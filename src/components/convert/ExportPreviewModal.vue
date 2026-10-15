<script setup lang="ts">
import { ref } from 'vue'
import { convertApi } from '@/api/convert'
import { useFeedbackStore } from '@/store/feedback'
import type { ExportPreviewResult } from '@shared/ipc-types'
import ExportContentModal from './ExportContentModal.vue'

/** 导出预览模态：文件清单、表结构、一致性检查结果、目标文件冲突策略 */

const props = defineProps<{
  preview: ExportPreviewResult
  onConfirm: (conflictMode: 'overwrite' | 'rename') => void
  onClose: () => void
}>()

const feedback = useFeedbackStore()
const mode = ref<'overwrite' | 'rename'>('rename')

function showExportContent(sheetId: number): void {
  const taskId = props.preview.taskId
  feedback.pushModal({
    title: `导出内容（工作表 ${sheetId + 1}）`,
    component: ExportContentModal,
    componentProps: {
      load: () => convertApi.previewExportContent(taskId, sheetId)
    }
  })
}
</script>

<template>
  <div class="max-h-[70vh] overflow-auto text-sm">
    <!-- 一致性检查 -->
    <div v-if="props.preview.issues.length > 0" class="mb-3 rounded border border-[var(--c-border-strong)] p-2">
      <div class="mb-1 text-xs font-semibold text-[var(--c-text-2)]">导出前检查（{{ props.preview.issues.length }} 项）</div>
      <div
        v-for="(issue, i) in props.preview.issues"
        :key="i"
        class="py-0.5 text-xs"
        :class="issue.severity === 'error' ? 'text-[var(--c-danger)]' : 'text-[var(--c-warn)]'"
      >
        {{ issue.severity === 'error' ? '✕' : '⚠' }} {{ issue.message }}
      </div>
    </div>

    <!-- 文件清单 -->
    <div class="mb-3">
      <div class="mb-1 text-xs font-semibold text-[var(--c-text-2)]">将生成 {{ props.preview.files.length }} 个文件（目录：{{ props.preview.outputDir }}），点击行查看导出内容</div>
      <div class="overflow-auto rounded border border-[var(--c-border)]">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="bg-[var(--c-surface-2)] text-left text-[var(--c-text-2)]">
              <th class="border border-[var(--c-border)] px-2 py-1">文件名</th>
              <th class="border border-[var(--c-border)] px-2 py-1">工作表</th>
              <th class="border border-[var(--c-border)] px-2 py-1">表名</th>
              <th class="border border-[var(--c-border)] px-2 py-1">行数</th>
              <th class="border border-[var(--c-border)] px-2 py-1">列数</th>
              <th class="border border-[var(--c-border)] px-2 py-1">导出内容</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="f in props.preview.files"
              :key="f.sheetId"
              class="cursor-pointer odd:bg-[var(--c-bg)] hover:bg-[var(--c-surface-2)]"
              @click="showExportContent(f.sheetId)"
            >
              <td class="border border-[var(--c-border)] px-2 py-1">{{ f.fileName }}</td>
              <td class="border border-[var(--c-border)] px-2 py-1">{{ f.sheetName }}</td>
              <td class="border border-[var(--c-border)] px-2 py-1">{{ f.tableName }}</td>
              <td class="border border-[var(--c-border)] px-2 py-1">{{ f.rowCount }}</td>
              <td class="border border-[var(--c-border)] px-2 py-1">{{ f.colCount }}</td>
              <td class="border border-[var(--c-border)] px-2 py-1 text-[var(--c-accent)]">查看 →</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 冲突策略 -->
    <div class="mb-3 rounded border border-[var(--c-border-strong)] p-2 text-xs">
      <div class="mb-1 font-semibold text-[var(--c-text-2)]">目标文件已存在时</div>
      <label class="mr-4 inline-flex items-center gap-1">
        <input v-model="mode" type="radio" value="rename" />
        自动加序号
      </label>
      <label class="inline-flex items-center gap-1">
        <input v-model="mode" type="radio" value="overwrite" />
        覆盖现有文件
      </label>
    </div>

    <div class="flex justify-end gap-2">
      <button
        class="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--c-surface-2)]"
        @click="props.onClose"
      >
        返回修改
      </button>
      <button
        class="rounded bg-[var(--c-primary)] px-3 py-1.5 text-sm hover:bg-[var(--c-primary-hover)]"
        :disabled="props.preview.issues.some((i) => i.severity === 'error')"
        @click="props.onConfirm(mode)"
      >
        确认导出
      </button>
    </div>
  </div>
</template>
