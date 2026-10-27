/**
 * WS 客户端的「旧连接不得污染新连接」竞态门禁（SEC-02）。
 *
 * 这里用**手写的假 WebSocket** 而不是 msw：需要精确控制「谁在什么时候
 * 回调」，才能构造出真实竞态的时间线：
 *
 *   1. ticket 还在飞的时候用户点了登出 → 迟到的 ticket 绝不能建 socket
 *      （否则新账号登录后会被一条旧账号的连接挤占）；
 *   2. 旧 socket 的 onmessage / onclose 在**新连接已建立后**才被触发
 *      （浏览器里真的会发生：close 事件是异步派发的）→ 旧帧不能进 store，
 *      旧 close 不能把新连接打回 reconnecting；
 *   3. 4003（服务端会话过期）应当走 onAuthFailed，且之后不再重连。
 */
import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ticketCtl = vi.hoisted(() => ({
  next: null as null | (() => Promise<{ ticket: string }>),
}))

vi.mock('@/api/auth', () => ({
  createWsTicket: () => {
    if (!ticketCtl.next) throw new Error('测试未设置 ticket handler')
    return ticketCtl.next()
  },
}))

import { WsClient, type ConnState } from '@/ws/client'
import { __resetTicketState } from '@/ws/ticket'


class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closeCalls: Array<{ code?: number; reason?: string }> = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: MessageEvent<string>) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  /* 测试驱动口 */
  finishOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  emitFrame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }

  fireClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason: '' } as CloseEvent)
  }
}

function readyEnvelope(): Record<string, unknown> {
  return {
    v: 1,
    type: 'ready',
    timestamp: new Date().toISOString(),
    data: { userId: 'u1', protocolVersion: 1 },
  }
}

function messageEnvelope(content: string): Record<string, unknown> {
  return {
    v: 1,
    type: 'message.created',
    timestamp: new Date().toISOString(),
    data: { content },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeClient(): {
  client: WsClient
  frames: unknown[]
  authFailures: string[]
  states: ConnState[]
} {
  const client = new WsClient()
  const frames: unknown[] = []
  const authFailures: string[] = []
  const states: ConnState[] = []
  client.setEvents({
    onState: (s) => states.push(s),
    onFrame: (env) => frames.push(env),
    onAuthFailed: (r) => authFailures.push(r),
  })
  return { client, frames, authFailures, states }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  ticketCtl.next = null
  __resetTicketState()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WsClient 连接代际隔离', () => {
  it('ticket 在飞时 stop()，迟到拿到的 ticket 不得建连', async () => {
    const { client, frames, authFailures } = makeClient()
    const gate = deferred<{ ticket: string }>()
    ticketCtl.next = () => gate.promise

    const connecting = client.connect()
    // 此刻 openOnce 正 await getTicket()，用户点了登出
    client.stop()
    expect(client.getState()).toBe('stopped')

    gate.resolve({ ticket: 't'.repeat(43) })
    await connecting

    // 核心断言：没有任何 WebSocket 被创建 —— 否则旧账号的连接会挂在
    // 新账号的会话上，且它用的是已作废的 ticket
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(client.getState()).toBe('stopped')
    expect(frames).toHaveLength(0)
    expect(authFailures).toHaveLength(0)
  })

  it('旧 socket 在新连接建立后迟到的 onmessage / onclose 均被丢弃', async () => {
    const { client, frames, states } = makeClient()
    ticketCtl.next = async () => ({ ticket: 'a'.repeat(43) })

    await client.connect()
    const first = FakeWebSocket.instances[0]!
    // 保存旧回调：浏览器真实情况下 close/message 事件是排队派发的，
    // stop() 之后仍会执行到我们保存下来的这两个闭包
    const staleMessage = first.onmessage
    const staleClose = first.onclose

    client.stop()
    ticketCtl.next = async () => ({ ticket: 'b'.repeat(43) })
    await client.connect()
    const second = FakeWebSocket.instances[1]!
    expect(second).not.toBe(first)

    second.finishOpen()
    second.emitFrame(readyEnvelope())
    expect(client.getState()).toBe('open')
    const framesBefore = frames.length

    // 旧连接残响
    staleMessage?.({ data: JSON.stringify(messageEnvelope('旧账号的消息')) } as MessageEvent<string>)
    staleClose?.({ code: 1006, reason: '' } as CloseEvent)

    expect(frames.length).toBe(framesBefore) // 旧帧没进分发器
    expect(client.getState()).toBe('open') // 旧 close 没把新连接打成 reconnecting
    expect(states).not.toContain('reconnecting')
    expect(FakeWebSocket.instances).toHaveLength(2) // 也没有被旧 close 触发重连
  })

  it('新连接建立前的旧 socket onclose 不触发重连（stop 已把回调摘掉）', async () => {
    const { client, states } = makeClient()
    ticketCtl.next = async () => ({ ticket: 'c'.repeat(43) })
    await client.connect()
    const first = FakeWebSocket.instances[0]!
    const staleClose = first.onclose

    client.stop()
    staleClose?.({ code: 1006, reason: '' } as CloseEvent)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(states).not.toContain('reconnecting')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('ticket 401 触发 onAuthFailed(ticket_auth) 且不重连', async () => {
    const { client, authFailures, states } = makeClient()
    ticketCtl.next = async () => {
      throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: undefined as never,
        data: { error: { code: 'UNAUTHORIZED', message: 'expired' } },
      })
    }

    await client.connect()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(authFailures).toEqual(['ticket_auth'])
    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})
