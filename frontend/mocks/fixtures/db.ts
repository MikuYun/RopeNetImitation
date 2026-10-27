/**
 * Mock 内存数据源 —— REST (MSW) 与 WS mock server 共用的**唯一**数据源。
 *
 * 为什么必须共用：若 REST 与 WS 各造一份数据，两边返回互相矛盾的内容，
 * 联调时会花大量时间怀疑前端代码。所有 seq 分配、已读游标、在线状态
 * 都只在这一处演进。
 */

/* ── 类型 ───────────────────────────────────────────────────────── */

export interface MockUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  bio: string | null
  createdAt: string
  online: boolean
}

export interface MockMessage {
  msgId: string
  conversationId: string
  senderId: string
  clientMsgId: string | null
  seq: number
  type: string
  content: string
  createdAt: string
}

export interface MockConversation {
  id: string
  type: 'single' | 'group'
  name: string | null
  memberIds: string[]
  ownerId?: string
  createdAt: string
  updatedAt: string
  lastSeq: number
}

export interface MockFriendRequest {
  id: string
  /** 完整 wire user（供 mock 直接序列化） */
  fromUser: Record<string, unknown>
  toUser: Record<string, unknown>
  /** 内部比较用的纯 id，避免从 Record 里取值时丢类型 */
  fromUserId: string
  toUserId: string
  direction: 'incoming' | 'outgoing'
  status: string
  /** 后端字段名为 note（非 message） */
  note: string
  createdAt: string
  updatedAt: string
}

export interface MockSession {
  userId: string
  expiresAt: string
}

export interface MockTicket {
  userId: string
  expiresAt: number
  used: boolean
}

/* ── 工具 ───────────────────────────────────────────────────────── */

let seqCounter = 0
export function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

