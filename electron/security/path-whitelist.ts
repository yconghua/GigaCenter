import fs from 'node:fs'
import path from 'node:path'
import { isPathInside } from '../core/path-utils'

// 路径白名单：按规范化后的目录树授权，本次应用生命周期有效。
// 导入/导出只允许用户通过对话框或拖拽选择的路径，主进程记录已授权路径，
// 渲染进程传任意路径时校验是否在已授权集合内，不在则拒绝。
// 符号链接/junction 解析后必须仍在授权根内，否则拒绝。

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

  /** 判断路径是否在已授权范围内（父目录或文件本体） */
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

function normalizeCase(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrInside(p: string, root: string): boolean {
  return isPathInside(p, root)
}
