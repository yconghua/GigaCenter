<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePythonStore } from '@/store/python'
import { useFeedbackStore } from '@/store/feedback'
import { pythonApi } from '@/api/python'
import { analyzeApi } from '@/api/analyze'
import PythonEditor from '@/components/python/PythonEditor.vue'
import type { PythonHistoryItem, PythonImportedFileInfo, ProbeTableInfo, PythonRuntimeInfo } from '@shared/ipc-types'

// Python 分析工作台：导入数据文件（副本入会话目录，不转 SQLite），编写 Python 代码
// 由独立 Worker 执行（JSON over stdio）。布局：顶部两行固定（运行时状态栏 + 按钮行），
// 下方左（已导入文件列表）| 右（上编辑器 / 下输出区），两处分隔条可拖动。

const py = usePythonStore()
const feedback = useFeedbackStore()

const runtime = ref<PythonRuntimeInfo | null>(null)
const code = ref('')
const dropActive = ref(false)
const importing = ref(false)
const expanded = ref<Record<string, boolean>>({})
/** 导入文件结构探测结果（源路径 → 表/字段信息），注册副本后按 fileId 关联 */
const metaByPath = ref<Record<string, ProbeTableInfo[]>>({})
// 左列宽度与右列上下比例（与数据分析页同款拖拽模式）
const leftWidth = ref(256)
const rightColRef = ref<HTMLDivElement | null>(null)
const rightRatio = ref(0.5)

const runtimeReady = computed(() => runtime.value?.status === 'ready')
const busy = computed(() => py.running || importing.value)
// 输出区 tab：输出 / 执行历史
const outputTab = ref<'output' | 'history'>('output')

