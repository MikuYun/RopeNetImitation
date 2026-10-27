/**
 * 附件相关的**纯逻辑**（无 DOM、无网络、无 Vue 依赖）—— 方便在 node 环境单测。
 *
 * 职责：
 *   1. 上传前的前端硬校验（>10MiB / 空文件先拦，别只靠后端 413）；
 *   2. 人类可读体积；
 *   3. mime/扩展名 → 文件卡片图标分类；
 *   4. 附件在会话列表里的短预览文案（`[图片]` / `[文件] xxx.pdf`）；
 *   5. 附件 → 消息 type 的映射（服务端也会推，前端用于乐观占位）。
 *
 * 安全说明：这里**不生成任何 HTML**，只返回字符串与枚举值。
 */
import type { Attachment, MessageType } from '@/types/domain'

/** 与服务端上限一致：10 * 1024 * 1024 字节。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export type UploadRejectCode = 'EMPTY_FILE' | 'UPLOAD_TOO_LARGE'

export interface UploadCheckRejected {
  ok: false
  code: UploadRejectCode
  message: string
}

export type UploadCheck = { ok: true } | UploadCheckRejected

/**
 * 上传前校验。**只做前端能确定的两件事**（体积、空文件）；
 * 类型白名单由服务端按魔数嗅探（客户端 mime 不可信），前端不假装能验。
 */
export function checkUploadFile(file: { name: string; size: number }): UploadCheck {
  if (!file.name || file.size <= 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '不能发送空文件' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: 'UPLOAD_TOO_LARGE',
      message: `文件超过 ${formatBytes(MAX_UPLOAD_BYTES)}（当前 ${formatBytes(file.size)}）`,
    }
  }
  return { ok: true }
}

/** 1536 → `1.5 KB`，10.5MiB → `10.5 MB`，0 → `0 B`。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 整数单位（B）直接取整；其余保留 1 位小数，>=100 时也不要长出小数尾巴
  const text = unit === 0 ? String(Math.round(value)) : value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 附件在 UI 上归到哪一类图标（pdf / zip / text / image / other）。 */
export type AttachmentIconKind = 'pdf' | 'zip' | 'text' | 'image' | 'other'

const RE_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
const RE_TEXT_EXT =
  /\.(txt|md|markdown|log|csv|tsv|json|jsonc|xml|ya?ml|toml|ini|conf|css|scss|less|html?|jsx?|tsx?|vue|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|sql)$/i

export function attachmentIconKind(att: Pick<Attachment, 'mimeType' | 'name'>): AttachmentIconKind {
  const mime = (att.mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || /\.pdf$/i.test(att.name)) return 'pdf'
  if (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    /\.(zip|rar|7z|gz|tar|tgz|bz2|xz)$/i.test(att.name)
  ) {
    return 'zip'
  }
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text'
  // mime 不在白名单（服务端只存白名单内的类型）时退回扩展名判断
  if (RE_IMAGE_EXT.test(att.name)) return 'image'
  if (RE_TEXT_EXT.test(att.name)) return 'text'
  return 'other'
}

/** 附件 → 消息 type（服务端也会推导；前端只需要乐观占位与渲染分支）。 */
export function messageTypeOfAttachment(att: Pick<Attachment, 'kind'>): MessageType {
  return att.kind === 'image' ? 'image' : 'file'
}

export function isImageAttachment(att: Pick<Attachment, 'kind' | 'mimeType'>): boolean {
  return att.kind === 'image' || (att.mimeType || '').toLowerCase().startsWith('image/')
}

/** 会话列表里的最后一条预览：附件消息不能把巨大的 base64/文件名直接塞进单行。 */
export function attachmentPreviewText(att: Pick<Attachment, 'kind' | 'name'>): string {
  return att.kind === 'image' ? '[图片]' : `[文件] ${att.name}`
}

/** 气泡里图片的替代文本（无障碍；永远是纯字符串插值）。 */
export function attachmentAltText(att: Pick<Attachment, 'name'>): string {
  return att.name ? `图片：${att.name}` : '图片附件'
}