let idCounter = 0
export function nid(prefix: string): string {
  idCounter += 1
  return `${prefix}_${idCounter.toString(36)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString()
}

/* ── 种子数据 ───────────────────────────────────────────────────── */

export const PASSWORD = 'password123'

function makeUser(id: string, username: string, displayName: string, bio: string): MockUser {
  return {
    id,
    username,
    displayName,
    avatarUrl: null,
    bio,
    createdAt: minutesAgo(60 * 24 * 30),
    online: false,
  }
}

export const users = new Map<string, MockUser>([
  ['u_alice', makeUser('u_alice', 'alice', '艾丽丝', '在线等，不急')],
  ['u_bob', makeUser('u_bob', 'bob', '鲍勃', '写代码中')],
  ['u_carol', makeUser('u_carol', 'carol', '卡罗尔', '今天也要好好吃饭')],
  ['u_dave', makeUser('u_dave', 'dave', '戴夫', '摸鱼选手')],
  ['u_erin', makeUser('u_erin', 'erin', '艾琳', '——')],
])

export const friendships = new Map<string, Set<string>>([
  ['u_alice', new Set(['u_bob', 'u_carol', 'u_dave'])],
  ['u_bob', new Set(['u_alice', 'u_carol'])],
  ['u_carol', new Set(['u_alice', 'u_bob', 'u_dave'])],
  ['u_dave', new Set(['u_alice', 'u_carol'])],
  ['u_erin', new Set<string>()],
])

export const friendRequests = new Map<string, MockFriendRequest>()
export const conversations = new Map<string, MockConversation>()
export const messages = new Map<string, MockMessage[]>()
export const readSeqs = new Map<string, Map<string, number>>()
export const sessions = new Map<string, MockSession>()
export const tickets = new Map<string, MockTicket>()

export function isFriend(a: string, b: string): boolean {
  return friendships.get(a)?.has(b) ?? false
}

export function addFriendship(a: string, b: string): void {
  if (!friendships.has(a)) friendships.set(a, new Set())
  if (!friendships.has(b)) friendships.set(b, new Set())
  friendships.get(a)!.add(b)
  friendships.get(b)!.add(a)
}

export function removeFriendship(a: string, b: string): void {
  friendships.get(a)?.delete(b)
  friendships.get(b)?.delete(a)
}

/* ── 会话 ───────────────────────────────────────────────────────── */

/** 建单聊。幂等：同一对用户重复调用返回既有会话。 */
export function ensureSingleConversation(userA: string, userB: string): MockConversation {
  for (const conv of conversations.values()) {
    if (conv.type !== 'single') continue
    if (conv.memberIds.includes(userA) && conv.memberIds.includes(userB)) return conv
  }
  const conv: MockConversation = {
    id: nid('c'),
    type: 'single',
    name: null,
    memberIds: [userA, userB],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastSeq: 0,
  }
  conversations.set(conv.id, conv)
  messages.set(conv.id, [])
  readSeqs.set(conv.id, new Map(conv.memberIds.map((u) => [u, 0])))
  return conv
}

export function createGroup(
  ownerId: string,
  name: string,
  memberIds: string[],
): MockConversation {
  const all = [...new Set([ownerId, ...memberIds])]
  const conv: MockConversation = {
    id: nid('c'),
    type: 'group',
    name,
    memberIds: all,
    ownerId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastSeq: 0,
  }
  conversations.set(conv.id, conv)
  messages.set(conv.id, [])
  readSeqs.set(conv.id, new Map(all.map((u) => [u, 0])))
  return conv
}

export function brief(user: MockUser | undefined | null): {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
} {
  if (!user) return { id: 'unknown', username: 'unknown', displayName: '未知用户', avatarUrl: null }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
  }
}

/** 按请求者视角组装会话（wire 形状，对齐后端 v0.2.0）。 */
export function summaryFor(conv: MockConversation, viewerId: string): Record<string, unknown> {
  const msgs = messages.get(conv.id) ?? []
  const last = msgs.length > 0 ? msgs[msgs.length - 1]! : null
  const reads = readSeqs.get(conv.id) ?? new Map<string, number>()
  const myRead = reads.get(viewerId) ?? 0

  let title: string
  let peer: ReturnType<typeof wireUser> | undefined
  if (conv.type === 'single') {
    const otherId = conv.memberIds.find((u) => u !== viewerId) ?? viewerId
    const other = users.get(otherId)
    title = other ? other.displayName : '未知用户'
    peer = other ? wireUser(other) : undefined
  } else {
    const members = conv.memberIds.map((u) => users.get(u)).filter((x): x is MockUser => !!x)
    title = conv.name ?? members.map((m) => m.displayName).join('、')
  }

  const unreadCount = msgs.filter((m) => m.seq > myRead && m.senderId !== viewerId).length

  const base: Record<string, unknown> = {
    id: conv.id,
    type: conv.type,
    name: conv.name ?? '',
    title,
    avatarUrl: '',
    ownerId: conv.type === 'group' ? (conv.ownerId ?? null) : null,
    memberCount: conv.memberIds.length,
    myRole: conv.type === 'group' ? (conv.ownerId === viewerId ? 'owner' : 'member') : 'member',
    members: conv.memberIds.map((uid) => memberOf(conv, uid)),
    unreadCount,
    lastSeq: conv.lastSeq,
    lastReadSeq: myRead,
    lastMessage: last,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  }
  // peer 仅单聊返回
  if (peer) base['peer'] = peer
  return base
}

export function wireUser(u: MockUser): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? '',
    bio: u.bio ?? '',
    createdAt: u.createdAt,
    online: mockOnline.has(u.id),
  }
}

function memberOf(conv: MockConversation, uid: string): Record<string, unknown> {
  const reads = readSeqs.get(conv.id) ?? new Map<string, number>()
  const u = users.get(uid)
  return {
    user: u ? wireUser(u) : wireUser(users.get('u_alice')!),
    role: conv.type === 'group' ? (uid === conv.ownerId ? 'owner' : 'member') : 'member',
    joinedAt: conv.createdAt,
    lastReadSeq: reads.get(uid) ?? 0,
  }
}

export function detailFor(conv: MockConversation, viewerId: string): Record<string, unknown> {
  return summaryFor(conv, viewerId)
}

/* ── 消息 ───────────────────────────────────────────────────────── */

export interface DeliverInput {
  conversationId: string
  senderId: string
  clientMsgId?: string | null
  content: string
  type?: string
}

export interface DeliverResult {
  message?: MockMessage
  duplicate?: boolean
  error?: string
}

/**
 * 投递消息。以 (senderId, clientMsgId) 幂等 —— 重复 clientMsgId 返回已存在的那条，
 * 不新建、不分配新 seq。这是前端乐观重试不产生重复的服务端半边。
 */
export function deliverMessage(input: DeliverInput): DeliverResult {
  const conv = conversations.get(input.conversationId)
  if (!conv) return { error: 'CONVERSATION_NOT_FOUND' }

  const list = messages.get(input.conversationId) ?? []

  if (input.clientMsgId) {
    const dup = list.find(
      (m) => m.senderId === input.senderId && m.clientMsgId === input.clientMsgId,
    )
    if (dup) return { message: dup, duplicate: true }
  }

  const convSeq = (conv.lastSeq ?? 0) + 1
  conv.lastSeq = convSeq
  conv.updatedAt = nowIso()

  const msg: MockMessage = {
    msgId: nid('m'),
    conversationId: input.conversationId,
    senderId: input.senderId,
    clientMsgId: input.clientMsgId ?? null,
    seq: convSeq,
    type: input.type ?? 'text',
    content: input.content,
    createdAt: nowIso(),
  }
  list.push(msg)
  messages.set(input.conversationId, list)

  // 发送者自己的已读游标自动前进
  const reads = readSeqs.get(input.conversationId)
  if (reads) reads.set(input.senderId, Math.max(reads.get(input.senderId) ?? 0, convSeq))

  return { message: msg }
}

/** 插入一条系统消息（群成员变更等）。 */
export function deliverSystemMessage(
  conversationId: string,
  text: string,
  actorId?: string,
): MockMessage | null {
  const conv = conversations.get(conversationId)
  if (!conv) return null
  const convSeq = (conv.lastSeq ?? 0) + 1
  conv.lastSeq = convSeq
  conv.updatedAt = nowIso()
  const msg: MockMessage = {
    msgId: nid('m'),
    conversationId,
    senderId: actorId ?? 'system',
    clientMsgId: null,
    seq: convSeq,
    type: 'system',
    content: text,
    createdAt: nowIso(),
  }
  const list = messages.get(conversationId) ?? []
  list.push(msg)
  messages.set(conversationId, list)
  return msg
}

/* ── 认证 ───────────────────────────────────────────────────────── */

export function issueSession(userId: string): { token: string; expiresAt: string } {
  const token = `tok_${userId}_${Math.random().toString(36).slice(2, 10)}`
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  sessions.set(token, { userId, expiresAt })
  return { token, expiresAt }
}

export function sessionOf(token: string): MockSession | null {
  return sessions.get(token) ?? null
}

export function issueTicket(userId: string): { ticket: string; expiresIn: number } {
  const ticket = `tkt_${Math.random().toString(36).slice(2, 12)}`
  tickets.set(ticket, { userId, expiresAt: Date.now() + 30_000, used: false })
  return { ticket, expiresIn: 30 }
}

/* ── 种子：会话与消息 ───────────────────────────────────────────── */

export interface SeedResult {
  cBob: MockConversation
  cCarol: MockConversation
  g1: MockConversation
  g2: MockConversation
}

export function seed(): SeedResult {
  const cBob = ensureSingleConversation('u_alice', 'u_bob')
  deliverMessage({
    conversationId: cBob.id,
    senderId: 'u_bob',
    clientMsgId: 'seed-b1',
    content: '在吗？想跟你确认一下接口的字段命名',
  })
  deliverMessage({
    conversationId: cBob.id,
    senderId: 'u_alice',
    clientMsgId: 'seed-a1',
    content: '在的，你说',
  })
  deliverMessage({
    conversationId: cBob.id,
    senderId: 'u_bob',
    clientMsgId: 'seed-b2',
    content: '消息的 id 字段，前端用 msgId 还是 id？',
  })
  deliverMessage({
    conversationId: cBob.id,
    senderId: 'u_alice',
    clientMsgId: 'seed-a2',
    content: '按你定的 msgId 走，我这边契约已经同步改成 msgId 了',
  })
  deliverMessage({
    conversationId: cBob.id,
    senderId: 'u_bob',
    clientMsgId: 'seed-b3',
    content: '好，那我保持不动',
  })
  const reads1 = readSeqs.get(cBob.id)
  reads1?.set('u_alice', 4)
  reads1?.set('u_bob', 3)

  const cCarol = ensureSingleConversation('u_alice', 'u_carol')
  deliverMessage({
    conversationId: cCarol.id,
    senderId: 'u_carol',
    clientMsgId: 'seed-c1',
    content: '明天的评审你参加吗',
  })
  deliverMessage({
    conversationId: cCarol.id,
    senderId: 'u_alice',
    clientMsgId: 'seed-ac1',
    content: '参加，我把前端进度同步一下',
  })

  const g1 = createGroup('u_alice', '前端契约讨论组', ['u_bob', 'u_carol'])
  deliverSystemMessage(g1.id, '艾丽丝 创建了群聊', 'u_alice')
  deliverMessage({
    conversationId: g1.id,
    senderId: 'u_bob',
    clientMsgId: 'seed-g1',
    content: '群聊的「N 人已读」依赖 members[].lastReadSeq，这个字段别省',
  })
  deliverMessage({
    conversationId: g1.id,
    senderId: 'u_carol',
    clientMsgId: 'seed-g2',
    content: '收到，会话详情里会带上',
  })

  const g2 = createGroup('u_bob', '临时同步群', ['u_alice', 'u_carol', 'u_dave'])
  deliverSystemMessage(g2.id, '鲍勃 创建了群聊', 'u_bob')
  deliverMessage({
    conversationId: g2.id,
    senderId: 'u_dave',
    clientMsgId: 'seed-g3',
    content: '断线补偿走 REST 还是 WS sync？',
  })

  return { cBob, cCarol, g1, g2 }
}

/** 演示用在线状态：默认让 bob、carol 在线，便于看到绿色圆点。 */
export const mockOnline = new Set(['u_bob', 'u_carol'])

seed()
