/**
 * 领域模型。
 *
 * 纪律：wire 类型（服务端下发的形状）不在这里手写，由后端 openapi.json
 * 经 openapi-typescript 生成到 types/api.gen.ts。这里只放纯前端模型与
 * 从 wire 类型派生的别名，避免两处各写一套。
 *
 * 后端契约命名（2026-09-28 [CONTRACT]）：
 *   User    = { id, username, displayName, avatarUrl, bio, createdAt, online }
 *   Message = { msgId, conversationId, senderId, clientMsgId, seq, type, content, createdAt }
 */

export type ConversationType = 'single' | 'group'
/**
 * 消息类型。
 *
 * `image` / `file` 是**附件消息**：正文可以为空（图片甚至恒为空），真实内容
 * 由 `attachment` 承载 —— 与后端 `POST /api/v1/uploads` + `Message.attachment`
 * 契约对齐。保持联合是超集，旧代码里的 `'text' | 'system'` 判断不会失效。
 */
export type MessageType = 'text' | 'system' | 'image' | 'file'

/**
 * 附件元数据（消息内嵌形态）。
 *
 * 与上传接口 201 响应同形，但**不含** `sha256` / 属主字段 —— 那些是服务端
 * 校验用的，没有必要进到每个接收者的消息里。
 *
 * 注意 `url`：它是 `/api/v1/uploads/<id>` 这类**需要 Bearer 鉴权**的路径。
 * 浏览器的 `<img src>` 无法自带 Authorization 头，所以前端一律先
 * `GET`(responseType:'blob') 再 `URL.createObjectURL`，**不得**直接把 `url`
 * 塞进 `<img>`。详见 `src/api/uploads.ts`。
 */
export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'file'
  url: string
  createdAt: string
}
export type MemberRole = 'owner' | 'admin' | 'member'
/**
 * 账号级别角色（与群内角色 `MemberRole` 是**两回事**）。
 *
 * `admin` 是平台管理员（ux2-contract §四），可进后台、可禁言/封禁他人；
 * `MemberRole` 说的是「这个人在某个群里是群主/管理员/成员」。
 */
export type UserRole = 'user' | 'admin'
/** 账号状态。`banned` 的账号登录会被 403 `ACCOUNT_BANNED`。 */
export type UserStatus = 'active' | 'banned'
export type Relationship = 'none' | 'friend' | 'request_sent' | 'request_received' | 'self'

export interface UserBrief {
  id: string
  /**
   * 对外可展示、可登录的稳定数字 id（ux2-contract §四新增）。
   *
   * 在 `UserBrief` 上声明为**可选**：会话成员、好友申请等投影里后端可能只下发
   * 精简字段，缺失时不能因此崩掉整个列表。`User`（auth.types）里是必需的。
   */
  uid?: number
  username: string
  displayName: string
  avatarUrl?: string | null
  /** 账号角色，缺失按 `'user'` 处理。 */
  role?: UserRole
  /** 账号状态，缺失按 `'active'` 处理。 */
  status?: UserStatus
  /**
   * 禁言到期时间（ISO8601）或 `null`。
   *
   * 语义见 ux2-contract §四：**非 null 且 `Date.parse(mutedUntil) > Date.now()`**
   * 才算「当前被禁言」；过去的时间是「已解除」，不能当禁言显示。
   */
  mutedUntil?: string | null
  /**
   * 在线状态**快照**，只在会话/好友列表的 user 里出现（后端 `User.online`）。
   *
   * 用途：首屏播种 —— `presence.changed` 只会推**变化**，若不在首屏从列表里
   * 播种，UI 会把所有在线的人显示成离线。之后由 `presence.changed` 增量修正。
   */
  online?: boolean
}

export interface ConversationMember {
  user: UserBrief
  role: MemberRole
  joinedAt: string
  lastReadSeq: number
}

export interface MessagePreview {
  type: MessageType
  content: string
  senderId: string
  seq: number
  /** 附件消息在会话列表里的短预览（不回带完整 attachment，避免列表膨胀）。 */
  attachmentKind?: 'image' | 'file' | null
}

