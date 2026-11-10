import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/conversations'
import { resetReadSync } from '@/utils/readSync'
import { useAuthStore } from './auth'
import { currentEpoch, epochValid } from './session'
import type { ConversationDetail, ConversationSummary } from '@/types/domain'

export const useConversationStore = defineStore('conversation', () => {
  const summariesById = ref<Map<string, ConversationSummary>>(new Map())
  /** 服务端给的顺序（updatedAt desc）。前端不二次排。 */
  const orderedIds = ref<string[]>([])
  const detailsById = ref<Map<string, ConversationDetail>>(new Map())
  const activeId = ref<string | null>(null)
  /**
   * **正在阅读**的会话 —— 与 activeId 刻意分开。
   *
   * activeId 表示「当前会话是谁」，由路由派生，桌面端一边看列表一边开着会话
   * 时它一直有值。而「正在阅读」是**已读判定的唯一依据**：只有消息正文确实
   * 渲染在屏幕上、且页面本身可见时才算在读。
   *
   * 【为什么必须分开】写这段之前，已读判定用的是 activeId，于是：
   *   - 手机端用户停在**会话列表**时，activeId 仍指向上次打开的会话
   *     （路由退出正文后 MessagePane 已卸载，但 activeId 未必被清）；
   *   - 桌面端用户在**联系人 tab**、列表被 v-show 隐藏时，正文仍在 DOM 里；
   * 两种情况新消息一到就被自动上报已读，未读数永远清空，用户根本不知道
   * 有人找过他。任务书写死了这条门禁。
   */
  const readingId = ref<string | null>(null)
  const loading = ref(false)
  const loaded = ref(false)

  function selfId(): string {
    return useAuthStore().userId
  }

  const list = computed<ConversationSummary[]>(() =>
    orderedIds.value
      .map((id) => summariesById.value.get(id))
      .filter((c): c is ConversationSummary => !!c),
  )

  const active = computed<ConversationSummary | null>(() =>
    activeId.value ? (summariesById.value.get(activeId.value) ?? null) : null,
  )

  const activeDetail = computed<ConversationDetail | null>(() =>
    activeId.value ? (detailsById.value.get(activeId.value) ?? null) : null,
  )

  const totalUnread = computed(() => list.value.reduce((s, c) => s + (c.unreadCount ?? 0), 0))

  function reorder(): void {
    orderedIds.value = [...summariesById.value.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((c) => c.id)
  }

  function upsertSummary(next: ConversationSummary, opts: { keepPosition?: boolean } = {}): void {
    const existing = summariesById.value.get(next.id)
    if (existing && opts.keepPosition) {
      summariesById.value.set(next.id, { ...existing, ...next })
      return
    }
    summariesById.value.set(next.id, next)
    if (!orderedIds.value.includes(next.id)) orderedIds.value.unshift(next.id)
    reorder()
  }

  function removeSummary(id: string): void {
    summariesById.value.delete(id)
    detailsById.value.delete(id)
    orderedIds.value = orderedIds.value.filter((x) => x !== id)
    if (activeId.value === id) activeId.value = null
  }

  function setActive(id: string | null): void {
    activeId.value = id
  }

  /**
   * 设置「正在阅读」的会话。传 null 表示当前没有在真正阅读任何会话。
   * 由 MessagePane 在**正文可见且页面可见**时调用（见 useVisibility 的说明）。
   */
  function setReading(id: string | null): void {
    if (readingId.value === id) return
    // 离开旧会话时，把它的乐观未读清掉之前的阅读标记；未读仍以服务端为准
    readingId.value = id
  }

  /** 当前是否正在真正阅读该会话 —— 已读上报的唯一门禁。 */
  function isReading(id: string): boolean {
    return readingId.value === id
  }

  /**
   * 本地乐观清零未读。只做显示 —— 服务端推来权威值即以服务端为准。
   * 不要在前端自己累加未读数。
   *
   * 注意：markRead 内部已不再调用它（那条路径需要「失败可回滚」，见
   * markRead 内注释）。保留导出是因为它是「只改显示」这一语义的
   * 独立入口，之后做「进入会话立即消红点」之类的交互会用到。
   */
  function clearUnreadLocally(id: string): void {
    const cur = summariesById.value.get(id)
    if (!cur || cur.unreadCount === 0) return
    summariesById.value.set(id, { ...cur, unreadCount: 0 })
  }

  async function fetchAll(): Promise<void> {
    const me = selfId()
    if (!me) return
    // 记下出发时的代际：注销/换账号期间回来的响应一律丢弃，
    // 否则上一个账号的会话列表会被写进已清空的 store
    const gen = currentEpoch()
    loading.value = true
    try {
      const items = await api.fetchConversations(me)
      if (!epochValid(gen)) return
      summariesById.value = new Map(items.map((c) => [c.id, c]))
      reorder()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function fetchDetail(id: string): Promise<ConversationDetail | null> {
    const me = selfId()
    const gen = currentEpoch()
    const detail = await api.fetchConversation(id, me)
    if (!epochValid(gen)) return null
    detailsById.value.set(id, detail)
    upsertSummary(detail, { keepPosition: true })
    return detail
  }

  async function ensureDetail(id: string): Promise<ConversationDetail | null> {
    const cached = detailsById.value.get(id)
    if (cached) return cached
    try {
      return await fetchDetail(id)
    } catch (e) {
      console.warn('[conversation] 拉取会话详情失败', e)
      return null
    }
  }

  async function createDirect(peerUserId: string): Promise<ConversationSummary> {
    const conv = await api.createDirect(peerUserId, selfId())
    upsertSummary(conv)
    return conv
  }

  async function createGroup(name: string, memberIds: string[]): Promise<ConversationSummary> {
    // 建群不乐观插入：id 需服务端生成，等返回再入列表
    const conv = await api.createGroup(name, memberIds, selfId())
    upsertSummary(conv)
    return conv
  }

  async function addMembers(id: string, memberIds: string[]): Promise<void> {
    const detail = await api.addMembers(id, memberIds, selfId())
    // 整体替换缓存，不做增量猜测
    detailsById.value.set(id, detail)
    upsertSummary(detail, { keepPosition: true })
  }

  async function removeMember(id: string, userId: string): Promise<void> {
    // 后端返回 {ok:true} 不含会话对象（diff-report C2），故移除后重新拉详情校准
    await api.removeMember(id, userId)
    await fetchDetail(id)
  }

  async function rename(id: string, name: string): Promise<void> {
    const conv = await api.renameConversation(id, name, selfId())
    upsertSummary(conv, { keepPosition: true })
  }

  /**
   * 每个会话的已读上报代际。
   *
   * 【为什么需要】markRead 是「乐观置 0 → 发请求 → 失败回滚」的模式。
   * 同一会话可能有两发并发在飞（例如快速连点、或自动已读与手动已读撞上）。
   * 如果旧的那发**后**失败，它会按自己出发时的快照回滚 —— 把**新那发已经
   * 成功的结果**一起抹掉，界面上红点又回来了，而服务端其实是已读的。
   *
   * 所以每发上报先领一个序号，回滚前确认「我仍是这个会话最新的一发」，
   * 否则什么都不做（后来者已经给出更权威的状态）。
   */
  const readGenByConv = ref<Map<string, number>>(new Map())

  async function markRead(id: string, lastReadSeq: number): Promise<void> {
    const prev = summariesById.value.get(id)
    if (!prev) return

    const myGen = (readGenByConv.value.get(id) ?? 0) + 1
    readGenByConv.value.set(id, myGen)

    // 记录回滚点：上报失败时要把乐观结果原样退回去
    const snapshot = { ...prev }

    // 乐观：仅本地显示。authoritative 由服务端 conversation.read 推送覆盖
    summariesById.value.set(id, {
      ...prev,
      unreadCount: 0,
      lastReadSeq: Math.max(prev.lastReadSeq, lastReadSeq),
    })

    try {
      // 后端返回 204 无正文（diff-report C1）
      await api.markRead(id, lastReadSeq)
    } catch (e) {
      /**
       * 【失败必须回滚】之前这里只 `console.warn` 就把错误吞了，而 unreadCount
       * 早已被清零 —— 界面上红点消失、看起来「已读成功」，实际上服务端根本
       * 没收到，刷新后又冒出来。用户在两个状态之间被来回骗。
       *
       * 但**只有仍是最新一发时才回滚**：否则会把后来那发成功的结果覆盖掉。
       * 回滚也叠在当前值上（而非整体覆盖快照），失败期间推来的新消息不能一起被抹掉。
       */
      const stillLatest = readGenByConv.value.get(id) === myGen
      if (stillLatest) {
        const cur = summariesById.value.get(id)
        if (cur) {
          summariesById.value.set(id, {
            ...cur,
            unreadCount: snapshot.unreadCount,
            lastReadSeq: Math.min(cur.lastReadSeq, snapshot.lastReadSeq),
          })
        }
      }
      console.warn('[conversation] 已读上报失败，已回滚未读显示', e)
      throw e
    }
  }

  /** 他人已读游标前进（WS conversation.read）。用于群聊「N 人已读」。 */
  function applyReadReceipt(id: string, userId: string, lastReadSeq: number): void {
    const detail = detailsById.value.get(id)
    if (!detail) return
    const idx = detail.members.findIndex((m) => m.user.id === userId)
    if (idx < 0) return
    const member = detail.members[idx]!
    if (lastReadSeq <= member.lastReadSeq) return
    const members = [...detail.members]
    members[idx] = { ...member, lastReadSeq }
    detailsById.value.set(id, { ...detail, members })
  }

  function reset(): void {
    summariesById.value = new Map()
    detailsById.value = new Map()
    orderedIds.value = []
    activeId.value = null
    readingId.value = null
    readGenByConv.value = new Map()
    loaded.value = false
    // 登出/换账号：WS 推送路径攒下的待发已读必须一起丢掉，
    // 否则会把上个账号的 seq 发到下个账号的会话上
    resetReadSync()
  }

  return {
    summariesById,
    orderedIds,
    detailsById,
    activeId,
    readingId,
    loading,
    loaded,
    list,
    active,
    activeDetail,
    totalUnread,
    upsertSummary,
    removeSummary,
    setActive,
    setReading,
    isReading,
    clearUnreadLocally,
    fetchAll,
    fetchDetail,
    ensureDetail,
    createDirect,
    createGroup,
    addMembers,
    removeMember,
    rename,
    markRead,
    applyReadReceipt,
    reset,
  }
})
