import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { logger } from '../log'

// Python 执行 Worker：spawn 内置解释器运行 giga_exec.py，JSON over stdio 通信。
// 特性：流式输出转发、30s 超时强杀、Windows 内存上限监控、崩溃自愈（下次运行自动重建）。
// 会话变量存在子进程内（giga_exec 的 globals），被杀/崩溃会丢失，需在结果中提示。

export type PythonBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; columns: string[]; rows: unknown[][]; total: number }
  | { kind: 'image'; mime: string; data: string }

export interface PythonRunResult {
  ok: boolean
  status: 'ok' | 'blocked' | 'error' | 'timeout' | 'oom' | 'crashed' | 'cancelled'
  elapsedMs: number
  message: string
  blocks: PythonBlock[]
}

export interface PythonStreamEvent {
  kind: 'out' | 'err'
  text: string
}

export interface PythonRegisterItem {
  name: string
  filePath: string
  kind: 'csv' | 'txt' | 'xlsx' | 'xls' | 'json' | 'sqlite'
  headerRow: number | null
}

interface PendingRun {
  resolve: (r: PythonRunResult) => void
  timer: NodeJS.Timeout
  memTimer: NodeJS.Timeout
  startedAt: number
}

interface PendingFormat {
  resolve: (r: { ok: boolean; code: string; message: string }) => void
}

interface PendingExport {
  resolve: (r: { ok: boolean; path: string; message: string }) => void
}

const DEFAULT_TIMEOUT_MS = 30_000
const MEM_LIMIT_MB = 1024
const MEM_CHECK_INTERVAL_MS = 5000

export class PythonWorker {
  private child: ChildProcess | null = null
  private pending: PendingRun | null = null
  /** 流式输出回调：主进程转推 event:python-stream */
  onStream: ((e: PythonStreamEvent) => void) | null = null

  constructor(
    private readonly pythonPath: string,
    private readonly sessionDir: string,
    private readonly execScript: string
  ) {}

