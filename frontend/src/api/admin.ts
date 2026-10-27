/**
 * 管理后台端点（ux2-contract §六）。
 *
 * 路径与响应以后端 `backend/src/routes.ts` 已注册的四个 admin 路由为准：
 *   GET    /api/v1/admin/users?query=&limit=&offset=
 *   POST   /api/v1/admin/users/:uid/mute   { minutes }
 *   DELETE /api/v1/admin/users/:uid        → 204 无正文
 *   GET    /api/v1/admin/stats
 *
 * 三个易错点（都在这里收敛掉，页面不必各自处理）：
 *
 * 1. **`:uid` 是数字 uid，不是 UUID**。URL 里拼的是 `user.uid`（如 10001），
 *    不是 `user.id`。后端参数校验是 `Type.Integer({minimum:1000})`，传 UUID
 *    会被 Fastify 直接 400，与业务错误混在一起非常难查。
 * 2. **`nextOffset: number | null` 的 null 才是末页**，不能用 `items.length < limit`
 *    判断 —— 后端 `limit+1` 探测法在「恰好整页」时 items.length === limit 且
 *    nextOffset 非 null，靠长度判断会提前停、漏掉最后一页。
 * 3. **DELETE 成功是 204 无正文**，axios 的 `data` 是空字符串。不要 JSON.parse，
 *    也不要拿返回值当 User 用。
 *
 * 权限：四个接口都要求 `role === 'admin'`，非管理员后端返回 403 `ADMIN_REQUIRED`
 * （由 `requireAdmin` 抛）。前端另有一道路由守卫（见 stores/admin.ts 的
 * `canAccessAdmin`），但**真正的边界永远在后端**，守卫只是别让用户看到空壳页面。
 */
import { http } from './http'
import { toUser } from './normalize'
import type { WirePage, WireUser } from './wire'
import type { User } from '@/api/auth.types'

/** 后端 `AdminUsersQuery.limit` 是 1..100，默认 30；这里显式给 30 与前端列表容量一致。 */
export const ADMIN_PAGE_LIMIT = 30

/** 禁言时长上限（契约 §六 `minutes: 0..525_600`，即最多 365 天）。 */
export const MUTE_MAX_MINUTES = 525_600

export interface ListUsersParams {
  /** 模糊匹配账号名 / 昵称 / uid 的十进制字符串；空串表示不过滤。 */
  query?: string
  limit?: number
  offset?: number
}

export interface AdminUserPage {
  items: User[]
  /** null 表示没有下一页。 */
  nextOffset: number | null
}

/** 概览计数（契约 §六 `AdminStats`）。 */
export interface AdminStats {
  users: number
  conversations: number
  messages: number
  uploads: number
  online: number
}

/**
 * 用户列表（按 uid 升序）。
 *
 * `query` 只在非空时才发 —— 后端 schema 是 `additionalProperties:false` 且
 * `query` 有 `maxLength: 64`，发空串虽然合法但会让 SQL 走 LIKE '%%' 分支，
 * 白白多一次全表扫描。
 */
export async function listUsers(params: ListUsersParams = {}): Promise<AdminUserPage> {
  const query: Record<string, string | number> = {
    limit: params.limit ?? ADMIN_PAGE_LIMIT,
    offset: params.offset ?? 0,
  }
  const keyword = (params.query ?? '').trim()
  if (keyword.length > 0) query['query'] = keyword
  const { data } = await http.get<WirePage<WireUser>>('/api/v1/admin/users', { params: query })
  return { items: data.items.map(toUser), nextOffset: data.nextOffset }
}

/**
 * 禁言 / 解除禁言。`minutes === 0` 表示解除（后端把 muted_until 置 null）。
 *
 * 返回的是**更新后的 User**，调用方应把它写回列表而不是重新拉整页 ——
 * 少一次往返，也避免分页 offset 在并发新增用户时错位。
 */
export async function muteUser(uid: number, minutes: number): Promise<User> {
  const safe = Math.max(0, Math.min(MUTE_MAX_MINUTES, Math.trunc(minutes)))
  const { data } = await http.post<WireUser>(
    `/api/v1/admin/users/${encodeURIComponent(String(uid))}/mute`,
    { minutes: safe },
  )
  return toUser(data)
}

/** 删除账号（204 无正文）。管理员账号会被后端 409 `CANNOT_DELETE_ADMIN` 拒绝。 */
export async function deleteUser(uid: number): Promise<void> {
  await http.delete(`/api/v1/admin/users/${encodeURIComponent(String(uid))}`)
}

export async function fetchAdminStats(): Promise<AdminStats> {
  const { data } = await http.get<AdminStats>('/api/v1/admin/stats')
  return data
}
