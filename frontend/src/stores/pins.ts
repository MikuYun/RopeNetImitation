/**
 * 置顶消息 store（ux2-contract §九）。
 *
 * 【为什么单独一个 store】置顶列表的生命周期与「消息分页」完全不同：
 *   - 消息是分页的（向上翻、缺口补齐），置顶是**整体列表**（最多 50 条，一次拿全）；
 *   - 消息属于某个会话的滚动上下文，置顶属于会话的「头部摘要」，会话没打开也要能显示；
 *   - 服务端每次置顶变化都推**完整列表**（`conversation.pins`），是权威快照，
 *     前端整体替换即可 —— 塞进 message store 的分桶里只会让分桶变复杂。
 *
 * 【代际（epoch）保护】登出/换账号时 `stores/auth.ts` 的 `clearLocal()` 会重置
 * 各 store，但它**不在本任务的写入范围**，不能保证会调用本 store 的 `reset()`。
 * 因此这里额外记录「这份数据是在哪个代际加载的」，读取时用 `epochValid()` 校验：
 * 代际一变，旧账号的置顶立刻读不出来，下一个账号登录后也看不到上一个账号的
 * 置顶标题（标题就是消息正文，属于隐私）。这比依赖调用方记得调 reset 更可靠。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/pins'
import { currentEpoch, epochValid } from './session'
import type { PinnedMessage } from '@/types/domain'

/** 单会话置顶上限（ux2-contract §九.2：超过返回 409 PIN_LIMIT）。 */
export const PIN_LIMIT = 50

interface ConvPins {
  items: PinnedMessage[]
  /** 加载这份数据时的会话代际；代际不符即视为空。 */
  epoch: number
}

export const usePinsStore = defineStore('pins', () => {
  const byConv = ref<Map<string, ConvPins>>(new Map())
  const loading = ref<Map<string, boolean>>(new Map())
  const errors = ref<Map<string, string | null>>(new Map())

  function entry(conversationId: string): ConvPins | null {
    const e = byConv.value.get(conversationId)
    if (!e) return null
    // 代际不符 = 上一个账号的数据，读出来即视为不存在
    return epochValid(e.epoch) ? e : null
  }

  function pinsOf(conversationId: string): PinnedMessage[] {
    return entry(conversationId)?.items ?? []
  }

  function isLoading(conversationId: string): boolean {
    return loading.value.get(conversationId) ?? false
  }

  function errorOf(conversationId: string): string | null {
    return errors.value.get(conversationId) ?? null
  }

  function isPinned(conversationId: string, msgId: string): boolean {
    return pinsOf(conversationId).some((p) => p.message.msgId === msgId)
  }

  function pinOf(conversationId: string, msgId: string): PinnedMessage | null {
    return pinsOf(conversationId).find((p) => p.message.msgId === msgId) ?? null
  }

  function setItems(conversationId: string, items: PinnedMessage[], epoch: number): void {
    byConv.value.set(conversationId, { items, epoch })
  }

  function setLoading(conversationId: string, v: boolean): void {
    loading.value.set(conversationId, v)
  }

  function setError(conversationId: string, message: string | null): void {
    errors.value.set(conversationId, message)
  }

  /**
   * 首次加载。
   *
   * `force=false` 且已经有数据时直接返回 —— 置顶条每次进会话都会挂载，
   * 不能每次都打接口。WS 推来 `conversation.pins` 时会自己刷新，所以缓存
   * 不会长期失真。
   */
  async function ensureLoaded(conversationId: string, force = false): Promise<void> {
    if (!conversationId) return
    if (!force && entry(conversationId)) return
    if (isLoading(conversationId)) return

    const gen = currentEpoch()
    setLoading(conversationId, true)
    try {
      const items = await api.listPins(conversationId)
      if (!epochValid(gen)) return
      setItems(conversationId, items, gen)
      setError(conversationId, null)
    } catch (e) {
      if (!epochValid(gen)) return
      // 后端置顶接口未落地（404/501）时不该每进一个会话就弹一次错：
      // 记录到 errors 里，由 UI 决定是否显示「置顶不可用」。
      setError(conversationId, (e as { message?: string }).message ?? '置顶列表加载失败')
      setItems(conversationId, [], gen)
    } finally {
      if (epochValid(gen)) setLoading(conversationId, false)
    }
  }

  async function refresh(conversationId: string): Promise<void> {
    await ensureLoaded(conversationId, true)
  }

  /**
   * 置顶一条消息。
   *
   * 幂等：后端对重复置顶回 200 + 原记录。本地也做一次去重再插入，保证
   * 「本地已经有这条」时不会出现两条相同 msgId 的置顶。
   */
  async function pin(conversationId: string, msgId: string): Promise<PinnedMessage> {
    const gen = currentEpoch()
    const pinned = await api.pinMessage(conversationId, msgId)
    if (!epochValid(gen)) return pinned

    const current = pinsOf(conversationId)
    const rest = current.filter((p) => p.message.msgId !== msgId)
    // 服务端排序是 pinned_at DESC —— 刚置顶的排最前
    const next = [pinned, ...rest].slice(0, PIN_LIMIT)
    setItems(conversationId, next, gen)
    setError(conversationId, null)
    return pinned
  }

  /**
   * 取消置顶。
   *
   * 本地**先删再请求**（乐观）：置顶条上点「取消」要立刻消失，否则用户会
   * 连点。失败时把原记录放回去，并在错误里说明。
   */
  async function unpin(conversationId: string, msgId: string): Promise<void> {
    const gen = currentEpoch()
    const before = pinsOf(conversationId)
    const target = before.find((p) => p.message.msgId === msgId) ?? null
    setItems(
      conversationId,
      before.filter((p) => p.message.msgId !== msgId),
      gen,
    )
    try {
      await api.unpinMessage(conversationId, msgId)
      if (!epochValid(gen)) return
      setError(conversationId, null)
    } catch (e) {
      if (!epochValid(gen)) return
      // 404 PIN_NOT_FOUND 表示「本来就不在了」，本地删除是对的，不算失败
      const code = (e as { code?: string }).code
      if (code !== 'PIN_NOT_FOUND') {
        if (target) {
          const restored = [target, ...pinsOf(conversationId)]
          setItems(conversationId, restored, gen)
        }
        setError(conversationId, (e as { message?: string }).message ?? '取消置顶失败')
      }
    }
  }

  /**
   * WS `conversation.pins` 推来的完整列表 —— 直接整体替换。
   *
   * 不合并的原因：合并需要处理「别人取消了我这边还在」的删除对账，
   * 而服务端给的本来就是全量权威快照，合并只会把 bug 藏起来。
   */
  function applyFromWs(conversationId: string, pins: PinnedMessage[]): void {
    const gen = currentEpoch()
    setItems(conversationId, pins, gen)
    setError(conversationId, null)
  }

  /** 会话被移除/退出时丢弃缓存。 */
  function dropConv(conversationId: string): void {
    byConv.value.delete(conversationId)
    loading.value.delete(conversationId)
    errors.value.delete(conversationId)
  }

  function reset(): void {
    byConv.value = new Map()
    loading.value = new Map()
    errors.value = new Map()
  }

  const total = computed(() => {
    let n = 0
    for (const convId of byConv.value.keys()) n += pinsOf(convId).length
    return n
  })

  return {
    byConv,
    total,
    pinsOf,
    isPinned,
    pinOf,
    isLoading,
    errorOf,
    ensureLoaded,
    refresh,
    pin,
    unpin,
    applyFromWs,
    dropConv,
    reset,
  }
})
