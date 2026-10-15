import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import iconv from 'iconv-lite'
import { parse } from 'csv-parse'
import { parse as parseSync } from 'csv-parse/sync'
import { createReadStream } from 'node:fs'
import { detectEncoding } from '../parsers/encoding'
import { uniqueIdentifier } from '../core/path-utils'
import { logger } from '../log'
import type {
  AnalyzeTableInfo,
  ImportTableMapping,
  ProbeFileResult,
  ProbeTableInfo
} from '../../shared/ipc-types'

/** 数据分析导入器：先结构探测（不落库），再按用户映射（表名/列名）落库到会话临时 SQLite。
 *  支持：SQLite、CSV/TXT、JSON（数组/NDJSON/单对象）、Excel（xlsx/xls）、SQL dump、BSON。
 *  不支持时明确报错，不静默降级。 */

export interface ImportOptions {
  onProgress?: (done: number, total: number) => void
  isCancelled?: () => boolean
}

export interface ImportOutcome {
  tables: AnalyzeTableInfo[]
  warnings: string[]
}

const CSV_BATCH = 5000

// ---------- 结构探测（不落库） ----------

export async function probeSource(sourcePath: string): Promise<ProbeFileResult> {
  const ext = path.extname(sourcePath).toLowerCase()
  const fileName = path.basename(sourcePath)
  try {
    if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') {
      return { filePath: sourcePath, fileName, tables: await probeSqlite(sourcePath), errors: [] }
    }
    if (ext === '.csv' || ext === '.txt') {
      return { filePath: sourcePath, fileName, tables: [await probeDelimited(sourcePath)], errors: [] }
    }
    if (ext === '.json') {
      return { filePath: sourcePath, fileName, tables: [await probeJson(sourcePath)], errors: [] }
    }
    if (ext === '.xlsx') {
      return { filePath: sourcePath, fileName, tables: await probeExcel(sourcePath), errors: [] }
    }
    // .xls 为旧版 OLE2 二进制，exceljs 仅支持 .xlsx，快速失败避免长时间无响应
    if (ext === '.xls') {
      return { filePath: sourcePath, fileName, tables: [], errors: ['不支持 .xls 旧格式，请用 Excel/WPS 将文件另存为 .xlsx 后导入'] }
    }
    if (ext === '.sql') {
      return { filePath: sourcePath, fileName, tables: await probeSqlDump(sourcePath), errors: [] }
    }
    if (ext === '.bson') {
      return { filePath: sourcePath, fileName, tables: [await probeBson(sourcePath)], errors: [] }
    }
    return { filePath: sourcePath, fileName, tables: [], errors: [`不支持的文件格式：${ext || '未知'}`] }
  } catch (err) {
    return { filePath: sourcePath, fileName, tables: [], errors: [err instanceof Error ? err.message : String(err)] }
  }
}

async function probeDelimited(sourcePath: string): Promise<ProbeTableInfo> {
  const head = readHead(sourcePath)
  const { encoding } = detectEncoding(head)
  const headText = iconv.decode(head, encoding)
  const firstLineEnd = headText.indexOf('\n')
  const firstLine = (firstLineEnd >= 0 ? headText.slice(0, firstLineEnd) : headText).trimEnd()
  const delimiter = detectDelimiter(firstLine)
  const headers = splitLine(firstLine, delimiter)
  const samples: (string | null)[][] = []
  await new Promise<void>((resolve, reject) => {
    const parser = createReadStream(sourcePath)
      .pipe(iconv.decodeStream(encoding))
      .pipe(
        parse({ delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true })
      )
    let first = true
    parser.on('data', (row: string[]) => {
      if (first) {
        first = false
        return
      }
      samples.push(row.map((v) => (v === '' ? null : v)))
      if (samples.length >= 500) parser.destroy()
    })
    parser.on('end', () => resolve())
    parser.on('close', () => resolve())
    parser.on('error', reject)
  })
  const types = inferColumnTypes(samples)
  return {
    tableIndex: 0,
    sourceName: path.basename(sourcePath, path.extname(sourcePath)),
    rowCount: null,
    sourceKind: 'delimited',
    sampleRows: samples.slice(0, 100),
    columns: headers.map((h, i) => ({ index: i, sourceName: h, inferredType: types[i] ?? 'text' }))
  }
}

