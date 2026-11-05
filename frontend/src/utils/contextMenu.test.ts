/**
 * 右键菜单纯逻辑层单测。
 *
 * 【为什么只测这些】本仓库 vitest 跑在 node（没装 jsdom / happy-dom），组件挂不上，
 * 所以真正被钉住的是**会写错的部分**：
 *   - `clampMenuPosition` 四个方向越界后的落点（写错的表现是「菜单跑到屏幕外」，
 *     用户看到的是「右键没反应」——最难从截图判断的一类 bug）；
 *   - `shouldKeepNativeMenu` 对输入框/富文本/普通节点的判定（写错的表现是
 *     「输入框里不能粘贴」，功能直接坏掉）；
 *   - `visibleMenuItems` 的过滤（写错的表现是菜单里出现一条永远点不动的空白项）。
 */
import { describe, expect, it } from 'vitest'
import {
  MENU_VIEWPORT_MARGIN,
  clampMenuPosition,
  hasVisibleMenuItems,
  shouldKeepNativeMenu,
  visibleMenuItems,
  type ContextMenuItem,
} from '@/utils/contextMenu'

const MENU = { width: 200, height: 180 }
const VIEWPORT = { width: 1000, height: 800 }

/** 只覆盖关心的字段，其余用默认值，让每条断言读起来就是它测的那件事。 */
function clamp(anchorX: number, anchorY: number, margin?: number) {
  return clampMenuPosition(anchorX, anchorY, MENU, VIEWPORT, margin)
}

describe('clampMenuPosition —— 常规情况', () => {
  it('四周都放得下时，菜单左上角就是鼠标点', () => {
    expect(clamp(100, 120)).toEqual({ x: 100, y: 120 })
  })

  it('默认留白是 8px，且能被入参覆盖', () => {
    expect(MENU_VIEWPORT_MARGIN).toBe(8)
    // margin=0 时贴边算「放得下」，不翻边
    expect(clamp(MENU.width, MENU.height, 0)).toEqual({ x: 200, y: 180 })
  })
})

describe('clampMenuPosition —— 右侧越界（往左翻）', () => {
  it('右侧放不下时把菜单整体翻到鼠标左侧', () => {
    // 900 + 200 > 1000 → x = 900 - 200 = 700
    const { x } = clamp(900, 100)
    expect(x).toBe(700)
  })

  it('翻到左侧后仍不得越过左边界', () => {
    // 锚点比留白还靠近左边缘（鼠标点在 2px 处）：夹到 margin，不得返回 2
    const left = clampMenuPosition(2, 50, MENU, VIEWPORT)
    expect(left.x).toBe(MENU_VIEWPORT_MARGIN)
  })

  it('恰好放得下（锚点 + 宽 + 留白 == 视口宽）不翻边', () => {
    // 792 + 200 + 8 === 1000，菜单右边缘离视口还有正好 8px，没必要翻
    expect(clamp(792, 100).x).toBe(792)
  })

  it('只差 1px 放不下时立刻翻边', () => {
    // 793 + 200 + 8 > 1000 → 翻到鼠标左侧
    expect(clamp(793, 100).x).toBe(593)
  })
})

describe('clampMenuPosition —— 下方越界（往上翻）', () => {
  it('下方放不下时把菜单整体翻到鼠标上方', () => {
    // 700 + 180 > 800 → y = 700 - 180 = 520
    expect(clamp(100, 700).y).toBe(520)
  })

  it('翻到上方后仍不得越过上边界', () => {
    // 锚点低于留白（鼠标点在 2px 处）：夹到 margin
    const narrow = clampMenuPosition(50, 2, MENU, VIEWPORT)
    expect(narrow.y).toBe(MENU_VIEWPORT_MARGIN)
  })
})

describe('clampMenuPosition —— 右下角同时越界', () => {
  it('两轴各自独立翻边', () => {
    expect(clamp(970, 760)).toEqual({ x: 770, y: 580 })
  })
})

describe('clampMenuPosition —— 视口比菜单还小', () => {
  it('放不下时不甘心返回负数，而是从 margin 起排（至少首项可见可点）', () => {
    const point = clampMenuPosition(30, 30, MENU, { width: 120, height: 100 })
    expect(point).toEqual({ x: MENU_VIEWPORT_MARGIN, y: MENU_VIEWPORT_MARGIN })
  })

  it('尺寸为 0（还没渲染/被隐藏）时退回锚点本身，不产生 NaN', () => {
    const point = clampMenuPosition(10, 20, { width: 0, height: 0 }, VIEWPORT)
    expect(point.x).toBe(10)
    expect(point.y).toBe(20)
    expect(Number.isNaN(point.x)).toBe(false)
  })
})

