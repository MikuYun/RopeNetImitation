/**
 * 附件上传/下载端点。
 *
 * 契约（后端 task-6 固定）：
 *   POST   /api/v1/uploads?filename=<URL 编码文件名>   裸二进制 body → 201 Attachment
 *   GET    /api/v1/uploads/:id                         → 原始字节（**必须带 Bearer**）
 *   DELETE /api/v1/uploads/:id                         → 204
 *
 * 两条安全纪律，任何改动都不得违反：
 *   1. **不得**把 token 拼进 URL（禁止 `?token=` / `?access_token=`）。
 *      浏览器 `<img src>` 无法自带 Authorization 头，所以图片一律走
 *      `fetchObjectUrl()`：axios 带 Bearer 取字节 → `URL.createObjectURL`
 *      → 交给 `<img>`。blob URL 是同源临时句柄，不含任何凭据。
 *   2. blob URL 是**显式资源**，用完必须 `URL.revokeObjectURL()`，否则每渲染
 *      一张图片就泄漏一份内存。本模块只负责生成，由调用方（AttachmentView）
 *      在 onUnmounted / 附件变化时释放。
 *
 * 复用 `http` 实例：Bearer 注入、401 续期、代际守卫全部由 http.ts 统一处理，
 * 不新建 axios 实例（否则那两处刚修好的竞态防线会绕过去）。
 */
import { http } from './http'
import type { Attachment } from '@/types/domain'
import type { WireAttachment } from './wire'

/** 与服务端上限一致（10 MiB）；超了这个值后端返回 413，前端提前拦。 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** 上传进度的回调形态（axios onUploadProgress 的裁剪版）。 */
export interface UploadProgress {
  loaded: number
  total: number
  /** 0..1；total 未知时为 0 */
  ratio: number
}

export interface UploadOptions {
  onProgress?: (p: UploadProgress) => void
  /** 取消上传（组件卸载时）。abort 后 promise 以 CanceledError 拒绝。 */
  signal?: AbortSignal
}

function toAttachment(a: WireAttachment): Attachment {
  return {
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    kind: a.kind === 'image' ? 'image' : 'file',
    url: a.url,
    createdAt: a.createdAt,
  }
}

/**
 * 上传一个文件。
 *
 * body 是 `File` 本身（裸二进制，不用 multipart）；文件名走 query 参数。
 * Content-Type 用浏览器给的类型；退化到 octet-stream 时服务端**忽略它**，
 * 改用魔数嗅探判定真实类型 —— 客户端声明的类型不可信。
 */
export async function uploadFile(file: File, options: UploadOptions = {}): Promise<Attachment> {
  const { data } = await http.post<WireAttachment>(
    `/api/v1/uploads?filename=${encodeURIComponent(file.name)}`,
    file,
    {
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      // 上传大文件时 20s 的默认超时太紧（慢网 10MiB 可能超）
      timeout: 120_000,
      signal: options.signal,
      onUploadProgress: (e) => {
        if (!options.onProgress) return
        const total = e.total ?? file.size
        const loaded = e.loaded
        options.onProgress({ loaded, total, ratio: total > 0 ? Math.min(1, loaded / total) : 0 })
      },
    },
  )
  return toAttachment(data)
}

/**
 * 取附件字节并转成 blob URL。
 *
 * 必须用 `responseType: 'blob'`，否则 axios 会把二进制当文本解码，图片直接损坏。
 */
export async function fetchAttachmentBlob(attachment: Pick<Attachment, 'id'>): Promise<Blob> {
  const { data } = await http.get<Blob>(`/api/v1/uploads/${encodeURIComponent(attachment.id)}`, {
    responseType: 'blob',
    timeout: 60_000,
  })
  return data
}

/**
 * 取附件 → blob URL。调用方负责 `revokeObjectUrl(url)`。
 */
export async function fetchObjectUrl(
  attachment: Pick<Attachment, 'id'>,
  signal?: AbortSignal,
): Promise<string> {
  const blob = await fetchAttachmentBlob(attachment)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  return URL.createObjectURL(blob)
}

/** 释放 blob URL。传 null/空串是安全的（幂等），方便直接放进 onUnmounted。 */
export function revokeObjectUrl(url: string | null | undefined): void {
  if (!url) return
  if (!url.startsWith('blob:')) return
  URL.revokeObjectURL(url)
}

/**
 * 下载附件（文件卡片用）。
 *
 * 同样走 Bearer + blob，绝不把带凭据的 URL 交给 `<a href>`；先取字节再触发
 * 一个临时 `<a download>`，点击即弃。
 */
export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const blob = await fetchAttachmentBlob(attachment)
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = attachment.name || 'download'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // 给浏览器一点时间去消费 click 生成的下载任务，立刻 revoke 会导致失败
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

/** 删除附件（发送后不再引用时清理；服务端对已附着附件返回 409 UPLOAD_IN_USE）。 */
export async function deleteUpload(id: string): Promise<void> {
  await http.delete(`/api/v1/uploads/${encodeURIComponent(id)}`)
}
