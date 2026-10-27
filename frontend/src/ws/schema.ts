/**
 * WebSocket 帧的 zod 定义 —— 前端侧的 WS 契约事实源。
 *
 * 出站帧在发送前 parse 一次，入站帧在分发前 parse 一次：后端独立开发，
 * 帧结构漂移是必然事件，必须在边界处失败而不是让脏数据流进 store。
 *
 * 契约基准：docs/v2/API-V2.md §2/§5（API 0.3.0，protocolVersion = 2）
 *   - 服务端信封 {v:1, id, type, timestamp, data}（信封 v 与业务 protocolVersion 独立演进）
 *   - 客户端帧**无信封 id/timestamp**，只有 {v, type, ...payload}
 *   - 消息实体字段为 msgId / content / attachments[] / recalled / replyTo
 *   - typing 字段为 active（布尔）
 *   - 发送消息、撤回与已读**走 REST**，不存在 WS 发消息 ack
 */
import { z } from 'zod'
import { WS_ENVELOPE_VERSION } from './constants'

/*
 * 关闭 zod 的 JIT 编译 —— 严格 CSP（script-src 'self'，无 'unsafe-eval'）必需。
 *
 * zod 会在 object schema 上探测 eval 能力并生成 `new Function` 快编译器：
 *   node_modules/zod/v4/core/util.js:216  allowsEval() 里 `new F("")` 探针
 *   node_modules/zod/v4/core/schemas.js:1166  const jit = !core.globalConfig.jitless
 * 探针的异常虽被 catch、功能不受影响，但浏览器仍会上报一条
 * securitypolicyviolation（script-src 拦 eval）。zod 官方注释原文：
 *   「Skip the probe under `jitless`: strict CSPs report the caught `new Function`
 *     as a `securitypolicyviolation` even though the throw is swallowed.」
 * 因而 `z.config({ jitless: true })` 是 zod 官方给出的解法（$ZodConfig.jitless
 * 的文档注释亦写「Disable JIT schema compilation. Useful in environments that
 * disallow eval.」），不是本项目的自创规避。
 *
 * 位置必须在**任何 schema 构造之前**：`const jit = !core.globalConfig.jitless`
 * 在 schema 构造时读取并固化。放进 main.ts 的 bootstrap 已经太晚 —— ESM 里
 * main.ts 的所有 import（含本文件）先于其模块体求值，那时 schema 早已建完。
 * 本文件是全仓唯一的 zod 运行时入口（handlers.ts 只 `import type`），放在
 * 模块体首行即可覆盖生产入口与单测入口两条路径。
 */
z.config({ jitless: true })

/* ── 基础标量 ───────────────────────────────────────────────────── */

const isoDateTime = z.string().min(1)
const entityId = z.string().min(1)
const seqNumber = z.number().int().min(0)

/* ── 实体 ───────────────────────────────────────────────────────── */

export const zUserBrief = z.object({
  id: entityId,
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
})

export const zUser = zUserBrief.extend({
  /**
   * ux2-contract §四新增的四个字段。**全部可选**：
   *  - 后端灰度期间 WS 帧可能还没有这些字段（丢了会整帧被拒，等于消息不显示）；
   *  - 会话成员等投影本来就可以只带精简字段。
   * 需要「完整 User」的地方（个人中心）走 REST + `normalize.toUser` 强约束。
   */
  uid: z.number().int().optional(),
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'banned']).optional(),
  mutedUntil: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  online: z.boolean().optional(),
  createdAt: isoDateTime.optional(),
})

/**
 * 附件元数据。字段与 `GET /api/v1/uploads` / `Message.attachments[]` 一致。
 *
 * 注意 `url` 需 Bearer 才能访问，前端不得直接用于 `<img src>`（见 api/uploads.ts）。
 */
export const zAttachment = z.object({
  id: entityId,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  kind: z.enum(['image', 'video', 'file']),
  url: z.string(),
  createdAt: isoDateTime,
})

/**
 * 引用回复的摘要（API-V2 §3 `ReplyRef`）。
 *
 * 只带展示所需的四个字段 —— 被引用消息的完整内容不随每条回复复制下发，
 * 否则长会话里引用链会让 payload 指数膨胀。
 */
