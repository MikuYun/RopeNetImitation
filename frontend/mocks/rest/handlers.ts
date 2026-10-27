/**
 * REST Mock handlers（MSW v2）。
 *
 * 所有 handler 都直接操作 fixtures/db.ts 那一份内存数据，
 * 与 WS mock server 共享状态，保证 REST 与 WS 返回一致。
 *
 * **形状刻意逐字段对齐 backend/openapi.json v0.2.0**：
 *   - 成功直接返回资源，不包 data；列表 {items, nextOffset}
 *   - 错误体 {error:{code,message,traceId}}
 *   - 端点路径 /friend-requests、/conversations/direct|group
 *   - read 返回 204 无正文
 *   - 错误码用后端的实际取值（VALIDATION_ERROR / UNAUTHORIZED / …）
 *
 * 这样 normalize 层在 Mock 与真实后端下走的是同一条代码路径，
 * 联调时的差异只可能来自真实后端，不会来自 mock 失真。
 */
import { http, HttpResponse } from 'msw'
import {
  PASSWORD,
  addFriendship,
  conversations,
  createGroup,
  deliverMessage,
  deliverSystemMessage,
  detailFor,
  ensureSingleConversation,
  friendships,
  friendRequests,
  isFriend,
  issueSession,
  issueTicket,
  messages,
  minutesAgo,
  mockOnline,
  nid,
  nowIso,
  readSeqs,
  sessionOf,
  summaryFor,
  users,
  wireUser,
  type MockConversation,
  type MockFriendRequest,
  type MockUser,
} from '../fixtures/db'

const API = '/api/v1'

/** 后端错误体：{error:{code,message,traceId}} */
function err(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message, traceId: nid('trace') } }, { status })
}

/** 后端列表包装：{items, nextOffset}，nextOffset=null 为末页 */
function page<T>(items: T[]) {
  return HttpResponse.json({ items, nextOffset: null })
}

function currentUser(request: Request): { id: string } | null {
  const raw = request.headers.get('Authorization') ?? ''
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : ''
  if (!token) return null
  const s = sessionOf(token)
  if (!s) return null
  if (Date.parse(s.expiresAt) < Date.now()) return null
  return { id: s.userId }
}

function requireUser(request: Request): { id: string } | Response {
  const u = currentUser(request)
  if (!u) return err(401, 'UNAUTHORIZED', '登录状态无效')
  return u
}

function isResponse(x: unknown): x is Response {
  return x instanceof Response
}

function conversationsOf(userId: string): MockConversation[] {
  return [...conversations.values()].filter((c) => c.memberIds.includes(userId))
}

function authResult(userId: string): Record<string, unknown> {
  const s = issueSession(userId)
  const user = users.get(userId)
  return {
    token: s.token,
    tokenType: 'Bearer',
    expiresAt: s.expiresAt,
    user: user ? wireUser(user) : null,
  }
}

const HEALTH = {
  status: 'ok',
  version: '0.2.0',
  protocolVersion: '0.2.0',
  serverTime: nowIso(),
}