async function probeJson(sourcePath: string): Promise<ProbeTableInfo> {
  const docs = readJsonDocs(sourcePath)
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d ?? {})))]
  const types = keys.map((k) => inferJsonType(docs.slice(0, 500).map((d) => d?.[k])))
  return {
    tableIndex: 0,
    sourceName: path.basename(sourcePath, path.extname(sourcePath)),
    rowCount: docs.length,
    columns: keys.map((k, i) => ({ index: i, sourceName: k, inferredType: types[i] }))
  }
}

async function probeExcel(sourcePath: string): Promise<ProbeTableInfo[]> {
  const ExcelJS = await import('exceljs').then(
    (m) => ((m as { default?: typeof import('exceljs') }).default ?? m) as typeof import('exceljs')
  )
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(sourcePath)
  const out: ProbeTableInfo[] = []
  for (const ws of wb.worksheets) {
    if (ws.state === 'hidden') continue
    const cellCount = ws.columnCount ?? 0
    const headers: string[] = []
    if ((ws.rowCount ?? 0) > 0) {
      const row = ws.getRow(1)
      for (let c = 1; c <= cellCount; c++) {
        headers.push(cellToString(row.getCell(c).value) ?? `col_${c}`)
      }
    }
    const samples: (string | null)[][] = []
    for (let r = 2; r <= Math.min(ws.rowCount ?? 1, 501); r++) {
      const row = ws.getRow(r)
      const outRow: (string | null)[] = []
      for (let c = 1; c <= cellCount; c++) outRow.push(cellToString(row.getCell(c).value))
      samples.push(outRow)
    }
    const types = inferColumnTypes(samples)
    out.push({
      tableIndex: out.length,
      sourceName: ws.name,
      rowCount: ws.rowCount ?? null,
      sourceKind: 'excel',
      sampleRows: samples.slice(0, 100),
      columns: headers.map((h, i) => ({ index: i, sourceName: h, inferredType: types[i] ?? 'text' }))
    })
  }
  return out
}

async function probeSqlite(sourcePath: string): Promise<ProbeTableInfo[]> {
  const src = new Database(sourcePath, { readonly: true })
  try {
    const rows = src
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>
    const out: ProbeTableInfo[] = []
    for (const row of rows) {
      const cols = src.prepare(`PRAGMA table_info(${quoteIdent(row.name)})`).all() as Array<{
        name: string
        type: string
      }>
      const count =
        row.type === 'table'
          ? (src.prepare(`SELECT count(*) c FROM ${quoteIdent(row.name)}`).get() as { c: number }).c
          : null
      out.push({
        tableIndex: out.length,
        sourceName: row.name,
        rowCount: count,
        readOnlyColumns: row.type === 'view',
        columns: cols.map((c, i) => ({
          index: i,
          sourceName: c.name,
          inferredType: mapSqliteType(c.type).toLowerCase()
        }))
      })
    }
    return out
  } finally {
    src.close()
  }
}

