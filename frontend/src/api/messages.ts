/**
 * 消息端点。路径与响应以后端 openapi.json **v0.2.0** 为准。
 *
 * 后端分页响应为 {items, hasMore, nextBeforeSeq, nextAfterSeq}；
 * 游标仍是 seq，语义与需求书等价。
 */
import { http } from './http'
import { toWireMessage } from './normalize'
import type { WireMessage, WireMessagePage, WireSyncItem } from './wire'
import type { WireMessage as DomainWireMessage } from '@/types/domain'

export interface MessagePage {
  /** 无论方向，服务端保证 seq 升序 */
  items: DomainWireMessage[]
  hasMore: boolean
  nextBeforeSeq: number | null
  nextAfterSeq: number | null
}

export async function fetchMessages(
  conversationId: string,
  params: { beforeSeq?: number; afterSeq?: number; limit?: number } = {},
): Promise<MessagePage> {
  const query: Record<string, number> = { limit: params.limit ?? 30 }
  // beforeSeq 与 afterSeq 互斥，不要同时传
  if (params.afterSeq !== undefined) query['afterSeq'] = params.afterSeq
  else if (params.beforeSeq !== undefined) query['beforeSeq'] = params.beforeSeq

  const { data } = await http.get<WireMessagePage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { params: query },
  )
  return {
    items: data.items.map(toWireMessage),
    hasMore: data.hasMore,
    nextBeforeSeq: data.nextBeforeSeq ?? null,
    nextAfterSeq: data.nextAfterSeq ?? null,
  }
}

/**
 * 发消息请求体。
 *
 * 附件消息的 `content` 可为空（服务端只要求「content 或 attachmentId 至少一个」），
 * `type` 由服务端按附件 kind 推导。
 *
 * `type` 是**可选的灰度兼容字段**（与后端 task-6 确认）：
 *   - 纯文本消息仍带 `type: 'text'`，这样打到尚未升级的旧后端也不会 400
 *     （旧 schema 要求 type+content 必填）；
 *   - 附件消息不带 `type`（服务端会忽略并自行推导）；
 *   - 新后端的 `type` 只接受字面量 `'text'`，传其它值会被拒，故联合只写 'text'。
 */
export interface SendMessageInput {
  clientMsgId: string
  type?: 'text'
  content?: string
  attachmentId?: string
}

/**
 * 发消息。
 * 首次持久化返回 **201**；同 clientMsgId 同内容重试返回 **200 原消息**；
 * 重用同 id 改会话/正文返回 **409 IDEMPOTENCY_CONFLICT**。
 */
export async function sendMessage(
  conversationId: string,
  input: SendMessageInput,
): Promise<DomainWireMessage> {
  const { data } = await http.post<WireMessage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    input,
  )
  return toWireMessage(data)
}

/**
 * 断线补偿。
 * 单次最多 100 会话、每会话最多 100 条；hasMore 为真时只推进到 nextSeq，
 * **禁止直接跳到 lastSeq**，否则漏消息。
 */
export async function syncConversations(
  cursors: Array<{ conversationId: string; lastSeq: number }>,
): Promise<WireSyncItem[]> {
  const { data } = await http.post<{ items: WireSyncItem[] }>('/api/v1/sync', {
    cursors: cursors.slice(0, 100),
  })
  return data.items
}
