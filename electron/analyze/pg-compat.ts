// PostgreSQL dump → SQLite 方言兼容转换。
// 数据分析页导入 .sql 文件时，若检测到 PostgreSQL 特征（pg_dump 产物），
// 先把 COPY 数据块转 INSERT、剔除 PG 专有语句（SET/授权/序列/函数等）、
// 映射类型与语法（bigserial→INTEGER、去 CASCADE、去 schema 前缀等），
// 再交给 SQLite 执行，尽量让 dump 导入后与原生 SQLite 文件表现一致。

/** 是否 PostgreSQL dump：按 pg_dump 头部注释 / set_config / COPY stdin / bigserial / SET client_encoding 等特征判定 */
export function isPgDump(raw: string): boolean {
  return (
    /PostgreSQL database dump/i.test(raw) ||
    /pg_catalog\.set_config/i.test(raw) ||
    /\bCOPY\s+["'`\w.]+\s*(\([^)]*\))?\s*FROM\s+stdin/i.test(raw) ||
    /^\s*SET\s+client_encoding\s*=/im.test(raw) ||
    /\bbigserial\b/i.test(raw) ||
    /\bSELECT\s+pg_catalog\./i.test(raw)
  )
}

export interface PgCompatResult {
  /** 转换后的语句序列（保持原顺序，可执行部分；不含被丢弃语句） */
  statements: string[]
  /** 丢弃的不兼容语句条数（SET/授权/序列/函数/COPY 残留等） */
  dropped: number
  /** 做过语法改写的语句条数（类型映射/去 CASCADE 等） */
  rewritten: number
}

/** 顶层 COPY 数据块 → INSERT 语句：解析 PG COPY text 格式（\N 空值、反斜杠转义、\. 结束行） */
function replaceCopyBlocks(sql: string): string {
  const copyRe = /\bCOPY\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_.$]*)(?:\s*\(([^)]*)\))?\s*FROM\s+stdin;?\s*\r?\n([\s\S]*?)\\\.\s*(?:\r?\n|$)/gi
  return sql.replace(copyRe, (_m, tableRaw: string, colsRaw: string | undefined, dataRaw: string) => {
    // 表名去 schema 前缀（public.orders / "public"."orders"），与 CREATE TABLE 转换保持一致
    const tableClean = tableRaw.replace(/^"?public"?\./, '')
    const table = tableClean.startsWith('"') ? tableClean : `"${tableClean}"`
    const cols = colsRaw
      ? ` (${colsRaw.split(',').map((c) => c.trim()).join(', ')})`
      : ''
    const insertLines: string[] = []
    for (const line of dataRaw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      const values = t.split('\t').map((f) => {
        if (f === '\\N') return 'NULL'
        // PG COPY text 格式字段内转义：\\ \t \n \r \b \f \v
        const unescaped = f
          .replace(/\\\\/g, '\u0000BS')
          .replace(/\\t/g, '\t')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\b/g, '\b')
          .replace(/\\f/g, '\f')
          .replace(/\\v/g, '\v')
          .replace(/\u0000BS/g, '\\')
        return `'${unescaped.replace(/'/g, "''")}'`
      })
      insertLines.push(`INSERT INTO ${table}${cols} VALUES (${values.join(', ')});`)
    }
    return insertLines.join('\n')
  })
}

/** 引号感知的语句切分：与 importer.splitSqlStatements 保持同样语义（字符串内的分号不误切） */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
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
    if (!inSingle && !inDouble) {
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
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    cur += ch
    if (ch === ';' && !inSingle && !inDouble) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 纯 PG 专有语句（无对应 SQLite 概念，直接丢弃） */
const DROP_STMT_RE =
  /^(SET\b|SELECT\s+pg_catalog\.|GRANT\b|REVOKE\b|CREATE\s+EXTENSION\b|COMMENT\s+ON\b|CREATE\s+SEQUENCE\b|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b|CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b|CREATE\s+(OR\s+REPLACE\s+)?(AGGREGATE|TYPE|DOMAIN|RULE|TRIGGER)\b|ALTER\s+(SEQUENCE|FUNCTION|ROLE|DEFAULT\s+PRIVILEGES|SCHEMA)\b|ALTER\s+TABLE\s+.*\bOWNER\s+TO\b|ALTER\s+TABLE\s+.*\bADD\s+CONSTRAINT\b)/i

/** CREATE TABLE / CREATE INDEX 尾部的 PG 专用子句（去 WITH/TABLESPACE/USING） */
function stripPgTrailingClauses(stmt: string): string {
  return stmt
    .replace(/\s*WITH\s*\([^)]*\)/gi, '')
    .replace(/\s*TABLESPACE\s+\w+/gi, '')
    .replace(/\s*USING\s+(btree|hash|gist|gin|brin)/gi, '')
    .replace(/\s*INCLUDING\s+\w+/gi, '')
    .trim()
}

