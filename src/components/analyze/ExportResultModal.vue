<script setup lang="ts">
import { computed, ref } from 'vue'
import { useFeedbackStore } from '@/store/feedback'
import { useAnalyzeStore } from '@/store/analyze'
import { analyzeApi } from '@/api/analyze'

// 查询结果导出预览模态：展示列、前 50 行样本与目标格式选项；确认后先弹保存对话框选输出路径，
// 再由主进程流式导出完整结果（不经过前端结果集）。

const props = defineProps<{ dialogId: number; sql: string }>()
const feedback = useFeedbackStore()
const analyze = useAnalyzeStore()

const targetKind = ref<'csv' | 'json' | 'sql'>('csv')
const exporting = ref(false)
const exportError = ref('')

const sampleRows = computed(() => (analyze.result?.rows ?? []).slice(0, 50))
const columns = computed(() => analyze.result?.columns ?? [])
const totalRows = computed(() => analyze.result?.rowCount ?? 0)

const formatLabel: Record<string, string> = {
  csv: 'CSV（逗号分隔，UTF-8 BOM，公式注入防护）',
  json: 'JSON（对象数组）',
  sql: 'SQL（建表 + INSERT 脚本）'
}

async function doExport(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  exportError.value = ''
  try {
    const chosen = await analyzeApi.chooseExportFile()
    if (!chosen.ok) {
      exportError.value = chosen.error.message
      return
    }
    if (!chosen.value.path) return // 用户取消保存对话框
    const res = await analyzeApi.exportResult({
      sessionId: analyze.sessionId,
      sql: props.sql,
      targetKind: targetKind.value,
      outputPath: chosen.value.path
    })
    if (!res.ok) {
      exportError.value = res.error.message
      return
    }
    feedback.closeDialog(props.dialogId, true)
    feedback.success(`已导出 ${res.value.rowCount} 行（${res.value.elapsedMs}ms）`)
    void analyzeApi.showInFolder(chosen.value.path)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="w-[640px] max-w-[90vw]">
    <p class="mb-3 text-sm text-[var(--c-text-2)]">
      将导出当前查询的完整结果（{{ totalRows }} 行 × {{ columns.length }} 列），导出走主进程流式，不经过前端结果集。
    </p>

    <div class="mb-3">
      <div class="mb-1 text-xs text-[var(--c-text-2)]">目标格式</div>
      <div class="flex gap-2">
        <button
          v-for="k in (['csv', 'json', 'sql'] as const)"
          :key="k"
          class="rounded border px-3 py-1 text-xs transition-colors"
          :class="targetKind === k ? 'border-[var(--c-primary)] bg-[var(--c-primary)]/10 text-[var(--c-text)]' : 'border-[var(--c-border-strong)] text-[var(--c-text-2)] hover:text-[var(--c-text)]'"
          @click="targetKind = k"
        >
          {{ formatLabel[k] }}
        </button>
      </div>
    </div>

    <div class="mb-3 max-h-56 overflow-auto rounded border border-[var(--c-border-strong)]">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-[var(--c-surface-2)]">
          <tr>
            <th v-for="c in columns" :key="c" class="border-b border-[var(--c-border-strong)] px-2 py-1 text-left text-[var(--c-text-2)]">
              {{ c }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in sampleRows" :key="ri" class="border-b border-[var(--c-border-strong)]">
            <td v-for="(v, ci) in row" :key="ci" class="max-w-40 truncate px-2 py-0.5 text-[var(--c-text-2)]">
              {{ v ?? 'NULL' }}
            </td>
          </tr>
          <tr v-if="sampleRows.length === 0">
            <td :colspan="columns.length" class="px-2 py-2 text-center text-[var(--c-text-2)]">无数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="exportError" class="mb-2 text-xs text-[var(--c-danger)]">{{ exportError }}</p>

    <div class="flex justify-end gap-2">
      <button class="rounded border border-[var(--c-border-strong)] px-3 py-1 text-sm text-[var(--c-text-2)] hover:bg-[var(--c-surface-2)]" @click="feedback.closeDialog(props.dialogId, false)">
        取消
      </button>
      <button
        class="rounded bg-[var(--c-primary)] px-3 py-1 text-sm text-[var(--c-on-primary)] hover:bg-[var(--c-primary-hover)] disabled:opacity-50"
        :disabled="exporting || totalRows === 0"
        @click="doExport"
      >
        {{ exporting ? '导出中…' : '选择保存位置并导出' }}
      </button>
    </div>
  </div>
</template>
