import path from 'node:path'

/** 路径工具：跨 Windows/Linux 的规范化、包含判断、文件名清洗。不依赖 Electron，可单测。 */

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 判断 p 是否在 root 内（含相等），Windows 下大小写不敏感 */
export function isPathInside(p: string, root: string): boolean {
  const target = normalizeForCompare(p)
  const base = normalizeForCompare(root)
  return target === base || target.startsWith(base + path.sep)
}

// Windows 保留名（含带扩展名和带空格形式）
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
// 非法字符：<>:"/\\|?* 与控制字符
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

/**
 * 文件名清洗：非法字符替换为 _、去尾点尾空格、保留名前加 _、防空。
 * 不做路径级处理，调用方需单独拼接并校验最终路径在授权根内。
 */
export function sanitizeFileName(name: string): string {
  let cleaned = name.replace(INVALID_CHARS, '_').trim()
  cleaned = cleaned.replace(/[. ]+$/, '')
  if (RESERVED_NAMES.test(cleaned)) cleaned = `_${cleaned}`
  // 全部变成下划线（原名为纯非法字符）时回退
  if (!cleaned || !cleaned.replace(/_+/g, '')) cleaned = 'untitled'
  return cleaned
}

/** 表名/列名清洗：保留字母数字与中文，其余转下划线，小写，截断 128；冲突由调用方加 _1/_2 */
export function sanitizeIdentifier(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 128)
  return cleaned || 'col'
}

/** 生成不冲突的标识符：已占用时追加 _1/_2 */
export function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base
  let n = 1
  while (used.has(candidate)) {
    candidate = `${base}_${n}`
    n++
  }
  used.add(candidate)
  return candidate
}

/**
 * 长路径处理：Windows 下启用开关时给绝对路径加 \\?\ 前缀，
 * 绕过 260 字符路径限制（依赖系统 LongPathsEnabled 注册表项）。
 * 已带前缀、非 Windows 或未启用时原样返回。
 */
export function withLongPath(p: string, enabled: boolean): string {
  if (!enabled) return p
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  if (abs.startsWith('\\\\?\\')) return abs
  return `\\\\?\\${abs}`
}
