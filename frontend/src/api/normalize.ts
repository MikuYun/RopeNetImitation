/**
 * wire → 领域模型 的归一化层。
 *
 * 这是全前端**唯一**感知后端字段命名的地方。后端 v0.2.0 已提供视角化字段
 * （title/avatarUrl/peer/memberCount/lastReadSeq/myRole），因此本层不再需要
 * 自行推导标题与成员数 —— 只在字段缺失时兜底，保持对后端旧版本的容忍。
 *
 * 见 docs/contract/diff-report.md。
 */
import type {
  Attachment,
  AttachmentKind,
  ConversationDetail,
  ConversationSummary,
  ConversationType,
  Friend,
  FriendRequest,
  LocalMessage,
  MemberRole,
  MessageType,
  PinnedMessage,
  Relationship,
  ReplyRef,
  UserBrief,
  WireMessage as DomainWireMessage,
} from '@/types/domain'
import type { User } from '@/api/auth.types'
import type {
  WireUserLike,
  WireAttachment,
  WireConversation,
  WireFriendRequest,
  WireMember,
  WireMessage,
  WirePinnedMessage,
  WireReplyRef,
  WireUser,
} from './wire'

export function normalizeConvType(raw: string): ConversationType {
  return raw === 'group' ? 'group' : 'single'
}

export function normalizeRole(raw: string): MemberRole {
  if (raw === 'owner' || raw === 'admin') return raw
  return 'member'
}

export function normalizeMessageType(raw: string): MessageType {
  if (
    raw === 'system' ||
    raw === 'image' ||
    raw === 'video' ||
    raw === 'file' ||
    raw === 'mixed'
  ) {
    return raw
  }
  return 'text'
}

/** 附件 kind 白名单（v2）；未知值降级为 `file`（最保守：当成可下载的普通文件）。 */
export function normalizeAttachmentKind(raw: string): AttachmentKind {
  if (raw === 'image' || raw === 'video') return raw
  return 'file'
}

/**
 * 归一化附件。
 *
 * 图片/文件消息的 `content` 可能为空串（服务端允许附件消息不带正文），
 * 因此附件消息的 `type` **必须**由 kind 兜底推导 —— 否则旧后端（或某个只扩
 * 了 attachment 没扩 type 的版本）会把图片消息降级成一条空文本气泡。
 *
 * v2 的 kind 是 `'image'|'video'|'file'`，不能再写成
 * `kind === 'image' ? 'image' : 'file'` —— 那样视频会被当成普通文件展示。
 */
export function toAttachment(a: WireAttachment | null | undefined): Attachment | null {
  if (!a || !a.id) return null
  return {
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    kind: normalizeAttachmentKind(a.kind),
    url: a.url,
    createdAt: a.createdAt,
  }
}

/**
 * 归一化附件数组（v2）。
 *
 * 兼容三种输入：
 *   1. v2 的 `attachments: []` —— 直接用（缺字段也当空数组）；
 *   2. 旧 v1 的 `attachment`（单数）—— 包成单元素数组；
 *   3. 两个都有（灰度后端）—— **以 `attachments` 为准**，避免同一附件重复渲染。
 *
 * `null` → `[]`，不是 `[null]`：下游组件可以无条件 `v-for`。
 */
export function toAttachments(
  list: Array<WireAttachment | null | undefined> | null | undefined,
  single?: WireAttachment | null,
): Attachment[] {
  const source = Array.isArray(list) && list.length > 0 ? list : single ? [single] : []
  const out: Attachment[] = []
  for (const a of source) {
    const att = toAttachment(a)
    if (att) out.push(att)
  }
  return out
}

/**
 * 归一化引用回复快照。
 *
 * 任何一个展示字段缺失都不应阻止气泡渲染引用条 —— 宁可为空字符串，也不要因此
 * 丢掉 `msgId`（丢了就没法点击跳转原消息）。
 */
export function toReplyRef(r: WireReplyRef | null | undefined): ReplyRef | null {
  if (!r || !r.msgId) return null
  return {
    msgId: r.msgId,
    senderId: r.senderId,
    senderName: r.senderName,
    preview: r.preview ?? '',
  }
}

/**
 * 归一化用户摘要。
 *
 * 注意 `online`：它是**快照**，只在会话/好友列表的 user 里出现。presence store
 * 用它做首屏播种（`presence.changed` 只推变化，不播种会导致首屏全显示离线）。
 * 早期版本漏了这个字段，导致 online 永远丢失、绿点永远不亮。
 *
 * `uid` / `role` / `status` / `mutedUntil` 是 ux2-contract §四新增字段。它们在
 * `UserBrief` 上是可选的：精简投影（会话成员/好友申请）可能不带，缺失时**保持
 * undefined**（不填默认值），让消费方用 `?? 'user'` / `?? 'active'` 自行兜底 ——
 * 这样「后端没给」与「后端给了 user/active」在类型上可区分。
 */
