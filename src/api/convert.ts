import type {
  ChooseOutputDirResult,
  ExportConfig,
  ExportPreviewContentResult,
  ExportPreviewResult,
  InspectSheetPayload,
  Result,
  SheetInspectResult,
  WorkbookInfo
} from '@shared/ipc-types'

/** 格式转换 IPC 封装：组件不直接调 ipcRenderer */

export interface ParseResult {
  workbook: WorkbookInfo
  inspects: Record<number, SheetInspectResult>
}

export const convertApi = {
  parseWorkbook(filePath: string): Promise<Result<ParseResult>> {
    return window.gigacenter.invoke<ParseResult>('convert:parse-workbook', { filePath })
  },
  inspectSheet(payload: InspectSheetPayload): Promise<Result<ParseResult>> {
    return window.gigacenter.invoke<ParseResult>('convert:inspect-sheet', payload)
  },
  previewExport(config: ExportConfig): Promise<Result<ExportPreviewResult>> {
    return window.gigacenter.invoke<ExportPreviewResult>('convert:preview-export', { config })
  },
  confirmExport(taskId: string): Promise<Result<{ started: boolean; taskId: string }>> {
    return window.gigacenter.invoke<{ started: boolean; taskId: string }>('convert:confirm-export', {
      taskId
    })
  },
  chooseOutputDir(): Promise<Result<ChooseOutputDirResult>> {
    return window.gigacenter.invoke<ChooseOutputDirResult>('convert:choose-output-dir')
  },
  chooseSourceFile(): Promise<Result<{ filePath: string | null }>> {
    return window.gigacenter.invoke<{ filePath: string | null }>('convert:choose-source-file')
  },
  showInFolder(filePath: string): Promise<Result<null>> {
    return window.gigacenter.invoke<null>('convert:show-in-folder', { filePath })
  },
  previewExportContent(taskId: string, sheetId: number): Promise<Result<ExportPreviewContentResult>> {
    return window.gigacenter.invoke<ExportPreviewContentResult>('convert:preview-export-content', {
      taskId,
      sheetId
    })
  }
}
