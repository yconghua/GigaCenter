import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { GigaCenterApi } from '../shared/ipc-types'

// preload 白名单：只暴露 invoke/on/off。
// 注意：sandbox: true 下 preload 不能 require 任何模块（仅 electron 内置），
// 因此通道白名单在此内联，值必须与 shared/ipc-types.ts 保持一致。
const allowedChannels = new Set<string>([
  'app:ping',
  'app:get-app-info',
  'app:get-paths',
  'app:open-devtools',
  'app:open-exe-folder',
  'app:open-folder',
  'app:show-in-folder',
  'settings:get',
  'settings:set-preferences',
  'settings:clear-preferences',
  'settings:export-diagnostics',
  'task:get-current',
  'task:get-active',
  'task:subscribe',
  'task:cancel',
  'app:confirm-close',
  'app:authorize-drop',
  'convert:parse-workbook',
  'convert:inspect-sheet',
  'convert:preview-export',
  'convert:confirm-export',
  'convert:choose-output-dir',
  'convert:show-in-folder',
  'convert:choose-source-file',
  'convert:preview-export-content',
  'convert:reset-session',
  'analyze:create-session',
  'analyze:probe-import',
  'analyze:import-file',
  'analyze:choose-files',
  'analyze:list-objects',
  'analyze:get-schema',
  'analyze:run-query',
  'analyze:preview-result',
  'analyze:export-result',
  'analyze:close-session',
  'analyze:choose-export-file',
  'analyze:show-in-folder',
  'probe:worker-query',
  'probe:worker-slow-start',
  'probe:worker-cancel',
  'event:probe',
  'event:task',
  'event:session-expired',
  'event:native-theme'
])

const api: GigaCenterApi = {
  invoke: (channel, payload) => {
    if (!allowedChannels.has(channel)) {
      return Promise.reject(new Error(`unauthorized channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload) as Promise<never>
  },
  on: (channel, cb) => {
    if (!allowedChannels.has(channel)) return () => undefined
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('gigacenter', {
  ...api,
  /** 拖拽/文件选择：渲染进程 File 对象 -> 绝对路径（sandbox 下 File.path 已被移除） */
  filePathFor: (file: File): string => webUtils.getPathForFile(file)
})
