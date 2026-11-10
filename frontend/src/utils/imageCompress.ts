/**
 * 表情包收藏前的图片压缩。
 *
 * 背景：表情包会**长期**占用服务器磁盘 —— 普通上传的图会随保留策略被清掉，但被
 * 收藏的表情因为 `stickers` 引用而永远保留（sweep 把 stickers 算作在用引用）。
 * 用户随手收藏一张 5 MB 的原图，就等于永久占 5 MB；几十个人各存几张就能把磁盘吃掉。
 * 收藏时先在前端把图缩到表情实际显示需要的尺寸（≤512px 边长）并转 WebP，
 * 通常能压掉 80%~95% 的体积。
 *
 * 为什么不放服务端：backend 依赖里没有任何图像处理库（sharp / jimp 都没有），
 * 为此新增一个原生依赖不值得；浏览器自带 canvas 就能做，还省一次原始字节上行。
 *
 * 纪律：
 * - GIF 一律不转码 —— canvas 只能取第一帧，转码会把动图变成静图，属于功能退化。
 *   动图按原始字节复制一份私有副本（仍受 2 MiB 上限约束）。
 * - 任何一步失败（不支持 createImageBitmap / toBlob 返回 null / 解码失败）都返回
 *   null，由调用方回退到「复制原图字节」，绝不阻断收藏本身。
 * - 纯函数（尺寸计算 / 格式判定 / 文件名）与 DOM 操作分离，便于在 node 环境下单测
 *   —— 本仓库 vitest 没有 jsdom。
 */

/** 表情显示区的最大边长（与 StickerPanel 的 4~5 列网格、气泡 260px 上限匹配）。 */
export const STICKER_MAX_EDGE = 512
/** WebP 质量 0.82：表情尺寸下肉眼几乎无差，体积明显小于 0.9。 */
export const STICKER_QUALITY = 0.82
/** 压缩目标格式。 */
export const STICKER_TARGET_MIME = 'image/webp'
/**
 * 收藏单张表情的体积上限，与后端 `MAX_STICKER_BYTES`（backend/src/upload.ts）一致。
 * 动图无法转码，因此超限的动图会被拒收。
 */
export const STICKER_MAX_BYTES = 2 * 1024 * 1024
/** 可以压缩转码的静图格式（GIF 走原始 upload，不转码）。 */
export const STICKER_STATIC_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp']
/**
 * 小于这个体积的静图不压缩 —— 压缩后要重新上传一份，省下来的绝对体积还不够
 * 抵消多一条 uploads 记录的开销；直接引用原始 upload 反而更省。
 */
export const STICKER_COMPRESS_MIN_BYTES = 64 * 1024
/** 压缩后没明显变小（省不到 20%）时就别多存一份，直接引用原图。 */
export const STICKER_COMPRESS_SAVING_RATIO = 0.8

export interface ImageSize {
  width: number
  height: number
}

/**
 * 计算等比缩放后的目标尺寸。
 * 宽高非法（NaN / 非有限 / ≤0）时返回 null；已经不超过上限时返回原尺寸（不放大）。
 */
export function stickerTargetSize(width: number, height: number, maxEdge = STICKER_MAX_EDGE): ImageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return null
  const w = Math.floor(width)
  const h = Math.floor(height)
  if (w <= 0 || h <= 0) return null
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  // 至少保留 1px，避免极端长边算出 0。
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** 这种 MIME 能不能用 canvas 转码（GIF 不能：会丢动画）。 */
export function isStickerStaticMime(mimeType: string): boolean {
  return STICKER_STATIC_MIME_TYPES.includes((mimeType || '').toLowerCase())
}

/** 体积是否超过入库上限。 */
export function isStickerTooLarge(size: number, limit = STICKER_MAX_BYTES): boolean {
  return !Number.isFinite(size) || size > limit
}

/**
 * 重传用的文件名：沿用原文件名（去掉扩展名）+ 真实编码格式的扩展名。
 * 表情面板的 aria-label 会用这个文件名，沿用原名比 `sticker-1729.webp` 可读得多；
 * 扩展名必须跟真实字节一致（不支持 WebP 编码的浏览器会回退成 PNG）。
 */
export function stickerFileName(originalName: string, mimeType: string): string {
  const ext = (mimeType || '').toLowerCase() === 'image/webp' ? 'webp' : 'png'
  const base = (originalName || '').replace(/[\\/]/g, '').replace(/\.[^.]+$/, '').trim()
  const safe = base === '' ? 'sticker' : base.slice(0, 80)
  return `${safe}.${ext}`
}

/** 上限的展示文案，与后端提示保持一致。 */
export function stickerLimitText(limit = STICKER_MAX_BYTES): string {
  return `${Math.round((limit / (1024 * 1024)) * 10) / 10} MB`
}

/**
 * 把一张图压到表情尺寸并转成 WebP。
 * 返回 null 表示「本次无法压缩」，调用方应回退成复制原始字节。
 */
export async function compressImageForSticker(blob: Blob, maxEdge = STICKER_MAX_EDGE): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const target = stickerTargetSize(bitmap.width, bitmap.height, maxEdge)
    if (!target) return null
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), STICKER_TARGET_MIME, STICKER_QUALITY)
    })
    if (!encoded || encoded.size <= 0) return null
    return encoded
  } catch {
    return null
  } finally {
    bitmap?.close?.()
  }
}
