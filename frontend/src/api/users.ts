/**
 * 用户端点。路径与响应以后端 openapi.json **v0.2.0** 为准。
 *
 * 注意：后端 `GET /users?q=` 为**模糊匹配**（用户名+昵称），且不返回
 * `relationship` —— 关系由调用方用已加载的好友/申请列表本地推导
 * （见 docs/contract/diff-report.md §2.2 与 normalize.deriveRelationship）。
 */
import { http } from './http'
import { toUser } from './normalize'
import type {
  WirePage,
  WirePost,
  WirePostPage,
  WireUser,
  WireUserProfileView,
} from './wire'
import type { User } from './auth.types'
import type { Relationship } from '@/types/domain'

export async function fetchMe(): Promise<User> {
  const { data } = await http.get<WireUser>('/api/v1/users/me')
  return toUser(data)
}

/** 体字段为 {displayName?, avatarUrl?, bio?}；后端拒绝未知字段，故按需构造。 */
export async function updateMe(input: {
  displayName?: string
  bio?: string
  avatarUrl?: string
}): Promise<User> {
  const payload: Record<string, string> = {}
  if (input.displayName !== undefined) payload['displayName'] = input.displayName
  if (input.bio !== undefined) payload['bio'] = input.bio
  if (input.avatarUrl !== undefined) payload['avatarUrl'] = input.avatarUrl
  const { data } = await http.patch<WireUser>('/api/v1/users/me', payload)
  return toUser(data)
}

/** q 必填，1–40 字符；后端为模糊匹配，不返回自己。 */
export async function searchUsers(query: string, limit = 30): Promise<User[]> {
  const { data } = await http.get<WirePage<WireUser>>('/api/v1/users', {
    params: { q: query, limit, offset: 0 },
  })
  return data.items.map(toUser)
}

/* ------------------------------------------------------------------ *
 * v2 访客资料（API-V2.md §3）
 * ------------------------------------------------------------------ */

/** 访客资料聚合视图：用户 + 访问者与之的关系 + 会话/动态/好友计数。 */
export interface UserProfileView {
  user: User
  relationship: Relationship
  conversationId: string | null
  postCount: number
  friendCount: number
}

/**
 * `GET /users/:userId`。
 *
 * 404 USER_NOT_FOUND；relationship 的 `self` 表示 userId 是当前登录用户。
 */
export async function fetchUserProfile(userId: string): Promise<UserProfileView> {
  const { data } = await http.get<WireUserProfileView>(
    `/api/v1/users/${encodeURIComponent(userId)}`,
  )
  return {
    user: toUser(data.user),
    relationship: data.relationship,
    conversationId: data.conversationId ?? null,
    postCount: typeof data.postCount === 'number' ? data.postCount : 0,
    friendCount: typeof data.friendCount === 'number' ? data.friendCount : 0,
  }
}

/** 访客资料的动态列表（分页，按 created_at DESC）。 */
export async function fetchUserPosts(
  userId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<{ items: WirePost[]; nextCursor: string | null }> {
  const query: Record<string, string | number> = {}
  if (params.cursor) query['cursor'] = params.cursor
  if (typeof params.limit === 'number') query['limit'] = params.limit
  const { data } = await http.get<WirePostPage>(
    `/api/v1/users/${encodeURIComponent(userId)}/posts`,
    { params: query },
  )
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextCursor: data.nextCursor ?? null,
  }
}
