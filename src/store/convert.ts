import { defineStore } from 'pinia'
import type {
  ColumnType,
  ExportConfig,
  ExportPreviewResult,
  ExportTargetKind,
  SheetExportConfig,
  SheetInspectResult,
  WorkbookInfo
} from '@shared/ipc-types'
import type { ParseResult } from '@/api/convert'

// 格式转换会话的前端状态：源工作簿、各工作表的勾选与列类型/列名修正、
// 导出目标配置，以及导出进行中的界面锁定态。
// 本页与分析页互不共享数据；同一页同时只允许一个导出任务，任务锁由主进程持有。

const DEFAULT_TARGET: ExportTargetKind = 'sqlite'

export const useConvertStore = defineStore('convert', {
  state: () => ({
    workbook: null as WorkbookInfo | null,
    inspects: {} as Record<number, SheetInspectResult>,
    sheetConfigs: {} as Record<number, SheetExportConfig>,
    targetKind: DEFAULT_TARGET as ExportTargetKind,
    tablePrefix: '',
    outputDir: '',
    csvFormulaProtection: true,
    conflictMode: 'rename' as 'overwrite' | 'rename',
    locked: false,
    preview: null as ExportPreviewResult | null,
    lastOutputDir: ''
  }),
  actions: {
    setParsed(parsed: ParseResult): void {
      // 重建各工作表配置时继承旧配置（表头行/公式模式/合并单元格/表名/勾选状态），
      // 否则每次重新探测都会把用户设置重置为默认值。
      const prev = this.sheetConfigs
      this.workbook = parsed.workbook
      this.inspects = parsed.inspects
      this.sheetConfigs = {}
      for (const sheet of parsed.workbook.sheets) {
        const inspect = parsed.inspects[sheet.id]
        const columnTypes: Record<number, ColumnType> = {}
        if (inspect) {
          for (const col of inspect.columns) columnTypes[col.index] = col.inferredType
        }
        const old = prev[sheet.id]
        this.sheetConfigs[sheet.id] = {
          sheetId: sheet.id,
          include: old ? old.include : !sheet.hidden,
          tableName: old?.tableName ?? sheet.name,
          columnTypes,
          columnNames: { ...(old?.columnNames ?? {}) },
          formulaMode: old?.formulaMode ?? 'value',
          mergeMode: old?.mergeMode ?? 'fill',
          headerRowIndex: old?.headerRowIndex ?? 0
        }
      }
    },
    toggleSheet(sheetId: number, include: boolean): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.include = include
    },
    setColumnType(sheetId: number, colIndex: number, type: ColumnType): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.columnTypes[colIndex] = type
    },
    setColumnName(sheetId: number, colIndex: number, name: string): void {
      const cfg = this.sheetConfigs[sheetId]
      if (!cfg) return
      // 清空自定义列名即删除覆盖，导出时回落到原始表头行
      const trimmed = name.trim()
      if (trimmed) cfg.columnNames[colIndex] = trimmed
      else delete cfg.columnNames[colIndex]
    },
    setTableName(sheetId: number, name: string): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.tableName = name
    },
    setFormulaMode(sheetId: number, mode: 'value' | 'formula'): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.formulaMode = mode
    },
    setMergeMode(sheetId: number, mode: 'fill' | 'blank'): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.mergeMode = mode
    },
    setHeaderRow(sheetId: number, index: number): void {
      const cfg = this.sheetConfigs[sheetId]
      if (cfg) cfg.headerRowIndex = index
    },
    buildConfig(): ExportConfig {
      if (!this.workbook) throw new Error('未解析文件')
      return {
        sourcePath: this.workbook.filePath,
        targetKind: this.targetKind,
        outputDir: this.outputDir,
        tablePrefix: this.tablePrefix,
        csvFormulaProtection: this.csvFormulaProtection,
        conflictMode: this.conflictMode,
        // Pinia state 是 reactive 代理，IPC 结构化克隆无法处理；先展开拍平成纯对象再传输
        sheets: Object.values(this.sheetConfigs)
          .filter((s) => s.include)
          .map((s) => ({
            sheetId: s.sheetId,
            include: s.include,
            tableName: s.tableName,
            columnTypes: { ...s.columnTypes },
            columnNames: { ...s.columnNames },
            formulaMode: s.formulaMode,
            mergeMode: s.mergeMode,
            headerRowIndex: s.headerRowIndex
          }))
      }
    },
    setLocked(locked: boolean): void {
      this.locked = locked
    },
    setPreview(preview: ExportPreviewResult | null): void {
      this.preview = preview
    },
    reset(): void {
      this.workbook = null
      this.inspects = {}
      this.sheetConfigs = {}
      this.targetKind = DEFAULT_TARGET
      this.tablePrefix = ''
      this.outputDir = ''
      this.preview = null
      this.locked = false
    },
    /** 重置 = 开启新会话：先通知主进程清理旧会话缓存，再清空前端全部状态 */
    async resetSession(): Promise<void> {
      await window.gigacenter.invoke('convert:reset-session')
      this.reset()
    }
  }
})
