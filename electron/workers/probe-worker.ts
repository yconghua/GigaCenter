import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'

/**
 * 探针 worker：验证 better-sqlite3 在 worker_threads 环境中可加载运行。
 * 收到 sql 消息后在内存库中执行，回传执行结果与 sqlite 版本；主进程通过 worker.terminate() 终止。
 */
parentPort?.on('message', (msg: { sql: string }) => {
  try {
    const db = new Database(':memory:') // 每条消息新建内存库，执行完即关闭，worker 无状态
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
    const row = db.prepare(msg.sql).get() as Record<string, unknown> | undefined
    const queryResult = row ? Object.values(row)[0] : null
    db.close()
    parentPort?.postMessage({ ok: true, sqliteVersion: version, queryResult })
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) })
  }
})