/* ── 原生菜单保留判定 ─────────────────────────────────────────── */

interface FakeNode {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
  parentElement?: FakeNode | null
}

function node(over: FakeNode = {}): FakeNode {
  return { tagName: 'DIV', parentElement: null, ...over }
}

describe('shouldKeepNativeMenu —— 输入类元素放过原生菜单', () => {
  it('input', () => {
    expect(shouldKeepNativeMenu(node({ tagName: 'INPUT' }) as unknown as EventTarget)).toBe(true)
  })

  it('textarea（大小写不敏感）', () => {
    expect(shouldKeepNativeMenu(node({ tagName: 'textarea' }) as unknown as EventTarget)).toBe(true)
  })

  it('select', () => {
    expect(shouldKeepNativeMenu(node({ tagName: 'SELECT' }) as unknown as EventTarget)).toBe(true)
  })

  it('contenteditable="true" 的富文本节点', () => {
    const el = node({ getAttribute: (name) => (name === 'contenteditable' ? 'true' : null) })
    expect(shouldKeepNativeMenu(el as unknown as EventTarget)).toBe(true)
  })

  it('contenteditable="" 与 "plaintext-only" 也算可编辑', () => {
    const empty = node({ getAttribute: (name) => (name === 'contenteditable' ? '' : null) })
    const plain = node({ getAttribute: (name) => (name === 'contenteditable' ? 'plaintext-only' : null) })
    expect(shouldKeepNativeMenu(empty as unknown as EventTarget)).toBe(true)
    expect(shouldKeepNativeMenu(plain as unknown as EventTarget)).toBe(true)
  })

  it('isContentEditable 运行时标记为 true 时同样放过（属性可能被框架改过）', () => {
    expect(shouldKeepNativeMenu(node({ isContentEditable: true }) as unknown as EventTarget)).toBe(true)
  })

  it('右键落在输入框的子节点上，要沿祖先链上溯命中', () => {
    const span = node({ tagName: 'SPAN' })
    const wrap = node({ tagName: 'DIV' })
    const input = node({ tagName: 'INPUT', parentElement: wrap })
    wrap.parentElement = input
    span.parentElement = wrap
    expect(shouldKeepNativeMenu(span as unknown as EventTarget)).toBe(true)
  })
})

describe('shouldKeepNativeMenu —— 普通节点接管为项目菜单', () => {
  it('普通 div 返回 false', () => {
    expect(shouldKeepNativeMenu(node() as unknown as EventTarget)).toBe(false)
  })

  it('contenteditable="false" 不算可编辑', () => {
    const el = node({ getAttribute: (name) => (name === 'contenteditable' ? 'false' : null) })
    expect(shouldKeepNativeMenu(el as unknown as EventTarget)).toBe(false)
  })

  it('target 为 null（事件无目标）返回 false，由调用方自己兜底', () => {
    expect(shouldKeepNativeMenu(null)).toBe(false)
  })

  it('祖先链自引用不会死循环（防假对象/异常 DOM 打爆调用栈）', () => {
    const el = node({ tagName: 'div' })
    el.parentElement = el
    expect(shouldKeepNativeMenu(el as unknown as EventTarget)).toBe(false)
  })
})

/* ── 菜单项过滤 ──────────────────────────────────────────────── */

function item(id: string, over: Partial<ContextMenuItem> = {}): ContextMenuItem {
  return { id, label: id, ...over }
}

describe('visibleMenuItems', () => {
  it('过滤 hidden:true，保留其余顺序', () => {
    const items = [item('a'), item('b', { hidden: true }), item('c')]
    expect(visibleMenuItems(items).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('hidden:false 与缺省都保留', () => {
    const items = [item('a', { hidden: false }), item('b')]
    expect(visibleMenuItems(items)).toHaveLength(2)
  })

  it('不修改入参（纯函数）', () => {
    const items = [item('a'), item('b', { hidden: true })]
    visibleMenuItems(items)
    expect(items).toHaveLength(2)
  })

  it('空数组返回空数组', () => {
    expect(visibleMenuItems([])).toEqual([])
  })
})

describe('hasVisibleMenuItems', () => {
  it('全部 hidden 时判定为「不该打开」', () => {
    expect(hasVisibleMenuItems([item('a', { hidden: true })])).toBe(false)
    expect(hasVisibleMenuItems([])).toBe(false)
  })

  it('只要有一项可见就开', () => {
    expect(hasVisibleMenuItems([item('a', { hidden: true }), item('b')])).toBe(true)
  })
})
