import Database from 'better-sqlite3'
import { createWriteStream } from 'node:fs'
import type { ColumnType } from '../../shared/ipc-types'
import { asyncAtomicWriteFile } from '../core/atomic-write'
import { getDialect, sqlStringLiteral } from './dialect'

/** SQL 导出：SQLite 生成 .db 文件（better-sqlite3 建库）；MySQL/PG/SQLServer 生成 .sql 脚本 */

export interface ColumnDef {
  name: string
  type: ColumnType
}

export interface SqlExportOptions {
  targetKind: 'sqlite' | 'mysql' | 'postgresql' | 'sqlserver'
  outputPath: string
  tableName: string
  columns: ColumnDef[]
  writeRows: (emit: (row: (string | null)[]) => void) => Promise<void>
}

export async function exportSqlFile(options: SqlExportOptions): Promise<void> {
  if (options.targetKind === 'sqlite') {
    await exportSqliteDb(options)
    return
  }
  await exportSqlScript(options)
}

async function exportSqliteDb(options: SqlExportOptions): Promise<void> {
  const result = await asyncAtomicWriteFile(options.outputPath, async (tmp) => {
    const db = new Database(tmp)
    try {
      db.pragma('journal_mode = WAL')
      const cols = options.columns.map((c) => {
        const sqliteType: Record<ColumnType, string> = {
          text: 'TEXT',
          integer: 'INTEGER',
          real: 'REAL',
          date: 'TEXT',
          boolean: 'INTEGER'
        }
        return `"${c.name.replace(/"/g, '""')}" ${sqliteType[c.type]}`
      })
      db.exec(
        `CREATE TABLE "${options.tableName.replace(/"/g, '""')}" (${cols.join(', ')})`
      )
      const insert = db.prepare(
        `INSERT INTO "${options.tableName.replace(/"/g, '""')}" VALUES (${options.columns
          .map(() => '?')
          .join(', ')})`
      )
      const batch = db.transaction((rows: (string | null)[][]) => {
        for (const row of rows) {
          insert.run(row.map((v) => normalizeForDb(v)))
        }
      })
      let rows: (string | null)[][] = []
      await options.writeRows((row) => {
        rows.push(row)
        if (rows.length >= 500) {
          batch(rows)
          rows = []
        }
      })
      if (rows.length > 0) batch(rows)
    } finally {
      db.close()
    }
  })
  if (!result.ok) throw new Error(result.error)
}

async function exportSqlScript(options: SqlExportOptions): Promise<void> {
  const dialect = getDialect(options.targetKind)
  const result = await asyncAtomicWriteFile(options.outputPath, async (tmp) => {
    const out = createWriteStream(tmp, { encoding: 'utf8' })
    const lines: string[] = []
    lines.push(`-- GigaCenter 导出：${options.tableName}`)
    lines.push('')
    const cols = options.columns
      .map((c) => `${dialect.quote(c.name)} ${dialect.typeOf(c.type)}`)
      .join(', ')
    lines.push(`CREATE TABLE ${dialect.quote(options.tableName)} (${cols});`)
    if (dialect.wrapTransaction) lines.push('')
    const writeChunk = (): void => {
      if (lines.length > 0) out.write(lines.join('\n') + '\n')
      lines.length = 0
    }
    let cancelled = false
    try {
      writeChunk()
      if (dialect.wrapTransaction) out.write('BEGIN;\n')
      let batch: string[] = []
      await options.writeRows((row) => {
        const values = row.map((v, i) => literalFor(v, options.columns[i]?.type ?? 'text', dialect))
        batch.push(`INSERT INTO ${dialect.quote(options.tableName)} VALUES (${values.join(', ')});`)
        if (batch.length >= dialect.batchSize) {
          out.write(batch.join('\n') + '\n')
          batch = []
        }
      })
      if (batch.length > 0) out.write(batch.join('\n') + '\n')
      if (dialect.wrapTransaction) out.write('COMMIT;\n')
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

function literalFor(
  v: string | null,
  type: ColumnType,
  dialect: ReturnType<typeof getDialect>
): string {
  if (v === null || v === '') return 'NULL'
  if (type === 'boolean') return dialect.boolLiteral(v)
  if (type === 'date') return dialect.dateLiteral(v)
  if (type === 'integer' || type === 'real') {
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : sqlStringLiteral(v)
  }
  return sqlStringLiteral(v)
}

function normalizeForDb(v: string | null): string | number | null {
  if (v === null || v === '') return null
  const n = Number(v)
  if (v !== '' && Number.isFinite(n) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
    return n
  }
  return v
}
