<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppPreferences } from '@shared/ipc-types'

// 快捷键在首页表格中的展示顺序；中文名通过 $t('home.sc.xxx') 取 i18n 词条。
const SHORTCUT_ORDER = ['runQuery', 'runSelected', 'formatSql', 'exportResult', 'openFile', 'openSettings', 'cancel'] as const

const shortcuts = ref<Record<string, string>>({})

onMounted(async () => {
  const res = await window.gigacenter.invoke<AppPreferences>('settings:get')
  if (res.ok) shortcuts.value = res.value.shortcuts ?? {}
})
</script>

<template>
  <div class="mx-auto min-h-full max-w-3xl px-6 py-8">
    <!-- Hero -->
    <div class="flex flex-col items-center pb-8 text-center">
      <img src="@/assets/logo/logo.png" alt="logo" class="h-16 w-16 object-contain" />
      <h1 class="mt-4 text-2xl font-bold">{{ $t('app.title') }}</h1>
      <p class="mt-2 text-sm text-[var(--c-text-2)]">{{ $t('home.tagline') }}</p>
      <p class="mt-1 text-xs text-[var(--c-text-3)]">{{ $t('home.version') }} v0.1.0</p>
    </div>

    <!-- 产品介绍 -->
    <section class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5">
      <h2 class="mb-3 text-base font-semibold">{{ $t('home.intro.title') }}</h2>
      <ul class="space-y-2 text-sm">
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-primary)]"></span>
          <span>{{ $t('home.intro.1') }}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-primary)]"></span>
          <span>{{ $t('home.intro.2') }}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-primary)]"></span>
          <span>{{ $t('home.intro.3') }}</span>
        </li>
      </ul>
    </section>

    <!-- 核心功能 -->
    <section class="mt-4">
      <h2 class="mb-3 text-base font-semibold">{{ $t('home.features.title') }}</h2>
      <div class="grid grid-cols-2 gap-4">
        <router-link
          to="/convert"
          class="block rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5 transition-colors hover:border-[var(--c-primary)]"
        >
          <h3 class="font-semibold text-[var(--c-primary)]">{{ $t('home.features.convert') }}</h3>
          <p class="mt-2 text-sm text-[var(--c-text-2)]">{{ $t('home.features.convertDesc') }}</p>
        </router-link>
        <router-link
          to="/analyze"
          class="block rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5 transition-colors hover:border-[var(--c-primary)]"
        >
          <h3 class="font-semibold text-[var(--c-primary)]">{{ $t('home.features.analyze') }}</h3>
          <p class="mt-2 text-sm text-[var(--c-text-2)]">{{ $t('home.features.analyzeDesc') }}</p>
        </router-link>
      </div>
    </section>

    <!-- 使用流程 -->
    <section class="mt-4">
      <h2 class="mb-3 text-base font-semibold">{{ $t('home.flow.title') }}</h2>
      <div class="grid grid-cols-2 gap-4">
        <div class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5">
          <h3 class="mb-3 font-semibold">{{ $t('home.flow.convert') }}</h3>
          <ol class="space-y-2 text-sm">
            <li v-for="n in 4" :key="n" class="flex items-start gap-3">
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--c-primary-soft)] text-xs text-[var(--c-primary)]"
              >
                {{ n }}
              </span>
              <span>{{ $t(`home.flow.convert.${n}`) }}</span>
            </li>
          </ol>
        </div>
        <div class="rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5">
          <h3 class="mb-3 font-semibold">{{ $t('home.flow.analyze') }}</h3>
          <ol class="space-y-2 text-sm">
            <li v-for="n in 4" :key="n" class="flex items-start gap-3">
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--c-primary-soft)] text-xs text-[var(--c-primary)]"
              >
                {{ n }}
              </span>
              <span>{{ $t(`home.flow.analyze.${n}`) }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- 快捷键 -->
    <section class="mt-4">
      <div class="mb-3 flex items-baseline gap-2">
        <h2 class="text-base font-semibold">{{ $t('home.shortcuts.title') }}</h2>
        <span class="text-xs text-[var(--c-text-3)]">{{ $t('home.shortcuts.hint') }}</span>
      </div>
      <div class="overflow-hidden rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)]">
        <table class="w-full text-sm">
          <tbody>
            <tr v-for="(key, idx) in SHORTCUT_ORDER" :key="key" :class="idx % 2 === 0 ? 'bg-[var(--c-surface)]' : 'bg-[var(--c-surface-2)]'">
              <td class="px-4 py-2 text-[var(--c-text-2)]">{{ $t(`home.sc.${key}`) }}</td>
              <td class="w-40 px-4 py-2 font-mono text-[var(--c-text)]">{{ shortcuts[key] ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 数据安全 -->
    <section class="mt-4 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-5">
      <h2 class="mb-3 text-base font-semibold">{{ $t('home.safety.title') }}</h2>
      <ul class="space-y-2 text-sm">
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-success)]"></span>
          <span>{{ $t('home.safety.1') }}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-success)]"></span>
          <span>{{ $t('home.safety.2') }}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-success)]"></span>
          <span>{{ $t('home.safety.3') }}</span>
        </li>
      </ul>
    </section>

    <!-- 底部引导 -->
    <div class="mt-6 flex flex-col items-center gap-2 pb-4">
      <router-link
        to="/convert"
        class="rounded bg-[var(--c-primary)] px-5 py-2 text-sm font-medium text-[var(--c-on-primary)] transition-colors hover:bg-[var(--c-primary-hover)]"
      >
        {{ $t('home.start') }}
      </router-link>
      <p class="text-xs text-[var(--c-text-3)]">{{ $t('home.settingsHint') }}</p>
    </div>
  </div>
</template>
