import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../log'

// 原子写：导出先写目标目录下的临时文件，全部内容落盘成功后再 rename 成最终文件名。
// Windows 下 rename 遇到目标已存在会失败：先删目标再 rename；
// 若删目标成功但 rename 失败，明确提示"原文件已被删除，请重新导出"。

export type AtomicWriteResult =
  | { ok: true; target: string }
  | { ok: false; error: string; targetDeleted: boolean }

/**
 * 原子写文件。write 回调负责把内容写入 tmpPath（流式/一次性均可），
 * 完成后刷盘并 rename；失败/异常时清理临时文件。
 */
export function atomicWriteFile(
  target: string,
  write: (tmpPath: string) => void
): AtomicWriteResult {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`)
  try {
    write(tmp)
    // 目标文件已存在：先删除（Windows rename 不覆盖；调用方可先清临时文件只读属性）。
    let targetDeleted = false
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target)
        targetDeleted = true
      } catch (err) {
        return { ok: false, error: `目标文件无法删除：${String(err)}`, targetDeleted: false }
      }
    }
    try {
      fs.renameSync(tmp, target)
      return { ok: true, target }
    } catch (err) {
      if (targetDeleted) {
        return {
          ok: false,
          error: `原文件已被删除，但重命名失败，请重新导出：${String(err)}`,
          targetDeleted: true
        }
      }
      return { ok: false, error: `重命名失败：${String(err)}`, targetDeleted: false }
    }
  } catch (err) {
    return { ok: false, error: String(err), targetDeleted: false }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp)
    } catch {
      /* 临时文件清理失败由启动时的残留扫描兜底 */
    }
  }
}

/**
 * 异步原子写：与 atomicWriteFile 同语义，write 回调可异步（流式导出用）。
 */
export async function asyncAtomicWriteFile(
  target: string,
  write: (tmpPath: string) => Promise<void>
): Promise<AtomicWriteResult> {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`)
  try {
    await write(tmp)
    let targetDeleted = false
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target)
        targetDeleted = true
      } catch (err) {
        return { ok: false, error: `目标文件无法删除：${String(err)}`, targetDeleted: false }
      }
    }
    try {
      fs.renameSync(tmp, target)
      return { ok: true, target }
    } catch (err) {
      if (targetDeleted) {
        return {
          ok: false,
          error: `原文件已被删除，但重命名失败，请重新导出：${String(err)}`,
          targetDeleted: true
        }
      }
      return { ok: false, error: `重命名失败：${String(err)}`, targetDeleted: false }
    }
  } catch (err) {
    // 取消错误保持原类型向上传播，避免被包装成普通失败而中断上报。
    if (err instanceof Error && err.name === 'CancelError') throw err
    return { ok: false, error: String(err), targetDeleted: false }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp)
    } catch {
      /* 临时文件清理失败由启动时的残留扫描兜底 */
    }
  }
}

/** 磁盘空间检查：以可用块数 × 块大小估算目标目录剩余空间，>= requiredBytes 才通过；
 *  statfs 检测失败（平台不支持等）时不阻塞，直接放行。 */
export function checkDiskSpace(
  targetDir: string,
  requiredBytes: number
): { ok: boolean; freeBytes: number } {
  try {
    const stat = fs.statfsSync(targetDir)
    const free = stat.bavail * stat.bsize
    return { ok: free >= requiredBytes, freeBytes: free }
  } catch {
    logger.debug('disk space check skipped', { targetDir })
    return { ok: true, freeBytes: Number.POSITIVE_INFINITY }
  }
}

/** 写入过程中的周期性空间检查（检查频率由调用方控制）：返回剩余空间是否仍高于阈值，
 *  低于阈值时由调用方中止导出；检测失败视为通过。 */
export function assertDiskSpace(targetDir: string, minFreeBytes: number): boolean {
  try {
    const stat = fs.statfsSync(targetDir)
    const free = stat.bavail * stat.bsize
    return free >= minFreeBytes
  } catch {
    return true
  }
}
