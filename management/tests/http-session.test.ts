import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { http, registerSessionHandlers } from '@/api/http'

let previousAdapter: typeof http.defaults.adapter

function unauthorized(config: InternalAxiosRequestConfig): AxiosError {
  return new AxiosError('unauthorized fixture', 'ERR_BAD_REQUEST', config, undefined, {
    status: 401, statusText: 'Unauthorized', config, headers: {},
    data: { error: { code: 'UNAUTHORIZED', message: 'expired fixture' } },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  previousAdapter = http.defaults.adapter
})

afterEach(() => {
  http.defaults.adapter = previousAdapter
  registerSessionHandlers({ getToken: () => null, refresh: async () => null, onUnauthorized: () => undefined })
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('FE-04 authentication failure terminates and isolates sessions', () => {
  it('401 from the refresh endpoint does not await its own single-flight promise forever', async () => {
    const onUnauthorized = vi.fn()
    const adapter: AxiosAdapter = async config => { throw unauthorized(config) }
    http.defaults.adapter = adapter
    registerSessionHandlers({
      getToken: () => 'a'.repeat(43),
      refresh: async () => {
        try {
          await http.post('/api/v1/auth/session/refresh')
          return '2026-10-09T00:00:00.000Z'
        } catch {
          return null
        }
      },
      onUnauthorized,
    })
    let settled = false
    void http.get('/api/v1/users/me').catch(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect.soft(settled, 'expired identity request must reject, not deadlock').toBe(true)
    expect.soft(onUnauthorized, 'expired identity must trigger terminal handling').toHaveBeenCalled()
  })
})
