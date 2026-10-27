/**
 * 消息操作菜单的**纯逻辑**（无 DOM、无 Vue 依赖）。
 *
 * 为什么把这几行抽出来单独放一个文件：
 *  1. `MessageBubble.vue` 是渲染层，vitest 环境是 node（没装 jsdom），
 *     组件挂不上去 —— 但「长按多久算长按」「安卓原生菜单要不要拦」「菜单
 *     该出现哪几项」这些判定恰恰是最容易写错、也最该被钉住的部分；
 *  2. 它们是纯函数，抽出来就能直接用假时钟/纯入参断言，不依赖任何渲染。
 *
 * 与组件的关系：组件只负责把 DOM 事件喂给这里的函数，并渲染返回的结果。
 */

/** 长按判定阈值（毫秒）。低于它算「点击/滚动起手」，不能弹菜单。 */
export const LONG_PRESS_MS = 500

/**
 * 移动端长按的判定器。
 *
 * 【为什么必须是「定时器 + 随时可取消」而不是 touchstart 直接开】
 * 手指按在气泡上然后向上滑动翻消息，是阅读长会话最常用的手势。如果
 * touchstart 就开菜单，用户会在每次想滚动时先弹出一个抽屉 —— 这比原来
 * 「悬浮按钮压字」更糟。所以规则是：按下开始计时，**期间任何**
 * touchmove / touchend / touchcancel 都会取消；只有按住不动满 500ms 才算长按。
 *
 * @param onFire 时间到时要执行的动作（打开菜单）
 * @param delay  阈值，默认 {@link LONG_PRESS_MS}；测试可注入极小值或假时钟
 */
export interface LongPress {
  /** 手指按下，开始计时。重复调用会重置计时（不会叠加多个定时器）。 */
  start(): void
  /** 取消计时（移动、抬起、取消、组件卸载都要调）。幂等。 */
  cancel(): void
  /** 当前是否正在计时（供测试与调试观察）。 */
  isArmed(): boolean
}

/**
 * 创建一个长按判定器。
 *
 * @param onFire 计时到点时的回调
 * @param delay  阈值毫秒数
 * @param setTimer/clearTimer 定时器注入点；默认用全局 setTimeout/clearTimeout，
 *        测试里换成手动触发的假实现，就不用真的等 500ms。
 */
export function createLongPress(
  onFire: () => void,
  delay: number = LONG_PRESS_MS,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): LongPress {
  let handle: unknown = null

  function cancel(): void {
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
  }

  function start(): void {
    cancel()
    handle = setTimer(() => {
      handle = null
      onFire()
    }, delay)
  }

  return {
    start,
    cancel,
    isArmed: () => handle !== null,
  }
}

/**
 * 长按/右键到点后，**要不要真的弹菜单**。
 *
 * 三个否决条件：
 *  - 系统消息（「X 加入了群聊」）没有正文可复制、也不能置顶，弹菜单只会让用户困惑；
 *  - 桌面端：悬浮工具条已经把操作摆在气泡外侧，再叠一个菜单是重复入口；
 *  - 移动端之外不接管 `contextmenu`，否则会夺走浏览器右键（复制链接/检查元素等）。
 *
 * @param isSystem 是否系统消息
 * @param isMobile 是否移动端断点（<=767px）
 */
export function shouldOpenMessageMenu(isSystem: boolean, isMobile: boolean): boolean {
  if (isSystem) return false
  return isMobile
}

/** 菜单项标识。文案由组件决定，顺序由 {@link messageMenuItems} 决定。 */
export type MessageMenuItem =
  | 'copy'
  | 'reply'
  | 'toggle-source'
  | 'toggle-pin'
  | 'download-attachment'
  | 'recall'

/**
 * 撤回窗口（毫秒）—— 与后端 RECALL_WINDOW_EXPIRED 的 120 秒**必须一致**。
 *
 * 客户端提前判一次，是为了不把注定 403 的动作摆在菜单上：用户点了才报错
 * 比根本不显示更差（特别是长按菜单已经在手边时）。但本地时钟不可信，
 * 后端才是最终仲裁者 —— 所以这只是**菜单可见性**优化，不能当成权限校验。
 */
export const RECALL_WINDOW_MS = 120_000

/**
 * 菜单里应该出现哪些项，以及它们的顺序。
 *
 * 顺序按「使用频率 × 后果」排：复制（最常用）→ 回复 → 看源码/渲染（阅读辅助）→
 * 置顶（改变会话状态）→ 下载附件 → 撤回（不可逆，固定放最后）。
 * 「取消」不在这个列表里：它由组件固定追加在末尾，不属于业务动作。
 *
 * @param opts.hasText      有正文才显示「复制正文」
 * @param opts.canReply     未撤回、非系统消息才可引用回复
 * @param opts.canToggle    正文含 Markdown 语法才显示「看源码/看渲染」
 * @param opts.pinned       是否已置顶，决定文案是「置顶」还是「取消置顶」
 * @param opts.hasAttachment 有附件才显示「下载附件」
 * @param opts.canRecall    作者本人 && 未撤回 && 在 120 秒窗口内
 */
export function messageMenuItems(opts: {
  hasText: boolean
  canReply: boolean
  canToggle: boolean
  pinned: boolean
  hasAttachment: boolean
  canRecall: boolean
}): MessageMenuItem[] {
  const items: MessageMenuItem[] = []
  if (opts.hasText) items.push('copy')
  if (opts.canReply) items.push('reply')
  if (opts.canToggle) items.push('toggle-source')
  // 置顶对任何已发出的消息都可用（文本/图片/文件都能置顶），所以不加条件；
  // `pinned` 只影响文案，不影响是否出现。
  items.push('toggle-pin')
  if (opts.hasAttachment) items.push('download-attachment')
  // 危险动作永远排最后：菜单是从上往下读的，误触代价高的项不能夹在中间
  if (opts.canRecall) items.push('recall')
  return items
}

/**
 * 消息是否还在撤回窗口内。
 *
 * 单独抽成函数而不写在组件里，是因为「本地时钟/服务端时钟不一致」这件事
 * 经常被忘记：时间解析不出来（NaN）时必须保守地判 false（不显示撤回），
 * 也不应该把「负数延迟」（本地时钟落后于服务端）判成超出窗口 —— 刚发出的
 * 消息反而不能撤回是最容易被用户发现的 bug。
 *
 * 未发送成功的乐观消息（`status !== 'sent'`）也不能撤回：服务端还没有这条消息。
 */
export function canRecallMessage(input: {
  isMine: boolean
  recalled: boolean
  status: string
  createdAt: string
  now?: number
}): boolean {
  if (!input.isMine) return false
  if (input.recalled) return false
  if (input.status !== 'sent') return false
  const created = Date.parse(input.createdAt)
  if (!Number.isFinite(created)) return false
  const now = input.now ?? Date.now()
  const elapsed = now - created
  if (elapsed < 0) return true
  return elapsed <= RECALL_WINDOW_MS
}
