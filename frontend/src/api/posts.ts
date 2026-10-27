/**
 * 广场（Square）端点。
 *
 * 契约基准：docs/v2/API-V2.md §4（唯一事实源；后端 openapi.json 尚未收录 posts）。
 *
 * 与消息端点（api/messages.ts）的差异：
 *   1. 广场附件**允许视频**，而 `types/domain.ts` 的 `Attachment.kind` 只有
 *      `'image' | 'file'`（该文件不在本模块写作用域内，且消息侧的归一化
 *      `normalize.toAttachment` 也会把视频压成 file）。因此这里定义
 *      `SquareAttachment` 与自定义 kind 推导，**不让广场依赖消息侧归一化**。
 *   2. 分页游标是不透明字符串 `nextCursor`（不是 seq / offset）。
 *
 * 传输纪律（不得违反）：
 *   - 一律复用 `./http` 的 `http` 实例（Bearer 注入、401 续期、代际守卫都在那里）；
 *   - 错误统一 `throw toApiError(e)`，调用方拿到的一定是 `ApiError`；
 *   - 附件地址是 `/api/v1/uploads/<id>`，需要 Bearer —— 组件里必须走
 *     `fetchObjectUrl()` 换成 blob URL，**不得**把 token 拼进 URL。
 */
import { http, toApiError } from './http'
import { toUserBrief } from './normalize'
import type { WireUserLike } from './wire'
import type { Attachment } from '@/types/domain'
import type { User } from '@/api/auth.types'

/* ── 契约常量（前端校验与后端 400 的同一份数值）──────────────────── */

/** 正文上限（按 Unicode 码点计，不是 UTF-16 长度）。 */
export const POST_MAX_CHARS = 5000
/** 评论上限。 */
export const COMMENT_MAX_CHARS = 1000
/** 单帖附件总数上限。 */
export const POST_MAX_ATTACHMENTS = 9
/** 单帖视频数上限。 */
export const POST_MAX_VIDEOS = 1
/** 图片单文件上限（与上传端点一致）。 */
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** 视频单文件上限（契约 §1：视频 100MiB）。 */
export const POST_VIDEO_MAX_BYTES = 100 * 1024 * 1024
/** 分页默认页长。 */
export const POST_PAGE_SIZE = 20

/* ── 领域模型 ───────────────────────────────────────────────────── */

export type SquareAttachmentKind = 'image' | 'video' | 'file'

/**
 * 广场附件。
 *
 * 与 `Attachment` 完全同构，仅把 `kind` 放宽到含 `'video'` ——
 * `Attachment` 的 kind 是 `'image' | 'file'`，属于本类型，故可直接赋值。
 */
export type SquareAttachment = Omit<Attachment, 'kind'> & { kind: SquareAttachmentKind }

/** 帖子作者。契约声明为完整 `User`；后端若下发精简投影，缺失字段按归一化默认值兜底。 */
export interface Post {
  id: string
  author: User
  content: string
  attachments: SquareAttachment[]
  likeCount: number
  commentCount: number
  likedByMe: boolean
  mine: boolean
  createdAt: string
  updatedAt: string
}

export interface PostComment {
  id: string
  postId: string
  author: User
  content: string
  replyToId: string | null
  replyToAuthorName: string | null
  createdAt: string
}

export interface PostPage {
  items: Post[]
  nextCursor: string | null
}

export interface PostCommentPage {
  items: PostComment[]
  nextCursor: string | null
}

export interface LikeResult {
  liked: boolean
  likeCount: number
}

export interface CreatePostInput {
  content?: string
  attachmentIds?: string[]
}

export interface CreateCommentInput {
  content: string
  replyToId?: string | null
}

export interface FeedQuery {
  cursor?: string | null
  limit?: number
}

/* ── wire 形状（只在文件内可见）──────────────────────────────────── */

