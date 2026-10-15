import { isPathInside } from '../core/path-utils'

// SQL 预检层：不做语法白名单，用户可写任意 SQL；
// 只对资源、路径、扩展、写权限做安全限制。
// 说明：这里是字符串级分析，不是 SQL 解析器，足以拦截常见越权；
// 真正的写保护靠 SQLite 层 query_only=ON 与只读打开原始库两层兜底。

export type StatementKind =
  | 'select'
  | 'pragma'
  | 'attach'
  | 'detach'
  | 'vacuum'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'savepoint'
  | 'write'
  | 'unknown'

export interface CheckedStatement {
  kind: StatementKind
  sql: string
}

export interface SqlCheckOptions {
  /** 只读模式：拒绝一切写操作与事务语句 */
  readonly: boolean
  /** 会话临时目录：VACUUM INTO 目标必须解析后在其内 */
  sessionTempDir: string
}

export interface SqlCheckResult {
  allowed: boolean
  errorCode?: string
  errorMessage?: string
  statements: CheckedStatement[]
}

// PRAGMA 白名单：仅放行只读查询与性能调优类 PRAGMA；禁用可改路径或加载扩展的危险 PRAGMA。
const ALLOWED_PRAGMAS = new Set([
  'table_info',
  'index_list',
  'index_info',
  'foreign_key_list',
  'query_only',
  'cache_size',
  'mmap_size',
  'page_size',
  'encoding',
  'journal_mode'
])

const FORBIDDEN_PRAGMAS = new Set([
  'temp_store_directory',
  'writable_schema',
  'load_extension',
  'data_store_directory'
])

/** 按分号拆分语句，处理字符串与注释（行注释、块注释） */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString: '"' | "'" | '`' | null = null
  let inLineComment = false
  let inBlockComment = false
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
      current += c
      i++
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        current += '*/'
        i += 2
        continue
      }
      current += c
      i++
      continue
    }
    if (inString) {
      if (c === inString) {
        if (next === inString) {
          current += c + next // 转义引号（'' 或 ""）
          i += 2
          continue
        }
        inString = null
      }
      current += c
      i++
      continue
    }
    if (c === '-' && next === '-') {
      inLineComment = true
      current += c
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      current += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      current += c
      i++
      continue
    }
    if (c === ';') {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}

/** 按语句头部识别类型（仅取前 64 字符，字符串字面量内的关键词不影响判定） */
export function identifyStatement(sql: string): StatementKind {
  const head = sql.trim().slice(0, 64).toUpperCase()
  if (head.startsWith('SELECT') || head.startsWith('WITH')) return 'select'
  if (head.startsWith('PRAGMA')) return 'pragma'
  if (head.startsWith('ATTACH')) return 'attach'
  if (head.startsWith('DETACH')) return 'detach'
  if (head.startsWith('VACUUM')) return 'vacuum'
  if (head.startsWith('BEGIN')) return 'begin'
  if (head.startsWith('COMMIT')) return 'commit'
  if (head.startsWith('ROLLBACK')) return 'rollback'
  if (head.startsWith('SAVEPOINT') || head.startsWith('RELEASE')) return 'savepoint'
  if (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/.test(head)) return 'write'
  return 'unknown'
}

/** 提取 PRAGMA 名（小写） */
export function pragmaName(sql: string): string | null {
  const m = /^PRAGMA\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/i.exec(sql)
  return m ? m[1].toLowerCase() : null
}

/** 提取 VACUUM INTO 的目标路径（引号内） */
export function vacuumIntoTarget(sql: string): string | null {
  const m = /\bINTO\s+(['"])(.*?)\1/i.exec(sql)
  return m ? m[2] : null
}

function deny(
  result: SqlCheckResult,
  code: string,
  message: string
): SqlCheckResult {
  return { ...result, allowed: false, errorCode: code, errorMessage: message }
}

export function checkSql(sql: string, opts: SqlCheckOptions): SqlCheckResult {
  const result: SqlCheckResult = {
    allowed: true,
    statements: splitStatements(sql).map((s) => ({ kind: identifyStatement(s), sql: s }))
  }
  for (const stmt of result.statements) {
    if (stmt.kind === 'attach') return deny(result, 'ATTACH_NOT_ALLOWED', 'ATTACH 已禁用')
    if (stmt.kind === 'detach') return deny(result, 'DETACH_NOT_ALLOWED', 'DETACH 已禁用')
    if (stmt.kind === 'pragma') {
      const name = pragmaName(stmt.sql)
      if (!name) return deny(result, 'PRAGMA_NOT_ALLOWED', '无法识别的 PRAGMA')
      if (FORBIDDEN_PRAGMAS.has(name)) {
        return deny(result, 'PRAGMA_FORBIDDEN', `PRAGMA ${name} 已禁用`)
      }
      if (!ALLOWED_PRAGMAS.has(name)) {
        return deny(result, 'PRAGMA_NOT_ALLOWED', `PRAGMA ${name} 不在白名单`)
      }
    }
    if (stmt.kind === 'vacuum') {
      const target = vacuumIntoTarget(stmt.sql)
      if (!target) {
        return deny(result, 'VACUUM_INTO_REQUIRED', 'VACUUM 必须带 INTO 目标')
      }
      if (!isPathInside(target, opts.sessionTempDir)) {
        return deny(result, 'VACUUM_PATH_OUTSIDE', 'VACUUM INTO 目标必须在会话临时目录内')
      }
    }
    if (opts.readonly) {
      if (stmt.kind === 'write') {
        return deny(result, 'WRITE_NOT_ALLOWED', '只读模式下禁止写操作')
      }
      if (
        stmt.kind === 'begin' ||
        stmt.kind === 'commit' ||
        stmt.kind === 'rollback' ||
        stmt.kind === 'savepoint'
      ) {
        return deny(result, 'TX_NOT_ALLOWED', '只读模式下禁止事务语句')
      }
    }
    // 可写模式（允许修改临时库开关打开）：写操作放行，前端在执行前弹确认。
  }
  return result
}
