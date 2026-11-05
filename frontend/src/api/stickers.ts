/**
 * 个人表情包端点（v2.4 新增）。
 *
 * 三个端点：
 *   GET    /api/v1/stickers?limit&offset   → { items: Sticker[]; nextOffset: number | null }
 *   POST   /api/v1/stickers  body { uploadId }  → 201 新建 / 200 已存在（幂等）
 *   DELETE /api/v1/stickers/:stickerId     → { ok: true }
 *
 * 【为什么表情包不直接复用「上传」】表情包是一张**已上传图片的引用**：
 * 客户端先走 `POST /api/v1/uploads` 拿到 uploadId，再 `POST /api/v1/stickers`
 * 把它登记成表情。所以 `Sticker.id`（表情记录 id，删除时用）和
 * `Sticker.uploadId`（真正取图时用的 id）是两个不同的东西，传错只会得到
 * 404 STICKER_NOT_FOUND，不会有更具体的提示。本文件把两者分开写在类型里。
 *
 * 【图片地址仍然要 Bearer】`Sticker.url` 与附件一样是
 * `/api/v1/uploads/<uploadId>`，**不能**直接塞进 `<img src>`（会 401）。
 * 组件必须走 `fetchObjectUrl({ id: sticker.uploadId })` 换成 blob URL，
 * 卸载时 `revokeObjectUrl` —— 与 `Attachment` 完全一致的纪律。
 *
 * 错误码：400 INVALID_UPLOAD / UNSUPPORTED_STICKER_TYPE（只允许
 * png/jpeg/webp/gif）、404 STICKER_NOT_FOUND。
 */
import { http, toApiError } from './http'
import type { WirePage } from './wire'
import type { Attachment } from '@/types/domain'

/* ── 契约常量 ───────────────────────────────────────────────────── */

/** 后端允许登记为表情的 MIME（其它图片格式一律 UNSUPPORTED_STICKER_TYPE）。 */
export const STICKER_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** 列表默认页长（后端上限远大于此，表情包总量本来就不大）。 */
export const STICKER_PAGE_SIZE = 60

/* ── 领域模型 ───────────────────────────────────────────────────── */

export interface Sticker {
  /** 表情记录 id —— 删除时用这个。 */
  id: string
  /** 上传记录 id —— 取图 / 发送消息时用这个。 */
  uploadId: string
  name: string
  mimeType: string
  size: number
  /** 当前契约只支持静态/动态图片表情。 */
  kind: 'image'
  /** `/api/v1/uploads/<uploadId>`，需要 Bearer，不能直接给 `<img src>`。 */
  url: string
  createdAt: string
}

/** wire 形状与领域模型一致；单独声明是为了守住「wire 只出现在 api 层」的纪律。 */
interface WireSticker {
  id: string
  uploadId: string
  name: string
  mimeType: string
  size: number
  kind: 'image'
  url: string
  createdAt: string
}

export interface StickerPage {
  items: Sticker[]
  /** null 表示末页。 */
  nextOffset: number | null
}

/* ── 归一化 ─────────────────────────────────────────────────────── */

/**
 * wire → 领域。
 *
 * `url` 缺失时按 uploadId 兜底拼出来：后端灰度期间（或某些投影）不回填 url，
 * 而取图本来就只需要 uploadId，兜底不会引入错误，反而少一类「图裂」。
 */
export function normalizeSticker(raw: WireSticker): Sticker {
  return {
    id: raw.id,
    uploadId: raw.uploadId,
    name: raw.name || '表情',
    mimeType: raw.mimeType || 'image/png',
    size: typeof raw.size === 'number' ? raw.size : 0,
    kind: 'image',
    url: raw.url || `/api/v1/uploads/${encodeURIComponent(raw.uploadId)}`,
    createdAt: raw.createdAt,
  }
}

/** 该 MIME 是否允许存成表情（与后端的白名单同一份数值）。 */
export function isStickerMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return STICKER_MIME_TYPES.includes(normalized)
}

/**
 * 把表情还原成「可发送的附件」。
 *
 * 发送消息只传 attachmentIds，但乐观插入的气泡要立刻把图渲染出来，所以需要
 * 一个形状正确的 `Attachment`。`id` 用 **uploadId**（服务端附件 id 就是
 * uploadId），`url` 沿用 `/api/v1/uploads/<uploadId>`。
 */
export function stickerToAttachment(sticker: Sticker): Attachment {
  return {
    id: sticker.uploadId,
    name: sticker.name,
    mimeType: sticker.mimeType,
    size: sticker.size,
    kind: 'image',
    url: sticker.url,
    createdAt: sticker.createdAt,
  }
}

/* ── 传输 ───────────────────────────────────────────────────────── */

async function request<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toApiError(e)
  }
}

function stickerPath(stickerId: string): string {
  return `/api/v1/stickers/${encodeURIComponent(stickerId)}`
}

/** 拉取表情列表（按创建时间倒序，最近添加的在前 —— 交给服务端排序）。 */
export async function listStickers(options: { limit?: number; offset?: number } = {}): Promise<StickerPage> {
  const params: Record<string, number> = {}
  if (options.limit !== undefined) params.limit = options.limit
  if (options.offset !== undefined) params.offset = options.offset
  return request(async () => {
    const { data } = await http.get<WirePage<WireSticker>>('/api/v1/stickers', { params })
    return {
      items: (data.items ?? []).map(normalizeSticker),
      nextOffset: data.nextOffset ?? null,
    }
  })
}

/**
 * 把一张已上传的图片登记为表情。
 *
 * 幂等：同一个 uploadId 重复提交，后端返回 **200 + 原记录**（不是 201）。
 * 所以本地不需要「先查再存」，直接拿返回值并进列表即可。
 */
export async function addSticker(uploadId: string): Promise<Sticker> {
  return request(async () => {
    const { data } = await http.post<WireSticker>('/api/v1/stickers', { uploadId })
    return normalizeSticker(data)
  })
}

/**
 * 删除表情（只删表情记录，不删上传本体 —— 别处可能还在引用这张图）。
 * `stickerId` 是**表情记录 id**，不是 uploadId。
 */
export async function deleteSticker(stickerId: string): Promise<void> {
  await request(async () => {
    await http.delete(stickerPath(stickerId))
  })
}
