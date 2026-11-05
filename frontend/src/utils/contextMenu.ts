/**
 * 项目自有右键菜单的**纯逻辑层**（无 Vue 依赖，仅少量 DOM 判定）。
 *
 * 【为什么要有一个自己的右键菜单】
 * PC 端在聊天页面右键，弹出来的是浏览器自带菜单（「查看网页源代码」「检查」
 * 「另存为」…），用户完全找不到「复制图片地址」「回到顶部」这类本项目操作。
 * 这个模块提供菜单定位、原生菜单保留判定与临时剪贴板写入三块地基，
 * 由 `components/base/AppContextMenu.vue` 渲染、`App.vue` 与附件组件调用。
 *
 * 【为什么把判定抽成纯函数】
 * 本仓库 vitest 环境是 node（没装 jsdom），组件挂不上；而「菜单该往左翻还是
 * 往上翻」「输入框里要不要放过原生菜单」恰恰是最容易写错的地方。抽成纯函数
 * 后可以只用假对象钉住行为 —— 见 `contextMenu.test.ts`。
 */

import { writeClipboardText } from '@/utils/clipboard'

/** 菜单项。字段极简：只描述「显示什么」，不描述「怎么显示」。 */
export interface ContextMenuItem {
  /** 稳定 id（调用方用于埋点/测试断言，渲染上与 label 无关）。 */
  id: string
  /** 主文案，如「复制图片地址」。 */
  label: string
  /** 右侧灰色提示（快捷键、目标主题名等），可选。 */
  hint?: string
  /** 危险操作（删除/退出/撤回），用危险色渲染。 */
  danger?: boolean
  /** 禁用（灰显、不可聚焦、点击无效）。 */
  disabled?: boolean
  /** 隐藏 —— 不渲染，且不会占位。由 `visibleMenuItems()` 过滤。 */
  hidden?: boolean
  /**
   * 触发时执行的动作；菜单会在调用它之前先关闭自己。
   *
   * 【为什么这一条不在最初的 5 字段约定里】约定只描述「显示什么」，但菜单项
   * 来自不同组件（页面级默认项、附件项），全局只有一份菜单实例，若靠
   * `emit('select', id)` 再让 App.vue 反查，就得再维护一张跨组件的动作注册表
   * 并处理 id 冲突；把动作随项传递是最小实现。缺省时点一下只关菜单。
   */
  run?: () => void | Promise<void>
}

/** 菜单自身的像素尺寸（`getBoundingClientRect()` 的结果）。 */
export interface MenuSize {
  width: number
  height: number
}

/** 视口尺寸（`window.innerWidth/innerHeight`）。 */
export interface ViewportSize {
  width: number
  height: number
}

/** 视口坐标。 */
export interface MenuPoint {
  x: number
  y: number
}

/** 菜单与视口边缘的最小留白。 */
export const MENU_VIEWPORT_MARGIN = 8

/**
 * 单轴定位：优先让菜单的左上角落在鼠标点，越界则翻到另一侧，最后夹进视口。
 *
 * - 右侧放不下 → 菜单右边缘贴鼠标（往左翻），符合「点在文字右边、菜单朝左长」的直觉；
 * - 视口比菜单本身还窄（极端：手机横屏 + 200% 缩放 + 中文长文案）→ 放弃贴边留白，
 *   一律从 `margin` 开始。此时菜单必然会溢出，但至少**第一项可点**，
 *   而不是被夹成负坐标后整块跑到屏幕外（那会变成「右键没反应」）。
 */
function clampAxis(anchor: number, size: number, extent: number, margin: number): number {
  const max = extent - size - margin
  if (max < margin) return margin
  const preferred = anchor + size + margin > extent ? anchor - size : anchor
  return Math.min(Math.max(preferred, margin), max)
}

/**
 * 把「鼠标点 + 菜单尺寸 + 视口」算成最终 `left/top`。
 *
 * @param anchorX 鼠标 clientX
 * @param anchorY 鼠标 clientY
 * @param size    菜单渲染后的实际尺寸（必须先渲染再量，否则算不准）
 * @param viewport 视口尺寸
 * @param margin  与视口边缘的最小留白，默认 8px
 */
export function clampMenuPosition(
  anchorX: number,
  anchorY: number,
  size: MenuSize,
  viewport: ViewportSize,
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuPoint {
  return {
    x: clampAxis(anchorX, size.width, viewport.width, margin),
    y: clampAxis(anchorY, size.height, viewport.height, margin),
  }
}

/** 走原生菜单的表单/富文本标签名。 */
const NATIVE_MENU_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * 只描述判定需要的结构 —— 让测试可以传假对象，不必依赖真实 DOM。
 * 真实元素天然满足该结构（`tagName` / `parentElement` / `getAttribute`）。
 */
interface NativeMenuCandidate {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
  parentElement?: NativeMenuCandidate | null
}

/** 元素自身是否属于「需要原生菜单」的节点。 */
function isNativeMenuNode(node: NativeMenuCandidate): boolean {
  const tag = (node.tagName ?? '').toUpperCase()
  if (NATIVE_MENU_TAGS.has(tag)) return true
  if (node.isContentEditable === true) return true
  // isContentEditable 在假对象/老浏览器里可能缺失，再看属性：
  // contenteditable="" / "true" / "plaintext-only" 都可编辑，只有 "false" 不可。
  const attr = typeof node.getAttribute === 'function' ? node.getAttribute('contenteditable') : null
  if (attr === null || attr === undefined) return false
  return attr.trim().toLowerCase() !== 'false'
}

/**
 * 该不该放过浏览器原生右键菜单。
 *
 * 【为什么输入框必须放过】夺走输入框的右键 = 用户没法「粘贴」，也没法用
 * 浏览器拼写检查改错别字 —— 这是比「菜单不统一」严重得多的功能损失。
 * 富文本编辑器（contenteditable）同理，它的粘贴/拼写完全依赖原生菜单。
 *
 * 判定要**沿祖先链上溯**：右键落在 `<textarea>` 内的某个节点上时 target 可能是
 * 子节点（某些浏览器），只看自身会漏判。
 */
export function shouldKeepNativeMenu(target: EventTarget | null): boolean {
  if (!target) return false
  let node = target as unknown as NativeMenuCandidate | null
  let depth = 0
  // 64 层足够覆盖任何真实 DOM；同时挡住假对象里 parentElement 自引用造成的死循环。
  while (node && depth < 64) {
    if (isNativeMenuNode(node)) return true
    node = node.parentElement ?? null
    depth += 1
  }
  return false
}

/** 过滤掉 `hidden` 的项 —— 菜单只渲染它。返回原数组顺序。 */
export function visibleMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.filter((item) => item.hidden !== true)
}

/** 过滤后是否为空。空菜单不该打开（否则会出现一个空白色块）。 */
export function hasVisibleMenuItems(items: ContextMenuItem[]): boolean {
  return items.some((item) => item.hidden !== true)
}

/**
 * 写文本到剪贴板，成功返回 true。
 *
 * 【为什么这里只是一行转调】实现已经统一收敛到 `@/utils/clipboard` 的
 * `writeClipboardText()`（task-3：消息气泡复制、代码块复制、分享链接、UID 复制
 * 原来各有一份降级实现，一共四份，改一处漏三处）。这里保留这个名字与签名，
 * 是为了让右键菜单/附件组件的调用点不必跟着改名 —— 但**降级逻辑只有一份**，
 * 不要再在这里重新长出 textarea + execCommand。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  return writeClipboardText(text)
}
