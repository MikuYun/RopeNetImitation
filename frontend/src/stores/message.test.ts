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
    // v2 新形状：附件事必填（无附件是 `[]`），撤回国与引用国未激活
    attachments: [],
    recalled: false,
    recalledAt: null,
    replyTo: null,
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

/*
 * ── upsertMessage：`message.updated`（撤回是目前唯一场景）的写入路径 ──
 *
 * 与 `insertOrIgnore` 的语义差别是这一组用例的全部意义：
 *   - insertOrIgnore 是「已存在则忽略」，专为追加新消息；
 *   - upsertMessage 是「以服务端最新版本为准」，已存在必须原地替换。
 *
 * 用错会出两类线上事故：撤回不生效（旧内容继续显示），或撤回后消息
 * 因为没有 pending 兑现而出现两份。
 */
describe('message store upsertMessage（message.updated 覆盖式写入）', () => {
  function wireMsg(seq: number, over: Partial<WireMessage> = {}): WireMessage {
    return { ...wireMessage(seq), ...over }
  }

  it('已存在的消息被原地替换，且 seq 顺序不变（撤回后不能挪到末尾）', () => {
    const store = useMessageStore()
    store.insertOrIgnore(wireMsg(10))
    store.insertOrIgnore(wireMsg(12))

    store.upsertMessage(wireMsg(10, { content: '', recalled: true, recalledAt: '2026-10-22T00:01:00.000Z' }))

    const list = store.messagesOf('c1')
    expect(list.map((m) => m.seq)).toEqual([10, 12])
    expect(list[0]?.recalled).toBe(true)
    expect(list[0]?.content).toBe('')
    // 服务端来的消息永远视为已确认态
    expect(list[0]?.status).toBe('sent')
    expect(list[1]?.recalled).toBe(false)
  })

  it('本地没有该消息时必须插入（先收撤回推送、后翻历史不能看到原文）', () => {
    const store = useMessageStore()
    store.insertOrIgnore(wireMsg(10))

    store.upsertMessage(wireMsg(8, { content: '', recalled: true }))

    expect(store.messagesOf('c1').map((m) => m.seq)).toEqual([8, 10])
    expect(store.messagesOf('c1')[0]?.recalled).toBe(true)
  })

  it('撤回推送带着自己的 clientMsgId 时，pending 里的乐观消息被兑现掉（不出现两份）', () => {
    const store = useMessageStore()
    const local = store.appendOptimistic({ conversationId: 'c1', senderId: 'u-self', content: 'hi' })
    expect(store.pendingOf('c1')).toHaveLength(1)

    store.upsertMessage({
      ...wireMsg(3),
      msgId: 'srv-3',
      senderId: 'u-self',
      clientMsgId: local.clientMsgId,
      content: 'hi',
    })

    expect(store.pendingOf('c1')).toHaveLength(0)
    expect(store.messagesOf('c1').map((m) => m.msgId)).toEqual(['srv-3'])
  })

  it('重复 upsert 同一条撤回消息是幂等的（WS 重连补偿会重放）', () => {
    const store = useMessageStore()
    store.insertOrIgnore(wireMsg(10))
    const recalled = wireMsg(10, { content: '', recalled: true })
    store.upsertMessage(recalled)
    store.upsertMessage(recalled)
    expect(store.messagesOf('c1')).toHaveLength(1)
    expect(store.messagesOf('c1')[0]?.recalled).toBe(true)
  })
})

/**
 * 「发送失败」误报的门禁。
 *
 * 真实时序（用户反复遇到的「图片有时发送失败」）：
 *   1. `sendMessage` 请求已到达服务端并落库；
 *   2. WS 的 `message.created` 抢先到达 → `insertOrIgnore` 兑现 pending → confirmed；
 *   3. axios 才因为客户端超时 / 连接抖动抛错。
 *
 * 此时 pending 已经不存在了。若 `markFailed` 仍把某条消息标成失败、调用方仍弹
 * toast，用户看到的就是「图明明发出去了，却提示发送失败」—— 于是去点重试，
 * 重试又靠 clientMsgId 幂等返回同一条，界面看起来「重试成功」，更让人困惑。
 *
 * 所以 `markFailed` 必须**返回是否真的标到了失败态**，调用方据此决定要不要提示。
 */
describe('message store markFailed 返回值（发送失败误报的门禁）', () => {
  it('pending 存在时返回 true，并把状态标成 failed', () => {
    const store = useMessageStore()
    const local = store.appendOptimistic({ conversationId: 'c1', senderId: 'u-self', content: 'hi' })

    expect(store.markFailed('c1', local.clientMsgId ?? '', 'NETWORK_ERROR')).toBe(true)
    const pending = store.pendingOf('c1')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.status).toBe('failed')
    expect(pending[0]?.errorCode).toBe('NETWORK_ERROR')
  })

  it('已经兑现成 confirmed 之后再 markFailed → 返回 false，且不留下任何失败态', () => {
    const store = useMessageStore()
    const local = store.appendOptimistic({ conversationId: 'c1', senderId: 'u-self', content: 'hi' })

    // WS 抢先兑现（这就是误报的起点）
    store.insertOrIgnore({
      ...wireMessage(3, 'hi'),
      msgId: 'srv-3',
      senderId: 'u-self',
      clientMsgId: local.clientMsgId,
    })
    expect(store.pendingOf('c1')).toHaveLength(0)

    // 迟到的 catch：必须报告「没标到」
    expect(store.markFailed('c1', local.clientMsgId ?? '', 'NETWORK_ERROR')).toBe(false)
    expect(store.pendingOf('c1')).toHaveLength(0)
    // 已兑现的消息仍然是 sent，不能被降级成失败
    expect(store.messagesOf('c1')).toHaveLength(1)
    expect(store.messagesOf('c1')[0]?.status).toBe('sent')
  })

  it('未知 clientMsgId → 返回 false（不凭空造失败态）', () => {
    const store = useMessageStore()
    expect(store.markFailed('c1', 'nope', 'NETWORK_ERROR')).toBe(false)
    expect(store.pendingOf('c1')).toHaveLength(0)
  })

  it('markRetrying 只在 pending 还在时生效；失败后重试回到 sending 且清掉 errorCode', () => {
    const store = useMessageStore()
    const local = store.appendOptimistic({ conversationId: 'c1', senderId: 'u-self', content: 'hi' })
    const cmid = local.clientMsgId ?? ''

    store.markFailed('c1', cmid, 'NETWORK_ERROR')
    store.markRetrying('c1', cmid)
    const pending = store.pendingOf('c1')
    expect(pending[0]?.status).toBe('sending')
    expect(pending[0]?.errorCode).toBeUndefined()
  })
})
