/**
 * 附件相关的**纯逻辑**（无 DOM、无网络、无 Vue 依赖）—— 方便在 node 环境单测。
 *
 * 职责：
 *   1. 上传前的前端硬校验（体积按类型分档 / 空文件 / mime 粗筛先拦，别只靠后端）；
 *   2. 人类可读体积；
 *   3. mime/扩展名 → 文件卡片图标分类；
 *   4. 附件在会话列表里的短预览文案（`[图片]` / `[视频]` / `[文件] xxx.pdf`）；
 *   5. 附件 → 消息 type 的映射（服务端也会推，前端用于乐观占位）。
 *
 * 安全说明：这里**不生成任何 HTML**，只返回字符串与枚举值。
 */
import type { Attachment, AttachmentKind, MessageType } from '@/types/domain'

/** 图片/普通文件上限：50 MiB（与服务端一致）。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * 视频上限：100 MiB。
 *
 * 【为什么视频要单独一档】视频天然比图片大一个数量级，把 50 MiB 套在视频上
 * 会让一部分长视频发不出去；而统一放宽到 100 MiB 又会让人把 90 MiB 的 zip 传上去。
 * 分档是产品与后端的共同约定（docs/v2/API-V2.md §1），前端必须按 kind 分派。
 */
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024

/** 单条消息最多附件数（后端：video ≤1、image ≤9、合计 ≤9 —— 合计这条最强）。 */
export const MAX_ATTACHMENTS = 9
/** 单条消息最多视频数。 */
export const MAX_VIDEO_ATTACHMENTS = 1

/**
 * 视频 mime 提示表。
 *
 * 【v2.3 起不再是准入名单】服务端会按魔数嗅探真实容器（mp4/mov 同族都识别成 video/mp4，
 * mkv/webm 同族识别成 video/webm），前端按 mime 前缀 `video/` 归类即可。
 * 保留这个常量是为了给「哪些容器浏览器能直接播」留一个显式清单，
 * 供 AttachmentView 决定渲染 `<video>` 还是降级成下载卡片。
 */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const

/** 可执行文件的扩展名黑名单（与服务端 `blockedExecutableLabel` 呼应，见下方说明）。 */
const RE_EXECUTABLE_EXT =
  /\.(exe|msi|msix|dll|sys|com|scr|pif|cpl|jar|apk|ipa|elf|dmg|pkg|deb|rpm|appimage)$/i

const RE_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
const RE_TEXT_EXT =
  /\.(txt|md|markdown|log|csv|tsv|json|jsonc|xml|ya?ml|toml|ini|conf|css|scss|less|html?|jsx?|tsx?|vue|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|sql)$/i

export type UploadRejectCode =
  | 'EMPTY_FILE'
  | 'UPLOAD_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_MANY_ATTACHMENTS'

export interface UploadCheckRejected {
  ok: false
  code: UploadRejectCode
  message: string
}

export type UploadCheck = { ok: true } | UploadCheckRejected

/** 判定一个文件的附件种类；mime 优先，扩展名兜底，最后才落到 file。 */
export function attachmentKindOf(mimeType: string | undefined | null, name = ''): AttachmentKind {
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  if (!mime && /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(name)) return 'video'
  if (!mime && RE_IMAGE_EXT.test(name)) return 'image'
  // 兜底一律 file：普通文件没有更细的分支，且这是最保守的展示形态
  return 'file'
}

/**
 * 上传前校验。
 *
 * 【v2.3 起不再有类型白名单】以前这里按 pdf/zip/文本三档放行，其余一律拒绝，
 * 用户拿到的是「仅支持图片、视频（MP4/WebM）、PDF、ZIP 与纯文本」——
 * 等于一个聊天软件只能发这几种东西。现在前端只拦三件它能确定的事：
 *   1. 空文件；
 *   2. 可执行文件（服务端也会按魔数再拦一次，这里靠扩展名先给即时反馈）；
 *   3. 体积超限。
 * 真实类型由服务端按魔数嗅探，客户端 mime 不可信，所以这里不做
 * 「这是不是真的 png」这种伪校验。
 *
 * 【mimeType 可选】既有调用方（以及单测）只传 `{name,size}`，缺 mime 时按
 * 普通文件走 50 MiB 档，这样老调用点不会因为多了视频分档而误伤。
 */
