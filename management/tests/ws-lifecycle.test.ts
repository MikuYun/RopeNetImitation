import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient } from '@/ws/client'

const mocked = vi.hoisted(() => ({ getTicket: vi.fn() }))
vi.mock('@/ws/ticket', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/ws/ticket')>(), getTicket: mocked.getTicket,
}))

let clients: WsClient[] = []
let sockets: FakeSocket[] = []

class FakeSocket {
  static OPEN = 1
  readyState = 1
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string) { sockets.push(this) }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  clients = []
  sockets = []
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173' })
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  for (const client of clients) client.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function client(): WsClient {
  const instance = new WsClient()
  clients.push(instance)
  return instance
}

describe('SEC-02 WebSocket lifecycle isolation', () => {
  it('stop while ticket is pending does not create an old-account connection', async () => {
    let complete!: (ticket: string) => void
    mocked.getTicket.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const instance = client()
    const connecting = instance.connect()
    instance.stop()
    complete('old-disposable-ticket')
    await connecting
    expect(sockets, 'late ticket must not create socket').toHaveLength(0)
    expect(instance.getState()).toBe('stopped')
  })

  it('late close from previous socket cannot replace new connection state', async () => {
    mocked.getTicket.mockResolvedValueOnce('first-disposable-ticket').mockResolvedValueOnce('second-disposable-ticket')
    const instance = client()
    await instance.connect()
    const first = sockets[0]!
    const oldClose = first.onclose
    instance.stop()
    await instance.connect()
    const second = sockets[1]!
    expect(second, 'second connection exists').toBeDefined()
    oldClose?.({ code: 1000 })
    expect(instance.isConnected(), 'previous close must not null current socket').toBe(true)
    expect(instance.getState(), 'previous close must not start reconnect').toBe('connecting')
  })

  it('stopped socket late message is not delivered to application handlers', async () => {
    mocked.getTicket.mockResolvedValue('disposable-ticket')
    const onFrame = vi.fn()
    const instance = client()
    instance.setEvents({ onFrame })
    await instance.connect()
    const oldMessage = sockets[0]!.onmessage
    instance.stop()
    oldMessage?.({ data: JSON.stringify({ v: 1, id: 'old-event', type: 'message.created', timestamp: '2026-10-08T00:00:00.000Z', data: {} }) })
    expect(onFrame, 'stale private event must not reach stores').not.toHaveBeenCalled()
  })
})
