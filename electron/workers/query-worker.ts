import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'

/** 数据分析查询 worker：执行主进程预检后的 SQL 语句列表，各结果集只回传前 limit 行。
 *  取消：主进程发送 {cancel:true} 消息置位标志，在语句之间与结果行之间检查后抛取消错误；terminate() 作为兜底。
 *  连接模式：readonly=true 时只读打开并开启 query_only；false（允许修改临时库）时用普通连接。 */

interface QueryWorkerData {
  dbPath: string
  /** 主进程预检（安全白名单）后拆分出的单条 SQL 语句。 */
  statements: string[]
  limit: number
  readonly: boolean
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowCount: number
  truncated: boolean
  /** 仅 EXPLAIN QUERY PLAN 语句填充：按 id/parent 解析出的计划树。 */
  explainPlan: Array<{ detail: string; children: Array<{ detail: string }> }> | null
}

let cancelled = false
parentPort?.on('message', (m: { cancel?: boolean }) => {
  if (m?.cancel) cancelled = true
})

function main(): void {
  const data = workerData as QueryWorkerData
  const t0 = Date.now()
  const db = data.readonly ? new Database(data.dbPath, { readonly: true }) : new Database(data.dbPath) // 只读模式打开；允许修改临时库时用普通连接
  try {
    if (data.readonly) db.pragma('query_only = ON')
    const results: QueryResult[] = []
    for (const stmtText of data.statements) {
      if (cancelled) throw cancelError()
      const trimmed = stmtText.trim()
      if (!trimmed) continue
      // 语句白名单兜底：只放行常见 SQL 关键字开头的语句，其余直接跳过（安全预检在主进程已完成）
      if (!/^(SELECT|EXPLAIN|WITH|PRAGMA|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE|REINDEX)\b/i.test(trimmed)) continue
      let stmt: Database.Statement
      try {
        stmt = db.prepare(trimmed)
      } catch (err) {
        throw new Error(`SQL 语法错误：${String(err instanceof Error ? err.message : err)}`, {
          cause: err
        })
      }
      const isExplain = /^EXPLAIN\b/i.test(trimmed)
      const cols = stmt.columns().map((c) => c.name)
      const rows: (string | null)[][] = []
      let count = 0
      let truncated = false
      for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
        if (cancelled) throw cancelError()
        // 达到 limit 立即停止迭代：避免 SELECT * 拖出全表扫描只为多统计几行。
        if (count >= data.limit) {
          truncated = true
          break
        }
        rows.push(cols.map((c) => stringifyCell(row[c])))
        count++
      }
      let explainPlan: QueryResult['explainPlan'] = null
      if (isExplain) {
        explainPlan = buildExplainTree(rows, cols)
      }
      results.push({ columns: cols, rows, rowCount: count, truncated, explainPlan })
    }
    if (results.length === 0) {
      results.push({ columns: ['ok'], rows: [['查询完成（无结果集）']], rowCount: 0, truncated: false, explainPlan: null })
    }
    parentPort?.postMessage({ done: true, results, elapsedMs: Date.now() - t0 })
  } catch (err) {
    parentPort?.postMessage({ error: String(err instanceof Error ? err.message : err) })
  } finally {
    db.close()
  }
}

/** 单元格值序列化为展示字符串：BLOB 转 hex 文本，对象转 JSON，空值保留 null。 */
function stringifyCell(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 把 EXPLAIN QUERY PLAN 的结果行（id/parent/detail）按父子关系组织成树，供前端可视化展示。 */
function buildExplainTree(
  rows: (string | null)[][],
  cols: string[]
): Array<{ detail: string; children: Array<{ detail: string }> }> {
  interface Node {
    id: number
    parent: number
    detail: string
    children: Node[]
  }
  const idIdx = cols.indexOf('id')
  const parentIdx = cols.indexOf('parent')
  const detailIdx = cols.indexOf('detail')
  if (idIdx < 0 || parentIdx < 0 || detailIdx < 0) {
    return rows.map((r) => ({ detail: r.join(' | '), children: [] }))
  }
  const nodes = new Map<number, Node>()
  for (const r of rows) {
    const id = Number(r[idIdx] ?? 0)
    const parent = Number(r[parentIdx] ?? 0)
    nodes.set(id, { id, parent, detail: r[detailIdx] ?? '', children: [] })
  }
  const roots: Node[] = []
  for (const node of nodes.values()) {
    if (node.parent === 0) roots.push(node)
    else {
      const p = nodes.get(node.parent)
      if (p) p.children.push(node)
      else roots.push(node)
    }
  }
  const toTree = (n: Node): { detail: string; children: Array<{ detail: string }> } => ({
    detail: n.detail,
    children: n.children.map(toTree)
  })
  return roots.map(toTree)
}

function cancelError(): Error {
  const e = new Error('查询已取消')
  e.name = 'CancelError'
  return e
}

void main()