/** 拖拽垂直分割条：调整左列宽度，限制在 180~520px */
function startColDrag(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = leftWidth.value
  const onMove = (ev: MouseEvent): void => {
    leftWidth.value = Math.min(520, Math.max(180, startWidth + (ev.clientX - startX)))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 拖拽横向分割条：调整编辑器/输出区上下比例，限制在 0.15~0.85 */
function startSplitDrag(e: MouseEvent): void {
  e.preventDefault()
  const container = rightColRef.value
  if (!container) return
  const startY = e.clientY
  const startRatio = rightRatio.value
  const height = container.offsetHeight
  const onMove = (ev: MouseEvent): void => {
    const ratio = startRatio + (ev.clientY - startY) / height
    rightRatio.value = Math.min(0.85, Math.max(0.15, ratio))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 运行全部 / 运行选中 / 格式化（格式化走 Worker 内 autopep8，P4 接入） */
async function runCode(value: string): Promise<void> {
  if (!runtimeReady.value) {
    feedback.warning('Python 运行时未就绪，请先在系统设置中初始化')
    return
  }
  if (busy.value) return
  const res = await py.run(value)
  if (res && !res.ok && res.status !== 'ok') {
    // 代码执行错误：完整 traceback 已在下方输出区，Toast 只提示位置
    if (res.status === 'error') feedback.errorToast('执行出错（详见下方输出区）')
    else feedback.errorToast(statusText(res.status, res.message))
  }
}

function onRunSelection(value: string): void {
  void runCode(value)
}

async function onFormat(value: string): Promise<void> {
  if (!runtimeReady.value) {
    feedback.warning('Python 运行时未就绪，无法格式化')
    return
  }
  if (!py.sessionId) return
  const res = await pythonApi.formatCode(py.sessionId, value)
  if (res.ok && res.value.ok) {
    code.value = res.value.code
    feedback.success('已格式化')
  } else {
    feedback.errorToast(`格式化失败：${res.ok ? res.value.message : res.error.message}`)
  }
}

const statusBadge: Record<string, { label: string; cls: string }> = {
  ok: { label: '成功', cls: 'text-[var(--c-success)] bg-[var(--c-success-soft)]' },
  blocked: { label: '安全拦截', cls: 'text-[var(--c-warn)] bg-[var(--c-warn-soft)]' },
  error: { label: '出错', cls: 'text-[var(--c-danger)] bg-[var(--c-danger-soft)]' },
  timeout: { label: '超时', cls: 'text-[var(--c-warn)] bg-[var(--c-warn-soft)]' },
  oom: { label: '内存超限', cls: 'text-[var(--c-danger)] bg-[var(--c-danger-soft)]' },
  crashed: { label: '中断', cls: 'text-[var(--c-warn)] bg-[var(--c-warn-soft)]' },
  cancelled: { label: '已取消', cls: 'text-[var(--c-warn)] bg-[var(--c-warn-soft)]' }
}

function historyBadge(status: string): { label: string; cls: string } {
  return statusBadge[status] ?? { label: status, cls: 'text-[var(--c-text-2)] bg-[var(--c-surface-2)]' }
}

function loadHistory(h: PythonHistoryItem): void {
  code.value = h.code
}

/** 历史项错误详情的展开状态 */
const expandedHist = ref<Record<string, boolean>>({})

function toggleHistDetail(h: PythonHistoryItem): void {
  expandedHist.value[h.id] = !expandedHist.value[h.id]
}

async function copyHistory(h: PythonHistoryItem): Promise<void> {
  try {
    await navigator.clipboard.writeText(h.code)
    feedback.success('已复制代码')
  } catch {
    feedback.errorToast('复制失败')
  }
}

// ---------- 导出结果 ----------
const exportKind = ref<'csv' | 'excel' | 'json' | 'sqlite' | 'png' | 'svg' | 'txt' | 'md'>('csv')
// 按最近一次结果内容给出可用导出格式：表格 / 图表 / 文本
const exportOptions = computed(() => {
  const opts: { value: string; label: string }[] = []
  const hasTable = py.blocks.some((b) => b.kind === 'table')
  const hasImage = py.blocks.some((b) => b.kind === 'image')
  const hasText = py.blocks.some((b) => b.kind === 'text') || py.streams.some((s) => s.text.trim().length > 0)
  if (hasTable) {
    opts.push(
      { value: 'csv', label: 'CSV' },
      { value: 'excel', label: 'Excel' },
      { value: 'json', label: 'JSON' },
      { value: 'sqlite', label: 'SQLite' }
    )
  }
  if (hasImage) opts.push({ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' })
  if (hasText) opts.push({ value: 'txt', label: 'TXT' }, { value: 'md', label: 'Markdown' })
  return opts
})

async function exportResult(): Promise<void> {
  if (!py.sessionId) return
  if (exportOptions.value.length === 0) {
    feedback.warning('暂无导出内容，请先运行代码')
    return
  }
  const kind = exportKind.value
  const res = await pythonApi.chooseExportFile(kind)
  if (!res.ok) {
    feedback.errorToast(res.error.message)
    return
  }
  if (!res.value.path) return
  const r = await pythonApi.exportResult(py.sessionId, kind, res.value.path)
  if (r.ok) {
    feedback.success(`已导出：${res.value.path}`)
  } else {
    feedback.errorToast(r.error.message)
  }
}

function statusText(status: string, message: string): string {
  const map: Record<string, string> = {
    blocked: '安全拦截',
    error: '执行出错',
    timeout: '执行超时（30 秒）',
    oom: '超出内存上限',
    crashed: '执行环境已重启',
    cancelled: '已取消'
  }
  return `${map[status] ?? status}${message ? `：${message}` : ''}`
}

/** 导入数据文件：Python 专用选择器（含 XLS），探针展示字段，复制到会话目录并注册变量 */
async function pickFiles(): Promise<void> {
  if (busy.value) {
    feedback.warning('已有任务运行中，请等待完成')
    return
  }
  const res = await pythonApi.chooseFiles()
  if (!res.ok) {
    feedback.errorToast(res.error.message)
    return
  }
  const paths = res.value.filePaths
  if (paths.length === 0) return
  // 同名拒绝（不区分大小写）：同一会话内已导入的文件不允许再次导入，提示并跳过
  const existing = new Set(py.files.map((f) => f.originalName.toLowerCase()))
  const dupes = paths.filter((p) => existing.has((p.split(/[\\/]/).pop() ?? p).toLowerCase()))
  if (dupes.length > 0) {
    feedback.errorToast(`已导入同名文件：${dupes.map((p) => p.split(/[\\/]/).pop()).join('、')}，请先删除再导入`)
  }
  const newPaths = paths.filter((p) => !existing.has((p.split(/[\\/]/).pop() ?? p).toLowerCase()))
  if (newPaths.length === 0) return
  importing.value = true
  try {
    // 结构探测：复用 analyze:probe-import，获取表/字段/行数（仅展示，导入仍复制原文件）
    const probeRes = await analyzeApi.probeImport(newPaths)
    if (probeRes.ok) {
      for (const f of probeRes.value.files) {
        metaByPath.value[f.filePath] = f.tables
      }
    }
    const items = newPaths.map((p) => {
      const ext = p.split('.').pop()?.toLowerCase() ?? ''
      const kind = (['csv', 'txt', 'xlsx', 'xls', 'json', 'sqlite', 'db', 'sqlite3'] as const).includes(ext as never)
        ? (ext === 'db' || ext === 'sqlite3' ? 'sqlite' : (ext as 'csv' | 'txt' | 'xlsx' | 'xls' | 'json' | 'sqlite'))
        : 'csv'
      return { sourcePath: p, originalName: p.split(/[\\/]/).pop() ?? p, kind, headerRow: 0 }
    })
    const added = await py.registerImport(items)
    if (added.length > 0) {
      // 把探测结果按 fileId 关联（与副本顺序对应），供左侧展开显示字段
      const metas: Record<string, ProbeTableInfo[]> = {}
      added.forEach((f, i) => {
        const tables = metaByPath.value[paths[i]] ?? []
        metas[f.id] = tables
        f.rowCount = tables[0]?.rowCount ?? null
      })
      py.setFileMetas(metas)
      feedback.success(`已导入 ${added.length} 个文件：${added.map((f) => `${f.originalName} → ${f.varName}`).join('、')}`)
    }
  } finally {
    importing.value = false
  }
}

/** 删除单个导入文件：确认后删副本与变量（源文件不受影响） */
async function onRemoveFile(f: PythonImportedFileInfo): Promise<void> {
  if (busy.value) {
    feedback.warning('已有任务运行中，请等待完成')
    return
  }
  const ok = await feedback.confirm({
    title: '删除文件',
    message: `将删除「${f.originalName}」的会话副本与同名变量（不影响源文件）。确认继续？`
  })
  if (!ok) return
  if (await py.removeFile(f.id)) feedback.success(`已删除 ${f.originalName}`)
  else feedback.errorToast('删除失败，请重试')
}

async function onReset(): Promise<void> {
  const ok = await feedback.confirm({
    title: '重置会话',
    message: '将删除已导入文件副本、执行历史、输出结果与临时变量，开启新会话。确认继续？'
  })
  if (!ok) return
  await py.reset()
  code.value = ''
  feedback.success('已重置，可重新导入数据')
}

function onCancelRun(): void {
  void py.cancel()
}

onMounted(async () => {
  const [infoRes] = await Promise.all([pythonApi.getRuntimeInfo()])
  if (infoRes.ok) runtime.value = infoRes.value
  // 会话初始化：Worker 懒启动（首次执行才 spawn）
  if (!py.sessionId) await py.init()
  streamOff = window.gigacenter.on('event:python-stream', (payload) => {
    const p = payload as { sessionId: string; kind: 'out' | 'err'; text: string } | null
    if (p && p.sessionId === py.sessionId) py.pushStream(p.kind, p.text)
  })
})

let streamOff: (() => void) | null = null

onBeforeUnmount(() => {
  streamOff?.()
  streamOff = null
})
</script>

<template>
  <div
    class="flex h-full flex-col gap-2 p-4"
    @dragover.prevent="dropActive = true"
    @drop.prevent="dropActive = false"
    @dragleave="dropActive = false"
  >
    <!-- 顶部第一行：运行时状态栏（固定，不参与拖动） -->
    <div class="flex items-center gap-3 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-1.5 text-xs">
      <span class="shrink-0 font-semibold">Python 运行时</span>
      <template v-if="runtimeReady">
        <span class="rounded bg-[var(--c-success-soft)] px-1.5 py-0.5 text-[var(--c-success)]">就绪</span>
        <span class="text-[var(--c-text-2)]">{{ runtime?.source === 'bundled' ? '内置' : '开发回退' }}</span>
        <span class="font-mono text-[var(--c-text)]">{{ runtime?.version || '未知版本' }}</span>
        <span class="truncate text-[var(--c-text-2)]">
          已装库：{{ runtime?.libraries.length ? runtime.libraries.join('、') : '—' }}
        </span>
      </template>
      <template v-else>
        <span class="rounded bg-[var(--c-warn-soft)] px-1.5 py-0.5 text-[var(--c-warn)]">未就绪</span>
        <span class="text-[var(--c-text-2)]">请到「系统设置 → Python 运行时」初始化（离线可用）</span>
      </template>
    </div>

    <!-- 顶部第二行：按钮行（固定，不参与拖动） -->
    <div class="flex items-center gap-2">
      <button
        class="rounded bg-[var(--c-primary)] px-3 py-1 text-sm text-[var(--c-on-primary)] hover:bg-[var(--c-primary-hover)] disabled:opacity-50"
        :disabled="busy"
        @click="pickFiles"
      >
        导入数据文件
      </button>
      <span v-if="py.files.length > 0" class="text-xs text-[var(--c-text-2)]">已导入：{{ py.files.length }} 个文件</span>
      <span v-else class="text-xs text-[var(--c-text-2)]">支持 CSV / TXT / XLSX / XLS / JSON / SQLite（可多选）</span>
      <div class="ml-auto flex items-center gap-2">
        <button
          v-if="py.running"
          class="rounded border border-[var(--c-danger-soft)] px-2 py-1 text-xs text-[var(--c-danger)] hover:bg-[var(--c-danger-soft)]"
          @click="onCancelRun"
        >
          取消执行
        </button>
        <button
          class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)] disabled:opacity-50"
          :disabled="busy"
          @click="onReset"
        >
          重置会话
        </button>
      </div>
    </div>

    <!-- 下方主区：左（文件列表）| 右（编辑器/输出区），竖直分隔条可拖 -->
    <div class="flex min-h-0 flex-1 gap-2">
      <!-- 左列：已导入文件列表 -->
      <div class="flex shrink-0 flex-col rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)]" :style="{ width: `${leftWidth}px` }">
        <div class="border-b border-[var(--c-border-strong)] p-2 text-xs font-semibold">已导入文件</div>
        <div class="min-h-0 flex-1 overflow-auto p-1">
          <div v-if="py.files.length === 0" class="p-3 text-xs text-[var(--c-text-2)]">导入文件后显示数据表（pandas 同名变量）</div>
          <div v-for="f in py.files" :key="f.id" class="mb-1 rounded px-2 py-1.5 hover:bg-[var(--c-surface-2)]">
            <div class="flex items-center gap-1.5 text-xs">
              <button
                v-if="py.fileMetas[f.id]?.length > 0"
                class="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-2)]"
                title="展开/收起字段"
                @click="expanded[f.id] = !expanded[f.id]"
              >
                {{ expanded[f.id] ? '▾' : '▸' }}
              </button>
              <span v-else class="w-4 shrink-0"></span>
              <span class="truncate text-[var(--c-text)]">{{ f.originalName }}</span>
              <span class="ml-auto shrink-0 text-[10px] text-[var(--c-text-3)]">{{ f.kind.toUpperCase() }}</span>
              <button
                class="shrink-0 rounded px-1 text-xs text-[var(--c-text-3)] hover:bg-[var(--c-danger-soft)] hover:text-[var(--c-danger)] disabled:opacity-40"
                title="删除此文件"
                :disabled="busy"
                @click="onRemoveFile(f)"
              >
                ✕
              </button>
            </div>
            <div class="mt-0.5 pl-5 font-mono text-[10px] text-[var(--c-accent)]">
              {{ f.varName }}<span v-if="f.rowCount !== null" class="text-[var(--c-text-3)]"> · {{ f.rowCount }} 行</span>
            </div>
            <div v-if="expanded[f.id] && py.fileMetas[f.id]" class="mt-1 border-l border-[var(--c-border-strong)] pl-3">
              <div v-for="t in py.fileMetas[f.id]" :key="t.tableIndex" class="mb-1">
                <div class="text-[10px] font-semibold text-[var(--c-text-2)]">{{ t.sourceName }}（{{ t.rowCount ?? '-' }} 行）</div>
                <div v-for="c in t.columns" :key="c.index" class="flex items-center gap-1.5 py-0.5 text-[10px] text-[var(--c-text-2)]">
                  <span class="truncate">{{ c.sourceName }}</span>
                  <span class="ml-auto shrink-0 text-[var(--c-text-3)]">{{ c.inferredType }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 竖直拖拽条 -->
      <div class="w-1 shrink-0 cursor-col-resize rounded px-0.5 py-0.5 hover:bg-[var(--c-primary)]/20" title="拖动调整左右宽度" @mousedown="startColDrag($event)">
        <div class="h-full w-0.5 rounded bg-[var(--c-surface-2)]" />
      </div>

      <!-- 右列：上=编辑器，下=输出区，横向分隔条可拖 -->
      <div ref="rightColRef" class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)]" :style="{ flex: `${rightRatio} 1 0%` }">
          <div class="flex items-center gap-2 border-b border-[var(--c-border-strong)] px-2 py-1">
            <span class="text-xs font-semibold">Python 代码</span>
            <span class="text-[10px] text-[var(--c-text-3)]">Ctrl+Enter 运行全部 · Ctrl+Shift+Enter 运行选中 · Ctrl+Shift+F 格式化</span>
          </div>
          <div class="relative min-h-0 flex-1">
            <PythonEditor v-model="code" @run="runCode" @run-selection="onRunSelection" @format="onFormat" />
            <div v-if="!runtimeReady" class="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-[var(--c-surface)]/60 text-sm text-[var(--c-text-2)]">
              请先在系统设置中初始化 Python 运行时
            </div>
          </div>
        </div>

        <div class="shrink-0 cursor-row-resize rounded px-1 py-0.5 hover:bg-[var(--c-primary)]/20" title="拖动调整上下高度" @mousedown="startSplitDrag($event)">
          <div class="h-0.5 rounded bg-[var(--c-surface-2)]" />
        </div>

        <!-- 输出区：流式文本 + 结果块（文本/表格/图表）+ 执行历史 -->
        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)]" :style="{ flex: `${1 - rightRatio} 1 0%` }">
          <div class="flex items-center border-b border-[var(--c-border-strong)] px-2 py-1">
            <button
              class="border-b-2 px-3 py-1 text-xs"
              :class="outputTab === 'output' ? 'border-[var(--c-primary)] text-[var(--c-text)]' : 'border-transparent text-[var(--c-text-2)]'"
              @click="outputTab = 'output'"
            >
              输出
            </button>
            <button
              class="border-b-2 px-3 py-1 text-xs"
              :class="outputTab === 'history' ? 'border-[var(--c-primary)] text-[var(--c-text)]' : 'border-transparent text-[var(--c-text-2)]'"
              @click="outputTab = 'history'"
            >
              执行历史<span v-if="py.history.length > 0" class="ml-1 text-[var(--c-text-3)]">{{ py.history.length }}</span>
            </button>
            <div class="ml-auto flex items-center gap-2">
              <button
                v-if="outputTab === 'history' && py.history.length > 0"
                class="text-xs text-[var(--c-text-2)] hover:text-[var(--c-danger)]"
                @click="py.clearHistory()"
              >
                清空历史
              </button>
              <template v-if="outputTab === 'output' && exportOptions.length > 0">
                <select
                  v-model="exportKind"
                  class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1.5 py-0.5 text-xs text-[var(--c-text)] outline-none"
                >
                  <option v-for="o in exportOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
                <button
                  class="rounded bg-[var(--c-primary)] px-2 py-1 text-xs text-[var(--c-on-primary)] hover:bg-[var(--c-primary-hover)] disabled:opacity-50"
                  :disabled="py.running"
                  @click="exportResult"
                >
                  导出结果
                </button>
              </template>
              <span class="text-[10px] text-[var(--c-text-3)]">每次运行清空上次输出</span>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-2">
            <template v-if="outputTab === 'output'">
              <div v-if="!py.running && py.streams.length === 0 && py.blocks.length === 0" class="text-xs text-[var(--c-text-2)]">
                运行代码后在此显示输出（文本 / 表格 / 图表）
              </div>
              <div v-for="(s, i) in py.streams" :key="`s${i}`" class="whitespace-pre-wrap break-words font-mono text-xs" :class="s.kind === 'err' ? 'text-[var(--c-danger)]' : 'text-[var(--c-text)]'">
                {{ s.text }}
              </div>
              <div v-for="(b, i) in py.blocks" :key="`b${i}`" class="mt-2">
                <div v-if="b.kind === 'text'" class="font-mono text-xs text-[var(--c-text)]">{{ b.text }}</div>
                <table v-else-if="b.kind === 'table'" class="w-full border-collapse text-xs">
                  <thead>
                    <tr class="bg-[var(--c-surface-2)]">
                      <th v-for="c in b.columns" :key="c" class="border border-[var(--c-border)] px-2 py-1 text-left">{{ c }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, ri) in b.rows" :key="ri">
                      <td v-for="(cell, ci) in row" :key="ci" class="border border-[var(--c-border)] px-2 py-0.5">
                        {{ cell === null || cell === '' ? '∅' : String(cell) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="b.kind === 'table' && b.total > b.rows.length" class="mt-0.5 text-[10px] text-[var(--c-text-3)]">
                  共 {{ b.total }} 行，仅显示前 {{ b.rows.length }} 行
                </div>
                <img v-else-if="b.kind === 'image'" :src="`data:${b.mime};base64,${b.data}`" class="max-h-80 max-w-full" alt="图表" />
              </div>
            </template>
            <template v-else>
              <div v-if="py.history.length === 0" class="text-xs text-[var(--c-text-2)]">暂无执行记录（历史仅当前会话有效，重置即清）</div>
              <div v-for="h in py.history" :key="h.id" class="mb-1 cursor-pointer rounded border border-[var(--c-border)] px-2 py-1.5 hover:bg-[var(--c-surface-2)]" @click="loadHistory(h)">
                <div class="flex items-center gap-2">
                  <span class="rounded px-1.5 py-0.5 text-[10px]" :class="historyBadge(h.status).cls">{{ historyBadge(h.status).label }}</span>
                  <span class="text-[10px] text-[var(--c-text-3)]">{{ new Date(h.at).toLocaleTimeString() }} · {{ h.elapsedMs }}ms</span>
                  <span class="ml-auto flex shrink-0 gap-2" @click.stop>
                    <button
                      v-if="h.message"
                      class="text-[10px] text-[var(--c-warn)] hover:underline"
                      @click="toggleHistDetail(h)"
                    >
                      {{ expandedHist[h.id] ? '收起详情' : '查看详情' }}
                    </button>
                    <button class="text-[10px] text-[var(--c-primary)] hover:underline" @click="copyHistory(h)">复制</button>
                  </span>
                </div>
                <div class="mt-0.5 truncate font-mono text-xs text-[var(--c-text-2)]">{{ h.code.replace(/\n/g, ' ⏎ ') }}</div>
                <div
                  v-if="expandedHist[h.id] && h.message"
                  class="mt-1 whitespace-pre-wrap break-words rounded border border-[var(--c-border)] bg-[var(--c-bg)] p-1.5 font-mono text-[10px] text-[var(--c-danger)]"
                >
                  {{ h.message }}
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