export const zReplyRef = z.object({
  msgId: entityId,
  senderId: entityId,
  senderName: z.string(),
  preview: z.string(),
})

export const zMessage = z.object({
  msgId: entityId,
  conversationId: entityId,
  senderId: entityId,
  clientMsgId: z.string().nullable().optional(),
  seq: seqNumber,
  // 消息类型六大类（API-V2 §2）：无附件→text，单一 kind→image/video/file，混合→mixed。
  // **保持非 passthrough 的严格性**（未知 type 仍要拒帧），但必须放行全部六值，
  // 否则 WS 推来的视频/混合消息会被整帧丢弃。
  type: z.enum(['text', 'system', 'image', 'video', 'file', 'mixed']),
  content: z.string(),
  /**
   * 附件数组，**恒应为数组**（无附件 `[]`）。
   *
   * `.default([])` 是**向后兼容的硬要求**：灰度期旧后端根本没这个字段，
   * 没有默认值就会让所有旧帧 `.safeParse` 失败 → 消息大面积不显示。
   */
  attachments: z.array(zAttachment).default([]),
  /** 是否已撤回（撤回后 content=''、attachments=[]）。旧帧缺省 false。 */
  recalled: z.boolean().default(false),
  recalledAt: z.string().nullable().default(null),
  replyTo: zReplyRef.nullable().default(null),
  /**
   * @deprecated 单数附件是 v0.2 的旧形状，v0.3 已改成 `attachments[]`。
   *
   * 这里只为兼容灰度期旧后端保留解析能力；消费方（handlers）拿到后必须
   * 归一化进 `attachments`，**不得**再直接读它。等全部后端切换完成即可删除。
   */
  attachment: zAttachment.nullable().optional(),
  createdAt: isoDateTime,
})

export const zConversationMember = z.object({
  user: zUserBrief,
  role: z.enum(['owner', 'admin', 'member']),
  joinedAt: isoDateTime,
  lastReadSeq: seqNumber,
})

export const zConversation = z.object({
  id: entityId,
  type: z.enum(['single', 'group']),
  name: z.string(),
  title: z.string(),
  avatarUrl: z.string().nullable().optional(),
  peer: zUserBrief.nullable().optional(),
  ownerId: z.string().nullable().optional(),
  memberCount: z.number().int().min(0).optional(),
  myRole: z.enum(['owner', 'admin', 'member']).optional(),
  members: z.array(zConversationMember).optional(),
  unreadCount: z.number().int().min(0).optional(),
  lastSeq: seqNumber.optional(),
  lastReadSeq: seqNumber.optional(),
  lastMessage: zMessage.nullable().optional(),
  createdAt: isoDateTime.optional(),
  updatedAt: isoDateTime,
})

