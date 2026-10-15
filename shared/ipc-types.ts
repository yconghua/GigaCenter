/**
 * IPC 通道与 payload 类型定义
 * 主进程、preload、渲染进程共用，编译期校验两端类型一致。
 */
export const IPC_CHANNELS = {
  // 应用信息
  ping: 'app:ping',
  getAppInfo: 'app:get-app-info',
  getPaths: 'app:get-paths',
  openDevTools: 'app:open-devtools',
  openExeFolder: 'app:open-exe-folder',
  openFolder: 'app:open-folder',
  showInFolder: 'app:show-in-folder',
  // 配置
  getSettings: 'settings:get',
  setPreferences: 'settings:set-preferences',
  clearPreferences: 'settings:clear-preferences',
  exportDiagnostics: 'settings:export-diagnostics',
  // 任务（事件缓冲与任务管理器阶段 1 落地，数据工作台阶段 2 接入）
  getCurrentTask: 'task:get-current',
  getActiveTasks: 'task:get-active',
  subscribeTask: 'task:subscribe',
  cancelTask: 'task:cancel',
  confirmClose: 'app:confirm-close',
  /** 拖拽授权：渲染进程仅在用户真实拖入文件时调用（主进程校验路径存在后授权父目录） */
  authorizeDrop: 'app:authorize-drop',
  // 格式转换（独立导航页）
  convertParseWorkbook: 'convert:parse-workbook',
  convertInspectSheet: 'convert:inspect-sheet',
  convertPreviewExport: 'convert:preview-export',
  convertConfirmExport: 'convert:confirm-export',
  convertChooseOutputDir: 'convert:choose-output-dir',
  convertShowInFolder: 'convert:show-in-folder',
  convertChooseSourceFile: 'convert:choose-source-file',
  /** 格式转换重置：清空主进程旧会话缓存（前端重置按钮调用） */
  convertResetSession: 'convert:reset-session',
  // 数据分析（数据工作台 Tab「数据分析」）
  analyzeCreateSession: 'analyze:create-session',
  analyzeProbeImport: 'analyze:probe-import',
  analyzeImportFile: 'analyze:import-file',
  analyzeChooseFiles: 'analyze:choose-files',
  analyzeListObjects: 'analyze:list-objects',
  analyzeGetSchema: 'analyze:get-schema',
  analyzeRunQuery: 'analyze:run-query',
  analyzePreviewResult: 'analyze:preview-result',
  analyzeExportResult: 'analyze:export-result',
  analyzeCloseSession: 'analyze:close-session',
  analyzeChooseExportFile: 'analyze:choose-export-file',
  analyzeShowInFolder: 'analyze:show-in-folder',
  // 技术探针（框架阶段验证用，正式功能开发时移除）
  probeWorkerQuery: 'probe:worker-query',
  probeWorkerSlowStart: 'probe:worker-slow-start',
  probeWorkerCancel: 'probe:worker-cancel',
  // 事件（主进程 -> 渲染进程）
  eventProbe: 'event:probe',
  eventTask: 'event:task',
  /** 会话因空闲超时被主进程回收后通知前端（前端清空会话状态并提示） */
  eventSessionExpired: 'event:session-expired',
  /** 系统/设置主题变化推送（跟随系统档运行时切换实时生效） */
  eventNativeTheme: 'event:native-theme'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 统一错误结构 */
export interface AppError {
  code: string
  message: string
}

/** 统一返回结构：Result<T, AppError> */
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

/** 应用信息 */
export interface AppInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: string
  instanceId: string
  /** 当前生效主题（跟随系统档解析后的结果），前端初始化时应用 */
  resolvedTheme: 'light' | 'dark'
}

export interface PingPayload {
  message: string
  receivedAt: number
}

export interface PingResult {
  pong: string
  receivedAt: number
  handledAt: number
}

/** 探针：worker 内 better-sqlite3 查询结果 */
export interface ProbeWorkerResult {
  sqliteVersion: string
  queryResult: unknown
  durationMs: number
}

export interface ProbeWorkerCancelResult {
  cancelled: boolean
  durationMs: number
}

// 配置

