import { createReadStream, openSync, readSync, closeSync } from 'node:fs'
import { parse } from 'csv-parse'
import iconv from 'iconv-lite'
import { detectEncoding } from '../parsers/encoding'
import { resolveSharedFormula } from './excel-refs'

/** exceljs 体积大、加载约 8s，仅在真正导出 Excel 时惰性加载 */
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
      // headerRowIndex 为 0-based（0 即第一行表头），与预览/导入链路 buildColumns 一致
      if (index < opts.headerRowIndex) {
        // 表头之前的行跳过
      } else if (index === opts.headerRowIndex) {
        onHeader(norm)
      } else {
        onRow(norm)
        done++
        if (done % 1000 === 0) onProgress?.(done, -1)
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
      const ws = wb.getWorksheet(sheetId + 1)
      if (!ws) {
        reject(new Error('工作表不存在'))
        return
      }
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
        if (out.every((v) => v === null)) {
          index++
          continue
        }
        // headerRowIndex 为 0-based（0 即第一行表头），与预览/导入链路 buildColumns 一致
        if (index < opts.headerRowIndex) {
          // 表头之前的行跳过
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