export function toUserBrief(u: WireUserLike | null | undefined): UserBrief {
  if (!u) return { id: '', username: '', displayName: '未知用户', avatarUrl: null }
  const brief: UserBrief = {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl || null,
    online: typeof u.online === 'boolean' ? u.online : undefined,
  }
  if (typeof u.uid === 'number') brief.uid = u.uid
  if (u.role === 'user' || u.role === 'admin') brief.role = u.role
  if (u.status === 'active' || u.status === 'banned') brief.status = u.status
  // 只有字段真的存在时才落 mutedUntil：'undefined'（后端没给）与 'null'（给了但没禁言）语义不同
  if (u.mutedUntil !== undefined) brief.mutedUntil = u.mutedUntil
  return brief
}

/**
 * 归一化完整用户。
 *
 * 与 `toUserBrief` 的区别：这里的 `uid` / `role` / `status` / `mutedUntil`
 * 是**必需**的（`User` 类型要求），因此必须给出确定值：
 *  - `uid` 缺失 → 0（不会与真实 uid 撞，因为真实 uid 从 1 开始；同时便于测试断言）
 *  - `role` 非白名单 → 'user'
 *  - `status` 非白名单 → 'active'（宁可当正常，也不要因为字段漂移把所有人当封禁）
 *  - `mutedUntil` 缺失 → null
 */
export function toUser(u: WireUser): User {
  return {
    id: u.id,
    uid: typeof u.uid === 'number' ? u.uid : 0,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl || null,
    bio: u.bio || null,
    role: u.role === 'admin' ? 'admin' : 'user',
    status: u.status === 'banned' ? 'banned' : 'active',
    mutedUntil: u.mutedUntil ?? null,
    createdAt: u.createdAt,
    online: u.online,
  }
}

/**
 * 判断用户当前是否处于**禁言中**。
 *
 * 契约 §四 的语义很具体：`mutedUntil` 非 null **且** `Date.parse(mutedUntil)`
 * 大于当前时间才算禁言。只判 `!== null` 会把「曾经被禁言、已到期」的用户
 * 永久显示成禁言状态 —— 这是最容易写错的一处，所以收敛成函数并单测。
 */
export function isMutedNow(
  user: Pick<UserBrief, 'mutedUntil'>,
  now: number = Date.now(),
): boolean {
  const until = user.mutedUntil
  if (!until) return false
  const ts = Date.parse(until)
  if (Number.isNaN(ts)) return false // 脏数据当作未禁言，不要让 UI 卡在禁言态
  return ts > now
}

/**
 * 归一化置顶记录（ux2-contract §九）。
 *
 * `id` 是 **pin 记录** id，不是消息 id；取消置顶走 `DELETE .../pins/:msgId`，
 * 用的是 `message.msgId`，两者不能混用。
 */
export function toPinnedMessage(p: WirePinnedMessage): PinnedMessage {
  return {
    id: p.id,
    message: toWireMessage(p.message),
    pinnedBy: toUserBrief(p.pinnedBy),
    pinnedAt: p.pinnedAt,
  }
}

/**
 * 会话摘要。
 * v0.2.0 已给 title/peer/memberCount/lastReadSeq，直接用；仅在后端未提供时兜底推导。
 */
export function toConversationSummary(c: WireConversation, selfId: string): ConversationSummary {
  const type = normalizeConvType(c.type)
  const members = c.members ?? []
  const selfMember = members.find((m) => m.user.id === selfId)
  const peerMember = type === 'single' ? (members.find((m) => m.user.id !== selfId) ?? null) : null

  const fallbackTitle =
    type === 'single'
      ? (peerMember?.user.displayName ?? c.name ?? '未知用户')
      : (c.name ?? members.map((m) => m.user.displayName).join('、'))

  return {
    id: c.id,
    type,
    title: c.title || fallbackTitle,
    avatarUrl: c.avatarUrl || null,
    peer: c.peer ? toUserBrief(c.peer) : peerMember ? toUserBrief(peerMember.user) : null,
    memberCount: c.memberCount ?? (type === 'group' ? members.length : null),
    lastMessage: c.lastMessage
      ? {
          type: normalizeMessageType(c.lastMessage.type),
          content: c.lastMessage.content,
          senderId: c.lastMessage.senderId,
          seq: c.lastMessage.seq,
          attachmentKind: (c.lastMessage.attachments?.[0] ?? c.lastMessage.attachment)?.kind ?? null,
        }
      : null,
    lastSeq: c.lastSeq ?? 0,
    lastReadSeq: c.lastReadSeq ?? selfMember?.lastReadSeq ?? 0,
    unreadCount: c.unreadCount ?? 0,
    updatedAt: c.updatedAt,
  }
}

