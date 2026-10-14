<script setup lang="ts">
import { useFeedbackStore } from '@/store/feedback'

const feedback = useFeedbackStore()
</script>

<template>
  <!-- 页面内顶部常驻提示条，每个页面最多 1 个 -->
  <div
    v-for="banner in feedback.banners"
    :key="banner.id"
    class="flex items-center justify-between gap-2 px-4 py-2 text-sm"
    :class="{
      'bg-[var(--c-accent-soft)] text-[var(--c-accent)]': banner.kind === 'info',
      'bg-[var(--c-warn-soft)] text-[var(--c-warn)]': banner.kind === 'warning',
      'bg-[var(--c-danger-soft)] text-[var(--c-danger)]': banner.kind === 'error'
    }"
  >
    <span>{{ banner.message }}</span>
    <button class="text-xs opacity-70 hover:opacity-100" @click="feedback.dismissBanner(banner.id)">✕</button>
  </div>
</template>
