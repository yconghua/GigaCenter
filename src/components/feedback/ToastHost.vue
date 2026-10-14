<script setup lang="ts">
import { useFeedbackStore } from '@/store/feedback'

const feedback = useFeedbackStore()
</script>

<template>
  <!-- Toast：右下角，最多 3 个；全部自动消失，手动 ✕ 仅保留为兜底（autoDismiss=false 时显示） -->
  <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
    <div
      v-for="toast in feedback.toasts"
      :key="toast.id"
      class="pointer-events-auto max-w-full rounded border px-3 py-2 text-sm shadow-lg"
      :class="{
        'border-[var(--c-border-strong)] bg-[var(--c-surface)]': toast.type === 'info',
        'border-[var(--c-success)] bg-[var(--c-success-soft)]': toast.type === 'success',
        'border-amber-300/60 bg-[var(--c-warn-soft)]': toast.type === 'warning',
        'border-[var(--c-danger-soft)] bg-[var(--c-danger-soft)]': toast.type === 'error'
      }"
    >
      <div class="flex items-start justify-between gap-2">
        <span class="min-w-0 break-words">{{ toast.message }}</span>
        <button
          v-if="!toast.autoDismiss"
          class="shrink-0 text-xs text-[var(--c-text-2)] hover:text-[var(--c-text)]"
          @click="feedback.dismissToast(toast.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>
