import { defineStore } from 'pinia'
import type { TaskEvent, TaskPage, TaskSnapshot } from '@shared/ipc-types'
import { useFeedbackStore } from './feedback'
import { useAnalyzeStore } from './analyze'
import { useConvertStore } from './convert'

// 全局任务：按页面分桶（convert / analyze），各页同时一个任务、页面间并行。
// 订阅 event:task，维护两页的任务快照；任务失败/取消/完成统一转自研弹窗或 Toast。

// 关闭确认流程防重入：确认框弹出期间忽略主进程重复的关闭请求
let closeConfirming = false

function isActiveTask(t: TaskSnapshot | null): boolean {
  return (
    t !== null &&
    (t.status === 'running' || t.status === 'awaiting_confirm' || t.status === 'cancelling')
  )
}

export const useTaskStore = defineStore('task', {
  state: () => ({
    convert: null as TaskSnapshot | null,
    analyze: null as TaskSnapshot | null,
    lastSeq: 0
  }),
  actions: {
    async init(): Promise<void> {
      await this.refresh()
      window.gigacenter.on('event:task', (payload) => this.onEvent(payload as TaskEvent))
      // 会话被主进程空闲回收：清空前端会话状态并提示
      window.gigacenter.on('event:session-expired', () => {
        const analyze = useAnalyzeStore()
        const hadData = analyze.imported || analyze.sqlText.trim().length > 0
        analyze.reset()
        if (hadData) {
          useFeedbackStore().warning('会话因长时间未使用已自动关闭，请重新导入数据')
        }
      })
    },
    /** 页面任务快照（页面内进度条/按钮状态用） */
    page(page: TaskPage): TaskSnapshot | null {
      return page === 'convert' ? this.convert : this.analyze
    },
    /** 页面是否忙碌：有活跃任务（含等待确认、取消中） */
    isPageBusy(page: TaskPage): boolean {
      return isActiveTask(this.page(page))
    },
    onEvent(ev: TaskEvent): void {
      this.lastSeq = Math.max(this.lastSeq, ev.seq)
      // 关闭确认请求（主进程窗口 ×）：优先处理，不受任务快照过滤
      if (ev.type === 'task-progress' && (ev.payload as { appCloseRequested?: boolean })?.appCloseRequested === true) {
        void this.handleAppCloseRequested()
        return
      }
      const bucket = ev.page ?? this.bucketByTaskId(ev.taskId)
      if (!bucket) {
        // 事件无归属页且不匹配任何当前任务：以服务端快照为准
        void this.refresh()
        return
      }
      const cur = this[bucket]
      // 快照缺失或事件不属于当前桶任务：服务端已清空/更换任务，重拉快照
      if (!cur || ev.taskId !== cur.taskId) {
        void this.refresh()
        return
      }
      if (ev.type === 'task-progress' || ev.type === 'task-warning') {
        const p = ev.payload
        const patch: Partial<TaskSnapshot> = {}
        if (typeof p.currentStep === 'string') patch.currentStep = p.currentStep
        if (typeof p.done === 'number') patch.done = p.done
        if (typeof p.total === 'number') patch.total = p.total
        if (typeof p.message === 'string') patch.message = p.message
        if (p.awaitingConfirm === true) patch.status = 'awaiting_confirm'
        this[bucket] = { ...cur, ...patch }
        if (ev.type === 'task-warning' && typeof p.message === 'string') {
          this[bucket]!.warnings = [...cur.warnings, p.message]
        }
        return
      }
      if (ev.type === 'task-error') {
        // 统一右下角错误 Toast（3 秒自动消失），页面内不再重复提示
        useFeedbackStore().errorToast(
          typeof ev.payload.message === 'string' ? ev.payload.message : '任务执行失败'
        )
      }
      void this.refresh()
    },
    /** 事件未带 page 时按 taskId 匹配两桶 */
    bucketByTaskId(taskId: string): TaskPage | null {
      if (this.convert?.taskId === taskId) return 'convert'
      if (this.analyze?.taskId === taskId) return 'analyze'
      return null
    },
    /** 窗口关闭确认：有任务运行/已导入数据/SQL 内容/格式转换未导出数据时弹确认框，否则直接放行关闭 */
    async handleAppCloseRequested(): Promise<void> {
      if (closeConfirming) return
      closeConfirming = true
      try {
        const fb = useFeedbackStore()
        const analyze = useAnalyzeStore()
        const convert = useConvertStore()
        const hasTask = isActiveTask(this.convert) || isActiveTask(this.analyze)
        const hasData = analyze.imported
        const hasSql = analyze.sqlText.trim().length > 0
        const hasConvertData = convert.workbook !== null
        if (!hasTask && !hasData && !hasSql && !hasConvertData) {
          await window.gigacenter.invoke('app:confirm-close')
          return
        }
        const reasons: string[] = []
        if (hasTask) reasons.push('有任务正在执行')
        if (hasData) reasons.push('数据分析中已导入的数据（关闭后自动清除）')
        if (hasSql) reasons.push('SQL 编辑器中有未执行的内容')
        if (hasConvertData) reasons.push('格式转换中已解析的文件（关闭后丢失）')
        const ok = await fb.confirm({
          title: '确认退出？',
          message: `当前${reasons.join('、')}，退出后这些内容将丢失，是否继续退出？`
        })
        if (ok) await window.gigacenter.invoke('app:confirm-close')
      } finally {
        closeConfirming = false
      }
    },
    async refresh(): Promise<void> {
      const res = await window.gigacenter.invoke<TaskSnapshot[]>('task:get-active')
      if (!res.ok) return
      this.convert = res.value.find((t) => t.page === 'convert') ?? null
      this.analyze = res.value.find((t) => t.page === 'analyze') ?? null
    },
    /** 取消指定页面任务；不传则取消全部 */
    async cancel(page?: TaskPage): Promise<void> {
      const taskId = page ? this.page(page)?.taskId : undefined
      await window.gigacenter.invoke('task:cancel', { taskId })
      if (page) this[page] = null
    }
  }
})
