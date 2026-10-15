import fs from 'node:fs'
import path from 'node:path'
import { isPathInside } from '../core/path-utils'

// 路径白名单：按规范化后的目录树授权，仅在本次应用生命周期内有效。
// 导入/导出只允许用户通过对话框或拖拽选择的路径；主进程记录已授权目录，
// 渲染进程传来任意路径时先校验是否落在已授权集合内，不在则拒绝。
// 符号链接/junction 经 realpath 解析后仍必须落在授权根内，否则拒绝。

export class PathWhitelist {
  private roots: string[] = []

  /** 授权一个已存在的目录（canonicalize 后加入集合，去重） */
  authorize(dir: string): void {
    const normalized = canonicalizeDirectory(dir)
    if (!normalized) return
    if (!this.roots.some((r) => isSameOrInside(normalized, r))) {
      this.roots.push(normalized)
    }
  }

  /** 拖拽/选择的文件：其父目录加入授权集合 */
  authorizeFile(file: string): void {
    this.authorize(path.dirname(file))
  }

  /** 判断路径是否落在已授权根目录内（文件路径按其父目录规范化后校验） */
  isAuthorized(p: string): boolean {
    const normalized = canonicalizePath(p)
    if (!normalized) return false
    return this.roots.some((r) => isSameOrInside(normalized, r))
  }

  isAuthorizedDir(dir: string): boolean {
    return this.isAuthorized(dir)
  }

  rootsList(): string[] {
    return [...this.roots]
  }
}

/** canonicalize 已存在的目录：realpath 解析符号链接/junction + 大小写规范化 */
export function canonicalizeDirectory(dir: string): string {
  try {
    const real = fs.realpathSync.native(dir)
    return normalizeCase(real)
  } catch {
    return ''
  }
}

/** 对可能不存在的路径做规范化（父目录 realpath + 拼文件名） */
export function canonicalizePath(p: string): string {
  const parent = path.dirname(p)
  const base = path.basename(p)
  const realParent = canonicalizeDirectory(parent)
  if (!realParent) return ''
  return normalizeCase(path.join(realParent, base))
}

// Windows 文件系统大小写不敏感，统一转小写，避免同一目录因大小写不同重复授权。
function normalizeCase(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrInside(p: string, root: string): boolean {
  return isPathInside(p, root)
}
