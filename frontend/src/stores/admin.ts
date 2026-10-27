/**
 * 管理后台状态（ux2-contract §六 / §十四-4）。
 *
 * 【为什么不用 friend store 那种「一次拉全量」写法】
 * 后台用户表的规模是不设上限的（真实环境里成千上万），一次 fetchAllPages 会
 * 拉几百次请求把限流打满（后端硬编码 200 次/分钟/用户）。因此这里保留
 * `nextOffset` 交给 UI 做「加载更多」：首屏只拉一页，滚到底再拉下一页。
 *
 * 【代际保护】沿用 `stores/session.ts` 的 epoch：登出/换账号期间回来的列表响应
 * 不得写进 store —— 否则普通用户登出后立刻用管理员登录，会先闪一屏旧数据。
 * 每个 await 之后都复查 `epochValid(gen)`。
 *
 * 【写后不回全量刷新】禁言/删除成功后只做本地列表修补（见 `applyMute` /
 * `removeLocally`）：分页 offset 在并发增删下会错位，重拉整页可能让用户
 * 当前正在看的行「跳走」。本地修补能保证视口稳定，统计数字单独 refreshStats。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/admin'
import { isMutedNow } from '@/api/normalize'
import { currentEpoch, epochValid } from './session'
import type { User } from '@/api/auth.types'
import type { UserRole } from '@/types/domain'

/**
 * 路由守卫判定（纯函数，便于单测）。
 *
 * 契约 §十四-4：管理后台仅 `role === 'admin'` 可见，非管理员重定向。
 * 单独抽出来有两个原因：
 *   1. `router.beforeEach` 里没法单测（要起 router + pinia + 异步 bootstrap）；
 *   2. 「什么算管理员」这个判断散落在模板/守卫/store 三处时必然漂移。
 *
 * 注意：这只是**可见性**判定，不是安全边界 —— 真正的边界在后端
 * `requireAdmin`（非 admin 一律 403 `ADMIN_REQUIRED`）。
 */
export function canAccessAdmin(role: UserRole | null | undefined): boolean {
  return role === 'admin'
}

/** 用户状态标签（契约 §十四-4 要求展示「正常/被禁用/禁言至 XX」）。 */
export type AdminUserState = 'active' | 'banned' | 'muted'

export function userStateOf(user: Pick<User, 'status' | 'mutedUntil'>, now: number): AdminUserState {
  if (user.status === 'banned') return 'banned'
  // 必须复用 isMutedNow：只看 mutedUntil !== null 会把「已到期的历史禁言」永久显示成禁言
  if (isMutedNow(user, now)) return 'muted'
  return 'active'
}

