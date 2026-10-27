/**
 * 对话框焦点管理原语的单测（覆盖本轮修的 3 条产品缺陷）。
 *
 * 【为什么测纯函数而不是 mount 组件】本仓库没装 jsdom / happy-dom，`package.json`
 * 本轮又不允许改（Lead 独占 lockfile），所以组件无法在 vitest 里渲染。判定逻辑
 * 全部收敛到 `@/utils/dialogA11y` 的纯函数后，三条缺陷的**行为契约**可以在 node
 * 环境里被真实钉住：
 *   - 缺陷 1「打开瞬间不聚焦」→ `initialFocusIndex()` 必须给出落点，
 *     且 `AppModal` 里「列表为空则聚焦容器」的分支必须有 `tabindex="-1"` 才能生效；
 *   - 缺陷 2「手机面板 Esc 关不掉」→ `dialogKeyAction({key:'Escape'})` 必须 close，
 *     且**只在面板打开时**成立（窗口监听是常驻的）；
 *   - 缺陷 3「Tab 逃逸到 BODY」→ 末尾 Tab 回首个、首个 Shift+Tab 去末尾。
 *
 * 最后两条是「契约锁」：选择器与 e2e 逐字一致；两个组件都真的接上了这套判定。
 * 没有它们，函数测得再绿也可能根本没被组件调用（假绿）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FOCUSABLE_SELECTOR,
  collectFocusables,
  dialogKeyAction,
  initialFocusIndex,
  isFocusableLike,
} from '@/utils/dialogA11y'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../..')

/** 构造一次按键输入的默认值，测试只覆写关心的字段。 */
function key(over: Partial<Parameters<typeof dialogKeyAction>[0]> = {}) {
  return dialogKeyAction({
    key: 'Tab',
    shiftKey: false,
    dialogOpen: true,
    focusableCount: 3,
    focusIndex: 0,
    ...over,
  })
}

describe('dialogA11y —— 缺陷 2：Esc 关闭', () => {
  it('面板打开时按 Esc 应请求关闭', () => {
    expect(key({ key: 'Escape' })).toEqual({ type: 'close' })
  })

  it('面板未打开时按 Esc 不得误关（窗口监听是常驻的）', () => {
    expect(key({ key: 'Escape', dialogOpen: false })).toBeNull()
  })

  it('输入法组合中的 Esc 不算关闭快捷键（中文输入会误触）', () => {
    expect(key({ key: 'Escape', isComposing: true })).toBeNull()
  })
})

describe('dialogA11y —— 缺陷 3：Tab 不逃出面板', () => {
  it('焦点在最后一个元素上按 Tab → 回首个', () => {
    expect(key({ focusableCount: 3, focusIndex: 2 })).toEqual({ type: 'focus', target: 'first' })
  })

  it('焦点在中间元素上按 Tab → 交给浏览器默认行为（不干预顺序导航）', () => {
    expect(key({ focusableCount: 3, focusIndex: 0 })).toBeNull()
  })

  it('焦点在首个元素上按 Shift+Tab → 去末尾', () => {
    expect(key({ shiftKey: true, focusableCount: 3, focusIndex: 0 })).toEqual({
      type: 'focus',
      target: 'last',
    })
  })

  it('焦点在中间元素上按 Shift+Tab → 不干预', () => {
    expect(key({ shiftKey: true, focusableCount: 3, focusIndex: 1 })).toBeNull()
  })

  it('只有一个可聚焦元素时，Tab 与 Shift+Tab 都停在它上面（不得跳到 body）', () => {
    expect(key({ focusableCount: 1, focusIndex: 0 })).toEqual({ type: 'focus', target: 'first' })
    expect(key({ shiftKey: true, focusableCount: 1, focusIndex: 0 })).toEqual({
      type: 'focus',
      target: 'last',
    })
  })

  it('焦点在容器本身（index=-1）时：正向 Tab 交给浏览器进入首个元素', () => {
    // 容器带 tabindex="-1"，浏览器的顺序导航会走到容器内第一个可聚焦元素；
    // 这里若强行 preventDefault 反而会把焦点卡在容器上。
    expect(key({ focusIndex: -1 })).toBeNull()
  })

  it('焦点在容器本身（index=-1）时：Shift+Tab 必须兜底到末尾，否则退出到弹层外', () => {
    expect(key({ shiftKey: true, focusIndex: -1 })).toEqual({ type: 'focus', target: 'last' })
  })

  it('面板里一个可聚焦元素都没有时不干预', () => {
    expect(key({ focusableCount: 0, focusIndex: -1 })).toBeNull()
  })

  it('非 Tab / 非 Esc 的按键不干预', () => {
    expect(key({ key: 'Enter' })).toBeNull()
    expect(key({ key: 'a' })).toBeNull()
  })
})

