/**
 * 独立 WS mock 服务（npm run mock:ws）。
 *
 * 为什么不用 MSW 的 WS 支持：它的 WebSocket 实现随版本变化大，且无法真实验证
 * ticket 一次性、指数退避、看门狗、4001 重取票据这些最易出 bug 的路径。
 * 这里用原生 ws 库（约 250 行）把 client.ts 整条链路练熟。
 *
 * 与 REST mock 的关系：
 *   MSW 跑在浏览器 Service Worker 里，本进程是独立 Node 进程 —— 两者**进程隔离**，
 *   不可能共享内存。因此这里只负责**连接生命周期**（ticket 握手、心跳、typing 中继、
 *   presence 广播），消息数据仍由 MSW 的 REST 层提供。
 *   这正是契约建议的顺序：REST 兜底路径优先，WS 只作优化。
 *   前端在 mock 下靠 client.ts 的 runCompensation() 走 REST 补齐消息。
 *
 * 契约对齐：backend/API.md §6（v0.2.0）
 *   - 服务端信封 {v:1, id, type, timestamp, data}
 *   - 客户端帧无 id/timestamp，只有 {v, type, ...}
 *   - 事件名：ready / pong / message.created / conversation.* / presence.changed /
 *     typing.changed / error
 *
 * 端口：3002（避开后端 3001）。Vite 的 /ws 代理默认指向 3001；
 * 若要用本 mock，把 VITE_BACKEND_ORIGIN 或 vite.config.ts 的 ws target 指到 3002。
 */
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env['WS_MOCK_PORT'] ?? 3002)
const PROTOCOL_VERSION = 1
const HEARTBEAT_MS = 25_000
const TICKET_TTL_MS = 30_000

/** ticket -> { userId, expiresAt, used } */
const tickets = new Map()
/** userId -> Set<ws> */
const connections = new Map()

let ticketSeq = 0

const server = createServer((req, res) => {
  // 允许浏览器（MSW 所在的页面）跨域调用，用于把 REST 侧的动作桥接过来
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 票据签发（前端在 mock 模式下仍走 MSW 的 /api/v1/auth/ws-ticket；
  // 这个端点供直接联调本 mock 时使用）
  if (req.method === 'POST' && req.url?.startsWith('/auth/ws-ticket')) {
    ticketSeq += 1
    const ticket = `tkt_${ticketSeq}_${randomUUID().slice(0, 8)}`
    tickets.set(ticket, {
      userId: String(req.headers['x-mock-user'] ?? 'u_alice'),
      expiresAt: Date.now() + TICKET_TTL_MS,
      used: false,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ticket, expiresIn: 30 }))
    return
  }

  // 桥：让 REST 侧（MSW handler）通知本进程向指定用户广播事件
  if (req.method === 'POST' && req.url === '/bridge/broadcast') {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      try {
        const { userIds, type, data } = JSON.parse(raw)
        for (const uid of userIds ?? []) {
          for (const ws of connections.get(uid) ?? []) send(ws, type, data)
        }
        res.writeHead(204)
        res.end()
      } catch {
        res.writeHead(400)
        res.end()
      }
    })
    return
  }

  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', `http://localhost:${PORT}`)
  const ticket = url.searchParams.get('ticket') ?? ''
  const v = Number(url.searchParams.get('v') ?? '1')
  const record = tickets.get(ticket)

  if (v !== PROTOCOL_VERSION) {
    console.log(`[ws-mock] 拒绝连接：不支持的 v=${v}`)
    ws.close(4002, 'unsupported v')
    return
  }

  // ticket 三条语义：存在、未过期、未使用
  if (!record) {
    console.log('[ws-mock] 拒绝连接：ticket 缺失或不存在')
    ws.close(4001, 'ticket invalid')
    return
  }
  if (record.used) {
    console.log('[ws-mock] 拒绝连接：ticket 已被使用（重放）')
    ws.close(4001, 'ticket already used')
    return
  }
  if (record.expiresAt < Date.now()) {
    console.log('[ws-mock] 拒绝连接：ticket 已过期')
    ws.close(4001, 'ticket expired')
    return
  }

  // 一次性：握手成功即作废
  record.used = true
  const userId = record.userId

  if (!connections.has(userId)) connections.set(userId, new Set())
  const set = connections.get(userId)
  // 后端限制：同一 session 最多 5 条连接
  if (set.size >= 5) {
    console.log(`[ws-mock] 拒绝连接：${userId} 连接数超限`)
    ws.close(1008, 'too many connections')
    return
  }
  set.add(ws)

  console.log(`[ws-mock] ${userId} 已连接，ticket 已作废（当前 ${set.size} 条连接）`)

  // ready 只带 userId
  send(ws, 'ready', { userId })

  ws.on('message', (raw) => {
    // 拒二进制帧（后端会以 1009 断开）
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return
    const text = raw.toString('utf8')

    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      send(ws, 'error', { code: 'INVALID_EVENT', message: '无法解析的帧' })
      return
    }

    if (frame.v !== PROTOCOL_VERSION) {
      ws.close(4002, 'unsupported v')
      return
    }

    switch (frame.type) {
      case 'ping':
        send(ws, 'pong', {})
        break

      case 'typing':
        // 不得回推给发送者本人，只推给同会话其他人
        relayToOthers(userId, 'typing.changed', {
          conversationId: frame.conversationId,
          userId,
          active: !!frame.active,
        })
        break

      default:
        send(ws, 'error', { code: 'INVALID_EVENT', message: `未知帧类型 ${frame.type}` })
    }
  })

  ws.on('close', (code) => {
    set.delete(ws)
    console.log(`[ws-mock] ${userId} 断开（code=${code}）`)
    if (set.size === 0) {
      relayToOthers(userId, 'presence.changed', { userId, online: false })
    }
  })
})

function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return
  ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      data,
    }),
  )
}

/**
 * 中继给除发送者外的所有连接。
 * mock 里没有真实会话成员表，简化为「推给所有人」——
 * 仅用于验证前端对事件的处理，不代表生产语义。
 */
function relayToOthers(senderId, type, data) {
  for (const [uid, set] of connections) {
    if (uid === senderId) continue
    for (const ws of set) send(ws, type, data)
  }
}

server.listen(PORT, () => {
  console.log(`[ws-mock] 监听 ws://127.0.0.1:${PORT}/ws`)
  console.log('[ws-mock] 连接需带一次性 ticket 与 v=1；同一 ticket 第二次握手会被 4001 拒绝')
  console.log('[ws-mock] 说明：本进程只负责连接生命周期，消息数据由 MSW 的 REST 层提供')
})
