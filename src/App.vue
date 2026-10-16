<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useTaskStore } from '@/store/task'
import { applyFontScale, applyTheme } from '@/theme'
import type { AppInfo, AppPreferences } from '@shared/ipc-types'
import ToastHost from '@/components/feedback/ToastHost.vue'
import DialogHost from '@/components/feedback/DialogHost.vue'
import BannerHost from '@/components/feedback/BannerHost.vue'

const route = useRoute()
const task = useTaskStore()

// 启动时应用持久化主题与字号设置；跟随系统档时，后续系统主题切换由主进程 nativeTheme 事件推送。
async function initTheme(): Promise<void> {
  const [infoRes, prefsRes] = await Promise.all([
    window.gigacenter.invoke<AppInfo>('app:get-app-info'),
    window.gigacenter.invoke<AppPreferences>('settings:get')
  ])
  if (infoRes.ok) applyTheme(infoRes.value.resolvedTheme)
  if (prefsRes.ok) applyFontScale(prefsRes.value.fontSize ?? 14)
  window.gigacenter.on('event:native-theme', (payload) => {
    const p = payload as { theme: 'light' | 'dark' } | null
    if (p && (p.theme === 'light' || p.theme === 'dark')) applyTheme(p.theme)
  })
}

onMounted(() => {
  void task.init()
  void initTheme()
})
</script>

<template>
  <div class="flex h-screen flex-col bg-[var(--c-bg)] text-[var(--c-text)]">
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4">
      <div class="flex items-center gap-3">
        <img src="@/assets/logo/logo.png" alt="logo" class="h-8 w-8 object-contain" />
        <span class="text-base font-semibold">{{ $t('app.title') }}</span>
      </div>
      <div class="text-sm text-[var(--c-text-2)]">v0.1.0</div>
    </header>
    <div class="flex min-h-0 flex-1">
      <nav class="w-44 shrink-0 border-r border-[var(--c-border-strong)] bg-[var(--c-surface)] p-2">
        <router-link
          to="/home"
          class="flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-[var(--c-surface-2)]"
          :class="route.path.startsWith('/home') ? 'font-medium text-[var(--c-primary)]' : 'text-[var(--c-text-2)]'"
        >
          <span class="h-4 w-1 shrink-0 rounded-full" :class="route.path.startsWith('/home') ? 'bg-[var(--c-primary)]' : 'bg-transparent'"></span>
          <span>{{ $t('nav.home') }}</span>
        </router-link>
        <router-link
          to="/convert"
          class="mt-1 flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-[var(--c-surface-2)]"
          :class="route.path.startsWith('/convert') ? 'font-medium text-[var(--c-primary)]' : 'text-[var(--c-text-2)]'"
        >
          <span class="h-4 w-1 shrink-0 rounded-full" :class="route.path.startsWith('/convert') ? 'bg-[var(--c-primary)]' : 'bg-transparent'"></span>
          <span>{{ $t('nav.convert') }}</span>
        </router-link>
        <router-link
          to="/analyze"
          class="mt-1 flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-[var(--c-surface-2)]"
          :class="route.path.startsWith('/analyze') ? 'font-medium text-[var(--c-primary)]' : 'text-[var(--c-text-2)]'"
        >
          <span class="h-4 w-1 shrink-0 rounded-full" :class="route.path.startsWith('/analyze') ? 'bg-[var(--c-primary)]' : 'bg-transparent'"></span>
          <span>{{ $t('nav.analyze') }}</span>
        </router-link>
        <router-link
          to="/settings"
          class="mt-1 flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-[var(--c-surface-2)]"
          :class="route.path === '/settings' ? 'font-medium text-[var(--c-primary)]' : 'text-[var(--c-text-2)]'"
        >
          <span class="h-4 w-1 shrink-0 rounded-full" :class="route.path === '/settings' ? 'bg-[var(--c-primary)]' : 'bg-transparent'"></span>
          <span>{{ $t('nav.settings') }}</span>
        </router-link>
      </nav>
      <main class="flex min-w-0 flex-1 flex-col overflow-auto">
        <BannerHost />
        <!-- min-h-0：约束路由容器高度，使 h-full 页面（数据分析等）填满可视区并内部滚动，不撑出最外层滚动条 -->
        <div class="min-h-0 min-w-0 flex-1">
          <router-view />
        </div>
      </main>
    </div>
    <ToastHost />
    <DialogHost />
  </div>
</template>