async function probeSqlDump(sourcePath: string): Promise<ProbeTableInfo[]> {
  const raw = fs.readFileSync(sourcePath, 'utf8')
  const statements = splitSqlStatements(raw)
  const out: ProbeTableInfo[] = []
  for (const stmt of statements) {
    const s = stmt.trim()
    if (!/^CREATE\s+TABLE/i.test(s)) continue
    const m = s.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([^\s"'`()]+)/i)
    if (!m) continue
    const colDefs = extractCreateColumns(s)
    out.push({
      tableIndex: out.length,
      sourceName: m[1],
      rowCount: null,
      readOnlyColumns: true,
      columns: colDefs.map((c, i) => ({ index: i, sourceName: c, inferredType: 'text' }))
    })
  }
  return out
}

async function probeBson(sourcePath: string): Promise<ProbeTableInfo> {
  const docs = await readBsonDocs(sourcePath)
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d ?? {})))]
  const types = keys.map((k) => inferJsonType(docs.slice(0, 500).map((d) => d?.[k])))
  return {
    tableIndex: 0,
    sourceName: path.basename(sourcePath, path.extname(sourcePath)),
    rowCount: docs.length,
    columns: keys.map((k, i) => ({ index: i, sourceName: k, inferredType: types[i] }))
  }
}

// ---------- 按映射落库 ----------

export async function importIntoSession(
  db: Database.Database,
  imports: ImportTableMapping[],
  opts: ImportOptions = {}
): Promise<ImportOutcome> {
  const warnings: string[] = []
  const tables: AnalyzeTableInfo[] = []
  const usedTables = new Set<string>()
  // 同一文件（SQL dump 多表）合并为一次执行
  const groups = new Map<string, ImportTableMapping[]>()
  for (const m of imports) {
    const arr = groups.get(m.filePath) ?? []
    arr.push(m)
    groups.set(m.filePath, arr)
  }
  const entries = [...groups.entries()]
  for (let gi = 0; gi < entries.length; gi++) {
    const [filePath, group] = entries[gi]
    if (opts.isCancelled?.()) throw new Error('导入已取消')
    opts.onProgress?.(gi, entries.length)
    const ext = path.extname(filePath).toLowerCase()
    let created: AnalyzeTableInfo[] = []
    if (ext === '.sql') {
      created = await importSqlDumpMapped(db, group, warnings, opts)
    } else {
      for (const m of group) {
        if (opts.isCancelled?.()) throw new Error('导入已取消')
        created.push(...(await importOne(db, m, ext, opts)))
      }
    }
    for (const t of created) {
      const finalName = uniqueIdentifier(t.name, usedTables)
      if (finalName !== t.name) {
        db.exec(`ALTER TABLE ${quoteIdent(t.name)} RENAME TO ${quoteIdent(finalName)}`)
        t.name = finalName
        warnings.push(`表名「${t.name}」与已有表冲突，已改为「${finalName}」`)
      }
      usedTables.add(finalName)
      tables.push(t)
    }
    opts.onProgress?.(gi + 1, entries.length)
  }
  return { tables, warnings }
}

async function importOne(
  db: Database.Database,
  mapping: ImportTableMapping,
  ext: string,
  opts: ImportOptions
): Promise<AnalyzeTableInfo[]> {
  if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') {
    return [await importSqliteMapped(db, mapping, opts)]
  }
  if (ext === '.csv' || ext === '.txt') return [await importDelimitedMapped(db, mapping, opts)]
  if (ext === '.json') return [await importJsonMapped(db, mapping, opts)]
  if (ext === '.xlsx' || ext === '.xls') return [await importExcelSheet(db, mapping, opts)]
  if (ext === '.bson') return [await importBsonMapped(db, mapping, opts)]
  throw new Error(`不支持的文件格式：${ext || '未知'}`)
}

