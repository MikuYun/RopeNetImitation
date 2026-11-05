/**
 * 表情包 store 单测。
 *
 * 这一层有三个「不看代码就一定会写错」的点，是本文件的靶心：
 *
 *  1. **只加载一次**：面板每次打开都会挂载，`ensureLoaded()` 必须是幂等的，
 *     否则每开一次面板就打一次接口。**加载失败也要记住「已经试过了」**，
 *     否则后端未上线（404）时每次打开都会再打一次注定失败的请求。
 *
 *  2. **幂等添加 + 前插**：同一个 uploadId 重复保存，后端返回 200 + 原记录。
 *     本地必须按 uploadId 去重（不是按表情记录 id），并把结果放到列表**头部**
 *     ——「最近保存的最先看到」，否则用户刚存完的表情要翻到底才找得到。
 *
 *  3. **代际（epoch）隔离**：`stores/auth.ts` 的 `clearLocal()` 不在本任务写入
 *     范围，不能保证会调用 `resetFor()`。表情包是用户私有收藏，串号可见属于
 *     隐私问题，所以 store 自己记录「数据加载时的代际」，代际一变就当作没有。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiCtl = vi.hoisted(() => ({
  listStickers: vi.fn(),
  addSticker: vi.fn(),
  deleteSticker: vi.fn(),
}))

vi.mock('@/api/stickers', () => ({
  STICKER_PAGE_SIZE: 60,
  STICKER_MIME_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  listStickers: apiCtl.listStickers,
  addSticker: apiCtl.addSticker,
  deleteSticker: apiCtl.deleteSticker,
}))

import { STICKER_PAGE_SIZE, type Sticker } from '@/api/stickers'
import { useStickerStore } from '@/stores/sticker'
import { bumpEpoch } from '@/stores/session'

function sticker(id: string, over: Partial<Sticker> = {}): Sticker {
  return {
    id,
    uploadId: `up-${id}`,
    name: `${id}.png`,
    mimeType: 'image/png',
    size: 1024,
    kind: 'image',
    url: `/api/v1/uploads/up-${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

function apiError(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiCtl.listStickers.mockReset()
  apiCtl.addSticker.mockReset()
  apiCtl.deleteSticker.mockReset()
})

describe('ensureLoaded', () => {
  it('首次加载写入列表，二次调用不再打接口', async () => {
    apiCtl.listStickers.mockResolvedValue({
      items: [sticker('s1'), sticker('s2')],
      nextOffset: null,
    })

    const store = useStickerStore()
    await store.ensureLoaded()

    expect(apiCtl.listStickers).toHaveBeenCalledTimes(1)
    expect(apiCtl.listStickers).toHaveBeenCalledWith({ limit: STICKER_PAGE_SIZE })
    expect(store.list.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(store.loaded).toBe(true)
    expect(store.count).toBe(2)

    await store.ensureLoaded()
    expect(apiCtl.listStickers).toHaveBeenCalledTimes(1)
  })

  it('并发调用只打一次接口', async () => {
    let resolve: (v: { items: Sticker[]; nextOffset: number | null }) => void = () => {}
    apiCtl.listStickers.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )

    const store = useStickerStore()
    const first = store.ensureLoaded()
    const second = store.ensureLoaded()
    resolve({ items: [sticker('s1')], nextOffset: null })
    await Promise.all([first, second])

    expect(apiCtl.listStickers).toHaveBeenCalledTimes(1)
    expect(store.count).toBe(1)
  })

  it('加载失败记录 error 且不抛，之后默认不再重试', async () => {
    apiCtl.listStickers.mockRejectedValue(apiError('NOT_FOUND', '表情包不可用'))

    const store = useStickerStore()
    await expect(store.ensureLoaded()).resolves.toBeUndefined()

    expect(store.error).toBe('表情包不可用')
    expect(store.list).toEqual([])
    expect(store.loading).toBe(false)

    // 后端未上线时不能每开一次面板打一次注定失败的请求
    await store.ensureLoaded()
    expect(apiCtl.listStickers).toHaveBeenCalledTimes(1)

    // 显式 refresh 才重试
    await store.refresh()
    expect(apiCtl.listStickers).toHaveBeenCalledTimes(2)
  })

  it('success 后 error 被清空', async () => {
    apiCtl.listStickers.mockRejectedValueOnce(apiError('NOT_FOUND')).mockResolvedValueOnce({
      items: [sticker('s1')],
      nextOffset: null,
    })

    const store = useStickerStore()
    await store.ensureLoaded()
    expect(store.error).not.toBeNull()

    await store.refresh()
    expect(store.error).toBeNull()
    expect(store.count).toBe(1)
  })
})

describe('add', () => {
  it('保存后前插到列表头部', async () => {
    apiCtl.listStickers.mockResolvedValue({
      items: [sticker('s1'), sticker('s2')],
      nextOffset: null,
    })
    apiCtl.addSticker.mockResolvedValue(sticker('s3'))

    const store = useStickerStore()
    await store.ensureLoaded()
    const saved = await store.add('up-s3')

    expect(apiCtl.addSticker).toHaveBeenCalledWith('up-s3')
    expect(saved.id).toBe('s3')
    expect(store.list.map((s) => s.id)).toEqual(['s3', 's1', 's2'])
  })

  it('按 uploadId 去重（后端幂等返回原记录时不出现两条）', async () => {
    apiCtl.listStickers.mockResolvedValue({
      items: [sticker('s1'), sticker('s2')],
      nextOffset: null,
    })
    // 同一张图再存一次：后端返回的可能是新的表情 id，但 uploadId 相同
    apiCtl.addSticker.mockResolvedValue(sticker('s9', { uploadId: 'up-s2' }))

    const store = useStickerStore()
    await store.ensureLoaded()
    await store.add('up-s2')

    expect(store.list.map((s) => s.id)).toEqual(['s9', 's1'])
    expect(store.hasUpload('up-s2')).toBe(true)
  })

  it('失败向上抛（交给调用方 toast），列表不变', async () => {
    apiCtl.listStickers.mockResolvedValue({ items: [sticker('s1')], nextOffset: null })
    apiCtl.addSticker.mockRejectedValue(apiError('UNSUPPORTED_STICKER_TYPE', '不支持的表情格式'))

    const store = useStickerStore()
    await store.ensureLoaded()

    await expect(store.add('up-x')).rejects.toThrow('不支持的表情格式')
    expect(store.list.map((s) => s.id)).toEqual(['s1'])
  })
})

describe('remove', () => {
  it('成功后从列表移除', async () => {
    apiCtl.listStickers.mockResolvedValue({
      items: [sticker('s1'), sticker('s2')],
      nextOffset: null,
    })
    apiCtl.deleteSticker.mockResolvedValue(undefined)

    const store = useStickerStore()
    await store.ensureLoaded()
    await store.remove('s1')

    expect(apiCtl.deleteSticker).toHaveBeenCalledWith('s1')
    expect(store.list.map((s) => s.id)).toEqual(['s2'])
  })

  it('失败时抛出且列表不变（不做乐观删除）', async () => {
    apiCtl.listStickers.mockResolvedValue({ items: [sticker('s1')], nextOffset: null })
    apiCtl.deleteSticker.mockRejectedValue(apiError('STICKER_NOT_FOUND', '表情不存在'))

    const store = useStickerStore()
    await store.ensureLoaded()

    await expect(store.remove('s1')).rejects.toThrow('表情不存在')
    expect(store.list.map((s) => s.id)).toEqual(['s1'])
  })
})

describe('resetFor / 代际保护', () => {
  it('resetFor 切换账号后清空列表', async () => {
    apiCtl.listStickers.mockResolvedValue({ items: [sticker('s1')], nextOffset: null })

    const store = useStickerStore()
    store.resetFor('u-alice')
    await store.ensureLoaded()
    expect(store.count).toBe(1)

    store.resetFor('u-bob')
    expect(store.list).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.count).toBe(0)
  })

  it('代际推进后旧数据立刻读不到（auth 没调 resetFor 也不会串号）', async () => {
    apiCtl.listStickers.mockResolvedValue({ items: [sticker('s1'), sticker('s2')], nextOffset: null })

    const store = useStickerStore()
    await store.ensureLoaded()
    expect(store.count).toBe(2)

    bumpEpoch()

    expect(store.list).toEqual([])
    expect(store.loaded).toBe(false)
    // 代际变了之后 ensureLoaded 会重新拉，而不是继续用旧数据
    await store.ensureLoaded()
    expect(apiCtl.listStickers).toHaveBeenCalledTimes(2)
  })

  it('在途请求跨代际返回时丢弃结果', async () => {
    let resolve: (v: { items: Sticker[]; nextOffset: number | null }) => void = () => {}
    apiCtl.listStickers.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )

    const store = useStickerStore()
    const pending = store.ensureLoaded()
    bumpEpoch()
    resolve({ items: [sticker('s1')], nextOffset: null })
    await pending

    expect(store.list).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('reset 清空全部状态', async () => {
    apiCtl.listStickers.mockResolvedValue({ items: [sticker('s1')], nextOffset: null })

    const store = useStickerStore()
    await store.ensureLoaded()
    store.reset()

    expect(store.items).toEqual([])
    expect(store.error).toBeNull()
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
  })
})