describe('dialogA11y —— 缺陷 1：打开瞬间的初始焦点', () => {
  it('有可聚焦元素时落到第一个', () => {
    expect(initialFocusIndex(7)).toBe(0)
  })

  it('没有可聚焦元素时返回 -1，调用方必须退到容器（依赖 tabindex="-1"）', () => {
    expect(initialFocusIndex(0)).toBe(-1)
  })
})

describe('dialogA11y —— 可聚焦性过滤', () => {
  it('disabled / 视觉隐藏（offsetParent 为 null）不算可聚焦', () => {
    expect(isFocusableLike({ disabled: false, offsetParent: {} })).toBe(true)
    expect(isFocusableLike({ disabled: true, offsetParent: {} })).toBe(false)
    expect(isFocusableLike({ offsetParent: null })).toBe(false)
    // 非元素（jest 风格假对象）不应被当作可聚焦，避免把 undefined 当 visible。
    expect(isFocusableLike({})).toBe(false)
  })

  it('collectFocusables 过滤掉隐藏项并保持 DOM 顺序', () => {
    const visible = { offsetParent: {} }
    const hidden = { offsetParent: null }
    const root = {
      querySelectorAll: () => [visible, hidden, visible, hidden],
    } as unknown as HTMLElement
    expect(collectFocusables(root)).toHaveLength(2)
    expect(collectFocusables(null)).toEqual([])
  })
})

describe('dialogA11y —— 与 e2e 的契约锁', () => {
  // 【为什么可能没有这个文件】PM 门禁 `management/verify.mjs` 会把 frontend 快照到
  // `management/evidence/<id>/snapshot/frontend`，其白名单只含 src/mocks/public/scripts
  // 与少数配置，**不含 e2e-*.mjs**（e2e 脚本不是发布产物的一部分）。因此在门禁快照里
  // 本用例必然拿不到文件。此时**显式 skip 并打印原因**，而不是 throw —— 让门禁诚实跳过，
  // 本地开发态仍做逐字契约校验。不得为了让它绿而放宽门禁白名单（那是拿门禁自利）。
  const MATRIX = resolve(SRC, 'e2e-matrix.mjs')
  const matrixExists = existsSync(MATRIX)

  it('选择器与 e2e-matrix.mjs 里 focusables()/focusNth() 的字面量逐字一致', (ctx) => {
    if (!matrixExists) {
      ctx.skip(
        `跳过：${MATRIX} 不存在（PM 门禁快照不含 e2e-*.mjs，属预期；非缺陷）`,
      )
    }
    const src = readFileSync(MATRIX, 'utf8')
    // e2e 脚本里该选择器出现两次（focusables、focusNth），必须两处都一致，
    // 否则「e2e 认为的可聚焦集合」与「组件认为的集合」不同，Tab 断言假绿/假红。
    const occurrences = src.split(FOCUSABLE_SELECTOR).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('两个对话框组件都真的接上了 dialogKeyAction（防止函数写完没人用）', () => {
    for (const rel of [
      'src/components/base/AppModal.vue',
      'src/components/layout/MobileNav.vue',
    ]) {
      const src = readFileSync(resolve(SRC, rel), 'utf8')
      expect(src).toContain("from '@/utils/dialogA11y'")
      expect(src).toContain('dialogKeyAction(')
      expect(src).toContain('addEventListener(\'keydown\'')
    }
  })

  it('两个对话框容器都带 tabindex="-1"（否则无焦点元素时无法把焦点移入弹层）', () => {
    for (const rel of [
      'src/components/base/AppModal.vue',
      'src/components/layout/MobileNav.vue',
    ]) {
      const src = readFileSync(resolve(SRC, rel), 'utf8')
      expect(src).toContain('tabindex="-1"')
    }
  })
})
