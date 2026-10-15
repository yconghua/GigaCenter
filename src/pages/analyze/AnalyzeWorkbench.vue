<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAnalyzeStore } from '@/store/analyze'
import { useFeedbackStore } from '@/store/feedback'
import { useTaskStore } from '@/store/task'
import { analyzeApi } from '@/api/analyze'
import SqlEditor from '@/components/analyze/SqlEditor.vue'
import ResultTable from '@/components/analyze/ResultTable.vue'
import ExportResultModal from '@/components/analyze/ExportResultModal.vue'
import ImportPreviewModal from '@/components/analyze/ImportPreviewModal.vue'
import type { AnalyzeImportPayload, AnalyzeQueryResult } from '@shared/ipc-types'

// 数据分析工作台：导入数据文件（可多选）转为临时 SQLite 库，编写 SQL 查询（支持跨表），浏览表结构并导出结果。
// 导入前先做结构探测，弹「导入前确认：表名与列名」模态，用户确认后一次落库。
// 查询历史仅当前会话有效，退出即清空。

const analyze = useAnalyzeStore()
const feedback = useFeedbackStore()
const task = useTaskStore()

const dropActive = ref(false)
const importing = ref(false)
const probing = ref(false)
const importError = ref('')
const bottomTab = ref<'history' | 'schema'>('history')
const objectFilter = ref('')
const expanded = ref<Record<string, boolean>>({})
// 左右两列内上下面板的高度比例（上：对象树/SQL 编辑器；下：查询历史/表结构与结果），由拖拽分割条调整。
const leftRatio = ref(0.5)
const rightRatio = ref(0.45)
const leftColRef = ref<HTMLDivElement | null>(null)
const rightColRef = ref<HTMLDivElement | null>(null)
// 左列宽度（右列自适应占满剩余空间），拖拽垂直分割条调整，限制在 180~520px。
const leftWidth = ref(256)

/** 拖拽垂直分割条：按住后监听 window 的 mousemove/mouseup，按横向位移更新左列宽度并钳制范围。 */
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

