/**
 * 自动已读上报的**第二道闸门**（WS 推送路径）。
 *
 * 【为什么需要这个文件】
 * 前端有两条「收到新消息就自动已读」的路径：
 *   1. `views/MessagePane.vue` —— 滚动/可见性驱动，已有防抖 + 最小间隔 + 失败退避；
 *   2. `ws/handlers.ts` —— 每来一条推送就判一次 `isReading`，命中就直接
 *      `conversationStore.markRead()`。
 * 第 2 条是一条消息一发请求，完全没有节流：对着一个正在刷的群，或者几条消息
 * 连着到，就是一连串 `POST /conversations/:id/read`，撞上服务端限流后返回 429
 * （`Rate limit exceeded, retry in N seconds`），控制台刷满失败日志。
 *
 * 这里给第 2 条路径补上同一套约束，但**保留首发的即时性**：空闲时第一条仍然
 * 立刻发（与改造前行为一致），只有落在最小间隔窗口内的后续消息才会被合并成
 * 一次尾随上报。
 *
 * 【为什么不做成两条路径共用一个调度器】
 * MessagePane 那条路径的编排更复杂（吸底判定、`msgStore.lastSeqOf`、群聊已读
 * 回执的 `applyMemberReadSeq`），且已被 e2e 逐条覆盖。把两者硬合并会牵动那块
 * 逻辑，风险大于收益。两条各自限流，最坏情况是每 1.5s 最多两发，仍远好于现在。
 *
 * 【为什么不 import store】
 * `stores/conversation.ts` 会调用 `resetReadSync()`；若本模块反过来 import store，
 * 就形成 `conversation.ts → readSync.ts → conversation.ts` 的循环。所以发送函数
 * 由调用方每次传进来，本模块不依赖任何 store。
 *
 * 【为什么不用 window.setTimeout】
 * vitest 跑在 node（没有 jsdom），`conversationStore.reset()` 也会走到这里；
 * 用全局 `setTimeout`/`clearTimeout` 在浏览器与 node 下都能工作。
 */

/** 两次上报之间的最小间隔（与 MessagePane 的 READ_REPORT_MIN_INTERVAL_MS 对齐）。 */
const MIN_INTERVAL_MS = 1500
/** 首次失败的退避，之后翻倍。 */
const BACKOFF_BASE_MS = 15_000
/** 退避上限。 */
const BACKOFF_MAX_MS = 60_000

type SendFn = (convId: string, lastReadSeq: number) => Promise<void>

/** 一条待发上报：seq 取较新者，send 换成最新那次调用给的（指向同一个 store 方法）。 */
interface PendingReport {
  seq: number
  send: SendFn
}

/** 每个会话「已经上报成功」的 seq，用来丢弃重复/回退的请求。 */
const ackedSeq = new Map<string, number>()
/** 已排程、尚未发出的上报。 */
const pending = new Map<string, PendingReport>()

let timer: ReturnType<typeof setTimeout> | null = null
let timerDueAt = 0
let inflight = false
let lastSuccessAt = 0
let backoffUntil = 0
let backoffMs = BACKOFF_BASE_MS

/** 页面是否在后台（node 里没有 document，按「可见」处理）。 */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

/** 清空所有待发与退避状态（登出/换账号时用）。 */
export function resetReadSync(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  timerDueAt = 0
  ackedSeq.clear()
  pending.clear()
  inflight = false
  lastSuccessAt = 0
  backoffUntil = 0
  backoffMs = BACKOFF_BASE_MS
}

/**
 * 从服务端错误里抠出建议的重试秒数（`Rate limit exceeded, retry in 17 seconds`）。
 * 抠不到就返回 0，由本地退避兜底。
 */
function serverRetryDelayMs(error: unknown): number {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const matched = /retry in (\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i.exec(text)
  if (!matched) return 0
  const seconds = Number(matched[1])
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0
}

/** 记一条待发（同会话取更靠后的 seq，并保留最新的 send）。 */
function enqueue(convId: string, seq: number, send: SendFn): void {
  const cur = pending.get(convId)
  pending.set(convId, { seq: Math.max(cur?.seq ?? 0, seq), send })
}

/** 把待发队列排到 `delay` 毫秒后执行；已有更早的排程则保留更早的那个。 */
function armTimer(delay: number): void {
  const dueAt = Date.now() + Math.max(0, delay)
  if (timer !== null && timerDueAt <= dueAt) return
  if (timer !== null) clearTimeout(timer)
  timerDueAt = dueAt
  timer = setTimeout(() => {
    timer = null
    timerDueAt = 0
    void flush()
  }, Math.max(0, delay))
}

/**
 * 请求一次自动已读（WS 推送路径的唯一入口）。
 *
 * @param convId 会话 id
 * @param seq    本次看到的最后一条消息 seq
 * @param send   真正发请求的函数（调用方传 `conversationStore.markRead`）
 */
export function scheduleReadReport(convId: string, seq: number, send: SendFn): void {
  if (!convId || seq <= 0) return
  // 后台标签页一律不发：回前台由 MessagePane 的 visibilitychange 统一补
  if (pageHidden()) return
  // 没前进就不发（重复推送、自己发的消息回显都会走到这里）
  if (seq <= (ackedSeq.get(convId) ?? 0)) return

  const now = Date.now()
  // 退避窗口内只记账，到期后一次性补最新值
  if (now < backoffUntil) {
    enqueue(convId, seq, send)
    armTimer(backoffUntil - now)
    return
  }
  // 最小间隔内的追加请求合并成一次尾随上报
  const wait = lastSuccessAt + MIN_INTERVAL_MS - now
  if (wait > 0) {
    enqueue(convId, seq, send)
    armTimer(wait)
    return
  }
  // 空闲：立刻发首条（策略与改造前一致，只有「追加」被节流）
  void dispatch(convId, seq, send)
}

/** 发一发。全局串行：在途时把 seq 记进 pending，落地后统一补发。 */
async function dispatch(convId: string, seq: number, send: SendFn): Promise<void> {
  if (inflight) {
    enqueue(convId, seq, send)
    return
  }
  inflight = true
  try {
    await send(convId, seq)
    ackedSeq.set(convId, Math.max(ackedSeq.get(convId) ?? 0, seq))
    lastSuccessAt = Date.now()
    backoffMs = BACKOFF_BASE_MS
    backoffUntil = 0
  } catch (e) {
    // markRead 内部已回滚乐观显示，这里只管退避与日志（不逐次刷屏）
    const serverMs = serverRetryDelayMs(e)
    const wait = Math.min(Math.max(backoffMs, serverMs), BACKOFF_MAX_MS)
    backoffUntil = Date.now() + wait
    backoffMs = Math.min(wait * 2, BACKOFF_MAX_MS)
    console.warn('[readSync] 自动已读上报失败，进入退避', wait, e)
    enqueue(convId, seq, send)
    armTimer(wait)
  } finally {
    inflight = false
    // 在途期间攒下的待发：等最小间隔过去再走（立刻发会马上又撞限流）
    if (pending.size > 0 && timer === null) {
      const wait = Math.max(0, lastSuccessAt + MIN_INTERVAL_MS - Date.now())
      armTimer(wait)
    }
  }
}

/** 定时器到点：把攒下的每条都发出去（各自串行，互不阻塞）。 */
async function flush(): Promise<void> {
  if (pending.size === 0) return
  const batch = [...pending.entries()]
  pending.clear()
  for (const [convId, report] of batch) {
    if (report.seq <= (ackedSeq.get(convId) ?? 0)) continue
    await dispatch(convId, report.seq, report.send)
  }
}