export function toConversationDetail(c: WireConversation, selfId: string): ConversationDetail {
  const summary = toConversationSummary(c, selfId)
  const members = (c.members ?? []).map((m: WireMember) => ({
    user: toUserBrief(m.user),
    role: normalizeRole(m.role),
    joinedAt: m.joinedAt,
    lastReadSeq: m.lastReadSeq ?? 0,
  }))
  const selfMember = members.find((m) => m.user.id === selfId)
  return {
    ...summary,
    members,
    myRole: normalizeRole(c.myRole ?? selfMember?.role ?? 'member'),
    createdAt: c.createdAt,
  }
}

export function toWireMessage(m: WireMessage): DomainWireMessage {
  const attachments = toAttachments(m.attachments, m.attachment)
  // 类型兜底：v2 前只有单数 attachment，且某些版本「只扩了 attachment 没扩 type」，
  // 有附件却报成 text —— 按附件组合重算，避免图片被渲染成空气泡。
  let type = normalizeMessageType(m.type)
  if (attachments.length > 0) {
    if (type === 'text') type = deriveTypeFromAttachments(attachments)
  } else if (type === 'image' || type === 'video' || type === 'file' || type === 'mixed') {
    // 反向兜底：声称是附件消息却拿不到任何附件元数据 —— 降级为文本，
    // 否则 UI 会渲染一个永远加载不出来的空附件卡片。
    type = 'text'
  }
  return {
    msgId: m.msgId,
    conversationId: m.conversationId,
    senderId: m.senderId,
    clientMsgId: m.clientMsgId || null,
    seq: m.seq,
    type,
    content: m.content,
    attachments,
    recalled: m.recalled === true,
    recalledAt: m.recalledAt ?? null,
    replyTo: toReplyRef(m.replyTo),
    createdAt: m.createdAt,
  }
}

/** 按附件组合推导 type，必须与服务端规则逐字一致（见 docs/v2/API-V2.md §2）。 */
export function deriveTypeFromAttachments(attachments: Attachment[]): MessageType {
  if (attachments.length === 0) return 'text'
  const kinds = new Set(attachments.map((a) => a.kind))
  if (kinds.size > 1) return 'mixed'
  const only = attachments[0]?.kind
  if (only === 'image') return 'image'
  if (only === 'video') return 'video'
  return 'file'
}

export function toLocalMessage(m: WireMessage): LocalMessage {
  const w = toWireMessage(m)
  return {
    localId: w.msgId,
    msgId: w.msgId,
    conversationId: w.conversationId,
    senderId: w.senderId,
    clientMsgId: w.clientMsgId ?? null,
    seq: w.seq,
    type: w.type,
    content: w.content,
    attachments: w.attachments,
    recalled: w.recalled,
    recalledAt: w.recalledAt,
    replyTo: w.replyTo,
    createdAt: w.createdAt,
    status: 'sent',
  }
}

/**
 * 好友申请。后端无 `direction` 字段，由 sender/recipient 与自身关系推导。
 * 注意：后端「一次申请同时出现在双方列表」，故同一 id 在两个方向上都会出现。
 */
export function toFriendRequest(r: WireFriendRequest, selfId: string): FriendRequest {
  return {
    id: r.id,
    fromUser: toUserBrief(r.sender),
    toUser: toUserBrief(r.recipient),
    direction: r.sender.id === selfId ? 'outgoing' : 'incoming',
    status: r.status ?? 'pending',
    message: r.note || null,
    createdAt: r.createdAt,
  }
}

/** 后端好友列表是纯 User 数组（无 since），since 用 createdAt 兜底。 */
export function toFriend(u: WireUser): Friend {
  return { user: toUserBrief(u), since: u.createdAt }
}

/**
 * 本地推导关系。后端 `GET /users` 不返回 relationship（diff-report §2.2），
 * 故用已加载的好友/申请列表判断。
 */
export function deriveRelationship(
  targetId: string,
  selfId: string,
  friendIds: Set<string>,
  outgoingIds: Set<string>,
  incomingIds: Set<string>,
): Relationship {
  if (targetId === selfId) return 'self'
  if (friendIds.has(targetId)) return 'friend'
  if (outgoingIds.has(targetId)) return 'request_sent'
  if (incomingIds.has(targetId)) return 'request_received'
  return 'none'
}
