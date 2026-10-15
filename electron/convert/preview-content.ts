import type { ColumnType, ExportConfig, SheetExportConfig, SheetInspectResult } from '../../shared/ipc-types'
import { sanitizeIdentifier, uniqueIdentifier } from '../core/path-utils'
import { getDialect, sqlStringLiteral } from '../exporters/dialect'
import { escapeCsv } from '../exporters/csv-exporter'
import { convertValue } from '../exporters/ndjson-exporter'
import { literalFor } from '../exporters/sql-exporter'

/** 导出内容预览：复用导出链路同一套列名清洗与行生成逻辑，
 *  基于重采样结果（前 50 行）生成目标格式的前 maxRows 条示例文本，
 *  与真实导出内容逐字一致（SQLite 除外：其真实产物为 .db 二进制，显示等价 SQL）。 */

export interface ExportPreviewContentResult {
  content: string
  maxRows: number
  /** 该表总数据行数 */
  totalRows: number
}

const SQLITE_TYPE: Record<ColumnType, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  date: 'TEXT',
  boolean: 'INTEGER'
}

function sqliteLiteral(v: string | null, type: ColumnType): string {
  if (v === null || v === '') return 'NULL'
  if (type === 'boolean') return v === 'true' || v === '1' ? '1' : '0'
  if (type === 'integer' || type === 'real') {
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : sqlStringLiteral(v)
  }
  return sqlStringLiteral(v)
}

export function buildExportPreviewContent(
  config: ExportConfig,
  sheet: SheetExportConfig,
  inspect: SheetInspectResult,
  tableName: string,
  maxRows = 10
): ExportPreviewContentResult {
  // 列名清洗：与 convert-worker 完全一致（用户改写值优先）
  const used = new Set<string>()
  const cleanNames = inspect.columns.map((c, i) =>
    uniqueIdentifier(sanitizeIdentifier(sheet.columnNames[i] ?? c.header ?? `col_${i + 1}`), used)
  )
  const rows = inspect.rows.slice(0, maxRows)
  const columns = inspect.columns.map((c, i) => ({
    name: cleanNames[i],
    type: sheet.columnTypes[i] ?? c.inferredType
  }))

  let content = ''
  if (config.targetKind === 'csv') {
    const lines: string[] = ['\uFEFF' + cleanNames.map((h) => escapeCsv(h, config.csvFormulaProtection)).join(',')]
    for (const row of rows) {
      lines.push(row.map((v) => escapeCsv(v, config.csvFormulaProtection)).join(','))
    }
    content = lines.join('\r\n')
  } else if (config.targetKind === 'mongodb') {
    const lines: string[] = []
    for (const row of rows) {
      const doc: Record<string, unknown> = {}
      for (let i = 0; i < cleanNames.length; i++) {
        doc[cleanNames[i]] = convertValue(row[i] ?? null, columns[i].type, cleanNames[i])
      }
      lines.push(JSON.stringify(doc))
    }
    content = lines.join('\n')
  } else if (config.targetKind === 'sqlite') {
    // 真实产物为 .db，此处展示等价建表 + 插入语句供用户核对
    const cols = columns.map((c) => `"${c.name.replace(/"/g, '""')}" ${SQLITE_TYPE[c.type]}`)
    const lines: string[] = [
      `-- GigaCenter 导出（SQLite .db，以下为等价语句）：${tableName}`,
      '',
      `CREATE TABLE "${tableName.replace(/"/g, '""')}" (${cols.join(', ')});`
    ]
    for (const row of rows) {
      const values = row.map((v, i) => sqliteLiteral(v, columns[i].type))
      lines.push(`INSERT INTO "${tableName.replace(/"/g, '""')}" VALUES (${values.join(', ')});`)
    }
    content = lines.join('\n')
  } else {
    // MySQL / PostgreSQL / SQL Server：与 exportSqlScript 同一套语句生成
    const dialect = getDialect(config.targetKind)
    const cols = columns.map((c) => `${dialect.quote(c.name)} ${dialect.typeOf(c.type)}`).join(', ')
    const lines: string[] = [
      `-- GigaCenter 导出：${tableName}`,
      '',
      `CREATE TABLE ${dialect.quote(tableName)} (${cols});`,
      '',
      ...(dialect.wrapTransaction ? ['BEGIN;'] : [])
    ]
    for (const row of rows) {
      const values = row.map((v, i) => literalFor(v, columns[i].type, dialect))
      lines.push(`INSERT INTO ${dialect.quote(tableName)} VALUES (${values.join(', ')});`)
    }
    if (dialect.wrapTransaction) lines.push('', 'COMMIT;')
    content = lines.join('\n')
  }

  return { content, maxRows: rows.length, totalRows: inspect.rows.length }
}
