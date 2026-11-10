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

const uploadCtl = vi.hoisted(() => ({
  fetchAttachmentBlob: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('@/api/stickers', () => ({
  STICKER_PAGE_SIZE: 60,
  STICKER_MIME_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  listStickers: apiCtl.listStickers,
  addSticker: apiCtl.addSticker,
  deleteSticker: apiCtl.deleteSticker,
}))

// saveFromAttachment 会取 blob / 重新上传，这里只关心「它选择了哪条路径」，
// 真实压缩由 utils/imageCompress.test.ts 的纯函数用例覆盖（node 环境没有 canvas）。
vi.mock('@/api/uploads', () => ({
  fetchAttachmentBlob: uploadCtl.fetchAttachmentBlob,
  uploadFile: uploadCtl.uploadFile,
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
  uploadCtl.fetchAttachmentBlob.mockReset()
  uploadCtl.uploadFile.mockReset()
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

describe('saveFromAttachment（收藏时压缩的编排）', () => {
  function attachment(over: Partial<{ id: string; name: string; mimeType: string; size: number }> = {}) {
    return {
      id: 'up-a',
      name: '图.png',
      mimeType: 'image/png',
      size: 1024,
      kind: 'image' as const,
      url: '/api/v1/uploads/up-a',
      createdAt: '2026-11-01T00:00:00.000Z',
      ...over,
    }
  }

  it('小图直接收藏原上传（不复制、不多占磁盘）', async () => {
    apiCtl.addSticker.mockResolvedValue(sticker('s1', { uploadId: 'up-a' }))

    const store = useStickerStore()
    await store.saveFromAttachment(attachment())

    expect(apiCtl.addSticker).toHaveBeenCalledWith('up-a')
    // 小图不值得压缩，也不该走「复制字节」那条路
    expect(uploadCtl.fetchAttachmentBlob).not.toHaveBeenCalled()
    expect(uploadCtl.uploadFile).not.toHaveBeenCalled()
  })

  it('收藏别人的图（后端 400 INVALID_STICKER）时复制一份自己的上传再收藏', async () => {
    apiCtl.addSticker
      .mockRejectedValueOnce(apiError('INVALID_STICKER', '表情包只支持 PNG/JPEG/WebP/GIF 图片'))
      .mockResolvedValueOnce(sticker('s2', { uploadId: 'up-copy' }))
    uploadCtl.fetchAttachmentBlob.mockResolvedValue(new Blob(['x'], { type: 'image/gif' }))
    uploadCtl.uploadFile.mockResolvedValue({ id: 'up-copy' })

    const store = useStickerStore()
    const saved = await store.saveFromAttachment(attachment({ id: 'up-friend', name: '动图.gif', mimeType: 'image/gif' }))

    expect(uploadCtl.uploadFile).toHaveBeenCalledTimes(1)
    // GIF 不转码：上传的类型必须还是 image/gif，否则动图会变成静帧
    expect((uploadCtl.uploadFile.mock.calls[0]?.[0] as File).type).toBe('image/gif')
    expect(apiCtl.addSticker).toHaveBeenLastCalledWith('up-copy')
    expect(saved.id).toBe('s2')
  })

  it('同一条消息连点两次「存为表情」只复制一次（不重复占磁盘）', async () => {
    // 第一次：原 upload 不是自己的 → 复制；第二次：认出「这张图已经复制过」→ 直接收藏那份。
    apiCtl.addSticker
      .mockRejectedValueOnce(apiError('INVALID_STICKER', '表情包只支持 PNG/JPEG/WebP/GIF 图片'))
      .mockResolvedValueOnce(sticker('s2', { uploadId: 'up-copy' }))
      .mockResolvedValueOnce(sticker('s2', { uploadId: 'up-copy' }))
    uploadCtl.fetchAttachmentBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    uploadCtl.uploadFile.mockResolvedValue({ id: 'up-copy' })

    const store = useStickerStore()
    const att = attachment({ id: 'up-friend', name: '图.png' })
    await store.saveFromAttachment(att)
    await store.saveFromAttachment(att)

    expect(uploadCtl.uploadFile).toHaveBeenCalledTimes(1)
    expect(apiCtl.addSticker).toHaveBeenLastCalledWith('up-copy')
  })

  it('非 INVALID_STICKER 的错误直接上抛（网络/鉴权错误不重复复制上传）', async () => {
    apiCtl.addSticker.mockRejectedValue(apiError('NETWORK', '网络断了'))

    const store = useStickerStore()
    await expect(store.saveFromAttachment(attachment())).rejects.toThrow('网络断了')
    expect(uploadCtl.uploadFile).not.toHaveBeenCalled()
  })

  it('原图超限且属主不是自己时提示裁剪（不静默失败）', async () => {
    apiCtl.addSticker.mockRejectedValue(apiError('INVALID_STICKER', '不行'))

    const store = useStickerStore()
    await expect(store.saveFromAttachment(attachment({ size: 3 * 1024 * 1024 }))).rejects.toThrow(
      /图片超过 2 MB，请先裁剪后再收藏/,
    )
    expect(uploadCtl.uploadFile).not.toHaveBeenCalled()
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
