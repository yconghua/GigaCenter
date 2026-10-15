import { defineStore } from 'pinia'
import type {
  AnalyzePreviewResult,
  AnalyzeQueryResult,
  AnalyzeSchemaResult,
  AnalyzeTableInfo
} from '@shared/ipc-types'
import { analyzeApi } from '@/api/analyze'

// 数据分析会话的前端状态：会话标识与临时库路径、导入对象树（表/视图/索引）、
// SQL 编辑器内容、查询结果集与查询历史。
// 查询历史仅存于内存、随会话结束清空，不落盘。

export interface QueryHistoryEntry {
  id: string
  sql: string
  at: number
  rowCount: number | null
  elapsedMs: number | null
}

export const useAnalyzeStore = defineStore('analyze', {
  state: () => ({
    sessionId: '',
    dbPath: '',
    imported: false,
    importing: false,
    objects: [] as AnalyzeTableInfo[],
    tables: [] as AnalyzeTableInfo[],
    selectedTable: '',
    schema: null as AnalyzeSchemaResult | null,
    preview: null as AnalyzePreviewResult | null,
    sqlText: '',
    running: false,
    result: null as AnalyzeQueryResult | null,
    resultError: '',
    history: [] as QueryHistoryEntry[],
    warnings: [] as string[],
    explainMode: false,
    /** 导出结果模态的数据（SQL、目标格式与输出路径） */
    exportTarget: null as { sql: string; targetKind: 'csv' | 'json' | 'sql'; outputPath: string } | null
  }),
  actions: {
    /** 进入工作台时调用：无会话则向主进程申请新建临时 SQLite 会话 */
    async ensureSession(): Promise<boolean> {
      if (this.sessionId) return true
      const res = await analyzeApi.createSession()
      if (!res.ok) return false
      this.sessionId = res.value.sessionId
      this.dbPath = res.value.dbPath
      return true
    },
    setSqlText(sql: string): void {
      this.sqlText = sql
    },
    reset(): void {
      this.sessionId = ''
      this.dbPath = ''
      this.imported = false
      this.objects = []
      this.tables = []
      this.selectedTable = ''
      this.schema = null
      this.preview = null
      this.result = null
      this.resultError = ''
      this.warnings = []
    },
    setObjects(objects: AnalyzeTableInfo[]): void {
      this.objects = objects
      this.tables = objects.filter((o) => o.type === 'table' || o.type === 'view')
    },
    /** 导入完成后把新表合并进对象树（避免整树重查），并追加主进程返回的警告 */
    mergeImported(tables: AnalyzeTableInfo[], warnings: string[]): void {
      this.imported = true
      const merged = [...this.objects]
      for (const t of tables) {
        const existing = merged.findIndex((o) => o.name === t.name && o.type === t.type)
        if (existing >= 0) merged[existing] = t
        else merged.push(t)
      }
      this.setObjects(merged)
      if (warnings.length > 0) this.warnings = [...this.warnings, ...warnings]
    },
    /** 重新拉取对象树，与主进程侧的权威状态对齐 */
    async refreshObjects(): Promise<void> {
      if (!this.sessionId) return
      const res = await analyzeApi.listObjects(this.sessionId)
      if (res.ok) this.setObjects(res.value)
    },
    async selectTable(name: string): Promise<void> {
      this.selectedTable = name
      if (!this.sessionId) return
      // 选中表后并行拉取表结构信息与前几行预览
      const [schemaRes, previewRes] = await Promise.all([
        analyzeApi.getSchema(this.sessionId, name),
        analyzeApi.previewResult(this.sessionId, name)
      ])
      if (schemaRes.ok) this.schema = schemaRes.value
      if (previewRes.ok) this.preview = previewRes.value
    },
    /** 记录一条查询历史：新记录插到最前，超过 100 条时丢弃最旧的一条 */
    pushHistory(sql: string, rowCount: number | null, elapsedMs: number | null): void {
      this.history.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sql, at: Date.now(), rowCount, elapsedMs })
      if (this.history.length > 100) this.history.pop()
    },
    setExportTarget(target: { sql: string; targetKind: 'csv' | 'json' | 'sql'; outputPath: string } | null): void {
      this.exportTarget = target
    }
  }
})
