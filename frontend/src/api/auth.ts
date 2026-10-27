/**
 * 认证端点。路径与响应以后端 openapi.json **v0.2.0** 为准。
 *
 * 后端返回扁平结构 `{token, tokenType:'Bearer', expiresAt, user}`，
 * 本模块归一化为内部 `{session:{token,expiresAt}, user}`，使 store 无需感知。
 */
import { http, ApiError } from './http'
import { toUser } from './normalize'
import type { WireAuthResult, WireHealth, WireWsTicket } from './wire'
import type { User } from './auth.types'

export type { User } from './auth.types'
export interface Session {
  token: string
  expiresAt: string
}
export interface AuthResult {
  user: User
  session: Session
}

function normalizeAuth(r: WireAuthResult): AuthResult {
  return {
    user: toUser(r.user),
    session: { token: r.token, expiresAt: r.expiresAt },
  }
}

/**
 * 注册。
 *
 * 【契约硬要求】后端 v0.2.0 把 `displayName` 列为 **required**，且 schema 有
 * `minLength: 1` —— 缺字段或传空串都会 400 VALIDATION_ERROR（已实测确认）。
 * 因此本函数强制要求调用方提供非空的 displayName，不再「有才带」。
 * 调用方（RegisterView）负责在用户未填时回填 username。
 */
export async function register(input: {
  username: string
  password: string
  displayName: string
}): Promise<AuthResult> {
  const displayName = input.displayName.trim()
  if (!displayName) {
    // 提前拦截，避免打到后端才 400 —— 这里的错误消息面向开发者，不是用户
    throw new ApiError(400, 'VALIDATION_ERROR', 'displayName 不能为空（后端 schema 要求 minLength 1）')
  }
  const { data } = await http.post<WireAuthResult>('/api/v1/auth/register', {
    username: input.username,
    password: input.password,
    displayName,
  })
  return normalizeAuth(data)
}

export async function login(input: { username: string; password: string }): Promise<AuthResult> {
  const { data } = await http.post<WireAuthResult>('/api/v1/auth/login', input)
  return normalizeAuth(data)
}

export async function logout(): Promise<void> {
  await http.post('/api/v1/auth/logout')
}

/** 冷启动校验会话有效性（v0.2.0 已实现该端点）。 */
export async function fetchSession(): Promise<AuthResult> {
  const { data } = await http.get<WireAuthResult>('/api/v1/auth/session')
  return normalizeAuth(data)
}

/**
 * 滑动续期。后端语义：**同一个 token**，只延后 expiresAt，不轮换。
 * 建议在过期前 60 秒调用；已过期/已注销返回 401，不能靠 refresh 复活。
 *
 * 标记 `__isRefreshCall`：让响应拦截器知道这个请求**自己就是续期**，
 * 它遇到 401 时必须直接终局登出，而不是再去续期 —— 后者会让单飞 promise
 * 等待自身，永远不 resolve（pm 的 http-session 回归）。
 */
export async function refreshSession(): Promise<Session> {
  const { data } = await http.post<WireAuthResult>('/api/v1/auth/session/refresh', undefined, {
    __isRefreshCall: true,
  } as never)
  return { token: data.token, expiresAt: data.expiresAt }
}

/** 一次性 WS 握手票据。TTL 30 秒，只可消费一次。 */
export async function createWsTicket(): Promise<{ ticket: string; expiresIn: number }> {
  const { data } = await http.post<WireWsTicket>('/api/v1/auth/ws-ticket')
  return data
}

/** 健康检查。v0.2.0 同时提供 /health 与 /api/v1/health。 */
export async function fetchHealth(): Promise<WireHealth> {
  const { data } = await http.get<WireHealth>('/api/v1/health')
  return data
}
