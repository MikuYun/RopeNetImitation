/**
 * HTTP 传输层 401 语义的回归测试（SEC-02 竞态门禁）。
 *
 * 三条纪律，每条都用一个**真实构造的竞态**验证，而不是只断言函数被调用：
 *
 *   1. 续期自身的 401 = 终局：绝不能再进续期，否则内层 await 自己那发
 *      单飞 promise，请求永远挂着、onUnauthorized 永不触发（界面「转圈」）。
 *   2. 并发 401 单飞：多发自愈请求同时过期时只允许一次续期，否则会把一次性
 *      的会话续期打成多次（后端每次续期都换 token，旧 token 立即作废）。
 *   3. 代际隔离：换账号后，**上一个账号**的在途请求回来的 401 不得踢掉新账号。
 *      讲述方式：adapter 收到请求时先让「当前 token」切成新账号的，再抛 401。
 */
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  http,
  markRefreshFailed,
  registerSessionHandlers,
  resetRefreshFailure,
} from '@/api/http'

const TOKEN_A = 'a'.repeat(43)
const TOKEN_B = 'b'.repeat(43)

let previousAdapter: typeof http.defaults.adapter

/** 构造一发自然后端会给出的 401（带 v0.2.0 统一错误体）。 */
function unauthorized(
  config: InternalAxiosRequestConfig,
  code = 'UNAUTHORIZED',
): AxiosError {
  return new AxiosError('unauthorized fixture', 'ERR_BAD_REQUEST', config, undefined, {
    status: 401,
    statusText: 'Unauthorized',
    config,
    headers: {},
    data: { error: { code, message: 'expired fixture' } },
  })
}

function restoreHandlers(): void {
  registerSessionHandlers({
    getToken: () => null,
    refresh: async () => null,
    onUnauthorized: () => undefined,
  })
}

beforeEach(() => {
  previousAdapter = http.defaults.adapter
  resetRefreshFailure()
  restoreHandlers()
})

afterEach(() => {
  http.defaults.adapter = previousAdapter
  restoreHandlers()
  resetRefreshFailure()
  vi.restoreAllMocks()
})

describe('http 401 续期与代际隔离', () => {
  it('续期端点自身返回 401 时终局退出，不死锁、只触发一次 onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    let refreshCalls = 0

    // 后端行为：续期也 401（身份彻底不可恢复）
    const adapter: AxiosAdapter = async (config) => {
      throw unauthorized(config as InternalAxiosRequestConfig)
    }
    http.defaults.adapter = adapter

    registerSessionHandlers({
      getToken: () => TOKEN_A,
      refresh: async () => {
        refreshCalls += 1
        try {
          await http.post('/api/v1/auth/session/refresh')
          return '2026-10-22T00:00:00.000Z'
        } catch {
          return null
        }
      },
      onUnauthorized,
    })

    let settled = false
    const pending = http.get('/api/v1/users/me').catch((e: unknown) => {
      settled = true
      return e
    })

    // 若死锁，这里的 await 会一直挂着；用超时兜住并显式失败
    const outcome = await Promise.race([
      pending,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ])

    expect(outcome, '续期自身 401 必须结束请求，不得内层 await 自己').not.toBe('timeout')
    expect(settled).toBe(true)
    expect(outcome).toBeInstanceOf(ApiError)
    expect((outcome as ApiError).status).toBe(401)
    // 关键：只续期一次 —— 续期失败后不再无限重试
    expect(refreshCalls).toBe(1)
    // 关键：终局回调恰好一次（多余一次会造成重复 toast / 重复清空）
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('并发多个 401 只打一次续期（单飞），且成功后各自重放一次', async () => {
    const onUnauthorized = vi.fn()
    let refreshCalls = 0
    const replays: string[] = []

    http.defaults.adapter = (async (config) => {
      const url = config.url ?? ''
      if (url.includes('/auth/session/refresh')) {
        refreshCalls += 1
        // 让单飞窗口足够宽：三个请求的 401 都会落在这段时间里
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          data: { token: TOKEN_B, expiresAt: '2026-10-22T01:00:00.000Z' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }
      }
      if (config.headers.get('Authorization') === `Bearer ${TOKEN_B}`) {
        replays.push(url)
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }
      }
      throw unauthorized(config as InternalAxiosRequestConfig)
    }) as AxiosAdapter

    let currentToken: string | null = TOKEN_A
    registerSessionHandlers({
      getToken: () => currentToken,
      refresh: async () => {
        refreshCalls += 1
        const r = await http.post('/api/v1/auth/session/refresh', undefined, {
          __isRefreshCall: true,
        } as never)
        currentToken = (r.data as { token: string }).token
        return (r.data as { expiresAt: string }).expiresAt
      },
      onUnauthorized,
    })

    const results = await Promise.all([
      http.get('/api/v1/conversations'),
      http.get('/api/v1/friends'),
      http.get('/api/v1/users/me'),
    ])

    // 注意：refresh 回调里也 +1，所以这里期望的是「HTTP 层只发了一次续期请求」
    expect(refreshCalls).toBe(2) // 1 次 handlers.refresh + 1 次内部 POST
    expect(replays).toHaveLength(3)
    expect(results).toHaveLength(3)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('换账号后旧 token 在途请求的 401 不踢新账号（不登出、不续期）', async () => {
    const onUnauthorized = vi.fn()
    const refresh = vi.fn(async () => '2026-10-22T01:00:00.000Z')
    let currentToken: string | null = TOKEN_A

    // 竞态的真实形态：请求带着 TOKEN_A 出发，响应回来前账号已经换成 TOKEN_B
    http.defaults.adapter = (async (config) => {
      currentToken = TOKEN_B
      throw unauthorized(config as InternalAxiosRequestConfig)
    }) as AxiosAdapter

    registerSessionHandlers({
      getToken: () => currentToken,
      refresh,
      onUnauthorized,
    })

    const err = await http.get('/api/v1/conversations').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    // 核心断言：旧账号的 401 **不能**触发登出，否则新账号被误踢
    expect(onUnauthorized).not.toHaveBeenCalled()
    // 也不能去续期：那会用新账号的凭据续出旧账号的结论
    expect(refresh).not.toHaveBeenCalled()
  })

  it('同一代的 401 仍然正常走续期并登出（代际隔离不吞掉真失效）', async () => {
    const onUnauthorized = vi.fn()
    const refresh = vi.fn(async () => null) // 续期也拿不到凭据

    http.defaults.adapter = (async (config) => {
      throw unauthorized(config as InternalAxiosRequestConfig, 'SESSION_EXPIRED')
    }) as AxiosAdapter

    const token = TOKEN_A
    registerSessionHandlers({
      getToken: () => token, // 全程同一身份，不是代际问题
      refresh,
      onUnauthorized,
    })

    const err = await http.get('/api/v1/friends').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith('SESSION_EXPIRED')
  })

  it('已知终局失败时不再白试续期，直接登出', async () => {
    const onUnauthorized = vi.fn()
    const refresh = vi.fn(async () => null)
    markRefreshFailed() // 例如上一发续期刚刚失败

    http.defaults.adapter = (async (config) => {
      throw unauthorized(config as InternalAxiosRequestConfig)
    }) as AxiosAdapter

    registerSessionHandlers({ getToken: () => TOKEN_A, refresh, onUnauthorized })

    const err = await http.get('/api/v1/users/me').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(refresh).not.toHaveBeenCalled()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})
