import { createReadStream, openSync, readSync, closeSync } from 'node:fs'
import { parse } from 'csv-parse'
import iconv from 'iconv-lite'
import { detectEncoding } from '../parsers/encoding'
import { resolveSharedFormula } from './excel-refs'

/** exceljs 体积大、加载约 8s，仅在真正需要读取 Excel 时惰性动态 import，且 Promise 缓存避免重复加载。 */
let exceljsPromise: Promise<typeof import('exceljs')> | null = null
async function getExcelJS(): Promise<typeof import('exceljs')> {
  if (!exceljsPromise) {
    exceljsPromise = import('exceljs').then((m) =>
      ((m as { default?: typeof import('exceljs') }).default ?? m) as typeof import('exceljs')
    )
  }
  return exceljsPromise
}

/** 流式行源：导出时重新读源文件，逐行回调（CSV 全流式；Excel 加载后逐行，不做全量收集） */

/** 任务取消时抛出的错误，沿流式读取链路向上传播，供调用方识别并终止导出。 */
export class CancelError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'CancelError'
  }
}

export interface StreamSheetOptions {
  headerRowIndex: number
  formulaMode: 'value' | 'formula'
  mergeMode: 'fill' | 'blank'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 以首行为样本统计候选分隔符的出现次数，取最多者作为 CSV 分隔符。 */
function detectDelimiter(firstLine: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = -1
  for (const c of candidates) {
    const re = new RegExp(escapeRegExp(c), 'g')
    const count = (firstLine.match(re) ?? []).length
    if (count > bestCount) {
      bestCount = count
      best = c
    }
  }
  return best
}

export async function streamSheetRows(
  sourcePath: string,
  sheetId: number,
  opts: StreamSheetOptions,
  onHeader: (header: (string | null)[]) => void,
  onRow: (row: (string | null)[]) => void,
  isCancelled: () => boolean,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const ext = sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    await streamCsv(sourcePath, opts, onHeader, onRow, isCancelled, onProgress)
  } else {
    await streamExcel(sourcePath, sheetId, opts, onHeader, onRow, isCancelled, onProgress)
  }
}

function streamCsv(
  filePath: string,
  opts: StreamSheetOptions,
  onHeader: (header: (string | null)[]) => void,
  onRow: (row: (string | null)[]) => void,
  isCancelled: () => boolean,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = openHead(filePath)
    const { encoding } = detectEncoding(fd)
    const headText = iconv.decode(fd, encoding)
    const firstLineEnd = headText.indexOf('\n')
    const firstLine = (firstLineEnd >= 0 ? headText.slice(0, firstLineEnd) : headText).trimEnd()
    const delimiter = detectDelimiter(firstLine)

    const parser = createReadStream(filePath)
      .pipe(iconv.decodeStream(encoding))
      .pipe(parse({ delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }))

    let index = 0
    let done = 0
    parser.on('data', (row: string[]) => {
      if (isCancelled()) {
        parser.destroy()
        reject(new CancelError())
        return
      }
      const norm: (string | null)[] = row.length > 0 ? row.map((v) => (v === '' ? null : v)) : []
      // headerRowIndex 为 0-based（0 即第一行表头），与预览/导入链路 buildColumns 的约定一致。
      if (index < opts.headerRowIndex) {
        // 表头行之前的行直接跳过，不进入回调
      } else if (index === opts.headerRowIndex) {
        onHeader(norm)
      } else {
        onRow(norm)
        done++
        if (done % 1000 === 0) onProgress?.(done, -1) // total 传 -1 表示 CSV 总行数未知
      }
      index++
    })
    parser.on('end', () => {
      onProgress?.(done, -1)
      resolve()
    })
    parser.on('error', (err) => reject(err))
  })
}

function streamExcel(
  filePath: string,
  sheetId: number,
  opts: StreamSheetOptions,
  onHeader: (header: (string | null)[]) => void,
  onRow: (row: (string | null)[]) => void,
  isCancelled: () => boolean,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const ExcelJS = await getExcelJS()
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filePath)
      // sheetId 为工作表数组下标（与 workbook.sheets 的顺序一致）；
      // 不能用 getWorksheet(id+1)：文件删除过工作表时 id 有空洞会取不到。
      const ws = wb.worksheets[sheetId]
      if (!ws) {
        reject(new Error('工作表不存在'))
        return
      }
      const mergeMap = new Map<string, unknown>()
      const merges = (ws.model.merges ?? []) as Array<{
        master?: { row: number; col: number }
        range?: { tl: { row: number; col: number }; br: { row: number; col: number } }
      }>
      // mergeMode=fill：把合并区域主格的值预填到区域内每个从属格，读单元格时查表替换。
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
      const cellCount = ws.columnCount ?? 0
      const total = ws.rowCount ?? 0
      let index = 0
      for (let r = 1; r <= total; r++) {
        if (isCancelled()) {
          reject(new CancelError())
          return
        }
        const wsRow = ws.getRow(r)
        const out: (string | null)[] = []
        for (let c = 1; c <= cellCount; c++) {
          const cell = wsRow.getCell(c)
          const merged = mergeMap.get(`${r}:${c}`)
          const raw = merged !== undefined ? merged : cell.value
          const resolved = opts.formulaMode === 'formula' ? resolveSharedFormula(ws, r, c, raw) : raw
          out.push(normalizeCell(resolved, opts.formulaMode))
        }
        // 整行为空的行不输出，也不占用表头行/数据行计数。
        if (out.every((v) => v === null)) {
          index++
          continue
        }
        // headerRowIndex 为 0-based（0 即第一行表头），与预览/导入链路 buildColumns 的约定一致。
        if (index < opts.headerRowIndex) {
          // 表头行之前的行直接跳过，不进入回调
        } else if (index === opts.headerRowIndex) {
          onHeader(out)
        } else {
          onRow(out)
        }
        index++
        if (index % 1000 === 0) onProgress?.(index, total)
      }
      onProgress?.(total, total)
      resolve()
    })().catch(reject)
  })
}

/** 只读文件头 64KB：供编码探测与 CSV 分隔符猜测使用，不建立完整读流。 */
function openHead(filePath: string): Buffer {
  const fd = openSync(filePath, 'r')
  const buf = Buffer.alloc(64 * 1024)
  try {
    const len = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, len)
  } finally {
    closeSync(fd)
  }
}

/** 单元格值归一：Date 转 ISO 文本、Buffer 转十六进制、公式按模式取公式文本或计算结果、
 *  富文本与富值对象递归解包，最终统一输出为字符串或 null。 */
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
      return (value as { richText: { text: string }[] }).richText.map((p) => p.text ?? '').join('')
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
