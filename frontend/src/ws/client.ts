/**
 * WebSocket 客户端。
 *
 * 全项目最易返工处，因此职责划分刻意做细：
 *   - ticket.ts  只管拿票据（单飞、禁缓存、失败分类）
 *   - client.ts  只管连接生命周期（握手、心跳、看门狗、退避、分发）
 *   - handlers.ts 只管把帧翻译成 store 操作（避免循环依赖）
 *
 * 契约要点（backend/API.md §6）：
 *   - 建连：POST /auth/ws-ticket → ws://host/ws?ticket=<t>&v=1
 *   - ticket 一次性、30 秒过期、**不控制已连接寿命**
 *   - 客户端帧无信封 id/timestamp，只有 {v, type, ...}
 *   - 发送消息与已读走 REST，本层不参与
 */
import {
  BACKOFF_JITTER,
  BACKOFF_STEPS_MS,
  DEFAULT_HEARTBEAT_MS,
  RECONNECT_WARN_THRESHOLD,
  WATCHDOG_FACTOR,
  WS_CLOSE,
  WS_ENVELOPE_VERSION,
  WS_PROTOCOL_VERSION,
} from './constants'
import { getTicket, TicketAuthError, TicketRateLimitError } from './ticket'
import { makeClientFrame, zInboundEnvelope, type InboundEnvelope } from './schema'

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export interface WsClientEvents {
  onState?: (state: ConnState, detail?: { attempt?: number }) => void
  onReady?: (env: InboundEnvelope) => void
  onFrame?: (env: InboundEnvelope) => void
  /** 身份失效，需登出 */
  onAuthFailed?: (reason: 'ticket_auth' | 'session_expired') => void
  /** 协议版本不匹配，需刷新页面 */
  onProtocolMismatch?: (remote: number) => void
  /** 连续失败达阈值，提示网络异常 */
  onPersistentFailure?: (attempts: number) => void
}

export class WsClient {
  private ws: WebSocket | null = null
  private state: ConnState = 'idle'
  private events: WsClientEvents = {}

  private heartbeatTimer: number | null = null
  private watchdogTimer: number | null = null
  private reconnectTimer: number | null = null

  private heartbeatMs = DEFAULT_HEARTBEAT_MS
  private attempt = 0
  private manualClose = false
  /**
   * 连接代际。
   *
   * 【为什么必须有】`openOnce` 里有一次 `await getTicket()`。在它返回之前
   * 用户可能已经登出（`stop()`）或已发起新连接，于是会出现三种竞态：
   *   1. 票据迟到 → 给一个**已经登出的账号**建了连接（旧账号的私有事件
   *      会流进刚清空的 store）；
   *   2. 旧 socket 的 onclose 迟到 → 把 `this.ws` 置空，掐掉当前这条好连接；
   *   3. 旧 socket 的 onmessage 迟到 → 把旧账号的消息投递给应用层。
   * 每次 `stop()` 与每次新 `openOnce` 都推进代际；所有异步回调先比对自己
   * 出发时的代际，不一致就整体丢弃。这是 pm 独立回归里 ws-lifecycle 三条的根因。
   */
  private gen = 0
  /** 连接级帧计数，独立于 Message.seq。 */
  private frameCount = 0
  private clockOffsetMs = 0

  setEvents(events: WsClientEvents): void {
    this.events = events
  }

  getState(): ConnState {
    return this.state
  }

  getFrameCount(): number {
    return this.frameCount
  }

  getClockOffsetMs(): number {
    return this.clockOffsetMs
  }

