<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useConvertStore } from '@/store/convert'
import { useTaskStore } from '@/store/task'
import { useFeedbackStore } from '@/store/feedback'
import { convertApi } from '@/api/convert'
import type { ExportPreviewResult, ExportTargetKind } from '@shared/ipc-types'
import ExportPreviewModal from '@/components/convert/ExportPreviewModal.vue'

const convert = useConvertStore()
const task = useTaskStore()
const feedback = useFeedbackStore()

const currentSheetId = ref<number | null>(null)

const targetKinds: { value: ExportTargetKind; label: string }[] = [
  { value: 'csv', label: 'CSV（UTF-8，公式防护）' },
  { value: 'sqlite', label: 'SQLite（.db）' },
  { value: 'mysql', label: 'MySQL（.sql）' },
  { value: 'postgresql', label: 'PostgreSQL（.sql）' },
  { value: 'sqlserver', label: 'SQL Server（.sql）' },
  { value: 'mongodb', label: 'MongoDB（.ndjson）' }
]

const typeLabels: Record<string, string> = {
  text: '文本',
  integer: '整数',
  real: '小数',
  date: '日期',
  boolean: '布尔'
}

const currentInspect = computed(() =>
  currentSheetId.value !== null ? convert.inspects[currentSheetId.value] : null
)
const currentSheetMeta = computed(() =>
  convert.workbook?.sheets.find((s) => s.id === currentSheetId.value) ?? null
)
const currentCfg = computed(() =>
  currentSheetId.value !== null ? convert.sheetConfigs[currentSheetId.value] : null
)

const isExcel = computed(() => convert.workbook?.kind === 'xlsx' || convert.workbook?.kind === 'xls')
const showCsvProtection = computed(() => convert.targetKind === 'csv')

// 预览列宽拖拽：按列索引存宽度，序号列用 -1
const colWidths = ref<Record<number, number>>({})
const resizeState = ref<{ index: number; startX: number; startWidth: number } | null>(null)

function onColResizeStart(e: MouseEvent, index: number): void {
  // 未拖过时以当前列宽为基准
  const th = (e.target as HTMLElement).parentElement?.parentElement as HTMLElement | null
  const startWidth = colWidths.value[index] ?? th?.offsetWidth ?? 80
  resizeState.value = { index, startX: e.clientX, startWidth }
  e.preventDefault()
  document.addEventListener('mousemove', onColResizeMove)
  document.addEventListener('mouseup', onColResizeEnd)
}

function onColResizeMove(e: MouseEvent): void {
  const state = resizeState.value
  if (!state) return
  const w = Math.max(40, state.startWidth + (e.clientX - state.startX))
  colWidths.value = { ...colWidths.value, [state.index]: w }
}

function onColResizeEnd(): void {
  resizeState.value = null
  document.removeEventListener('mousemove', onColResizeMove)
  document.removeEventListener('mouseup', onColResizeEnd)
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onColResizeMove)
  document.removeEventListener('mouseup', onColResizeEnd)
})

async function onPickSource(): Promise<void> {
  const res = await window.gigacenter.invoke<{ filePath: string | null }>('convert:choose-source-file')
  if (res.ok && res.value.filePath) await parseFile(res.value.filePath)
}

async function parseFile(filePath: string): Promise<void> {
  const res = await convertApi.parseWorkbook(filePath)
  if (res.ok) {
    convert.setParsed(res.value)
    currentSheetId.value = convert.workbook?.sheets[0]?.id ?? null
  }
  // 解析失败提示由 task store 统一右下角 Toast（task-error 事件），此处不再重复提示
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}
function onDrop(e: DragEvent): void {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const p = window.gigacenter.filePathFor(file)
  if (!p) return
  // 拖拽即用户选择：先授权父目录再解析（路径白名单要求）
  void window.gigacenter.invoke('app:authorize-drop', { paths: [p] }).then(() => parseFile(p))
}

async function onChooseOutputDir(): Promise<void> {
  const res = await convertApi.chooseOutputDir()
  if (res.ok && res.value.directory) convert.outputDir = res.value.directory
}

