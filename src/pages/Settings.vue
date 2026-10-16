<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppPreferences, PathInfo, PythonRuntimeInfo } from '@shared/ipc-types'
import { useFeedbackStore } from '@/store/feedback'
import { applyFontScale } from '@/theme'
import { t } from '@/i18n'

const feedback = useFeedbackStore()
const prefs = ref<AppPreferences | null>(null)
const paths = ref<PathInfo | null>(null)
const pythonRuntime = ref<PythonRuntimeInfo | null>(null)
const pythonBusy = ref(false)

const themeOptions: { value: AppPreferences['theme']; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '随操作系统亮暗自动切换' },
  { value: 'light', label: '亮色', hint: '始终使用浅色外观' },
  { value: 'dark', label: '暗色', hint: '始终使用深色外观' }
]

async function onFontSizeChange(e: Event): Promise<void> {
  const v = Number((e.target as HTMLInputElement).value)
  // 字号由设置页直接在前端即时应用（主进程不推送字号变化事件），再持久化到偏好
  applyFontScale(v)
  await setPref({ fontSize: v })
}

const shortcutLabels: Record<string, string> = {
  runQuery: '执行查询',
  runSelected: '执行选中 SQL',
  formatSql: '格式化 SQL',
  exportResult: '导出当前结果',
  openFile: '打开文件',
  openSettings: '打开系统设置',
  cancel: '取消弹窗 / 取消任务'
}

onMounted(async () => {
  const [prefsRes, pathsRes] = await Promise.all([
    window.gigacenter.invoke<AppPreferences>('settings:get'),
    window.gigacenter.invoke<PathInfo>('app:get-paths')
  ])
  if (prefsRes.ok) prefs.value = prefsRes.value
  if (pathsRes.ok) paths.value = pathsRes.value
  await refreshPythonRuntime()
})

async function refreshPythonRuntime(): Promise<void> {
  const res = await window.gigacenter.invoke<PythonRuntimeInfo>('python:get-runtime-info')
  if (res.ok) pythonRuntime.value = res.value
}

async function onInitPythonRuntime(): Promise<void> {
  pythonBusy.value = true
  const res = await window.gigacenter.invoke<PythonRuntimeInfo>('python:init-runtime')
  pythonBusy.value = false
  if (res.ok) {
    pythonRuntime.value = res.value
    feedback.success('Python 运行时已初始化，离线可用')
  } else {
    feedback.errorToast(res.error.message)
  }
}

async function onUninstallPythonRuntime(): Promise<void> {
  const ok = await feedback.confirm({
    title: '卸载 Python 运行时',
    message: '将删除内置 Python 运行时及其已装库（约 200-300MB）。Python 分析功能将不可用，可随时重新初始化。确认继续？'
  })
  if (!ok) return
  pythonBusy.value = true
  const res = await window.gigacenter.invoke('python:uninstall-runtime')
  pythonBusy.value = false
  if (res.ok) {
    pythonRuntime.value = null
    feedback.success('Python 运行时已删除')
  } else {
    feedback.errorToast(res.error.message)
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    feedback.success(t('settings.copied'))
  } catch {
    feedback.errorToast('复制失败')
  }
}

async function openFolder(path: string): Promise<void> {
  const res = await window.gigacenter.invoke('app:open-folder', path)
  if (!res.ok) feedback.errorToast(res.error.message)
}

async function setPref(patch: Partial<AppPreferences>): Promise<void> {
  const res = await window.gigacenter.invoke<AppPreferences>('settings:set-preferences', patch)
  if (res.ok) prefs.value = res.value
  else feedback.errorToast(res.error.message)
}

async function onClearPreferences(): Promise<void> {
  const ok = await feedback.confirm({
    title: t('settings.clearPreferences'),
    message: t('settings.clearPreferencesConfirm')
  })
  if (!ok) return
  const res = await window.gigacenter.invoke('settings:clear-preferences')
  if (res.ok) {
    feedback.success('偏好已清除')
    prefs.value = null
  } else {
    feedback.errorToast(res.error.message)
  }
}

