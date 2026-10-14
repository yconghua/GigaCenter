import { EventBuffer } from './event-buffer'
import type { TaskEvent, TaskEventType, TaskPage, TaskSnapshot, TaskStatus } from '../../shared/ipc-types'
import { logger } from '../log'

// 全局多任务模型：任务按 taskId 独立注册，可多个并存。
// 每个页面（convert/analyze）同时只允许一个任务，页面之间并行。
// 状态机：idle / running / awaiting_confirm / cancelling / done / failed / cancelled，phase 只做展示。
// 事件经 EventBuffer 缓存（环形 2000），由 emit 回调推送到渲染进程。

interface BeginOptions {
  taskId: string
  title: string
  page: TaskPage
  sessionId?: string
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

  /** 全部活跃任务快照列表（前端初始化分桶用） */
  getActive(): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => ({ ...t }))
  }

  /** 指定任务快照；不存在返回 null */
  get(taskId: string): TaskSnapshot | null {
    const t = this.tasks.get(taskId)
    return t ? { ...t } : null
  }

  /** 页面是否已有活跃任务（同页互斥，跨页并行） */
  isPageBusy(page: TaskPage): boolean {
    for (const t of this.tasks.values()) {
      if (t.page === page && isActive(t.status)) return true
    }
    return false
  }

  /** 启动任务：同页已有活跃任务时返回 false */
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
      startedAt: now
    })
    logger.info('[event=task-begin]', { taskId: options.taskId, page: options.page, title: options.title, sessionId: options.sessionId })
    this.push('task-progress', options.taskId, options.sessionId, 'starting', {})
    return true
  }

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

  warn(taskId: string, message: string): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.warnings.push(message)
    this.push('task-warning', taskId, undefined, t.phase, { message })
  }

  /** 进入等待确认阶段（如导出预览），属于独立状态，不属于 running */
  awaitConfirm(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.status = 'awaiting_confirm'
    this.push('task-progress', taskId, undefined, t.phase, {
      awaitingConfirm: true
    })
  }

  confirmProceed(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (t) t.status = 'running'
  }

  done(taskId: string, message = ''): TaskSnapshot | null {
    const snapshot = this.finish(taskId, 'done', message)
    if (snapshot) {
      logger.info('[event=task-done]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, elapsedMs: snapshot.elapsedMs, message })
      this.push('task-done', taskId, undefined, snapshot.phase, { message })
    }
    return snapshot
  }

  fail(taskId: string, code: string, message: string): TaskSnapshot | null {
    const snapshot = this.finish(taskId, 'failed', message)
    if (snapshot) {
      logger.warn('[event=task-failed]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, code, message, elapsedMs: snapshot.elapsedMs })
      this.push('task-error', taskId, undefined, snapshot.phase, { code, message })
    }
    return snapshot
  }

  /** 取消指定任务；taskId 为空取消全部。不算 done 也不算 error，走 task-cancelled */
  cancel(taskId?: string): TaskSnapshot[] {
    const targets = taskId ? [taskId] : [...this.tasks.keys()]
    const cancelled: TaskSnapshot[] = []
    for (const id of targets) {
      const t = this.tasks.get(id)
      if (!t) continue
      t.status = 'cancelled'
      const snapshot = { ...t }
      logger.info('[event=task-cancelled]', { taskId: snapshot.taskId, page: snapshot.page, title: snapshot.title, elapsedMs: snapshot.elapsedMs })
      this.push('task-cancelled', id, undefined, snapshot.phase, {
        message: '任务已取消'
      })
      this.tasks.delete(id)
      cancelled.push(snapshot)
    }
    return cancelled
  }

  /** 快照 + 增量重连：lastSeq 超出缓冲返回 snapshotExpired */
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