async function onReinspect(): Promise<void> {
  if (!convert.workbook || currentSheetId.value === null) return
  const cfg = currentCfg.value
  if (!cfg) return
  const res = await convertApi.inspectSheet({
    filePath: convert.workbook.filePath,
    sheetId: currentSheetId.value,
    headerRowIndex: cfg.headerRowIndex,
    formulaMode: cfg.formulaMode,
    mergeMode: cfg.mergeMode
  })
  if (res.ok) {
    // 保留用户已改的列类型
    const prev = convert.inspects[currentSheetId.value]
    const kept: Record<number, string> = {}
    if (prev) {
      for (const col of prev.columns) kept[col.index] = cfg.columnTypes[col.index] ?? col.inferredType
    }
    convert.setParsed(res.value)
    if (currentSheetId.value !== null && kept) {
      const newCfg = convert.sheetConfigs[currentSheetId.value]
      if (newCfg) newCfg.columnTypes = { ...kept } as never
    }
  } else {
    feedback.errorToast(`重新解析失败：${res.error.message}`)
  }
}

async function onPreviewExport(): Promise<void> {
  if (!convert.outputDir) {
    await onChooseOutputDir()
    if (!convert.outputDir) return
  }
  const config = convert.buildConfig()
  if (config.sheets.length === 0) {
    feedback.warning('请至少勾选一个工作表')
    return
  }
  const res = await convertApi.previewExport(config)
  if (!res.ok) {
    feedback.errorToast(`预览失败：${res.error.message}`)
    return
  }
  convert.setPreview(res.value)
  pushPreviewModal(res.value)
}

function pushPreviewModal(preview: ExportPreviewResult): void {
  const dialogId = feedback.pushModal({
    title: '导出预览',
    component: ExportPreviewModal,
    componentProps: {
      preview,
      onConfirm: (conflictMode: 'overwrite' | 'rename') => {
        convert.conflictMode = conflictMode
        feedback.closeDialog(dialogId, true)
        void runExport()
      },
      onClose: () => {
        feedback.closeDialog(dialogId, false)
        // 关闭预览弹窗 = 放弃导出：终结 awaiting_confirm 任务，否则本页任务被锁死
        void task.cancel('convert')
      }
    }
  })
}

async function runExport(): Promise<void> {
  const preview = convert.preview
  if (!preview) return
  convert.setLocked(true)
  const res = await convertApi.confirmExport(preview.taskId)
  if (!res.ok) {
    convert.setLocked(false)
    feedback.errorToast(`导出启动失败：${res.error.message}`)
  }
}

// 导出结束：任务清空后解锁并提示
watch(
  () => task.convert,
  (cur) => {
    if (convert.locked && !cur) {
      convert.setLocked(false)
      const preview = convert.preview
      if (preview && preview.files.length > 0) {
        const first = preview.files[0]
        const openPath = `${convert.outputDir.replace(/[\\/]+$/, '')}/${first.fileName}`
        void convertApi.showInFolder(openPath)
        feedback.success('导出完成，已在文件夹中定位文件')
      }
    }
  }
)

const sheetSelectable = computed(() => !convert.locked)

const taskPercent = computed(() => {
  const c = task.convert
  if (!c || !c.total || c.total <= 0) return 0
  return Math.min(100, Math.round((c.done / c.total) * 100))
})

async function onCancelTask(): Promise<void> {
  const ok = await feedback.confirm({
    title: '取消任务',
    message: '正在进行的任务将被取消，未完成的导出会被清理，是否继续？'
  })
  if (ok) await task.cancel('convert')
}

async function onResetSession(): Promise<void> {
  await convert.resetSession()
  feedback.info('已重置，可导入新文件开始新会话')
}
</script>

