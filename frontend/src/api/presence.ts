/**
 * 在线状态端点。
 *
 * 后端 v0.2.0 **未提供** `GET /presence`（契约里是 deferred 端点 X3，
 * 见 contracts/requirements/rest-requirements.json 的 deferredEndpoints）。
 * 在线状态的来源是：
 *   1. 列表内嵌的 `User.online`（会话详情 members[]、好友列表）
 *   2. WS `presence.changed` `{userId, online}` 推送（**无 lastSeenAt**）
 *
 * 本模块保留调用入口，供后端日后补该端点时启用（把下面的开关打开即可）。
 * 默认**不主动探测**，理由见开关处的注释。
 */
import { http, toApiError } from './http'
import type { PresenceState } from '@/types/domain'

/**
 * 是否主动探测该端点。
 *
 * 【为什么默认关】探测一个已知不存在的端点，代价是**每次页面加载都会在浏览器
 * 控制台留一条红色 404**。Chrome 的网络层自己打这行红字，前端拦不掉
 * （axios 的 validateStatus 只影响是否抛异常，不影响浏览器记日志）。
 * 实测：首屏 ChatView 与 MessagePane 会各触发一次，控制台看起来像坏了，
 * 浏览器验收的「无未预期控制台错误」也永远过不了。
 *
 * 契约已明确该端点是 deferred、且降级路径（列表内嵌 online 快照）就是
 * 约定的 fallback，所以不探测才是符合契约的行为。
 *
 * 后端补上该端点后：把这里改成 `true` 即可，无需其它改动。
 */
const PROBE_PRESENCE_ENDPOINT = false

interface WirePresence {
  userId: string
  online: boolean
  lastSeenAt: string | null
}

export async function fetchPresence(userIds: string[]): Promise<PresenceState[] | null> {
  if (userIds.length === 0) return []
  if (!PROBE_PRESENCE_ENDPOINT) return null
  try {
    const { data } = await http.get<{ items: WirePresence[] }>('/api/v1/presence', {
      params: { userIds: userIds.join(',') },
    })
    return data.items
  } catch (e) {
    // 【勿改回 `(e as {status}).status`】axios 抛的是 AxiosError，它的 `status`
    // 在顶层是 undefined（真正的状态码在 `e.response.status`）。原来的写法因此
    // **永远判不出 404**，于是把"端点未实现"当成真错误继续向上抛。
    // 统一走 toApiError，它已经把 e.response.status 取出来了。
    if (toApiError(e).isUnimplemented) return null
    throw e
  }
}
