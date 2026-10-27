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
  createLongPress,
  messageMenuItems,
  shouldOpenMessageMenu,
} from '@/components/message/messageMenu'

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
    expect(
      messageMenuItems({ hasText: true, canToggle: false, pinned: false, hasAttachment: false }),
    ).toEqual(['copy', 'toggle-pin'])
  })

  it('含 Markdown 语法的消息多出「看源码」', () => {
    expect(
      messageMenuItems({ hasText: true, canToggle: true, pinned: false, hasAttachment: false }),
    ).toEqual(['copy', 'toggle-source', 'toggle-pin'])
  })

  it('已置顶时置顶项仍然存在（只改文案，不是消失）', () => {
    const items = messageMenuItems({
      hasText: true,
      canToggle: false,
      pinned: true,
      hasAttachment: false,
    })
    expect(items).toContain('toggle-pin')
  })

  it('有附件时多出「下载附件」，且排在最后', () => {
    expect(
      messageMenuItems({ hasText: true, canToggle: true, pinned: false, hasAttachment: true }),
    ).toEqual(['copy', 'toggle-source', 'toggle-pin', 'download-attachment'])
  })

  it('纯附件消息（无正文）：不出现复制，但仍有置顶与下载', () => {
    expect(
      messageMenuItems({ hasText: false, canToggle: false, pinned: false, hasAttachment: true }),
    ).toEqual(['toggle-pin', 'download-attachment'])
  })

  it('系统消息即使调用也应只有置顶之外的空列表（hasText=false 且无附件 → 仅置顶）', () => {
    // 组件层用 shouldOpenMessageMenu 拦住了系统消息；这里钉住「纯逻辑本身不会凭空造项」。
    expect(
      messageMenuItems({ hasText: false, canToggle: false, pinned: false, hasAttachment: false }),
    ).toEqual(['toggle-pin'])
  })
})
