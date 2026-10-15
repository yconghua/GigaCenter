import type { Workbook } from 'exceljs'
import { resolveSharedFormula } from '../convert/excel-refs'

/** exceljs 体积大、加载约 8s，仅在真正解析 Excel 时惰性加载 */
let exceljsPromise: Promise<typeof import('exceljs')> | null = null
async function getExcelJS(): Promise<typeof import('exceljs')> {
  if (!exceljsPromise) {
    exceljsPromise = import('exceljs').then((m) =>
      ((m as { default?: typeof import('exceljs') }).default ?? m) as typeof import('exceljs')
    )
  }
  return exceljsPromise
}

/** Excel 读取：工作表元数据 + 前 50 行预览 + 类型推断采样。
 *  普通加载（含合并单元格/公式元信息）；超大文件由行数预警兜底（M4 补流式）。 */

export interface ExcelSheetMeta {
  id: number
  name: string
  rowCount: number
  colCount: number
  hidden: boolean
}

export interface ExcelSheetReadOptions {
  formulaMode: 'value' | 'formula'
  mergeMode: 'fill' | 'blank'
}

export interface ExcelSheetReadResult {
  meta: ExcelSheetMeta
  previewRows: (string | null)[][]
  sampleRows: (string | null)[][]
  notices: string[]
}

const PREVIEW_LIMIT = 50
const SAMPLE_LIMIT = 6000

export async function readExcelWorkbook(filePath: string): Promise<{
  sheets: ExcelSheetMeta[]
  reads: Map<number, ExcelSheetReadResult>
}> {
  const ExcelJS = await getExcelJS()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const sheets = wb.worksheets.map((ws, i) => ({
    id: i,
    name: ws.name,
    rowCount: ws.rowCount ?? 0,
    colCount: ws.columnCount ?? 0,
    hidden: ws.state === 'hidden'
  }))

  const reads = new Map<number, ExcelSheetReadResult>()
  for (const meta of sheets) {
    reads.set(meta.id, readSheetRows(wb, meta, { formulaMode: 'value', mergeMode: 'fill' }))
  }
  return { sheets, reads }
}

function readSheetRows(
  wb: Workbook,
  meta: ExcelSheetMeta,
  opts: ExcelSheetReadOptions
): ExcelSheetReadResult {
  // meta.id 为工作表数组下标；不能 getWorksheet(id+1)：文件删除过工作表时 id 有空洞会取不到。
  const ws = wb.worksheets[meta.id]
  const notices: string[] = []
  if (!ws) {
    return { meta, previewRows: [], sampleRows: [], notices: ['工作表不存在'] }
  }

  // mergeMode=fill 时，把合并区域主单元格的值预填到区域内所有非主单元格，读取时优先取映射值。
  const mergeMap = new Map<string, unknown>()
  const merges = (ws.model.merges ?? []) as Array<{
    master?: { row: number; col: number }
    range?: { tl: { row: number; col: number }; br: { row: number; col: number } }
  }>
  if (opts.mergeMode === 'fill') {
    for (const m of merges) {
      const master = m.master
      const range = m.range
      if (!range || !master) continue
      const masterVal = ws.getCell(master.row, master.col).value
      for (let r = range.tl.row; r <= range.br.row; r++) {
        for (let c = range.tl.col; c <= range.br.col; c++) {
          if (r === master.row && c === master.col) continue
          mergeMap.set(`${r}:${c}`, masterVal)
        }
      }
    }
  }

  const previewRows: (string | null)[][] = []
  const sampleRows: (string | null)[][] = []
  let sampleIndex = 0
  let hasFormulas = false
  let hasNotes = false
  const cellCount = ws.columnCount ?? 0

  for (let r = 1; r <= (ws.rowCount ?? 0); r++) {
    const wsRow = ws.getRow(r)
    const out: (string | null)[] = []
    for (let c = 1; c <= cellCount; c++) {
      const cell = wsRow.getCell(c)
      const mergedVal = mergeMap.get(`${r}:${c}`)
      const raw = mergedVal !== undefined ? mergedVal : cell.value
      if (typeof raw === 'object' && raw !== null && ('formula' in raw || 'sharedFormula' in raw)) hasFormulas = true
      if (cell.note) hasNotes = true
      // formula 模式下，共享公式需按当前单元格坐标平移相对引用后，再输出公式文本。
      const resolved = opts.formulaMode === 'formula' ? resolveSharedFormula(ws, r, c, raw) : raw
      out.push(normalizeCell(resolved, opts.formulaMode))
    }
    if (out.every((v) => v === null)) continue
    if (previewRows.length < PREVIEW_LIMIT) previewRows.push(out)
    if (sampleRows.length < SAMPLE_LIMIT) {
      if (sampleIndex < 1000) sampleRows.push(out)
      else if (sampleIndex % 5 === 0) sampleRows.push(out)
    }
    sampleIndex++
  }

  if (hasFormulas) notices.push('该工作表包含公式单元格（默认取计算值，可切换为公式文本）')
  if (hasNotes) notices.push('该工作表包含批注（导入时忽略）')
  if (merges.length > 0) notices.push(`该工作表包含 ${merges.length} 处合并单元格（默认填充首值，可切换为留空）`)

  return { meta, previewRows, sampleRows, notices }
}

// 把 exceljs 单元格值归一为可入库的字符串或 null：日期转本地时间格式、Buffer 转 hex、
// 公式按模式取公式文本或计算值，富文本/超链接/错误对象各自提取，嵌套对象递归展开。
function normalizeCell(value: unknown, formulaMode: 'value' | 'formula'): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    if (value instanceof Date) return toIso(value)
    if (value instanceof Buffer) return `0x${value.toString('hex')}`
    if (('formula' in value || 'sharedFormula' in value) && typeof value === 'object') {
      const f = value as { formula?: string; result?: unknown }
      if (formulaMode === 'formula' && typeof f.formula === 'string') return f.formula
      const result = f.result
      return result === undefined || result === null ? '' : normalizeCell(result, formulaMode)
    }
    if ('richText' in value) {
      const rt = (value as { richText: { text: string }[] }).richText
      return rt.map((p) => p.text ?? '').join('')
    }
    if ('text' in value && (value as { text: unknown }).text !== undefined && (value as { text: unknown }).text !== null) {
      return normalizeCell((value as { text: unknown }).text, formulaMode)
    }
    if ('value' in value) {
      return normalizeCell((value as { value: unknown }).value, formulaMode)
    }
    if ('error' in value) return String((value as { error: unknown }).error)
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function toIso(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