async function importDelimitedMapped(
  db: Database.Database,
  mapping: ImportTableMapping,
  opts: ImportOptions
): Promise<AnalyzeTableInfo> {
  const t0 = Date.now()
  const tableName = mapping.tableName
  const colNames = mapping.columns.map((c) => c.name)
  if (colNames.length === 0) throw new Error(`表「${tableName}」没有列`)
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const head = readHead(mapping.filePath)
        const { encoding } = detectEncoding(head)
        const headText = iconv.decode(head, encoding)
        const firstLineEnd = headText.indexOf('\n')
        const firstLine = (firstLineEnd >= 0 ? headText.slice(0, firstLineEnd) : headText).trimEnd()
        const delimiter = detectDelimiter(firstLine)
        let batch: (string | null)[][] = []
        let totalRows = 0
        db.exec(
          `CREATE TABLE ${quoteIdent(tableName)} (${colNames.map((c) => `${quoteIdent(c)} TEXT`).join(', ')})`
        )
        const inserted = db.transaction((rows: (string | null)[][]) => {
          const stmt = db.prepare(
            `INSERT INTO ${quoteIdent(tableName)} (${colNames.map((c) => quoteIdent(c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`
          )
          for (const row of rows) stmt.run(...colNames.map((_, i) => row[i] ?? null))
        })
        const parser = createReadStream(mapping.filePath)
          .pipe(iconv.decodeStream(encoding))
          .pipe(
            parse({ delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true })
          )
        // 表头行索引（0 = 第 1 行是表头）：跳过表头及其前的行，其后为数据
        const headerRowIndex = mapping.headerRowIndex ?? 0
        let skipLeft = headerRowIndex + 1
        parser.on('data', (row: string[]) => {
          if (opts.isCancelled?.()) {
            parser.destroy()
            reject(new Error('导入已取消'))
            return
          }
          if (skipLeft > 0) {
            skipLeft--
            return
          }
          batch.push(row.map((v) => (v === '' ? null : v)))
          if (batch.length >= CSV_BATCH) {
            inserted(batch)
            totalRows += batch.length
            batch = []
          }
        })
        parser.on('end', () => {
          if (batch.length > 0) {
            inserted(batch)
            totalRows += batch.length
          }
          const count = db.prepare(`SELECT count(*) c FROM ${quoteIdent(tableName)}`).get() as { c: number }
          logger.debug('csv imported', { tableName, rows: count.c, ms: Date.now() - t0 })
          resolve({
            name: tableName,
            type: 'table',
            rowCount: count.c,
            columns: colNames.map((n) => ({ name: n, type: 'text' }))
          })
        })
        parser.on('error', reject)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}

async function importExcelSheet(
  db: Database.Database,
  mapping: ImportTableMapping,
  opts: ImportOptions
): Promise<AnalyzeTableInfo> {
  const ExcelJS = await import('exceljs').then(
    (m) => ((m as { default?: typeof import('exceljs') }).default ?? m) as typeof import('exceljs')
  )
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(mapping.filePath)
  const visible = wb.worksheets.filter((ws) => ws.state !== 'hidden')
  const ws = visible[mapping.tableIndex]
  if (!ws) throw new Error(`工作表 ${mapping.tableIndex} 不存在`)
  const tableName = mapping.tableName
  const colNames = mapping.columns.map((c) => c.name)
  if (colNames.length === 0) throw new Error(`表「${tableName}」没有列`)
  const mergeMap = buildMergeMap(ws)
  const cellCount = ws.columnCount ?? 0
  let batch: (string | null)[][] = []
  let total = 0
  db.exec(
    `CREATE TABLE ${quoteIdent(tableName)} (${colNames.map((c) => `${quoteIdent(c)} TEXT`).join(', ')})`
  )
  const inserted = db.transaction((rows: (string | null)[][]) => {
    const stmt = db.prepare(
      `INSERT INTO ${quoteIdent(tableName)} (${colNames.map((c) => quoteIdent(c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`
    )
    for (const row of rows) stmt.run(...colNames.map((_, i) => row[i] ?? null))
  })
  // 表头行索引（0 = 第 1 行是表头），数据从表头行之后开始
  const headerRowIndex = mapping.headerRowIndex ?? 0
  const dataStartRow = headerRowIndex + 2
  for (let r = dataStartRow; r <= (ws.rowCount ?? 0); r++) {
    if (opts.isCancelled?.()) throw new Error('导入已取消')
    const row = ws.getRow(r)
    const out: (string | null)[] = []
    for (let c = 1; c <= cellCount; c++) out.push(cellToString(mergeMap.get(`${r}:${c}`) ?? row.getCell(c).value))
    if (out.every((v) => v === null)) continue
    batch.push(out)
    if (batch.length >= CSV_BATCH) {
      inserted(batch)
      total += batch.length
      batch = []
    }
  }
  if (batch.length > 0) {
    inserted(batch)
    total += batch.length
  }
  return {
    name: tableName,
    type: 'table',
    rowCount: total,
    columns: colNames.map((n) => ({ name: n, type: 'text' }))
  }
}