<template>
  <div class="relative p-4">
    <!-- 本地处理提示条 -->
    <div class="mb-3 rounded border border-[var(--c-accent-soft)] bg-[var(--c-accent-soft)] px-3 py-2 text-xs text-[var(--c-accent)]">
      数据仅在本地临时处理，关闭后自动清除；原始文件只读打开，不会修改
    </div>

    <!-- 页面内任务进度（解析/导出），替代全局底部任务条 -->
    <div
      v-if="task.convert && (task.convert.status === 'running' || task.convert.status === 'cancelling')"
      class="mb-3 flex items-center gap-3 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface-2)] px-3 py-2 text-sm"
    >
      <div class="w-40 truncate text-[var(--c-text)]">{{ task.convert.title }}</div>
      <div class="w-48 truncate text-xs text-[var(--c-text-2)]">
        {{ task.convert.currentStep || task.convert.phase }}
      </div>
      <div class="h-1.5 flex-1 overflow-hidden rounded bg-[var(--c-surface-2)]">
        <div class="h-full bg-[var(--c-primary)] transition-all" :style="{ width: `${taskPercent}%` }" />
      </div>
      <div v-if="task.convert.total > 0" class="text-xs text-[var(--c-text-2)]">
        {{ task.convert.done }}/{{ task.convert.total }}
      </div>
      <div v-else-if="task.convert.done > 0" class="text-xs text-[var(--c-text-2)]">
        已处理 {{ task.convert.done }} 行
      </div>
      <button
        class="rounded border border-[var(--c-border-strong)] px-2 py-1 text-xs hover:bg-[var(--c-surface-2)]"
        @click="onCancelTask"
      >
        取消
      </button>
    </div>

    <!-- 锁定遮罩 -->
    <div v-if="convert.locked" class="absolute inset-0 z-10 flex items-center justify-center bg-[var(--c-text)]/30">
      <div class="rounded bg-[var(--c-surface)] px-4 py-3 text-sm text-[var(--c-text)]">导出进行中，请勿重复操作…</div>
    </div>

    <!-- 文件选择 -->
    <div v-if="!convert.workbook" class="flex flex-col items-center gap-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-8">
      <button
        class="rounded bg-[var(--c-primary)] px-4 py-2 text-sm hover:bg-[var(--c-primary-hover)] disabled:opacity-50"
        :disabled="task.isPageBusy('convert')"
        @click="onPickSource"
      >
        选择文件（CSV / TXT / XLSX）
      </button>
      <div class="text-xs text-[var(--c-text-2)]">支持 CSV / TXT / XLSX 格式；旧版 .xls 请先另存为 .xlsx</div>
      <div
        class="flex h-28 w-full items-center justify-center rounded-lg border border-dashed border-[var(--c-border-strong)] bg-[var(--c-bg)] text-sm text-[var(--c-text-2)]"
        @dragover="onDragOver"
        @drop="onDrop"
      >
        或将文件拖拽到此处
      </div>
    </div>

    <template v-else>
      <!-- Sheet 清单 -->
      <div class="mb-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
        <div class="mb-2 flex items-center justify-between text-sm">
          <div class="flex items-center gap-2">
            <span class="h-4 w-1 shrink-0 rounded-full bg-[var(--c-primary)]"></span>
            <span class="font-semibold text-[var(--c-text)]">{{ convert.workbook.fileName }}</span>
          </div>
          <div class="flex gap-2">
            <span class="text-xs text-[var(--c-text-2)]">{{ convert.workbook.fileSize }} 字节</span>
            <button
              class="rounded border border-[var(--c-border-strong)] px-2 py-0.5 text-xs hover:bg-[var(--c-surface-2)] disabled:opacity-50"
              :disabled="task.isPageBusy('convert')"
              @click="onResetSession"
            >
              重置（新会话）
            </button>
          </div>
        </div>
        <div v-if="!isExcel && convert.workbook.encoding !== 'utf8'" class="mb-2 text-xs text-[var(--c-accent)]">
          编码：{{ convert.workbook.encoding }}
        </div>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
          <label
            v-for="sheet in convert.workbook.sheets"
            :key="sheet.id"
            class="flex cursor-pointer items-center gap-2 rounded border border-[var(--c-border)] px-2 py-1.5 text-sm"
            :class="currentSheetId === sheet.id ? 'border-[var(--c-primary)]' : ''"
            @click="currentSheetId = sheet.id"
          >
            <input
              type="checkbox"
              :checked="convert.sheetConfigs[sheet.id]?.include"
              :disabled="!sheetSelectable"
              @click.stop
              @change="(e) => convert.toggleSheet(sheet.id, (e.target as HTMLInputElement).checked)"
            />
            <span class="truncate text-[var(--c-text)]">
              {{ sheet.name }}
            </span>
            <span class="ml-auto text-xs text-[var(--c-text-2)]">{{ sheet.rowCount }} 行 × {{ sheet.colCount }} 列</span>
            <span v-if="sheet.hidden" class="text-xs text-[var(--c-warn)]">隐藏</span>
          </label>
        </div>
      </div>

      <!-- 预览与类型 -->
      <div v-if="currentInspect && currentCfg" class="mb-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
        <div class="mb-2 flex flex-wrap items-center gap-3 text-sm">
          <div class="flex items-center gap-2">
            <span class="h-4 w-1 shrink-0 rounded-full bg-[var(--c-accent)]"></span>
            <span class="font-semibold text-[var(--c-text)]">「{{ currentSheetMeta?.name }}」预览（前 50 行）</span>
            <label class="text-xs text-[var(--c-text-2)]">
              表名：
              <input
                class="w-28 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1 py-0.5 text-xs"
                :disabled="convert.locked"
                :value="currentCfg.tableName"
                :title="currentSheetMeta?.name"
                @change="(e) => convert.setTableName(currentSheetId as number, (e.target as HTMLInputElement).value)"
              />
            </label>
          </div>
          <template v-if="isExcel">
            <label class="text-xs text-[var(--c-text-2)]">
              公式：
              <select
                class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1 py-0.5 text-xs"
                :disabled="convert.locked"
                :value="currentCfg.formulaMode"
                @change="(e) => { convert.setFormulaMode(currentSheetId as number, (e.target as HTMLSelectElement).value as 'value' | 'formula'); void onReinspect() }"
              >
                <option value="value">取计算值</option>
                <option value="formula">取公式文本</option>
              </select>
            </label>
            <label class="text-xs text-[var(--c-text-2)]">
              合并单元格：
              <select
                class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1 py-0.5 text-xs"
                :disabled="convert.locked"
                :value="currentCfg.mergeMode"
                @change="(e) => { convert.setMergeMode(currentSheetId as number, (e.target as HTMLSelectElement).value as 'fill' | 'blank'); void onReinspect() }"
              >
                <option value="fill">填充首值</option>
                <option value="blank">留空</option>
              </select>
            </label>
          </template>
          <label class="text-xs text-[var(--c-text-2)]">
            表头行：
            <input
              type="number"
              min="0"
              class="w-14 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1 py-0.5 text-xs"
              :disabled="convert.locked"
              :value="currentCfg.headerRowIndex"
              @change="(e) => { convert.setHeaderRow(currentSheetId as number, Number((e.target as HTMLInputElement).value) || 0); void onReinspect() }"
            />
          </label>
        </div>
        <div v-for="n in currentInspect.notices" :key="n" class="mb-1 text-xs text-[var(--c-warn)]">⚠ {{ n }}</div>
        <div class="max-h-96 overflow-auto">
          <table class="w-full border-separate border-spacing-0 text-xs" style="table-layout: fixed">
            <colgroup>
              <col :style="colWidths[-1] ? { width: colWidths[-1] + 'px' } : {}" />
              <col
                v-for="col in currentInspect.columns"
                :key="col.index"
                :style="colWidths[col.index] ? { width: colWidths[col.index] + 'px' } : {}"
              />
            </colgroup>
            <thead>
              <tr>
                <th class="sticky top-0 z-10 border border-[var(--c-border)] bg-[var(--c-surface-2)] px-2 py-1 text-left font-medium text-[var(--c-text-2)]">
                  <div class="relative">
                    <span>#</span>
                    <div
                      class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--c-primary)]"
                      @mousedown.prevent="onColResizeStart($event, -1)"
                    ></div>
                  </div>
                </th>
                <th
                  v-for="col in currentInspect.columns"
                  :key="col.index"
                  class="sticky top-0 z-10 border border-[var(--c-border)] bg-[var(--c-surface-2)] px-2 py-1 text-left"
                >
                  <div class="relative">
                    <div class="flex flex-col gap-0.5 pr-1">
                      <input
                        class="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-[var(--c-text)] hover:border-[var(--c-border-strong)] focus:border-[var(--c-border-strong)] focus:bg-[var(--c-surface)]"
                        :disabled="convert.locked"
                        :value="currentCfg.columnNames[col.index] ?? col.header"
                        :title="col.header"
                        @change="(e) => convert.setColumnName(currentSheetId as number, col.index, (e.target as HTMLInputElement).value)"
                      />
                      <div class="flex items-center gap-1">
                        <select
                          class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-1 py-0.5 text-xs"
                          :disabled="convert.locked"
                          :value="currentCfg.columnTypes[col.index] ?? col.inferredType"
                          @change="(e) => convert.setColumnType(currentSheetId as number, col.index, (e.target as HTMLSelectElement).value as never)"
                        >
                          <option v-for="(label, key) in typeLabels" :key="key" :value="key">{{ label }}</option>
                        </select>
                        <span v-if="col.needsConfirm" class="cursor-help text-[var(--c-warn)]" :title="col.warnings.join('\n')">⚠</span>
                      </div>
                    </div>
                    <div
                      class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--c-primary)]"
                      @mousedown.prevent="onColResizeStart($event, col.index)"
                    ></div>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in currentInspect.rows" :key="ri" class="odd:bg-[var(--c-bg)]">
                <td class="border border-[var(--c-border)] px-2 py-1 text-[var(--c-text-2)]">{{ ri + 1 }}</td>
                <td
                  v-for="(cell, ci) in row"
                  :key="ci"
                  class="truncate border border-[var(--c-border)] px-2 py-1"
                  :title="cell ?? ''"
                >
                  {{ cell ?? '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 目标配置 -->
      <div class="mb-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
        <div class="mb-2 flex items-center gap-2 text-sm">
          <span class="h-4 w-1 shrink-0 rounded-full bg-[var(--c-success)]"></span>
          <span class="font-semibold text-[var(--c-text)]">导出设置</span>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <label class="text-xs text-[var(--c-text-2)]">
            目标格式
            <select
              v-model="convert.targetKind"
              class="mt-1 block w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1 text-sm"
              :disabled="convert.locked"
            >
              <option v-for="k in targetKinds" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </label>
          <label class="text-xs text-[var(--c-text-2)]">
            表名前缀
            <input
              v-model="convert.tablePrefix"
              class="mt-1 block w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1 text-sm"
              :disabled="convert.locked"
              placeholder="可选"
            />
          </label>
          <label class="text-xs text-[var(--c-text-2)]">
            输出目录
            <div class="mt-1 flex gap-1">
              <input
                :value="convert.outputDir"
                class="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1 text-sm"
                disabled
                placeholder="未选择"
              />
              <button
                class="rounded border border-[var(--c-border-strong)] px-2 text-xs hover:bg-[var(--c-surface-2)]"
                :disabled="convert.locked"
                @click="onChooseOutputDir"
              >
                选择
              </button>
            </div>
          </label>
          <label v-if="showCsvProtection" class="flex items-end gap-1 pb-1 text-xs text-[var(--c-text-2)]">
            <input v-model="convert.csvFormulaProtection" type="checkbox" :disabled="convert.locked" />
            公式注入防护（= + - @ 前缀加 '）
          </label>
        </div>
      </div>

      <!-- 操作 -->
      <div class="flex items-center gap-2">
        <button
          class="rounded bg-[var(--c-primary)] px-4 py-2 text-sm hover:bg-[var(--c-primary-hover)] disabled:opacity-50"
          :disabled="convert.locked || task.isPageBusy('convert')"
          @click="onPreviewExport"
        >
          预览并导出
        </button>
        <span v-if="convert.locked" class="text-xs text-[var(--c-warn)]">导出进行中，配置已锁定</span>
      </div>
    </template>
  </div>
</template>
