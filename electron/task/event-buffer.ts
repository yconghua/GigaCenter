import type { TaskEvent, TaskEventType, TaskPage } from '../../shared/ipc-types'

// 任务事件环形缓冲：固定容量 2000 条，每条事件携带单调递增序号。
// 渲染进程重连时先取任务快照（get_active_tasks + subscribe_task），主进程再从 lastSeq+1 开始推送增量事件。
// 若 lastSeq 早于缓冲中最旧事件的序号（早期事件已被挤出），deltaAfter 返回 null，表示快照已过期，渲染进程需强制拉全量。

export const EVENT_BUFFER_CAPACITY = 2000

interface InternalEvent {
  seq: number
  type: TaskEventType
  taskId: string
  page?: TaskPage
  sessionId?: string
  phase?: string
  payload: Record<string, unknown>
  at: number
}

export class EventBuffer {
  private items: InternalEvent[] = []
  private nextSeq = 1

  push(event: {
    type: TaskEventType
    taskId: string
    page?: TaskPage
    sessionId?: string
    phase?: string
    payload: Record<string, unknown>
  }): TaskEvent {
    const item: InternalEvent = {
      ...event,
      seq: this.nextSeq++,
      at: Date.now()
    }
    this.items.push(item)
    if (this.items.length > EVENT_BUFFER_CAPACITY) this.items.shift() // 超出容量时丢弃最旧事件
    return item
  }

  /** 当前已分发的最大序号（下一条事件的序号减一）。 */
  lastSeq(): number {
    return this.nextSeq - 1
  }

  /** 返回 lastSeq 之后的增量事件；返回 null 表示快照已过期（缓冲中最旧事件序号已越过 lastSeq）。 */
  deltaAfter(lastSeq: number): TaskEvent[] | null {
    if (lastSeq >= this.nextSeq) return []
    const oldestSeq = this.items.length > 0 ? this.items[0].seq : this.nextSeq
    if (lastSeq < oldestSeq - 1) return null
    return this.items.filter((e) => e.seq > lastSeq)
  }
}
