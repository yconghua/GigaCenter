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
import { streamSheetRows } from './source-stream'

/** 导出链路编排模块：worker 内解析源文件（CSV/Excel）、构建列信息与类型推断、
 *  按用户设置重采样工作表、生成导出前预览并做一致性检查、计算配置快照哈希。 */

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
    // 编码识别提示：置信度偏低或非 UTF-8 解码时，向预览追加一条用户可见提示
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

/** 由采样行构建列信息：第 headerRowIndex 行为表头行，其余为数据行；
 *  列数取表头行与数据行的最大值，缺表头的列名回退为「列N」，并对每列采样值做类型推断。 */
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

/** 表头行/公式/合并模式调整后的工作表重采样：走与实际导出同一套流式读取链路，
 *  仅取前 50 行数据，保证页面预览、导出预览与真实导出的列名一致。 */
export async function inspectSheetFile(
  filePath: string,
  sheetId: number,
  sheetName: string,
  opts: { headerRowIndex: number; formulaMode: 'value' | 'formula'; mergeMode: 'fill' | 'blank' }
): Promise<SheetInspectResult> {
  let header: (string | null)[] | null = null
  const rows: (string | null)[][] = []
  await streamSheetRows(
    filePath,
    sheetId,
    opts,
    (h) => {
      header = h
    },
    (row) => {
      if (rows.length < 50) rows.push(row)
    },
    () => false,
    () => undefined
  )
  // 表头行之前的行已被流式读取跳过；将表头行与数据行合并为样本后按第 0 行重建列信息。
  const sampleRows = header ? [header, ...rows] : rows
  return {
    sheetId,
    sheetName,
    columns: buildColumns(sampleRows, 0),
    rows,
    notices: []
  }
}

/** 各目标导出格式支持的列类型全集：text/integer/real/date/boolean 五种基础类型
 *  在所有目标方言下均可表达，不存在目标库不支持的类型。 */
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
  const subDir = multi ? sanitizeFileName(baseName) : null // 多工作表导出时，各文件归入以源文件名命名的子目录
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
      // 列名优先取用户改写值，未改则用源表头
      const displayName = sheet.columnNames[col.index] ?? col.header
      const cleaned = uniqueIdentifier(sanitizeIdentifier(displayName || `col_${col.index + 1}`), usedCols)
      columnMapping[cleaned] = displayName
      if (cleaned !== sanitizeIdentifier(displayName)) {
        issues.push({
          severity: 'warning',
          code: 'COLUMN_RENAMED',
          message: `表「${tableName}」列「${displayName}」已清洗为「${cleaned}」`
        })
      }
    }

    for (const col of inspect.columns) {
      const type = sheet.columnTypes[col.index] ?? col.inferredType
      if (!SUPPORTED_TYPES[config.targetKind].includes(type)) {
        issues.push({
          severity: 'error',
          code: 'TYPE_UNSUPPORTED',
          message: `表「${tableName}」列「${sheet.columnNames[col.index] ?? col.header}」类型 ${type} 目标库不支持`
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

  // 校验输出目录存在性，并按源文件大小 × 1.5 预估导出所需磁盘空间。
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
