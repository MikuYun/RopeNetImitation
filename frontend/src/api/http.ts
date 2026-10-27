/**
 * HTTP 传输层。
 *
 * 职责边界：只做传输 —— 注入 Bearer、统一错误映射、401 会话处理。
 * 不做业务编排（那是 store 的事），也不感知后端字段命名（那是 normalize 的事）。
 *
 * 路径策略：后端 openapi 的 path key 内含 `/api/v1`（health 除外，是 `/health`），
 * 故 baseURL 置空、调用处写全路径。见 docs/contract/diff-report.md A1。
 */
import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios'

/** 后端统一错误体：{error:{code,message,traceId}}（v0.2.0）。 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    traceId?: string
  }
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly traceId?: string

  constructor(status: number, code: string, message: string, traceId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (traceId !== undefined) this.traceId = traceId
  }

  /** 后端尚未实现该能力（用于优雅降级）。 */
  get isUnimplemented(): boolean {
    return this.status === 404 || this.status === 501
  }
}

type SessionHandlers = {
  getToken: () => string | null
  refresh: () => Promise<string | null>
  onUnauthorized: (reason: string) => void
}

let handlers: SessionHandlers | null = null

export function registerSessionHandlers(h: SessionHandlers): void {
  handlers = h
}

export const http: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 20_000,
  // 全局默认 Content-Type: application/json。
  //
  // 【已实测，勿改】这里看似会踩到后端「带 Content-Type 但空 body → 400」的坑，
  // 实际不会：axios 在 data 为 undefined/null 时会自行**移除**这个默认头，
  // 于是 ws-ticket / session/refresh / logout 三个无 body 的 POST 都是 200。
  //
  // 反例（试过，不要采纳）：若改为「无 body 时手动 delete Content-Type」，
  // axios 会退回它自己的 POST 默认值 application/x-www-form-urlencoded，
  // 后端直接返回 **415 Unsupported Media Type** —— 比原来的 400 更糟。
  // 若显式置为 undefined 同样 415。所以保持现状是最优解。
  headers: { 'Content-Type': 'application/json' },
})

http.interceptors.request.use((config) => {
  const token = handlers?.getToken() ?? null
  // 【代际快照】记下这发请求出发时的身份。401 回来时若当前 token 已经不同，
  // 说明这是**上一个账号**的在途请求，它的鉴权结论与当前会话无关（见响应拦截器）。
  ;(config as RetriableConfig).__authTokenSnapshot = token
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})

/** 单飞：同一时刻只允许一个续期请求在飞，避免并发 401 打出多次刷新。 */
let refreshInFlight: Promise<string | null> | null = null

/**
 * 续期调用是否已被标记为「终局失败」。
 *
 * 【要解决的问题】refresh 端点自己也返回 401 时会进入死锁：响应拦截器里
 * `refreshSingleFlight()` → refresh 发请求 → 又是 401 → 又进拦截器 →
 * 但此时 `refreshInFlight` 正指向外层那个尚未 resolve 的 promise，于是
 * 内层 **await 自己的外层**，谁都不会先返回，请求永远挂着，
 * `onUnauthorized` 也永远不触发 —— 用户卡在「转圈但没反应」。
 *
 * 出现终局失败时置位，后续 401 直接走登出，不再尝试续期。
 * 登录/续期成功时复位。pm 的 http-session 回归正是此例。
 */
let refreshFailedTerminally = false

/**
 * 本次「终局失败」是否已经通知过上层。
 *
 * 【为什么要去重】续期自身的 401 会走两道处理：内层 `isRefreshCall` 分支先
 * 通知一次，外层发现 `newExpiry === null` 又会落到末尾的 `onUnauthorized`。
 * 两发通知并非无害：`onSessionRevoked` 会 stop WS、清 store、弹错误 toast，
 * 重复一次就是重复的副作用。这里让「同一个终局」只播报一次。
 */
let terminalNotified = false

export function markRefreshFailed(): void {
  refreshFailedTerminally = true
}

export function resetRefreshFailure(): void {
  refreshFailedTerminally = false
  terminalNotified = false
}

/** 终局登出：同一轮终局只播报一次。 */
function notifyTerminal(reason: string): void {
  if (terminalNotified) return
  terminalNotified = true
  handlers?.onUnauthorized(reason)
}

