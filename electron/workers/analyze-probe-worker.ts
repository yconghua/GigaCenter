import { parentPort, workerData } from 'node:worker_threads'
import { probeSource } from '../analyze/importer'
import type { ProbeImportResult } from '../../shared/ipc-types'

/** 数据分析探测 worker：只解析文件结构（表/列/行数），不落库，供导入预览模态展示。 */

interface AnalyzeProbeWorkerData {
  filePaths: string[]
}

async function main(): Promise<void> {
  const data = workerData as AnalyzeProbeWorkerData
  const files: ProbeImportResult['files'] = []
  for (const fp of data.filePaths) {
    files.push(await probeSource(fp))
  }
  parentPort?.postMessage({ done: true, result: { files } })
}

void main()
