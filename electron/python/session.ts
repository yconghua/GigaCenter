import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../log'
import { PythonWorker, cleanupSessionDir } from './python-worker'
import type { PythonRegisterItem } from './python-worker'
import type { PythonBlock } from '../../shared/ipc-types'

// Python 分析会话：独立会话目录 + 常驻 Worker（懒启动）+ 导入文件注册表。
// 会话目录 = 实例临时根/python/<sessionId>，副本与中间产物只存在于此；
// 重置会话 = 关闭旧会话（杀 Worker + 删目录）并新建，回到初始态。

export type PythonImportKind = 'csv' | 'txt' | 'xlsx' | 'xls' | 'json' | 'sqlite'

export interface PythonImportedFile {
  id: string
  /** 会话目录内的副本文件名（同名去重加序号） */
  copyName: string
  /** 副本绝对路径（用户代码相对路径引用 copyName 即可） */
  copyPath: string
  /** 用户原始文件名 */
  originalName: string
  kind: PythonImportKind
  /** 自动注册的 DataFrame 变量名 */
  varName: string
  headerRow: number | null
  rowCount: number | null
}

export interface PythonSession {
  sessionId: string
  dir: string
  worker: PythonWorker | null
  files: PythonImportedFile[]
  createdAt: number
  lastActiveAt: number
  /** 最近一次执行的结果快照（导出结果时主进程据此写文件；重置会话时清空） */
  lastBlocks: PythonBlock[]
  lastText: string
}

const sessions = new Map<string, PythonSession>()

/** 创建会话：在实例临时根下建独立会话目录；Worker 懒启动（首次执行才 spawn） */
export function createSession(instanceTempRoot: string): PythonSession {
  const sessionId = randomUUID().replace(/-/g, '')
  const dir = path.join(instanceTempRoot, 'python', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const session: PythonSession = {
    sessionId,
    dir,
    worker: null,
    files: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    lastBlocks: [],
    lastText: ''
  }
  sessions.set(sessionId, session)
  logger.info('[event=python-session-create]', { sessionId })
  return session
}

export function getSession(sessionId: string): PythonSession | null {
  return sessions.get(sessionId) ?? null
}

/** 确保会话 Worker 存活（懒启动），并挂接流式输出转发回调 */
export function ensureWorker(session: PythonSession, pythonPath: string, execScript: string): PythonWorker {
  if (!session.worker) {
    session.worker = new PythonWorker(pythonPath, session.dir, execScript)
  }
  return session.worker
}

/** 复制导入文件到会话目录（同名去重加序号），返回副本信息 */
export function copyImportFile(session: PythonSession, sourcePath: string, originalName: string, kind: PythonImportKind): PythonImportedFile {
  const base = path.basename(originalName)
  let copyName = base
  let counter = 1
  while (fs.existsSync(path.join(session.dir, copyName))) {
    const ext = path.extname(base)
    const stem = path.basename(base, ext)
    copyName = `${stem}_${counter}${ext}`
    counter += 1
  }
  const copyPath = path.join(session.dir, copyName)
  fs.copyFileSync(sourcePath, copyPath)
  const file: PythonImportedFile = {
    id: randomUUID().replace(/-/g, ''),
    copyName,
    copyPath,
    originalName,
    kind,
    varName: sanitizeVarName(stemOf(copyName)),
    headerRow: 0,
    rowCount: null
  }
  session.files.push(file)
  return file
}

/** 文件名 → 合法 Python 标识符：中文/空格/横杠等非法字符替换为下划线，数字开头加前缀 */
export function sanitizeVarName(name: string): string {
  let s = name.replace(/[^\w\u4e00-\u9fff]/g, '_')
  if (/^\d/.test(s)) s = `t_${s}`
  if (!s) s = 'data'
  return s
}

function stemOf(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}

/** 更新文件信息（导入确认时设置表头行/行数） */
export function updateImportedFile(session: PythonSession, fileId: string, patch: Partial<Pick<PythonImportedFile, 'headerRow' | 'rowCount' | 'varName'>>): void {
  const f = session.files.find((x) => x.id === fileId)
  if (f) Object.assign(f, patch)
}

/** 向 Worker 注册全部导入文件（注册表驱动，重复注册幂等）；Worker 未启动时跳过（下次运行自动补载） */
export function syncRegisteredFiles(session: PythonSession): void {
  if (!session.worker || !session.worker.isAlive()) return
  for (const f of session.files) {
    const item: PythonRegisterItem = {
      name: f.varName,
      filePath: f.copyPath,
      kind: f.kind,
      headerRow: f.headerRow
    }
    session.worker.register(item)
  }
}

/** 关闭会话：杀 Worker + 删会话目录（幂等） */
export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  try {
    session.worker?.dispose()
  } catch (err) {
    logger.warn('python worker dispose failed', { sessionId, err: String(err) })
  }
  cleanupSessionDir(session.dir)
  logger.info('[event=python-session-close]', { sessionId, ageMs: Date.now() - session.createdAt })
}

/** 关闭全部会话（应用退出前调用） */
export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id)
}

/** 会话临时占用（系统设置页可复用） */
export function pythonTempUsedBytes(instanceTempRoot: string): number {
  const root = path.join(instanceTempRoot, 'python')
  if (!fs.existsSync(root)) return 0
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    }
  }
  walk(root)
  return total
}
