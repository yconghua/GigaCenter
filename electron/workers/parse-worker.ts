import { parentPort, workerData } from 'node:worker_threads'
import { parseSourceFile } from '../convert/convert-core'

/** 解析 worker：产出源文件的工作表清单、前 50 行数据与类型推断采样。属重计算任务，由主进程通过 worker.terminate() 取消。 */

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
