import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/api/messages'
import { messageTypeOfAttachments } from '@/utils/attachments'
import { uuid } from '@/utils/uuid'
import { currentEpoch, epochValid } from './session'
import {
  createBucket,
  type Attachment,
  type ConversationBucket,
  type LocalMessage,
  type ReplyRef,
  type WireMessage,
} from '@/types/domain'

/**
 * 消息 store —— 三层去重的落地处。
 *
 *   层 1  pendingByClientMsgId  关联本地乐观消息与服务端确认
 *   层 2  confirmedById         按服务端 msgId 去重（应对实时推送与分页补齐重叠）
 *   层 3  服务端幂等            (senderId, clientMsgId) 唯一索引，网络重试不产生重复
 *
 * 所有插入都走 insertOrIgnore / upsertMessage 两个入口：
 *   - insertOrIgnore：**追加**新消息（已存在则忽略）；
 *   - upsertMessage：**覆盖**已有消息（`message.updated`，撤回是当前唯一场景）。
 * 除这两个入口外不得出现第三套合并逻辑。
 * 排序一律按 seq；绝不用 createdAt（时钟偏移会导致消息跳跃）。
 */
export const useMessageStore = defineStore('message', () => {
  const buckets = ref<Map<string, ConversationBucket>>(new Map())

  function bucketOf(conversationId: string): ConversationBucket {
    let b = buckets.value.get(conversationId)
    if (!b) {
      b = createBucket(conversationId)
      buckets.value.set(conversationId, b)
    }
    return b
  }

  /* ── 读取 ──────────────────────────────────────────────────────── */

  /** 某会话的展示序列：已确认（按 seq）+ 乐观待确认（按发送顺序）。 */
  function messagesOf(conversationId: string): LocalMessage[] {
    const b = buckets.value.get(conversationId)
    if (!b) return []
    return [...b.confirmed, ...b.pending]
  }

  function lastSeqOf(conversationId: string): number {
    return buckets.value.get(conversationId)?.lastSeq ?? 0
  }

  function hasMoreOlder(conversationId: string): boolean {
    return buckets.value.get(conversationId)?.hasMoreOlder ?? true
  }

  function isLoading(conversationId: string): boolean {
    return buckets.value.get(conversationId)?.loading ?? false
  }

  /**
   * 该会话是否已加载过消息（用户打开过，或已被补偿过）。
   *
   * 用于重连补偿的判断：**未打开过的会话不应补历史** —— 否则会把全部历史
   * 拉进内存（见 ws/handlers.ts 的 stale 过滤注释）。
   */
  function isLoaded(conversationId: string): boolean {
    return buckets.value.get(conversationId)?.loaded ?? false
  }

  /** 群聊「N 人已读」：统计 lastReadSeq >= 某条消息 seq 的成员数（排除自己）。 */
  function readCountFor(conversationId: string, seq: number, selfId: string): number {
    const b = buckets.value.get(conversationId)
    if (!b) return 0
    let count = 0
    for (const [userId, readSeq] of b.memberReadSeqs) {
      if (userId === selfId) continue
      if (readSeq >= seq) count += 1
    }
    return count
  }

  /* ── 写入：唯一入口 ────────────────────────────────────────────── */

  function normalizeWire(m: WireMessage): LocalMessage {
    return {
      localId: m.msgId,
      msgId: m.msgId,
      conversationId: m.conversationId,
      senderId: m.senderId,
      clientMsgId: m.clientMsgId ?? null,
      seq: m.seq,
      type: m.type,
      content: m.content,
      // 防御性拷贝：wire 对象可能被调用方复用，直接挂引用会让两侧共享同一个数组
      attachments: [...(m.attachments ?? [])],
      recalled: m.recalled === true,
      recalledAt: m.recalledAt ?? null,
      replyTo: m.replyTo ?? null,
      createdAt: m.createdAt,
      status: 'sent',
    }
  }

  /**
   * 插入一条服务端消息。已存在则忽略。
   * 若本地有对应 clientMsgId 的乐观消息，用服务端版本替换它（层 1 兑现）。
   */
  function insertOrIgnore(wire: WireMessage): void {
    const b = bucketOf(wire.conversationId)

    // 层 1：兑现乐观消息
    if (wire.clientMsgId) {
      const pending = b.pendingByClientMsgId.get(wire.clientMsgId)
      if (pending) {
        b.pendingByClientMsgId.delete(wire.clientMsgId)
        const idx = b.pending.findIndex((p) => p.localId === pending.localId)
        if (idx >= 0) b.pending.splice(idx, 1)
      }
    }

    // 层 2：按 msgId 去重
    if (b.confirmedById.has(wire.msgId)) {
      // 已确认过的消息可能带着更新的 seq（例如补偿补齐），仅更新元数据不重排
      const existingIdx = b.confirmed.findIndex((m) => m.msgId === wire.msgId)
      if (existingIdx >= 0) b.confirmed[existingIdx] = normalizeWire(wire)
      syncCursor(b, wire.seq)
      return
    }

    b.confirmedById.add(wire.msgId)
    b.confirmed.push(normalizeWire(wire))
    b.confirmed.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))
    syncCursor(b, wire.seq)
    buckets.value.set(wire.conversationId, { ...b })
  }

  function syncCursor(b: ConversationBucket, seq: number): void {
    if (seq > b.lastSeq) b.lastSeq = seq
    if (b.oldestSeq === null || seq < b.oldestSeq) b.oldestSeq = seq
  }

  /**
   * 服务端消息的**覆盖式**写入 —— `message.updated` 专用（撤回是当前的唯一场景）。
   *
   * 与 `insertOrIgnore` 的区别在语义：
   *   - `insertOrIgnore` 是「已存在则忽略」，只适合**追加**新消息；
   *   - 这里是「以服务端最新版本为准」，已存在必须**原地替换**。
   *
   * 【为什么原地替换而不是删了重插】撤回后 `content` 变空串、`attachments` 变空数组，
   * 但消息在时间线上的位置不能变（seq 不变）—— 删了重插会重新排序，可能挪到末尾。
   * 同时必须保留 `status:'sent'`：来自服务端的消息永远是已确认态（normalizeWire 给的就是 sent）。
   *
   * 本地没有这条消息时（例如它还在更早的分页里没加载）必须插入，不能当成
   * 「不关我事」丢弃 —— 否则用户先收到撤回推送、后翻到历史，看到的会是原文。
   */
  function upsertMessage(wire: WireMessage): void {
    const b = bucketOf(wire.conversationId)
    const next = normalizeWire(wire)

    // 层 1：如果这条消息还在 pending（乐观态），先兑现掉，避免同一消息出现两份
    if (wire.clientMsgId) {
      const pending = b.pendingByClientMsgId.get(wire.clientMsgId)
      if (pending) {
        b.pendingByClientMsgId.delete(wire.clientMsgId)
        const pIdx = b.pending.findIndex((p) => p.localId === pending.localId)
        if (pIdx >= 0) b.pending.splice(pIdx, 1)
      }
    }

    const idx = b.confirmed.findIndex((m) => m.msgId === wire.msgId)
    if (idx >= 0) {
      b.confirmed[idx] = next
    } else {
      b.confirmedById.add(wire.msgId)
      b.confirmed.push(next)
      b.confirmed.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))
    }
    syncCursor(b, wire.seq)
    buckets.value.set(wire.conversationId, { ...b })
  }

  /** 批量插入（分页 / 补偿）。 */
  function insertMany(list: WireMessage[]): void {
    for (const m of list) insertOrIgnore(m)
  }

  /**
   * 乐观发送：立即入 pending，返回本地消息。
   * 网络失败或后端确认后由 confirm / markFailed 收尾。
   *
   * 附件消息（v2）：`attachments` 传已上传好的附件数组，`type` 由**附件组合**推导
   * （无附件→text、单一 kind→image/video/file、混合→mixed），与服务端推导规则一致
   * —— 否则本地气泡会先按一种形态渲染、回包后又跳成另一种。
   *
   * `replyTo` 是本地构造的引用快照：发送时服务端还没下发 ReplyRef，但气泡需要
   * 立刻显示出「回复了谁」。字段口径与 normalize.toReplyRef 一致。
   */
  function appendOptimistic(input: {
    conversationId: string
    senderId: string
    content: string
    attachments?: Attachment[]
    replyTo?: ReplyRef | null
  }): LocalMessage {
    const b = bucketOf(input.conversationId)
    const clientMsgId = uuid()
    const attachments = [...(input.attachments ?? [])]
    const msg: LocalMessage = {
      localId: clientMsgId,
      msgId: '',
      conversationId: input.conversationId,
      senderId: input.senderId,
      clientMsgId,
      seq: null,
      type: messageTypeOfAttachments(attachments),
      content: input.content,
      attachments,
      recalled: false,
      recalledAt: null,
      replyTo: input.replyTo ?? null,
      createdAt: new Date().toISOString(),
      status: 'sending',
    }
    b.pending.push(msg)
    b.pendingByClientMsgId.set(clientMsgId, msg)
    buckets.value.set(input.conversationId, { ...b })
    return msg
  }

  /**
   * 标记失败，保留气泡供重试。**返回是否真的标到了一个待发送消息。**
   *
   * 【为什么要有返回值】这个地方曾经藏着一个很气人的假失败：
   *   1. 请求发出，服务端已落库并推进 seq；
   *   2. 客户端 axios 先触发 20s 超时（或 WS `message.created` 先到），
   *      `insertOrIgnore` 已经把这条乐观消息从 `pending` 兑现走了；
   *   3. 紧接着 catch 里的 `markFailed` 找不到 pending → 静默 return；
   *   4. 但调用方无条件弹了个「发送失败」toast。
   * 结果是消息明明发出去了，界面却报失败，用户以为要重发。
   * 有了返回值，调用方只有在「确实标到失败态」时才弹提示，迟到失败不再误报。
   */
  function markFailed(conversationId: string, clientMsgId: string, errorCode?: string): boolean {
    const b = bucketOf(conversationId)
    const p = b.pendingByClientMsgId.get(clientMsgId)
    if (!p) return false
    if (errorCode !== undefined) p.errorCode = errorCode
    p.status = 'failed'
    buckets.value.set(conversationId, { ...b })
    return true
  }

  /** 重试：复用同一 clientMsgId，靠服务端幂等保证不产生重复。 */
  function markRetrying(conversationId: string, clientMsgId: string): void {
    const b = bucketOf(conversationId)
    const p = b.pendingByClientMsgId.get(clientMsgId)
    if (!p) return
    p.status = 'sending'
    delete p.errorCode
    buckets.value.set(conversationId, { ...b })
  }

  /** 取待发送（含失败的）消息，用于重连后按会话保序重发。 */
  function pendingOf(conversationId: string): LocalMessage[] {
    return [...(buckets.value.get(conversationId)?.pending ?? [])]
  }

  function allPending(): LocalMessage[] {
    const out: LocalMessage[] = []
    for (const b of buckets.value.values()) out.push(...b.pending)
    return out
  }

  /* ── 分页与补偿 ────────────────────────────────────────────────── */

  /** 向上翻页：加载更早的消息。 */
  async function loadOlder(conversationId: string, limit = 30): Promise<number> {
    const b = bucketOf(conversationId)
    if (b.loading || !b.hasMoreOlder) return 0
    b.loading = true
    buckets.value.set(conversationId, { ...b })
    const gen = currentEpoch()
    try {
      const params: { limit: number; beforeSeq?: number } = { limit }
      if (b.oldestSeq !== null) params.beforeSeq = b.oldestSeq
      const page = await api.fetchMessages(conversationId, params)
      if (!epochValid(gen)) return 0
      insertMany(page.items)
      const nb = bucketOf(conversationId)
      nb.hasMoreOlder = page.hasMore
      nb.loaded = true
      buckets.value.set(conversationId, { ...nb })
      return page.items.length
    } finally {
      // 同 ensureLoaded：代际失效时不得重建分桶
      if (epochValid(gen)) {
        const nb = bucketOf(conversationId)
        nb.loading = false
        buckets.value.set(conversationId, { ...nb })
      }
    }
  }

  /** 首次加载某会话（最新一页）。 */
  async function ensureLoaded(conversationId: string, limit = 30): Promise<void> {
    const b = bucketOf(conversationId)
    if (b.loaded || b.loading) return
    b.loading = true
    buckets.value.set(conversationId, { ...b })
    // 代际保护：注销/换账号期间回来的历史属于上一个账号，必须丢弃。
    // 否则它会被写进刚被 reset() 清空的 buckets —— 下一个账号登录后
    // 就能看到上一个账号的私聊内容（pm 独立回归的第三条反例）。
    const gen = currentEpoch()
    try {
      const page = await api.fetchMessages(conversationId, { limit })
      if (!epochValid(gen)) return
      insertMany(page.items)
      const nb = bucketOf(conversationId)
      nb.hasMoreOlder = page.hasMore
      nb.loaded = true
      buckets.value.set(conversationId, { ...nb })
    } finally {
      // 【finally 也要判代际】否则 `bucketOf()` 会在 reset() 清空之后
      // **重新创建**一个空分桶，让 buckets.size 又变成 1 —— 残留检查照样失败。
      // 代际已失效时什么都不做：那个桶已经不属于当前账号。
      if (epochValid(gen)) {
        const nb = bucketOf(conversationId)
        nb.loading = false
        buckets.value.set(conversationId, { ...nb })
      }
    }
  }

  /**
   * REST 兜底补齐缺口 —— 断线补偿的第一实现，不依赖 WS sync 帧。
   * 反复分页直到追上服务端最新 seq 或达到安全上限。
   */
  async function catchUp(conversationId: string, maxRounds = 10): Promise<number> {
    const gen = currentEpoch()
    let total = 0
    for (let round = 0; round < maxRounds; round += 1) {
      const afterSeq = lastSeqOf(conversationId)
      const page = await api.fetchMessages(conversationId, { afterSeq, limit: 100 })
      if (!epochValid(gen)) return total
      if (page.items.length === 0) {
        markStale(conversationId, false)
        return total
      }
      insertMany(page.items)
      total += page.items.length
      if (!page.hasMore) {
        markStale(conversationId, false)
        return total
      }
    }
    // 缺口异常大：交给调用方决定是否提示
    markStale(conversationId, true)
    return total
  }

  function markStale(conversationId: string, stale: boolean): void {
    const b = bucketOf(conversationId)
    b.stale = stale
    buckets.value.set(conversationId, { ...b })
  }

  /** 会话被移除时丢弃分桶，避免内存泄漏与误渲染。 */
  function dropBucket(conversationId: string): void {
    buckets.value.delete(conversationId)
    buckets.value = new Map(buckets.value)
  }

  /** 补偿：消费 WS sync 帧的结果。hasMore 为真则回落到 REST 分页。 */
  async function applySyncResult(
    results: Array<{
      conversationId: string
      messages: WireMessage[]
      latestSeq: number
      hasMore: boolean
    }>,
  ): Promise<void> {
    for (const r of results) {
      insertMany(r.messages)
      if (r.hasMore) {
        markStale(r.conversationId, true)
        await catchUp(r.conversationId)
      } else {
        markStale(r.conversationId, false)
      }
    }
  }

  /** 设置会话成员已读游标（来自 ConversationDetail.members[]）。 */
  function seedMemberReadSeqs(
    conversationId: string,
    members: Array<{ user: { id: string }; lastReadSeq: number }>,
  ): void {
    const b = bucketOf(conversationId)
    for (const m of members) b.memberReadSeqs.set(m.user.id, m.lastReadSeq)
    buckets.value.set(conversationId, { ...b })
  }

  /** 单个成员已读游标前进（WS conversation.read）。 */
  function applyMemberReadSeq(conversationId: string, userId: string, lastReadSeq: number): void {
    const b = bucketOf(conversationId)
    const cur = b.memberReadSeqs.get(userId) ?? 0
    if (lastReadSeq <= cur) return
    b.memberReadSeqs.set(userId, lastReadSeq)
    buckets.value.set(conversationId, { ...b })
  }

  /** 缺口检测：收到的 seq 比本地 lastSeq 大超过 1，说明中间丢帧。 */
  function detectGap(conversationId: string, incomingSeq: number): boolean {
    const b = buckets.value.get(conversationId)
    if (!b) return false
    if (b.lastSeq === 0) return false
    return incomingSeq > b.lastSeq + 1
  }

  function reset(): void {
    buckets.value = new Map()
  }

  return {
    buckets,
    messagesOf,
    lastSeqOf,
    hasMoreOlder,
    isLoading,
    isLoaded,
    readCountFor,
    insertOrIgnore,
    insertMany,
    upsertMessage,
    appendOptimistic,
    markFailed,
    markRetrying,
    pendingOf,
    allPending,
    loadOlder,
    ensureLoaded,
    catchUp,
    markStale,
    dropBucket,
    applySyncResult,
    seedMemberReadSeqs,
    applyMemberReadSeq,
    detectGap,
    reset,
  }
})

/** 便于在模板中判断相邻时间是否需要显示时间标签。 */
export type { ConversationBucket }