/** UI 偏好：只持久化 UI 偏好，不存原始数据/查询结果/文件名/临时路径 */
export interface AppPreferences {
  theme: 'system' | 'light' | 'dark'
  tableDensity: 'compact' | 'normal' | 'loose'
  fontSize: number
  shortcuts: Record<string, string>
  lastOpenDirectory: string
  lastExportDirectory: string
  allowModifyTempDb: boolean
  /** 启用 \\?\ 长路径支持（默认关） */
  longPathSupport: boolean
  /** 系统通知开关：仅长任务完成/失败，默认开 */
  notificationsEnabled: boolean
}

/** 路径信息（系统设置页展示） */
export interface PathInfo {
  configDir: string
  logDir: string
  tempRoot: string
  sessionTempUsedBytes: number
  instanceId: string
}

// ---------- 任务状态机与事件 ----------

/** 任务归属页面：页面间任务可并行，同页同时一个任务 */
export type TaskPage = 'convert' | 'analyze'

export type TaskStatus =
  | 'idle'
  | 'running'
  | 'awaiting_confirm'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TaskSnapshot {
  taskId: string
  page: TaskPage
  status: TaskStatus
  phase: string
  title: string
  currentStep: string
  done: number
  total: number
  elapsedMs: number
  warnings: string[]
  message: string
  startedAt: number
  /** 任务详情（操作参数），用于日志回溯 */
  detail?: Record<string, unknown>
}

export type TaskEventType =
  | 'task-progress'
  | 'task-warning'
  | 'task-done'
  | 'task-error'
  | 'task-cancelled'

/** 任务事件：带单调序号，支持快照 + 增量重连 */
export interface TaskEvent {
  seq: number
  type: TaskEventType
  taskId: string
  page?: TaskPage
  sessionId?: string
  phase?: string
  payload: Record<string, unknown>
  at: number
}

export interface SubscribeTaskPayload {
  taskId: string
  lastSeq: number
}

export interface SubscribeTaskResult {
  snapshot: TaskSnapshot | null
  events: TaskEvent[]
  /** 快照已过期：lastSeq 超出环形缓冲，需强制拉全量快照 */
  snapshotExpired: boolean
}

// ---------- preload 暴露的 API ----------

/** preload 暴露给渲染进程的白名单 API 形状 */
export interface GigaCenterApi {
  invoke<T = unknown>(channel: IpcChannel, payload?: unknown): Promise<Result<T>>
  on(channel: IpcChannel, cb: (payload: unknown) => void): () => void
}

// ---------- 格式转换 ----------

export type ConvertFileKind = 'csv' | 'txt' | 'xlsx' | 'xls'

export interface SheetMeta {
  id: number
  name: string
  rowCount: number
  colCount: number
  hidden: boolean
}

export interface WorkbookInfo {
  filePath: string
  fileName: string
  fileSize: number
  kind: ConvertFileKind
  encoding: string
  encodingConfidence: number | null
  sheets: SheetMeta[]
}

export type ColumnType = 'text' | 'integer' | 'real' | 'date' | 'boolean'

export interface ColumnSample {
  index: number
  header: string
  sampleValues: (string | null)[]
  inferredType: ColumnType
  confidence: number
  needsConfirm: boolean
  warnings: string[]
}

export interface SheetInspectResult {
  sheetId: number
  sheetName: string
  columns: ColumnSample[]
  /** 前 50 行数据（不含表头） */
  rows: (string | null)[][]
  /** 该 Sheet 的信息提示（公式/批注/合并等） */
  notices: string[]
}

export interface InspectSheetPayload {
  filePath: string
  sheetId: number
  headerRowIndex: number
  formulaMode: 'value' | 'formula'
  mergeMode: 'fill' | 'blank'
}

export type ExportTargetKind = 'csv' | 'sqlite' | 'mysql' | 'postgresql' | 'sqlserver' | 'mongodb'

export interface SheetExportConfig {
  sheetId: number
  include: boolean
  tableName: string
  /** 列类型（column index -> 类型），用户手动修正后的值 */
  columnTypes: Record<number, ColumnType>
  /** 用户改写的列名（column index -> 新列名），未改的列不在其中 */
  columnNames: Record<number, string>
  formulaMode: 'value' | 'formula'
  mergeMode: 'fill' | 'blank'
  headerRowIndex: number
}

