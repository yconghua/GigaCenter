import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import { logger } from '../log'

// Python 运行时管理（离线捆绑）：
//   基线 = 安装目录 resources/python-embed（electron-builder extraResources 打包，只读）；
//   激活 = 用户数据目录 python-runtime（首次使用从基线复制，可写、可卸载）；
//   开发回退 = 环境变量 GIGACENTER_DEV_PYTHON 指向的解释器路径（未打包时调试用）。
// 与系统 Python 完全隔离：spawn 一律用绝对路径调用激活目录内的 python.exe，不依赖 PATH。

const BASELINE_DIR_NAME = 'python-embed'
const RUNTIME_DIR_NAME = 'python-runtime'

/** 界面状态栏展示的关键库清单（探测 import 是否可用） */
const REQUIRED_LIBS = ['pandas', 'numpy', 'matplotlib', 'openpyxl', 'xlrd', 'autopep8']

export interface PythonRuntimeInfo {
  /** ready=可执行（激活目录或开发回退就绪）；missing=未就绪 */
  status: 'ready' | 'missing'
  /** bundled=内置运行时；dev=开发回退解释器 */
  source: 'bundled' | 'dev' | ''
  pythonPath: string
  version: string
  libraries: string[]
  initializedAt: number | null
}

/** 探测结果缓存：运行时初始化/卸载时刷新，避免每次界面读取都启动子进程 */
let cached: PythonRuntimeInfo | null = null

function baselineDir(): string {
  return path.join(process.resourcesPath, BASELINE_DIR_NAME)
}

function activeDir(): string {
  return path.join(app.getPath('userData'), RUNTIME_DIR_NAME)
}

function pythonExe(dir: string): string {
  return path.join(dir, 'python.exe')
}

/** 探测解释器版本与已装库（find_spec 不真正导入库，开销小） */
function probe(dir: string, source: 'bundled' | 'dev'): PythonRuntimeInfo {
  const exe = pythonExe(dir)
  let version = ''
  let libraries: string[] = []
  try {
    version = execFileSync(exe, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch (err) {
    logger.warn('python version probe failed', { error: String(err) })
  }
  try {
    const libsExpr = `import importlib.util as u;print('|'.join(x for x in ${JSON.stringify(REQUIRED_LIBS)} if u.find_spec(x)))`
    const out = execFileSync(exe, ['-c', libsExpr], { encoding: 'utf-8', timeout: 8000 }).trim()
    libraries = out ? out.split('|') : []
  } catch (err) {
    logger.warn('python libraries probe failed', { error: String(err) })
  }
  let initializedAt: number | null = null
  try {
    const st = fs.statSync(exe)
    initializedAt = Math.floor(st.mtimeMs)
  } catch {
    initializedAt = null
  }
  return { status: 'ready', source, pythonPath: exe, version, libraries, initializedAt }
}

/** 运行时状态：激活目录优先，开发回退次之；都没有则 missing。结果缓存，force 强制刷新 */
export function getRuntimeInfo(force = false): PythonRuntimeInfo {
  if (cached && !force) return cached
  const active = activeDir()
  if (fs.existsSync(pythonExe(active))) {
    cached = probe(active, 'bundled')
    return cached
  }
  const dev = process.env.GIGACENTER_DEV_PYTHON
  if (dev && fs.existsSync(dev)) {
    cached = probe(path.dirname(dev), 'dev')
    return cached
  }
  cached = { status: 'missing', source: '', pythonPath: '', version: '', libraries: [], initializedAt: null }
  return cached
}

/** 初始化运行时：从安装目录基线复制到用户数据目录（幂等，重装会整体替换），返回最新状态 */
export function initRuntime(): PythonRuntimeInfo {
  const base = baselineDir()
  if (!fs.existsSync(pythonExe(base))) {
    logger.error('python baseline missing', { baseline: base })
    return { status: 'missing', source: '', pythonPath: '', version: '', libraries: [], initializedAt: null }
  }
  const active = activeDir()
  fs.rmSync(active, { recursive: true, force: true })
  fs.cpSync(base, active, { recursive: true })
  logger.info('python runtime initialized', { pythonPath: pythonExe(active) })
  return getRuntimeInfo(true)
}

/** 卸载运行时：删除激活目录（卸载程序流程一并删除整个用户数据目录，此处供设置页单独操作） */
export function uninstallRuntime(): void {
  fs.rmSync(activeDir(), { recursive: true, force: true })
  cached = null
  logger.info('python runtime uninstalled')
}