async function onShortcutChange(key: string, value: string): Promise<void> {
  // 输入框清空时回落到该动作的默认快捷键（默认值即 key 本身）
  const shortcuts = { ...(prefs.value?.shortcuts ?? {}), [key]: value.trim() || key }
  await setPref({ shortcuts })
}

async function onExportDiagnostics(): Promise<void> {
  const res = await window.gigacenter.invoke<{ path: string }>('settings:export-diagnostics')
  if (res.ok) {
    feedback.success(`诊断包已生成：${res.value.path}`)
    const shown = await window.gigacenter.invoke('app:show-in-folder', res.value.path)
    if (!shown.ok) feedback.errorToast(shown.error.message)
  } else {
    feedback.errorToast(res.error.message)
  }
}

async function onOpenDevTools(): Promise<void> {
  await window.gigacenter.invoke('app:open-devtools')
}

async function onOpenExeFolder(): Promise<void> {
  await window.gigacenter.invoke('app:open-exe-folder')
}

// 卸载程序：强确认后调主进程清理用户数据并启动系统卸载器，应用随即退出
const uninstalling = ref(false)

async function onUninstall(): Promise<void> {
  const ok = await feedback.confirm({
    title: '卸载程序并清除数据',
    message: '将卸载 GigaCenter，并删除本机上的配置、日志与临时数据。此操作不可撤销，确认继续？'
  })
  if (!ok) return
  uninstalling.value = true
  const res = await window.gigacenter.invoke('settings:uninstall-app')
  if (!res.ok) {
    uninstalling.value = false
    feedback.errorToast(res.error.message)
    return
  }
  // 主进程已启动卸载流程，应用将自动退出
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <div class="p-4">
    <div class="text-sm font-semibold">{{ $t('settings.title') }}</div>

    <!-- 路径与实例信息 -->
    <div v-if="paths" class="mt-4 space-y-2 text-sm">
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <span class="shrink-0 text-[var(--c-text-2)]">{{ $t('settings.configDir') }}</span>
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[var(--c-text)]">{{ paths.configDir }}</span>
          <button class="shrink-0 text-xs text-[var(--c-primary)] hover:underline" @click="openFolder(paths.configDir)">
            {{ $t('settings.openDir') }}
          </button>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <span class="shrink-0 text-[var(--c-text-2)]">{{ $t('settings.logDir') }}</span>
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[var(--c-text)]">{{ paths.logDir }}</span>
          <button class="shrink-0 text-xs text-[var(--c-primary)] hover:underline" @click="openFolder(paths.logDir)">
            {{ $t('settings.openDir') }}
          </button>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <span class="shrink-0 text-[var(--c-text-2)]">{{ $t('settings.tempRoot') }}</span>
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[var(--c-text)]">{{ paths.tempRoot }}</span>
          <button class="shrink-0 text-xs text-[var(--c-primary)] hover:underline" @click="openFolder(paths.tempRoot)">
            {{ $t('settings.openDir') }}
          </button>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <span class="shrink-0 text-[var(--c-text-2)]">{{ $t('settings.sessionTempUsed') }}</span>
        <span class="text-[var(--c-text)]">{{ formatBytes(paths.sessionTempUsedBytes) }}</span>
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <div>
          <div class="text-[var(--c-text-2)]">{{ $t('settings.instanceId') }}</div>
          <div class="text-xs text-[var(--c-text-3)]">{{ $t('settings.instanceIdHint') }}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-[var(--c-text)]">{{ paths.instanceId }}</span>
          <button class="text-xs text-[var(--c-primary)] hover:underline" @click="copyText(paths.instanceId)">
            {{ $t('settings.copy') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 外观：主题（亮/暗/跟随系统）与界面字号 -->
    <div v-if="prefs" class="mt-4 space-y-2 text-sm">
      <div class="rounded bg-[var(--c-surface)] px-3 py-2">
        <div class="mb-2">主题外观</div>
        <div class="flex gap-2">
          <button
            v-for="opt in themeOptions"
            :key="opt.value"
            class="flex-1 rounded border px-2 py-1.5 text-xs"
            :class="prefs.theme === opt.value
              ? 'border-[var(--c-primary)] bg-[var(--c-primary-soft)] text-[var(--c-text)]'
              : 'border-[var(--c-border-strong)] hover:bg-[var(--c-surface-2)]'"
            @click="setPref({ theme: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="mt-1 text-xs text-[var(--c-text-3)]">
          {{ themeOptions.find((o) => o.value === prefs?.theme)?.hint }}
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <div>
          <div>界面字号</div>
          <div class="text-xs text-[var(--c-text-3)]">全局文字与控件尺寸，即时生效</div>
        </div>
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="12"
            max="18"
            step="1"
            class="w-36 accent-[var(--c-primary)]"
            :value="prefs.fontSize"
            @input="onFontSizeChange"
          />
          <span class="w-10 text-xs text-[var(--c-text-2)]">{{ prefs.fontSize }}px</span>
        </div>
      </div>
    </div>

    <!-- 行为设置 -->
    <div v-if="prefs" class="mt-4 space-y-2 text-sm">
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <div>
          <div>{{ $t('settings.allowModifyTempDb') }}</div>
          <div class="text-xs text-[var(--c-text-3)]">{{ $t('settings.allowModifyTempDbHint') }}</div>
        </div>
        <input
          type="checkbox"
          class="h-4 w-4 accent-[var(--c-primary)]"
          :checked="prefs.allowModifyTempDb"
          @change="setPref({ allowModifyTempDb: ($event.target as HTMLInputElement).checked })"
        />
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <div>
          <div>启用长路径支持</div>
          <div class="text-xs text-[var(--c-text-3)]">路径超 260 字符时使用 \\?\ 前缀（默认关，改动即时生效）</div>
        </div>
        <input
          type="checkbox"
          class="h-4 w-4 accent-[var(--c-primary)]"
          :checked="prefs.longPathSupport"
          @change="setPref({ longPathSupport: ($event.target as HTMLInputElement).checked })"
        />
      </div>
      <div class="flex items-center justify-between gap-4 rounded bg-[var(--c-surface)] px-3 py-2">
        <div>
          <div>系统通知</div>
          <div class="text-xs text-[var(--c-text-3)]">仅长任务完成/失败时通知，应用内提示不受影响</div>
        </div>
        <input
          type="checkbox"
          class="h-4 w-4 accent-[var(--c-primary)]"
          :checked="prefs.notificationsEnabled"
          @change="setPref({ notificationsEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </div>

      <!-- 快捷键配置 -->
      <div class="mt-4">
        <div class="mb-1 text-sm font-semibold">快捷键配置</div>
        <div class="overflow-hidden rounded bg-[var(--c-surface)]">
          <div v-for="(label, key) in shortcutLabels" :key="key" class="flex items-center justify-between border-b border-[var(--c-border)] px-3 py-1.5 last:border-b-0">
            <span class="text-sm text-[var(--c-text)]">{{ label }}</span>
            <input
              class="w-44 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1 text-xs text-[var(--c-text)]"
              :value="prefs.shortcuts[key] ?? ''"
              placeholder="如 Ctrl+Enter"
              @change="onShortcutChange(key, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="px-3 py-1.5 text-xs text-[var(--c-text-3)]">
            编辑后立即保存；CodeMirror 编辑器内 Ctrl+Enter 执行、Ctrl+Shift+Enter 执行选中、Ctrl+Shift+F 格式化已内置生效。
          </div>
        </div>
      </div>

      <!-- 诊断包 -->
      <div class="mt-4 flex items-center gap-3">
        <button
          class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-1.5 text-sm text-[var(--c-text)] hover:bg-[var(--c-surface-2)]"
          @click="onExportDiagnostics"
        >
          导出诊断包
        </button>
        <span class="text-xs text-[var(--c-text-3)]">脱敏信息：版本、系统、实例 ID、最近日志；不含原始数据与 SQL 全文</span>
      </div>

      <!-- 开发者工具 -->
      <div class="mt-4 flex items-center gap-3">
        <button
          class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-1.5 text-sm text-[var(--c-text)] hover:bg-[var(--c-surface-2)]"
          @click="onOpenDevTools"
        >
          打开控制台
        </button>
        <button
          class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-1.5 text-sm text-[var(--c-text)] hover:bg-[var(--c-surface-2)]"
          @click="onOpenExeFolder"
        >
          打开程序所在目录
        </button>
        <span class="text-xs text-[var(--c-text-3)]">控制台在独立窗口打开，诊断模式调试用</span>
      </div>
    </div>

    <!-- 清除按钮（互不影响，各自独立生效） -->
    <div class="mt-4 flex gap-2">
      <button
        class="rounded border border-[var(--c-danger-soft)] bg-[var(--c-danger-soft)] px-3 py-1.5 text-sm text-[var(--c-danger)] hover:bg-[var(--c-danger-soft)]"
        @click="onClearPreferences"
      >
        {{ $t('settings.clearPreferences') }}
      </button>
    </div>

    <!-- Python 运行时 -->
    <div class="mt-4 rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] p-3 text-sm">
      <div class="mb-2 font-semibold">Python 运行时</div>
      <div v-if="pythonBusy" class="text-xs text-[var(--c-text-2)]">处理中…</div>
      <template v-else-if="pythonRuntime && pythonRuntime.status === 'ready'">
        <div class="space-y-1 text-xs text-[var(--c-text-2)]">
          <div class="flex justify-between gap-4">
            <span>来源</span>
            <span class="text-[var(--c-text)]">{{ pythonRuntime.source === 'bundled' ? '内置（随程序捆绑，离线可用）' : '开发回退' }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span>版本</span>
            <span class="font-mono text-[var(--c-text)]">{{ pythonRuntime.version || '未知' }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span>已装库</span>
            <span class="text-[var(--c-text)]">{{ pythonRuntime.libraries.length > 0 ? pythonRuntime.libraries.join('、') : '（未检测到）' }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span>位置</span>
            <span class="truncate text-[var(--c-text)]">{{ pythonRuntime.pythonPath }}</span>
          </div>
        </div>
      </template>
      <div v-else class="text-xs text-[var(--c-text-2)]">
        未初始化。内置 Python 随安装包捆绑，首次使用需初始化一次（本地复制，离线可用）。
      </div>
      <div class="mt-2 flex gap-2">
        <button
          class="rounded border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-3 py-1.5 text-xs hover:bg-[var(--c-surface-2)] disabled:opacity-50"
          :disabled="pythonBusy"
          @click="onInitPythonRuntime"
        >
          {{ pythonRuntime?.status === 'ready' ? '重新初始化' : '初始化运行时' }}
        </button>
        <button
          v-if="pythonRuntime?.status === 'ready'"
          class="rounded border border-[var(--c-danger-soft)] bg-[var(--c-surface)] px-3 py-1.5 text-xs text-[var(--c-danger)] hover:bg-[var(--c-danger-soft)] disabled:opacity-50"
          :disabled="pythonBusy"
          @click="onUninstallPythonRuntime"
        >
          卸载运行时
        </button>
      </div>
    </div>

    <!-- 危险操作：卸载程序并清除本机数据 -->
    <div class="mt-4 rounded border border-[var(--c-danger)] bg-[var(--c-danger-soft)] p-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-sm font-semibold text-[var(--c-danger)]">卸载程序</div>
          <div class="mt-0.5 text-xs text-[var(--c-danger)]">
            卸载 GigaCenter，并一并删除本机配置、日志与临时数据（不可撤销）
          </div>
        </div>
        <button
          class="shrink-0 rounded bg-[var(--c-danger)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          :disabled="uninstalling"
          @click="onUninstall"
        >
          {{ uninstalling ? '正在卸载…' : '卸载程序并清除数据' }}
        </button>
      </div>
    </div>
  </div>
</template>