export interface ExportConfig {
  sourcePath: string
  targetKind: ExportTargetKind
  outputDir: string
  tablePrefix: string
  csvFormulaProtection: boolean
  /** 目标文件已存在时的处理策略（前端预览模态选择） */
  conflictMode: 'overwrite' | 'rename'
  sheets: SheetExportConfig[]
}

export interface ConsistencyIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface ExportFileInfo {
  fileName: string
  sheetId: number
  sheetName: string
  tableName: string
  rowCount: number
  colCount: number
  /** 列名映射：清洗后的列名 -> 原名 */
  columnMapping: Record<string, string>
}

export interface ExportPreviewResult {
  taskId: string
  files: ExportFileInfo[]
  issues: ConsistencyIssue[]
  targetKind: ExportTargetKind
  outputDir: string
  configHash: string
}

export interface ConfirmExportPayload {
  taskId: string
}

export interface ChooseOutputDirResult {
  directory: string | null
}

export interface ExportEventDetail {
  currentStep: string
  done: number
  total: number
  message: string
}

// ---------- 数据分析 ----------

export interface AnalyzeSessionInfo {
  sessionId: string
  dbPath: string
  createdAt: number
}

export interface AnalyzeTableInfo {
  name: string
  type: 'table' | 'view' | 'index' | 'trigger'
  /** table/view 才有：估算行数 */
  rowCount: number | null
  /** 对象树二级展示：列清单（table/view 才有） */
  columns: Array<{ name: string; type: string }>
}

export interface AnalyzeImportResult {
  sessionId: string
  dbPath: string
  tables: AnalyzeTableInfo[]
  warnings: string[]
  elapsedMs: number
}

/** 导入预览（结构探测）：列信息 */
export interface ProbeColumnInfo {
  index: number
  sourceName: string
  inferredType: string
}

/** 导入预览（结构探测）：一个表（Excel 一个 Sheet 一表，其余格式单文件一表） */
export interface ProbeTableInfo {
  tableIndex: number
  sourceName: string
  rowCount: number | null
  columns: ProbeColumnInfo[]
  /** 列名是否允许重命名（视图 / SQL dump 为只读，仅表名可改） */
  readOnlyColumns?: boolean
}

/** 导入预览（结构探测）：一个文件 */
export interface ProbeFileResult {
  filePath: string
  fileName: string
  tables: ProbeTableInfo[]
  errors: string[]
}

export interface ProbeImportResult {
  files: ProbeFileResult[]
}

/** 导入确认：一列的重命名映射 */
export interface ImportColumnMapping {
  index: number
  name: string
}

/** 导入确认：一个表的重命名映射（列顺序与探测一致） */
export interface ImportTableMapping {
  filePath: string
  tableIndex: number
  tableName: string
  columns: ImportColumnMapping[]
}

export interface AnalyzeImportPayload {
  /** 复用已有会话则传入；不传由主进程新建 */
  sessionId?: string
  /** 多文件多表一次提交 */
  files: ImportTableMapping[]
}

export interface AnalyzeChooseFilesResult {
  filePaths: string[]
}

export interface AnalyzeColumnInfo {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKey: boolean
}

export interface AnalyzeSchemaResult {
  tableName: string
  columns: AnalyzeColumnInfo[]
  indexes: Array<{ name: string; columns: string; unique: boolean }>
  foreignKeys: Array<{ from: string; to: string; toColumn: string }>
}

export interface AnalyzeRunQueryPayload {
  sessionId: string
  sql: string
  /** 行数上限；不传时主进程按 10 万行执行层上限兜底（防止全量 SELECT 拖垮内存） */
  limit?: number
}

export interface AnalyzeQueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowCount: number
  /** 是否因上限截断 */
  truncated: boolean
  elapsedMs: number
  explainPlan: Array<{ detail: string; children: Array<{ detail: string }> }> | null
}

export interface AnalyzeExportPayload {
  sessionId: string
  /** 导出哪条结果集：用 sql 原文标识 */
  sql: string
  targetKind: 'csv' | 'json' | 'sql'
  outputPath: string
  limit: number
}

export interface AnalyzeExportResult {
  rowCount: number
  elapsedMs: number
}

export interface AnalyzePreviewResult {
  columns: string[]
  rows: (string | null)[][]
  totalRows: number
}