export interface ConversationSummary {
  id: string
  type: ConversationType
  title: string
  avatarUrl?: string | null
  peer?: UserBrief | null
  memberCount?: number | null
  lastMessage?: MessagePreview | null
  lastSeq: number
  lastReadSeq: number
  unreadCount: number
  updatedAt: string
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMember[]
  myRole: MemberRole
  createdAt: string
}

export interface WireMessage {
  msgId: string
  conversationId: string
  senderId: string
  clientMsgId?: string | null
  seq: number
  type: MessageType
  content: string
  /**
   * 附件消息的元数据；非附件消息恒为 `null`（后端也保证 `system` 为 null）。
   * 声明为可选是为了兼容尚未带该字段的后端版本。
   */
  attachment?: Attachment | null
  createdAt: string
}

/** 发送状态：本地乐观态。 */
export type LocalSendStatus = 'sending' | 'sent' | 'failed'

/**
 * 本地消息模型。
 *
 * 与 wire 的差异只在「发送状态」与「乐观占位」两处，其余字段直接透传。
 * `seq` 为 null 表示尚未被服务端确认（乐观占位）。
 */
export interface LocalMessage extends Omit<WireMessage, 'seq' | 'msgId'> {
  /** 乐观阶段用 clientMsgId 作临时主键；确认后换成服务端 msgId。 */
  localId: string
  msgId: string
  seq: number | null
  status: LocalSendStatus
  /** 失败原因，用于重试提示。 */
  errorCode?: string
}

export interface FriendRequest {
  id: string
  fromUser: UserBrief
  toUser: UserBrief
  direction: 'incoming' | 'outgoing'
  status: 'pending' | 'accepted' | 'rejected' | 'expired'
  message?: string | null
  createdAt: string
}

export interface Friend {
  user: UserBrief
  since: string
}

export interface UserSearchResult {
  user: UserBrief
  relationship: Relationship
}

/**
 * 置顶消息（ux2-contract §九）。
 *
 * `id` 是 **pin 记录**的 id，不是消息 id —— 同一条消息被取消置顶后再置顶
 * 会拿到新的 pin id。真正的消息用 `message.msgId` 定位。
 */
export interface PinnedMessage {
  id: string
  message: WireMessage
  pinnedBy: UserBrief
  pinnedAt: string
}

export interface PresenceState {
  userId: string
  online: boolean
  lastSeenAt?: string | null
}

/** 会话消息分桶：每个会话一份，独立维护分页与缺口状态。 */
export interface ConversationBucket {
  conversationId: string
  /** 已确认消息，按 seq 升序。 */
  confirmed: LocalMessage[]
  /** 乐观待确认消息，按发送顺序。 */
  pending: LocalMessage[]
  /** 层2 去重：已确认的 msgId 集合。 */
  confirmedById: Set<string>
  /** 层1 去重：clientMsgId -> 乐观消息。 */
  pendingByClientMsgId: Map<string, LocalMessage>
  /** 本会话已收到的最大 seq；用于缺口检测。 */
  lastSeq: number
  /** 已加载的最小 seq；用于向上翻页。 */
  oldestSeq: number | null
  hasMoreOlder: boolean
  loaded: boolean
  loading: boolean
  /** 标记为 stale 表示缺口过大，需走 REST 完整分页补齐。 */
  stale: boolean
  /** 各成员的已读游标，用于群聊「N 人已读」。 */
  memberReadSeqs: Map<string, number>
}

export function createBucket(conversationId: string): ConversationBucket {
  return {
    conversationId,
    confirmed: [],
    pending: [],
    confirmedById: new Set(),
    pendingByClientMsgId: new Map(),
    lastSeq: 0,
    oldestSeq: null,
    hasMoreOlder: true,
    loaded: false,
    loading: false,
    stale: false,
    memberReadSeqs: new Map(),
  }
}
