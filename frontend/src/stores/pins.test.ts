/**
 * 置顶 store 单测（ux2-contract §九）。
 *
 * 这一层有两个「不看代码就一定会写错」的点，正是本文件的靶心：
 *
 *  1. **代际（epoch）隔离**：`stores/auth.ts` 的 `clearLocal()` 不在本任务的
 *     写入范围，无法保证会调用 `pinsStore.reset()`。若只依赖调用方，换账号时
 *     上一个账号的置顶标题（＝消息正文）会继续显示给下一个人。所以 store 自己
 *     记录「数据加载时的代际」，代际变了就当作没有。
 *
 *  2. **乐观取消置顶的回滚**：置顶条上点 × 必须立刻消失（否则用户连点），
 *     但请求失败时要把记录放回去 —— 唯独 404 `PIN_NOT_FOUND` 不能放回，
 *     那表示「服务端本来就没有」，放回会造出一条永远删不掉的幽灵置顶。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiCtl = vi.hoisted(() => ({
  listPins: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
}))

vi.mock('@/api/pins', () => ({
  listPins: apiCtl.listPins,
  pinMessage: apiCtl.pinMessage,
  unpinMessage: apiCtl.unpinMessage,
}))

import { PIN_LIMIT, usePinsStore } from '@/stores/pins'
import { bumpEpoch } from '@/stores/session'
import type { PinnedMessage } from '@/types/domain'

function pinned(msgId: string, over: Partial<PinnedMessage> = {}): PinnedMessage {
  return {
    id: `pin-${msgId}`,
    message: {
      msgId,
      conversationId: 'c1',
      senderId: 'u-bob',
      clientMsgId: null,
      seq: 1,
      type: 'text',
      content: `内容 ${msgId}`,
      createdAt: '2026-10-22T00:00:00.000Z',
    },
    pinnedBy: { id: 'u-self', username: 'me', displayName: 'Me' },
    pinnedAt: '2026-10-23T00:00:00.000Z',
    ...over,
  }
}

function apiError(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiCtl.listPins.mockReset()
  apiCtl.pinMessage.mockReset()
  apiCtl.unpinMessage.mockReset()
})

describe('ensureLoaded', () => {
  it('首次加载写入列表，二次调用不再打接口', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()

    await store.ensureLoaded('c1')
    expect(store.pinsOf('c1').map((p) => p.message.msgId)).toEqual(['m1'])

    await store.ensureLoaded('c1')
    expect(apiCtl.listPins).toHaveBeenCalledTimes(1)
  })

  it('force=true 时强制重新请求', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.ensureLoaded('c1', true)
    expect(apiCtl.listPins).toHaveBeenCalledTimes(2)
  })

  it('空 conversationId 直接返回，不发请求', async () => {
    const store = usePinsStore()
    await store.ensureLoaded('')
    expect(apiCtl.listPins).not.toHaveBeenCalled()
  })

  it('接口失败（如后端未落地 404）不抛，只记录错误且列表为空', async () => {
    apiCtl.listPins.mockRejectedValue(apiError('NOT_FOUND', '置顶接口不存在'))
    const store = usePinsStore()
    await expect(store.ensureLoaded('c1')).resolves.toBeUndefined()
    expect(store.pinsOf('c1')).toEqual([])
    expect(store.errorOf('c1')).toBe('置顶接口不存在')
  })

  it('并发调用只打一次接口（isLoading 去重）', async () => {
    let release!: (v: PinnedMessage[]) => void
    apiCtl.listPins.mockImplementation(
      () => new Promise<PinnedMessage[]>((res) => (release = res)),
    )
    const store = usePinsStore()
    const a = store.ensureLoaded('c1')
    const b = store.ensureLoaded('c1')
    release([pinned('m1')])
    await Promise.all([a, b])
    expect(apiCtl.listPins).toHaveBeenCalledTimes(1)
  })
})

describe('pin', () => {
  it('新置顶插到最前面（服务端 pinned_at DESC）', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    apiCtl.pinMessage.mockResolvedValue(pinned('m2'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.pin('c1', 'm2')
    expect(store.pinsOf('c1').map((p) => p.message.msgId)).toEqual(['m2', 'm1'])
  })

  it('重复置顶同一条不会出现两条（幂等 200 的场景）', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    apiCtl.pinMessage.mockResolvedValue(pinned('m1'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.pin('c1', 'm1')
    expect(store.pinsOf('c1')).toHaveLength(1)
  })

  it('超过上限时截断到 PIN_LIMIT（服务端会 409，本地也不该无限堆）', async () => {
    const many = Array.from({ length: PIN_LIMIT }, (_, i) => pinned(`m${i}`))
    apiCtl.listPins.mockResolvedValue(many)
    apiCtl.pinMessage.mockResolvedValue(pinned('m-new'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.pin('c1', 'm-new')
    expect(store.pinsOf('c1')).toHaveLength(PIN_LIMIT)
    expect(store.pinsOf('c1')[0]?.message.msgId).toBe('m-new')
  })

  it('失败向上抛（由 UI 决定 toast 文案）', async () => {
    apiCtl.listPins.mockResolvedValue([])
    apiCtl.pinMessage.mockRejectedValue(apiError('PIN_LIMIT', '置顶已满'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await expect(store.pin('c1', 'm1')).rejects.toThrow('置顶已满')
  })
})

describe('unpin（乐观删除 + 失败回滚）', () => {
  it('请求还没回来，本地就已经删掉了（乐观）', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1'), pinned('m2')])
    let release!: () => void
    apiCtl.unpinMessage.mockImplementation(() => new Promise<void>((res) => (release = res)))
    const store = usePinsStore()
    await store.ensureLoaded('c1')

    const p = store.unpin('c1', 'm1')
    // 还没 resolve，列表里已经没有 m1
    expect(store.pinsOf('c1').map((x) => x.message.msgId)).toEqual(['m2'])
    release()
    await p
    expect(store.pinsOf('c1').map((x) => x.message.msgId)).toEqual(['m2'])
  })

  it('服务端 500 时把记录放回去（不能假装成功）', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    apiCtl.unpinMessage.mockRejectedValue(apiError('INTERNAL', '服务器错误'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.unpin('c1', 'm1')
    expect(store.pinsOf('c1').map((x) => x.message.msgId)).toEqual(['m1'])
    expect(store.errorOf('c1')).toBe('服务器错误')
  })

  it('404 PIN_NOT_FOUND 不回滚（服务端本来就没有，回滚会造出幽灵置顶）', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    apiCtl.unpinMessage.mockRejectedValue(apiError('PIN_NOT_FOUND', '置顶不存在'))
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.unpin('c1', 'm1')
    expect(store.pinsOf('c1')).toEqual([])
  })
})

describe('applyFromWs', () => {
  it('WS 推来完整列表时整体替换，不做增量合并', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')

    store.applyFromWs('c1', [pinned('m9')])
    expect(store.pinsOf('c1').map((p) => p.message.msgId)).toEqual(['m9'])
  })

  it('WS 推来空数组 = 全部取消置顶', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    store.applyFromWs('c1', [])
    expect(store.pinsOf('c1')).toEqual([])
  })
})

describe('代际隔离（换账号不能看到上一个账号的置顶）', () => {
  it('bumpEpoch 之后，旧代际的置顶立刻读不出来', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    expect(store.pinsOf('c1')).toHaveLength(1)

    bumpEpoch()
    expect(store.pinsOf('c1')).toEqual([])
    expect(store.isPinned('c1', 'm1')).toBe(false)
  })

  it('登出瞬间还在飞的请求，回来后不得写入新代际', async () => {
    let release!: (v: PinnedMessage[]) => void
    apiCtl.listPins.mockImplementation(
      () => new Promise<PinnedMessage[]>((res) => (release = res)),
    )
    const store = usePinsStore()
    const p = store.ensureLoaded('c1')
    bumpEpoch()
    release([pinned('m1')])
    await p
    expect(store.pinsOf('c1')).toEqual([])
  })
})

describe('dropConv / reset / total', () => {
  it('dropConv 清掉该会话的列表/加载态/错误', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    store.dropConv('c1')
    expect(store.pinsOf('c1')).toEqual([])
    expect(store.isLoading('c1')).toBe(false)
    expect(store.errorOf('c1')).toBeNull()
  })

  it('reset 清空全部会话', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.ensureLoaded('c2')
    expect(store.total).toBe(2)
    store.reset()
    expect(store.total).toBe(0)
  })

  it('不同会话互不干扰', async () => {
    apiCtl.listPins.mockResolvedValue([pinned('m1')])
    const store = usePinsStore()
    await store.ensureLoaded('c1')
    await store.ensureLoaded('c2')
    expect(store.pinsOf('c1').map((p) => p.message.msgId)).toEqual(['m1'])
    expect(store.pinsOf('c2').map((p) => p.message.msgId)).toEqual(['m1'])
    store.dropConv('c1')
    expect(store.pinsOf('c1')).toEqual([])
    expect(store.pinsOf('c2')).toHaveLength(1)
  })
})
