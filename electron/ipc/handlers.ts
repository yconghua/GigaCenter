import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { IPC_CHANNELS } from '../../shared/ipc-types'
import type {
  AnalyzeChooseFilesResult,
  AnalyzeExportPayload,
  AnalyzeExportResult,
  AnalyzeImportPayload,
  AnalyzeImportResult,
  AnalyzePreviewResult,
  AnalyzeQueryResult,
  AnalyzeRunQueryPayload,
  AnalyzeSchemaResult,
  AppInfo,  AppPreferences,
  ChooseOutputDirResult,
  ExportConfig,
  ExportPreviewResult,
  InspectSheetPayload,
  PingPayload,
  PingResult,
  ProbeImportResult,
  ProbeWorkerCancelResult,
  ProbeWorkerResult,
  Result,
  SheetInspectResult,
  SubscribeTaskPayload,
  SubscribeTaskResult,
  WorkbookInfo
} from '../../shared/ipc-types'
import { logger } from '../log'
import type { TempManager } from '../temp/temp-manager'
import type { TaskManager } from '../task/task-manager'
import type { ConfigStore } from '../config/store'
import type { PathWhitelist } from '../security/path-whitelist'
import { buildExportPreview, inspectSheetFile } from '../convert/convert-core'
import { buildExportPreviewContent } from '../convert/preview-content'
import type { ParsedSource } from '../convert/convert-core'
import { createSession, getSession, closeSession, closeAllSessions, touchSession, closeExpiredSessions } from '../analyze/session'
import { listObjects, getSchema, previewTable } from '../analyze/analyze-core'
import { checkSql } from '../security/sql-precheck'
import { getRuntimeInfo, initRuntime, uninstallRuntime } from '../python/runtime'
import {
  createSession as createPythonSession,
  getSession as getPythonSession,
  closeSession as closePythonSession,
  ensureWorker,
  copyImportFile,
  updateImportedFile,
  syncRegisteredFiles
} from '../python/session'
import { resolveExecScript } from '../python/python-worker'
import { atomicWriteFile } from '../core/atomic-write'
import type { PythonRegisterImportItem, PythonRunResult, PythonSessionInfo } from '../../shared/ipc-types'

// 实例 ID：本次启动生成的随机唯一标识，只存内存，下次启动换新。
const instanceId = randomUUID()

