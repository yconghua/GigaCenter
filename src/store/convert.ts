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

// 格式转换会话状态：源文件、Sheet 勾选与类型修正、目标配置、导出锁定态。
// 两个 Tab 完全独立，不互传数据；单任务锁在主进程。

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
      this.workbook = parsed.workbook
      this.inspects = parsed.inspects
      this.sheetConfigs = {}
      for (const sheet of parsed.workbook.sheets) {
        const inspect = parsed.inspects[sheet.id]
        const columnTypes: Record<number, ColumnType> = {}
        if (inspect) {
          for (const col of inspect.columns) columnTypes[col.index] = col.inferredType
        }
        this.sheetConfigs[sheet.id] = {
          sheetId: sheet.id,
          include: !sheet.hidden,
          tableName: sheet.name,
          columnTypes,
          formulaMode: 'value',
          mergeMode: 'fill',
          headerRowIndex: 0
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
        // Pinia state 是 reactive 代理，IPC 无法克隆；先拍平成纯对象再传输
        sheets: Object.values(this.sheetConfigs)
          .filter((s) => s.include)
          .map((s) => ({
            sheetId: s.sheetId,
            include: s.include,
            tableName: s.tableName,
            columnTypes: { ...s.columnTypes },
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
    /** 重置 = 开启新会话：先清主进程旧会话缓存，再清前端全部状态 */
    async resetSession(): Promise<void> {
      await window.gigacenter.invoke('convert:reset-session')
      this.reset()
    }
  }
})
