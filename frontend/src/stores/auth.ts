import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/auth'
import type { User } from '@/api/auth.types'
import { registerSessionHandlers, resetRefreshFailure } from '@/api/http'
import { wsClient } from '@/ws/client'
import { useConversationStore } from './conversation'
import { useFriendStore } from './friend'
import { useMessageStore } from './message'
import { usePresenceStore } from './presence'
import { useUiStore } from './ui'
import { bumpEpoch } from './session'

const TOKEN_KEY = 'aitrance.session'
const EXPIRES_KEY = 'aitrance.sessionExpiresAt'

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeCredentials(token: string | null, expiresAt: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    if (expiresAt) localStorage.setItem(EXPIRES_KEY, expiresAt)
    else localStorage.removeItem(EXPIRES_KEY)
  } catch {
    /* 隐私模式下 localStorage 可能抛错；内存态仍可用，降级为「刷新后需重登」 */
  }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const token = ref<string | null>(readStorage(TOKEN_KEY))
  const expiresAt = ref<string | null>(readStorage(EXPIRES_KEY))
  const status = ref<AuthStatus>('idle')
  const revokedReason = ref<string | null>(null)

  const isAuthenticated = computed(() => token.value !== null && user.value !== null)
  const displayName = computed(() => user.value?.displayName ?? '')
  const userId = computed(() => user.value?.id ?? '')

  let bootstrapped = false
  let refreshTimer: number | null = null

  function applySession(next: { token: string; expiresAt: string }): void {
    token.value = next.token
    expiresAt.value = next.expiresAt
    writeCredentials(next.token, next.expiresAt)
    // 新凭据落地 = 终局失败状态作废：否则下一次真失效时 onUnauthorized
    // 会被上一轮的「已播报」标记吞掉，界面卡在既未登录也不提示的中间态。
    resetRefreshFailure()
    scheduleRefresh()
  }

  /** session 到期前 60s 静默续期，让活跃用户不掉线。 */
  function scheduleRefresh(): void {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (!expiresAt.value) return
    const expiry = Date.parse(expiresAt.value)
    if (!Number.isFinite(expiry)) return
    const delay = Math.max(5_000, expiry - Date.now() - 60_000)
    refreshTimer = window.setTimeout(() => {
      void doRefresh()
    }, delay)
  }

  async function doRefresh(): Promise<string | null> {
    try {
      const session = await api.refreshSession()
      // 后端未实现该端点时返回 null，属预期内 —— 保留现状，等 401 兜底
      if (!session) return null
      applySession(session)
      return session.expiresAt
    } catch (e) {
      console.warn('[auth] session 续期失败', e)
      return null
    }
  }

  /**
   * 清本地身份与**所有业务缓存**。
   *
   * 【为什么必须清业务 store，而不是只清 token】这些 store 装在 Pinia 里，
   * 生命周期比一次登录长得多。只清凭据的话：
   *   - 上一个账号的会话列表、消息、好友仍在内存里，注销后页面还显示着
   *     私密内容（pm 实测：注销后 3 条私密气泡仍在屏幕上）；
   *   - 更严重的是**换账号登录后**，新账号会先看到旧账号的数据，
   *     直到各 store 拉完自己的列表才被覆盖 —— 期间是真实的信息泄露。
   *
   * 顺序：先推进代际（作废所有在途异步回调），再清数据。
   * 反过来会把「清理过程中回来的响应」又写进刚清空的 store。
   *
   * UI store 不清：主题、当前 tab 属设备偏好，与账号无关；
   * 但草稿要清 —— 那是上一个账号的会话内容。
   */
  function clearLocal(): void {
    bumpEpoch()

    user.value = null
    token.value = null
    expiresAt.value = null
    writeCredentials(null, null)
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer)
      refreshTimer = null
    }

    // 清业务缓存。store 之间的相互引用（presence 依赖 conversation/friend）
    // 在这里是安全的：都是已初始化的单例。
    useConversationStore().reset()
    useMessageStore().reset()
    useFriendStore().reset()
    usePresenceStore().reset()
    useUiStore().clearDrafts()
  }

  async function loginWith(input: { username: string; password: string }): Promise<void> {
    status.value = 'loading'
    try {
      const res = await api.login(input)
      user.value = res.user
      applySession(res.session)
      revokedReason.value = null
      status.value = 'authenticated'
      await wsClient.connect()
    } catch (e) {
      status.value = 'anonymous'
      throw e
    }
  }

  async function registerWith(input: {
    username: string
    password: string
    /** 后端 register 的 displayName 为 required + minLength 1，故此处亦必填 */
    displayName: string
  }): Promise<void> {
    status.value = 'loading'
    try {
      const res = await api.register(input)
      user.value = res.user
      applySession(res.session)
      revokedReason.value = null
      status.value = 'authenticated'
      await wsClient.connect()
    } catch (e) {
      status.value = 'anonymous'
      throw e
    }
  }

  /** 冷启动：校验本地 token 是否仍有效。只在首次导航前跑一次。 */
  async function bootstrap(): Promise<void> {
    if (bootstrapped) return
    bootstrapped = true
    if (!token.value) {
      status.value = 'anonymous'
      return
    }
    status.value = 'loading'
    try {
      const res = await api.fetchSession()
      user.value = res.user
      applySession(res.session)
      status.value = 'authenticated'
      await wsClient.connect()
    } catch {
      // token 无效或后端不可达：清凭据，安静跳登录
      clearLocal()
      status.value = 'anonymous'
    }
  }

  async function logout(): Promise<void> {
    wsClient.stop()
    try {
      await api.logout()
    } catch {
      /* 登出失败不应阻塞本地清理 */
    }
    clearLocal()
    status.value = 'anonymous'
  }

  /** 由 WS 或 HTTP 层触发的会话失效。 */
  function onSessionRevoked(reason: string): void {
    if (!token.value) return
    revokedReason.value = reason
    wsClient.stop()
    clearLocal()
    status.value = 'anonymous'
  }

  registerSessionHandlers({
    getToken: () => token.value,
    refresh: () => doRefresh(),
    onUnauthorized: (reason) => onSessionRevoked(reason),
  })

  return {
    user,
    token,
    expiresAt,
    status,
    revokedReason,
    isAuthenticated,
    displayName,
    userId,
    bootstrap,
    loginWith,
    registerWith,
    logout,
    onSessionRevoked,
  }
})