  /** 是否已有存活子进程 */
  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /** 启动子进程；已存活则跳过（会话变量保留） */
  private ensureStarted(): void {
    if (this.isAlive()) return
    // 隔离系统 Python 干扰：清空 PYTHONHOME/PYTHONPATH，强制 UTF-8 输出，注入会话目录；
    // matplotlib 字体缓存写入会话目录（避免依赖用户主目录权限，重置会话时一并清理）
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONHOME: '',
      PYTHONPATH: '',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      MPLCONFIGDIR: this.sessionDir,
      GIGACENTER_SESSION_DIR: this.sessionDir
    }
    // 工作目录设为会话目录：用户代码中的相对路径（如 pd.read_csv("sales.csv")）
    // 直接解析到会话目录内的导入副本，无需拼绝对路径
    this.child = spawn(this.pythonPath, [this.execScript], {
      cwd: this.sessionDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdout?.setEncoding('utf-8')
    this.child.stderr?.setEncoding('utf-8')
    const buffer: string[] = []
    this.child.stdout?.on('data', (chunk: string) => {
      buffer.push(chunk)
      let text = buffer.join('')
      let nl = text.indexOf('\n')
      while (nl >= 0) {
        const line = text.slice(0, nl).trim()
        text = text.slice(nl + 1)
        nl = text.indexOf('\n')
        if (!line) continue
        this.handleFrame(line)
      }
      buffer.length = 0
      buffer.push(text)
    })
    this.child.stderr?.on('data', (chunk: string) => {
      // 非协议输出（解释器自身报错/警告）按 err 流转发
      this.onStream?.({ kind: 'err', text: chunk })
    })
    this.child.on('exit', (code, signal) => {
      this.child = null
      const p = this.pending
      if (p) {
        this.clearTimers(p)
        this.pending = null
        p.resolve({
          ok: false,
          status: 'crashed',
          elapsedMs: Date.now() - p.startedAt,
          message: `执行环境已退出（code=${code ?? '-'}, signal=${signal ?? '-'}），会话变量已重置`,
          blocks: []
        })
      }
    })
    this.child.on('error', (err) => {
      this.child = null
      const p = this.pending
      if (p) {
        this.clearTimers(p)
        this.pending = null
        p.resolve({
          ok: false,
          status: 'crashed',
          elapsedMs: Date.now() - p.startedAt,
          message: `执行环境启动失败：${String(err)}`,
          blocks: []
        })
      }
    })
  }

  private handleFrame(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.onStream?.({ kind: 'err', text: line })
      return
    }
    const t = frame.t
    if (t === 'stream') {
      this.onStream?.({ kind: frame.c === 'err' ? 'err' : 'out', text: String(frame.text ?? '') })
    } else if (t === 'done') {
      const p = this.pending
      if (p) {
        this.clearTimers(p)
        this.pending = null
        p.resolve({
          ok: Boolean(frame.ok),
          status: frame.ok === true ? 'ok' : 'error',
          elapsedMs: Number(frame.elapsed ?? Date.now() - p.startedAt),
          message: '',
          blocks: Array.isArray(frame.blocks) ? (frame.blocks as PythonBlock[]) : []
        })
      }
    } else if (t === 'error') {
      const p = this.pending
      if (p) {
        this.clearTimers(p)
        this.pending = null
        const status = (frame.status as string) === 'blocked' ? 'blocked' : 'error'
        p.resolve({
          ok: false,
          status,
          elapsedMs: Date.now() - p.startedAt,
          message: String(frame.message ?? '执行失败'),
          blocks: []
        })
      }
    } else if (t === 'format') {
      const fmt = this.pendingFormat
      if (fmt) {
        this.pendingFormat = null
        fmt.resolve({
          ok: Boolean(frame.ok),
          code: String(frame.code ?? ''),
          message: String(frame.message ?? '')
        })
      }
    } else if (t === 'export') {
      const ex = this.pendingExport
      if (ex) {
        this.pendingExport = null
        ex.resolve({
          ok: Boolean(frame.ok),
          path: String(frame.path ?? ''),
          message: String(frame.message ?? '')
        })
      }
    }
    // pong / ack 等内部帧忽略
  }

  private pendingFormat: PendingFormat | null = null
  private pendingExport: PendingExport | null = null

  private clearTimers(p: PendingRun): void {
    clearTimeout(p.timer)
    clearInterval(p.memTimer)
  }

