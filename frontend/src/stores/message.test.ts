/**
 * 消息 store 的「登出后迟到响应不得重建桶」竞态门禁（SEC-02）。
 *
 * 真实竞态时间线（pm 实测复现过一次）：
 *   1. 用户在会话 A 里滚动历史 → `loadOlder` 发出 REST 请求；
 *   2. 用户点登出 → `auth.clearLocal()` → `bumpEpoch()` + `message.reset()`；
 *   3. 请求这时才回来。
 *
 * 若响应处理里少了代际判断，`bucketOf()` 会**懒创建**一个空桶并写进 map ——
 * 于是已清空的 store 又凭空多出一个会话的消息桶，下一个账号登录后命中它，
 * 界面上出现上一个账号的残留。`loadOlder` / `ensureLoaded` 的 finally 块
 * 也有同一个坑：即使 try 里判了代际，finally 里再调 `bucketOf()` 同样会重建。
 *
 * 因此这里断言的是 `buckets.size`，而不只是返回值。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiCtl = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
}))

vi.mock('@/api/messages', async () => {
  const actual = await vi.importActual<typeof import('@/api/messages')>('@/api/messages')
  return { ...actual, fetchMessages: apiCtl.fetchMessages }
})

import { useMessageStore } from '@/stores/message'
import { bumpEpoch } from '@/stores/session'
import type { WireMessage } from '@/types/domain'

function wireMessage(seq: number, content = `m${seq}`): WireMessage {
  return {
    msgId: `srv-${seq}`,
    conversationId: 'c1',
    senderId: 'u-other',
    clientMsgId: null,
    seq,
    type: 'text',
    content,
    createdAt: '2026-10-22T00:00:00.000Z',
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
  apiCtl.fetchMessages.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('message store 登出代际隔离', () => {
  it('loadOlder 在飞时登出，迟到响应不得重建消息桶', async () => {
    const store = useMessageStore()
    // 先有桶（正常阅读过），再走出让
    apiCtl.fetchMessages.mockResolvedValueOnce({
      items: [wireMessage(10)],
      hasMore: true,
      nextBeforeSeq: 10,
      nextAfterSeq: null,
    })
    await store.ensureLoaded('c1')
    expect(store.buckets.size).toBe(1)
    expect(store.messagesOf('c1')).toHaveLength(1)

    // 第二发：翻历史，挂在半空
    const gate = deferred<{
      items: WireMessage[]
      hasMore: boolean
      nextBeforeSeq: number | null
      nextAfterSeq: number | null
    }>()
    apiCtl.fetchMessages.mockReturnValueOnce(gate.promise)
    const older = store.loadOlder('c1')

    // 登出：清代际 + 清 store
    bumpEpoch()
    store.reset()
    expect(store.buckets.size).toBe(0)

    gate.resolve({
      items: [wireMessage(8)],
      hasMore: true,
      nextBeforeSeq: 8,
      nextAfterSeq: null,
    })
    const added = await older

    // 核心断言：桶没有被 lazy 重建，旧消息也没落进 store
    expect(store.buckets.size).toBe(0)
    expect(added).toBe(0)
    expect(store.messagesOf('c1')).toEqual([])
  })

  it('ensureLoaded 在飞时登出，迟到响应不得写入消息', async () => {
    const store = useMessageStore()
    const gate = deferred<{
      items: WireMessage[]
      hasMore: boolean
      nextBeforeSeq: number | null
      nextAfterSeq: number | null
    }>()
    apiCtl.fetchMessages.mockReturnValueOnce(gate.promise)

    const loading = store.ensureLoaded('c1')
    bumpEpoch()
    store.reset()

    gate.resolve({
      items: [wireMessage(1), wireMessage(2)],
      hasMore: false,
      nextBeforeSeq: 1,
      nextAfterSeq: 2,
    })
    await loading

    expect(store.buckets.size).toBe(0)
    expect(store.messagesOf('c1')).toEqual([])
    expect(store.isLoaded('c1')).toBe(false)
  })

  it('catchUp 在飞时登出，迟到分页不得写回，也不得把 bucket 标 stale', async () => {
    const store = useMessageStore()
    apiCtl.fetchMessages.mockResolvedValueOnce({
      items: [wireMessage(1)],
      hasMore: false,
      nextBeforeSeq: 1,
      nextAfterSeq: null,
    })
    await store.ensureLoaded('c1')

    const gate = deferred<{
      items: WireMessage[]
      hasMore: boolean
      nextBeforeSeq: number | null
      nextAfterSeq: number | null
    }>()
    apiCtl.fetchMessages.mockReturnValueOnce(gate.promise)
    const sync = store.catchUp('c1')

    bumpEpoch()
    store.reset()

    gate.resolve({
      items: [wireMessage(2)],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: 2,
    })
    await sync

    expect(store.buckets.size).toBe(0)
    expect(store.lastSeqOf('c1')).toBe(0)
  })

  it('同一代际内 loadOlder 正常合并且 loading 归零', async () => {
    const store = useMessageStore()
    apiCtl.fetchMessages.mockResolvedValueOnce({
      items: [wireMessage(10)],
      hasMore: true,
      nextBeforeSeq: 10,
      nextAfterSeq: null,
    })
    await store.ensureLoaded('c1')
    expect(store.isLoading('c1')).toBe(false)

    apiCtl.fetchMessages.mockResolvedValueOnce({
      items: [wireMessage(7)],
      hasMore: false,
      nextBeforeSeq: 7,
      nextAfterSeq: null,
    })
    const added = await store.loadOlder('c1')

    expect(added).toBe(1)
    expect(store.messagesOf('c1').map((m) => m.seq)).toEqual([7, 10])
    expect(store.hasMoreOlder('c1')).toBe(false)
    expect(store.isLoading('c1')).toBe(false)
  })
})