export const useAdminStore = defineStore('admin', () => {
  const users = ref<User[]>([])
  const stats = ref<api.AdminStats | null>(null)
  /** 已发起过的查询关键词（空串 = 不过滤）。 */
  const query = ref('')
  const nextOffset = ref<number | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const saving = ref(false)
  const statsLoading = ref(false)
  /** 最近一次失败的人话错误（页面顶部展示，不清空列表）。 */
  const error = ref('')

  const hasMore = computed(() => nextOffset.value !== null)
  const isEmpty = computed(() => !loading.value && users.value.length === 0)

  /** 请求代数：只在「最新一次加载」写回，防止快速改查询词时旧响应覆盖新结果。 */
  let requestSeq = 0

  function patchUser(next: User): void {
    const idx = users.value.findIndex((u) => u.id === next.id)
    if (idx >= 0) users.value.splice(idx, 1, next)
  }

  function removeLocally(userId: string): void {
    const idx = users.value.findIndex((u) => u.id === userId)
    if (idx >= 0) users.value.splice(idx, 1)
  }

  /**
   * 首屏 / 换查询词重载。
   *
   * `keyword` 会先 trim 再落库：后端 query 有 maxLength 64，且空白关键词在
   * SQL 上是 `LIKE '% %'`，会意外过滤掉名字里没空格的用户。
   */
  async function load(keyword: string = query.value): Promise<void> {
    const gen = currentEpoch()
    const mine = (requestSeq += 1)
    const trimmed = keyword.trim().slice(0, 64)
    query.value = trimmed
    loading.value = true
    error.value = ''
    try {
      const page = await api.listUsers({ query: trimmed, limit: api.ADMIN_PAGE_LIMIT, offset: 0 })
      if (!epochValid(gen) || mine !== requestSeq) return
      users.value = page.items
      nextOffset.value = page.nextOffset
    } catch (e) {
      if (!epochValid(gen) || mine !== requestSeq) return
      error.value = messageOf(e)
      // 失败时保留旧列表会显示与查询词不符的数据，宁可清空 + 顶部报错
      users.value = []
      nextOffset.value = null
    } finally {
      if (mine === requestSeq) loading.value = false
    }
  }

  /** 加载下一页。`nextOffset === null` 时直接返回（不是错误）。 */
  async function loadMore(): Promise<void> {
    const offset = nextOffset.value
    if (offset === null || loading.value || loadingMore.value) return
    const gen = currentEpoch()
    const mine = requestSeq
    loadingMore.value = true
    error.value = ''
    try {
      const page = await api.listUsers({ query: query.value, limit: api.ADMIN_PAGE_LIMIT, offset })
      if (!epochValid(gen) || mine !== requestSeq) return
      // 去重：期间若有人被禁言/删除触发过重载，同一 id 可能出现两次
      const seen = new Set(users.value.map((u) => u.id))
      for (const item of page.items) if (!seen.has(item.id)) users.value.push(item)
      nextOffset.value = page.nextOffset
    } catch (e) {
      if (!epochValid(gen) || mine !== requestSeq) return
      error.value = messageOf(e)
    } finally {
      if (mine === requestSeq) loadingMore.value = false
    }
  }

  async function refreshStats(): Promise<void> {
    const gen = currentEpoch()
    statsLoading.value = true
    try {
      const next = await api.fetchAdminStats()
      if (!epochValid(gen)) return
      stats.value = next
    } catch (e) {
      if (!epochValid(gen)) return
      error.value = messageOf(e)
    } finally {
      statsLoading.value = false
    }
  }

  /**
   * 禁言（`minutes === 0` 即解除）。
   *
   * 成功后：本地修补该行 + 刷新统计（禁言不改用户数，但保持「列表与统计来自
   * 同一次操作之后」的一致性对验收很重要）。失败把错误往上抛，由页面弹 toast。
   */
  async function mute(uid: number, minutes: number): Promise<User> {
    const gen = currentEpoch()
    saving.value = true
    error.value = ''
    try {
      const next = await api.muteUser(uid, minutes)
      if (epochValid(gen)) patchUser(next)
      return next
    } finally {
      saving.value = false
    }
  }

  /** 解除禁言。语义等价 `mute(uid, 0)`，单独留一个名字让调用点自解释。 */
  async function unmute(uid: number): Promise<User> {
    return mute(uid, 0)
  }

  /**
   * 删除账号。
   *
   * 成功后本地移除该行并刷新统计 —— 但**不**重拉列表：删掉一行后当前页少一条，
   * 重拉会把下一条顶上来，看似更满，实际会让正在逐个清理的管理员迷失位置。
   * 缺点是被删用户若原本在下一页，页码会留一个与后端不一致的空档，
   * 因此统计必须重拉（用户数已变）。
   */
  async function remove(user: User): Promise<void> {
    const gen = currentEpoch()
    saving.value = true
    error.value = ''
    try {
      await api.deleteUser(user.uid)
      if (epochValid(gen)) removeLocally(user.id)
      if (epochValid(gen)) void refreshStats()
    } finally {
      saving.value = false
    }
  }

  function reset(): void {
    requestSeq += 1
    users.value = []
    stats.value = null
    query.value = ''
    nextOffset.value = null
    loading.value = false
    loadingMore.value = false
    saving.value = false
    statsLoading.value = false
    error.value = ''
  }

  return {
    users,
    stats,
    query,
    nextOffset,
    loading,
    loadingMore,
    saving,
    statsLoading,
    error,
    hasMore,
    isEmpty,
    load,
    loadMore,
    refreshStats,
    mute,
    unmute,
    remove,
    reset,
  }
})

/** 把 ApiError / Error 收敛成一句可展示的话，避免页面里到处 `catch (e: any)`。 */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message.length > 0) return e.message
  return '请求失败，请稍后重试'
}