interface WirePostAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  /** 后端 v2 会给 'image' | 'video' | 'file'；老实现可能只有前两者。 */
  kind?: string | null
  url: string
  createdAt: string
}

interface WirePost {
  id: string
  author: WireUserLike | null
  content?: string | null
  attachments?: WirePostAttachment[] | null
  likeCount?: number | null
  commentCount?: number | null
  likedByMe?: boolean | null
  mine?: boolean | null
  createdAt: string
  updatedAt?: string | null
}

interface WirePostComment {
  id: string
  postId?: string | null
  author: WireUserLike | null
  content?: string | null
  replyToId?: string | null
  replyToAuthorName?: string | null
  createdAt: string
}

interface WirePage<T> {
  items?: T[] | null
  nextCursor?: string | null
}

interface WireLikeResult {
  liked?: boolean | null
  likeCount?: number | null
}

/* ── 归一化 ─────────────────────────────────────────────────────── */

/**
 * 附件分类：**mime 优先于后端 kind**。
 *
 * 后端 kind 是本契约新增字段，老实现/灰度期可能缺；而 mime 来自魔数嗅探，
 * 比 kind 更可信。kind 合法时直接采用（省一次前缀判断）。
 */
export function attachmentKindOf(a: {
  mimeType?: string | null
  kind?: string | null
}): SquareAttachmentKind {
  if (a.kind === 'image' || a.kind === 'video' || a.kind === 'file') return a.kind
  const mime = (a.mimeType ?? '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

function toSquareAttachment(a: WirePostAttachment | null | undefined): SquareAttachment | null {
  if (!a || !a.id) return null
  return {
    id: a.id,
    name: a.name ?? '',
    mimeType: a.mimeType ?? '',
    size: typeof a.size === 'number' ? a.size : 0,
    kind: attachmentKindOf(a),
    url: a.url ?? `/api/v1/uploads/${a.id}`,
    createdAt: a.createdAt ?? '',
  }
}

/**
 * 归一化作者。
 *
 * 契约是完整 `User`，但帖子列表的作者投影很可能精简（只有 id/username/
 * displayName/avatarUrl）。缺 `uid/role/status/mutedUntil` 时给出确定值，
 * 与 `normalize.toUser` 的兜底策略保持一致（uid 0 不会与真实 uid 撞）。
 */
export function toPostAuthor(u: WireUserLike | null | undefined): User {
  const brief = toUserBrief(u)
  return {
    ...brief,
    uid: brief.uid ?? 0,
    role: brief.role ?? 'user',
    status: brief.status ?? 'active',
    mutedUntil: brief.mutedUntil ?? null,
  }
}

function toPost(raw: WirePost): Post {
  return {
    id: raw.id,
    author: toPostAuthor(raw.author),
    content: typeof raw.content === 'string' ? raw.content : '',
    attachments: (raw.attachments ?? [])
      .map(toSquareAttachment)
      .filter((a): a is SquareAttachment => a !== null),
    likeCount: typeof raw.likeCount === 'number' ? raw.likeCount : 0,
    commentCount: typeof raw.commentCount === 'number' ? raw.commentCount : 0,
    likedByMe: raw.likedByMe === true,
    mine: raw.mine === true,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt || raw.createdAt,
  }
}

function toComment(raw: WirePostComment, fallbackPostId: string): PostComment {
  return {
    id: raw.id,
    postId: raw.postId || fallbackPostId,
    author: toPostAuthor(raw.author),
    content: typeof raw.content === 'string' ? raw.content : '',
    replyToId: raw.replyToId ?? null,
    replyToAuthorName: raw.replyToAuthorName ?? null,
    createdAt: raw.createdAt,
  }
}

/** 统一错误出口：调用方拿到的一定是 ApiError。 */
async function request<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toApiError(e)
  }
}

/* ── 帖子 ───────────────────────────────────────────────────────── */

