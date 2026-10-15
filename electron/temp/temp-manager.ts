import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logger } from '../log'

// 临时目录三层生命周期：
// 实例根 %TEMP%\GigaCenter\<instanceId>（正常退出清理本实例根）
//   ├── sessions/<sessionId>  会话临时目录（数据分析临时 SQLite、导入缓存）
//   └── tasks/<taskId>        任务临时目录（解析缓存、预览副本、导出临时文件）
// 启动时扫描 %TEMP%\GigaCenter，删除超过 24h 且无进程锁的残留实例根。

const BASE = path.join(os.tmpdir(), 'GigaCenter')
const STALE_MS = 24 * 60 * 60 * 1000

export class TempManager {
  readonly instanceId: string
  readonly instanceRoot: string
  readonly lockPath: string

  constructor(instanceId: string) {
    this.instanceId = instanceId
    this.instanceRoot = path.join(BASE, instanceId)
    this.lockPath = path.join(this.instanceRoot, 'instance.lock')
  }

  init(): void {
    this.scanAndCleanupStale()
    fs.mkdirSync(this.instanceRoot, { recursive: true })
    this.acquireLock()
  }

  /** 正常退出只清本实例临时根；强杀进程不走退出流程，靠启动扫描兜底 */
  dispose(): void {
    try {
      fs.rmSync(this.instanceRoot, { recursive: true, force: true })
      logger.info('instance temp root cleaned', { instanceId: this.instanceId })
    } catch (err) {
      logger.warn('instance temp cleanup failed', { error: String(err) })
    }
  }

  createSessionDir(sessionId: string): string {
    const p = path.join(this.instanceRoot, 'sessions', sessionId)
    fs.mkdirSync(p, { recursive: true })
    return p
  }

  removeSessionDir(sessionId: string): void {
    this.removeDir(path.join(this.instanceRoot, 'sessions', sessionId))
  }

  createTaskDir(taskId: string): string {
    const p = path.join(this.instanceRoot, 'tasks', taskId)
    fs.mkdirSync(p, { recursive: true })
    return p
  }

  /** 清理任务临时目录：幂等，失败不阻塞主流程，记录日志 */
  removeTaskDir(taskId: string): void {
    this.removeDir(path.join(this.instanceRoot, 'tasks', taskId))
  }

  /** 递归统计本实例 sessions 目录已占用的字节数，用于临时空间占用提示。 */
  sessionTempUsedBytes(): number {
    const sessions = path.join(this.instanceRoot, 'sessions')
    return this.dirSize(sessions)
  }

  private removeDir(p: string): void {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    } catch (err) {
      logger.warn('temp dir cleanup failed', { path: p, error: String(err) })
    }
  }

  private dirSize(p: string): number {
    try {
      if (!fs.existsSync(p)) return 0
      let total = 0
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) total += fs.statSync(full).size
        }
      }
      walk(p)
      return total
    } catch {
      return 0
    }
  }

  /** 以 wx 独占方式创建本实例锁文件：正常运行期间由本进程持有，作为存活标记。 */
  private acquireLock(): void {
    try {
      const fd = fs.openSync(this.lockPath, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), instanceId: this.instanceId }))
      fs.closeSync(fd)
    } catch (err) {
      logger.error('instance lock acquire failed', { error: String(err) })
    }
  }

  /**
   * 启动扫描：对每个残留实例根尝试独占打开 instance.lock（wx），
   * 成功 = 无进程锁，可清理；失败只记录日志，跳过，不阻塞启动。
   * 删除前先 rename 到带时间戳的"待删除"名（原子操作，并发竞争只有一个成功）。
   */
  private scanAndCleanupStale(): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(BASE, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const root = path.join(BASE, entry.name)
      if (root === this.instanceRoot) continue
      const stat = this.safeStat(root)
      if (!stat) continue
      if (Date.now() - stat.mtimeMs < STALE_MS) continue
      const lockPath = path.join(root, 'instance.lock')
      let fd: number | null
      try {
        fd = fs.openSync(lockPath, 'wx')
      } catch {
        continue // 有锁或无法判断，跳过
      }
      if (fd !== null) fs.closeSync(fd)
      this.removeStaleRoot(root)
    }
  }

  private removeStaleRoot(root: string): void {
    const target = `${root}.deleting-${Date.now()}`
    try {
      fs.renameSync(root, target)
    } catch {
      return // 竞争失败或文件占用，跳过，下次启动再扫
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      logger.info('stale temp root cleaned', { path: root })
    } catch (err) {
      logger.warn('stale temp cleanup failed', { path: root, error: String(err) })
    }
  }

  private safeStat(p: string): fs.Stats | null {
    try {
      return fs.statSync(p)
    } catch {
      return null
    }
  }
}
