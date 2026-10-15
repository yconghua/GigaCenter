<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFeedbackStore } from '@/store/feedback'

const feedback = useFeedbackStore()
const expanded = ref(false)

// 同一时刻只显示最上层一个模态，其余排队
const top = computed(() => feedback.dialogs[feedback.dialogs.length - 1] ?? null)

function onPrimary(): void {
  if (!top.value) return
  feedback.closeDialog(top.value.id, true)
}

function onSecondary(): void {
  if (!top.value) return
  feedback.closeDialog(top.value.id, false)
}

function onKeydown(e: KeyboardEvent): void {
  if (!top.value) return
  if (e.key === 'Escape') {
    // 确认框 Esc 取消；错误框 Esc 关闭
    e.preventDefault()
    onSecondary()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    onPrimary()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="top" class="fixed inset-0 z-40 flex items-center justify-center bg-[var(--c-text)]/50 p-4">
      <div
        class="w-full overflow-hidden rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4 shadow-xl"
        :class="top.kind === 'modal' ? (top.width ?? 'max-w-2xl') : 'max-w-md'"
      >
        <template v-if="top.kind === 'modal' && top.component">
          <div class="mb-3 flex items-center justify-between">
            <div class="text-sm font-semibold">{{ top.title }}</div>
            <button class="text-xs text-[var(--c-text-2)] hover:text-[var(--c-text)]" @click="onSecondary">关闭</button>
          </div>
          <component :is="top.component" v-bind="top.componentProps ?? {}" />
        </template>
        <template v-else>
        <div class="text-sm font-semibold">{{ top.title }}</div>
        <div class="mt-2 text-sm text-[var(--c-text)]">{{ top.message }}</div>

        <!-- 错误框：诊断详情折叠区 + 复制 -->
        <div v-if="top.kind === 'error'" class="mt-2">
          <button
            class="text-xs text-[var(--c-text-2)] hover:text-[var(--c-text)]"
            @click="expanded = !expanded"
          >
            {{ expanded ? '收起诊断信息' : '展开诊断信息' }}
          </button>
          <pre
            v-if="expanded && (top.detail || top.errorCode)"
            class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-bg)] p-2 text-xs text-[var(--c-text-2)]"
          >{{ top.errorCode ? `错误码：${top.errorCode}\n` : '' }}{{ top.detail }}</pre>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <button
            v-if="top.kind === 'confirm' && top.secondaryLabel"
            class="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--c-surface-2)]"
            @click="onSecondary"
          >
            {{ top.secondaryLabel }}
          </button>
          <button
            class="rounded px-3 py-1.5 text-sm"
            :class="
              top.kind === 'error'
                ? 'bg-[var(--c-surface-2)] hover:bg-[var(--c-border-strong)]'
                : 'bg-[var(--c-primary)] hover:bg-[var(--c-primary-hover)]'
            "
            @click="onPrimary"
          >
            {{ top.primaryLabel }}
          </button>
        </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
