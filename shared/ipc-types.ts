/**
 * IPC 通道与 payload 类型定义：主进程、preload、渲染进程三方共用的协议契约。
 * 通道字符串集中在此声明，各通道的请求/响应类型与事件语义由下方注释说明；
 * 编译期校验两端类型一致，新增或改名通道需同步 preload 白名单。
 */
export const IPC_CHANNELS = {
  // 应用信息：版本/路径查询、窗口与文件管理器操作
  /** 心跳探针：渲染进程加载完成后的连通性自检 */
  ping: 'app:ping',
  /** 返回应用信息（版本/平台/实例 ID/当前生效主题） */
  getAppInfo: 'app:get-app-info',
  /** 返回路径信息（配置/日志/临时目录及占用，设置页展示） */
  getPaths: 'app:get-paths',
  /** 打开渲染进程开发者工具（调试用） */
  openDevTools: 'app:open-devtools',
  /** 在系统文件管理器中打开 exe 所在目录 */
  openExeFolder: 'app:open-exe-folder',
  /** 打开指定文件夹（路径须经白名单校验） */
  openFolder: 'app:open-folder',
  /** 在文件管理器中选中并高亮指定文件 */
  showInFolder: 'app:show-in-folder',
  // 配置：UI 偏好的读取/保存/重置与诊断导出
  /** 读取全部 UI 偏好 */
  getSettings: 'settings:get',
  /** 保存 UI 偏好（部分字段） */
  setPreferences: 'settings:set-preferences',
  /** 重置 UI 偏好为默认值 */
  clearPreferences: 'settings:clear-preferences',
  /** 打包导出诊断信息（日志/配置快照），便于反馈问题 */
  exportDiagnostics: 'settings:export-diagnostics',
  /** 卸载程序：清理用户配置/日志/临时数据后调用系统卸载器（静默）并退出 */
  uninstallApp: 'settings:uninstall-app',
  // Python 分析（独立导航页）：运行时管理与会话执行
  /** 查询 Python 运行时状态（来源/版本/已装库，结果缓存） */
  pythonGetRuntimeInfo: 'python:get-runtime-info',
  /** 初始化 Python 运行时：从安装目录基线复制到用户数据目录（离线可用） */
  pythonInitRuntime: 'python:init-runtime',
  /** 卸载 Python 运行时：删除激活目录 */
  pythonUninstallRuntime: 'python:uninstall-runtime',
  /** 创建 Python 分析会话（独立会话目录，Worker 懒启动） */
  pythonCreateSession: 'python:create-session',
  /** 重置 Python 会话：关闭旧会话（杀 Worker + 删目录）并新建 */
  pythonResetSession: 'python:reset-session',
  /** 执行 Python 代码：JSON over stdio，流式输出经 event:python-stream 推送 */
  pythonRunCode: 'python:run-code',
  /** autopep8 格式化 Python 代码（Worker 内执行，不触达运行状态） */
  pythonFormatCode: 'python:format-code',
  /** 导出 Python 分析结果：表格（Worker 直写后原子搬运）/ 图表 / 文本，按目标路径落盘 */
  pythonExportResult: 'python:export-result',
  /** Python 结果保存对话框：按导出格式给过滤器与默认文件名 */
  pythonChooseExportFile: 'python:choose-export-file',
  /** 取消当前 Python 执行：强杀 Worker（会话变量重置） */
  pythonCancelRun: 'python:cancel-run',
  /** 注册导入文件：复制到会话目录并预读注册 DataFrame 变量 */
  pythonRegisterImport: 'python:register-import',
  /** 更新已导入文件信息（表头行/行数/变量名） */
  pythonUpdateImported: 'python:update-imported',
  /** Python 执行流式输出事件（stdout/stderr 实时行） */
  eventPythonStream: 'event:python-stream',
  // 任务（事件缓冲与任务管理器阶段 1 落地，数据工作台阶段 2 接入）
  /** 取当前页面任务快照（无任务时返回 null） */
  getCurrentTask: 'task:get-current',
  /** 取所有活动任务列表 */
  getActiveTasks: 'task:get-active',
  /** 订阅任务事件流：携带 lastSeq 断点续传，返回快照 + 增量事件 */
  subscribeTask: 'task:subscribe',
  /** 请求取消指定任务（任务进入 cancelling，待 worker 响应） */
  cancelTask: 'task:cancel',
  /** 关闭确认：渲染进程检查无未保存状态后回此通道，主进程再真正销毁窗口 */
  confirmClose: 'app:confirm-close',
  /** 拖拽授权：渲染进程仅在用户真实拖入文件时调用（主进程校验路径存在后授权父目录） */
  authorizeDrop: 'app:authorize-drop',
  // 格式转换（独立导航页）：工作簿 → 目标库/文件
  /** 解析源工作簿，返回文件/编码与各工作表元信息 */
  convertParseWorkbook: 'convert:parse-workbook',
  /** 剖析单个工作表：按表头行/公式模式/合并模式，返回列推断与样本行 */
  convertInspectSheet: 'convert:inspect-sheet',
  /** 按导出配置预演：返回文件清单/一致性问题/configHash，不落盘 */
  convertPreviewExport: 'convert:preview-export',
  /** 按 taskId 正式执行已预演通过的导出 */
  convertConfirmExport: 'convert:confirm-export',
  /** 弹出目录选择框，返回所选导出目录 */
  convertChooseOutputDir: 'convert:choose-output-dir',
  /** 在文件管理器中高亮导出产物 */
  convertShowInFolder: 'convert:show-in-folder',
  /** 弹出文件选择框，选择待转换的源文件 */
  convertChooseSourceFile: 'convert:choose-source-file',
  /** 导出内容预览：按 taskId+sheetId 生成该表前 N 条导出文本（SQL/CSV/NDJSON） */
  convertPreviewExportContent: 'convert:preview-export-content',
  /** 格式转换重置：清空主进程旧会话缓存（前端重置按钮调用） */
  convertResetSession: 'convert:reset-session',
  // 数据分析（数据工作台 Tab「数据分析」）：会话内临时 SQLite 库
  /** 新建分析会话（分配临时 SQLite 库），返回 sessionId */
  analyzeCreateSession: 'analyze:create-session',
  /** 导入前结构探测：返回各表列信息与样本行，不建库 */
  analyzeProbeImport: 'analyze:probe-import',
  /** 按列名/表头行映射正式导入多文件多表，返回表清单 */
  analyzeImportFile: 'analyze:import-file',
  /** 弹出多文件选择框 */
  analyzeChooseFiles: 'analyze:choose-files',
  /** 列出会话库中的表/视图/索引/触发器 */
  analyzeListObjects: 'analyze:list-objects',
  /** 返回指定表的列/索引/外键结构 */
  analyzeGetSchema: 'analyze:get-schema',
  /** 对会话库执行只读 SQL（行数上限兜底），返回结果集与执行计划 */
  analyzeRunQuery: 'analyze:run-query',
  /** 预览某条 SQL 的结果集（分页/抽样，不落盘） */
  analyzePreviewResult: 'analyze:preview-result',
  /** 将结果集导出为 csv/json/sql 文件 */
  analyzeExportResult: 'analyze:export-result',
  /** 关闭会话并释放其临时库与文件 */
  analyzeCloseSession: 'analyze:close-session',
  /** 弹出保存文件对话框，选择导出目标路径 */
  analyzeChooseExportFile: 'analyze:choose-export-file',
  /** 在文件管理器中高亮导出产物 */
  analyzeShowInFolder: 'analyze:show-in-folder',
  // 技术探针（框架阶段验证用，正式功能开发时移除）
  /** 在 worker 内执行 better-sqlite3 查询，验证 worker 环境与计时 */
  probeWorkerQuery: 'probe:worker-query',
  /** 模拟 worker 慢启动，验证超时与加载态 */
  probeWorkerSlowStart: 'probe:worker-slow-start',
  /** 触发并验证 worker 任务取消路径 */
  probeWorkerCancel: 'probe:worker-cancel',
  // 事件（主进程 → 渲染进程）
  /** 页面加载完成后回送探针，验证事件通道连通 */
  eventProbe: 'event:probe',
  /** 任务事件流（进度/警告/完成/失败/取消），带单调序号，渲染进程据此刷新 UI */
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

/** 心跳探针请求：渲染进程发出的消息与发送时间戳 */
export interface PingPayload {
  message: string
  receivedAt: number
}

/** 心跳探针响应：pong 字符串与主进程处理时间戳 */
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

/** 探针：worker 取消是否生效与耗时 */
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

// ---------- Python 分析 ----------

/** Python 运行时状态（设置页与页面状态栏展示） */
export interface PythonRuntimeInfo {
  status: 'ready' | 'missing'
  source: 'bundled' | 'dev' | ''
  pythonPath: string
  version: string
  libraries: string[]
  initializedAt: number | null
}

/** Python 执行结果块（输出区按序渲染：文本/表格/图表） */
export type PythonBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; columns: string[]; rows: unknown[][]; total: number }
  | { kind: 'image'; mime: string; data: string }

