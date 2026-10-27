/**
 * 对话框（桌面居中弹层 / 手机底部面板）的焦点管理原语。
 *
 * 【为什么抽成独立模块，而不是直接写在组件里】
 *   1. 本轮修的真实缺陷是「两条实现的行为漂移」：`AppModal` 早就有 Tab 循环与
 *      Esc 处理，`MobileNav` 的 `.sheet` 一行都没有 —— 于是手机上按 Esc 关不掉、
 *      Tab 直接逃到 `<body>`。把判定收敛成一份纯函数后，两个组件共用同一套规则，
 *      不会再各自长出一个版本。
 *   2. 测试环境是 node（本仓库没装 jsdom/happy-dom，package.json 也不允许本轮
 *      改动），组件没法在单测里 mount。把「该不该关、Tab 跳哪、初始焦点给谁」
 *      抽成不碰 DOM 的纯函数，就能被单测直接钉住；DOM 部分只剩 querySelector 一层。
 *
 * 【与 e2e 的一致性契约】`FOCUSABLE_SELECTOR` 必须与
 * `frontend/e2e-matrix.mjs` 里 `focusables()` / `focusNth()` 使用的选择器逐字相同，
 * 否则「e2e 认为的可聚焦列表」和「组件认为的列表」不是同一个集合，Tab 循环断言会
 * 变成假绿或假红。`dialogA11y.test.ts` 里有一条断言专门钉住这串字面量。
 */

/** 可聚焦元素选择器 —— 与 e2e-matrix.mjs 逐字一致，改这里必须同步改那边。 */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * 「可聚焦」判定所需的最小结构。
 *
 * 不用 `HTMLElement` 是为了让纯函数能被假对象驱动；真实调用点传进来的就是 HTMLElement。
 */
export interface FocusableLike {
  /** 表单控件的 disabled 属性；非表单元素为 undefined。 */
  disabled?: boolean
  /** 元素可见时非 null（真实 DOM 里是定位祖先或 body），隐藏时为 null。 */
  offsetParent?: unknown
}

/**
 * 元素是否真的能被 Tab 命中。
 *
 * `[tabindex="-1"]` 已经在选择器里排除了；这里再排掉 disabled 与视觉隐藏
 * （display:none、隐藏祖先下的元素），否则 Tab 循环会把焦点送到看不见的元素上，
 * 用户表现为「焦点消失了」。
 */
export function isFocusableLike(el: FocusableLike): boolean {
  if (el.disabled === true) return false
  return el.offsetParent !== null && el.offsetParent !== undefined
}

/** 收集容器内当前可聚焦的元素，保持 DOM 顺序。 */
export function collectFocusables(root: HTMLElement | null | undefined): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusableLike)
}

/** 一次按键应当触发的动作；`null` = 不干预，交给浏览器默认行为。 */
export type DialogKeyAction = { type: 'close' } | { type: 'focus'; target: 'first' | 'last' } | null

export interface DialogKeyInput {
  key: string
  shiftKey: boolean
  /** 对话框当前是否真的打开（窗口监听是常驻的，必须自己判，否则会误关）。 */
  dialogOpen: boolean
  /** 容器内可聚焦元素数量。 */
  focusableCount: number
  /** 当前焦点在上述列表里的下标；-1 = 焦点在容器本身或容器外。 */
  focusIndex: number
  /** 输入法组合中的按键不算快捷键 —— 否则中文输入时按 Esc 会直接把弹层关掉。 */
  isComposing?: boolean
}

/**
 * 判定键盘事件该做什么。两个组件都只调用它，不再各写一份分支。
 *
 * Tab 的语义按「焦点当前落在列表的第几个」来定：
 *   - 正向 Tab 只有落在**最后一个**元素上才需要拦（否则会跳出容器）→ 回首个；
 *   - 反向 Shift+Tab 只有落在**首个**元素上才需要拦 → 去末尾；
 *   - `focusIndex === -1`（焦点在容器本身或容器外）时：正向 Tab **不拦** ——
 *     容器带 `tabindex="-1"`，浏览器的顺序导航会自然走到容器内第一个可聚焦元素；
 *     反向则要兜底跳到末尾，否则会退到弹层外。
 */
export function dialogKeyAction(input: DialogKeyInput): DialogKeyAction {
  if (!input.dialogOpen) return null
  if (input.isComposing === true) return null
  if (input.key === 'Escape') return { type: 'close' }
  if (input.key !== 'Tab') return null
  const count = input.focusableCount
  if (count <= 0) return null
  if (input.shiftKey) return input.focusIndex <= 0 ? { type: 'focus', target: 'last' } : null
  return input.focusIndex >= count - 1 ? { type: 'focus', target: 'first' } : null
}

/**
 * 打开瞬间的初始焦点下标。
 *
 * 优先给第一个可聚焦元素（与 e2e 的「弹层内可聚焦元素 >= 3」用的是同一列表）；
 * 一个都没有时返回 -1，调用方应把焦点给容器本身（容器必须带 `tabindex="-1"`，
 * 否则 `focus()` 不生效，焦点会留在触发按钮上 —— 这正是本轮修的缺陷 1）。
 */
export function initialFocusIndex(focusableCount: number): number {
  return focusableCount > 0 ? 0 : -1
}
