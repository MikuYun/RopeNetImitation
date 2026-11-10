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
 *   2. blob URL 是**显式资源**，用完必须 `revokeObjectUrl()`，否则每渲染
 *      一张图片就泄漏一份内存。本模块只负责生成，由调用方（AttachmentView）
 *      在 onUnmounted / 附件变化时释放。
 *
 * 复用 `http` 实例：Bearer 注入、401 续期、代际守卫全部由 http.ts 统一处理，
 * 不新建 axios 实例（否则那两处刚修好的竞态防线会绕过去）。
 *
 * 【本地缓存】附件字节不可变（upload id → 内容），所以 `fetchAttachmentBlob` /
 * `fetchObjectUrl` 统一走 `@/utils/mediaCache` 的三层缓存（内存 LRU → IndexedDB
 * → 网络）。组件反复挂载/卸载（虚拟列表滚动）时命中缓存，**不再重复请求**。
 * `revokeObjectUrl` 变成缓存层的「释放一份引用」：幂等、只对 `blob:` 生效，
 * 只摘掉内存里的 URL 关联，IndexedDB 里的字节保留，下次同 key 重新建 URL。
 */
import { http } from './http'
import {
  evictCachedMedia,
  getCachedBlob,
  getCachedObjectUrl,
  releaseCachedObjectUrl,
} from '@/utils/mediaCache'
import type { Attachment, AttachmentKind } from '@/types/domain'
import type { WireAttachment } from './wire'

/** 图片/普通文件上限（50 MiB，与服务端一致）；超了后端返回 413，前端提前拦。 */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/**
 * 视频上限（100 MiB）。
 *
 * 与 `@/utils/attachments` 的 `MAX_VIDEO_UPLOAD_BYTES` 是同一个数值 —— 这里再导出
 * 一份是为了让「上传通道自己的上限」与「表单校验的上限」都能就近引用，避免组件
 * 为了一个常量去 import 校验模块。两处必须同步改。
 */
export const UPLOAD_VIDEO_MAX_BYTES = 100 * 1024 * 1024

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

/** 上传 201 响应 → 领域 Attachment。kind 只认白名单，其余一律 file。 */
function toAttachment(a: WireAttachment): Attachment {
  const kind: AttachmentKind =
    a.kind === 'image' || a.kind === 'video' ? a.kind : 'file'
  return {
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    kind,
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
      // 上传大文件时 20s 的默认超时太紧（慢网 50MiB 可能超）
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
 * 不经过缓存的原始拉取（唯一真正发网络请求的地方）。
 *
 * 必须用 `responseType: 'blob'`，否则 axios 会把二进制当文本解码，图片直接损坏。
 */
async function requestAttachmentBlob(id: string): Promise<Blob> {
  const { data } = await http.get<Blob>(`/api/v1/uploads/${encodeURIComponent(id)}`, {
    responseType: 'blob',
    timeout: 60_000,
  })
  return data
}

/**
 * 取附件字节（走本地缓存：内存 → IndexedDB → 网络）。
 *
 * 返回的 Blob 是共享的，调用方**不得**修改它；需要 objectURL 请用
 * `fetchObjectUrl`，它复用缓存里的 URL，比自己 createObjectURL 更省。
 */
export async function fetchAttachmentBlob(attachment: Pick<Attachment, 'id'>): Promise<Blob> {
  return getCachedBlob(attachment.id, () => requestAttachmentBlob(attachment.id))
}

/**
 * 取附件 → blob URL（走本地缓存，命中时复用已有 URL，不新建）。
 *
 * 调用方负责 `revokeObjectUrl(url)`；同一 URL 可能被多个调用方共享，缓存层用
 * 引用计数保证最后一个释放者才真正 revoke。
 *
 * 传了 `signal` 时，若等待期间被 abort，则以 AbortError 拒绝，并释放刚拿到的那份
 * 引用（不会泄漏 objectURL）。abort 不会取消共享的网络请求 —— 那个结果正好留给
 * 缓存和其他等待者。
 */
export async function fetchObjectUrl(
  attachment: Pick<Attachment, 'id'>,
  signal?: AbortSignal,
): Promise<string> {
  const url = await getCachedObjectUrl(attachment.id, () => requestAttachmentBlob(attachment.id))
  if (signal?.aborted) {
    revokeObjectUrl(url)
    throw new DOMException('aborted', 'AbortError')
  }
  return url
}

/**
 * 释放 blob URL（幂等、只对 `blob:` 生效）。
 *
 * 与老的直接 `URL.revokeObjectURL` 的区别：同一附件可能被多个组件同时显示，
 * 缓存层按引用计数延迟到最后一个释放者才真正 revoke；并且**不会**删除
 * IndexedDB 里持久化的字节 —— 下次再显示只需重建 objectURL，0 网络请求。
 * 传 null/空串是安全的，方便直接放进 onUnmounted。
 */
export function revokeObjectUrl(url: string | null | undefined): void {
  releaseCachedObjectUrl(url)
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

/** 删除附件（发送后不再引用时清理；服务端对已附着附件返回 409 UPLOAD_IN_USE）。
 *
 * 成功后会丢弃本地缓存里的这份字节：服务端已不可达，再留着只会白占配额。
 */
export async function deleteUpload(id: string): Promise<void> {
  await http.delete(`/api/v1/uploads/${encodeURIComponent(id)}`)
  evictCachedMedia(id)
}
