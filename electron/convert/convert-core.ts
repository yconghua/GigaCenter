import { statSync } from 'node:fs'
import path from 'node:path'
import type {
  ColumnSample,
  ColumnType,
  ConsistencyIssue,
  ExportConfig,
  ExportFileInfo,
  ExportPreviewResult,
  ExportTargetKind,
  SheetInspectResult,
  WorkbookInfo
} from '../../shared/ipc-types'
import { inferColumn } from '../inference/type-inference'
import { parseCsvFile } from '../parsers/csv-parser'
import { readExcelWorkbook } from '../parsers/excel-parser'
import { sanitizeFileName, sanitizeIdentifier, uniqueIdentifier } from '../core/path-utils'
import { checkDiskSpace } from '../core/atomic-write'

/** 格式转换编排：解析源文件（worker 内调用）、构建预览、一致性检查、配置快照 */

export interface ParsedSource {
  workbook: WorkbookInfo
  inspects: Record<number, SheetInspectResult>
}

export async function parseSourceFile(filePath: string): Promise<ParsedSource> {
  const ext = path.extname(filePath).toLowerCase()
  const fileSize = statSync(filePath).size
  if (ext === '.csv' || ext === '.txt') {
    const csv = await parseCsvFile(filePath)
    const sheetName = path.basename(filePath, ext)
    const sheets = [
      {
        id: 0,
        name: sheetName,
        rowCount: csv.rowCount,
        colCount: csv.colCount,
        hidden: false
      }
    ]
    const workbook: WorkbookInfo = {
      filePath,
      fileName: path.basename(filePath),
      fileSize,
      kind: ext === '.csv' ? 'csv' : 'txt',
      encoding: csv.encoding,
      encodingConfidence: csv.encodingConfidence,
      sheets
    }
    const notices: string[] = []
    if (csv.encodingConfidence !== null && csv.encodingConfidence < 0.7) {
      notices.push(`编码识别置信度较低（${Math.round(csv.encodingConfidence * 100)}%），按 ${csv.encoding} 解码`)
    } else if (csv.encoding !== 'utf8') {
      notices.push(`检测到编码 ${csv.encoding}，已自动解码`)
    }
    return {
      workbook,
      inspects: {
        0: {
          sheetId: 0,
          sheetName,
          columns: buildColumns(csv.sampleRows),
          rows: csv.previewRows,
          notices
        }
      }
    }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const { sheets, reads } = await readExcelWorkbook(filePath)
    const workbook: WorkbookInfo = {
      filePath,
      fileName: path.basename(filePath),
      fileSize,
      kind: ext === '.xlsx' ? 'xlsx' : 'xls',
      encoding: 'binary',
      encodingConfidence: null,
      sheets
    }
    const inspects: Record<number, SheetInspectResult> = {}
    for (const s of sheets) {
      const rd = reads.get(s.id)
      inspects[s.id] = rd
        ? {
            sheetId: s.id,
            sheetName: s.name,
            columns: buildColumns(rd.sampleRows),
            rows: rd.previewRows,
            notices: rd.notices
          }
        : { sheetId: s.id, sheetName: s.name, columns: [], rows: [], notices: ['读取失败'] }
    }
    return { workbook, inspects }
  }
  throw new Error(`不支持的文件类型：${ext}`)
}

/** 由采样行构建列信息：第 headerRowIndex 行为表头，其余为数据 */
export function buildColumns(
  sampleRows: (string | null)[][],
  headerRowIndex = 0
): ColumnSample[] {
  const header = sampleRows[headerRowIndex] ?? []
  const dataRows = sampleRows.slice(headerRowIndex + 1)
  let colCount = header.length
  for (const r of dataRows) {
    if (r.length > colCount) colCount = r.length
  }
  const columns: ColumnSample[] = []
  for (let i = 0; i < colCount; i++) {
    const values = dataRows.map((r) => r[i] ?? null)
    const inferred = inferColumn(values)
    columns.push({
      index: i,
      header: header[i] ?? `列${i + 1}`,
      sampleValues: values.slice(0, 50),
      inferredType: inferred.type,
      confidence: inferred.confidence,
      needsConfirm: inferred.needsConfirm,
      warnings: inferred.warnings
    })
  }
  return columns
}

