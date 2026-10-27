/**
 * 长按菜单判定的纯函数单测。
 *
 * 覆盖的是「组件里最容易悄悄写错、而单测又最难触达」的三件事：
 *  1. 长按阈值与取消语义（手指在气泡上滑动翻消息时**不能**弹菜单）；
 *  2. 哪些情况下根本不该弹菜单（系统消息、桌面端）；
 *  3. 菜单项的出现条件与顺序。
 *
 * 用假时钟注入，不依赖 jsdom，也不真的等 500ms。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LONG_PRESS_MS,
  RECALL_WINDOW_MS,
  canRecallMessage,
  createLongPress,
  messageMenuItems,
  shouldOpenMessageMenu,
} from '@/components/message/messageMenu'

/** messageMenuItems 的默认入参：纯文本、不可撤回、不可回复。 */
function items(over: Partial<Parameters<typeof messageMenuItems>[0]> = {}) {
  return messageMenuItems({
    hasText: true,
    canReply: false,
    canToggle: false,
    pinned: false,
    hasAttachment: false,
    canRecall: false,
    ...over,
  })
}

/** 手动触发的假定时器：不推进真实时间，直接由测试决定「时间到」。 */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  fire: () => void
  fireCount: () => number
  cancelled: () => number
  lastDelay: () => number
} {
  let fn: (() => void) | null = null
  let delay = 0
  let fired = 0
  let cancelled = 0
  return {
    setTimer: (cb, ms) => {
      fn = cb
      delay = ms
      return { id: fired + cancelled + 1 }
    },
    clearTimer: () => {
      cancelled += 1
      fn = null
    },
    fire: () => {
      const cb = fn
      fn = null
      if (cb) {
        fired += 1
        cb()
      }
    },
    fireCount: () => fired,
    cancelled: () => cancelled,
    lastDelay: () => delay,
  }
}