  /** 建立连接（或重连）。重复调用安全。 */
  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'open') return
    this.manualClose = false
    await this.openOnce()
  }

  /** 主动断开且不再重连（登出时调用）。 */
  stop(code = 1000, reason = 'client stop'): void {
    // 推进代际：让所有在途的取票/连帧/关闭回调立即作废
    this.gen += 1
    this.manualClose = true
    this.clearTimers()
    this.setState('stopped')
    if (this.ws) {
      // 先摘掉回调再关闭：close 会同步触发 onclose，
      // 那条回调属于本代际、已被作废，但清掉更干净，也避免它读到 this.ws
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      try {
        this.ws.close(code, reason)
      } catch {
        /* 忽略：连接可能已在关闭中 */
      }
      this.ws = null
    }
  }

  /** 发送一帧。返回 false 表示当前未连接。 */
  send(type: string, payload: Record<string, unknown> = {}): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(makeClientFrame(type, payload)))
      return true
    } catch {
      return false
    }
  }

  /** 供 handlers 判断会话是否活跃（例如决定是否走 REST 兜底）。 */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /* ── 内部 ──────────────────────────────────────────────────────── */

  private setState(state: ConnState, detail?: { attempt?: number }): void {
    this.state = state
    this.events.onState?.(state, detail)
  }

  private async openOnce(): Promise<void> {
    // 本代际：任何 await 之后都要回来核对，不一致说明期间发生了
    // stop()（登出）或新一次 openOnce（重连/换账号），本次结果必须整体丢弃。
    const gen = this.gen
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.attempt })

    let ticket: string
    try {
      ticket = await getTicket()
    } catch (e) {
      if (gen !== this.gen) return
      if (e instanceof TicketAuthError) {
        // 身份失效：不盲目重试，交给上层判定是否登出
        this.setState('stopped')
        this.events.onAuthFailed?.('ticket_auth')
        return
      }
      if (e instanceof TicketRateLimitError) {
        this.scheduleReconnect(e.retryAfterMs)
        return
      }
      this.scheduleReconnect()
      return
    }

    // 取票期间登出了 / 被更新的连接取代了 —— 不能给旧账号建连接
    if (gen !== this.gen) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}&v=${WS_ENVELOPE_VERSION}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      if (gen !== this.gen) return
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (gen !== this.gen) return
      // 握手成功不代表会话可用，仍要等 ready 帧。
      this.armWatchdog()
    }

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (gen !== this.gen) return
      this.handleRawFrame(ev.data)
    }

    ws.onerror = () => {
      // 具体原因由 onclose 的关闭码给出
    }

    ws.onclose = (ev: CloseEvent) => {
      // 【勿删这道判断】旧连接的 onclose 可能在**新连接已建立之后**才到达。
      // 不判断就会出现两件坏事：把 this.ws 置空掐掉当前好连接；
      // 以及触发一次不属于当前代际的重连。pm 的 ws-lifecycle 第二条正是此例。
      if (gen !== this.gen) return
      this.clearTimers()
      this.ws = null
      if (this.manualClose) {
        this.setState('stopped')
        return
      }
      this.handleCloseCode(ev.code)
    }
  }

  private handleRawFrame(raw: unknown): void {
    if (typeof raw !== 'string') {
      // 服务端明确拒绝二进制帧（1009），这里只做防御
      console.warn('[ws] 收到二进制帧，已丢弃')
      return
    }
    this.armWatchdog()

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      console.warn('[ws] 收到非 JSON 帧，已丢弃')
      return
    }

    const result = zInboundEnvelope.safeParse(parsedJson)
    if (!result.success) {
      // 边界处失败，不让脏数据流进 store
      console.warn('[ws] 帧结构不符合契约，已丢弃', result.error.issues)
      return
    }
    const env = result.data

    if (env.v !== WS_ENVELOPE_VERSION) {
      this.clearTimers()
      this.manualClose = true
      this.setState('stopped')
      this.events.onProtocolMismatch?.(env.v)
      try {
        this.ws?.close(WS_CLOSE.PROTOCOL_MISMATCH, 'version mismatch')
      } catch {
        /* 忽略 */
      }
      return
    }

    this.frameCount += 1

    if (env.type === 'ready') {
      this.onReadyFrame(env)
    }

    this.events.onFrame?.(env)
  }

  private onReadyFrame(env: InboundEnvelope): void {
    // 优先用 ready.data.serverTime（后端已下发，语义明确）；
    // 缺失时退回信封 timestamp。两者都用于估算时钟偏移。
    const raw = env.data as { serverTime?: unknown; protocolVersion?: unknown }
    const source =
      typeof raw.serverTime === 'string' ? raw.serverTime : env.timestamp
    const serverTime = Date.parse(source)
    if (Number.isFinite(serverTime)) {
      this.clockOffsetMs = serverTime - Date.now()
    }

    // 若后端在 ready 里回传协议版本且与本地不一致，视为不兼容
    if (typeof raw.protocolVersion === 'number' && raw.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.clearTimers()
      this.manualClose = true
      this.setState('stopped')
      this.events.onProtocolMismatch?.(raw.protocolVersion)
      return
    }

    this.attempt = 0
    this.setState('open', { attempt: 0 })
    this.startHeartbeat()
    this.events.onReady?.(env)
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      this.send('ping')
    }, this.heartbeatMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 看门狗：任意帧都算活性。超过 2× 心跳间隔零帧，说明连接已死
   * （可能是半开连接 —— TCP 层没报错但报文不再到达），必须强制重连。
   */
  private armWatchdog(): void {
    this.clearWatchdog()
    const timeout = this.heartbeatMs * WATCHDOG_FACTOR
    this.watchdogTimer = window.setTimeout(() => {
      console.warn('[ws] 看门狗超时，强制重连')
      this.clearWatchdog()
      try {
        this.ws?.close(WS_CLOSE.ABNORMAL, 'watchdog timeout')
      } catch {
        /* 忽略 */
      }
    }, timeout)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat()
    this.clearWatchdog()
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private handleCloseCode(code: number): void {
    switch (code) {
      case WS_CLOSE.TICKET_INVALID:
        // 可自愈：申请新票据后重连，不退避
        console.warn('[ws] ticket 失效，立即重新取票重连')
        void this.openOnce()
        return

      case WS_CLOSE.PROTOCOL_MISMATCH:
        // 不盲目重连，避免无限刷日志
        this.manualClose = true
        this.setState('stopped')
        this.events.onProtocolMismatch?.(0)
        return

      case WS_CLOSE.SESSION_EXPIRED:
        // 4003：session 过期/注销 —— 停止自动重连，清登录状态
        // 契约明示：**不要**对失效 token 调 refresh
        this.manualClose = true
        this.clearTimers()
        this.setState('stopped')
        this.events.onAuthFailed?.('session_expired')
        return

      case WS_CLOSE.BINARY_UNSUPPORTED:
        // 1003：二进制帧 —— 客户端缺陷，停重连并打日志
        this.manualClose = true
        this.setState('stopped')
        console.error('[ws] 服务端不支持二进制帧，客户端必须以 JSON 文本帧发送')
        return

      case WS_CLOSE.POLICY_VIOLATION:
        // 1008 只表示超连接数或超帧频（session 失效已改 4003）——
        // 退避重连即可，**不得据此登出**
        console.warn('[ws] 超出连接数或帧频限制，退避重连')
        this.scheduleReconnect()
        return

      case WS_CLOSE.MESSAGE_TOO_BIG:
        // 1009：客户端缺陷
        this.manualClose = true
        this.setState('stopped')
        console.error('[ws] 帧过大被服务端拒绝，请检查客户端发送内容')
        return

      case WS_CLOSE.TRY_AGAIN_LATER:
        this.scheduleReconnect(5_000)
        return

      default:
        this.scheduleReconnect()
        return
    }
  }

  private scheduleReconnect(overrideDelayMs?: number): void {
    if (this.manualClose) return
    this.attempt += 1

    if (this.attempt >= RECONNECT_WARN_THRESHOLD) {
      this.events.onPersistentFailure?.(this.attempt)
    }

    let delay: number
    if (overrideDelayMs !== undefined) {
      delay = overrideDelayMs
    } else {
      const idx = Math.min(this.attempt - 1, BACKOFF_STEPS_MS.length - 1)
      const base = BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!
      const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1)
      delay = Math.max(500, Math.round(base + jitter))
    }

    this.setState('reconnecting', { attempt: this.attempt })
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.openOnce()
    }, delay)
  }
}

export const wsClient = new WsClient()