async function importJsonMapped(
  db: Database.Database,
  mapping: ImportTableMapping,
  opts: ImportOptions
): Promise<AnalyzeTableInfo> {
  const docs = readJsonDocs(mapping.filePath)
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d ?? {})))]
  const tableName = mapping.tableName
  const colNames = mapping.columns.map((c) => c.name)
  db.exec(
    `CREATE TABLE ${quoteIdent(tableName)} (${colNames.map((c) => `${quoteIdent(c)} TEXT`).join(', ')})`
  )
  const stmt = db.prepare(
    `INSERT INTO ${quoteIdent(tableName)} (${colNames.map((c) => quoteIdent(c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`
  )
  const insert = db.transaction((items: Record<string, unknown>[]) => {
    for (const item of items) stmt.run(...keys.map((k) => jsonToString(item[k])))
  })
  for (let i = 0; i < docs.length; i += CSV_BATCH) {
    if (opts.isCancelled?.()) throw new Error('导入已取消')
    insert(docs.slice(i, i + CSV_BATCH))
  }
  const count = db.prepare(`SELECT count(*) c FROM ${quoteIdent(tableName)}`).get() as { c: number }
  return {
    name: tableName,
    type: 'table',
    rowCount: count.c,
    columns: colNames.map((n) => ({ name: n, type: 'text' }))
  }
}

async function importBsonMapped(
  db: Database.Database,
  mapping: ImportTableMapping,
  opts: ImportOptions
): Promise<AnalyzeTableInfo> {
  const docs = await readBsonDocs(mapping.filePath)
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d ?? {})))]
  const tableName = mapping.tableName
  const colNames = mapping.columns.map((c) => c.name)
  db.exec(
    `CREATE TABLE ${quoteIdent(tableName)} (${colNames.map((c) => `${quoteIdent(c)} TEXT`).join(', ')})`
  )
  const stmt = db.prepare(
    `INSERT INTO ${quoteIdent(tableName)} (${colNames.map((c) => quoteIdent(c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`
  )
  const insert = db.transaction((items: Record<string, unknown>[]) => {
    for (const item of items) stmt.run(...keys.map((k) => jsonToString(item[k])))
  })
  for (let i = 0; i < docs.length; i += CSV_BATCH) {
    if (opts.isCancelled?.()) throw new Error('导入已取消')
    insert(docs.slice(i, i + CSV_BATCH))
  }
  const count = db.prepare(`SELECT count(*) c FROM ${quoteIdent(tableName)}`).get() as { c: number }
  return {
    name: tableName,
    type: 'table',
    rowCount: count.c,
    columns: colNames.map((n) => ({ name: n, type: 'text' }))
  }
}

