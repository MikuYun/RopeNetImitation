/**
 * WebSocket 帧的 zod 定义 —— 前端侧的 WS 契约事实源。
 *
 * 出站帧在发送前 parse 一次，入站帧在分发前 parse 一次：后端独立开发，
 * 帧结构漂移是必然事件，必须在边界处失败而不是让脏数据流进 store。
 *
 * 契约基准：backend/API.md §6（v0.2.0）+ docs/contract/diff-report.md §2.5
 *   - 服务端信封 {v:1, id, type, timestamp, data}
 *   - 客户端帧**无信封 id/timestamp**，只有 {v, type, ...payload}
 *   - 消息实体字段为 msgId / content
 *   - typing 字段为 active（布尔）
 *   - 发送消息与已读**走 REST**，不存在 WS 发消息 ack
 */
import { z } from 'zod'
import { WS_PROTOCOL_VERSION } from './constants'

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
 * 附件元数据。字段与 `GET /api/v1/uploads` / `Message.attachment` 一致。
 *
 * 注意 `url` 需 Bearer 才能访问，前端不得直接用于 `<img src>`（见 api/uploads.ts）。
 */
export const zAttachment = z.object({
  id: entityId,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  kind: z.enum(['image', 'file']),
  url: z.string(),
  createdAt: isoDateTime,
})

export const zMessage = z.object({
  msgId: entityId,
  conversationId: entityId,
  senderId: entityId,
  clientMsgId: z.string().nullable().optional(),
  seq: seqNumber,
  // 附件消息：image / file。**保持非 passthrough 的严格性**（未知 type 仍要拒帧），
  // 但要放行新增的两个值，否则 WS 推来的附件消息会被整帧丢弃。
  type: z.enum(['text', 'system', 'image', 'file']),
  content: z.string(),
  // 可选：旧后端不带；`system` 恒为 null
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
 */
export function makeClientFrame<T extends string>(
  type: T,
  payload: Record<string, unknown> = {},
): { v: typeof WS_PROTOCOL_VERSION; type: T } & Record<string, unknown> {
  return { v: WS_PROTOCOL_VERSION, type, ...payload }
}

/* ── 入站帧 data 结构 ───────────────────────────────────────────── */

/**
 * ready 帧。后端 v0.2.0 落地后为 `{userId,serverTime,protocolVersion:1}`。
 * 除 userId 外一律宽松：后端可能继续追加字段，前端不得因此拒帧。
 */
export const zReadyData = z
  .object({
    userId: entityId,
    /** ISO 8601 UTC；与信封 timestamp 相同。优先用它做时钟偏移 */
    serverTime: isoDateTime.optional(),
    /** 信封协议版本，数字 1 */
    protocolVersion: z.number().int().optional(),
  })
  .passthrough()

export const zMessageCreatedData = z.object({
  message: zMessage,
  unreadCount: z.number().int().min(0).optional(),
})

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
} as const

export const C2S = {
  PING: 'ping',
  TYPING: 'typing',
} as const
