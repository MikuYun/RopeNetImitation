/**
 * 个人表情包 store。
 *
 * 【为什么单独一个 store】表情包是**跨会话**的：它不属于任何 conversation，
 * 面板在哪个聊天里打开都应该是同一份列表。塞进 message / conversation store
 * 都会让它跟着会话切换被清掉。
 *
 * 【代际（epoch）保护】登出/换账号时 `stores/auth.ts` 的 `clearLocal()` 会重置
 * 各 store，但它**不在本任务的写入范围**，不能保证会调用本 store 的 `reset()`。
 * 表情包是一份「用户私有收藏」，串到下一个账号是明显的隐私问题，所以这里
 * 记录「数据加载时的代际」，代际一变就整体作废（照 `stores/pins.ts` 的做法）。
 *
 * 【列表只加载一次】面板每次打开都挂载，不能每次都打接口。`ensureLoaded()`
 * 默认为幂等；只有添加/删除之后本地列表已是最新，也不需要强制刷新。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/stickers'
import { STICKER_PAGE_SIZE, type Sticker } from '@/api/stickers'
import { fetchAttachmentBlob, uploadFile } from '@/api/uploads'
import {
  STICKER_COMPRESS_MIN_BYTES,
  STICKER_COMPRESS_SAVING_RATIO,
  STICKER_TARGET_MIME,
  compressImageForSticker,
  isStickerStaticMime,
  isStickerTooLarge,
  stickerFileName,
  stickerLimitText,
} from '@/utils/imageCompress'
import type { Attachment } from '@/types/domain'
import { currentEpoch, epochValid } from './session'

export const useStickerStore = defineStore('sticker', () => {
  const items = ref<Sticker[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 写入当前 items 时的代际；null 表示「还没加载过」。 */
  const loadedEpoch = ref<number | null>(null)
  /** 当前数据所属账号（仅用于 resetFor 判断，不对外暴露成响应式状态）。 */
  let ownerId: string | null = null
  /**
   * 加载序号：只让「最后一次发起的加载」负责关掉 loading。
   * 不能直接用代际判断 —— 跨代际作废的请求如果不再关 loading，
   * 这个 store 就会永远卡在 loading=true，之后再也加载不出来。
   */
  let loadToken = 0

  /**
   * 「原附件 id → 我复制出来的 upload id」映射（仅本次会话有效）。
   *
   * 收藏**别人的**图片时要复制字节成自己的上传（后端要求表情必须是本人的 upload），
   * 复制出来的 upload id 和原 attachment.id 不是同一个，光按 uploadId 查重会漏掉：
   * 同一条消息连点两次「存为表情」就会多存一份图。这里按附件 id 记住复制结果。
   */
  const copiedUploads = new Map<string, string>()

  /** 代际不符 = 上一个账号的收藏，一律读不到。 */
  function isFresh(): boolean {
    return loadedEpoch.value !== null && epochValid(loadedEpoch.value)
  }

  /** 代际不符时把残留数据丢掉（懒清理，避免在 computed 里写状态）。 */
  function dropIfStale(): void {
    if (loadedEpoch.value !== null && !epochValid(loadedEpoch.value)) {
      items.value = []
      loadedEpoch.value = null
      error.value = null
    }
  }

  const loaded = computed(() => isFresh())

  const list = computed<Sticker[]>(() => {
    if (loadedEpoch.value !== null && !epochValid(loadedEpoch.value)) return []
    return items.value
  })

  const count = computed(() => list.value.length)

  function hasUpload(uploadId: string): boolean {
    return list.value.some((s) => s.uploadId === uploadId)
  }

  function findById(stickerId: string): Sticker | null {
    return list.value.find((s) => s.id === stickerId) ?? null
  }

  /**
   * 首次加载（默认幂等）。
   *
   * 失败只记录到 `error`，**不抛**：面板打开时后端可能还没上线（404），
   * 这时应该显示空态而不是让整个聊天页冒一个未捕获的 promise 错误。
   */
  async function ensureLoaded(force = false): Promise<void> {
    dropIfStale()
    if (!force && isFresh()) return
    if (loading.value) return

    const gen = currentEpoch()
    const token = ++loadToken
    loading.value = true
    try {
      const page = await api.listStickers({ limit: STICKER_PAGE_SIZE })
      if (!epochValid(gen) || token !== loadToken) return
      items.value = page.items
      loadedEpoch.value = gen
      error.value = null
    } catch (e) {
      if (!epochValid(gen)) return
      error.value = (e as { message?: string }).message ?? '表情包加载失败'
      items.value = []
      // 也记成「已加载过」：否则每次打开面板都会重新打一次注定失败的接口
      loadedEpoch.value = gen
    } finally {
      // 只有最后一次发起的加载负责关 loading：跨代际作废的请求也必须关，
      // 否则 loading 永远为 true，这个 store 之后再也加载不出来。
      if (token === loadToken) loading.value = false
    }
  }

  /** 强制重新拉取（面板下拉刷新/重试用）。 */
  async function refresh(): Promise<void> {
    await ensureLoaded(true)
  }

  /**
   * 把一张已上传的图片存为表情。
   *
   * 幂等：同一个 uploadId 重复提交后端返回 200 + 原记录，本地再按 uploadId
   * 去重一次并**前插**到头部（最近添加的最先看到）。失败向上抛，由调用方 toast。
   */
  async function add(uploadId: string): Promise<Sticker> {
    dropIfStale()
    const gen = currentEpoch()
    const sticker = await api.addSticker(uploadId)
    if (!epochValid(gen)) return sticker

    const rest = items.value.filter((s) => s.id !== sticker.id && s.uploadId !== sticker.uploadId)
    items.value = [sticker, ...rest]
    loadedEpoch.value = gen
    error.value = null
    return sticker
  }

  /**
   * 收藏一张图片消息为表情，**收藏时先压缩**。
   *
   * 为什么压缩：表情包是长期占用服务器磁盘的收藏品（被 stickers 引用的 upload
   * 永远不会被保留策略清掉 —— sweep 把 stickers 算作在用引用），原图动辄 2~5 MB，
   * 而表情显示上限只有 512px。这里把原图缩到 512px 转 WebP 后重新上传，再把
   * 「压缩图」收藏成表情，通常只剩原来的 5%~20%。
   *
   * 三种路径（依次尝试，前面的失败就退到后面，绝不让收藏本身失败）：
   * 1. **压缩重传**：静图且 >64 KiB → 取 blob → 压到 512px WebP → 上传 → 收藏新图。
   *    只有压完确实小 20% 以上才采用（否则多存一份反而更浪费）。
   * 2. **直接收藏原上传**：图是我的、体积小、或 GIF（转码会丢动画）→ 引用原 upload，
   *    零额外存储。
   * 3. **复制字节再收藏**：原上传不属于我（收藏别人消息里的图，后端要求表情必须
   *    是自己的上传）→ 取字节复制一份成自己的上传（GIF 也走这条，保住动画）。
   *
   * 兜底：任何一步抛错都退到下一档；只有「原图超过上限且既压不下去也复制不了」才抛错，
   * 由调用方 toast 告诉用户裁剪。
   */
  async function saveFromAttachment(attachment: Attachment): Promise<Sticker> {
    // 代际校验交给内部 `add()`：三条路径最终都要走它，这里不必重复判定。
    dropIfStale()

    // ⓪ 这条消息的图之前已经复制成我的上传了：直接收藏那一份，不要再压/再传一次。
    // 否则连点两次「存为表情」会各生成一个 upload，磁盘多花一倍（见 copiedUploads 注释）。
    const cached = copiedUploads.get(attachment.id)
    if (cached) {
      try {
        return await add(cached)
      } catch (e) {
        // 那份复制出来的上传可能已经不在了（删表情时服务器会把无人引用的上传连文件一起清），
        // 忘掉缓存重新走一遍完整流程即可。
        if ((e as { code?: string }).code !== 'INVALID_STICKER') throw e
        copiedUploads.delete(attachment.id)
      }
    }

    // ⓪' 这张原图已经是我的表情了（旧版本收藏的、或通过接口收藏的）→ 直接返回那一条。
    // 不这么做的话会走第 ① 档压出第二个 upload，同一个源图变成两条表情，白占一份磁盘。
    // 列表还没拉过就先拉一次；拉失败只是拿不到去重信息，不影响继续收藏。
    if (!loaded.value) await ensureLoaded()
    const saved = items.value.find((item) => item.uploadId === attachment.id)
    if (saved) return saved

    // ① 压缩重传。
    if (isStickerStaticMime(attachment.mimeType) && attachment.size > STICKER_COMPRESS_MIN_BYTES) {
      const compressedId = await compressThenUpload(attachment)
      if (compressedId) return add(compressedId)
    }

    // ② 直接收藏原上传。
    try {
      return await add(attachment.id)
    } catch (e) {
      // 只有「这个 upload 不能当表情」（典型：不是我的上传）才继续走第 ③ 档；
      // 网络/鉴权错误直接上抛，重试也没意义。
      if ((e as { code?: string }).code !== 'INVALID_STICKER') throw e
    }

    // ③ 复制字节成自己的上传后再收藏。
    if (isStickerTooLarge(attachment.size)) {
      throw new Error(`图片超过 ${stickerLimitText()}，请先裁剪后再收藏`)
    }
    const source = await fetchAttachmentBlob(attachment)
    const mimeType = source.type || attachment.mimeType
    const copy = new File([source], stickerFileName(attachment.name, mimeType), { type: mimeType })
    const uploaded = await uploadFile(copy)
    copiedUploads.set(attachment.id, uploaded.id)
    return add(uploaded.id)
  }

  /**
   * 压缩后上传，返回新 uploadId；不适配/失败返回 null（由调用方退到下一档）。
   *
   * 单独抽出来是因为它要吞掉所有异常：压缩是**优化**，不是收藏的前置条件，
   * 浏览器不支持 canvas、取流失败、上传失败都不该让用户存不了表情。
   */
  async function compressThenUpload(attachment: Attachment): Promise<string | null> {
    try {
      const source = await fetchAttachmentBlob(attachment)
      const compressed = await compressImageForSticker(source)
      // 没变小 20% 以上就别多存一份 —— 压缩的意义是省磁盘，不是走流程。
      if (!compressed || isStickerTooLarge(compressed.size)) return null
      if (compressed.size >= attachment.size * STICKER_COMPRESS_SAVING_RATIO) return null
      // 不支持 WebP 编码的浏览器会让 toBlob 回退成 PNG，扩展名必须跟真实 type 走。
      const mimeType = compressed.type || STICKER_TARGET_MIME
      const file = new File([compressed], stickerFileName(attachment.name, mimeType), { type: mimeType })
      const uploaded = await uploadFile(file)
      copiedUploads.set(attachment.id, uploaded.id)
      return uploaded.id
    } catch {
      return null
    }
  }

  /**
   * 删除一个表情。
   *
   * 采用「先请求成功再改本地」：表情格子上有二次确认弹窗，用户已经点过一次，
   * 不需要乐观反馈来掩盖延迟；而失败时本地不动，比回滚更好解释。
   */
  async function remove(stickerId: string): Promise<void> {
    dropIfStale()
    const gen = currentEpoch()
    await api.deleteSticker(stickerId)
    if (!epochValid(gen)) return
    items.value = items.value.filter((s) => s.id !== stickerId)
  }

  /** 改账号/登出时清空（auth.ts 不在写域，这里同时靠 epoch 兜底）。 */
  function resetFor(userId: string | null): void {
    if (userId === ownerId && userId !== null) return
    ownerId = userId
    reset()
  }

  function reset(): void {
    items.value = []
    loading.value = false
    error.value = null
    loadedEpoch.value = null
    copiedUploads.clear()
  }

  return {
    items,
    list,
    count,
    loaded,
    loading,
    error,
    hasUpload,
    findById,
    ensureLoaded,
    refresh,
    add,
    saveFromAttachment,
    remove,
    resetFor,
    reset,
  }
})
