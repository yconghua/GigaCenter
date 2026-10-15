<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'

// 查询结果表格：虚拟滚动渲染全量结果集（横向+竖向滚动），表头 sticky 固定在顶部；
// 支持点击表头排序、单元格/全部可见行复制、列宽拖拽与列显隐。

const props = defineProps<{
  columns: string[]
  rows: (string | null)[][]
  truncated?: boolean
}>()

const emit = defineEmits<{ (e: 'copy-cell', value: string | null): void }>()

const containerRef = ref<HTMLDivElement | null>(null)
const sortCol = ref<number>(-1)
const sortDir = ref<'asc' | 'desc'>('asc')
const colWidths = ref<Record<number, number>>({})
const hiddenCols = ref<Set<number>>(new Set())

const ROW_H = 32
// 前端内存排序：按列值字符串比较，不改动原始 props.rows；未选排序列时原样返回
const sortedRows = computed<(string | null)[][]>(() => {
  if (sortCol.value < 0 || sortCol.value >= props.columns.length) return props.rows
  const ci = sortCol.value
  return [...props.rows].sort((a, b) => {
    const va = a[ci] ?? ''
    const vb = b[ci] ?? ''
    const cmp = va < vb ? -1 : va > vb ? 1 : 0
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})
const virtualizer = useVirtualizer({
  count: sortedRows.value.length,
  getScrollElement: () => containerRef.value,
  estimateSize: () => ROW_H,
  overscan: 12
})

function toggleSort(ci: number): void {
  if (sortCol.value === ci) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortCol.value = ci
    sortDir.value = 'asc'
  }
}

/** 列样式：拖拽自定义过宽度的列固定宽度，其余列弹性自适应 */
function colStyle(ci: number): Record<string, string> {
  const w = colWidths.value[ci]
  return w !== undefined
    ? { minWidth: `${w}px`, maxWidth: `${w}px` }
    : { minWidth: '120px', maxWidth: '240px' }
}

/** 拖拽表头右缘把手调列宽：mousemove 期间实时写入宽度（限 60~600px），mouseup 时注销监听并恢复文本选择。 */
function startColResize(ci: number, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const cell = (e.currentTarget as HTMLElement).parentElement
  if (!cell) return
  const startX = e.clientX
  const startWidth = cell.offsetWidth
  const onMove = (ev: MouseEvent): void => {
    colWidths.value = { ...colWidths.value, [ci]: Math.min(600, Math.max(60, startWidth + (ev.clientX - startX))) }
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

function copyCell(v: string | null): void {
  emit('copy-cell', v)
}

async function copyVisibleAll(): Promise<void> {
  const text = sortedRows.value.map((r) => r.map((v) => v ?? '').join(',')).join('\n')
  await navigator.clipboard.writeText(text)
}

function toggleCol(ci: number): void {
  const next = new Set(hiddenCols.value)
  if (next.has(ci)) next.delete(ci)
  else next.add(ci)
  hiddenCols.value = next
}

// 行数变化时通知虚拟器重测总高度，避免残留旧滚动位置
watch(
  () => props.rows.length,
  () => virtualizer.value?.measure()
)

function sortIndicator(ci: number): string {
  if (sortCol.value !== ci) return '⇅'
  return sortDir.value === 'asc' ? '↑' : '↓'
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部工具条 -->
    <div class="flex flex-wrap items-center gap-2 border-b border-[var(--c-border-strong)] px-2 py-1 text-xs text-[var(--c-text-2)]">
      <span>{{ sortedRows.length }} 行{{ props.truncated ? '（已截断）' : '' }}</span>
      <span v-if="hiddenCols.size > 0">{{ hiddenCols.size }} 列已隐藏</span>
      <span class="ml-auto text-[var(--c-text-2)]">双击单元格复制 · 点击表头排序 · 拖列边调宽</span>
      <button
        class="rounded bg-[var(--c-surface-2)] px-2 py-0.5 hover:bg-[var(--c-surface-2)]"
        title="复制全部可见行（CSV 格式）"
        @click="copyVisibleAll"
      >
        复制全部
      </button>
    </div>

    <!-- 数据滚动区：全量数据，横向+竖向滚动；表头 sticky 在顶部，横向随数据滚动 -->
    <div class="flex min-h-0 flex-1">
      <div ref="containerRef" class="min-w-0 flex-1 overflow-auto">
        <div class="sticky top-0 z-10 flex border-b border-[var(--c-border-strong)] bg-[var(--c-surface-2)]">
          <div
            v-for="(col, ci) in columns"
            v-show="!hiddenCols.has(ci)"
            :key="`h${ci}`"
            class="relative flex min-w-0 flex-1 cursor-pointer select-none items-center gap-1 overflow-hidden whitespace-nowrap border-r border-[var(--c-border-strong)] px-2 py-1 text-xs font-medium text-[var(--c-text)] hover:bg-[var(--c-surface-2)]"
            :style="colStyle(ci)"
            :title="`按 ${col} 排序`"
            @click="toggleSort(ci)"
          >
            <span class="truncate">{{ col }}</span>
            <span class="shrink-0 text-[10px] text-[var(--c-text-2)]">{{ sortIndicator(ci) }}</span>
            <span
              class="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-[var(--c-primary)]/40"
              title="拖动调整列宽"
              @mousedown="startColResize(ci, $event)"
              @click.stop
            />
          </div>
        </div>
        <div class="relative" :style="{ height: `${virtualizer.getTotalSize()}px` }">
          <div
            v-for="item in virtualizer.getVirtualItems()"
            :key="String(item.key)"
            class="absolute left-0 right-0 flex border-b border-[var(--c-border-strong)]"
            :style="{ top: `${item.start}px`, height: `${item.size}px` }"
          >
            <div
              v-for="(_, ci) in columns"
              v-show="!hiddenCols.has(ci)"
              :key="ci"
              class="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap border-r border-[var(--c-border-strong)] px-2 text-xs text-[var(--c-text)]"
              :style="colStyle(ci)"
              @dblclick="copyCell(sortedRows[item.index][ci])"
            >
              {{ sortedRows[item.index][ci] ?? 'NULL' }}
            </div>
          </div>
        </div>
      </div>
      <div v-if="hiddenCols.size > 0" class="flex flex-col overflow-auto border-l border-[var(--c-border-strong)]" style="max-width: 140px">
        <button
          v-for="(_, ci) in columns"
          :key="ci"
          class="px-2 py-0.5 text-left text-[11px] text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)]"
          @click="toggleCol(ci)"
        >
          {{ hiddenCols.has(ci) ? '☐' : '☑' }} {{ columns[ci] }}
        </button>
      </div>
    </div>
  </div>
</template>
