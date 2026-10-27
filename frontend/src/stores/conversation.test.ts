/**
 * 已读上报的失败回滚竞态门禁（SEC-02）。
 *
 * 门禁要守的是一条很窄的线：**只有「仍是这个会话最新一发」的上报才允许回滚**。
 *
 * 反例（真实会出现的时序）：用户快速点了两下会话，
 *   发#1 出发（gen=1）→ 发#2 出发（gen=2）→ 发#2 成功 → 发#1 **才**失败。
 * 如果发#1 按自己出发时的快照回滚，就会把发#2 已经成功的结果一起抹掉：
 * 界面红点重新出现，而服务端其实是已读的 —— 用户被两个状态来回骗。
 *
 * 另外两条配套断言：
 *   - 单发失败仍必须回滚（否则失败被静默吞掉，「看起来已读」但刷新后复活）；
 *   - 回滚叠在当前值上而非整体覆盖快照（失败期间推来的新消息不能被抹掉）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiCtl = vi.hoisted(() => ({
  markRead: vi.fn(),
}))

vi.mock('@/api/conversations', async () => {
  const actual = await vi.importActual<typeof import('@/api/conversations')>('@/api/conversations')
  return { ...actual, markRead: apiCtl.markRead }
})

import { useConversationStore } from '@/stores/conversation'
import { bumpEpoch } from '@/stores/session'
import type { ConversationSummary } from '@/types/domain'

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1',
    type: 'single',
    title: '对手',
    lastSeq: 12,
    lastReadSeq: 3,
    unreadCount: 9,
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...over,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiCtl.markRead.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('conversation store 已读上报竞态', () => {
  it('旧一发失败不回滚新一发已成功的已读游标', async () => {
    const store = useConversationStore()
    store.upsertSummary(summary())

    // 两个独立的挂起点，用来精确控制「谁先失败」
    const first = deferred<void>()
    const second = deferred<void>()
    apiCtl.markRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const p1 = store.markRead('c1', 10) // gen = 1
    const p2 = store.markRead('c1', 12) // gen = 2
    expect(store.summariesById.get('c1')?.unreadCount).toBe(0) // 乐观清零
    expect(store.summariesById.get('c1')?.lastReadSeq).toBe(12)

    // 后发先至：发#2 成功
    second.resolve()
    await p2
    expect(store.summariesById.get('c1')?.lastReadSeq).toBe(12)

    // 先发后失败：发#1 已不是最新，必须什么都不做
    first.reject(new Error('network down'))
    await p1.catch(() => undefined)

    const after = store.summariesById.get('c1')!
    expect(after.lastReadSeq, '旧发失败不得把新发已成功的游标退回去').toBe(12)
    expect(after.unreadCount, '旧发失败不得把红点叫回来').toBe(0)
  })

  it('单发失败仍然回滚（失败不能被静默吞掉）', async () => {
    const store = useConversationStore()
    store.upsertSummary(summary({ lastReadSeq: 3, unreadCount: 9 }))

    apiCtl.markRead.mockRejectedValueOnce(new Error('500'))
    await expect(store.markRead('c1', 12)).rejects.toThrow('500')

    const after = store.summariesById.get('c1')!
    expect(after.unreadCount).toBe(9)
    expect(after.lastReadSeq).toBe(3)
  })

  it('回滚叠在当前值上：失败期间推来的新消息不被抹掉', async () => {
    const store = useConversationStore()
    store.upsertSummary(summary({ lastReadSeq: 3, unreadCount: 9 }))

    const gate = deferred<void>()
    apiCtl.markRead.mockReturnValueOnce(gate.promise)
    const pending = store.markRead('c1', 12)

    // 失败尚未回来时，WS 推来一条新消息（unreadCount 由上游更新）
    store.upsertSummary(summary({ lastReadSeq: 3, unreadCount: 11 }), { keepPosition: true })

    gate.reject(new Error('offline'))
    await pending.catch(() => undefined)

    const after = store.summariesById.get('c1')!
    // 未读数回到快照，但游标只回退到自己的快照值，不会整体覆盖掉当前对象
    expect(after.unreadCount).toBe(9)
    expect(after.lastReadSeq).toBe(3)
    expect(after.id).toBe('c1')
  })

  it('登出清空后迟到的已读失败不重建会话条目', async () => {
    const store = useConversationStore()
    store.upsertSummary(summary())

    const gate = deferred<void>()
    apiCtl.markRead.mockReturnValueOnce(gate.promise)
    const pending = store.markRead('c1', 12)

    // 登出：重置换代
    bumpEpoch()
    store.reset()
    expect(store.summariesById.size).toBe(0)

    gate.reject(new Error('401 during logout'))
    await pending.catch(() => undefined)

    expect(store.summariesById.size).toBe(0)
  })
})
