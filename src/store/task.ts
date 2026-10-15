import { defineStore } from 'pinia'
import type { TaskEvent, TaskPage, TaskSnapshot } from '@shared/ipc-types'
import { useFeedbackStore } from './feedback'
import { useAnalyzeStore } from './analyze'
import { useConvertStore } from './convert'

// 全局任务状态：按页面分桶（convert / analyze），每页同时只有一个活跃任务，两页之间可并行。
// 订阅主进程 event:task 事件维护两页的任务快照；任务失败统一弹右下角错误 Toast。

// 关闭确认流程防重入：确认框弹出期间忽略主进程重复发来的关闭请求
let closeConfirming = false

/** 活跃任务状态：running / awaiting_confirm / cancelling；完成或失败后由 refresh 清空 */
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
      // 会话被主进程空闲回收：清空前端会话状态，有数据时提示用户重新导入
      window.gigacenter.on('event:session-expired', () => {
        const analyze = useAnalyzeStore()
        const hadData = analyze.imported || analyze.sqlText.trim().length > 0
        analyze.reset()
        if (hadData) {
          useFeedbackStore().warning('会话因长时间未使用已自动关闭，请重新导入数据')
        }
      })
    },
    /** 读取指定页面的任务快照，供页面内进度条与按钮禁用态使用 */
    page(page: TaskPage): TaskSnapshot | null {
      return page === 'convert' ? this.convert : this.analyze
    },
    /** 页面是否忙碌：存在活跃任务（含等待确认、取消中） */
    isPageBusy(page: TaskPage): boolean {
      return isActiveTask(this.page(page))
    },
    onEvent(ev: TaskEvent): void {
      this.lastSeq = Math.max(this.lastSeq, ev.seq)
      // 关闭确认请求（用户点主进程窗口 ×）：优先处理，不经过任务快照归属过滤
      if (ev.type === 'task-progress' && (ev.payload as { appCloseRequested?: boolean })?.appCloseRequested === true) {
        void this.handleAppCloseRequested()
        return
      }
      const bucket = ev.page ?? this.bucketByTaskId(ev.taskId)
      if (!bucket) {
        // 事件无归属页且匹配不上任何当前任务：以服务端快照为准，重拉一遍
        void this.refresh()
        return
      }
      const cur = this[bucket]
      // 快照缺失或事件不属于当前桶任务：服务端已清空或更换任务，重拉快照对齐
      if (!cur || ev.taskId !== cur.taskId) {
        void this.refresh()
        return
      }
      // 进度/警告事件：只对存在的字段做增量补丁，避免整对象替换丢失状态
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
        // 统一弹右下角错误 Toast（3 秒自动消失），页面内不再重复提示
        useFeedbackStore().errorToast(
          typeof ev.payload.message === 'string' ? ev.payload.message : '任务执行失败'
        )
      }
      void this.refresh()
    },
    /** 事件未带 page 字段时，按 taskId 在两页快照中匹配归属 */
    bucketByTaskId(taskId: string): TaskPage | null {
      if (this.convert?.taskId === taskId) return 'convert'
      if (this.analyze?.taskId === taskId) return 'analyze'
      return null
    },
    /** 窗口关闭确认：有任务运行、已导入数据、SQL 未执行内容或已解析文件时弹确认框，否则直接放行关闭 */
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
    /** 取消指定页面的任务；不传页面则取消全部活跃任务 */
    async cancel(page?: TaskPage): Promise<void> {
      const taskId = page ? this.page(page)?.taskId : undefined
      await window.gigacenter.invoke('task:cancel', { taskId })
      if (page) this[page] = null
    }
  }
})