describe('createLongPress', () => {
  it('按住满阈值才触发一次', () => {
    const t = fakeTimers()
    const onFire = vi.fn()
    const lp = createLongPress(onFire, 500, t.setTimer, t.clearTimer)

    lp.start()
    expect(onFire).not.toHaveBeenCalled()
    expect(lp.isArmed()).toBe(true)

    t.fire()
    expect(onFire).toHaveBeenCalledTimes(1)
    // 触发后自动解除，不会残留计时状态
    expect(lp.isArmed()).toBe(false)
  })

  it('滑动/抬起取消后即使时间到也不触发', () => {
    const t = fakeTimers()
    const onFire = vi.fn()
    const lp = createLongPress(onFire, 500, t.setTimer, t.clearTimer)

    lp.start()
    lp.cancel()
    t.fire()
    expect(onFire).not.toHaveBeenCalled()
    expect(lp.isArmed()).toBe(false)
  })

  it('重复 start 会重置计时，不会叠加多个定时器', () => {
    const t = fakeTimers()
    const onFire = vi.fn()
    const lp = createLongPress(onFire, 500, t.setTimer, t.clearTimer)

    lp.start()
    lp.start()
    lp.start()
    // 三次 start 只应留下一个有效定时器（前两个被 clear）
    expect(t.cancelled()).toBeGreaterThanOrEqual(2)
    t.fire()
    expect(onFire).toHaveBeenCalledTimes(1)
    // 再去 fire 残留回调也不该再触发
    t.fire()
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('cancel 幂等：没有计时时调用也不抛', () => {
    const t = fakeTimers()
    const lp = createLongPress(() => {}, 500, t.setTimer, t.clearTimer)
    expect(() => {
      lp.cancel()
      lp.cancel()
    }).not.toThrow()
  })

  it('把阈值传给定时器（默认 LONG_PRESS_MS = 500）', () => {
    const t = fakeTimers()
    const lp = createLongPress(() => {}, LONG_PRESS_MS, t.setTimer, t.clearTimer)
    lp.start()
    expect(t.lastDelay()).toBe(500)
    expect(LONG_PRESS_MS).toBe(500)
  })
})

describe('shouldOpenMessageMenu', () => {
  it('移动端的普通消息弹菜单', () => {
    expect(shouldOpenMessageMenu(false, true)).toBe(true)
  })

  it('桌面端不弹菜单（悬浮工具条已是入口，且不能夺走右键）', () => {
    expect(shouldOpenMessageMenu(false, false)).toBe(false)
  })

  it('系统消息即使在移动端也不弹（没有正文可复制、也不能置顶）', () => {
    expect(shouldOpenMessageMenu(true, true)).toBe(false)
    expect(shouldOpenMessageMenu(true, false)).toBe(false)
  })
})

describe('messageMenuItems', () => {
  it('纯文本消息：复制 + 置顶', () => {
    expect(items()).toEqual(['copy', 'toggle-pin'])
  })

  it('含 Markdown 语法的消息多出「看源码」', () => {
    expect(items({ canToggle: true })).toEqual(['copy', 'toggle-source', 'toggle-pin'])
  })

  it('已置顶时置顶项仍然存在（只改文案，不是消失）', () => {
    expect(items({ pinned: true })).toContain('toggle-pin')
  })

  it('有附件时多出「下载附件」，排在撤回之前', () => {
    expect(items({ canToggle: true, hasAttachment: true })).toEqual([
      'copy',
      'toggle-source',
      'toggle-pin',
      'download-attachment',
    ])
  })

  it('纯附件消息（无正文）：不出现复制，但仍有置顶与下载', () => {
    expect(items({ hasText: false, hasAttachment: true })).toEqual([
      'toggle-pin',
      'download-attachment',
    ])
  })

  it('系统消息即使调用也应只有置顶之外的空列表（hasText=false 且无附件 → 仅置顶）', () => {
    // 组件层用 shouldOpenMessageMenu 拦住了系统消息；这里钉住「纯逻辑本身不会凭空造项」。
    expect(items({ hasText: false })).toEqual(['toggle-pin'])
  })

  it('可回复时 reply 紧跟在 copy 之后', () => {
    expect(items({ canReply: true })).toEqual(['copy', 'reply', 'toggle-pin'])
  })

  it('无正文时 reply 仍在 copy 位置（回复不依赖正文）', () => {
    expect(items({ hasText: false, canReply: true })).toEqual(['reply', 'toggle-pin'])
  })

  it('可撤回时 recall 永远排最后（危险动作不能被夹在中间）', () => {
    expect(items({ canToggle: true, hasAttachment: true, canReply: true, canRecall: true })).toEqual(
      ['copy', 'reply', 'toggle-source', 'toggle-pin', 'download-attachment', 'recall'],
    )
  })

  it('不可撤回时不出现 recall', () => {
    expect(items({ canRecall: false })).not.toContain('recall')
  })
})

describe('canRecallMessage', () => {
  const base = {
    isMine: true,
    recalled: false,
    status: 'sent',
    createdAt: '2026-01-01T00:00:00.000Z',
    now: Date.parse('2026-01-01T00:01:00.000Z'),
  }

  it('作者本人 + 未撤回 + 60 秒内 → 可撤回', () => {
    expect(canRecallMessage(base)).toBe(true)
  })

  it('恰好 120 秒仍可撤回（边界包含）', () => {
    expect(
      canRecallMessage({ ...base, now: Date.parse(base.createdAt) + RECALL_WINDOW_MS }),
    ).toBe(true)
  })

  it('超过 120 秒不可撤回', () => {
    expect(
      canRecallMessage({ ...base, now: Date.parse(base.createdAt) + RECALL_WINDOW_MS + 1 }),
    ).toBe(false)
  })

  it('别人的消息不可撤回', () => {
    expect(canRecallMessage({ ...base, isMine: false })).toBe(false)
  })

  it('已撤回的不可重复撤回', () => {
    expect(canRecallMessage({ ...base, recalled: true })).toBe(false)
  })

  it('尚未发送成功的乐观消息不可撤回（服务端还没有它）', () => {
    expect(canRecallMessage({ ...base, status: 'sending' })).toBe(false)
    expect(canRecallMessage({ ...base, status: 'failed' })).toBe(false)
  })

  it('createdAt 解析不出来时保守判 false', () => {
    expect(canRecallMessage({ ...base, createdAt: 'not-a-date' })).toBe(false)
  })

  it('本地时钟落后于服务端（elapsed 为负）仍判可撤回', () => {
    expect(canRecallMessage({ ...base, now: Date.parse(base.createdAt) - 5000 })).toBe(true)
  })
})
