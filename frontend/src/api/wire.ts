/**
 * 后端真实响应形状（wire 类型）。
 *
 * 来源：backend/openapi.json **v0.2.0**（2026-09-28）+ backend/API.md。
 * 契约基准与差异见 docs/contract/diff-report.md。
 *
 * 纪律：wire 类型只在本文件与 normalize.ts 出现。业务层与组件一律使用
 * types/domain.ts 的领域模型 —— 后端改字段名时只改 normalize 一处。
 */

export interface WireUser {
  id: string
  /** ux2-contract §四新增：对外可展示/可登录的稳定数字 id。 */
  uid: number
  username: string
  displayName: string
  avatarUrl: string
  bio: string
  /** 账号级别角色（平台管理员）——注意与群内 `WireMember.role` 不是同一个概念。 */
  role: 'user' | 'admin'
  status: 'active' | 'banned'
  /** 禁言到期时间；非 null 且晚于当前时间才算被禁言。 */
  mutedUntil: string | null
  createdAt: string
  online: boolean
}

/**
 * 附件元数据（后端 `Attachment`）。
 *
 * `url` 是 `/api/v1/uploads/<id>`，访问需要 Bearer —— 前端必须走
 * `GET`(responseType:'blob') 再 `URL.createObjectURL`，不得把 token 拼进 URL，
 * 也不得直接放进 `<img src>`。
 */
export interface WireAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'file'
  url: string
  createdAt: string
}

export interface WireMessage {
  msgId: string
  conversationId: string
  senderId: string
  /**
   * 发送方的幂等键。**服务端广播/查询回来的消息可能没有它**（例如 system 消息、
   * 由别人发出的消息在某些后端实现里不回填），所以这里必须是「可选可空」，
   * 与 `types/domain.ts` 的 `WireMessage.clientMsgId?: string | null` 保持一致。
   */
  clientMsgId?: string | null
  seq: number
  type: 'text' | 'system' | 'image' | 'file'
  content: string
  /** 附件消息才有；`system` 恒为 null。旧后端可能不带该字段。 */
  attachment?: WireAttachment | null
  createdAt: string
}

/**
 * 「可能是灰度版」的 wire user —— 归一化层的实际入参形状。
 *
 * 为什么不是 `WireUser`：新后端 REST 响应一定给全 `uid/role/status/mutedUntil`
 * 以及 `avatarUrl/bio/createdAt/online`，但有两类数据拿不到这么全：
 *  1. 旧后端（缺 ux2 四字段）；
 *  2. WS 帧 —— zod schema 为了「不因缺字段整帧被拒」把可选字段都设成 optional，
 *     推断出来的类型里 `avatarUrl/createdAt` 等也是可选的。
 * 与其在调用处层层断言，不如让归一化函数直接收这个更宽的形状，内部做兜底。
 */
export interface WireUserLike {
  id: string
  username: string
  displayName: string
  avatarUrl?: string | null
  bio?: string | null
  uid?: number
  role?: 'user' | 'admin'
  status?: 'active' | 'banned'
  mutedUntil?: string | null
  createdAt?: string
  online?: boolean
}

export interface WireMember {
  user: WireUser
  role: 'owner' | 'admin' | 'member'
  joinedAt: string
  lastReadSeq: number
}

export interface WireConversation {
  id: string
  type: 'single' | 'group'
  /** 原始群名；私聊为空 */
  name: string
  /** 请求者视角标题：私聊=对方昵称，群聊=群名 */
  title: string
  avatarUrl: string
  /** 仅单聊返回 */
  peer?: WireUser
  ownerId: string | null
  memberCount: number
  myRole: 'owner' | 'admin' | 'member'
  members: WireMember[]
  unreadCount: number
  lastSeq: number
  lastReadSeq: number
  lastMessage: WireMessage | null
  createdAt: string
  updatedAt: string
}

export interface WireFriendRequest {
  id: string
  sender: WireUser
  recipient: WireUser
  note: string
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: string
  updatedAt: string
}

/** 统一分页包装：后端列表统一 `{items, nextOffset}`。 */
export interface WirePage<T> {
  items: T[]
  /** null 表示末页 */
  nextOffset: number | null
}

export interface WireMessagePage {
  items: WireMessage[]
  hasMore: boolean
  nextBeforeSeq: number | null
  nextAfterSeq: number | null
}

/** 分页包装：置顶列表。 */
export interface WirePinsPage {
  items: WirePinnedMessage[]
}

/**
 * 置顶记录（ux2-contract §九）。
 *
 * `id` 是 **pin 记录** id；要定位/取消置顶一条消息时用 `message.msgId`。
 */
export interface WirePinnedMessage {
  id: string
  message: WireMessage
  /**
   * 用 LooseWireUser：这条记录既可能来自 REST（新后端，四字段齐全），
   * 也可能来自 WS `conversation.pins`（zod schema 为灰度把四字段设成 optional）。
   */
  pinnedBy: WireUserLike
  pinnedAt: string
}

export interface WireAuthResult {
  token: string
  tokenType: 'Bearer'
  expiresAt: string
  user: WireUser
}

export interface WireWsTicket {
  ticket: string
  expiresIn: number
}

export interface WireSyncItem {
  conversationId: string
  messages: WireMessage[]
  /** 服务端当前最高序号 */
  lastSeq: number
  unreadCount: number
  hasMore: boolean
  /** 本页实际最后返回序号；无消息时等于输入游标 */
  nextSeq: number
}

/** read 端点返回 204 无正文（见 diff-report C1）。 */
export type WireReadResult = void

export interface WireOk {
  ok: true
}

export interface WireHealth {
  status: string
  version: string
  protocolVersion: string
  serverTime: string
}

export interface WireApiError {
  error: {
    code: string
    message: string
    traceId?: string
  }
}