function refreshSingleFlight(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (handlers?.refresh() ?? Promise.resolve(null))
      .then((result) => {
        // 续期没拿到新凭据 = 身份已不可恢复
        if (!result) markRefreshFailed()
        else resetRefreshFailure()
        return result
      })
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

interface RetriableConfig extends AxiosRequestConfig {
  __retriedAfterRefresh?: boolean
  /** 这个请求本身就是续期调用 —— 它遇到 401 时**不能**再去续期。 */
  __isRefreshCall?: boolean
  /** 请求出发时注入的 token 快照（null = 出发时就是未认证状态）。 */
  __authTokenSnapshot?: string | null
}

/**
 * 这发失败的 401 是否属于「已作废的代际」。
 *
 * 【要解决的问题】登出/换账号后，上一个账号的在途请求仍会陆续收到 401。
 * 那时它调 `onUnauthorized` → `auth.onSessionRevoked()`，而后者只判「当前
 * 有没有 token」——**新账号刚登录、token 正存在**，于是旧请求的 401 把
 * 新账号踢下线，用户被迫重新登录。
 *
 * 判据：出发时的 token ≠ 当前 token（含 null ↔ 非 null），即身份边界已跨过，
 * 这发请求的鉴权结论不再适用于当前身份。此时直接抛错，**不**登出、**不**续期。
 */
function isStaleAuthFailure(config: RetriableConfig): boolean {
  if (!('__authTokenSnapshot' in config)) return false
  const current = handlers?.getToken() ?? null
  return (config.__authTokenSnapshot ?? null) !== current
}

/** 续期端点的路径。契约固定，此处用于识别"这个 401 来自续期自身"。 */
const REFRESH_PATH = '/api/v1/auth/session/refresh'

/**
 * 判断这个失败请求是不是续期请求本身。
 *
 * 两条判据并用：
 *   1. 显式标记（api/auth.ts 的 refreshSession 会带上）；
 *   2. URL 命中续期端点 —— 兜住**任何**没走我们这层封装的调用
 *      （例如测试或将来别处直接 http.post 这个路径）。
 * 只靠 1 不够：pm 的回归就直接 http.post 该路径，没有标记。
 * 漏判的代价是死锁，所以这里宁可宽一点。
 */
function isRefreshCall(config: RetriableConfig | undefined): boolean {
  if (!config) return false
  if (config.__isRefreshCall) return true
  const url = config.url ?? ''
  return url.includes(REFRESH_PATH)
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0
    const body = error.response?.data
    const code = body?.error?.code ?? (status === 0 ? 'NETWORK_ERROR' : 'INTERNAL_ERROR')
    const message = body?.error?.message ?? error.message ?? '请求失败'

    const config = error.config as RetriableConfig | undefined

    if (status === 401 && config) {
      // 【先判代际】跨过身份边界的 401 是旧账号的残响：既不登出（会误踢新账号），
      // 也不续期（会把新账号的凭据续成旧账号的）。直接把这发请求判死即可。
      if (isStaleAuthFailure(config)) {
        throw new ApiError(status, code, message, body?.error?.traceId)
      }

      // 【续期自身的 401 = 终局】绝不能再去续期：单飞 promise 此刻正指向
      // 外层那次调用，内层 await 自己 → 永远不 resolve，请求挂着、
      // onUnauthorized 不触发，界面表现为「转圈但没反应」。
      if (isRefreshCall(config)) {
        markRefreshFailed()
        notifyTerminal(code)
        throw new ApiError(status, code, message, body?.error?.traceId)
      }

      // 已知身份不可恢复：不再白试一次续期，直接终局
      if (refreshFailedTerminally) {
        notifyTerminal(code)
        throw new ApiError(status, code, message, body?.error?.traceId)
      }

      if (!config.__retriedAfterRefresh) {
        config.__retriedAfterRefresh = true
        const newExpiry = await refreshSingleFlight()
        if (newExpiry) {
          return http.request(config)
        }
      }
      notifyTerminal(code)
    }

    throw new ApiError(status, code, message, body?.error?.traceId)
  },
)

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  if (axios.isAxiosError(e)) {
    const status = e.response?.status ?? 0
    const body = e.response?.data as ApiErrorBody | undefined
    return new ApiError(
      status,
      body?.error?.code ?? (status === 0 ? 'NETWORK_ERROR' : 'INTERNAL_ERROR'),
      body?.error?.message ?? e.message,
      body?.error?.traceId,
    )
  }
  return new ApiError(0, 'UNKNOWN_ERROR', e instanceof Error ? e.message : String(e))
}
