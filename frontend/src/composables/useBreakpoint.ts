/**
 * 断点判定 —— JS 侧的唯一事实源。
 *
 * 【为什么必须有这个文件】CSS 媒体查询读不到 CSS 变量，所以数值在样式里必然
 * 重复一遍。把数值和语义集中在这里，至少保证 JS 只有一处定义；样式里的媒体
 * 查询则以本文件的常量为准手写，并在文件头注明。
 *
 * 【边界纪律】767 / 768、1023 / 1024 两处必须严格互补：
 *   mobile  = width <= 767
 *   tablet  = 768 <= width <= 1023
 *   desktop = width >= 1024
 * 不要写成 `max-width: 768px` —— 那和 JS 的 `<= 767` 差一个像素，
 * 在恰好 768px 宽时 CSS 认为还在手机态、JS 认为已进平板态，两边打架。
 *
 * 【为什么用 matchMedia 而不是 resize 事件】matchMedia 只在**跨越边界**时
 * 触发，不像 resize 那样每次拖动都回调几十次；拖动窗口时不会反复重算布局。
 */
import { computed, onUnmounted, readonly, ref, type ComputedRef, type Ref } from 'vue'

/** 断点数值（px）。样式里的媒体查询必须与此一致。 */
export const BP = {
  mobileMax: 767,
  tabletMin: 768,
  tabletMax: 1023,
  desktopMin: 1024,
} as const

export type ScreenSize = 'mobile' | 'tablet' | 'desktop'

/** 触控热区最小边长（CSS px）。见任务书 R3/R4。 */
export const MIN_TOUCH_TARGET = 44

/** 主输入框最小字号 —— 小于 16px 时 iOS Safari 聚焦会自动放大页面。 */
export const MOBILE_INPUT_FONT_SIZE = 16

const QUERIES: Array<{ size: ScreenSize; query: string }> = [
  { size: 'mobile', query: `(max-width: ${BP.mobileMax}px)` },
  { size: 'tablet', query: `(min-width: ${BP.tabletMin}px) and (max-width: ${BP.tabletMax}px)` },
  { size: 'desktop', query: `(min-width: ${BP.desktopMin}px)` },
]

function currentSize(): ScreenSize {
  if (typeof window === 'undefined') return 'desktop'
  for (const { size, query } of QUERIES) {
    if (window.matchMedia(query).matches) return size
  }
  // 理论上三条查询已覆盖全部宽度；走到这里说明 matchMedia 不可用（老环境/测试桩）
  return window.innerWidth >= BP.desktopMin ? 'desktop' : window.innerWidth >= BP.tabletMin ? 'tablet' : 'mobile'
}

export interface UseBreakpoint {
  size: Readonly<Ref<ScreenSize>>
  /** 手机单栏模式：列表与正文互斥 */
  isMobile: ComputedRef<boolean>
  /** 平板：紧凑多栏 */
  isTablet: ComputedRef<boolean>
  /** 桌面：完整多栏 */
  isDesktop: ComputedRef<boolean>
  /** 平板或桌面 —— 需要多栏布局的分支统一用它，避免写两遍 */
  isWide: ComputedRef<boolean>
}

/**
 * 订阅当前断点。组件卸载时自动解绑。
 *
 * 用 `addEventListener('change')` 而非已废弃的 `addListener`。
 */
export function useBreakpoint(): UseBreakpoint {
  const size = ref<ScreenSize>(currentSize())
  const listeners: Array<() => void> = []

  for (const { size: s, query } of QUERIES) {
    const mql = window.matchMedia(query)
    const onChange = (): void => {
      if (mql.matches) size.value = s
    }
    mql.addEventListener('change', onChange)
    listeners.push(() => mql.removeEventListener('change', onChange))
  }

  onUnmounted(() => {
    for (const off of listeners) off()
    listeners.length = 0
  })

  // 布尔量一律用 computed 派生 —— 用 ref 快照会在断点切换后变成陈旧值
  const isMobile = computed(() => size.value === 'mobile')
  const isTablet = computed(() => size.value === 'tablet')
  const isDesktop = computed(() => size.value === 'desktop')
  const isWide = computed(() => size.value !== 'mobile')

  return {
    size: readonly(size),
    isMobile,
    isTablet,
    isDesktop,
    isWide,
  }
}

/**
 * 判断「现在这一屏是不是真的能被用户看到」。
 *
 * 已读门禁（R5）靠它：CSS 隐藏（`display:none` / `v-show=false`）但组件仍
 * mounted 的列表与详情页**不能**冒充「正在阅读」，否则用户停在列表时收到的
 * 消息会被静默标记为已读。
 *
 * 三个条件缺一不可：
 *   1. 元素自身渲染且未被 `display:none` 及其祖先隐藏 —— `offsetParent` 为 null
 *      即说明该元素或其祖先被隐藏（`position: fixed` 元素例外，故额外查 rect）
 *   2. 元素在视口内有实际占位
 *   3. 标签页处于可见状态（`document.visibilityState`）
 */
export function isElementVisible(el: Element | null | undefined): boolean {
  if (!el) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  // offsetParent 为 null 表示元素或其祖先 display:none（fixed 定位元素本身
  // offsetParent 就是 null，所以先看 rect，再排除 fixed 情形）
  if ((el as HTMLElement).offsetParent === null) {
    const pos = getComputedStyle(el).position
    if (pos !== 'fixed') return false
  }
  return true
}