/** 拖拽横向分割条：按容器高度把纵向位移换算成上下面板比例，限制在 0.15~0.85。 */
function startSplitDrag(side: 'left' | 'right', e: MouseEvent): void {
  e.preventDefault()
  const container = side === 'left' ? leftColRef.value : rightColRef.value
  if (!container) return
  const startY = e.clientY
  const startRatio = side === 'left' ? leftRatio.value : rightRatio.value
  const height = container.offsetHeight
  const onMove = (ev: MouseEvent): void => {
    const ratio = startRatio + (ev.clientY - startY) / height
    const clamped = Math.min(0.85, Math.max(0.15, ratio))
    if (side === 'left') leftRatio.value = clamped
    else rightRatio.value = clamped
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

// 对象树按关键字过滤：同时匹配对象名（表/视图/索引）与下属列名
const filteredObjects = computed(() => {
  const kw = objectFilter.value.trim().toLowerCase()
  if (!kw) return analyze.objects
  return analyze.objects.filter((o) => o.name.toLowerCase().includes(kw) || o.columns.some((c) => c.name.toLowerCase().includes(kw)))
})

const editingBusy = computed(() => analyze.running || importing.value || probing.value)

onMounted(() => {
  void analyze.ensureSession()
})

onBeforeUnmount(() => {
  // 组件卸载时不关闭会话：切 Tab 后可恢复现场；临时库只在应用退出时由主进程清理。
})

function toggleExpand(name: string): void {
  expanded.value[name] = !expanded.value[name]
}

async function pickFiles(): Promise<void> {
  if (editingBusy.value) {
    feedback.warning('已有任务运行中，请等待或取消')
    return
  }
  const res = await analyzeApi.chooseFiles()
  if (!res.ok) {
    feedback.errorToast(res.error.message)
    return
  }
  const paths = res.value.filePaths
  if (paths.length === 0) return
  await openProbeModal(paths)
}

async function onDrop(e: DragEvent): Promise<void> {
  dropActive.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length === 0) return
  const paths = files.map((f) => window.gigacenter.filePathFor(f)).filter((p): p is string => Boolean(p))
  if (paths.length === 0) return
  await window.gigacenter.invoke('app:authorize-drop', { paths })
  await openProbeModal(paths)
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
  dropActive.value = true
}

function onDragLeave(): void {
  dropActive.value = false
}

/** 结构探测通过后弹「导入前确认：表名与列名」模态，用户确认表名/列名映射后才落库。 */
async function openProbeModal(paths: string[]): Promise<void> {
  if (editingBusy.value) {
    feedback.warning('已有任务运行中，请等待或取消')
    return
  }
  probing.value = true
  try {
    const res = await analyzeApi.probeImport(paths)
    if (!res.ok) {
      feedback.errorToast(res.error.message)
      return
    }
    const files = res.value.files
    const okFiles = files.filter((f) => f.tables.length > 0)
    if (okFiles.length === 0) {
      const err = files.find((f) => f.errors.length > 0)
      feedback.errorToast(err?.errors[0] ?? '所选文件没有可导入的表')
      return
    }
    const dialogId = feedback.pushModal({
      title: '导入前确认：表名与列名',
      component: ImportPreviewModal,
      width: 'max-w-[1400px]',
      componentProps: {
        files,
        onConfirm: (mappedFiles: AnalyzeImportPayload['files']) => {
          feedback.closeDialog(dialogId, true)
          void doImport(mappedFiles)
        },
        onClose: () => feedback.closeDialog(dialogId, false)
      }
    })
  } finally {
    probing.value = false
  }
}

/** 按用户确认的映射落库：复用当前会话以支持跨表查询；主进程侧新建会话时切换到实际落库的 sessionId。 */
async function doImport(files: AnalyzeImportPayload['files']): Promise<void> {
  if (importing.value || analyze.running) {
    feedback.warning('已有任务运行中，请等待或取消')
    return
  }
  importing.value = true
  importError.value = ''
  try {
    const res = await analyzeApi.importFile({ sessionId: analyze.sessionId || undefined, files })
    if (!res.ok) {
      // 失败提示由 task store 统一以右下角 Toast 弹出（task-error 事件），此处只记录页面内错误状态
      importError.value = res.error.message
      return
    }
    // 复用会话时 sessionId/dbPath 不变；新建会话时必须切换到实际落库的会话，否则后续查询与预览会落空
    analyze.sessionId = res.value.sessionId
    analyze.dbPath = res.value.dbPath
    analyze.mergeImported(res.value.tables, res.value.warnings)
    if (res.value.warnings.length > 0) {
      feedback.showBanner('warning', `导入完成，${res.value.warnings.length} 条警告（可在提示区展开）`)
    } else {
      feedback.success(`导入完成：${res.value.tables.length} 张表，${res.value.elapsedMs}ms`)
    }
    const firstTable = analyze.tables[0]
    if (firstTable) void analyze.selectTable(firstTable.name)
  } catch (e) {
    // IPC 异常兜底：避免导入静默失败，也避免 importing 一直为 true 导致导入按钮卡死
    const msg = e instanceof Error ? e.message : String(e)
    importError.value = msg
    feedback.errorToast(`导入失败：${msg}`)
  } finally {
    importing.value = false
  }
}

async function runQuery(sqlText: string): Promise<void> {
  if (!analyze.sessionId) return
  if (analyze.running) {
    feedback.warning('上一条查询未返回，请等待或取消')
    return
  }
  analyze.running = true
  analyze.resultError = ''
  const res = await analyzeApi.runQuery({ sessionId: analyze.sessionId, sql: sqlText })
  analyze.running = false
  if (!res.ok) {
    // 失败提示由 task store 统一以右下角 Toast 弹出（task-error 事件），此处只记录页面内错误状态
    analyze.resultError = res.error.message
    return
  }
  const result: AnalyzeQueryResult = res.value
  analyze.result = result
  // SQL 以 EXPLAIN 开头时，结果集为查询计划树，界面切换到查询计划面板展示
  analyze.explainMode = /^EXPLAIN\b/i.test(sqlText.trim())
  analyze.pushHistory(sqlText, result.rowCount, result.elapsedMs)
  if (result.truncated) {
    feedback.showBanner('warning', '结果较大，已限制显示前 100000 行，建议加 LIMIT 或改用导出查看完整结果')
  }
}

function runSelection(sqlText: string): void {
  void runQuery(sqlText)
}

function formatSql(sqlText: string): void {
  analyze.setSqlText(sqlText)
}

function explainQuery(): void {
  const sql = analyze.sqlText.trim()
  if (!sql) return
  const wrapped = /^EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN QUERY PLAN ${sql}`
  void runQuery(wrapped)
}

function openExport(): void {
  if (!analyze.result || analyze.result.rowCount === 0) {
    feedback.warning('当前没有可导出的结果集')
    return
  }
  const sql = analyze.history[0]?.sql ?? analyze.sqlText
  feedback.pushModal({
    title: '导出查询结果',
    component: ExportResultModal,
    componentProps: { sql }
  })
}

async function generateTemplate(tableName: string, kind: 'select' | 'insert'): Promise<void> {
  const schema = analyze.schema
  if (!schema) return
  const quoted = `"${tableName.replace(/"/g, '""')}"`
  if (kind === 'select') {
    analyze.setSqlText(`SELECT *\nFROM ${quoted}\nWHERE 1 = 1\nLIMIT 100;`)
  } else {
    const cols = schema.columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ')
    const vals = schema.columns.map((c) => `:${c.name}`).join(', ')
    analyze.setSqlText(`INSERT INTO ${quoted} (${cols})\nVALUES (${vals});`)
  }
}