async function importSqliteMapped(
  db: Database.Database,
  mapping: ImportTableMapping,
  opts: ImportOptions
): Promise<AnalyzeTableInfo> {
  const src = new Database(mapping.filePath, { readonly: true })
  try {
    const rows = src
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>
    const target = rows[mapping.tableIndex]
    if (!target) throw new Error(`数据对象 ${mapping.tableIndex} 不存在`)
    const tableName = mapping.tableName
    if (target.type === 'view') {
      // 视图：仅支持改表名，列名保留原样（探测时列输入框已禁用）
      const def = src.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(target.name) as {
        sql: string | null
      }
      if (!def.sql) throw new Error(`视图「${target.name}」无定义`)
      const renamedSql = def.sql.replace(new RegExp(escapeRegExp(target.name), 'g'), tableName)
      db.exec(renamedSql)
      const cols = src.prepare(`PRAGMA table_info(${quoteIdent(target.name)})`).all() as Array<{
        name: string
        type: string
      }>
      return {
        name: tableName,
        type: 'view',
        rowCount: null,
        columns: cols.map((c) => ({ name: c.name, type: mapSqliteType(c.type).toLowerCase() }))
      }
    }
    const cols = src.prepare(`PRAGMA table_info(${quoteIdent(target.name)})`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    const colNames = mapping.columns.map((c) => c.name)
    if (colNames.length === 0) throw new Error(`表「${tableName}」没有列`)
    const colDefs = colNames
      .map((n, i) => `${quoteIdent(n)} ${mapSqliteType(cols[i]?.type ?? 'TEXT')}`)
      .join(', ')
    db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${colDefs || 'id INTEGER'})`)
    const stmt = db.prepare(
      `INSERT INTO ${quoteIdent(tableName)} (${colNames.map((c) => quoteIdent(c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`
    )
    const srcRows = src.prepare(`SELECT * FROM ${quoteIdent(target.name)}`).all() as Record<string, unknown>[]
    const batch = db.transaction((items: Record<string, unknown>[]) => {
      for (const item of items) stmt.run(...cols.map((c) => item[c.name] ?? null))
    })
    for (let i = 0; i < srcRows.length; i += CSV_BATCH) {
      if (opts.isCancelled?.()) throw new Error('导入已取消')
      batch(srcRows.slice(i, i + CSV_BATCH))
    }
    const count = db.prepare(`SELECT count(*) c FROM ${quoteIdent(tableName)}`).get() as { c: number }
    return {
      name: tableName,
      type: 'table',
      rowCount: count.c,
      columns: colNames.map((n, i) => ({
        name: n,
        type: mapSqliteType(cols[i]?.type ?? 'TEXT').toLowerCase()
      }))
    }
  } finally {
    src.close()
  }
}

async function importSqlDumpMapped(
  db: Database.Database,
  group: ImportTableMapping[],
  warnings: string[],
  opts: ImportOptions
): Promise<AnalyzeTableInfo[]> {
  const sourcePath = group[0].filePath
  const raw = fs.readFileSync(sourcePath, 'utf8')
  const statements = splitSqlStatements(raw)
  const tables: AnalyzeTableInfo[] = []
  let executed = 0
  for (const stmt of statements) {
    if (opts.isCancelled?.()) throw new Error('导入已取消')
    const s = stmt.trim()
    if (!s) continue
    if (!/^(CREATE|INSERT|DROP|BEGIN|COMMIT|PRAGMA)/i.test(s)) {
      warnings.push(`跳过不支持的语句（仅支持 CREATE/INSERT/DROP/事务）：${s.slice(0, 40)}...`)
      continue
    }
    try {
      db.exec(s)
      executed++
      if (/^CREATE\s+TABLE/i.test(s)) {
        const m = s.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([^\s"'`()]+)/i)
        if (m) {
          const probeCols = extractCreateColumns(s)
          tables.push({
            name: m[1],
            type: 'table',
            rowCount: null,
            columns: probeCols.map((c) => ({ name: c, type: 'text' }))
          })
        }
      }
    } catch (err) {
      warnings.push(`语句执行失败已跳过：${s.slice(0, 60)}...（${String(err).slice(0, 80)}）`)
    }
  }
  if (executed === 0 && warnings.length > 0) {
    throw new Error('SQL dump 无可执行语句，请确认是标准 CREATE/INSERT 文本')
  }
  // 表重命名（列名不支持重命名，探测时列输入框已禁用；若用户改了列名则保留原名）
  for (const m of group) {
    const orig = tables[m.tableIndex]
    if (!orig) continue
    if (m.columns.some((c, i) => c.name !== (orig.columns[i]?.name ?? c.name))) {
      warnings.push(`SQL dump 不支持列重命名，表「${orig.name}」列名已保留原样`)
    }
    if (m.tableName !== orig.name) {
      try {
        db.exec(`ALTER TABLE ${quoteIdent(orig.name)} RENAME TO ${quoteIdent(m.tableName)}`)
        orig.name = m.tableName
      } catch (err) {
        warnings.push(`表「${orig.name}」重命名失败：${String(err).slice(0, 80)}`)
      }
    }
  }
  // 统计行数
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT count(*) c FROM ${quoteIdent(t.name)}`).get() as { c: number }
      t.rowCount = c.c
    } catch {
      t.rowCount = null
    }
  }
  return tables
}

// ---------- 工具 ----------

function inferColumnTypes(samples: (string | null)[][]): string[] {
  if (samples.length === 0) return []
  const n = Math.max(...samples.map((r) => r.length), 0)
  const types: string[] = []
  for (let c = 0; c < n; c++) {
    let seen = 0
    let allInt = true
    let allReal = true
    let allBool = true
    for (const row of samples) {
      const v = row[c]
      if (v === null || v === undefined) continue
      seen++
      if (!/^-?\d+$/.test(v)) allInt = false
      if (!Number.isFinite(Number(v))) allReal = false
      if (!/^(true|false|TRUE|FALSE|True|False)$/.test(v)) allBool = false
    }
    if (seen === 0) types.push('text')
    else if (allInt) types.push('integer')
    else if (allReal) types.push('real')
    else if (allBool) types.push('boolean')
    else types.push('text')
  }
  return types
}

function inferJsonType(values: unknown[]): string {
  let seen = 0
  let allInt = true
  let allNum = true
  let allBool = true
  for (const v of values) {
    if (v === null || v === undefined) continue
    seen++
    if (!(typeof v === 'number' && Number.isInteger(v))) allInt = false
    if (typeof v !== 'number') allNum = false
    if (typeof v !== 'boolean') allBool = false
  }
  if (seen === 0) return 'text'
  if (allInt) return 'integer'
  if (allNum) return 'real'
  if (allBool) return 'boolean'
  return 'text'
}

function splitLine(line: string, delimiter: string): string[] {
  try {
    const rows = parseSync(line, {
      delimiter,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true
    }) as unknown[][]
    return (rows[0] ?? []).map((v) => (v === null || v === undefined ? '' : String(v).trim()))
  } catch {
    return line
      .split(delimiter)
      .map((v) => v.trim())
      .filter((v, i, a) => !(i === a.length - 1 && v === ''))
  }
}

function readJsonDocs(sourcePath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(sourcePath, 'utf8')
  const trimmed = raw.trim()
  let parsed: unknown[]
  if (trimmed.startsWith('[')) {
    parsed = JSON.parse(trimmed) as unknown[]
  } else if (trimmed.startsWith('{')) {
    parsed = [JSON.parse(trimmed)]
  } else {
    parsed = trimmed
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
  }
  const docs = parsed as Record<string, unknown>[]
  if (docs.length === 0) throw new Error('JSON 文件为空')
  const first = docs[0]
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error('JSON 顶层必须是对象数组、NDJSON 或单对象')
  }
  return docs
}

async function readBsonDocs(sourcePath: string): Promise<Record<string, unknown>[]> {
  const { deserialize } = await import('bson')
  const buf = fs.readFileSync(sourcePath)
  const docs: Record<string, unknown>[] = []
  let offset = 0
  while (offset < buf.length) {
    const len = buf.readInt32LE(offset)
    if (len <= 0 || offset + len > buf.length) {
      throw new Error('BSON 文件结构损坏或不是 MongoDB 导出格式')
    }
    docs.push(deserialize(buf.subarray(offset, offset + len)) as Record<string, unknown>)
    offset += len
  }
  if (docs.length === 0) throw new Error('BSON 文件为空')
  return docs
}

function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      cur += ch
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        cur += '*/'
        i++
      } else cur += ch
      continue
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true
        cur += ch
        continue
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        cur += '*/'
        i++
        continue
      }
    }
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick
    cur += ch
    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

function extractCreateColumns(createSql: string): string[] {
  const open = createSql.indexOf('(')
  const close = createSql.lastIndexOf(')')
  if (open < 0 || close <= open) return []
  const body = createSql.slice(open + 1, close)
  const parts = splitTopLevel(body)
  const cols: string[] = []
  for (const part of parts) {
    const p = part.trim()
    const m = p.match(/^["'`]?([A-Za-z0-9_]+)["'`]?\s/)
    if (!m) continue
    const kw = m[1].toUpperCase()
    if (['PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN', 'CHECK', 'KEY'].includes(kw)) continue
    cols.push(m[1])
  }
  return cols
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inS = false
  let inD = false
  let inB = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inS) {
      if (ch === "'") inS = false
      cur += ch
      continue
    }
    if (inD) {
      if (ch === '"') inD = false
      cur += ch
      continue
    }
    if (inB) {
      if (ch === '`') inB = false
      cur += ch
      continue
    }
    if (ch === "'") inS = true
    else if (ch === '"') inD = true
    else if (ch === '`') inB = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) break
    }
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function cellToString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if ('formula' in v && typeof v === 'object') {
      const f = v as { formula?: string; result?: unknown }
      const result = f.result
      return result === undefined || result === null ? null : cellToString(result)
    }
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((p) => p.text).join('')
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text
    if ('error' in v) return String((v as { error: unknown }).error)
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function buildMergeMap(ws: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>()
  const sheet = ws as {
    model?: { merges?: unknown[] }
    getCell: (row: number, col: number) => { value: unknown }
  }
  const merges = (sheet.model?.merges ?? []) as Array<{
    master?: { row: number; col: number }
    range?: { tl: { row: number; col: number }; br: { row: number; col: number } }
  }>
  for (const m of merges) {
    const master = m.master
    const range = m.range
    if (!range || !master) continue
    const masterVal = sheet.getCell(master.row, master.col).value
    for (let r = range.tl.row; r <= range.br.row; r++) {
      for (let c = range.tl.col; c <= range.br.col; c++) {
        if (r === master.row && c === master.col) continue
        map.set(`${r}:${c}`, masterVal)
      }
    }
  }
  return map
}

function jsonToString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as { _bsontype?: string; toString?: () => string }
    if (o._bsontype === 'ObjectId') return o.toString?.() ?? String(v)
    return JSON.stringify(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function mapSqliteType(t: string): string {
  const up = t.toUpperCase()
  if (up.includes('INT')) return 'INTEGER'
  if (up.includes('CHAR') || up.includes('CLOB') || up.includes('TEXT')) return 'TEXT'
  if (up.includes('BLOB')) return 'BLOB'
  if (up.includes('REAL') || up.includes('FLOA') || up.includes('DOUB')) return 'REAL'
  if (up.includes('BOOL')) return 'INTEGER'
  if (up.includes('DATE') || up.includes('TIME')) return 'TEXT'
  return up || 'TEXT'
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function detectDelimiter(firstLine: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = -1
  for (const c of candidates) {
    const count = (firstLine.match(new RegExp(escapeRegExp(c), 'g')) ?? []).length
    if (count > bestCount) {
      bestCount = count
      best = c
    }
  }
  return best
}

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(64 * 1024)
  try {
    const len = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, len)
  } finally {
    fs.closeSync(fd)
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