export const handlers = [
  /* ── 健康检查（后端同时提供带前缀与不带前缀两个） ────────────── */
  http.get(`${API}/health`, () => HttpResponse.json(HEALTH)),
  http.get('/health', () => HttpResponse.json(HEALTH)),

  /* ── 认证 ─────────────────────────────────────────────────────── */
  http.post(`${API}/auth/register`, async ({ request }) => {
    const body = (await request.json()) as {
      username?: string
      password?: string
      displayName?: string
    }
    const username = (body.username ?? '').trim()
    // 后端规则：3–32 位 ASCII 字母/数字/下划线，统一小写存储
    if (!/^[a-z0-9_]{3,32}$/i.test(username)) {
      return err(400, 'VALIDATION_ERROR', '用户名为 3–32 位字母、数字或下划线')
    }
    for (const u of users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        return err(409, 'USERNAME_TAKEN', '该用户名已被占用')
      }
    }
    const password = body.password ?? ''
    if (password.length < 8 || password.length > 128) {
      return err(400, 'VALIDATION_ERROR', '密码为 8–128 位')
    }
    const id = nid('u')
    const user: MockUser = {
      id,
      username: username.toLowerCase(),
      displayName: body.displayName?.trim() || username,
      avatarUrl: null,
      bio: null,
      createdAt: nowIso(),
      online: true,
    }
    users.set(id, user)
    friendships.set(id, new Set())
    return HttpResponse.json(authResult(id), { status: 201 })
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string }
    const key = (body.username ?? '').toLowerCase()
    const user = [...users.values()].find((u) => u.username.toLowerCase() === key)
    // 登录失败不区分用户不存在与密码错误（防枚举）
    if (!user || body.password !== PASSWORD) {
      return err(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
    }
    mockOnline.add(user.id)
    return HttpResponse.json(authResult(user.id))
  }),

  http.post(`${API}/auth/logout`, () => HttpResponse.json({ ok: true })),

  http.get(`${API}/auth/session`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const raw = request.headers.get('Authorization') ?? ''
    const token = raw.slice(7)
    const s = sessionOf(token)
    const user = users.get(u.id)
    return HttpResponse.json({
      token,
      tokenType: 'Bearer',
      expiresAt: s?.expiresAt ?? nowIso(),
      user: user ? wireUser(user) : null,
    })
  }),

  http.post(`${API}/auth/session/refresh`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const raw = request.headers.get('Authorization') ?? ''
    const token = raw.slice(7)
    const s = sessionOf(token)
    if (!s) return err(401, 'UNAUTHORIZED', '登录状态无效')
    // 同 token，只延后 expiresAt（不轮换 —— 轮换会导致多标签页互踢）
    s.expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    const user = users.get(u.id)
    return HttpResponse.json({
      token,
      tokenType: 'Bearer',
      expiresAt: s.expiresAt,
      user: user ? wireUser(user) : null,
    })
  }),

  http.post(`${API}/auth/ws-ticket`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    return HttpResponse.json(issueTicket(u.id))
  }),

  /* ── 用户 ─────────────────────────────────────────────────────── */
  http.get(`${API}/users/me`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const user = users.get(u.id)
    if (!user) return err(401, 'UNAUTHORIZED', '登录状态无效')
    return HttpResponse.json(wireUser(user))
  }),

  http.patch(`${API}/users/me`, async ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const body = (await request.json()) as {
      displayName?: string
      bio?: string
      avatarUrl?: string
    }
    const user = users.get(u.id)
    if (!user) return err(404, 'USER_NOT_FOUND', '用户不存在')
    if (body.displayName !== undefined) {
      if (body.displayName.length < 1 || body.displayName.length > 40) {
        return err(400, 'VALIDATION_ERROR', '昵称为 1–40 字符')
      }
      user.displayName = body.displayName
    }
    if (body.bio !== undefined) {
      if (body.bio.length > 200) return err(400, 'VALIDATION_ERROR', '简介最多 200 字符')
      user.bio = body.bio
    }
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl && !/^https:\/\//.test(body.avatarUrl)) {
        return err(400, 'INVALID_AVATAR_URL', '头像必须是 HTTPS 地址')
      }
      user.avatarUrl = body.avatarUrl || null
    }
    return HttpResponse.json(wireUser(user))
  }),

  /** 后端为**模糊匹配**用户名或昵称，不返回自己（diff-report §2.2）。 */
  http.get(`${API}/users`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    if (!q || q.length > 40) return err(400, 'VALIDATION_ERROR', 'q 为 1–40 字符')
    const limit = Number(url.searchParams.get('limit') ?? 30) || 30
    const items = [...users.values()]
      .filter(
        (x) =>
          x.id !== u.id &&
          (x.username.toLowerCase().includes(q) || x.displayName.toLowerCase().includes(q)),
      )
      .slice(0, Math.min(limit, 100))
      .map(wireUser)
    return page(items)
  }),

  /* ── 好友 ─────────────────────────────────────────────────────── */
  /** 后端返回纯 User 数组（无 since）。 */
  http.get(`${API}/friends`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const ids = friendships.get(u.id) ?? new Set<string>()
    const items = [...ids]
      .map((id) => users.get(id))
      .filter((x): x is MockUser => !!x)
      .map(wireUser)
    return page(items)
  }),

  /** 一次申请同时出现在双方列表；不传 status 返回全部。 */
  http.get(`${API}/friend-requests`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const status = new URL(request.url).searchParams.get('status')
    const items = [...friendRequests.values()]
      .filter((r) => r.fromUserId === u.id || r.toUserId === u.id)
      .filter((r) => (status ? r.status === status : true))
      .map(serializeRequest)
    return page(items)
  }),

  http.post(`${API}/friend-requests`, async ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const body = (await request.json()) as { userId?: string; note?: string }
    const toId = body.userId ?? ''
    if (toId === u.id) return err(400, 'SELF_FRIEND_REQUEST', '不能添加自己为好友')
    if (!users.has(toId)) return err(404, 'USER_NOT_FOUND', '用户不存在')
    if (isFriend(u.id, toId)) return err(409, 'ALREADY_FRIENDS', '你们已经是好友')
    // 跨方向重复 pending 亦冲突
    const dup = [...friendRequests.values()].find(
      (r) =>
        r.status === 'pending' &&
        ((r.fromUserId === u.id && r.toUserId === toId) ||
          (r.fromUserId === toId && r.toUserId === u.id)),
    )
    if (dup) return err(409, 'REQUEST_PENDING', '已存在待处理的申请')
    if (body.note !== undefined && body.note.length > 200) {
      return err(400, 'VALIDATION_ERROR', '附言最多 200 字符')
    }

    const me = users.get(u.id)
    const target = users.get(toId)
    const req = {
      id: nid('fr'),
      fromUser: wireUserBrief(me),
      toUser: wireUserBrief(target),
      fromUserId: u.id,
      toUserId: toId,
      direction: 'outgoing' as const,
      status: 'pending',
      note: body.note ?? '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    friendRequests.set(req.id, req)

    // mock：1.5 秒后模拟对方通过，便于单机演示完整加好友 → 出会话流程
    window.setTimeout(() => {
      const r = friendRequests.get(req.id)
      if (r && r.status === 'pending') {
        r.status = 'accepted'
        r.updatedAt = nowIso()
        addFriendship(u.id, toId)
        ensureSingleConversation(u.id, toId)
      }
    }, 1_500)

    return HttpResponse.json(serializeRequest(req), { status: 201 })
  }),

  /** 处理申请：{action:'accept'|'reject'}。非接收方返回 404（不泄露存在性）。 */
  http.post(`${API}/friend-requests/:requestId/respond`, async ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const req = friendRequests.get(String(params['requestId']))
    if (!req || req.toUserId !== u.id) {
      return err(404, 'REQUEST_NOT_FOUND', '申请不存在')
    }
    if (req.status !== 'pending') return err(409, 'REQUEST_RESOLVED', '该申请已处理')
    const body = (await request.json()) as { action?: string }
    if (body.action !== 'accept' && body.action !== 'reject') {
      return err(400, 'VALIDATION_ERROR', 'action 只能是 accept 或 reject')
    }
    req.status = body.action === 'accept' ? 'accepted' : 'rejected'
    req.updatedAt = nowIso()
    if (req.status === 'accepted') {
      addFriendship(u.id, req.fromUserId)
      // 后端**不自动建会话**（diff-report C3），由前端另调 /conversations/direct
    }
    return HttpResponse.json(serializeRequest(req))
  }),

  /* ── 会话 ─────────────────────────────────────────────────────── */
  http.get(`${API}/conversations`, ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const items = conversationsOf(u.id)
      .map((c) => summaryFor(c, u.id))
      // 后端排序：updatedAt DESC, id DESC
      .sort((a, b) => {
        const d = Date.parse(String(b['updatedAt'])) - Date.parse(String(a['updatedAt']))
        if (d !== 0) return d
        return String(b['id']).localeCompare(String(a['id']))
      })
    return page(items)
  }),

  http.get(`${API}/conversations/:conversationId`, ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const conv = conversations.get(String(params['conversationId']))
    // 非成员统一 404，避免会话存在性泄露
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    return HttpResponse.json(detailFor(conv, u.id))
  }),

  /** 建私聊：必须已是好友；双方唯一、可重复调用。 */
  http.post(`${API}/conversations/direct`, async ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const body = (await request.json()) as { userId?: string }
    const peerId = body.userId ?? ''
    if (peerId === u.id) return err(400, 'SELF_CONVERSATION', '不能与自己建私聊')
    if (!users.has(peerId)) return err(404, 'USER_NOT_FOUND', '用户不存在')
    if (!isFriend(u.id, peerId)) return err(403, 'FRIEND_REQUIRED', '你们还不是好友')
    const conv = ensureSingleConversation(u.id, peerId)
    return HttpResponse.json(summaryFor(conv, u.id))
  }),

  /** 建群：至少一位其他好友；memberIds 不能重复。 */
  http.post(`${API}/conversations/group`, async ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const body = (await request.json()) as { name?: string; memberIds?: string[] }
    const name = (body.name ?? '').trim()
    if (name.length < 1 || name.length > 60) {
      return err(400, 'VALIDATION_ERROR', '群名为 1–60 字符')
    }
    const raw = body.memberIds ?? []
    if (raw.length < 1 || raw.length > 99) {
      return err(400, 'INVALID_MEMBERS', 'memberIds 为 1–99 项')
    }
    const memberIds = [...new Set(raw)].filter((x) => x !== u.id && users.has(x))
    if (memberIds.length !== raw.length) {
      return err(400, 'INVALID_MEMBERS', '成员含重复或不存在的用户')
    }
    for (const m of memberIds) {
      if (!isFriend(u.id, m)) return err(403, 'FRIEND_REQUIRED', '只能邀请好友入群')
    }
    const conv = createGroup(u.id, name, memberIds)
    const names = memberIds.map((m) => users.get(m)?.displayName ?? m).join('、')
    deliverSystemMessage(conv.id, `${users.get(u.id)?.displayName} 邀请 ${names} 加入了群聊`, u.id)
    return HttpResponse.json(summaryFor(conv, u.id), { status: 201 })
  }),

  http.patch(`${API}/conversations/:conversationId`, async ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const conv = conversations.get(String(params['conversationId']))
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    if (conv.type !== 'group') return err(400, 'GROUP_REQUIRED', '仅群聊可改名称')
    if (conv.ownerId !== u.id) return err(403, 'OWNER_REQUIRED', '仅群主可修改群名')
    const body = (await request.json()) as { name?: string }
    const name = (body.name ?? '').trim()
    if (name.length < 1 || name.length > 60) {
      return err(400, 'VALIDATION_ERROR', '群名为 1–60 字符')
    }
    conv.name = name
    conv.updatedAt = nowIso()
    deliverSystemMessage(conv.id, `${users.get(u.id)?.displayName} 修改群名为「${name}」`, u.id)
    return HttpResponse.json(summaryFor(conv, u.id))
  }),

  /** 加成员：仅群主邀请自己的好友；已在群内者忽略。 */
  http.post(`${API}/conversations/:conversationId/members`, async ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const conv = conversations.get(String(params['conversationId']))
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    if (conv.type !== 'group') return err(400, 'GROUP_REQUIRED', '仅群聊可添加成员')
    if (conv.ownerId !== u.id) return err(403, 'OWNER_REQUIRED', '仅群主可邀请成员')
    const body = (await request.json()) as { memberIds?: string[] }
    const raw = body.memberIds ?? []
    if (raw.length < 1) return err(400, 'INVALID_MEMBERS', 'memberIds 至少 1 项')

    const added: string[] = []
    for (const m of raw) {
      if (conv.memberIds.includes(m)) continue // 已在群内 → 忽略（幂等）
      if (!users.has(m)) return err(400, 'INVALID_MEMBERS', '成员不存在')
      if (!isFriend(u.id, m)) return err(403, 'FRIEND_REQUIRED', '只能邀请自己的好友')
      if (conv.memberIds.length >= 100) return err(400, 'GROUP_FULL', '群成员已达上限 100 人')
      conv.memberIds.push(m)
      added.push(m)
      readSeqs.get(conv.id)?.set(m, 0)
    }
    if (added.length > 0) {
      const names = added.map((m) => users.get(m)?.displayName ?? m).join('、')
      deliverSystemMessage(conv.id, `${users.get(u.id)?.displayName} 邀请 ${names} 加入了群聊`, u.id)
    }
    return HttpResponse.json(detailFor(conv, u.id))
  }),

  /** 移除成员：群主移除他人或普通成员主动退出。返回 {ok:true}。 */
  http.delete(`${API}/conversations/:conversationId/members/:userId`, ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const conv = conversations.get(String(params['conversationId']))
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    if (conv.type !== 'group') return err(400, 'GROUP_REQUIRED', '仅群聊可移除成员')
    const targetId = String(params['userId'])
    if (!conv.memberIds.includes(targetId)) {
      return err(404, 'MEMBER_NOT_FOUND', '成员不存在')
    }
    const isSelf = targetId === u.id
    const isOwner = conv.ownerId === u.id
    // 群主不能退群或转让（后端策略，diff-report C6）
    if (isSelf && isOwner) {
      return err(409, 'OWNER_CANNOT_LEAVE', '群主不能退出群聊（MVP 不支持转让）')
    }
    if (!isSelf && !isOwner) return err(403, 'OWNER_REQUIRED', '仅群主可移除他人')

    conv.memberIds = conv.memberIds.filter((x) => x !== targetId)
    readSeqs.get(conv.id)?.delete(targetId)
    deliverSystemMessage(
      conv.id,
      `${users.get(targetId)?.displayName ?? targetId} 退出了群聊`,
      targetId,
    )
    return HttpResponse.json({ ok: true })
  }),

  /** 已读：只前进不回退，0 合法；返回 204 无正文（diff-report C1）。 */
  http.post(`${API}/conversations/:conversationId/read`, async ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const convId = String(params['conversationId'])
    const conv = conversations.get(convId)
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    const body = (await request.json()) as { lastReadSeq?: number }
    const seq = body.lastReadSeq ?? 0
    const all = messages.get(convId) ?? []
    const maxSeq = all.length > 0 ? all[all.length - 1]!.seq : 0
    if (seq < 0 || seq > maxSeq) {
      return err(400, 'INVALID_READ_CURSOR', '已读游标不对应已有消息')
    }
    const reads = readSeqs.get(convId)
    if (reads) {
      // 单调不回退：更小的值静默忽略
      reads.set(u.id, Math.max(reads.get(u.id) ?? 0, seq))
    }
    return new HttpResponse(null, { status: 204 })
  }),

  /* ── 消息 ─────────────────────────────────────────────────────── */
  http.get(`${API}/conversations/:conversationId/messages`, ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const convId = String(params['conversationId'])
    const conv = conversations.get(convId)
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }

    const url = new URL(request.url)
    const beforeRaw = url.searchParams.get('beforeSeq')
    const afterRaw = url.searchParams.get('afterSeq')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 100)

    if (beforeRaw && afterRaw) {
      return err(400, 'INVALID_CURSOR', 'beforeSeq 与 afterSeq 互斥')
    }

    const all = [...(messages.get(convId) ?? [])].sort((a, b) => a.seq - b.seq)
    let items: typeof all
    let hasMore: boolean

    if (afterRaw) {
      const after = Number(afterRaw)
      const newer = all.filter((m) => m.seq > after)
      items = newer.slice(0, limit)
      hasMore = newer.length > limit
    } else if (beforeRaw) {
      const before = Number(beforeRaw)
      const older = all.filter((m) => m.seq < before)
      hasMore = older.length > limit
      items = older.slice(-limit)
    } else {
      hasMore = all.length > limit
      items = all.slice(-limit)
    }

    return HttpResponse.json({
      items,
      hasMore,
      nextBeforeSeq: hasMore && items.length > 0 ? items[0]!.seq : null,
      nextAfterSeq: hasMore && items.length > 0 ? items[items.length - 1]!.seq : null,
    })
  }),

  /**
   * 发消息。首次 201；同 clientMsgId 同内容重试 200 原消息；
   * 同 id 改会话/正文 409 IDEMPOTENCY_CONFLICT。
   */
  http.post(`${API}/conversations/:conversationId/messages`, async ({ request, params }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const convId = String(params['conversationId'])
    const conv = conversations.get(convId)
    if (!conv || !conv.memberIds.includes(u.id)) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }

    const body = (await request.json()) as {
      clientMsgId?: string
      type?: string
      content?: string
    }
    if (body.type !== 'text') {
      return err(400, 'VALIDATION_ERROR', '客户端只能发送 type=text')
    }
    const content = body.content ?? ''
    if (!content.trim()) return err(400, 'VALIDATION_ERROR', '消息正文不能为空白')
    if (content.length > 4000) return err(400, 'VALIDATION_ERROR', '消息正文最多 4000 字符')
    if (!body.clientMsgId) return err(400, 'VALIDATION_ERROR', 'clientMsgId 必填')

    const res = deliverMessage({
      conversationId: convId,
      senderId: u.id,
      clientMsgId: body.clientMsgId,
      content,
    })
    if (res.error || !res.message) {
      return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
    }
    const status = res.duplicate ? 200 : 201
    return HttpResponse.json(res.message, { status })
  }),

  /* ── 补偿 ─────────────────────────────────────────────────────── */
  http.post(`${API}/sync`, async ({ request }) => {
    const u = requireUser(request)
    if (isResponse(u)) return u
    const body = (await request.json()) as {
      cursors?: Array<{ conversationId: string; lastSeq: number }>
    }
    const cursors = body.cursors ?? []
    if (cursors.length > 100) return err(400, 'VALIDATION_ERROR', '单次最多 100 个会话')
    const seen = new Set<string>()
    for (const c of cursors) {
      if (seen.has(c.conversationId)) {
        return err(400, 'DUPLICATE_CURSOR', 'cursors 含重复会话')
      }
      seen.add(c.conversationId)
      const conv = conversations.get(c.conversationId)
      if (!conv || !conv.memberIds.includes(u.id)) {
        return err(404, 'CONVERSATION_NOT_FOUND', '会话不存在或无权访问')
      }
      const all = messages.get(c.conversationId) ?? []
      const maxSeq = all.length > 0 ? all[all.length - 1]!.seq : 0
      if (c.lastSeq > maxSeq) return err(400, 'INVALID_CURSOR', '游标超过服务端当前序号')
    }

    const items = cursors.map((c) => {
      const all = [...(messages.get(c.conversationId) ?? [])].sort((a, b) => a.seq - b.seq)
      const newer = all.filter((m) => m.seq > c.lastSeq)
      const pageItems = newer.slice(0, 100)
      const reads = readSeqs.get(c.conversationId) ?? new Map<string, number>()
      const myRead = reads.get(u.id) ?? 0
      return {
        conversationId: c.conversationId,
        messages: pageItems,
        lastSeq: all.length > 0 ? all[all.length - 1]!.seq : 0,
        unreadCount: all.filter((m) => m.seq > myRead && m.senderId !== u.id).length,
        hasMore: newer.length > 100,
        // nextSeq 是本页实际最后返回序号；无消息时等于输入游标
        nextSeq: pageItems.length > 0 ? pageItems[pageItems.length - 1]!.seq : c.lastSeq,
      }
    })
    return HttpResponse.json({ items })
  }),
]

/** 好友申请序列化：后端形状 {id,sender,recipient,note,status,createdAt,updatedAt} */
function serializeRequest(r: MockFriendRequest): Record<string, unknown> {
  return {
    id: r.id,
    sender: r.fromUser,
    recipient: r.toUser,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function wireUserBrief(u: MockUser | undefined): Record<string, unknown> {
  if (!u) return { id: '', username: '', displayName: '', avatarUrl: '', bio: '', createdAt: '', online: false }
  return wireUser(u)
}

export { minutesAgo }
