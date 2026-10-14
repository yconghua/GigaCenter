import { parentPort, workerData } from 'node:worker_threads'
import { parseSourceFile } from '../convert/convert-core'

/** 解析 worker：Sheet 清单 + 前 50 行 + 类型推断采样（重任务，可 terminate 取消） */

async function main(): Promise<void> {
  const { filePath } = workerData as { filePath: string }
  try {
    const result = await parseSourceFile(filePath)
    parentPort?.postMessage({ ok: true, result })
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) })
  }
}

void main()