export const zFriendRequest = z.object({
  id: entityId,
  sender: zUserBrief,
  recipient: zUserBrief,
  note: z.string().nullable().optional(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime.optional(),
})

/**
 * 置顶记录（ux2-contract §九）。
 *
 * `id` 是 **pin 记录** id；`message.msgId` 才是消息 id（取消置顶用它）。
 * `pinnedBy` 用 `zUser`（而非 Brief）—— 契约写明是完整 User，但这里所有新增字段
 * 都是可选的，所以对精简帧也宽容。
 */
export const zPinnedMessage = z.object({
  id: entityId,
  message: zMessage,
  pinnedBy: zUser,
  pinnedAt: isoDateTime,
})

/* ── 信封 ───────────────────────────────────────────────────────── */

export const zInboundEnvelope = z.object({
  v: z.number().int(),
  id: z.string().optional(),
  type: z.string(),
  timestamp: isoDateTime,
  data: z.unknown(),
})

export type InboundEnvelope = z.infer<typeof zInboundEnvelope>

/**
 * 构造出站帧。
 * 客户端帧**不加** id / timestamp —— 后端 schema 会拒绝未知字段。
 *
 * 这里的 `v` 是**信封版本**（后端 realtime.ts 恒发 `v:1`），不是业务协议版本 —— 后者
 * 走 `ready.data.protocolVersion`（0.3.0 起为 2）。两者混用会一升级就 4002 断连。
 */
export function makeClientFrame<T extends string>(
  type: T,
  payload: Record<string, unknown> = {},
): { v: typeof WS_ENVELOPE_VERSION; type: T } & Record<string, unknown> {
  return { v: WS_ENVELOPE_VERSION, type, ...payload }
}

/* ── 入站帧 data 结构 ───────────────────────────────────────────── */

/**
 * ready 帧。后端 0.3.0 起为 `{userId,serverTime,protocolVersion:2}`（信封 v 仍是 1）。
 * 除 userId 外一律宽松：后端可能继续追加字段，前端不得因此拒帧。
 */
export const zReadyData = z
  .object({
    userId: entityId,
    /** ISO 8601 UTC；与信封 timestamp 相同。优先用它做时钟偏移 */
    serverTime: isoDateTime.optional(),
    /** 业务协议版本（0.3.0 起为 2）。缺失时不校验，便于灰度 */
    protocolVersion: z.number().int().optional(),
  })
  .passthrough()

export const zMessageCreatedData = z.object({
  message: zMessage,
  unreadCount: z.number().int().min(0).optional(),
})

/**
 * `message.updated` 帧（API-V2 §6）。
 *
 * 服务端可能下发**两种形状**：裸 `{message}` 或 `{conversationId, message}`。
 * 契约把 `conversationId` 标为可选（消息实体里本来就有），所以用 union 两种都收：
 * 只写一种就会在灰度期丢帧 —— 而丢的恰好是「撤回」这类必须立刻同步的更新。
 */
export const zMessageUpdatedData = z.union([
  z.object({ message: zMessage }),
  z.object({ conversationId: entityId.optional(), message: zMessage }),
])

/** `post.*` 帧载荷（API-V2 §7）。前端只透传给广场模块，不在这里解释业务。 */
export const zPostEventData = z.object({
  postId: entityId,
  actorId: entityId,
})

export type PostEventData = z.infer<typeof zPostEventData>

export const zConversationEventData = z.object({
  conversation: zConversation,
})

export const zConversationRemovedData = z.object({
  conversationId: entityId,
})

/**
 * `conversation.pins` 帧（ux2-contract §九.4）：置顶/取消置顶后广播**完整列表**，
 * 前端整体替换而非增量合并 —— 服务端是唯一权威，客户端不猜顺序。
 */
export const zConversationPinsData = z.object({
  conversationId: entityId,
  pins: z.array(zPinnedMessage),
})

export const zReadUpdatedData = z.object({
  conversationId: entityId,
  /** 读者 */
  userId: entityId,
  lastReadSeq: seqNumber,
  /** 接收者自己的未读数 */
  unreadCount: z.number().int().min(0).optional(),
})

export const zPresenceData = z.object({
  userId: entityId,
  online: z.boolean(),
})

export const zTypingData = z.object({
  conversationId: entityId,
  userId: entityId,
  active: z.boolean(),
})

export const zFriendRequestData = z.object({ request: zFriendRequest })

export const zErrorData = z.object({
  code: z.string(),
  message: z.string(),
})

/* ── 事件类型名（与 backend/API.md §6 逐字对齐） ────────────────── */

export const S2C = {
  READY: 'ready',
  PONG: 'pong',
  ERROR: 'error',
  MESSAGE_CREATED: 'message.created',
  /** API-V2 §6：消息被修改（撤回等）后重新下发完整 Message。 */
  MESSAGE_UPDATED: 'message.updated',
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_REMOVED: 'conversation.removed',
  CONVERSATION_READ: 'conversation.read',
  /** ux2-contract §九.4：置顶列表变化（携带完整列表）。 */
  CONVERSATION_PINS: 'conversation.pins',
  FRIEND_REQUESTED: 'friend.requested',
  FRIEND_RESOLVED: 'friend.resolved',
  PRESENCE_CHANGED: 'presence.changed',
  TYPING_CHANGED: 'typing.changed',
  /** 广场事件（API-V2 §7）：fe-square 订阅，消息层只负责分发。 */
  POST_CREATED: 'post.created',
  POST_DELETED: 'post.deleted',
  POST_LIKED: 'post.liked',
  POST_COMMENTED: 'post.commented',
} as const

export const C2S = {
  PING: 'ping',
  TYPING: 'typing',
} as const
