import { createWriteStream } from 'node:fs'
import { asyncAtomicWriteFile } from '../core/atomic-write'

/** CSV 导出：UTF-8 BOM 头、可选表头行、公式注入防护与单元格转义；经临时文件原子落盘。 */

export interface CsvExportOptions {
  outputPath: string
  formulaProtection: boolean
  header: (string | null)[]
  /** 逐行写出（不含表头，由调用方决定是否写 header 行） */
  writeRows: (emit: (row: (string | null)[]) => void) => Promise<void>
  includeHeader: boolean
}

export async function exportCsvFile(options: CsvExportOptions): Promise<void> {
  const result = await asyncAtomicWriteFile(options.outputPath, async (tmp) => {
    const out = createWriteStream(tmp, { encoding: 'utf8' })
    const flush = (line: string): void => {
      if (!out.write(line)) {
        // 背压简化处理：未等待 drain，依赖 Node 写缓冲内部排队；流式导出写入频率有限，暂不反压上游
      }
    }
    let cancelled = false
    try {
      out.write('\uFEFF')
      if (options.includeHeader) {
        flush(options.header.map((h) => escapeCsv(h, options.formulaProtection)).join(',') + '\r\n')
      }
      await options.writeRows((row) => {
        flush(row.map((v) => escapeCsv(v, options.formulaProtection)).join(',') + '\r\n')
      })
    } catch (err) {
      cancelled = err instanceof Error && err.name === 'CancelError'
      throw err
    } finally {
      if (cancelled) {
        // 取消：丢弃未 flush 缓冲立即退出，避免等待排空（取消响应 <2s）
        out.destroy()
      } else {
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve())
          out.on('error', reject)
        })
      }
    }
  })
  if (!result.ok) throw new Error(result.error)
}

export function escapeCsv(v: string | null, protection: boolean): string {
  if (v === null || v === '') return ''
  let s = v
  // 公式注入防护：以 = + - @ \t \r 开头时加 ' 前缀
  if (protection && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
