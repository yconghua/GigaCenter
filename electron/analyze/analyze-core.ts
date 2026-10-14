import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { logger } from '../log'
import type {
  AnalyzeTableInfo,
  AnalyzeSchemaResult,
  AnalyzeColumnInfo,
  AnalyzePreviewResult
} from '../../shared/ipc-types'

/** 数据分析元数据与导出辅助：表/视图/索引/触发器对象树、表结构、前 50 行预览。 */

export function listObjects(db: Database.Database): AnalyzeTableInfo[] {
  const rows = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ name: string; type: string }>
  const out: AnalyzeTableInfo[] = []
  for (const row of rows) {
    let rowCount: number | null = null
    let columns: Array<{ name: string; type: string }> = []
    if (row.type === 'table') {
      try {
        const c = db.prepare(`SELECT count(*) c FROM ${quoteIdent(row.name)}`).get() as { c: number }
        rowCount = c.c
      } catch {
        rowCount = null
      }
      columns = db
        .prepare(`PRAGMA table_info(${quoteIdent(row.name)})`)
        .all()
        .map((col) => {
          const c = col as { name: string; type: string }
          return { name: c.name, type: mapSqliteType(c.type).toLowerCase() }
        })
    } else if (row.type === 'view') {
      try {
        columns = db
          .prepare(`PRAGMA table_info(${quoteIdent(row.name)})`)
          .all()
          .map((col) => {
            const c = col as { name: string; type: string }
            return { name: c.name, type: mapSqliteType(c.type).toLowerCase() }
          })
      } catch {
        columns = []
      }
    }
    out.push({ name: row.name, type: row.type as AnalyzeTableInfo['type'], rowCount, columns })
  }
  return out
}

export function getSchema(db: Database.Database, tableName: string): AnalyzeSchemaResult {
  const cols = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all() as Array<{
    name: string
    unique: number
  }>
  const indexDetail: AnalyzeSchemaResult['indexes'] = []
  for (const idx of indexes) {
    const parts = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string }>
    indexDetail.push({
      name: idx.name,
      columns: parts.map((p) => p.name).join(', '),
      unique: idx.unique === 1
    })
  }
  const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all() as Array<{
    from: string
    table: string
    to: string
  }>
  return {
    tableName,
    columns: cols.map<AnalyzeColumnInfo>((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.notnull === 1,
      defaultValue: c.dflt_value,
      primaryKey: c.pk > 0
    })),
    indexes: indexDetail,
    foreignKeys: fks.map((f) => ({ from: f.from, to: f.table, toColumn: f.to }))
  }
}

export function previewTable(db: Database.Database, tableName: string): AnalyzePreviewResult {
  const cols = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{ name: string }>
  const names = cols.map((c) => c.name)
  const total = (db.prepare(`SELECT count(*) c FROM ${quoteIdent(tableName)}`).get() as { c: number }).c
  const rows = db
    .prepare(`SELECT * FROM ${quoteIdent(tableName)} LIMIT 50`)
    .all() as Record<string, unknown>[]
  return {
    columns: names,
    rows: rows.map((r) => names.map((n) => stringifyCell(r[n]))),
    totalRows: total
  }
}

/** 解析 EXPLAIN QUERY PLAN 文本为树形结构 */
export function parseExplainPlan(raw: string): Array<{ detail: string; children: Array<{ detail: string }> }> {
  const lines = raw.split('\n').filter((l) => l.trim())
  const roots: Array<{ detail: string; children: Array<{ detail: string }> }> = []
  const stack: Array<{ level: number; node: { detail: string; children: Array<{ detail: string }> } }> = []
  for (const line of lines) {
    const m = line.match(/^(\s*)(.*)$/)
    if (!m) continue
    const level = m[1].length
    const detail = m[2].trim()
    if (!detail) continue
    const node = { detail, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length > 0) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ level, node })
  }
  return roots
}

/** 查询结果导出：走主进程/worker 流式写文件（复用原子写语义），支持取消检查 */
export async function exportQueryResult(
  db: Database.Database,
  sql: string,
  targetKind: 'csv' | 'json' | 'sql',
  outputPath: string,
  limit: number,
  isCancelled?: () => boolean
): Promise<number> {
  const t0 = Date.now()
  const stmt = db.prepare(sql)
  const cols = stmt.columns().map((c) => c.name)
  const rows = stmt.iterate() as IterableIterator<Record<string, unknown>>
  const tmp = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  const fd = fs.openSync(tmp, 'w')
  let count = 0
  try {
    if (targetKind === 'csv') {
      fs.writeSync(fd, '\uFEFF' + cols.map(escapeCsv).join(',') + '\r\n')
      for (const row of rows) {
        if (isCancelled?.()) throw new Error('导出已取消')
        if (count >= limit) break
        fs.writeSync(fd, cols.map((c) => escapeCsv(stringifyCell(row[c]))).join(',') + '\r\n')
        count++
      }
    } else if (targetKind === 'json') {
      fs.writeSync(fd, '[\n')
      let first = true
      for (const row of rows) {
        if (isCancelled?.()) throw new Error('导出已取消')
        if (count >= limit) break
        fs.writeSync(fd, (first ? '' : ',\n') + JSON.stringify(row))
        first = false
        count++
      }
      fs.writeSync(fd, '\n]\n')
    } else {
      // sql
      fs.writeSync(fd, `CREATE TABLE result (${cols.map((c) => `"${c.replace(/"/g, '""')}" TEXT`).join(', ')});\n`)
      fs.writeSync(fd, 'BEGIN;\n')
      for (const row of rows) {
        if (isCancelled?.()) throw new Error('导出已取消')
        if (count >= limit) break
        const values = cols.map((c) => sqlLiteral(stringifyCell(row[c]))).join(', ')
        fs.writeSync(fd, `INSERT INTO result VALUES (${values});\n`)
        count++
      }
      fs.writeSync(fd, 'COMMIT;\n')
    }
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(fd)
  // 原子替换（Windows 目标存在时先删再 rename）
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath)
  fs.renameSync(tmp, outputPath)
  logger.debug('query result exported', { targetKind, rows: count, ms: Date.now() - t0, path: path.basename(outputPath) })
  return count
}

function stringifyCell(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function escapeCsv(v: string | null): string {
  if (v === null) return ''
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function sqlLiteral(v: string | null): string {
  if (v === null) return 'NULL'
  return `'${v.replace(/'/g, "''")}'`
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function mapSqliteType(t: string): string {
  const up = t.toUpperCase()
  if (up.includes('INT')) return 'INTEGER'
  if (up.includes('CHAR') || up.includes('CLOB') || up.includes('TEXT')) return 'TEXT'
  if (up.includes('BLOB')) return 'BLOB'
  if (up.includes('REAL') || up.includes('FLOA') || up.includes('DOUB')) return 'REAL'
  if (up.includes('BOOL')) return 'INTEGER'
  if (up.includes('DATE') || up.includes('TIME')) return 'TEXT'
  return up || 'TEXT'
}
