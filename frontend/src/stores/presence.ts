import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/presence'
import { TYPING_DISPLAY_TTL_MS } from '@/ws/constants'
import { useConversationStore } from './conversation'
import { useFriendStore } from './friend'

/**
 * 在线状态 + 输入状态。
 *
 * 边界纪律：
 *   - 只存**他人**状态。自己的在线状态由服务端裁定，前端不上报。
 *   - 输入状态的展示必须带 TTL —— 不能信任对端一定发 stop（关页面 / 断网就没有 stop）。
 *   - `GET /presence` 后端未实现时降级为使用列表内嵌的 `User.online` 快照
 *     （见 docs/contract/diff-report.md C3）。
 */
export const usePresenceStore = defineStore('presence', () => {
  const onlineByUserId = ref<Map<string, boolean>>(new Map())
  const lastSeenByUserId = ref<Map<string, string | null>>(new Map())
  /** convId -> (userId -> 过期时间戳) */
  const typingByConv = ref<Map<string, Map<string, number>>>(new Map())
  /** 预取端点是否可用（后端未实现时为 false）。 */
  const prefetchSupported = ref(true)

  let gcTimer: number | null = null
  /** 预取单飞标记：见 prefetch 内的说明。 */
  let prefetchInFlight = false
  /** 触发响应式刷新的计数器：Map 内部变更不会自动追踪。 */
  const tick = ref(0)

  function ensureGc(): void {
    if (gcTimer !== null) return
    gcTimer = window.setInterval(() => {
      let changed = false
      const now = Date.now()
      for (const users of typingByConv.value.values()) {
        for (const [userId, expiresAt] of users) {
          if (expiresAt <= now) {
            users.delete(userId)
            changed = true
          }
        }
      }
      if (changed) tick.value += 1
    }, 1_000)
  }

  function stopGc(): void {
    if (gcTimer !== null) {
      window.clearInterval(gcTimer)
      gcTimer = null
    }
  }

  const onlineCount = computed(() => {
    void tick.value
    let n = 0
    for (const online of onlineByUserId.value.values()) if (online) n += 1
    return n
  })

  function isOnline(userId: string): boolean {
    void tick.value
    if (!userId) return false
    return onlineByUserId.value.get(userId) ?? false
  }

  function lastSeenOf(userId: string): string | null {
    void tick.value
    return lastSeenByUserId.value.get(userId) ?? null
  }

  /** 某会话正在输入的人（不含自己）。 */
  function typingUsersOf(conversationId: string, selfId: string): string[] {
    void tick.value
    const users = typingByConv.value.get(conversationId)
    if (!users) return []
    const now = Date.now()
    const out: string[] = []
    for (const [userId, expiresAt] of users) {
      if (userId === selfId) continue
      if (expiresAt > now) out.push(userId)
    }
    return out
  }

  function isAnyoneTyping(conversationId: string, selfId: string): boolean {
    return typingUsersOf(conversationId, selfId).length > 0
  }

  /* ── 写入 ──────────────────────────────────────────────────────── */

  /**
   * 首屏预取。优先调 `GET /presence`；后端未实现时降级为
   * 使用会话/好友列表里已内嵌的 `online` 快照（diff-report C3）。
   */
  async function prefetch(userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)].filter(Boolean)
    seedFromLists()
    if (unique.length === 0 || !prefetchSupported.value) return

    // 单飞：首屏会有多处在同一 tick 里调 prefetch（ChatView 挂载、MessagePane
    // 进入会话各一次），若不加这道闸，每一处都会先打出一个必然 404 的请求，
    // 控制台刷成一片红，看起来像坏了。等第一次的结论出来再决定后续走不走。
    if (prefetchInFlight) return
    prefetchInFlight = true
    try {
      const result = await api.fetchPresence(unique)
      if (result === null) {
        prefetchSupported.value = false
        console.info('[presence] 后端未实现 /presence，降级为列表内嵌 online 快照')
        return
      }
      for (const p of result) {
        onlineByUserId.value.set(p.userId, p.online)
        lastSeenByUserId.value.set(p.userId, p.lastSeenAt ?? null)
      }
      tick.value += 1
    } catch (e) {
      console.warn('[presence] 预取失败', e)
    } finally {
      prefetchInFlight = false
    }
  }

  /**
   * 从会话成员与好友列表播种在线状态。
   *
   * 必要性：`presence.changed` 只推**变化**，不推当前状态。若首屏不播种，
   * 所有已在线的人都会被显示成离线，直到他恰好上下线一次。
   *
   * 数据来源是 `UserBrief.online`（后端 `User.online` 快照）。若归一化层
   * 漏掉了该字段，这里会静默什么也不做 —— 表现为「绿点永远不亮」。
   */
  function seedFromLists(): void {
    const convStore = useConversationStore()
    const friendStore = useFriendStore()
    let changed = false

    for (const detail of convStore.detailsById.values()) {
      for (const m of detail.members) {
        if (typeof m.user.online === 'boolean') {
          onlineByUserId.value.set(m.user.id, m.user.online)
          changed = true
        }
      }
    }
    for (const f of friendStore.friends) {
      if (typeof f.user.online === 'boolean') {
        onlineByUserId.value.set(f.user.id, f.user.online)
        changed = true
      }
    }
    if (changed) tick.value += 1
  }

  function applyPresenceUpdated(userId: string, online: boolean, lastSeenAt?: string | null): void {
    onlineByUserId.value.set(userId, online)
    if (lastSeenAt !== undefined) lastSeenByUserId.value.set(userId, lastSeenAt)
    tick.value += 1
  }

  function applyTyping(conversationId: string, userId: string, active: boolean): void {
    ensureGc()
    let users = typingByConv.value.get(conversationId)
    if (!users) {
      users = new Map()
      typingByConv.value.set(conversationId, users)
    }
    if (active) {
      users.set(userId, Date.now() + TYPING_DISPLAY_TTL_MS)
    } else {
      users.delete(userId)
    }
    tick.value += 1
  }

  function clearTyping(conversationId: string): void {
    typingByConv.value.delete(conversationId)
    tick.value += 1
  }

  function reset(): void {
    onlineByUserId.value = new Map()
    lastSeenByUserId.value = new Map()
    typingByConv.value = new Map()
    prefetchSupported.value = true
    prefetchInFlight = false
    stopGc()
    tick.value += 1
  }

  return {
    onlineByUserId,
    lastSeenByUserId,
    typingByConv,
    prefetchSupported,
    onlineCount,
    isOnline,
    lastSeenOf,
    typingUsersOf,
    isAnyoneTyping,
    prefetch,
    seedFromLists,
    applyPresenceUpdated,
    applyTyping,
    clearTyping,
    reset,
  }
})
