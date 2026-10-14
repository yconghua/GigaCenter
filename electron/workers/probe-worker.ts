import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'

/**
 * 探针 worker：验证 better-sqlite3 在 worker_threads 中可用。
 * 收到 sql 消息后执行并回传结果；主进程通过 worker.terminate() 取消。
 */
parentPort?.on('message', (msg: { sql: string }) => {
  try {
    const db = new Database(':memory:')
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
    const row = db.prepare(msg.sql).get() as Record<string, unknown> | undefined
    const queryResult = row ? Object.values(row)[0] : null
    db.close()
    parentPort?.postMessage({ ok: true, sqliteVersion: version, queryResult })
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) })
  }
})