/** 类型/语法文本级映射（仅对可执行语句做，字符串字面量中出现 :: 的场景在 dump 中极少，可接受） */
function mapPgSyntax(stmt: string): string {
  let s = stmt
  // schema 前缀：public.foo 与 "public"."foo"
  s = s.replace(/(?<![A-Za-z0-9_."'])"public"\./g, '').replace(/(?<![A-Za-z0-9_."'])public\./g, '')
  // PG 类型转换 ::type
  s = s.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?/g, '')
  // 自增序列类型
  s = s.replace(/\bbigserial\b/gi, 'INTEGER')
  s = s.replace(/\bsmallserial\b/gi, 'INTEGER')
  s = s.replace(/\bserial\b/gi, 'INTEGER')
  // 类型映射
  s = s.replace(/\bcharacter\s+varying\s*\(\s*\d+\s*\)/gi, 'TEXT')
  s = s.replace(/\bvarchar\s*\(\s*\d+\s*\)/gi, 'TEXT')
  s = s.replace(/\bchar\s*\(\s*\d+\s*\)/gi, 'TEXT')
  s = s.replace(/\bbigint\b/gi, 'INTEGER')
  s = s.replace(/\bsmallint\b/gi, 'INTEGER')
  s = s.replace(/\bdouble\s+precision\b/gi, 'REAL')
  s = s.replace(/\bnumeric\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\)/gi, 'REAL')
  s = s.replace(/\bdecimal\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\)/gi, 'REAL')
  s = s.replace(/\bmoney\b/gi, 'REAL')
  s = s.replace(/\bboolean\b/gi, 'INTEGER')
  s = s.replace(/\btimestamp\s*with\s+time\s+zone\b/gi, 'TEXT')
  s = s.replace(/\btimestamp\s*without\s+time\s+zone\b/gi, 'TEXT')
  s = s.replace(/\btimestamp(?:\(\s*\d+\s*\))?\b/gi, 'TEXT')
  s = s.replace(/\btime\s*with\s+time\s+zone\b/gi, 'TEXT')
  s = s.replace(/\btime\s*without\s+time\s+zone\b/gi, 'TEXT')
  s = s.replace(/\btime(?:\(\s*\d+\s*\))?\b/gi, 'TEXT')
  s = s.replace(/\bdate\b/gi, 'TEXT')
  s = s.replace(/\bbytea\b/gi, 'BLOB')
  s = s.replace(/\buuid\b/gi, 'TEXT')
  s = s.replace(/\bjsonb?\b/gi, 'TEXT')
  // DEFAULT 表达式：nextval 序列值 / now() 无 SQLite 等价
  s = s.replace(/\s*DEFAULT\s+nextval\s*\([^)]*\)/gi, '')
  s = s.replace(/\s*DEFAULT\s+now\s*\(\s*\)/gi, ' DEFAULT CURRENT_TIMESTAMP')
  // DROP ... CASCADE/RESTRICT（SQLite 不支持；语句可能带尾部分号）
  s = s.replace(/\s+(CASCADE|RESTRICT)\s*;?\s*$/i, '')
  // CREATE INDEX 里 PostgreSQL 的 WHERE 部分索引（SQLite 支持部分索引，保留）
  return s.trim()
}

/** 剥离开头的 -- 行注释（split 可能把注释行与下一条语句拼在一起），返回剥离后的语句 */
function stripLeadingComments(s: string): string {
  return s.replace(/^(?:--[^\n]*\n?)+/g, '').trim()
}

/** 主入口：PG dump 文本 → SQLite 可执行语句序列 */
export function convertPgDump(raw: string): PgCompatResult {
  // COPY 数据块先转 INSERT（必须在语句切分前完成，数据行不含分号会污染切分）
  const copyConverted = replaceCopyBlocks(raw)
  // 剔除 psql 元命令行（\connect 等）与 COPY 结束标记残留行
  const withoutMeta = copyConverted
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\[A-Za-z]/.test(line) && line.trim() !== '\\.')
    .join('\n')
  const statements: string[] = []
  let dropped = 0
  let rewritten = 0
  for (const rawStmt of splitStatements(withoutMeta)) {
    const s = stripLeadingComments(rawStmt)
    if (!s) continue
    if (DROP_STMT_RE.test(s)) {
      dropped++
      continue
    }
    const converted = stripPgTrailingClauses(mapPgSyntax(s))
    if (converted !== s) rewritten++
    statements.push(converted)
  }
  return { statements, dropped, rewritten }
}