export function checkUploadFile(file: {
  name: string
  size: number
  type?: string
  mimeType?: string
}): UploadCheck {
  if (!file.name || file.size <= 0) {
    return { ok: false, code: 'EMPTY_FILE', message: '不能发送空文件' }
  }
  const mime = (file.type ?? file.mimeType ?? '').toLowerCase()
  const kind = attachmentKindOf(mime, file.name)
  if (RE_EXECUTABLE_EXT.test(file.name)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_TYPE',
      message: '不支持发送可执行文件，请压缩成 zip 后发送',
    }
  }
  const limit = kind === 'video' ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES
  if (file.size > limit) {
    return {
      ok: false,
      code: 'UPLOAD_TOO_LARGE',
      message:
        kind === 'video'
          ? `视频超过 ${formatBytes(limit)}（当前 ${formatBytes(file.size)}）`
          : `文件超过 ${formatBytes(limit)}（当前 ${formatBytes(file.size)}）`,
    }
  }
  return { ok: true }
}

/**
 * 校验「一组待发附件」的组合规则。
 *
 * 与后端规则逐条对应：合计 ≤9、视频 ≤1、无重复 id。放在这里而不是组件里，
 * 是因为「选文件」「拖拽」「粘贴」三条入口都要走同一套判定。
 */
export function checkAttachmentSelection(
  attachments: Array<Pick<Attachment, 'id' | 'kind'>>,
): UploadCheck {
  const message = `最多 ${MAX_ATTACHMENTS} 个附件，视频最多 ${MAX_VIDEO_ATTACHMENTS} 个`
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, code: 'TOO_MANY_ATTACHMENTS', message }
  }
  if (attachments.filter((a) => a.kind === 'video').length > MAX_VIDEO_ATTACHMENTS) {
    return { ok: false, code: 'TOO_MANY_ATTACHMENTS', message }
  }
  if (new Set(attachments.map((a) => a.id)).size !== attachments.length) {
    return { ok: false, code: 'TOO_MANY_ATTACHMENTS', message: '同一附件不能重复添加' }
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

/**
 * 附件在 UI 上归到哪一类图标。
 *
 * v2.3 起服务端几乎接受任何文件，所以这里按「用户能认出来的大类」分档：
 * pdf / zip（压缩包）/ text / image / video / audio / doc / sheet / slide / other。
 */
export type AttachmentIconKind =
  | 'pdf'
  | 'zip'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'other'

const RE_ARCHIVE_EXT = /\.(zip|rar|7z|gz|tgz|tar|bz2|xz|zst|cab|iso)$/i
const RE_DOC_EXT = /\.(docx?|rtf|odt|pages|wps)$/i
const RE_SHEET_EXT = /\.(xlsx?|csv|ods|numbers|et)$/i
const RE_SLIDE_EXT = /\.(pptx?|odp|key|dps)$/i
const RE_AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|m4a|aac|amr|wma|mid|midi|opus|ape)$/i

export function attachmentIconKind(att: Pick<Attachment, 'mimeType' | 'name'>): AttachmentIconKind {
  const mime = (att.mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || /\.pdf$/i.test(att.name)) return 'pdf'
  if (mime === 'font/woff' || mime === 'font/woff2' || mime === 'font/otf' || mime === 'font/ttf') return 'other'
  // Office 家族：OOXML（zip 容器）在服务端会被嗅探成 application/zip，
  // 所以这里必须先看扩展名，否则 docx 会显示成压缩包图标。
  if (RE_DOC_EXT.test(att.name)) return 'doc'
  if (RE_SHEET_EXT.test(att.name)) return 'sheet'
  if (RE_SLIDE_EXT.test(att.name)) return 'slide'
  if (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-rar-compressed' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/gzip' ||
    mime === 'application/x-bzip2' ||
    mime === 'application/x-xz' ||
    mime === 'application/zstd' ||
    mime === 'application/x-tar' ||
    mime === 'application/vnd.ms-cab-compressed' ||
    RE_ARCHIVE_EXT.test(att.name)
  ) {
    return 'zip'
  }
  if (mime === 'application/x-ole-storage' || mime === 'application/rtf') return 'doc'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text'
  // mime 认不出（application/octet-stream）时退回扩展名判断
  if (RE_IMAGE_EXT.test(att.name)) return 'image'
  if (RE_AUDIO_EXT.test(att.name)) return 'audio'
  if (RE_TEXT_EXT.test(att.name)) return 'text'
  return 'other'
}

