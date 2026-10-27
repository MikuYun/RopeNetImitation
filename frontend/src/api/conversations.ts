/**
 * 会话端点。路径与响应以后端 openapi.json **v0.2.0** 为准。
 *
 * 注意（见 docs/contract/diff-report.md §3）：
 *   - `read` 返回 204 无正文 → 拿不到权威 unreadCount，改由 WS conversation.read 推送
 *   - `DELETE .../members/{userId}` 返回 {ok:true} → 需重新 GET 校准
 */
import { http } from './http'
import { toConversationDetail, toConversationSummary } from './normalize'
import type { WireConversation, WireOk, WirePage } from './wire'
import type { ConversationDetail, ConversationSummary } from '@/types/domain'

const CONV_LIMIT = 100

export async function fetchConversations(selfId: string): Promise<ConversationSummary[]> {
  const { data } = await http.get<WirePage<WireConversation>>('/api/v1/conversations', {
    params: { limit: CONV_LIMIT, offset: 0 },
  })
  return data.items.map((c) => toConversationSummary(c, selfId))
}

export async function fetchConversation(id: string, selfId: string): Promise<ConversationDetail> {
  const { data } = await http.get<WireConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}`,
  )
  return toConversationDetail(data, selfId)
}

/** 建单聊。后端幂等：同一对用户返回既有会话。必须已是好友。 */
export async function createDirect(
  peerUserId: string,
  selfId: string,
): Promise<ConversationSummary> {
  const { data } = await http.post<WireConversation>('/api/v1/conversations/direct', {
    userId: peerUserId,
  })
  return toConversationSummary(data, selfId)
}

export async function createGroup(
  name: string,
  memberIds: string[],
  selfId: string,
): Promise<ConversationSummary> {
  const { data } = await http.post<WireConversation>('/api/v1/conversations/group', {
    name,
    memberIds,
  })
  return toConversationSummary(data, selfId)
}

export async function renameConversation(
  id: string,
  name: string,
  selfId: string,
): Promise<ConversationSummary> {
  const { data } = await http.patch<WireConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}`,
    { name },
  )
  return toConversationSummary(data, selfId)
}

export async function addMembers(
  id: string,
  memberIds: string[],
  selfId: string,
): Promise<ConversationDetail> {
  const { data } = await http.post<WireConversation>(
    `/api/v1/conversations/${encodeURIComponent(id)}/members`,
    { memberIds },
  )
  return toConversationDetail(data, selfId)
}

/** 后端返回 {ok:true}，故移除后需重新拉详情校准（diff-report C2）。 */
export async function removeMember(id: string, userId: string): Promise<WireOk> {
  const { data } = await http.delete<WireOk>(
    `/api/v1/conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
  )
  return data
}

/**
 * 上报已读游标。返回 204 无正文（diff-report C1）。
 * 只前进不回退；0 合法；正数必须对应当前会话已有消息。
 */
export async function markRead(id: string, lastReadSeq: number): Promise<void> {
  await http.post(`/api/v1/conversations/${encodeURIComponent(id)}/read`, { lastReadSeq })
}
