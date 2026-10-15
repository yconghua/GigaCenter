import type {
  AnalyzeChooseFilesResult,
  AnalyzeImportPayload,
  AnalyzeImportResult,
  AnalyzePreviewResult,
  AnalyzeQueryResult,
  AnalyzeRunQueryPayload,
  AnalyzeSchemaResult,
  AnalyzeTableInfo,
  ProbeImportResult,
  Result
} from '@shared/ipc-types'

/** 数据分析 IPC 封装：前端组件不直接调用 ipcRenderer，统一经此发起 analyze:* 通道的会话、导入、查询与导出请求。 */

export interface AnalyzeSessionInfo {
  sessionId: string
  dbPath: string
  createdAt: number
}

export const analyzeApi = {
  createSession(): Promise<Result<AnalyzeSessionInfo>> {
    return window.gigacenter.invoke<AnalyzeSessionInfo>('analyze:create-session')
  },
  probeImport(filePaths: string[]): Promise<Result<ProbeImportResult>> {
    return window.gigacenter.invoke<ProbeImportResult>('analyze:probe-import', { filePaths })
  },
  importFile(payload: AnalyzeImportPayload): Promise<Result<AnalyzeImportResult>> {
    return window.gigacenter.invoke<AnalyzeImportResult>('analyze:import-file', payload)
  },
  chooseFiles(): Promise<Result<AnalyzeChooseFilesResult>> {
    return window.gigacenter.invoke<AnalyzeChooseFilesResult>('analyze:choose-files')
  },
  listObjects(sessionId: string): Promise<Result<AnalyzeTableInfo[]>> {
    return window.gigacenter.invoke<AnalyzeTableInfo[]>('analyze:list-objects', sessionId)
  },
  getSchema(sessionId: string, tableName: string): Promise<Result<AnalyzeSchemaResult>> {
    return window.gigacenter.invoke<AnalyzeSchemaResult>('analyze:get-schema', { sessionId, tableName })
  },
  previewResult(sessionId: string, tableName: string): Promise<Result<AnalyzePreviewResult>> {
    return window.gigacenter.invoke<AnalyzePreviewResult>('analyze:preview-result', { sessionId, tableName })
  },
  runQuery(payload: AnalyzeRunQueryPayload): Promise<Result<AnalyzeQueryResult>> {
    return window.gigacenter.invoke<AnalyzeQueryResult>('analyze:run-query', payload)
  },
  exportResult(payload: {
    sessionId: string
    sql: string
    targetKind: 'csv' | 'json' | 'sql'
    outputPath: string
    limit?: number
  }): Promise<Result<{ rowCount: number; elapsedMs: number }>> {
    return window.gigacenter.invoke<{ rowCount: number; elapsedMs: number }>('analyze:export-result', payload)
  },
  closeSession(sessionId: string): Promise<Result<null>> {
    return window.gigacenter.invoke<null>('analyze:close-session', sessionId)
  },
  chooseExportFile(): Promise<Result<{ path: string | null }>> {
    return window.gigacenter.invoke<{ path: string | null }>('analyze:choose-export-file')
  },
  showInFolder(filePath: string): Promise<Result<null>> {
    return window.gigacenter.invoke<null>('analyze:show-in-folder', { filePath })
  }
}
