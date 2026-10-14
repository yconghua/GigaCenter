import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { exportQueryResult } from '../analyze/analyze-core'
import { withLongPath } from '../core/path-utils'

/** 数据分析结果导出 worker：完整结果集流式写文件（不经过渲染进程）。
 *  长路径开关每次创建 worker 时由主进程实时传入，无需重启生效。 */

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
  const db = new Database(data.dbPath, { readonly: true })
  try {
    db.pragma('query_only = ON')
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
