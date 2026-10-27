/**
 * WS 一次性票据获取。
 *
 * 三条纪律（见 contracts/requirements/ws-requirements.json）：
 *   1. 禁止缓存 —— 每个 WebSocket 对象配一个新 ticket
 *   2. 单飞 —— 同一时刻只允许一个 in-flight 请求，否则并发重连会打出多个
 *      ticket 而 ticket 是单次的，多出来的全废
 *   3. 失败分类 —— 401 不重试直接登出；429 按 Retry-After；其余退避重试
 */
import { AxiosError } from 'axios'
import { createWsTicket } from '@/api/auth'

export class TicketAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TicketAuthError'
  }
}

export class TicketRateLimitError extends Error {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'TicketRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

let inFlight: Promise<string> | null = null

async function fetchTicketOnce(): Promise<string> {
  const { ticket } = await createWsTicket()
  if (!ticket) {
    throw new Error('后端返回的 ticket 为空')
  }
  return ticket
}

/**
 * 取得一个**全新**的握手票据。
 * 并发调用共享同一次请求（单飞），但每次「重连」都必须重新调用本函数。
 */
export async function getTicket(): Promise<string> {
  if (inFlight) return inFlight

  inFlight = fetchTicketOnce()
    .catch((e: unknown) => {
      if (e instanceof AxiosError) {
        const status = e.response?.status ?? 0
        const code = (e.response?.data as { error?: { code?: string } } | undefined)?.error?.code

        // 401：身份已失效，重试无意义 —— 交给上层登出。
        // 后端 v0.2.0 统一用 UNAUTHORIZED（缺失/失效/注销/过期不再细分），
        // 故按状态码判定即可，同时兼容旧 code 以免误判。
        if (
          status === 401 ||
          code === 'UNAUTHORIZED' ||
          code === 'SESSION_INVALID' ||
          code === 'SESSION_EXPIRED'
        ) {
          throw new TicketAuthError(`票据获取被拒（${code ?? 'UNAUTHORIZED'}）`)
        }

        // 429：限流，按 Retry-After 等待
        if (status === 429) {
          const raw = e.response?.headers?.['retry-after']
          const seconds = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
          const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : 5_000
          throw new TicketRateLimitError('票据获取被限流', retryAfterMs)
        }
      }
      throw e
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** 仅用于测试与诊断。 */
export function __resetTicketState(): void {
  inFlight = null
}
