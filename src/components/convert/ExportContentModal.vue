<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ExportPreviewContentResult, Result } from '@shared/ipc-types'

/** 导出内容弹窗：展示某张工作表导出的前 N 条示例文本（SQL/CSV/NDJSON），内容由父级通过 props.load 异步拉取。 */

const props = defineProps<{
  load: () => Promise<Result<ExportPreviewContentResult>>
}>()

const loading = ref(true)
const content = ref('')
const error = ref('')
const totalRows = ref(0)
const maxRows = ref(0)
const copied = ref(false)

// 弹窗挂载后异步拉取该工作表的导出预览：成功则填充文本与总行数，失败则记录错误信息。
onMounted(async () => {
  const r = await props.load()
  loading.value = false
  if (r.ok) {
    content.value = r.value.content
    totalRows.value = r.value.totalRows
    maxRows.value = r.value.maxRows
  } else {
    error.value = r.error.message
  }
})

async function onCopy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(content.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    /* 剪贴板 API 不可用（如非安全上下文）时静默失败，不弹错误提示 */
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="loading" class="py-6 text-center text-xs text-[var(--c-text-2)]">正在生成导出内容…</div>
    <div v-else-if="error" class="py-6 text-center text-xs text-[var(--c-danger)]">{{ error }}</div>
    <template v-else>
      <div class="flex items-center justify-between text-xs text-[var(--c-text-2)]">
        <span>显示前 {{ maxRows }} 条示例（表共 {{ totalRows }} 行）</span>
        <button
          class="rounded border border-[var(--c-border-strong)] px-2 py-0.5 text-xs hover:bg-[var(--c-surface-2)]"
          @click="onCopy"
        >
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>
      <pre class="max-h-80 overflow-auto whitespace-pre rounded border border-[var(--c-border)] bg-[var(--c-bg)] p-3 font-mono text-xs text-[var(--c-text)]">{{ content }}</pre>
    </template>
  </div>
</template>
