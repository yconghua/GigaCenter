import { createReadStream, openSync, readSync, closeSync } from 'node:fs'
import { parse } from 'csv-parse'
import iconv from 'iconv-lite'
import { detectEncoding } from './encoding'

/** CSV/TXT 流式解析：编码检测、分隔符探测、行数统计、前 50 行预览与类型推断采样 */

export interface CsvParseResult {
  rowCount: number
  colCount: number
  encoding: string
  encodingConfidence: number | null
  /** 前 50 行（预览用） */
  previewRows: (string | null)[][]
  /** 类型推断采样：前 1000 行 + 之后均匀抽样（上限 6000） */
  sampleRows: (string | null)[][]
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

export function parseCsvFile(filePath: string): Promise<CsvParseResult> {
  return new Promise((resolve, reject) => {
    // 先读取文件头部 64KB，仅用于编码检测与分隔符探测，之后再流式解析全文件。
    const fd = openSync(filePath, 'r')
    const head = Buffer.alloc(64 * 1024)
    let headLen: number
    try {
      headLen = readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
    const headBuf = head.subarray(0, headLen)
    const { encoding, confidence } = detectEncoding(headBuf)

    // 按解码后的首行原文探测分隔符。
    const headText = iconv.decode(headBuf, encoding)
    const firstLineEnd = headText.indexOf('\n')
    const firstLine = (firstLineEnd >= 0 ? headText.slice(0, firstLineEnd) : headText).trimEnd()
    const delimiter = detectDelimiter(firstLine)

    const stream = createReadStream(filePath)
    const parser = stream
      .pipe(iconv.decodeStream(encoding))
      .pipe(
        parse({
          delimiter,
          relax_column_count: true,
          relax_quotes: true,
          skip_empty_lines: true,
          bom: true
        })
      )

    // 逐行回调：空字符串归一为 null；列数取历史最大值；预览保留前 50 行，
    // 类型推断采样先全收前 1000 行、之后每 5 行取 1 行，总量上限 6000。
    let rowCount = 0
    let colCount = 0
    const previewRows: (string | null)[][] = []
    const sampleRows: (string | null)[][] = []
    let sampleIndex = 0

    parser.on('data', (row: string[]) => {
      const norm: (string | null)[] = row.length > 0 ? row.map((v) => (v === '' ? null : v)) : []
      rowCount++
      if (colCount < norm.length) colCount = norm.length
      if (previewRows.length < 50) previewRows.push(norm)
      if (sampleRows.length < 6000) {
        if (sampleIndex < 1000) {
          sampleRows.push(norm)
        } else if (sampleIndex % 5 === 0) {
          sampleRows.push(norm)
        }
      }
      sampleIndex++
    })
    parser.on('end', () => {
      resolve({ rowCount, colCount, encoding, encodingConfidence: confidence, previewRows, sampleRows })
    })
    parser.on('error', (err) => reject(err))
  })
}
