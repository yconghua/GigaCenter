import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  PythonBlock,
  PythonHistoryItem,
  PythonImportedFileInfo,
  PythonRunResult,
  ProbeTableInfo
} from '@shared/ipc-types'
import { pythonApi } from '@/api/python'

// Python 分析页会话状态：会话 ID、导入文件、运行状态、流式输出、结果块与执行历史。
// 历史与会话绑定，重置会话时一并清除；输出区默认清空式（每次运行替换上次）。

export const usePythonStore = defineStore('python', () => {
  const sessionId = ref<string | null>(null)
  const files = ref<PythonImportedFileInfo[]>([])
  /** 导入文件的结构探测结果（fileId → 表/字段信息），供左侧列表展开显示字段 */
  const fileMetas = ref<Record<string, ProbeTableInfo[]>>({})
  const running = ref(false)
  const streams = ref<{ kind: 'out' | 'err'; text: string }[]>([])
  const blocks = ref<PythonBlock[]>([])
  const history = ref<PythonHistoryItem[]>([])
  const runtimeMissing = ref(false)

  const hasSession = computed(() => sessionId.value !== null)
  const lastStatus = computed(() => history.value[0]?.status ?? null)

  /** 建立会话（页面挂载时调用一次） */
  async function init(): Promise<void> {
    const res = await pythonApi.createSession()
    if (res.ok) {
      sessionId.value = res.value.sessionId
      runtimeMissing.value = false
    } else {
      runtimeMissing.value = true
    }
  }

  /** 重置会话：主进程杀 Worker + 删旧会话目录并新建，前端清空全部状态 */
  async function reset(): Promise<void> {
    running.value = false
    streams.value = []
    blocks.value = []
    history.value = []
    files.value = []
    fileMetas.value = {}
    const res = await pythonApi.resetSession(sessionId.value ?? '')
    if (res.ok) {
      sessionId.value = res.value.sessionId
      runtimeMissing.value = false
    } else {
      runtimeMissing.value = true
      sessionId.value = null
    }
  }

  /** 导入文件：复制到会话目录并预读注册（页面弹确认后调用） */
  async function registerImport(
    items: Array<{ sourcePath: string; originalName: string; kind: PythonImportedFileInfo['kind']; headerRow: number | null }>
  ): Promise<PythonImportedFileInfo[]> {
    if (!sessionId.value) return []
    const res = await pythonApi.registerImport(sessionId.value, items)
    if (res.ok) {
      files.value = [...files.value, ...res.value]
      return res.value
    }
    return []
  }

  /** 删除单个导入文件：主进程删记录+副本+注销变量，前端同步列表与元数据 */
  async function removeFile(fileId: string): Promise<boolean> {
    if (!sessionId.value) return false
    const res = await pythonApi.removeImport(sessionId.value, fileId)
    if (!res.ok) return false
    files.value = files.value.filter((f) => f.id !== fileId)
    const next = { ...fileMetas.value }
    delete next[fileId]
    fileMetas.value = next
    return true
  }

  /** 设置文件结构探测结果（左侧列表展开显示字段） */
  function setFileMetas(metas: Record<string, ProbeTableInfo[]>): void {
    fileMetas.value = { ...fileMetas.value, ...metas }
  }

  /** 执行代码：清空上次输出，流式输出实时追加，结果块渲染，记录历史 */
  async function run(code: string): Promise<PythonRunResult | null> {
    if (!sessionId.value || running.value) return null
    running.value = true
    streams.value = []
    blocks.value = []
    const res = await pythonApi.runCode(sessionId.value, code)
    running.value = false
    if (res.ok) {
      const result = res.value
      blocks.value = result.blocks ?? []
      // 失败时历史保存完整错误详情：优先取本次 err 流（traceback），无则退回结果 message
      const errText = streams.value
        .filter((s) => s.kind === 'err')
        .map((s) => s.text)
        .join('\n')
        .trim()
      history.value.unshift({
        id: crypto.randomUUID(),
        code,
        at: Date.now(),
        elapsedMs: result.elapsedMs,
        status: result.status,
        message: result.status !== 'ok' ? (errText || result.message || undefined) : undefined
      })
      return result
    }
    // IPC 层失败（运行时缺失/会话不存在等）
    history.value.unshift({
      id: crypto.randomUUID(),
      code,
      at: Date.now(),
      elapsedMs: 0,
      status: 'error',
      message: res.error.message
    })
    streams.value.push({ kind: 'err', text: res.error.message })
    return null
  }

  /** 取消执行（主进程强杀 Worker，会话变量重置） */
  async function cancel(): Promise<void> {
    if (sessionId.value) await pythonApi.cancelRun(sessionId.value)
    running.value = false
  }

  /** 流式输出回调（event:python-stream 触发） */
  function pushStream(kind: 'out' | 'err', text: string): void {
    streams.value.push({ kind, text })
  }

  /** 执行历史操作 */
  function clearHistory(): void {
    history.value = []
  }

  return {
    sessionId,
    files,
    fileMetas,
    running,
    streams,
    blocks,
    history,
    runtimeMissing,
    hasSession,
    lastStatus,
    init,
    reset,
    registerImport,
    removeFile,
    setFileMetas,
    run,
    cancel,
    pushStream,
    clearHistory
  }
})
