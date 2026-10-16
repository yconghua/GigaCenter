import type {
  PythonHistoryItem,
  PythonImportedFileInfo,
  PythonRegisterImportItem,
  PythonRuntimeInfo,
  PythonRunResult,
  PythonSessionInfo
} from '@shared/ipc-types'

// Python 分析 IPC 封装：渲染进程 → preload 白名单通道的强类型调用

export const pythonApi = {
  getRuntimeInfo: () => window.gigacenter.invoke<PythonRuntimeInfo>('python:get-runtime-info'),
  chooseFiles: () => window.gigacenter.invoke<{ filePaths: string[] }>('python:choose-files'),
  createSession: () => window.gigacenter.invoke<PythonSessionInfo>('python:create-session'),
  resetSession: (sessionId: string) =>
    window.gigacenter.invoke<PythonSessionInfo>('python:reset-session', { sessionId }),
  runCode: (sessionId: string, code: string) =>
    window.gigacenter.invoke<PythonRunResult>('python:run-code', { sessionId, code }),
  formatCode: (sessionId: string, code: string) =>
    window.gigacenter.invoke<{ ok: boolean; code: string; message: string }>('python:format-code', { sessionId, code }),
  exportResult: (sessionId: string, kind: string, outputPath: string) =>
    window.gigacenter.invoke<{ path: string }>('python:export-result', { sessionId, kind, outputPath }),
  chooseExportFile: (kind: string) =>
    window.gigacenter.invoke<{ path: string | null }>('python:choose-export-file', { kind }),
  cancelRun: (sessionId: string) => window.gigacenter.invoke<null>('python:cancel-run', { sessionId }),
  registerImport: (sessionId: string, items: PythonRegisterImportItem[]) =>
    window.gigacenter.invoke<PythonImportedFileInfo[]>('python:register-import', { sessionId, items }),
  updateImported: (
    sessionId: string,
    fileId: string,
    patch: Partial<Pick<PythonImportedFileInfo, 'headerRow' | 'rowCount' | 'varName'>>
  ) => window.gigacenter.invoke<null>('python:update-imported', { sessionId, fileId, patch })
}

export type { PythonHistoryItem, PythonImportedFileInfo, PythonRuntimeInfo, PythonRunResult }
