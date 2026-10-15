import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { logger, sanitizePath } from '../log'

/** 数据分析会话：临时 SQLite 的创建、注册表与生命周期管理。
 *  每个会话在实例临时目录下独占一个子目录，库文件启用 WAL；会话按空闲 TTL 回收，应用退出时统一清理。 */

export interface AnalyzeSession {
  sessionId: string
  dbPath: string
  /** 主连接：串行执行写与元数据操作；耗时查询走 worker 的只读短连接。 */
  db: Database.Database
  createdAt: number
  /** 最近一次使用时间：空闲超时回收依据（主进程定期扫描） */
  lastActiveAt: number
}

/** 会话注册表：sessionId -> 会话（含主连接与目录信息），退出/关闭时清理。 */
const sessions = new Map<string, AnalyzeSession & { dir: string }>()

/** 创建会话：在实例临时根下建独立会话目录并初始化临时 SQLite（WAL 模式，synchronous=NORMAL）。 */
export function createSession(instanceTempRoot: string): AnalyzeSession {
  const sessionId = randomUUID().replace(/-/g, '')
  const dir = path.join(instanceTempRoot, 'sessions', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'data.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  const now = Date.now()
  const session: AnalyzeSession & { dir: string } = { sessionId, dbPath, db, dir, createdAt: now, lastActiveAt: now }
  sessions.set(sessionId, session)
  logger.info('[event=session-create]', { sessionId, dbPath: sanitizePath(dbPath) })
  return session
}

/** 获取会话；不存在返回 null */
export function getSession(sessionId: string): AnalyzeSession | null {
  return sessions.get(sessionId) ?? null
}

/** 记录会话活动（查询/预览/导出/导入等使用时调用），刷新空闲计时 */
export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session) session.lastActiveAt = Date.now()
}

/**
 * 回收空闲会话：超过 ttlMs 未活动的会话关闭并清理临时库。
 * 返回被关闭的 sessionId 列表，供主进程通知前端。
 */
export function closeExpiredSessions(ttlMs: number): string[] {
  const now = Date.now()
  const expired: string[] = []
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActiveAt >= ttlMs) expired.push(sessionId)
  }
  for (const id of expired) closeSession(id)
  return expired
}

/** 关闭会话：先 wal_checkpoint(TRUNCATE) 截断 WAL，再关连接、删临时目录；重复调用幂等。 */
export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  try {
    session.db.pragma('wal_checkpoint(TRUNCATE)')
    session.db.close()
  } catch (err) {
    logger.debug('session wal checkpoint failed', { sessionId, err: String(err) })
  }
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('session cleanup failed (startup scan will retry)', { sessionId, err: String(err) })
  }
  logger.info('[event=session-close]', { sessionId, ageMs: Date.now() - session.createdAt })
}

/** 关闭全部会话（应用退出前调用） */
export function closeAllSessions(): void {
  for (const sessionId of [...sessions.keys()]) closeSession(sessionId)
}

/** 当前会话临时占用（系统设置页展示） */
export function sessionTempUsedBytes(instanceTempRoot: string): number {
  const sessionsRoot = path.join(instanceTempRoot, 'sessions')
  if (!fs.existsSync(sessionsRoot)) return 0
  let total = 0
  for (const name of fs.readdirSync(sessionsRoot)) {
    const full = path.join(sessionsRoot, name)
    if (!fs.statSync(full).isDirectory()) continue
    total += dirSize(full)
  }
  return total
}

function dirSize(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else {
      try {
        total += fs.statSync(full).size
      } catch {
        /* 文件可能被并发清理 */
      }
    }
  }
  return total
}
