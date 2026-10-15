import { createWriteStream } from 'node:fs'
import type { ColumnType } from '../../shared/ipc-types'
import { asyncAtomicWriteFile } from '../core/atomic-write'

/** MongoDB NDJSON 导出：一行一文档。
 *  类型映射：integer/real -> number、boolean -> boolean、date -> {$date}、text -> string、
 *  _id 文本列（24 位十六进制）-> {$oid}、NULL -> null。 */

export interface NdjsonExportOptions {
  outputPath: string
  headers: (string | null)[]
  columnTypes: Record<number, ColumnType>
  writeRows: (emit: (row: (string | null)[]) => void) => Promise<void>
}

export async function exportNdjsonFile(options: NdjsonExportOptions): Promise<void> {
  const result = await asyncAtomicWriteFile(options.outputPath, async (tmp) => {
    const out = createWriteStream(tmp, { encoding: 'utf8' })
    let cancelled = false
    try {
      await options.writeRows((row) => {
        const doc: Record<string, unknown> = {}
        for (let i = 0; i < options.headers.length; i++) {
          const name = options.headers[i] ?? `col_${i + 1}`
          doc[name] = convertValue(row[i] ?? null, options.columnTypes[i] ?? 'text', name)
        }
        out.write(JSON.stringify(doc) + '\n')
      })
    } catch (err) {
      cancelled = err instanceof Error && err.name === 'CancelError'
      throw err
    } finally {
      if (cancelled) {
        // 取消：丢弃未 flush 缓冲立即退出
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

/** 单元格字符串按列类型转换为 MongoDB 可表达的 JSON 值；_id 列若为 24 位十六进制则包成 $oid。 */
export function convertValue(v: string | null, type: ColumnType, name: string): unknown {
  if (v === null || v === '') return null
  if (type === 'integer' || type === 'real') {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
  }
  if (type === 'boolean') return v.toLowerCase() === 'true' || v === '1'
  if (type === 'date') return { $date: v }
  if (name === '_id' && /^[0-9a-fA-F]{24}$/.test(v)) return { $oid: v }
  return v
}
