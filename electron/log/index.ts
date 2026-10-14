import path from 'node:path'

// electron-log 的类型为 CommonJS 默认导出（MainLogger），无具名类型导出；
// 这里只声明用到的最小结构。
interface ElectronLogLike {
  transports: {
    file: {
      resolvePathFn?: (() => string) | null
      maxSize?: number
      format?: string | unknown
    }
  }
  error(msg: string): void
  warn(msg: string): void
  info(msg: string): void
  debug(msg: string): void
}

// 统一日志入口：所有日志点必须走本模块，路径/SQL 脱敏在此完成。
// electron-log 与 electron 只能在主进程加载（worker 线程内 require('electron') 失败，
// 打包 asar 后 worker 无 electron 模块），因此这里全部惰性加载：
// initLogger 只由主进程调用；worker 内 logger.* 回退 console，事件日志由主进程统一记录。

let fileLog: ElectronLogLike | null | undefined

function getFileLog(): ElectronLogLike | null {
  if (fileLog !== undefined) return fileLog
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fileLog = require('electron-log') as unknown as ElectronLogLike
  } catch {
    fileLog = null
  }
  return fileLog
}

export function initLogger(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  const l = getFileLog()
  if (!l) return
  l.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log')
  l.transports.file.maxSize = 20 * 1024 * 1024
  l.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
}

/** 路径脱敏：只保留盘符 + \\...\\，末级也脱敏为 *** */
export function sanitizePath(p: string): string {
  if (!p) return ''
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? ''
  return drive ? `${drive}\\...\\***` : '\\...\\***'
}

function fmt(meta: unknown): string {
  if (meta === undefined || meta === null) return ''
  if (typeof meta === 'string') return ` ${meta}`
  try {
    return ` ${JSON.stringify(meta)}`
  } catch {
    return ' [unserializable]'
  }
}

function write(level: 'error' | 'warn' | 'info' | 'debug', msg: string, meta?: unknown): void {
  const text = msg + fmt(meta)
  const l = getFileLog()
  if (l) {
    if (level === 'error') l.error(text)
    else if (level === 'warn') l.warn(text)
    else if (level === 'info') l.info(text)
    else l.debug(text)
    return
  }
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const logger = {
  error(msg: string, meta?: unknown): void {
    write('error', msg, meta)
  },
  warn(msg: string, meta?: unknown): void {
    write('warn', msg, meta)
  },
  info(msg: string, meta?: unknown): void {
    write('info', msg, meta)
  },
  debug(msg: string, meta?: unknown): void {
    write('debug', msg, meta)
  },
  /** SQL 不记文本，只记类型 + 是否含 WHERE + 参数数量 */
  sql(stmtType: string, hasWhere: boolean, paramCount: number): void {
    write('debug', `[SQL] type=${stmtType} where=${hasWhere} params=${paramCount}`)
  }
}
