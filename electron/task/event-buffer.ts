import type { TaskEvent, TaskEventType, TaskPage } from '../../shared/ipc-types'

// 任务事件环形缓冲：容量 2000 条 + 单调序号。
// 渲染进程重连时先拿快照（get_active_tasks + subscribe_task），主进程从 lastSeq+1 推增量。
// lastSeq 超出缓冲范围返回 null（快照已过期），渲染进程强制拉全量。

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
    if (this.items.length > EVENT_BUFFER_CAPACITY) this.items.shift()
    return item
  }

  lastSeq(): number {
    return this.nextSeq - 1
  }

  /** 返回 lastSeq 之后的增量；null 表示快照已过期 */
  deltaAfter(lastSeq: number): TaskEvent[] | null {
    if (lastSeq >= this.nextSeq) return []
    const oldestSeq = this.items.length > 0 ? this.items[0].seq : this.nextSeq
    if (lastSeq < oldestSeq - 1) return null
    return this.items.filter((e) => e.seq > lastSeq)
  }
}