  /** Windows 内存监控：轮询 tasklist 查询 RSS，超限按 oom 终止（非 Windows 跳过） */
  private startMemMonitor(p: PendingRun): void {
    if (process.platform !== 'win32') return
    p.memTimer = setInterval(() => {
      if (!this.child || this.child.pid === undefined) return
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${this.child.pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf-8',
          timeout: 3000
        })
        const m = /"([\d,]+)\s*K"/.exec(out)
        if (m) {
          const mb = Number(m[1].replace(/,/g, '')) / 1024
          if (mb > MEM_LIMIT_MB) {
            this.terminate('oom', `执行超出内存上限（${MEM_LIMIT_MB}MB），已终止`)
          }
        }
      } catch {
        /* tasklist 查询失败忽略，超时兜底仍在 */
      }
    }, MEM_CHECK_INTERVAL_MS)
  }

  private terminate(status: 'timeout' | 'oom', message: string): void {
    const p = this.pending
    if (!p) return
    this.clearTimers(p)
    this.pending = null
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    p.resolve({
      ok: false,
      status,
      elapsedMs: Date.now() - p.startedAt,
      message,
      blocks: []
    })
  }

  /** 执行一段代码；同页单任务（串行），返回最终结果；超时/超内存/崩溃按对应状态返回 */
  run(code: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PythonRunResult> {
    if (this.pending) {
      return Promise.resolve({
        ok: false,
        status: 'error',
        elapsedMs: 0,
        message: '已有正在执行的代码，请等待完成',
        blocks: []
      })
    }
    this.ensureStarted()
    if (!this.isAlive()) {
      return Promise.resolve({
        ok: false,
        status: 'crashed',
        elapsedMs: 0,
        message: '执行环境不可用，请重置会话后重试',
        blocks: []
      })
    }
    return new Promise<PythonRunResult>((resolve) => {
      const startedAt = Date.now()
      const p: PendingRun = {
        resolve,
        timer: setTimeout(() => this.terminate('timeout', `执行超过 ${timeoutMs / 1000} 秒，已自动终止`), timeoutMs),
        memTimer: setTimeout(() => undefined, 0),
        startedAt
      }
      this.pending = p
      this.startMemMonitor(p)
      this.child?.stdin?.write(JSON.stringify({ op: 'run', code }) + '\n')
    })
  }

  /** 注册导入文件并预读 DataFrame 变量（失败不阻塞，首次执行时重试） */
  register(item: PythonRegisterItem): void {
    this.ensureStarted()
    if (!this.isAlive()) return
    this.child?.stdin?.write(JSON.stringify({ op: 'register', ...item, headerRow: item.headerRow ?? 0 }) + '\n')
  }

  /** 注销单个导入文件变量：删除子进程注册表条目与全局变量（删除文件时调用） */
  unregister(name: string): void {
    if (!this.isAlive()) return
    this.child?.stdin?.write(JSON.stringify({ op: 'unregister', name }) + '\n')
  }

  /** autopep8 格式化代码：Worker 内执行，不触达运行状态与变量 */
  format(code: string): Promise<{ ok: boolean; code: string; message: string }> {
    this.ensureStarted()
    if (!this.isAlive()) {
      return Promise.resolve({ ok: false, code: '', message: '执行环境不可用' })
    }
    return new Promise((resolve) => {
      this.pendingFormat = { resolve }
      this.child?.stdin?.write(JSON.stringify({ op: 'format', code }) + '\n')
    })
  }

  /** 导出最近一次 giga_table 表格：Worker 直写会话目录内的临时文件 */
  exportTable(kind: 'csv' | 'excel' | 'json' | 'sqlite', target: string): Promise<{ ok: boolean; path: string; message: string }> {
    this.ensureStarted()
    if (!this.isAlive()) {
      return Promise.resolve({ ok: false, path: '', message: '执行环境不可用' })
    }
    return new Promise((resolve) => {
      this.pendingExport = { resolve }
      this.child?.stdin?.write(JSON.stringify({ op: 'export', kind, target }) + '\n')
    })
  }

  /** 取消当前执行：强杀子进程（会话变量随之重置），返回取消结果 */
  cancel(): PythonRunResult | null {
    const p = this.pending
    if (!p) return null
    this.clearTimers(p)
    this.pending = null
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    const result: PythonRunResult = {
      ok: false,
      status: 'cancelled',
      elapsedMs: Date.now() - p.startedAt,
      message: '已取消（执行环境已重启，会话变量已重置）',
      blocks: []
    }
    p.resolve(result)
    return result
  }

  /** 重置会话：清空子进程内变量与注册表；无子进程时仅清状态 */
  reset(): void {
    if (this.isAlive()) {
      this.child?.stdin?.write(JSON.stringify({ op: 'reset' }) + '\n')
    }
  }

  /** 销毁：杀子进程并清空挂起状态（会话目录由会话模块负责删除） */
  dispose(): void {
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    this.child = null
    const p = this.pending
    if (p) {
      this.clearTimers(p)
      this.pending = null
      p.resolve({
        ok: false,
        status: 'cancelled',
        elapsedMs: Date.now() - p.startedAt,
        message: '执行环境已关闭',
        blocks: []
      })
    }
  }
}

/** 定位 giga_exec.py：激活运行时的内置脚本优先，回退工程内源码（开发模式） */
export function resolveExecScript(runtimePythonDir: string): string {
  const bundled = path.join(runtimePythonDir, 'giga_exec.py')
  if (fs.existsSync(bundled)) return bundled
  return path.join(__dirname, 'giga_exec.py')
}

/** 清理会话目录（重置/退出时调用），幂等 */
export function cleanupSessionDir(sessionDir: string): void {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('python session cleanup failed', { error: String(err) })
  }
}
