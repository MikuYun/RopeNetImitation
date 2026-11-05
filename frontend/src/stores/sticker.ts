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
    remove,
    resetFor,
    reset,
  }
})
