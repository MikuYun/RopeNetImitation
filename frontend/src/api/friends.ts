/**
 * 好友端点。路径与响应以后端 openapi.json **v0.2.0** 为准。
 *
 * 后端差异要点：
 *   - 列表统一 {items, nextOffset}，limit/offset 可选（默认 30，最大 100）
 *   - 好友列表是纯 User 数组（无 since）
 *   - 申请用 sender/recipient/note，无 direction；一次申请同时出现在双方列表
 *   - 处理申请是 POST /friend-requests/{id}/respond {action}
 *   - **通过申请不会自动创建私聊**（diff-report C3）→ accept 后需另调 direct
 */
import { http } from './http'
import { toFriend, toFriendRequest } from './normalize'
import type { WireFriendRequest, WirePage, WireUser } from './wire'
import type { Friend, FriendRequest } from '@/types/domain'

/** 后端 limit 最大 100，分页取到 nextOffset 为 null 为止。 */
const PAGE_LIMIT = 100

async function fetchAllPages<T>(url: string, params: Record<string, unknown>): Promise<T[]> {
  const out: T[] = []
  let offset = 0
  for (let round = 0; round < 50; round += 1) {
    const { data } = await http.get<WirePage<T>>(url, {
      params: { ...params, limit: PAGE_LIMIT, offset },
    })
    out.push(...data.items)
    if (data.nextOffset === null || data.items.length === 0) break
    offset = data.nextOffset
  }
  return out
}

export async function fetchFriends(): Promise<Friend[]> {
  const items = await fetchAllPages<WireUser>('/api/v1/friends', {})
  return items.map(toFriend)
}

export async function sendFriendRequest(input: {
  toUserId: string
  note?: string
}): Promise<FriendRequest> {
  const payload: Record<string, string> = { userId: input.toUserId }
  if (input.note) payload['note'] = input.note
  const { data } = await http.post<WireFriendRequest>('/api/v1/friend-requests', payload)
  return toFriendRequest(data, data.sender.id)
}

/**
 * 好友申请列表。后端不传 status 时返回全部，故由调用方本地按 status 过滤，
 * 一次请求即可同时拿到 incoming / outgoing（同一申请在双方列表都出现）。
 */
export async function fetchFriendRequests(selfId: string): Promise<FriendRequest[]> {
  const items = await fetchAllPages<WireFriendRequest>('/api/v1/friend-requests', {})
  return items.map((r) => toFriendRequest(r, selfId))
}

export async function respondFriendRequest(
  requestId: string,
  action: 'accept' | 'reject',
): Promise<FriendRequest> {
  const { data } = await http.post<WireFriendRequest>(
    `/api/v1/friend-requests/${encodeURIComponent(requestId)}/respond`,
    { action },
  )
  return toFriendRequest(data, data.recipient.id)
}

/**
 * 通过申请。后端 respond **不返回会话**（diff-report C3），
 * 因此这里额外建一次单聊 —— `/conversations/direct` 是幂等的。
 */
export async function acceptFriendRequest(
  requestId: string,
  senderId: string,
): Promise<{ conversationId: string }> {
  await respondFriendRequest(requestId, 'accept')
  const { data } = await http.post<{ id: string }>('/api/v1/conversations/direct', {
    userId: senderId,
  })
  return { conversationId: data.id }
}

export async function rejectFriendRequest(requestId: string): Promise<void> {
  await respondFriendRequest(requestId, 'reject')
}
