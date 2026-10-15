import { defineStore } from 'pinia'

// 自研弹窗体系：Toast / 横幅 / 确认框 / 错误框 / 业务模态，全部由 Vue 组件实现，
// 不调用浏览器 alert/confirm/prompt，不使用 Electron dialog 消息框。
// 优先级：模态 > 确认框 > 错误框 > 横幅 > Toast。
// 模态同一时刻只允许一个；Toast 最多 3 个。

export interface ToastItem {
  id: number
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  autoDismiss: boolean
}

export interface BannerItem {
  id: number
  kind: 'info' | 'warning' | 'error'
  message: string
}

export type DialogKind = 'confirm' | 'error' | 'modal'

export interface DialogItem {
  id: number
  kind: DialogKind
  title: string
  message: string
  primaryLabel: string
  secondaryLabel?: string
  /** 错误框：错误码与可折叠诊断详情 */
  errorCode?: string
  detail?: string
  canRetry?: boolean
  /** 确认框：用户点击后的回调（true=主按钮，false=次按钮） */
  onResult?: (ok: boolean) => void
  /** 业务模态：自定义内容组件 */
  component?: unknown
  componentProps?: Record<string, unknown>
  /** 业务模态宽度（Tailwind 宽度类），缺省 max-w-2xl */
  width?: string
}

let nextId = 1

export const useFeedbackStore = defineStore('feedback', {
  state: () => ({
    toasts: [] as ToastItem[],
    banners: [] as BannerItem[],
    dialogs: [] as DialogItem[]
  }),
  actions: {
    // ---------- Toast ----------
    toast(type: ToastItem['type'], message: string, autoDismiss = true): void {
      const id = nextId++
      this.toasts.push({ id, type, message, autoDismiss })
      if (this.toasts.length > 3) this.toasts.shift()
      if (autoDismiss) {
        setTimeout(() => this.dismissToast(id), 3000)
      }
    },
    info(message: string): void {
      this.toast('info', message)
    },
    success(message: string): void {
      this.toast('success', message)
    },
    warning(message: string): void {
      this.toast('warning', message)
    },
    // 错误 Toast：与其它级别一致，3 秒后自动消失
    errorToast(message: string): void {
      this.toast('error', message, true)
    },
    dismissToast(id: number): void {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    },

    // ---------- 横幅（每个页面最多 1 个） ----------
    showBanner(kind: BannerItem['kind'], message: string): number {
      const id = nextId++
      this.banners = this.banners.filter((b) => b.kind === kind)
      this.banners.push({ id, kind, message })
      return id
    },
    dismissBanner(id: number): void {
      this.banners = this.banners.filter((b) => b.id !== id)
    },

    // ---------- 模态弹窗（确认框/错误框/业务模态共用队列） ----------
    confirm(options: {
      title: string
      message: string
      primaryLabel?: string
      secondaryLabel?: string
    }): Promise<boolean> {
      return new Promise((resolve) => {
        const id = nextId++
        this.dialogs.push({
          id,
          kind: 'confirm',
          title: options.title,
          message: options.message,
          primaryLabel: options.primaryLabel ?? '确认',
          secondaryLabel: options.secondaryLabel ?? '取消',
          onResult: resolve
        })
      })
    },
    showError(options: {
      title: string
      message: string
      errorCode?: string
      detail?: string
      canRetry?: boolean
      onRetry?: () => void
    }): void {
      const id = nextId++
      this.dialogs.push({
        id,
        kind: 'error',
        title: options.title,
        message: options.message,
        primaryLabel: '关闭',
        errorCode: options.errorCode,
        detail: options.detail,
        canRetry: options.canRetry,
        onResult: (ok) => {
          if (ok && options.canRetry && options.onRetry) options.onRetry()
        }
      })
    },
    /** 业务模态：渲染自定义组件（导出预览等），返回 dialogId 供关闭 */
    pushModal(options: {
      title: string
      component: unknown
      componentProps?: Record<string, unknown>
      width?: string
    }): number {
      const id = nextId++
      this.dialogs.push({
        id,
        kind: 'modal',
        title: options.title,
        message: '',
        primaryLabel: '',
        component: options.component,
        componentProps: options.componentProps,
        width: options.width
      })
      return id
    },
    closeDialog(id: number, result: boolean): void {
      const dialog = this.dialogs.find((d) => d.id === id)
      if (dialog) dialog.onResult?.(result)
      this.dialogs = this.dialogs.filter((d) => d.id !== id)
    },
    closeTopDialog(result: boolean): void {
      const top = this.dialogs[this.dialogs.length - 1]
      if (top) this.closeDialog(top.id, result)
    },
    hasModal(): boolean {
      return this.dialogs.length > 0
    }
  }
})