/** 信息流：`createdAt` 降序，游标分页。 */
export async function fetchPosts(query: FeedQuery = {}): Promise<PostPage> {
  const params: Record<string, string | number> = { limit: query.limit ?? POST_PAGE_SIZE }
  if (query.cursor) params['cursor'] = query.cursor
  return request(async () => {
    const { data } = await http.get<WirePage<WirePost>>('/api/v1/posts', { params })
    return {
      items: (data.items ?? []).map(toPost),
      nextCursor: data.nextCursor ?? null,
    }
  })
}

/** 发帖：content 或 attachmentIds 至少一个（由调用方/后端共同保证）。 */
export async function createPost(input: CreatePostInput): Promise<Post> {
  const body: CreatePostInput = {}
  const content = (input.content ?? '').trim()
  if (content) body.content = content
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    body.attachmentIds = input.attachmentIds
  }
  return request(async () => {
    const { data } = await http.post<WirePost>('/api/v1/posts', body)
    return toPost(data)
  })
}

/** 单帖详情（WS 事件后补齐占位、或详情页刷新用）。 */
export async function fetchPost(postId: string): Promise<Post> {
  return request(async () => {
    const { data } = await http.get<WirePost>(`/api/v1/posts/${encodeURIComponent(postId)}`)
    return toPost(data)
  })
}

/** 删除（后端软删除；非属主且非管理员由后端 403）。 */
export async function deletePost(postId: string): Promise<void> {
  await request(() => http.delete(`/api/v1/posts/${encodeURIComponent(postId)}`))
}

/* ── 点赞 ───────────────────────────────────────────────────────── */

/** 点赞。幂等：已赞时后端返回当前状态而不报错。 */
export async function likePost(postId: string): Promise<LikeResult> {
  return request(async () => {
    const { data } = await http.post<WireLikeResult>(
      `/api/v1/posts/${encodeURIComponent(postId)}/like`,
    )
    return {
      liked: data.liked !== false,
      likeCount: typeof data.likeCount === 'number' ? data.likeCount : 0,
    }
  })
}

/** 取消点赞。 */
export async function unlikePost(postId: string): Promise<LikeResult> {
  return request(async () => {
    const { data } = await http.delete<WireLikeResult>(
      `/api/v1/posts/${encodeURIComponent(postId)}/like`,
    )
    return {
      liked: data.liked === true,
      likeCount: typeof data.likeCount === 'number' ? data.likeCount : 0,
    }
  })
}

/* ── 评论 ───────────────────────────────────────────────────────── */

/** 评论列表：`createdAt` 升序（先发的在上），游标分页。 */
export async function fetchComments(
  postId: string,
  query: FeedQuery = {},
): Promise<PostCommentPage> {
  const params: Record<string, string | number> = { limit: query.limit ?? POST_PAGE_SIZE }
  if (query.cursor) params['cursor'] = query.cursor
  return request(async () => {
    const { data } = await http.get<WirePage<WirePostComment>>(
      `/api/v1/posts/${encodeURIComponent(postId)}/comments`,
      { params },
    )
    return {
      items: (data.items ?? []).map((c) => toComment(c, postId)),
      nextCursor: data.nextCursor ?? null,
    }
  })
}

/** 发评论。`replyToId` 必须属于同一帖，否则后端 400 INVALID_REPLY_TARGET。 */
export async function createComment(
  postId: string,
  input: CreateCommentInput,
): Promise<PostComment> {
  const body: { content: string; replyToId?: string } = { content: input.content.trim() }
  if (input.replyToId) body.replyToId = input.replyToId
  return request(async () => {
    const { data } = await http.post<WirePostComment>(
      `/api/v1/posts/${encodeURIComponent(postId)}/comments`,
      body,
    )
    return toComment(data, postId)
  })
}

/** 删除评论（软删除；`commentCount` 由后端同步递减）。 */
export async function deleteComment(postId: string, commentId: string): Promise<void> {
  await request(() =>
    http.delete(
      `/api/v1/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
    ),
  )
}
