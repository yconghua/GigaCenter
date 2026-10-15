import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import type { ExportConfig, SheetExportConfig } from '../../shared/ipc-types'
import { streamSheetRows, CancelError } from '../convert/source-stream'
import { exportCsvFile } from '../exporters/csv-exporter'
import { exportSqlFile } from '../exporters/sql-exporter'
import { exportNdjsonFile } from '../exporters/ndjson-exporter'
import { sanitizeIdentifier, uniqueIdentifier, withLongPath } from '../core/path-utils'

/** 转换导出 worker：按主进程传入的配置快照，把源工作表流式转换为 CSV / SQL / NDJSON 文件落盘。
 *  数据流：源端流式推入行数据 → 内存队列 → 导出器逐行消费，内存中只保留未消费的积压行。
 *  取消：检测到取消标志后抛 CancelError 退出（连接直接丢弃，未提交事务自动回滚）。
 *  长路径开关随每次创建 worker 由主进程实时传入，无需重启即可生效。 */

interface ConvertTaskData {
  config: ExportConfig
  sheetFileNames: Record<number, string>
  sheetNames: Record<number, string>
  sheetTableNames: Record<number, string>
  longPathSupport: boolean
}

let cancelled = false // 取消标志：主进程发来 {cancel:true} 消息时置位

parentPort?.on('message', (m: unknown) => {
  if (m && typeof m === 'object' && (m as { cancel?: boolean }).cancel) cancelled = true
})

async function main(): Promise<void> {
  const { config, sheetFileNames, sheetNames, sheetTableNames, longPathSupport } = workerData as ConvertTaskData
  try {
    const included = config.sheets.filter((s) => s.include)
    let done = 0
    for (const sheet of included) {
      if (cancelled) throw new CancelError()
      const fileName = sheetFileNames[sheet.sheetId]
      const outputPath = withLongPath(path.join(config.outputDir, fileName), longPathSupport)
      const sheetName = sheetNames[sheet.sheetId] ?? `Sheet ${sheet.sheetId + 1}`
      const tableName = sheetTableNames[sheet.sheetId] ?? sheet.tableName
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      await exportSheet(config, sheet, outputPath, tableName)
      done++
      parentPort?.postMessage({
        progress: {
          done,
          total: included.length,
          currentStep: `正在导出「${sheetName}」`,
          message: `${sheetName} 导出完成`
        }
      })
    }
    parentPort?.postMessage({ done: true })
  } catch (err) {
    if (err instanceof CancelError) {
      parentPort?.postMessage({ cancelled: true })
    } else {
      parentPort?.postMessage({ error: err instanceof Error ? err.stack ?? String(err) : String(err) })
    }
  }
}

async function exportSheet(
  config: ExportConfig,
  sheet: SheetExportConfig,
  outputPath: string,
  tableName: string
): Promise<void> {
  let header: (string | null)[] = []
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => {
    resolveReady = r
  })
  const rowQueue: (string | null)[][] = []
  let wakeup: (() => void) | null = null
  let sourceEnded = false
  let sourceError: Error | null = null

  const onHeader = (h: (string | null)[]): void => {
    header = h
    resolveReady()
  }
  const onRow = (row: (string | null)[]): void => {
    rowQueue.push(row)
    wakeup?.()
  }

  // 队列消费者：源端推入行进入 rowQueue，导出器逐行 emit；sourceEnded 后排空队列退出，循环任意位置都可能抛 CancelError。
  const consume = async (emit: (row: (string | null)[]) => void): Promise<void> => {
    for (;;) {
      if (cancelled) throw new CancelError()
      while (rowQueue.length > 0) {
        if (cancelled) throw new CancelError()
        emit(rowQueue.shift() as (string | null)[])
      }
      if (sourceEnded) break
      await new Promise<void>((r) => {
        wakeup = r
        // 挂起等待期间源可能已结束或任务已取消，醒来前先判断条件，避免死等。
        if (sourceEnded || cancelled) r()
      })
      wakeup = null
    }
  }

  const sourcePromise = streamSheetRows(
    config.sourcePath,
    sheet.sheetId,
    {
      headerRowIndex: sheet.headerRowIndex,
      formulaMode: sheet.formulaMode,
      mergeMode: sheet.mergeMode
    },
    onHeader,
    onRow,
    () => cancelled,
    () => undefined
  ).catch((err: unknown) => {
    sourceError = err instanceof Error ? err : new Error(String(err))
  })
  void sourcePromise.then(() => {
    sourceEnded = true
    wakeup?.()
  })

  await ready

  // 列名清洗：用户改写值优先于表头原值；清洗与去重算法与预览阶段一致，保证导出表结构与预览相同。
  const used = new Set<string>()
  const cleanNames = header.map((h, i) =>
    uniqueIdentifier(sanitizeIdentifier(sheet.columnNames[i] ?? h ?? `col_${i + 1}`), used)
  )
  const columns = header.map((_, i) => ({ name: cleanNames[i], type: sheet.columnTypes[i] ?? 'text' }))

  if (config.targetKind === 'csv') {
    await exportCsvFile({
      outputPath,
      formulaProtection: config.csvFormulaProtection,
      header: cleanNames,
      includeHeader: true,
      writeRows: (emit) => consume(emit)
    })
  } else if (config.targetKind === 'mongodb') {
    await exportNdjsonFile({
      outputPath,
      headers: cleanNames,
      columnTypes: sheet.columnTypes,
      writeRows: (emit) => consume(emit)
    })
  } else {
    await exportSqlFile({
      targetKind: config.targetKind,
      outputPath,
      tableName,
      columns,
      writeRows: (emit) => consume(emit)
    })
  }

  if (sourceError) throw sourceError
  await sourcePromise
}

void main()