/** 单个附件 → 消息 type。 */
export function messageTypeOfAttachment(att: Pick<Attachment, 'kind'>): MessageType {
  if (att.kind === 'image') return 'image'
  if (att.kind === 'video') return 'video'
  return 'file'
}

/**
 * 一组附件 → 消息 type。
 *
 * **必须与服务端规则逐字一致**（docs/v2/API-V2.md §2）：无附件 → text，
 * 单一 kind → 对应类型，混合 → mixed。乐观消息用这个推导，否则本地气泡
 * 在服务端回包前后会换一次渲染形态（先按 file 渲染再跳成 mixed）。
 */
export function messageTypeOfAttachments(
  attachments: Array<Pick<Attachment, 'kind'>>,
): MessageType {
  if (attachments.length === 0) return 'text'
  if (new Set(attachments.map((a) => a.kind)).size > 1) return 'mixed'
  const only = attachments[0]
  if (!only) return 'text'
  return messageTypeOfAttachment(only)
}

export function isImageAttachment(att: Pick<Attachment, 'kind' | 'mimeType'>): boolean {
  return att.kind === 'image' || (att.mimeType || '').toLowerCase().startsWith('image/')
}

export function isVideoAttachment(att: Pick<Attachment, 'kind' | 'mimeType'>): boolean {
  return att.kind === 'video' || (att.mimeType || '').toLowerCase().startsWith('video/')
}

/** 单个附件的短预览文案。 */
export function attachmentPreviewText(att: Pick<Attachment, 'kind' | 'name'>): string {
  if (att.kind === 'image') return '[图片]'
  if (att.kind === 'video') return '[视频]'
  return `[文件] ${att.name}`
}

/**
 * 一组附件的短预览文案。
 *
 * 单附件走 `attachmentPreviewText`（保持 `[文件] xxx.pdf` 这种带名字的形态）；
 * 多附件同 kind 合并成 `[图片 ×3]`，混合一律 `[附件]` —— 会话列表是**单行**，
 * 塞不下文件名列表。
 */
export function attachmentsPreviewText(
  attachments: Array<Pick<Attachment, 'kind' | 'name'>>,
): string {
  if (attachments.length === 0) return ''
  const first = attachments[0]
  if (!first) return ''
  if (attachments.length === 1) return attachmentPreviewText(first)
  const kinds = new Set(attachments.map((a) => a.kind))
  if (kinds.size === 1) {
    const only = first.kind
    const label = only === 'image' ? '图片' : only === 'video' ? '视频' : '文件'
    return `[${label} ×${attachments.length}]`
  }
  return '[附件]'
}

/** 气泡里图片的替代文本（无障碍；永远是纯字符串插值）。 */
export function attachmentAltText(att: Pick<Attachment, 'name'>): string {
  return att.name ? `图片：${att.name}` : '图片附件'
}

/** 视频的替代文本。 */
export function videoAltText(att: Pick<Attachment, 'name'>): string {
  return att.name ? `视频：${att.name}` : '视频附件'
}

/**
 * 视频卡上的时长文案（`m:ss`）。
 *
 * 拿不到 metadata 时返回空串（不是 `0:00`）—— 「未知」和「零秒」在 UI 上
 * 语义完全不同，显示 0:00 会让用户以为视频坏了。
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return ''
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
