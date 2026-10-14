import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { importIntoSession } from '../analyze/importer'
import type { AnalyzeImportResult, ImportTableMapping } from '../../shared/ipc-types'

/** 数据分析导入 worker：按用户映射（多文件多表）落库到会话临时 SQLite，避免阻塞主进程。 */

interface ImportWorkerData {
  dbPath: string
  imports: ImportTableMapping[]
}

let cancelled = false
parentPort?.on('message', (m: { cancel?: boolean }) => {
  if (m?.cancel) cancelled = true
})

async function main(): Promise<void> {
  const data = workerData as ImportWorkerData
  const db = new Database(data.dbPath)
  const t0 = Date.now()
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    const result = await importIntoSession(db, data.imports, { isCancelled: () => cancelled })
    const out: AnalyzeImportResult = {
      sessionId: '',
      dbPath: data.dbPath,
      tables: result.tables,
      warnings: result.warnings,
      elapsedMs: Date.now() - t0
    }
    parentPort?.postMessage({ done: true, result: out })
  } catch (err) {
    parentPort?.postMessage({ error: String(err instanceof Error ? err.message : err) })
  } finally {
    db.close()
  }
}

void main()