export function getInstanceId(): string {
  return instanceId
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

// ---------- 格式转换状态（主进程持有，不信任渲染进程） ----------

interface ConvertSnapshot {
  config: ExportConfig
  hash: string
  fileNames: Record<number, string>
  sheetNames: Record<number, string>
  tableNames: Record<number, string>
}

interface ConvertState {
  /** 当前会话：一次解析成功 = 一个会话；新文件解析/重置会替换并丢弃旧会话缓存 */
  session: { filePath: string; parsed: ParsedSource } | null
  /** preview 阶段保存的配置快照：confirm 只传 taskId，用内部快照校验 */
  snapshots: Map<string, ConvertSnapshot>
  worker: Worker | null
  workerTaskId: string | null
}

const convertState: ConvertState = {
  session: null,
  snapshots: new Map(),
  worker: null,
  workerTaskId: null
}

// ---------- 数据分析状态（查询/导入/导出 worker，全局单任务锁共享） ----------

interface AnalyzeState {
  worker: Worker | null
  workerTaskId: string | null
}

const analyzeState: AnalyzeState = {
  worker: null,
  workerTaskId: null
}

export interface IpcDeps {
  temp: TempManager
  config: ConfigStore
  tasks: TaskManager
  whitelist: PathWhitelist
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { temp, config, tasks, whitelist } = deps
  taskManagerRef = tasks

  // ---------- 应用信息 ----------

  ipcMain.handle(IPC_CHANNELS.ping, (_e, payload: PingPayload) => {
    const result: PingResult = {
      pong: `pong: ${payload?.message ?? ''}`,
      receivedAt: payload?.receivedAt ?? 0,
      handledAt: Date.now()
    }
    logger.debug('ping handled')
    return ok(result)
  })

  ipcMain.handle(IPC_CHANNELS.getAppInfo, () => {
    const info: AppInfo = {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? '',
      platform: process.platform,
      instanceId,
      resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    return ok(info)
  })

  ipcMain.handle(IPC_CHANNELS.getPaths, () => {
    return ok({
      configDir: config.configDir,
      logDir: path.join(app.getPath('userData'), 'logs'),
      tempRoot: temp.instanceRoot,
      sessionTempUsedBytes: temp.sessionTempUsedBytes(),
      instanceId
    })
  })

  ipcMain.handle(IPC_CHANNELS.openDevTools, (e) => {
    e.sender.openDevTools({ mode: 'detach' })
    return ok({ opened: true })
  })

  ipcMain.handle(IPC_CHANNELS.openExeFolder, () => {
    shell.showItemInFolder(app.getPath('exe'))
    return ok({ shown: true })
  })

  // 打开指定目录（设置页路径项）：校验存在后用系统文件管理器打开。
  ipcMain.handle(IPC_CHANNELS.openFolder, async (_e, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return fail('invalid_path', '路径无效')
    if (!fs.existsSync(folderPath)) return fail('not_found', '目录不存在')
    const errorMessage = await shell.openPath(folderPath)
    if (errorMessage) return fail('open_failed', errorMessage)
    return ok({ opened: true })
  })

  // 在文件管理器中显示并选中文件/目录（诊断包导出后定位）。
  ipcMain.handle(IPC_CHANNELS.showInFolder, (_e, itemPath: string) => {
    if (typeof itemPath !== 'string' || itemPath.length === 0) return fail('invalid_path', '路径无效')
    if (!fs.existsSync(itemPath)) return fail('not_found', '路径不存在')
    shell.showItemInFolder(itemPath)
    return ok({ shown: true })
  })

  // ---------- 配置 ----------

  /** 应用主题：设置 themeSource 并把实际解析的明暗结果推给所有窗口（跟随系统模式下，系统切换明暗时同样生效） */
  function applyTheme(prefs: AppPreferences): void {
    nativeTheme.themeSource = prefs.theme
    const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.eventNativeTheme, { theme: resolved })
      }
    }
  }

  ipcMain.handle(IPC_CHANNELS.getSettings, () => ok(config.getPreferences()))

  ipcMain.handle(IPC_CHANNELS.setPreferences, (_e, patch: Partial<AppPreferences>) => {
    const result = config.setPreferences(patch)
    logger.info('[event=settings-change]', { keys: Object.keys(patch ?? {}) })
    if (patch && 'theme' in patch) applyTheme(result)
    return ok(result)
  })

  ipcMain.handle(IPC_CHANNELS.clearPreferences, () => {
    config.clearPreferences()
    applyTheme(config.getPreferences())
    return ok(null)
  })

  // 诊断包：脱敏应用/系统信息 + 最近日志，不包含原始数据、SQL 全文、用户文件名。
  ipcMain.handle(IPC_CHANNELS.exportDiagnostics, () => {
    try {
      const logPath = path.join(app.getPath('userData'), 'logs', 'main.log')
      const tail = fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, 'utf-8')
            .split('\n')
            .slice(-80)
            .join('\n')
        : '(无日志)'
      const diagDir = path.join(app.getPath('userData'), 'diagnostics')
      fs.mkdirSync(diagDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const outPath = path.join(diagDir, `diag-${ts}.json`)
      const payload = {
        generatedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? '',
        nodeVersion: process.versions.node,
        chromeVersion: process.versions.chrome ?? '',
        osVersion: `${os.type()} ${os.release()}`,
        platform: process.platform,
        arch: process.arch,
        instanceId: getInstanceId(),
        tempRoot: deps.temp.instanceRoot,
        sessionTempUsedBytes: deps.temp.sessionTempUsedBytes(),
        logTail: tail
      }
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8')
      return ok({ path: outPath })
    } catch (err) {
      return fail('DIAGNOSTICS_FAILED', `诊断包生成失败：${String(err)}`)
    }
  })

  // 卸载：先清临时残留，再启动延迟清理命令删除用户数据目录（日志文件被本进程占用，
  // 需等进程退出释放句柄），最后调用 NSIS 卸载器静默卸载并退出。
  ipcMain.handle(IPC_CHANNELS.uninstallApp, () => {
    try {
      // 1) 临时残留（%TEMP%\GigaCenter）：无本进程占用，立即删除
      fs.rmSync(path.join(os.tmpdir(), 'GigaCenter'), { recursive: true, force: true })

      // 2) 用户数据目录（%LOCALAPPDATA%\GigaCenter）：当前日志句柄占用，
      //    由独立 cmd 延迟约 3 秒（ping -n 4）待本进程退出后整目录删除
      const userData = app.getPath('userData')
      const cleanCmd = `ping 127.0.0.1 -n 4 >nul & rmdir /s /q "${userData}"`
      spawn('cmd.exe', ['/d', '/c', cleanCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()

      // 3) 定位 NSIS 卸载器（安装目录下 Uninstall *.exe）并静默启动
      const exeDir = path.dirname(app.getPath('exe'))
      let uninstaller: string | null = null
      try {
        const un = fs.readdirSync(exeDir).find((f) => /^Uninstall .+\.exe$/i.test(f))
        uninstaller = un ? path.join(exeDir, un) : null
      } catch {
        uninstaller = null
      }
      if (!uninstaller) {
        return fail('UNINSTALLER_NOT_FOUND', '未找到卸载程序（Uninstall *.exe），请从系统设置卸载')
      }
      spawn(uninstaller, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()

      // 4) 延迟退出：确保 IPC 响应送达渲染进程后再关闭
      setTimeout(() => {
        app.quit()
      }, 800)
      return ok(null)
    } catch (err) {
      logger.error('uninstall failed', err)
      return fail('UNINSTALL_FAILED', `卸载失败：${String(err)}`)
    }
  })

  // ---------- Python 分析：运行时管理 ----------

  ipcMain.handle(IPC_CHANNELS.pythonGetRuntimeInfo, () => ok(getRuntimeInfo()))

  ipcMain.handle(IPC_CHANNELS.pythonInitRuntime, () => {
    try {
      return ok(initRuntime())
    } catch (err) {
      logger.error('python runtime init failed', err)
      return fail('PYTHON_INIT_FAILED', `运行时初始化失败：${String(err)}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.pythonUninstallRuntime, () => {
    try {
      uninstallRuntime()
      return ok(null)
    } catch (err) {
      logger.error('python runtime uninstall failed', err)
      return fail('PYTHON_UNINSTALL_FAILED', `运行时卸载失败：${String(err)}`)
    }
  })

  // ---------- Python 分析：会话与执行 ----------

  /** 运行时会话执行器脚本与解释器路径（激活运行时或开发回退） */
  function pythonLaunch(): { pythonPath: string; execScript: string } | null {
    const info = getRuntimeInfo()
    if (info.status !== 'ready') return null
    return { pythonPath: info.pythonPath, execScript: resolveExecScript(path.dirname(info.pythonPath)) }
  }

  /** 流式输出转发：Worker 行输出 → 所有窗口 event:python-stream */
  function attachStream(sessionId: string): void {
    const session = getPythonSession(sessionId)
    if (!session?.worker) return
    session.worker.onStream = (e) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.eventPythonStream, { sessionId, ...e })
      }
    }
  }

  ipcMain.handle(IPC_CHANNELS.pythonCreateSession, () => {
    const launch = pythonLaunch()
    if (!launch) return fail('PYTHON_RUNTIME_MISSING', 'Python 运行时未就绪，请先在系统设置中初始化')
    const session = createPythonSession(deps.temp.instanceRoot)
    const info: PythonSessionInfo = { sessionId: session.sessionId }
    return ok(info)
  })

  ipcMain.handle(IPC_CHANNELS.pythonResetSession, (_e, payload?: { sessionId?: string }) => {
    const sessionId = payload?.sessionId
    if (sessionId) closePythonSession(sessionId)
    const launch = pythonLaunch()
    if (!launch) return fail('PYTHON_RUNTIME_MISSING', 'Python 运行时未就绪，请先在系统设置中初始化')
    const session = createPythonSession(deps.temp.instanceRoot)
    return ok({ sessionId: session.sessionId } satisfies PythonSessionInfo)
  })

  ipcMain.handle(IPC_CHANNELS.pythonRegisterImport, (_e, payload?: { sessionId?: string; items?: PythonRegisterImportItem[] }) => {
    const session = getPythonSession(payload?.sessionId ?? '')
    if (!session) return fail('PYTHON_SESSION_NOT_FOUND', 'Python 会话不存在，请重置会话后重试')
    const items = payload?.items ?? []
    const infos = []
    for (const item of items) {
      if (!deps.whitelist.isAuthorizedDir(path.dirname(item.sourcePath))) {
        return fail('PATH_NOT_AUTHORIZED', `文件未授权：${path.basename(item.sourcePath)}`)
      }
      if (!fs.existsSync(item.sourcePath)) {
        return fail('FILE_NOT_FOUND', `文件不存在：${path.basename(item.sourcePath)}`)
      }
      const f = copyImportFile(session, item.sourcePath, item.originalName, item.kind)
      f.headerRow = item.headerRow
      infos.push(f)
    }
    // Worker 存活时同步注册（预读 DataFrame）；未启动则下次执行时自动补载
    if (session.worker?.isAlive()) syncRegisteredFiles(session)
    return ok(infos)
  })

  ipcMain.handle(IPC_CHANNELS.pythonUpdateImported, (_e, payload?: { sessionId?: string; fileId?: string; patch?: Partial<{ headerRow: number | null; rowCount: number | null; varName: string }> }) => {
    const session = getPythonSession(payload?.sessionId ?? '')
    if (!session) return fail('PYTHON_SESSION_NOT_FOUND', 'Python 会话不存在')
    if (payload?.fileId) updateImportedFile(session, payload.fileId, payload.patch ?? {})
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.pythonRunCode, (_e, payload?: { sessionId?: string; code?: string }) => {
    const session = getPythonSession(payload?.sessionId ?? '')
    if (!session) return fail('PYTHON_SESSION_NOT_FOUND', 'Python 会话不存在，请重置会话后重试')
    const launch = pythonLaunch()
    if (!launch) return fail('PYTHON_RUNTIME_MISSING', 'Python 运行时未就绪，请先在系统设置中初始化')
    const worker = ensureWorker(session, launch.pythonPath, launch.execScript)
    attachStream(session.sessionId)
    syncRegisteredFiles(session)
    const code = payload?.code ?? ''
    if (!code.trim()) {
      const empty: PythonRunResult = { ok: false, status: 'error', elapsedMs: 0, message: '代码为空', blocks: [] }
      return ok(empty)
    }
    return new Promise<PythonRunResult>((resolve) => {
      void worker.run(code).then((r) => {
        // 结果快照：导出结果时主进程据此写文件（表格由 Worker 直写临时文件后搬运）
        session.lastBlocks = r.blocks ?? []
        session.lastText = (r.blocks ?? [])
          .filter((b) => b.kind === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
        resolve(r)
      })
    })
  })

  /** Python 导出结果：按类型分三类处理——表格（Worker 直写会话目录临时文件后原子搬运）、
   *  图表（base64 解码写文件）、文本（拼接写 TXT/MD）；目标路径由用户保存对话框给出。 */
  ipcMain.handle(
    IPC_CHANNELS.pythonExportResult,
    async (_e, payload?: { sessionId?: string; kind?: string; outputPath?: string }) => {
      const session = getPythonSession(payload?.sessionId ?? '')
      if (!session) return fail('PYTHON_SESSION_NOT_FOUND', 'Python 会话不存在')
      const kind = payload?.kind ?? ''
      const outputPath = payload?.outputPath ?? ''
      if (!outputPath) return fail('INVALID_OUTPUT_PATH', '导出路径为空')
      const targetDir = path.dirname(outputPath)
      if (!deps.whitelist.isAuthorizedDir(targetDir)) {
        return fail('PATH_NOT_AUTHORIZED', '导出目录未授权')
      }

      // 表格类：Worker 直写会话目录临时文件 → 主进程读取 → 原子写目标
      const tableKinds = ['csv', 'excel', 'json', 'sqlite']
      if (tableKinds.includes(kind)) {
        const launch = pythonLaunch()
        if (!launch) return fail('PYTHON_RUNTIME_MISSING', 'Python 运行时未就绪')
        const worker = ensureWorker(session, launch.pythonPath, launch.execScript)
        const tmpTarget = path.join(session.dir, `__export_tmp.${kind === 'sqlite' ? 'db' : kind}`)
        const res = await worker.exportTable(kind as 'csv' | 'excel' | 'json' | 'sqlite', tmpTarget)
        if (!res.ok) return fail('PYTHON_EXPORT_FAILED', res.message)
        const buf = fs.readFileSync(tmpTarget)
        const writeResult = atomicWriteFile(outputPath, (tmp) => fs.writeFileSync(tmp, buf))
        try {
          fs.rmSync(tmpTarget, { force: true })
        } catch {
          /* 临时文件由会话清理兜底 */
        }
        if (!writeResult.ok) return fail('EXPORT_WRITE_FAILED', writeResult.error)
        return ok({ path: outputPath })
      }

      // 图表类：取最近一次结果中的最后一张图，base64 解码后原子写
      if (kind === 'png' || kind === 'svg') {
        const imgs = (session.lastBlocks ?? []).filter((b) => b.kind === 'image')
        const last = imgs[imgs.length - 1]
        if (!last) return fail('NO_IMAGE_RESULT', '没有可导出的图表（请先运行代码生成图表）')
        const buf = Buffer.from(last.data ?? '', 'base64')
        const writeResult = atomicWriteFile(outputPath, (tmp) => fs.writeFileSync(tmp, buf))
        if (!writeResult.ok) return fail('EXPORT_WRITE_FAILED', writeResult.error)
        return ok({ path: outputPath })
      }

      // 文本类：拼接最近一次执行的文本输出写 TXT / Markdown
      if (kind === 'txt' || kind === 'md') {
        const text = session.lastText || ''
        const writeResult = atomicWriteFile(outputPath, (tmp) => fs.writeFileSync(tmp, text, 'utf-8'))
        if (!writeResult.ok) return fail('EXPORT_WRITE_FAILED', writeResult.error)
        return ok({ path: outputPath })
      }

      return fail('UNSUPPORTED_EXPORT_KIND', `不支持的导出格式：${kind}`)
    }
  )

  /** Python 结果保存对话框：按导出格式给过滤器与默认文件名，记住上次导出目录 */
  ipcMain.handle(IPC_CHANNELS.pythonChooseExportFile, async (_e, payload?: { kind?: string }) => {
    const kind = payload?.kind ?? 'csv'
    const map: Record<string, { ext: string; name: string }> = {
      csv: { ext: 'csv', name: 'CSV 文件' },
      excel: { ext: 'xlsx', name: 'Excel 文件' },
      json: { ext: 'json', name: 'JSON 文件' },
      sqlite: { ext: 'db', name: 'SQLite 数据库' },
      png: { ext: 'png', name: 'PNG 图片' },
      svg: { ext: 'svg', name: 'SVG 图片' },
      txt: { ext: 'txt', name: '文本文件' },
      md: { ext: 'md', name: 'Markdown 文件' }
    }
    const cfg = map[kind] ?? map.csv
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, {
      title: '导出 Python 结果',
      defaultPath: path.join(
        config.getPreferences().lastExportDirectory || app.getPath('documents'),
        `python结果_${exportTimestamp()}.${cfg.ext}`
      ),
      filters: [{ name: cfg.name, extensions: [cfg.ext] }]
    })
    if (result.canceled || !result.filePath) return ok({ path: null })
    // 记住本次导出目录，下次默认定位到同一文件夹。
    config.setPreferences({ lastExportDirectory: path.dirname(result.filePath) })
    deps.whitelist.authorize(path.dirname(result.filePath))
    return ok({ path: result.filePath })
  })

  ipcMain.handle(IPC_CHANNELS.pythonCancelRun, (_e, payload?: { sessionId?: string }) => {
    const session = getPythonSession(payload?.sessionId ?? '')
    if (!session?.worker) return ok(null)
    session.worker.cancel()
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.pythonFormatCode, async (_e, payload?: { sessionId?: string; code?: string }) => {
    const session = getPythonSession(payload?.sessionId ?? '')
    if (!session) return fail('PYTHON_SESSION_NOT_FOUND', 'Python 会话不存在')
    const launch = pythonLaunch()
    if (!launch) return fail('PYTHON_RUNTIME_MISSING', 'Python 运行时未就绪，请先在系统设置中初始化')
    const worker = ensureWorker(session, launch.pythonPath, launch.execScript)
    attachStream(session.sessionId)
    const res = await worker.format(payload?.code ?? '')
    return ok(res)
  })

  // ---------- 任务（单任务模型 + 快照/增量重连） ----------

  ipcMain.handle(IPC_CHANNELS.getCurrentTask, () => ok(tasks.getActive()[0] ?? null))

  ipcMain.handle(IPC_CHANNELS.getActiveTasks, () => ok(tasks.getActive()))

  ipcMain.handle(
    IPC_CHANNELS.subscribeTask,
    (_e, payload: SubscribeTaskPayload) => {
      const result: SubscribeTaskResult = tasks.subscribe(payload.taskId, payload.lastSeq)
      return ok(result)
    }
  )

  ipcMain.handle(IPC_CHANNELS.cancelTask, (_e, payload?: { taskId?: string }) => {
    // 取消 = terminate 对应页面的 worker（连接丢弃，未提交事务自动回滚），再置任务为 cancelled。
    const taskId = payload?.taskId
    const task = taskId ? tasks.get(taskId) : null
    if (task?.page === 'analyze') terminateWorker('analyze')
    else terminateWorker('convert')
    if (taskId) convertState.snapshots.delete(taskId)
    else convertState.snapshots.clear()
    const cancelled = tasks.cancel(taskId)
    return ok({ cancelled: cancelled.length })
  })

  // 关闭窗口：渲染进程自研确认框确认后调用。
  ipcMain.handle(IPC_CHANNELS.confirmClose, () => {
    BrowserWindow.getAllWindows()[0]?.destroy()
    return ok(null)
  })

  // 拖拽授权：仅用户真实拖入的路径可授权（主进程校验存在性后加入白名单）。
  ipcMain.handle(IPC_CHANNELS.authorizeDrop, (_e, payload: { paths: string[] }) => {
    for (const p of payload?.paths ?? []) {
      if (typeof p === 'string' && p.length > 0 && fs.existsSync(p)) {
        whitelist.authorizeFile(p)
      }
    }
    return ok(null)
  })

  // ---------- 格式转换 ----------

  ipcMain.handle(IPC_CHANNELS.convertParseWorkbook, (_e, payload: { filePath: string }) => {
    return runParseTask(payload.filePath, deps)
  })

  ipcMain.handle(IPC_CHANNELS.convertInspectSheet, async (_e, payload: InspectSheetPayload) => {
    // 表头行/公式/合并模式变化：按参数重采样目标工作表，覆盖会话预览，导出预览同步生效。
    const session = convertState.session
    if (!session || session.filePath !== payload.filePath) {
      return fail('SOURCE_NOT_PARSED', '请先解析源文件再调整预览')
    }
    try {
      const meta = session.parsed.workbook.sheets.find((s) => s.id === payload.sheetId)
      const inspect = await inspectSheetFile(
        payload.filePath,
        payload.sheetId,
        meta?.name ?? `Sheet ${payload.sheetId + 1}`,
        {
          headerRowIndex: payload.headerRowIndex,
          formulaMode: payload.formulaMode,
          mergeMode: payload.mergeMode
        }
      )
      session.parsed.inspects[payload.sheetId] = inspect
      return ok({ workbook: session.parsed.workbook, inspects: session.parsed.inspects })
    } catch (err) {
      return fail('INSPECT_FAILED', `重新解析失败：${String(err instanceof Error ? err.message : err)}`)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.convertPreviewExport,
    (_e, payload: { config: ExportConfig }) => {
      const session = convertState.session
      if (!session || session.filePath !== payload.config.sourcePath) {
        return fail('SOURCE_NOT_PARSED', '请先解析源文件再预览导出')
      }
      if (!whitelist.isAuthorizedDir(payload.config.outputDir)) {
        return fail('OUTPUT_NOT_AUTHORIZED', '输出目录未授权，请重新选择目录')
      }
      const preview = buildExportPreview(payload.config, session.parsed.inspects)
      const taskId = randomUUID()
      convertState.snapshots.set(taskId, {
        config: payload.config,
        hash: preview.configHash,
        fileNames: Object.fromEntries(
          preview.files.map((f) => [f.sheetId, f.fileName])
        ),
        sheetNames: Object.fromEntries(
          preview.files.map((f) => [f.sheetId, f.sheetName])
        ),
        tableNames: Object.fromEntries(
          preview.files.map((f) => [f.sheetId, f.tableName])
        )
      })
      // 预览确认阶段占住本页任务（awaiting_confirm 独立状态）
      if (!tasks.begin({
        taskId,
        title: '导出预览',
        page: 'convert',
        detail: {
          action: 'export-preview',
          targetKind: preview.targetKind,
          sheets: preview.files.map((f) => f.sheetName),
          totalRows: preview.files.reduce((s, f) => s + (f.rowCount ?? 0), 0),
          outputDir: preview.outputDir
        }
      })) {
        return fail('TASK_BUSY', '格式转换已有任务运行中，请等待或取消')
      }
      tasks.awaitConfirm(taskId)
      // 兜底：前端确认框关闭/断连时任务卡在 awaiting_confirm 会锁死本页任务，
      // 30 秒后自动终结（前端再确认会得到 SNAPSHOT_NOT_FOUND 提示重新预览）。
      setTimeout(() => {
        const current = tasks.get(taskId)
        if (current && current.status === 'awaiting_confirm') {
          convertState.snapshots.delete(taskId)
          tasks.cancel(taskId)
          logger.warn('export preview confirm timed out, task cancelled', { taskId })
        }
      }, 30_000)
      const result: ExportPreviewResult = {
        taskId,
        files: preview.files,
        issues: preview.issues,
        targetKind: preview.targetKind,
        outputDir: preview.outputDir,
        configHash: preview.configHash
      }
      logger.info('[event=export-preview]', {
        taskId,
        targetKind: preview.targetKind,
        files: preview.files.map((f) => f.fileName)
      })
      return ok(result)
    }
  )

  ipcMain.handle(IPC_CHANNELS.convertConfirmExport, (_e, payload: { taskId: string }) => {
    const snapshot = convertState.snapshots.get(payload.taskId)
    if (!snapshot) {
      return fail('SNAPSHOT_NOT_FOUND', '导出配置快照不存在或已过期，请重新预览')
    }
    const current = tasks.get(payload.taskId)
    if (!current || current.status !== 'awaiting_confirm') {
      return fail('TASK_STATE_INVALID', '任务状态无效，请重新预览导出')
    }
    convertState.snapshots.delete(payload.taskId)

    // 目标文件冲突处理。
    const finalNames: Record<number, string> = {}
    for (const [sheetId, fileName] of Object.entries(snapshot.fileNames)) {
      const full = path.join(snapshot.config.outputDir, fileName)
      if (fs.existsSync(full)) {
        if (snapshot.config.conflictMode === 'rename') {
          finalNames[Number(sheetId)] = renamedPath(fileName)
        } else {
          finalNames[Number(sheetId)] = fileName // overwrite：原子写先删目标
        }
      } else {
        finalNames[Number(sheetId)] = fileName
      }
    }

    const taskId = payload.taskId
    tasks.confirmProceed(taskId)
    const worker = new Worker(path.join(__dirname, '../workers/convert-worker.js'), {
      workerData: {
        config: snapshot.config,
        sheetFileNames: finalNames,
        sheetNames: snapshot.sheetNames,
        sheetTableNames: snapshot.tableNames,
        // 每次导出实时读取开关，改动无需重启生效。
        longPathSupport: config.getPreferences().longPathSupport
      }
    })
    convertState.worker = worker
    convertState.workerTaskId = taskId

    // worker 消息协议：progress 上报进度，done/cancelled/error 终结任务并复位 worker 引用。
    worker.on('message', (msg: Record<string, unknown>) => {
      if (msg.progress && typeof msg.progress === 'object') {
        const p = msg.progress as { done: number; total: number; currentStep: string; message: string }
        tasks.update(taskId, 'exporting', p.currentStep ?? '', p.done ?? 0, p.total ?? 0, p.message ?? '')
      } else if (msg.done) {
        convertState.worker = null
        convertState.workerTaskId = null
        tasks.done(taskId, '导出完成')
        logger.info('[event=export-done]', { taskId, targetKind: snapshot.config.targetKind, fileName: path.basename(snapshot.config.sourcePath) })
      } else if (msg.cancelled) {
        convertState.worker = null
        convertState.workerTaskId = null
        tasks.cancel(taskId)
      } else if (msg.error) {
        convertState.worker = null
        convertState.workerTaskId = null
        logger.error('[event=export-failed]', { taskId, targetKind: snapshot.config.targetKind, error: String(msg.error) })
        tasks.fail(taskId, 'EXPORT_FAILED', String(msg.error))
      }
    })
    worker.once('error', (err) => {
      convertState.worker = null
      convertState.workerTaskId = null
      logger.error('[event=export-failed]', { taskId, targetKind: snapshot.config.targetKind, error: String(err) })
      tasks.fail(taskId, 'EXPORT_FAILED', String(err))
    })

    return ok({ started: true, taskId })
  })

  ipcMain.handle(IPC_CHANNELS.convertResetSession, () => {
    // 重置 = 开启新会话：丢弃当前解析缓存与预览快照，前端同时清空页面状态。
    convertState.session = null
    convertState.snapshots.clear()
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.convertChooseSourceFile, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择数据文件',
      defaultPath: config.getPreferences().lastOpenDirectory || app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: '数据文件', extensions: ['csv', 'txt', 'xlsx'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return ok({ filePath: null })
    }
    const filePath = result.filePaths[0]
    // 记住本次打开目录，下次默认定位到同一文件夹。
    config.setPreferences({ lastOpenDirectory: path.dirname(filePath) })
    whitelist.authorizeFile(filePath)
    return ok({ filePath })
  })

  ipcMain.handle(IPC_CHANNELS.convertChooseOutputDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择导出目录',
      defaultPath: config.getPreferences().lastExportDirectory || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      const out: ChooseOutputDirResult = { directory: null }
      return ok(out)
    }
    const dir = result.filePaths[0]
    config.setPreferences({ lastExportDirectory: dir })
    whitelist.authorize(dir)
    const out: ChooseOutputDirResult = { directory: dir }
    return ok(out)
  })

  ipcMain.handle(IPC_CHANNELS.convertShowInFolder, (_e, payload: { filePath: string }) => {
    if (!whitelist.isAuthorizedDir(path.dirname(payload.filePath))) {
      return fail('PATH_NOT_AUTHORIZED', '路径未授权')
    }
    shell.showItemInFolder(payload.filePath)
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.convertPreviewExportContent, (_e, payload: { taskId: string; sheetId: number }) => {
    const snapshot = convertState.snapshots.get(payload.taskId)
    if (!snapshot) {
      return fail('SNAPSHOT_NOT_FOUND', '导出配置快照不存在或已过期，请重新预览')
    }
    const sheet = snapshot.config.sheets.find((s) => s.sheetId === payload.sheetId && s.include)
    if (!sheet) {
      return fail('SHEET_NOT_INCLUDED', '该工作表未勾选导出')
    }
    const inspect = convertState.session?.parsed.inspects[payload.sheetId]
    if (!inspect) {
      return fail('INSPECT_NOT_FOUND', '工作表采样数据不存在，请重新解析')
    }
    const tableName = snapshot.tableNames[payload.sheetId] ?? sheet.tableName
    try {
      const result = buildExportPreviewContent(snapshot.config, sheet, inspect, tableName)
      // 总行数以解析阶段的真实统计为准（采样结果只保留前 50 行）
      const meta = convertState.session?.parsed.workbook.sheets.find((s) => s.id === payload.sheetId)
      if (meta) result.totalRows = meta.rowCount
      return ok(result)
    } catch (err) {
      return fail('PREVIEW_CONTENT_FAILED', `生成导出内容失败：${String(err)}`)
    }
  })

  // ---------- 技术探针（框架阶段验证用） ----------

  ipcMain.handle(IPC_CHANNELS.probeWorkerQuery, () => runWorkerQuery('SELECT 1 + 1 AS v'))

  ipcMain.handle(IPC_CHANNELS.probeWorkerSlowStart, () => {
    if (slowWorker) {
      void slowWorker.terminate()
      slowWorker = null
    }
    slowWorker = new Worker(path.join(__dirname, '../workers/probe-worker.js'))
    slowWorkerStartedAt = Date.now()
    slowWorker.postMessage({
      sql: 'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 500000000) SELECT count(*) AS v FROM cnt'
    })
    return ok({ started: true })
  })

  ipcMain.handle(IPC_CHANNELS.probeWorkerCancel, () => {
    if (!slowWorker) {
      return ok<ProbeWorkerCancelResult>({ cancelled: false, durationMs: 0 })
    }
    void slowWorker.terminate()
    slowWorker = null
    const durationMs = Date.now() - slowWorkerStartedAt
    logger.info('probe slow worker cancelled', { durationMs })
    return ok<ProbeWorkerCancelResult>({ cancelled: true, durationMs })
  })

  // ---------- 数据分析 ----------

  ipcMain.handle(IPC_CHANNELS.analyzeCreateSession, () => {
    const session = createSession(temp.instanceRoot)
    return ok({ sessionId: session.sessionId, dbPath: session.dbPath, createdAt: session.createdAt })
  })

  ipcMain.handle(IPC_CHANNELS.analyzeImportFile, (_e, payload: AnalyzeImportPayload) => {
    return runImportTask(payload, deps)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeProbeImport, async (_e, payload: { filePaths: string[] }) => {
    const paths = payload?.filePaths ?? []
    if (paths.length === 0) return fail('IMPORT_EMPTY', '没有待探测的文件')
    for (const fp of paths) {
      if (!deps.whitelist.isAuthorizedDir(path.dirname(fp))) {
        return fail('PATH_NOT_AUTHORIZED', `文件未授权：${path.basename(fp)}`)
      }
      if (!fs.existsSync(fp)) {
        return fail('FILE_NOT_FOUND', `文件不存在：${path.basename(fp)}`)
      }
    }
    return await new Promise<Result<ProbeImportResult>>((resolve) => {
      const worker = new Worker(path.join(__dirname, '../workers/analyze-probe-worker.js'), {
        workerData: { filePaths: paths }
      })
      worker.once('message', (msg) => {
        void worker.terminate()
        if (msg.done) {
          resolve(ok(msg.result as ProbeImportResult))
        } else {
          logger.error('probe import failed', { error: String(msg.error ?? '结构探测失败') })
          resolve(fail('PROBE_FAILED', String(msg.error ?? '结构探测失败')))
        }
      })
      worker.once('error', (err) => {
        void worker.terminate()
        logger.error('probe worker crashed', { error: String(err) })
        resolve(fail('PROBE_FAILED', String(err)))
      })
    })
  })

  ipcMain.handle(IPC_CHANNELS.analyzeChooseFiles, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择数据文件（可多选）',
      defaultPath: config.getPreferences().lastOpenDirectory || app.getPath('documents'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '数据文件',
          extensions: ['sqlite', 'db', 'sqlite3', 'csv', 'txt', 'json', 'xlsx', 'sql', 'bson']
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return ok<AnalyzeChooseFilesResult>({ filePaths: [] })
    }
    // 记住本次打开目录（多选取第一个文件所在目录）。
    config.setPreferences({ lastOpenDirectory: path.dirname(result.filePaths[0]) })
    for (const fp of result.filePaths) deps.whitelist.authorize(path.dirname(fp))
    return ok<AnalyzeChooseFilesResult>({ filePaths: result.filePaths })
  })

  ipcMain.handle(IPC_CHANNELS.analyzeListObjects, (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在或已关闭')
    touchSession(sessionId)
    return ok(listObjects(session.db))
  })

  ipcMain.handle(IPC_CHANNELS.analyzeGetSchema, (_e, payload: { sessionId: string; tableName: string }) => {
    const session = getSession(payload.sessionId)
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在或已关闭')
    touchSession(payload.sessionId)
    try {
      const schema: AnalyzeSchemaResult = getSchema(session.db, payload.tableName)
      return ok(schema)
    } catch (err) {
      return fail('SCHEMA_FAILED', `读取表结构失败：${String(err instanceof Error ? err.message : err)}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.analyzePreviewResult, (_e, payload: { sessionId: string; tableName: string }) => {
    const session = getSession(payload.sessionId)
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在或已关闭')
    touchSession(payload.sessionId)
    try {
      const preview: AnalyzePreviewResult = previewTable(session.db, payload.tableName)
      return ok(preview)
    } catch (err) {
      return fail('PREVIEW_FAILED', `预览失败：${String(err instanceof Error ? err.message : err)}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.analyzeRunQuery, (_e, payload: AnalyzeRunQueryPayload) => {
    return runQueryTask(payload, deps)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeExportResult, (_e, payload: AnalyzeExportPayload) => {
    return runExportTask(payload, deps)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeCloseSession, (_e, sessionId: string) => {
    closeSession(sessionId)
    return ok(null)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeChooseExportFile, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, {
      title: '导出查询结果',
      defaultPath: path.join(
        config.getPreferences().lastExportDirectory || app.getPath('documents'),
        `结果_${exportTimestamp()}.csv`
      ),
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: 'JSON 文件', extensions: ['json'] },
        { name: 'SQL 文件', extensions: ['sql'] }
      ]
    })
    if (result.canceled || !result.filePath) return ok({ path: null })
    // 记住本次导出目录，下次默认定位到同一文件夹。
    config.setPreferences({ lastExportDirectory: path.dirname(result.filePath) })
    whitelist.authorize(path.dirname(result.filePath))
    return ok({ path: result.filePath })
  })

  ipcMain.handle(IPC_CHANNELS.analyzeShowInFolder, (_e, filePath: string) => {
    if (!whitelist.isAuthorizedDir(path.dirname(filePath))) {
      return fail('PATH_NOT_AUTHORIZED', '路径未授权')
    }
    shell.showItemInFolder(filePath)
    return ok(null)
  })

  // ---------- 会话空闲回收 ----------
  // 数据分析临时 SQLite 长时间不活动会一直占磁盘；每 60 秒扫描，
  // 超过 30 分钟未使用的会话自动关闭，并通知前端清空状态。
  const SESSION_IDLE_TTL_MS = 30 * 60 * 1000
  setInterval(() => {
    const expired = closeExpiredSessions(SESSION_IDLE_TTL_MS)
    if (expired.length === 0) return
    logger.info('[event=session-expired]', { sessionIds: expired, ttlMs: SESSION_IDLE_TTL_MS })
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.eventSessionExpired, { sessionIds: expired })
      }
    }
  }, 60_000)
}

/** 终止指定页面的 worker（parse/convert 归 convert，import/query/export 归 analyze） */
function terminateWorker(page: 'convert' | 'analyze'): void {
  const state = page === 'convert' ? convertState : analyzeState
  if (state.worker) {
    void state.worker.terminate()
    state.worker = null
    state.workerTaskId = null
  }
}

/** terminate 当前所有活跃 worker */
function terminateActiveWorkers(): void {
  terminateWorker('convert')
  terminateWorker('analyze')
}

// 模块级 TaskManager 引用：退出清理（cancelAllActiveTasks）需要全量取消任务，
// 而 tasks 实例在 registerIpcHandlers 闭包内创建。
let taskManagerRef: TaskManager | null = null

/** 应用退出前调用：先终止全部 worker 并终结任务，再清理会话（main.ts before-quit） */
export function cancelAllActiveTasks(): void {
  terminateActiveWorkers()
  convertState.snapshots.clear()
  taskManagerRef?.cancel()
  closeAllSessions()
}

/** parse 任务：全局任务锁 + worker 解析，成功后缓存 ParsedSource */
async function runParseTask(
  filePath: string,
  deps: IpcDeps
): Promise<Result<{ workbook: WorkbookInfo; inspects: Record<number, SheetInspectResult> }>> {
  const { tasks, whitelist } = deps
  if (!whitelist.isAuthorized(filePath)) {
    return fail('PATH_NOT_AUTHORIZED', '文件路径未授权，请通过文件选择或拖拽导入')
  }
  if (!fs.existsSync(filePath)) {
    return fail('FILE_NOT_FOUND', '文件不存在')
  }
  const ext = path.extname(filePath).toLowerCase()
  if (!['.csv', '.txt', '.xlsx', '.xls'].includes(ext)) {
    return fail('UNSUPPORTED_TYPE', `不支持的文件类型：${ext}`)
  }
  // .xls 为旧版 OLE2 二进制格式，exceljs 仅支持 .xlsx（zip 封装），直接明确提示避免长时间无响应。
  if (ext === '.xls') {
    return fail('UNSUPPORTED_XLS', '不支持 .xls 旧格式，请用 Excel/WPS 将文件另存为 .xlsx 后导入')
  }
  const taskId = randomUUID()
  const stat = fs.statSync(filePath)
  if (!tasks.begin({
    taskId,
    title: `解析 ${path.basename(filePath)}`,
    page: 'convert',
    detail: {
      action: 'parse',
      fileName: path.basename(filePath),
      fileSize: stat.size,
      ext
    }
  })) {
    return fail('TASK_BUSY', '格式转换已有任务运行中，请等待或取消')
  }
  const startedAt = Date.now()
  logger.info('[event=file-parse]', { taskId, fileName: path.basename(filePath), fileSize: stat.size, ext })

  return await new Promise<Result<{ workbook: WorkbookInfo; inspects: Record<number, SheetInspectResult> }>>((resolve) => {
    const worker = new Worker(path.join(__dirname, '../workers/parse-worker.js'), {
      workerData: { filePath }
    })
    convertState.worker = worker
    convertState.workerTaskId = taskId

    worker.on('message', (msg: Record<string, unknown>) => {
      void worker.terminate()
      if (convertState.worker === worker) {
        convertState.worker = null
        convertState.workerTaskId = null
      }
      if (msg.ok) {
        const parsed = msg.result as ParsedSource
        // 解析成功 = 建立/覆盖当前会话（异路径解析自动丢弃旧会话缓存）。
        convertState.session = { filePath, parsed }
        tasks.done(taskId, '解析完成')
        logger.info('[event=file-parse-done]', {
          taskId,
          fileName: path.basename(filePath),
          sheets: parsed.workbook.sheets.length,
          durationMs: Date.now() - startedAt
        })
        resolve(ok({ workbook: parsed.workbook, inspects: parsed.inspects }))
      } else {
        logger.error('[event=file-parse-failed]', { taskId, fileName: path.basename(filePath), error: String(msg.error) })
        tasks.fail(taskId, 'PARSE_FAILED', String(msg.error))
        resolve(fail('PARSE_FAILED', String(msg.error)))
      }
    })
    worker.once('error', (err) => {
      if (convertState.worker === worker) {
        convertState.worker = null
        convertState.workerTaskId = null
      }
      logger.error('[event=file-parse-failed]', { taskId, fileName: path.basename(filePath), error: String(err) })
      tasks.fail(taskId, 'PARSE_FAILED', String(err))
      resolve(fail('PARSE_FAILED', String(err)))
    })
  })
}

/** 目标文件已存在且策略为 rename 时：加 _1 序号（保留扩展名） */
function renamedPath(fileName: string): string {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let n = 1
  let candidate = `${base}_${n}${ext}`
  while (fs.existsSync(path.join(path.dirname(fileName), candidate))) {
    n++
    candidate = `${base}_${n}${ext}`
  }
  return path.join(path.dirname(fileName), candidate)
}

// 探针：worker 内 better-sqlite3 查询（框架阶段验证用，正式功能开发时移除）。
let slowWorker: Worker | null = null
let slowWorkerStartedAt = 0

function runWorkerQuery(sql: string): Promise<Result<ProbeWorkerResult>> {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, '../workers/probe-worker.js'))
    const started = Date.now()
    worker.once('message', (msg) => {
      void worker.terminate()
      if (msg.ok) {
        logger.info('probe worker query done', {
          sqliteVersion: msg.sqliteVersion,
          queryResult: msg.queryResult,
          durationMs: Date.now() - started
        })
        resolve(
          ok({
            sqliteVersion: msg.sqliteVersion,
            queryResult: msg.queryResult,
            durationMs: Date.now() - started
          })
        )
      } else {
        logger.error('probe worker query failed', { error: String(msg.error) })
        resolve(fail('PROBE_WORKER_ERROR', String(msg.error)))
      }
    })
    worker.once('error', (e) => {
      void worker.terminate()
      logger.error('probe worker error', { error: String(e) })
      resolve(fail('PROBE_WORKER_ERROR', String(e)))
    })
    worker.postMessage({ sql })
  })
}

// ---------- 数据分析：注册在 registerIpcHandlers 内（见函数体末尾） ----------

/** 导入任务：全局单任务锁 + import worker（多文件多表按映射落库，支持复用会话） */
function runImportTask(payload: AnalyzeImportPayload, deps: IpcDeps): Promise<Result<AnalyzeImportResult>> {
  return new Promise((resolve) => {
    if (!payload.files || payload.files.length === 0) {
      resolve(fail('IMPORT_EMPTY', '没有待导入的数据'))
      return
    }
    for (const f of payload.files) {
      if (!deps.whitelist.isAuthorizedDir(path.dirname(f.filePath))) {
        resolve(fail('PATH_NOT_AUTHORIZED', `文件未授权，请通过文件选择或拖拽导入：${path.basename(f.filePath)}`))
        return
      }
      if (!fs.existsSync(f.filePath)) {
        resolve(fail('FILE_NOT_FOUND', `文件不存在：${path.basename(f.filePath)}`))
        return
      }
    }
    const session = payload.sessionId ? getSession(payload.sessionId) : createSession(deps.temp.instanceRoot)
    if (!session) {
      resolve(fail('SESSION_NOT_FOUND', '会话不存在或已关闭'))
      return
    }
    touchSession(session.sessionId)
    const taskId = randomUUID()
    if (!deps.tasks.begin({
      taskId,
      title: '导入数据',
      page: 'analyze',
      sessionId: session.sessionId,
      detail: {
        action: 'import',
        files: payload.files.map((f) => path.basename(f.filePath))
      }
    })) {
      if (!payload.sessionId) closeSession(session.sessionId)
      resolve(fail('TASK_BUSY', '数据分析已有任务运行中，请等待或取消'))
      return
    }
    const importStartedAt = Date.now()
    // 按文件分组统计元数据（一个文件可含多张表）。
    const fileMetaMap = new Map<string, { fileName: string; fileSize: number; tables: number }>()
    for (const f of payload.files) {
      const entry = fileMetaMap.get(f.filePath) ?? { fileName: path.basename(f.filePath), fileSize: 0, tables: 0 }
      entry.tables++
      fileMetaMap.set(f.filePath, entry)
    }
    for (const [filePath, entry] of fileMetaMap) {
      try {
        entry.fileSize = fs.statSync(filePath).size
      } catch {
        /* 文件在导入前被移除，worker 会报错 */
      }
    }
    logger.info('[event=import-start]', { taskId, sessionId: session.sessionId, files: [...fileMetaMap.values()] })
    const worker = new Worker(path.join(__dirname, '../workers/import-worker.js'), {
      workerData: { dbPath: session.dbPath, imports: payload.files }
    })
    analyzeState.worker = worker
    analyzeState.workerTaskId = taskId
    worker.once('message', (msg) => {
      if (msg.done) {
        deps.tasks.update(taskId, 'importing', '完成', 1, 1, '导入完成')
        const result: AnalyzeImportResult = msg.result
        deps.tasks.done(taskId, '导入完成')
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        void worker.terminate()
        logger.info('[event=import-done]', {
          taskId,
          sessionId: session.sessionId,
          tables: result.tables?.length ?? 0,
          durationMs: Date.now() - importStartedAt
        })
        resolve(ok({ ...result, sessionId: session.sessionId, dbPath: session.dbPath }))
      } else {
        deps.tasks.fail(taskId, 'IMPORT_FAILED', String(msg.error ?? '导入失败'))
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        if (!payload.sessionId) closeSession(session.sessionId)
        void worker.terminate()
        logger.warn('[event=import-failed]', { taskId, sessionId: session.sessionId, error: String(msg.error ?? '导入失败') })
        resolve(fail('IMPORT_FAILED', String(msg.error ?? '导入失败')))
      }
    })
    worker.once('error', (err) => {
      deps.tasks.fail(taskId, 'IMPORT_FAILED', String(err))
      analyzeState.worker = null
      analyzeState.workerTaskId = null
      if (!payload.sessionId) closeSession(session.sessionId)
      logger.error('[event=import-failed]', { taskId, sessionId: session.sessionId, error: String(err) })
      resolve(fail('IMPORT_FAILED', String(err)))
    })
  })
}

/** 查询任务：预检 + 单任务锁 + query worker */
function runQueryTask(payload: AnalyzeRunQueryPayload, deps: IpcDeps): Promise<Result<AnalyzeQueryResult>> {
  return new Promise((resolve) => {
    const session = getSession(payload.sessionId)
    if (!session) {
      resolve(fail('SESSION_NOT_FOUND', '会话不存在或已关闭'))
      return
    }
    const allowModify = deps.config.getPreferences().allowModifyTempDb
    const check = checkSql(payload.sql, {
      readonly: !allowModify,
      sessionTempDir: path.dirname(session.dbPath)
    })
    if (!check.allowed) {
      resolve(fail(check.errorCode ?? 'SQL_BLOCKED', check.errorMessage ?? 'SQL 被拦截'))
      return
    }
    const taskId = randomUUID()
    if (!deps.tasks.begin({
      taskId,
      title: '执行查询',
      page: 'analyze',
      sessionId: payload.sessionId,
      detail: {
        action: 'query',
        // SQL 全文含业务数据，只记录语句类型与条数
        sqlKinds: check.statements.map((s) => s.kind),
        statementCount: check.statements.length,
        limit: payload.limit ?? 100000
      }
    })) {
      resolve(fail('TASK_BUSY', '数据分析已有任务运行中，请等待或取消'))
      return
    }
    touchSession(payload.sessionId)
    const statements = check.statements.map((s) => s.sql)
    const worker = new Worker(path.join(__dirname, '../workers/query-worker.js'), {
      workerData: {
        dbPath: session.dbPath,
        statements,
        // 执行层上限：不传 limit 时默认 10 万行，防止 SELECT * 全量拖垮内存。
        limit: payload.limit ?? 100000,
        readonly: !allowModify
      }
    })
    analyzeState.worker = worker
    analyzeState.workerTaskId = taskId
    worker.once('message', (msg) => {
      if (msg.done) {
        deps.tasks.update(taskId, 'querying', '完成', 1, 1, '查询完成')
        deps.tasks.done(taskId, '查询完成')
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        void worker.terminate()
        const first = msg.results?.[0]
        logger.info('[event=query-done]', {
          taskId,
          sessionId: payload.sessionId,
          rowCount: first?.rowCount ?? 0,
          durationMs: msg.elapsedMs ?? 0
        })
        resolve(
          ok({
            columns: first?.columns ?? [],
            rows: first?.rows ?? [],
            rowCount: first?.rowCount ?? 0,
            truncated: first?.truncated ?? false,
            elapsedMs: msg.elapsedMs ?? 0,
            explainPlan: first?.explainPlan ?? null
          })
        )
      } else {
        deps.tasks.fail(taskId, 'QUERY_FAILED', String(msg.error ?? '查询失败'))
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        void worker.terminate()
        logger.warn('[event=query-failed]', { taskId, sessionId: payload.sessionId, error: String(msg.error ?? '查询失败') })
        resolve(fail('QUERY_FAILED', String(msg.error ?? '查询失败')))
      }
    })
    worker.once('error', (err) => {
      deps.tasks.fail(taskId, 'QUERY_FAILED', String(err))
      analyzeState.worker = null
      analyzeState.workerTaskId = null
      logger.error('[event=query-failed]', { taskId, sessionId: payload.sessionId, error: String(err) })
      resolve(fail('QUERY_FAILED', String(err)))
    })
  })
}

/** 导出任务：单任务锁 + export worker */
function runExportTask(payload: AnalyzeExportPayload, deps: IpcDeps): Promise<Result<AnalyzeExportResult>> {
  return new Promise((resolve) => {
    const session = getSession(payload.sessionId)
    if (!session) {
      resolve(fail('SESSION_NOT_FOUND', '会话不存在或已关闭'))
      return
    }
    if (!deps.whitelist.isAuthorizedDir(path.dirname(payload.outputPath))) {
      resolve(fail('OUTPUT_NOT_AUTHORIZED', '输出目录未授权，请重新选择'))
      return
    }
    const taskId = randomUUID()
    if (!deps.tasks.begin({
      taskId,
      title: '导出结果',
      page: 'analyze',
      sessionId: payload.sessionId,
      detail: {
        action: 'export',
        targetKind: payload.targetKind,
        fileName: path.basename(payload.outputPath)
      }
    })) {
      resolve(fail('TASK_BUSY', '数据分析已有任务运行中，请等待或取消'))
      return
    }
    touchSession(payload.sessionId)
    logger.info('[event=export-start]', {
      taskId,
      sessionId: payload.sessionId,
      targetKind: payload.targetKind,
      fileName: path.basename(payload.outputPath)
    })
    const worker = new Worker(path.join(__dirname, '../workers/export-worker.js'), {
      workerData: {
        dbPath: session.dbPath,
        sql: payload.sql,
        targetKind: payload.targetKind,
        outputPath: payload.outputPath,
        limit: payload.limit ?? 1000000,
        // 每次导出实时读取开关，改动无需重启生效。
        longPathSupport: deps.config.getPreferences().longPathSupport
      }
    })
    analyzeState.worker = worker
    analyzeState.workerTaskId = taskId
    worker.once('message', (msg) => {
      if (msg.done) {
        deps.tasks.update(taskId, 'exporting', '完成', 1, 1, '导出完成')
        deps.tasks.done(taskId, '导出完成')
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        void worker.terminate()
        logger.info('[event=export-done]', {
          taskId,
          sessionId: payload.sessionId,
          targetKind: payload.targetKind,
          fileName: path.basename(payload.outputPath),
          rowCount: msg.rowCount ?? 0,
          durationMs: msg.elapsedMs ?? 0
        })
        resolve(ok({ rowCount: msg.rowCount ?? 0, elapsedMs: msg.elapsedMs ?? 0 }))
      } else {
        deps.tasks.fail(taskId, 'EXPORT_FAILED', String(msg.error ?? '导出失败'))
        analyzeState.worker = null
        analyzeState.workerTaskId = null
        void worker.terminate()
        logger.warn('[event=export-failed]', {
          taskId,
          sessionId: payload.sessionId,
          targetKind: payload.targetKind,
          error: String(msg.error ?? '导出失败')
        })
        resolve(fail('EXPORT_FAILED', String(msg.error ?? '导出失败')))
      }
    })
    worker.once('error', (err) => {
      deps.tasks.fail(taskId, 'EXPORT_FAILED', String(err))
      analyzeState.worker = null
      analyzeState.workerTaskId = null
      logger.error('[event=export-failed]', {
        taskId,
        sessionId: payload.sessionId,
        targetKind: payload.targetKind,
        error: String(err)
      })
      resolve(fail('EXPORT_FAILED', String(err)))
    })
  })
}

function exportTimestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 应用退出时清理全部会话（main.ts before-quit 调用） */
export function shutdownAnalyze(): void {
  terminateActiveWorkers()
  closeAllSessions()
}