/** 各目标方言支持的列类型（全集映射，无"不支持"类型，全类型可表达） */
const SUPPORTED_TYPES: Record<ExportTargetKind, ColumnType[]> = {
  csv: ['text', 'integer', 'real', 'date', 'boolean'],
  sqlite: ['text', 'integer', 'real', 'date', 'boolean'],
  mysql: ['text', 'integer', 'real', 'date', 'boolean'],
  postgresql: ['text', 'integer', 'real', 'date', 'boolean'],
  sqlserver: ['text', 'integer', 'real', 'date', 'boolean'],
  mongodb: ['text', 'integer', 'real', 'date', 'boolean']
}

const EXT_BY_KIND: Record<ExportTargetKind, string> = {
  csv: 'csv',
  sqlite: 'db',
  mysql: 'sql',
  postgresql: 'sql',
  sqlserver: 'sql',
  mongodb: 'ndjson'
}

/** 导出时间戳：YYYYMMDD_HHmmss */
export function exportTimestamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 导出前预览：文件清单 + 表结构 + 一致性检查。
 * 不跑全量转换、不写目标目录；配置快照哈希由主进程保存，confirm 只传 taskId。
 */
export function buildExportPreview(
  config: ExportConfig,
  inspects: Record<number, SheetInspectResult>
): ExportPreviewResult {
  const issues: ConsistencyIssue[] = []
  const files: ExportFileInfo[] = []
  const usedTables = new Set<string>()
  const ts = exportTimestamp()
  const baseName = path.basename(config.sourcePath, path.extname(config.sourcePath))
  const included = config.sheets.filter((s) => s.include)
  const multi = included.length > 1
  const subDir = multi ? sanitizeFileName(baseName) : null
  const ext = EXT_BY_KIND[config.targetKind]

  for (const sheet of included) {
    const inspect = inspects[sheet.sheetId]
    if (!inspect) {
      issues.push({ severity: 'error', code: 'SHEET_NOT_FOUND', message: `工作表 ${sheet.sheetId} 不存在` })
      continue
    }
    const rawTable = (config.tablePrefix + sheet.tableName).trim()
    const tableName = uniqueIdentifier(sanitizeIdentifier(rawTable || 'table'), usedTables)
    if (tableName !== sanitizeIdentifier(rawTable)) {
      issues.push({
        severity: 'warning',
        code: 'TABLE_RENAMED',
        message: `表名「${rawTable}」已清洗为「${tableName}」`
      })
    }

    const usedCols = new Set<string>()
    const columnMapping: Record<string, string> = {}
    for (const col of inspect.columns) {
      const cleaned = uniqueIdentifier(sanitizeIdentifier(col.header), usedCols)
      columnMapping[cleaned] = col.header
      if (cleaned !== sanitizeIdentifier(col.header)) {
        issues.push({
          severity: 'warning',
          code: 'COLUMN_RENAMED',
          message: `表「${tableName}」列「${col.header}」已清洗为「${cleaned}」`
        })
      }
    }

    for (const col of inspect.columns) {
      const type = sheet.columnTypes[col.index] ?? col.inferredType
      if (!SUPPORTED_TYPES[config.targetKind].includes(type)) {
        issues.push({
          severity: 'error',
          code: 'TYPE_UNSUPPORTED',
          message: `表「${tableName}」列「${col.header}」类型 ${type} 目标库不支持`
        })
      }
    }

    const sheetNameSafe = sanitizeFileName(inspect.sheetName)
    const fileName = multi
      ? `${sanitizeFileName(baseName)}_${sheetNameSafe}_${ts}.${ext}`
      : `${sanitizeFileName(baseName)}_${ts}.${ext}`
    files.push({
      fileName: subDir ? path.join(subDir, fileName) : fileName,
      sheetId: sheet.sheetId,
      sheetName: inspect.sheetName,
      tableName,
      rowCount: inspect.rows.length,
      colCount: inspect.columns.length,
      columnMapping
    })
  }

  // 目标目录存在性 + 磁盘空间（按源文件大小 × 1.5 预估）
  try {
    statSync(config.outputDir)
  } catch {
    issues.push({ severity: 'error', code: 'OUTPUT_DIR_MISSING', message: '输出目录不存在' })
  }
  const estimate = statSync(config.sourcePath).size * 1.5
  const space = checkDiskSpace(config.outputDir, estimate)
  if (!space.ok) {
    issues.push({ severity: 'error', code: 'DISK_SPACE', message: '输出目录剩余空间不足' })
  }

  const configHash = computeConfigHash(JSON.stringify({ config, files }))
  return {
    taskId: 'pending',
    files,
    issues,
    targetKind: config.targetKind,
    outputDir: config.outputDir,
    configHash
  }
}

/** 配置快照哈希：主进程内部保存，confirm 时只传 taskId，不信任渲染进程 */
export function computeConfigHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