function fillFromHistory(sql: string): void {
  analyze.setSqlText(sql)
}

async function copyCell(v: string | null): Promise<void> {
  await navigator.clipboard.writeText(v ?? 'NULL')
  feedback.info('已复制')
}

function cancelTask(): void {
  void task.cancel('analyze')
}

const taskPercent = computed(() => {
  const c = task.analyze
  if (!c || !c.total || c.total <= 0) return 0
  return Math.min(100, Math.round((c.done / c.total) * 100))
})

async function onResetAnalyze(): Promise<void> {
  // 重置 = 关闭旧会话（主进程删除临时库）并清空前端状态，下次导入时自动开启新会话
  if (analyze.sessionId) {
    await analyzeApi.closeSession(analyze.sessionId)
  }
  analyze.reset()
  feedback.success('已重置，可重新导入数据')
}
</script>

<template>
  <div
    class="flex h-full flex-col gap-2 p-4"
    @dragover.prevent="onDragOver"
    @drop.prevent="onDrop"
    @dragleave="onDragLeave"
  >
    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-2">
      <button class="rounded bg-[var(--c-primary)] px-3 py-1 text-sm text-[var(--c-on-primary)] hover:bg-[var(--c-primary-hover)] disabled:opacity-50" :disabled="editingBusy || task.isPageBusy('analyze')" @click="pickFiles">
        导入数据文件
      </button>
      <span v-if="analyze.imported" class="text-xs text-[var(--c-text-2)]">已导入：{{ analyze.tables.length }} 张表</span>
      <span v-else class="text-xs text-[var(--c-text-2)]">支持 SQLite / CSV / TXT / JSON / Excel / SQL dump（可多选）</span>
      <div class="ml-auto flex items-center gap-2">
        <button class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)] disabled:opacity-50" :disabled="task.isPageBusy('analyze')" @click="onResetAnalyze">
          重置
        </button>
        <button v-if="analyze.result" class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)] disabled:opacity-50" :disabled="task.isPageBusy('analyze')" @click="openExport">
          导出结果
        </button>
        <button class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)] disabled:opacity-50" :disabled="!analyze.sqlText || analyze.running || task.isPageBusy('analyze')" @click="explainQuery">
          EXPLAIN
        </button>
        <button v-if="analyze.running" class="rounded border border-[var(--c-danger-soft)] px-2 py-1 text-xs text-[var(--c-danger)] hover:bg-[var(--c-danger-soft)]" @click="cancelTask">
          取消查询
        </button>
      </div>
    </div>

    <!-- 页面内任务进度（导入/查询），替代全局底部任务条 -->
    <div
      v-if="task.analyze && (task.analyze.status === 'running' || task.analyze.status === 'cancelling')"
      class="mb-1 flex items-center gap-3 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface-2)] px-3 py-2 text-sm"
    >
      <div class="w-40 truncate text-[var(--c-text)]">{{ task.analyze.title }}</div>
      <div class="w-48 truncate text-xs text-[var(--c-text-2)]">
        {{ task.analyze.currentStep || task.analyze.phase }}
      </div>
      <div class="h-1.5 flex-1 overflow-hidden rounded bg-[var(--c-surface-2)]">
        <div class="h-full bg-[var(--c-primary)] transition-all" :style="{ width: `${taskPercent}%` }" />
      </div>
      <div v-if="task.analyze.total > 0" class="text-xs text-[var(--c-text-2)]">
        {{ task.analyze.done }}/{{ task.analyze.total }}
      </div>
      <div v-else-if="task.analyze.done > 0" class="text-xs text-[var(--c-text-2)]">
        已处理 {{ task.analyze.done }} 行
      </div>
      <button
        class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs hover:bg-[var(--c-surface-2)]"
        @click="cancelTask"
      >
        取消
      </button>
    </div>

    <p v-if="importError" class="rounded border border-[var(--c-danger)] bg-[var(--c-danger-soft)] px-3 py-1 text-xs text-[var(--c-danger)]">
      {{ importError }}
    </p>
    <p v-if="analyze.warnings.length > 0" class="max-h-20 overflow-auto rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
      <span v-for="(w, i) in analyze.warnings" :key="i" class="block">{{ w }}</span>
    </p>

    <div class="flex min-h-0 flex-1 gap-2">
      <!-- 左列：上=表和字段，下=查询历史/表结构，上下可拖；左右宽度可拖 -->
      <div ref="leftColRef" class="flex shrink-0 flex-col gap-1" :style="{ width: `${leftWidth}px` }">
        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)]" :style="{ flex: `${leftRatio} 1 0%` }">
          <div class="border-b border-[var(--c-border-strong)] p-2">
            <input v-model="objectFilter" type="text" placeholder="搜索表/字段…" class="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-surface-2)] px-2 py-1 text-xs outline-none focus:border-sky-500" />
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-1">
            <div v-if="!analyze.imported" class="p-3 text-xs text-[var(--c-text-2)]">导入文件后显示表/视图/索引</div>
            <div v-for="obj in filteredObjects" :key="obj.type + obj.name">
              <div class="group flex items-center rounded px-1 hover:bg-[var(--c-surface-2)]" :class="analyze.selectedTable === obj.name ? 'bg-[var(--c-primary)]/20' : ''">
                <button
                  v-if="obj.type === 'table' || obj.type === 'view'"
                  class="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-2)]"
                  title="展开/收起列"
                  @click="toggleExpand(obj.name)"
                >
                  {{ expanded[obj.name] ? '▾' : '▸' }}
                </button>
                <span v-else class="w-4 shrink-0"></span>
                <button
                  class="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs transition-colors"
                  :class="analyze.selectedTable === obj.name ? 'text-[var(--c-text)]' : 'text-[var(--c-text-2)] hover:text-[var(--c-text)]'"
                  :disabled="obj.type === 'index' || obj.type === 'trigger'"
                  @click="analyze.selectTable(obj.name)"
                >
                  <span>{{ obj.type === 'table' ? '📄' : obj.type === 'view' ? '👁' : obj.type === 'index' ? '⚡' : '⚙' }}</span>
                  <span class="truncate">{{ obj.name }}</span>
                  <span v-if="obj.rowCount !== null" class="ml-auto text-[10px] text-[var(--c-text-2)]">{{ obj.rowCount }}</span>
                </button>
                <span v-if="obj.type === 'table' || obj.type === 'view'" class="hidden shrink-0 gap-0.5 group-hover:flex">
                  <button class="rounded bg-[var(--c-surface-2)] px-1 text-[10px] text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)]" title="生成 SELECT 模板" @click="generateTemplate(obj.name, 'select')">
                    SELECT
                  </button>
                  <button v-if="obj.type === 'table'" class="rounded bg-[var(--c-surface-2)] px-1 text-[10px] text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)]" title="生成 INSERT 模板" @click="generateTemplate(obj.name, 'insert')">
                    INSERT
                  </button>
                </span>
              </div>
              <div v-if="(obj.type === 'table' || obj.type === 'view') && expanded[obj.name] && obj.columns.length > 0" class="mb-1 ml-4 border-l border-[var(--c-border-strong)] pl-2">
                <div v-for="col in obj.columns" :key="obj.name + col.name" class="flex items-center gap-1.5 py-0.5 text-xs text-[var(--c-text-2)]">
                  <span class="truncate">{{ col.name }}</span>
                  <span class="ml-auto shrink-0 text-[10px] text-[var(--c-text-3)]">{{ col.type }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="shrink-0 cursor-row-resize rounded px-1 py-0.5 hover:bg-[var(--c-primary)]/20" title="拖动调整上下高度" @mousedown="startSplitDrag('left', $event)">
          <div class="h-0.5 rounded bg-[var(--c-surface-2)]" />
        </div>

        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)]" :style="{ flex: `${1 - leftRatio} 1 0%` }">
          <div class="flex border-b border-[var(--c-border-strong)]">
            <button class="border-b-2 px-3 py-1 text-xs" :class="bottomTab === 'history' ? 'border-[var(--c-primary)] text-[var(--c-text)]' : 'border-transparent text-[var(--c-text-2)]'" @click="bottomTab = 'history'">
              查询历史（仅当前会话）
            </button>
            <button class="border-b-2 px-3 py-1 text-xs" :class="bottomTab === 'schema' ? 'border-[var(--c-primary)] text-[var(--c-text)]' : 'border-transparent text-[var(--c-text-2)]'" @click="bottomTab = 'schema'">
              表结构
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-2">
            <div v-if="bottomTab === 'history'">
              <div v-if="analyze.history.length === 0" class="text-xs text-[var(--c-text-2)]">暂无查询记录（历史仅当前会话有效，退出即清）</div>
              <div v-for="h in analyze.history.slice(0, 20)" :key="h.id" class="mb-1 cursor-pointer rounded px-2 py-1 hover:bg-[var(--c-surface-2)]" @click="fillFromHistory(h.sql)">
                <div class="truncate font-mono text-xs text-[var(--c-text-2)]">{{ h.sql }}</div>
                <div class="text-[10px] text-[var(--c-text-2)]">{{ new Date(h.at).toLocaleTimeString() }} · {{ h.rowCount ?? '-' }} 行 · {{ h.elapsedMs ?? '-' }}ms</div>
              </div>
            </div>
            <div v-else-if="analyze.schema">
              <div class="mb-1 text-xs font-semibold text-[var(--c-text-2)]">{{ analyze.schema.tableName }} 字段</div>
              <table class="w-full text-xs">
                <thead class="text-left text-[var(--c-text-2)]">
                  <tr>
                    <th class="px-1">字段</th>
                    <th class="px-1">类型</th>
                    <th class="px-1">主键</th>
                    <th class="px-1">默认值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in analyze.schema.columns" :key="c.name" class="text-[var(--c-text-2)]">
                    <td class="px-1 py-0.5">{{ c.name }}</td>
                    <td class="px-1 py-0.5">{{ c.type }}</td>
                    <td class="px-1 py-0.5">{{ c.primaryKey ? '✓' : '' }}</td>
                    <td class="px-1 py-0.5">{{ c.defaultValue ?? '' }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="analyze.schema.indexes.length > 0" class="mt-2">
                <div class="mb-1 text-xs font-semibold text-[var(--c-text-2)]">索引</div>
                <div v-for="idx in analyze.schema.indexes" :key="idx.name" class="text-xs text-[var(--c-text-2)]">
                  {{ idx.unique ? 'UNIQUE ' : '' }}{{ idx.name }} ({{ idx.columns }})
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-[var(--c-text-2)]">点击左侧表查看结构</div>
          </div>
        </div>
      </div>

      <!-- 左右宽度拖拽条 -->
      <div class="w-1 shrink-0 cursor-col-resize rounded px-0.5 py-0.5 hover:bg-[var(--c-primary)]/20" title="拖动调整左右宽度" @mousedown="startColDrag($event)">
        <div class="h-full w-0.5 rounded bg-[var(--c-surface-2)]" />
      </div>

      <!-- 右列：上=SQL 编辑器，下=结果区，上下可拖 -->
      <div ref="rightColRef" class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)]" :style="{ flex: `${rightRatio} 1 0%` }">
          <div class="relative min-h-0 flex-1">
            <SqlEditor
              v-model="analyze.sqlText"
              :tables="analyze.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) }))"
              @run="runQuery"
              @run-selection="runSelection"
              @format="formatSql"
            />
            <div v-if="!analyze.imported" class="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-[var(--c-surface)]/60 text-sm text-[var(--c-text-2)]">
              请先导入数据文件
            </div>
          </div>
        </div>

        <div class="shrink-0 cursor-row-resize rounded px-1 py-0.5 hover:bg-[var(--c-primary)]/20" title="拖动调整上下高度" @mousedown="startSplitDrag('right', $event)">
          <div class="h-0.5 rounded bg-[var(--c-surface-2)]" />
        </div>

        <div class="flex min-h-0 flex-col rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)]" :style="{ flex: `${1 - rightRatio} 1 0%` }">
          <div v-if="analyze.result" class="flex min-h-0 flex-1 flex-col">
            <div v-if="analyze.explainMode && analyze.result.explainPlan" class="max-h-44 shrink-0 overflow-auto border-b border-[var(--c-border-strong)] p-2">
              <div class="mb-1 text-xs font-semibold text-[var(--c-text-2)]">查询计划</div>
              <div v-for="(node, i) in analyze.result.explainPlan" :key="i" class="font-mono text-xs text-[var(--c-text-2)]">
                <div>{{ node.detail }}</div>
                <div v-for="(child, j) in node.children" :key="j" class="pl-4 text-[var(--c-text-2)]">
                  {{ child.detail }}
                </div>
              </div>
              <div class="mt-1 text-[11px] text-amber-400/80">
                提示：全表扫描/临时排序通常可用索引优化，可右键表生成查询模板后加 WHERE 条件。
              </div>
            </div>
            <ResultTable :columns="analyze.result.columns" :rows="analyze.result.rows" :truncated="analyze.result.truncated" @copy-cell="copyCell" />
          </div>
          <div v-else-if="analyze.resultError" class="flex h-full items-start justify-center overflow-auto p-4">
            <div class="w-full max-w-2xl rounded border border-[var(--c-danger)] bg-[var(--c-danger-soft)] p-3 text-sm text-[var(--c-danger)]">
              <div class="mb-1 font-semibold">查询失败</div>
              <pre class="whitespace-pre-wrap font-mono text-xs">{{ analyze.resultError }}</pre>
            </div>
          </div>
          <div v-else class="flex h-full flex-col items-center justify-center gap-2 text-[var(--c-text-2)]">
            <div class="text-sm">执行 SQL 后结果显示在此处</div>
            <div class="text-xs">Ctrl+Enter 执行 · Ctrl+Shift+Enter 执行选中 · Ctrl+Shift+F 格式化</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 拖拽遮罩 -->
    <div v-if="dropActive" class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-2 border-dashed border-[var(--c-primary)] bg-[var(--c-primary)]/10">
      <div class="text-lg text-[var(--c-text)]">松开以导入数据文件</div>
    </div>
  </div>
</template>
