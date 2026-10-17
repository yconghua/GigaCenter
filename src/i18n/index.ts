import type { App } from 'vue'

// 国际化入口：当前仅内置中文词条，但 messages 按语言分组组织，便于后续新增语言。
// 约束：所有界面文案必须经 t() / $t() 取词，禁止在组件中硬编码中文。
const messages: Record<string, Record<string, string>> = {
  zh: {
    'app.title': '千兆宇宙中心',
    'nav.home': '首页',
    'nav.convert': '格式转换',
    'nav.analyze': '数据分析',
    'nav.python': 'Python 分析',
    'nav.settings': '系统设置',
    // 首页
    'home.tagline': '本地数据格式转换、SQL 与 Python 数据分析工具',
    'home.version': '版本',
    'home.intro.title': '关于千兆宇宙中心',
    'home.intro.1': '数据只在你的电脑上处理，不上传任何服务器',
    'home.intro.2': '原始文件始终只读打开，绝不会被修改',
    'home.intro.3': '导入的数据存入临时库，关闭程序后自动清除',
    'home.intro.4': 'Python 分析使用程序内置运行时，离线开箱即用',
    'home.features.title': '核心功能',
    'home.features.convert': '格式转换',
    'home.features.convertDesc': '导入 CSV / TXT / Excel，预览并命名表名与列名，导出为 CSV / SQL / NDJSON / MongoDB 格式',
    'home.features.analyze': '数据分析',
    'home.features.analyzeDesc': '导入多个数据文件到临时库，编写 SQL 跨表查询，结果导出 CSV / JSON / SQL',
    'home.features.python': 'Python 分析',
    'home.features.pythonDesc': '导入 CSV / TXT / Excel / JSON / SQLite，编写 Python 代码处理数据，输出表格、图表与文本并导出',
    'home.flow.title': '使用流程',
    'home.flow.convert': '格式转换流程',
    'home.flow.convert.1': '选择文件或拖拽到页面',
    'home.flow.convert.2': '预览并命名表名与列名',
    'home.flow.convert.3': '设置导出格式与选项',
    'home.flow.convert.4': '一键导出到本地目录',
    'home.flow.analyze': '数据分析流程',
    'home.flow.analyze.1': '导入数据文件（可多选）',
    'home.flow.analyze.2': '确认表名与列名',
    'home.flow.analyze.3': '编写 SQL 查询，支持跨表',
    'home.flow.analyze.4': '查看结果并导出',
    'home.flow.python': 'Python 分析流程',
    'home.flow.python.1': '导入数据文件（自动注册同名变量）',
    'home.flow.python.2': '编写 Python 代码，支持运行全部 / 选中',
    'home.flow.python.3': '查看文本、表格、图表三类输出',
    'home.flow.python.4': '导出结果或重置会话',
    'home.shortcuts.title': '快捷键',
    'home.shortcuts.hint': '可在系统设置中修改',
    'home.sc.runQuery': '运行查询',
    'home.sc.runSelected': '运行选中 SQL',
    'home.sc.formatSql': '格式化 SQL',
    'home.sc.exportResult': '导出结果',
    'home.sc.openFile': '打开文件',
    'home.sc.openSettings': '打开系统设置',
    'home.sc.cancel': '取消任务',
    'home.safety.title': '数据安全',
    'home.safety.1': '临时数据库随会话创建，程序关闭即清除',
    'home.safety.2': '日志只记录操作事件与文件名大小，不记录文件内容与 SQL 全文',
    'home.safety.3': '每个启动实例独立隔离，互不干扰',
    'home.start': '开始使用',
    'home.settingsHint': '前往系统设置可调整主题、字号与快捷键',
    // 系统设置
    'settings.title': '系统设置',
    'settings.configDir': '配置目录',
    'settings.logDir': '日志目录',
    'settings.tempRoot': '临时根目录',
    'settings.sessionTempUsed': '当前会话临时占用',
    'settings.instanceId': '当前运行实例 ID',
    'settings.instanceIdHint': '本次启动有效，仅用于临时目录、锁文件、日志的归属标识',
    'settings.copy': '复制',
    'settings.openDir': '打开目录',
    'settings.copied': '已复制',
    'settings.clearPreferences': '清除本地偏好',
    'settings.clearPreferencesConfirm': '将重置主题、密度、字体、快捷键、上次目录、窗口位置，是否继续？',
    'settings.allowModifyTempDb': '允许修改临时库',
    'settings.allowModifyTempDbHint': '默认关闭；打开后执行非 SELECT 前需确认，修改只影响临时库，导出结果可能基于被改过的数据',
    // 弹窗通用
    'dialog.confirm': '确认',
    'dialog.cancel': '取消',
    'dialog.close': '关闭',
    'dialog.expandDetail': '展开诊断信息',
    'dialog.collapseDetail': '收起诊断信息',
    // 框架自检（正式功能开发时移除）
    'probe.title': '框架自检',
    'probe.desc': '以下四项用于验证框架阶段的技术探针，正式功能开发时移除',
    'probe.ping': 'IPC 调用（app:ping）',
    'probe.event': '事件推送（event:probe）',
    'probe.worker': 'worker + better-sqlite3 查询',
    'probe.cancel': 'worker 取消（terminate）',
    'probe.waiting': '等待中…',
    'probe.ok': '通过',
    'probe.fail': '失败'
  }
}

// 当前固定使用中文词条（多语言扩展时按 locale 切换）。
const dict = messages.zh

/** script 中调用的翻译函数；模板内通过全局属性 $t 复用同一实现。未命中词条时原样返回 key，避免界面出现空白。 */
export function t(key: string): string {
  return dict[key] ?? key
}

export interface I18n {
  locale: string
  t(key: string): string
}

/** 安装国际化：向应用注册全局 $t；当前固定中文，locale 参数为多语言扩展预留。 */
export function createI18n(locale = 'zh') {
  const i18n: I18n = {
    locale,
    t
  }
  return {
    ...i18n,
    install(app: App): void {
      app.config.globalProperties.$t = i18n.t
    }
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $t: (key: string) => string
  }
}
