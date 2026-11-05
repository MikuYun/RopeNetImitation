/**
 * 剪贴板写入 —— **全仓库唯一**的一份实现（含非安全上下文降级）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么必须有降级，而不是直接 `navigator.clipboard.writeText`】
 *
 * `navigator.clipboard` **只在安全上下文**（https / localhost / file）里存在。
 * 本项目在手机上调试时走的是 `http://<局域网IP>:5173`，此时
 * `window.isSecureContext === false` → `navigator.clipboard` 是 `undefined`，
 * 直接 `await navigator.clipboard.writeText(...)` 会在**取值那一刻**就抛
 * `TypeError`（不是 promise reject，连 catch 的异步语义都进不去）。
 *
 * 用户报的缺陷「移动端长按复制消息正文失败」就是这个：气泡里的复制按钮
 * 一点就提示「复制失败」。而在修它之前，仓库里其实已经有**三份**各自
 * 带降级的实现（`utils/markdown.ts` 的代码块复制、`square/PostCard.vue`
 * 的分享链接、`views/ProfileView.vue` 的 UID 复制），只有消息气泡漏了。
 *
 * 【为什么现在收敛成一份】
 * 四份实现意味着四个会各自漂移的地方：改了一处的超时/清理，另外三处不动。
 * 所以这里统一为 `writeClipboardText()`，上面三处与消息气泡、右键菜单
 * （`utils/contextMenu.ts` 的 `copyTextToClipboard` 现在转调本函数）全部改用它。
 *
 * 【降级链】
 * 1. `navigator.clipboard.writeText`（安全上下文，异步、需要用户手势/权限）；
 * 2. 临时 `<textarea>` + `document.execCommand('copy')` —— 已废弃，但它是
 *    **非安全上下文里唯一还能写入剪贴板**的方案（安卓 Chrome 实测可用）；
 * 3. 都失败 → 返回 `false`，由调用方给出「请手动选择文本」之类的人工兜底提示。
 *
 * 【为什么返回 boolean 而不是抛异常】
 * 「复制失败」不是异常情况，而是**可预期的环境差异**（内网 http / 用户拒绝
 * 权限 / 无 document 的 node 环境）。调用方每次都要 try/catch 会把业务代码
 * 泡在噪声里，且很容易漏掉 catch → 按钮静默无反应，比报错更糟。
 * ═══════════════════════════════════════════════════════════════════════
 */

/** 复制失败时给用户的人工兜底文案（调用方 toast 统一用它，避免四处措辞漂移）。 */
export const CLIPBOARD_FALLBACK_HINT = '复制失败，请长按手动选择文本'

/**
 * 把文本写进系统剪贴板，成功返回 `true`。
 *
 * @param text 要复制的文本；空串直接返回 `false`（复制空内容没有意义，
 *        而且 `execCommand` 对空选区在部分浏览器上会返回 false 误导调用方）。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false

  // ── 第一优先：异步 Clipboard API（仅安全上下文） ──
  // 用可选链而不是 `navigator.clipboard.writeText`：非安全上下文里
  // `clipboard` 本身是 undefined，属性访问就会抛。
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 权限被拒 / 非安全上下文 / 无用户手势 → 落到下面的 DOM 兜底 */
  }

  return writeViaTextarea(text)
}

/**
 * `textarea + execCommand('copy')` 兜底。
 *
 * 细节都是踩过的坑：
 * - `position: fixed` + `top: -1000px` + `opacity: 0`：留在视口坐标系外，
 *   既不引起滚动跳动，也不会在页面上被看见；
 * - `readonly`：iOS/安卓上不加会把软键盘顶起来；
 * - **必须 `document.body.appendChild` 之后再 `select()`**：游离节点
 *   （未入文档）的选区不会被 `execCommand` 采纳；
 * - 无论成功失败都要 `removeChild`：复制按钮可能被连点，残留节点会越堆越多。
 */
function writeViaTextarea(text: string): boolean {
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
