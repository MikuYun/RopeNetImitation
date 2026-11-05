/**
 * 消息端点。路径与响应以后端 openapi.json **v0.3.0**（docs/v2/API-V2.md）为准。
 *
 * 后端分页响应为 {items, hasMore, nextBeforeSeq, nextAfterSeq}；
 * 游标仍是 seq，语义与需求书等价。
 */
import { http, toApiError } from './http'
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
 * 发消息请求体（v2）。
 *
 * 【关键：只传存在的字段】后端请求体一律 `additionalProperties: false`，
 * 多传一个字段就是 400 VALIDATION_ERROR。因此组 body 时需要逐字段判断，
 * 而不是把 input 直接丢给 axios。
 *
 * 【content 空串必须省略】后端没有 minLength，但传 `''` 与省略在语义上没区别，
 * 省略能少一个字段、少一次「空串算不算有内容」的歧义。纯附件消息（只有图片/文件、
 * 没有正文）是合法的发送方式，此时 content 直接不出现即可。
 *
 * 【attachmentIds】1..9，unique；video ≤1、image ≤9、合计 ≤9。
 * 这些组合规则前端也要先拦（见 utils/attachments.ts#checkAttachmentSelection），
 * 客户端先行校验能省一次往返、错误文案也更贴近产品语言。
 */
export interface SendMessageInput {
  clientMsgId: string
  content?: string
  attachmentIds?: string[]
  replyToMsgId?: string | null
}

/** 把领域层的 SendMessageInput 转成**只含存在字段**的请求体。 */
function toSendBody(input: SendMessageInput): Record<string, unknown> {
  const body: Record<string, unknown> = { clientMsgId: input.clientMsgId }
  // 空串 / 纯空白不上送：后端 minLength 1 会拒
  const content = input.content?.trim()
  if (content) body['content'] = content
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    body['attachmentIds'] = input.attachmentIds
  }
  // 只有存在引用时才传 replyToMsgId（不传不等于 null，但少传一个字段更安全）
  if (input.replyToMsgId) body['replyToMsgId'] = input.replyToMsgId
  return body
}

/**
 * 发消息。
 * 首次持久化返回 **201**；同 clientMsgId 同内容重试返回 **200 原消息**；
 * 重用同 id 改会话/正文返回 **409 IDEMPOTENCY_CONFLICT**。
 *
 * 可能抛的业务错：
 *   - 409 `UPLOAD_IN_USE`：附件已被别的消息引用（选中的图同时被另一个窗口发了）
 *   - 400 `ATTACHMENT_LIMIT`：附件组合超限
 *   - 400 `VALIDATION_ERROR`：既没有文字也没有附件
 *
 * 【超时与重发】这里**不用**全局 20 秒超时。带附件的消息在服务端要走事务
 * （占位检查 + 插入消息 + 插入附件关联），慢网下 20 秒不够，超时后前端已经
 * 弹出「发送失败」，可服务端其实落库成功了 —— 用户看到的失败是假的。
 * 所以单独放宽到 60 秒，并且对「一个字节响应都没收到」（status 0）的情况
 * **自动重发一次**：后端按 `(senderId, clientMsgId)` 幂等，重发要么拿到
 * 200 原消息、要么补上真正没送达的那次，不会产生重复消息。
 */
const SEND_TIMEOUT_MS = 60_000
const SEND_RETRY_DELAY_MS = 600

export async function sendMessage(
  conversationId: string,
  input: SendMessageInput,
): Promise<DomainWireMessage> {
  const url = `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`
  const body = toSendBody(input)
  const post = (): Promise<DomainWireMessage> =>
    http
      .post<WireMessage>(url, body, { timeout: SEND_TIMEOUT_MS })
      .then(({ data }) => toWireMessage(data))

  try {
    return await post()
  } catch (e) {
    // status 0 = 连接被拒/断开/客户端超时，请求是否到达服务端未知。
    // 只有这一类值得重发：4xx/5xx 都有确定的语义，重发只是重复失败。
    if (toApiError(e).status !== 0) throw e
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS))
    return post()
  }
}

/**
 * 撤回消息（v2）。仅作者本人、且 `createdAt` 距今 ≤ 120 秒。
 *
 * 成功返回**已脱敏的** Message（`recalled=true`、`content=''`、`attachments=[]`）。
 * 调用方必须用返回值 `upsertMessage()` 到 store —— 不要自己手改字段，
 * 服务端可能还改了其它字段。
 *
 * 超过时限 → 403 `RECALL_WINDOW_EXPIRED`。
 */
export async function recallMessage(
  conversationId: string,
  msgId: string,
): Promise<DomainWireMessage> {
  const { data } = await http.post<WireMessage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(msgId)}/recall`,
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
