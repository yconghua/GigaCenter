import { EventBuffer } from './event-buffer'
import type { TaskEvent, TaskEventType, TaskPage, TaskSnapshot, TaskStatus } from '../../shared/ipc-types'
import { logger } from '../log'

// 全局多任务模型：任务按 taskId 独立注册，多个任务可并存。
// 同一页面（convert/analyze）同时只允许一个活跃任务，不同页面之间并行执行。
// 任务状态机：idle / running / awaiting_confirm / cancelling / done / failed / cancelled；phase 仅用于前端展示，不参与状态判定。
// 所有任务事件统一经 EventBuffer 缓存（环形容量 2000），再由 emit 回调推送到渲染进程。

interface BeginOptions {
  taskId: string
  title: string
  page: TaskPage
  sessionId?: string
  /** 任务详情（操作参数快照），随 task-begin/task-done/task-failed 事件写入日志。 */
  detail?: Record<string, unknown>
}

function isActive(status: TaskStatus): boolean {
  return status === 'running' || status === 'awaiting_confirm' || status === 'cancelling'
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskSnapshot>()
  private readonly buffer = new EventBuffer()
  private readonly emit: (event: TaskEvent) => void

  constructor(emit: (event: TaskEvent) => void) {
    this.emit = emit
  }

  /** 返回全部非终态任务的快照列表（拷贝），供前端初始化时按页面分桶。 */
  getActive(): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => ({ ...t }))
  }

  /** 返回指定任务的快照（拷贝）；任务不存在返回 null。 */
  get(taskId: string): TaskSnapshot | null {
    const t = this.tasks.get(taskId)
    return t ? { ...t } : null
  }

  /** 指定页面是否已有活跃任务：同页互斥，跨页可并行。 */
  isPageBusy(page: TaskPage): boolean {
    for (const t of this.tasks.values()) {
      if (t.page === page && isActive(t.status)) return true
    }
    return false
  }

  /** 启动任务并置为 running；同页已有活跃任务时返回 false 拒绝启动。 */
  begin(options: BeginOptions): boolean {
    if (this.isPageBusy(options.page)) return false
    const now = Date.now()
    this.tasks.set(options.taskId, {
      taskId: options.taskId,
      page: options.page,
      status: 'running',
      phase: 'starting',
      title: options.title,
      currentStep: '',
      done: 0,
      total: 0,
      elapsedMs: 0,
      warnings: [],
      message: '',
      startedAt: now,
      detail: options.detail
    })
    logger.info('[event=task-begin]', { taskId: options.taskId, page: options.page, title: options.title, sessionId: options.sessionId, detail: options.detail })
    this.push('task-progress', options.taskId, options.sessionId, 'starting', {})
    return true
  }

  /** 更新任务进度（phase/当前步骤/完成计数）并推送 task-progress 事件；任务已结束时静默忽略。 */
  update(
    taskId: string,
    phase: string,
    currentStep: string,
    done: number,
    total: number,
    message = ''
  ): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.phase = phase
    t.currentStep = currentStep
    t.done = done
    t.total = total
    t.message = message
    t.elapsedMs = Date.now() - t.startedAt
    this.push('task-progress', taskId, undefined, phase, {
      currentStep,
      done,
      total,
      message
    })
  }

  /** 追加一条警告并推送 task-warning 事件；任务已结束时静默忽略。 */
  warn(taskId: string, message: string): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.warnings.push(message)
    this.push('task-warning', taskId, undefined, t.phase, { message })
  }

  /** 进入等待确认阶段（如导出预览待确认）：独立状态 awaiting_confirm，不再算作 running。 */
  awaitConfirm(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.status = 'awaiting_confirm'
    this.push('task-progress', taskId, undefined, t.phase, {
      awaitingConfirm: true
    })
  }

  /** 用户确认继续后，任务从 awaiting_confirm 回到 running。 */
  confirmProceed(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (t) t.status = 'running'
  }

  done(taskId: string, message = ''): TaskSnapshot | null {
    const snapshot = this.finish(taskId, 'done', message)
    if (snapshot) {
      logger.info('[event=task-done]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, elapsedMs: snapshot.elapsedMs, message, detail: snapshot.detail })
      this.push('task-done', taskId, undefined, snapshot.phase, { message })
    }
    return snapshot
  }

  fail(taskId: string, code: string, message: string): TaskSnapshot | null {
    const snapshot = this.finish(taskId, 'failed', message)
    if (snapshot) {
      logger.warn('[event=task-failed]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, code, message, elapsedMs: snapshot.elapsedMs, detail: snapshot.detail })
      this.push('task-error', taskId, undefined, snapshot.phase, { code, message })
    }
    return snapshot
  }

  /** 取消指定任务；taskId 为空时取消全部任务。取消不算 done 也不算 error，统一走 task-cancelled 事件。 */
  cancel(taskId?: string): TaskSnapshot[] {
    const targets = taskId ? [taskId] : [...this.tasks.keys()]
    const cancelled: TaskSnapshot[] = []
    for (const id of targets) {
      const t = this.tasks.get(id)
      if (!t) continue
      t.status = 'cancelled'
      const snapshot = { ...t }
      logger.info('[event=task-cancelled]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, elapsedMs: snapshot.elapsedMs, detail: snapshot.detail })
      this.push('task-cancelled', id, undefined, snapshot.phase, {
        message: '任务已取消'
      })
      this.tasks.delete(id)
      cancelled.push(snapshot)
    }
    return cancelled
  }

  /** 重连恢复：返回任务快照与 lastSeq 之后的增量事件；lastSeq 超出缓冲范围时 snapshotExpired 置 true。 */
  subscribe(taskId: string, lastSeq: number): {
    snapshot: TaskSnapshot | null
    events: TaskEvent[]
    snapshotExpired: boolean
  } {
    const snapshot = this.get(taskId)
    const delta = this.buffer.deltaAfter(lastSeq)
    if (delta === null) {
      return { snapshot, events: [], snapshotExpired: true }
    }
    return { snapshot, events: delta, snapshotExpired: false }
  }

  /** 收尾：标记终态、刷新耗时，返回快照后将任务从注册表移除。 */
  private finish(taskId: string, status: TaskStatus, message: string): TaskSnapshot | null {
    const t = this.tasks.get(taskId)
    if (!t) return null
    t.status = status
    t.message = message
    t.elapsedMs = Date.now() - t.startedAt
    const snapshot = { ...t }
    this.tasks.delete(taskId)
    return snapshot
  }

  /** 生成事件并写入 EventBuffer，同时立即推送到渲染进程。 */
  private push(
    type: TaskEventType,
    taskId: string,
    sessionId: string | undefined,
    phase: string | undefined,
    payload: Record<string, unknown>
  ): void {
    const page = this.tasks.get(taskId)?.page
    const event = this.buffer.push({ type, taskId, page, sessionId, phase, payload })
    this.emit(event)
  }
}
