import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { exportQueryResult } from '../analyze/analyze-core'
import { withLongPath } from '../core/path-utils'

/** 数据分析结果导出 worker：在 worker 内打开只读 SQLite 连接执行 SQL，结果集直接流式写文件，不经过渲染进程中转。
 *  长路径开关随每次创建 worker 由主进程实时传入，无需重启即可生效。 */

interface ExportWorkerData {
  dbPath: string
  sql: string
  targetKind: 'csv' | 'json' | 'sql'
  outputPath: string
  limit: number
  longPathSupport: boolean
}

let cancelled = false
parentPort?.on('message', (m: { cancel?: boolean }) => {
  if (m?.cancel) cancelled = true
})

async function main(): Promise<void> {
  const data = workerData as ExportWorkerData
  const t0 = Date.now()
  const db = new Database(data.dbPath, { readonly: true }) // 只读模式打开会话库，避免导出过程误写
  try {
    db.pragma('query_only = ON') // 开启 query_only，连接内禁止任何写操作
    const outputPath = withLongPath(data.outputPath, data.longPathSupport)
    const rowCount = await exportQueryResult(db, data.sql, data.targetKind, outputPath, data.limit, () => cancelled)
    parentPort?.postMessage({ done: true, rowCount, elapsedMs: Date.now() - t0 })
  } catch (err) {
    parentPort?.postMessage({ error: String(err instanceof Error ? err.message : err) })
  } finally {
    db.close()
  }
}

void main()