/** Python 代码执行结果 */
export interface PythonRunResult {
  ok: boolean
  status: 'ok' | 'blocked' | 'error' | 'timeout' | 'oom' | 'crashed' | 'cancelled'
  elapsedMs: number
  message: string
  blocks: PythonBlock[]
}

/** Python 会话（渲染进程侧持有 sessionId，其余由主进程管理） */
export interface PythonSessionInfo {
  sessionId: string
}

/** 已导入文件（会话内副本与注册信息） */
export interface PythonImportedFileInfo {
  id: string
  copyName: string
  originalName: string
  kind: 'csv' | 'txt' | 'xlsx' | 'xls' | 'json' | 'sqlite'
  varName: string
  headerRow: number | null
  rowCount: number | null
}

/** 导入文件注册请求项（复制 + 预读注册） */
export interface PythonRegisterImportItem {
  sourcePath: string
  originalName: string
  kind: 'csv' | 'txt' | 'xlsx' | 'xls' | 'json' | 'sqlite'
  headerRow: number | null
}

/** Python 执行历史记录项 */
export interface PythonHistoryItem {
  id: string
  code: string
  at: number
  elapsedMs: number
  status: 'ok' | 'blocked' | 'error' | 'timeout' | 'oom' | 'crashed' | 'cancelled'
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

/** 可解析的源文件类型 */
export type ConvertFileKind = 'csv' | 'txt' | 'xlsx' | 'xls'

/** 工作表元信息（工作簿解析后返回） */
export interface SheetMeta {
  id: number
  name: string
  rowCount: number
  colCount: number
  hidden: boolean
}

/** 工作簿解析结果：文件级信息 + 各工作表元信息 */
export interface WorkbookInfo {
  filePath: string
  fileName: string
  fileSize: number
  kind: ConvertFileKind
  encoding: string
  encodingConfidence: number | null
  sheets: SheetMeta[]
}

/** 列类型推断结果（对齐 SQLite 亲和类型） */
export type ColumnType = 'text' | 'integer' | 'real' | 'date' | 'boolean'

/** 单列样本：原始表头/样本值/推断类型与置信度 */
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

/** 工作表剖析请求：表头行位置、公式取值模式、合并单元格处理方式 */
export interface InspectSheetPayload {
  filePath: string
  sheetId: number
  headerRowIndex: number
  formulaMode: 'value' | 'formula'
  mergeMode: 'fill' | 'blank'
}

/** 导出目标类型 */
export type ExportTargetKind = 'csv' | 'sqlite' | 'mysql' | 'postgresql' | 'sqlserver' | 'mongodb'

export interface SheetExportConfig {
  sheetId: number
  include: boolean
  tableName: string
  /** 列类型（column index → 类型），用户手动修正后的值 */
  columnTypes: Record<number, ColumnType>
  /** 用户改写的列名（column index → 新列名），未改的列不在其中 */
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

/** 导出预演发现的一致性问题（列名冲突/类型不兼容等） */
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
  /** 列名映射：清洗后的列名 → 原名 */
  columnMapping: Record<string, string>
}

/** 导出预演结果：产物文件清单 + 问题清单 + 配置指纹（正式导出按 configHash 复用） */
export interface ExportPreviewResult {
  taskId: string
  files: ExportFileInfo[]
  issues: ConsistencyIssue[]
  targetKind: ExportTargetKind
  outputDir: string
  configHash: string
}

export interface ExportPreviewContentResult {
  /** 前 N 条导出文本（与真实导出内容一致的示例） */
  content: string
  maxRows: number
  /** 该表总数据行数 */
  totalRows: number
}

/** 正式导出请求：仅携带预演返回的 taskId，配置以主进程预演快照为准 */
export interface ConfirmExportPayload {
  taskId: string
}

/** 目录选择结果：用户取消时为 null */
export interface ChooseOutputDirResult {
  directory: string | null
}

/** 导出进度事件明细（通过 eventTask 下发） */
export interface ExportEventDetail {
  currentStep: string
  done: number
  total: number
  message: string
}

// ---------- 数据分析 ----------

/** 分析会话信息：临时库路径与会话创建时间 */
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

/** 正式导入结果：会话信息 + 入库表清单 + 警告与耗时 */
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
  /** 原始数据样本（不含探测用表头行），供前端调整表头行时本地重算列名与类型 */
  sampleRows?: (string | null)[][]
  /** 源文件类型：excel / csv / txt / 其他（决定是否显示表头行选择） */
  sourceKind?: 'excel' | 'delimited' | 'other'
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
  /** 表头行索引（0 = 第一行为表头），Excel/CSV/TXT 可调，缺省 0 */
  headerRowIndex?: number
}

export interface AnalyzeImportPayload {
  /** 复用已有会话则传入；不传由主进程新建 */
  sessionId?: string
  /** 多文件多表一次提交 */
  files: ImportTableMapping[]
}

/** 多文件选择结果：用户取消时返回空数组 */
export interface AnalyzeChooseFilesResult {
  filePaths: string[]
}

/** 会话库列结构（PRAGMA table_info 归一化） */
export interface AnalyzeColumnInfo {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKey: boolean
}

/** 表结构：列清单 + 索引 + 外键 */
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

/** 结果集导出结果：导出行数与耗时 */
export interface AnalyzeExportResult {
  rowCount: number
  elapsedMs: number
}

/** 结果集预览：列名 + 当前页行 + 总行数 */
export interface AnalyzePreviewResult {
  columns: string[]
  rows: (string | null)[][]
  totalRows: number
}
