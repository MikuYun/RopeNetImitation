<script setup lang="ts">
/**
 * 消息区。
 *
 * 关键行为：
 *   - 向上滚动到顶自动加载更早的消息，且**保持滚动位置**（翻页前记录 scrollHeight）
 *   - 新消息到达时若已在底部则自动吸底；否则不打扰（不强制滚动）
 *   - 排序完全按 seq（由 store 保证），模板不排序
 *   - 消息文本永不 v-html（见 MessageBubble）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import AppSkeleton from '@/components/base/AppSkeleton.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import MessageBubble from '@/components/message/MessageBubble.vue'
import DateDivider from '@/components/message/DateDivider.vue'
import TypingIndicator from '@/components/message/TypingIndicator.vue'
import MessageComposer from '@/components/message/MessageComposer.vue'
import type { ComposerSendPayload } from '@/components/message/composer'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useMessageStore } from '@/stores/message'
import { usePinsStore } from '@/stores/pins'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore } from '@/stores/ui'
import { useBreakpoint, isElementVisible } from '@/composables/useBreakpoint'
import { goBack } from '@/composables/useBackNavigation'
import { fromNow, needsDateDivider, formatDateDivider } from '@/utils/datetime'
import { toApiError } from '@/api/http'
import type { SendMessageInput } from '@/api/messages'
import type { Attachment, LocalMessage, PinnedMessage, ReplyRef, WireMessage } from '@/types/domain'
import { attachmentsPreviewText } from '@/utils/attachments'

const props = defineProps<{ convId: string }>()

const auth = useAuthStore()
const convStore = useConversationStore()
const msgStore = useMessageStore()
const pinsStore = usePinsStore()
const presence = usePresenceStore()
const friendStore = useFriendStore()
const ui = useUiStore()
const router = useRouter()
const route = useRoute()
const { isMobile } = useBreakpoint()

const scroller = ref<HTMLElement | null>(null)
const atBottom = ref(true)

const conversation = computed(() => convStore.summariesById.get(props.convId) ?? null)
const detail = computed(() => convStore.detailsById.get(props.convId) ?? null)
const messages = computed<LocalMessage[]>(() => msgStore.messagesOf(props.convId))
const loadingOlder = computed(() => msgStore.isLoading(props.convId))

const typingNames = computed(() => {
  const ids = presence.typingUsersOf(props.convId, auth.userId)
  return ids.map((id) => nameOf(id)).filter(Boolean)
})

const peerOnline = computed(() =>
  conversation.value?.peer ? presence.isOnline(conversation.value.peer.id) : false,
)

const peerLastSeen = computed(() => {
  const peer = conversation.value?.peer
  if (!peer) return ''
  if (presence.isOnline(peer.id)) return '在线'
  const last = presence.lastSeenOf(peer.id)
  return last ? `最后在线 ${fromNow(last)}` : ''
})

const subtitle = computed(() => {
  const c = conversation.value
  if (!c) return ''
  if (c.type === 'group') return `${c.memberCount ?? detail.value?.members.length ?? 0} 人`
  return peerLastSeen.value
})

function nameOf(userId: string): string {
  const m = detail.value?.members.find((x) => x.user.id === userId)
  if (m) return m.user.displayName
  const f = friendStore.friends.find((x) => x.user.id === userId)
  if (f) return f.user.displayName
  const p = conversation.value?.peer
  if (p && p.id === userId) return p.displayName
  return ''
}

/**
 * 消息头/气泡旁的发送者头像（需求 1：头像必须在聊天界面里真实可见）。
 *
 * 与 `nameOf` 同一套查找顺序：群成员详情 → 好友列表 → 单聊 peer。
 * 返回空串表示「查不到头像」，MessageBubble 会退回首字母，不会破图。
 */
function avatarOf(userId: string): string {
  const m = detail.value?.members.find((x) => x.user.id === userId)
  if (m) return m.user.avatarUrl ?? ''
  const f = friendStore.friends.find((x) => x.user.id === userId)
  if (f) return f.user.avatarUrl ?? ''
  const p = conversation.value?.peer
  if (p && p.id === userId) return p.avatarUrl ?? ''
  return ''
}

/** 单聊对方是否已读到某条消息。 */
function peerReadSeq(): number {
  const c = conversation.value
  if (!c || c.type !== 'single' || !c.peer) return 0
  return detail.value?.members.find((m) => m.user.id === c.peer!.id)?.lastReadSeq ?? 0
}

function readByPeer(msg: LocalMessage): boolean {
  if (msg.seq === null) return false
  return peerReadSeq() >= msg.seq
}

/** 群聊已读人数（不含自己）。 */
function readCountOf(msg: LocalMessage): number {
  if (conversation.value?.type !== 'group') return 0
  if (msg.seq === null) return 0
  const total = (detail.value?.members.length ?? 1) - 1
  const n = countReaders(msg.seq)
  // 全员已读时不显示数字，避免每条都挂一串「2 人已读」
  return n >= total ? 0 : n
}

function countReaders(seq: number): number {
  let n = 0
  for (const m of detail.value?.members ?? []) {
    if (m.user.id === auth.userId) continue
    if (m.lastReadSeq >= seq) n += 1
  }
  return n
}

/** 渲染序列：在合适的位置插入日期分隔条。LocalMessage 与分隔条混排。 */
type Row = { kind: 'divider'; key: string; label: string } | { kind: 'msg'; key: string; msg: LocalMessage }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let prev: string | null = null
  for (const m of messages.value) {
    if (needsDateDivider(m.createdAt, prev)) {
      out.push({ kind: 'divider', key: `d-${m.localId}`, label: formatDateDivider(m.createdAt) })
    }
    out.push({ kind: 'msg', key: m.localId, msg: m })
    prev = m.createdAt
  }
  return out
})

// 手动上报已读的唯一入口 —— 带门禁，见下面 syncReading 的说明。
// markRead 失败会回滚乐观显示并抛出，这里兜住：门禁逻辑仍是唯一的判据来源，
// 失败只记日志不打断交互（服务端未收到，下次进会话或推送到达会再校准）。
async function reportRead(convId: string, seq: number): Promise<void> {
  if (seq <= 0) return
  try {
    await convStore.markRead(convId, seq)
    msgStore.applyMemberReadSeq(convId, auth.userId, seq)
  } catch (e) {
    console.warn('[MessagePane] 已读上报失败，显示已回滚', e)
  }
}

/**
 * 同步「正在阅读」状态。
 *
 * 【门禁】只有同时满足三条才算真正在读：
 *   1. 消息正文元素在 DOM 里且实际可见（不是 `display:none`）
 *   2. 浏览器标签页处于可见状态（用户没切到别的标签/最小化）
 *   3. 路由停在 `chat`（不是详情页、不是列表、不是联系人）
 *
 * 缺第 1 条的后果：桌面端 CSS 隐藏的列表/正文仍 mounted，照样吞未读。
 * 缺第 2 条的后果：后台标签页收到消息被标记已读，用户回来一看红点没了。
 *
 * 不满足时把 readingId 清空 —— 之后新消息不会再触发自动已读，
 * 列表上的未读红点得以保留（任务书 R5 的核心验收项）。
 */
let readSyncTimer: number | null = null

function syncReading(): void {
  const visible =
    route.name === 'chat' &&
    isElementVisible(scroller.value) &&
    !!conversation.value
  if (!visible) {
    convStore.setReading(null)
    return
  }
  convStore.setReading(props.convId)
  const last = msgStore.lastSeqOf(props.convId)
  if (last > 0) void reportRead(props.convId, last)
}

/** 合并同一帧内的多次触发（滚动 + 可见性 + 路由可能同时发生）。 */
function scheduleReadSync(): void {
  if (readSyncTimer !== null) window.clearTimeout(readSyncTimer)
  readSyncTimer = window.setTimeout(() => {
    readSyncTimer = null
    syncReading()
  }, 0)
}

function onVisibilityChange(): void {
  scheduleReadSync()
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onVisibilityChange)
  scheduleReadSync()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onVisibilityChange)
  if (readSyncTimer !== null) {
    window.clearTimeout(readSyncTimer)
    readSyncTimer = null
  }
  // 卸载即离开阅读态，避免后续推送被误判为「正在读」
  convStore.setReading(null)
})

/**
 * 上传中的滚动位置维护 + 阅读态刷新。
 *
 * 贴底时才认为「看到了最新消息」→ 这时才允许自动已读。
 * 用户正在往上翻历史时新消息不吸底、也不算已读（任务书 R3/R5）。
 */
function onScroll(): void {
  const el = scroller.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  atBottom.value = distance < 40
  if (el.scrollTop < 60 && msgStore.hasMoreOlder(props.convId) && !loadingOlder.value) {
    void loadOlder()
  }
  scheduleReadSync()
}

/** 翻页前记录高度，翻页后补偿滚动位置，避免视口跳动。 */
async function loadOlder(): Promise<void> {
  const el = scroller.value
  if (!el) return
  const prevHeight = el.scrollHeight
  const prevTop = el.scrollTop
  await msgStore.loadOlder(props.convId)
  await nextTick()
  const newHeight = el.scrollHeight
  el.scrollTop = prevTop + (newHeight - prevHeight)
}

function scrollToBottom(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

// ── 消息置顶（ux2-contract §九） ─────────────────────────────────────
/**
 * 置顶列表。
 *
 * 【为什么放在顶部条而不是「只是把消息固定」】置顶的意义是「不用翻历史就能
 * 找到」，所以必须有可见入口。顶部条的每一条都是**入口**：点一下跳到那条
 * 消息（.pane__scroll 里按 data-msg-id 定位）。
 */
const pinnedList = computed<PinnedMessage[]>(() => pinsStore.pinsOf(props.convId))
const pinnedCount = computed(() => pinnedList.value.length)
/** 置顶条展开态：默认收起，超过 1 条时才值得展开（避免长期占用消息区高度）。 */
const pinsOpen = ref(false)

/** 已置顶的消息 id 集合 —— 传给气泡决定菜单/工具条显示「置顶」还是「取消置顶」。 */
const pinnedIds = computed(() => new Set(pinnedList.value.map((p) => p.message.msgId)))

/**
 * 置顶条里显示的摘要文本。
 *
 * 置顶条只有一行宽度，正文可能很长；图片/文件消息正文可能为空。所以：
 *   - 附件 → 用 `attachmentsPreviewText` 的占位（`[图片]` / `[视频]` / `[文件] 名`），
 *     否则显示空白条
 *   - 空正文 → 兜底「（无正文）」
 * 完整内容由点击跳转去看，这里不做任何截断以外的加工。
 */
function pinText(pin: PinnedMessage): string {
  const m = pin.message
  if (m.recalled) return '（已撤回）'
  const body = m.content.trim()
  if (body) return body.replace(/\s+/g, ' ')
  const preview = attachmentsPreviewText(m.attachments ?? [])
  if (preview) return preview
  return '（无正文）'
}

function isPinnedMsg(msg: LocalMessage): boolean {
  const id = msg.msgId || msg.localId
  return pinnedIds.value.has(id)
}

/**
 * 置顶一条消息。
 *
 * 传入的 msgId 必须是**服务端消息 UUID**：乐观消息（status==='sending'）还没有
 * 真正的 msgId，此时置顶必然 400 INVALID_MESSAGE，所以先拦下来解释清楚，
 * 而不是让用户看到一串后端错误码。
 */
async function onPin(msgId: string): Promise<void> {
  const msg = messages.value.find((m) => (m.msgId || m.localId) === msgId)
  if (msg && msg.status !== 'sent') {
    ui.toast('消息尚未发送成功，不能置顶', 'info')
    return
  }
  try {
    await pinsStore.pin(props.convId, msgId)
    pinsOpen.value = true
  } catch (e) {
    const err = toApiError(e)
    if (err.code === 'PIN_LIMIT') ui.toast('置顶已满 50 条，请先取消一条', 'error')
    else if (err.code === 'INVALID_MESSAGE') ui.toast('这条消息已不存在，无法置顶', 'error')
    else ui.toast(`置顶失败：${err.message}`, 'error')
  }
}

async function onUnpin(msgId: string): Promise<void> {
  try {
    await pinsStore.unpin(props.convId, msgId)
  } catch (e) {
    ui.toast(`取消置顶失败：${toApiError(e).message}`, 'error')
  }
}

/**
 * 点击置顶条跳到对应消息。
 *
 * 【为什么要「滚过去 + 高亮」而不是直接弹窗预览】用户点置顶是想看上下文
 * （那条消息前后说了什么），弹窗把上下文切断了。滚动定位保留原始阅读位置，
 * 再用一次性高亮告诉用户「就是这条」。
 *
 * 定位用 `data-msg-id`（MessageBubble 根节点上的属性），不依赖 seq —— seq 在
 * 分页未加载时可能根本不在 DOM 里，而置顶消息本身一定是已加载的。
 */
const HIGHLIGHT_MS = 1600
const highlightId = ref<string | null>(null)
let highlightTimer: number | null = null

async function jumpToPinned(pin: PinnedMessage): Promise<void> {
  const msgId = pin.message.msgId
  const scroll = scroller.value
  if (!scroll) return

  // 目标不在 DOM（理论上不会：置顶消息必然是已加载消息）→ 兜底拉一次最新页
  let node = scroll.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(msgId)}"]`)
  if (!node) {
    await msgStore.ensureLoaded(props.convId, 30)
    await nextTick()
    node = scroll.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(msgId)}"]`)
  }
  if (!node) {
    ui.toast('这条消息已不在当前会话', 'info')
    return
  }

  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.classList.add('pane__row--flash')
  highlightId.value = msgId
  if (highlightTimer !== null) window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    node?.classList.remove('pane__row--flash')
    highlightId.value = null
    highlightTimer = null
  }, HIGHLIGHT_MS)
}

/**
 * 属性选择器里的 id 转义。
 *
 * msgId 是 UUID（只含 [0-9a-f-]），理论上不需要转义；但 `CSS.escape` 在旧
 * WebView 里可能不存在，这里做能力检测 + 手写兜底，避免整块功能在个别
 * 浏览器上直接抛错（一个异常会让整个点击处理器失效）。
 */
function cssEscape(value: string): string {
  const api = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (api?.escape) return api.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

onUnmounted(() => {
  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer)
    highlightTimer = null
  }
})


/**
 * 发送消息。
 *
 * payload 来自 MessageComposer：`{ content, attachments, replyToMsgId }`。
 *
 * 【为什么 content 与 attachmentIds 一起传】v1 的实现在有附件时**丢掉了 content**，
 * 只发 `attachmentId`，于是「图片 + 文字」里的文字凭空消失（这正是 v2 修的 bug）。
 * 现在两者既可并存、也可只有附件：content 允许为空串，附件允许为空数组，
 * 唯一非法的组合是「既没有文字也没有附件」。
 *
 * 乐观消息与最终确认消息的 type 由 store/normalize 按附件统一推导，这里不重复判断。
 */
async function onSend(payload: ComposerSendPayload): Promise<void> {
  const { content, attachments } = payload
  const replyToMsgId = payload.replyToMsgId
  const replyTo = buildReplyRef(replyToMsgId)

  const local = msgStore.appendOptimistic({
    conversationId: props.convId,
    senderId: auth.userId,
    content,
    attachments,
    replyTo,
  })
  replyTarget.value = null
  await nextTick()
  scrollToBottom()

  // 发送走 REST（后端已确定）：原生幂等、状态码明确、重试简单。
  try {
    const { sendMessage } = await import('@/api/messages')
    const confirmed = await sendMessage(
      props.convId,
      buildSendInput(local.clientMsgId ?? '', content, attachments, replyToMsgId),
    )
    // insertOrIgnore 会按 clientMsgId 兑现并移除乐观消息
    msgStore.insertOrIgnore(confirmed)
    applyConfirmedSummary(confirmed)
  } catch (e) {
    const err = toApiError(e)
    /*
     * 只有**确实把这条乐观消息标成了失败态**才提示。
     *
     * 反例（曾经真实存在）：服务端已落库，WS 的 `message.created` 抢先到达，
     * `insertOrIgnore` 把 pending 兑现成了 confirmed；随后 axios 的超时/网络错误
     * 才抛出。此时这条消息已经躺在时间线上、状态是 sent，再弹一个「发送失败」
     * 就是纯误报 —— 用户会去点重试、甚至以为消息没发出去而重复发一遍。
     * 所以把 toast 的触发权收归 store 的实际结果。
     */
    const marked = msgStore.markFailed(props.convId, local.clientMsgId ?? '', err.code)
    if (marked) ui.toast(`发送失败：${err.message}`, 'error')
  }
}

/** 组发送请求体：只放存在的字段（后端 additionalProperties:false）。 */
function buildSendInput(
  clientMsgId: string,
  content: string,
  attachments: Attachment[],
  replyToMsgId: string | null,
): SendMessageInput {
  const input: SendMessageInput = { clientMsgId, content }
  if (attachments.length > 0) input.attachmentIds = attachments.map((a) => a.id)
  if (replyToMsgId) input.replyToMsgId = replyToMsgId
  return input
}

/** 用本地已有消息拼一个引用引用信息（服务端回包会用权威值覆盖）。 */
function buildReplyRef(msgId: string | null): ReplyRef | null {
  if (!msgId) return null
  const target = messages.value.find((m) => (m.msgId || m.localId) === msgId)
  if (!target) return null
  const preview =
    target.content.trim().replace(/\s+/g, ' ') || attachmentsPreviewText(target.attachments ?? [])
  return {
    msgId: target.msgId || target.localId,
    senderId: target.senderId,
    senderName: nameOf(target.senderId) || (target.senderId === auth.userId ? '你' : '对方'),
    preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
  }
}

/** 把已确认消息的最新状态同步到会话列表的 lastMessage。 */
function applyConfirmedSummary(confirmed: WireMessage): void {
  const conv = conversation.value
  if (!conv || confirmed.seq === null || confirmed.seq <= conv.lastSeq) return
  convStore.upsertSummary(
    {
      ...conv,
      lastMessage: {
        type: confirmed.type,
        content: confirmed.content,
        senderId: auth.userId,
        seq: confirmed.seq,
        attachmentKind: confirmed.attachments?.[0]?.kind ?? null,
      },
      lastSeq: confirmed.seq,
      updatedAt: confirmed.createdAt,
    },
    { keepPosition: true },
  )
}

/**
 * 失败重试。附件已经上传成功，只需把同一批 uploadId 再挂一次；正文照旧带上。
 */
async function retry(msg: LocalMessage): Promise<void> {
  if (!msg.clientMsgId) return
  msgStore.markRetrying(props.convId, msg.clientMsgId)
  try {
    const { sendMessage } = await import('@/api/messages')
    const confirmed = await sendMessage(
      props.convId,
      buildSendInput(
        msg.clientMsgId,
        msg.content,
        msg.attachments ?? [],
        msg.replyTo?.msgId ?? null,
      ),
    )
    msgStore.insertOrIgnore(confirmed)
    applyConfirmedSummary(confirmed)
  } catch (e) {
    const err = toApiError(e)
    if (msgStore.markFailed(props.convId, msg.clientMsgId, err.code)) {
      ui.toast(`发送失败：${err.message}`, 'error')
    }
  }
}

// ── 引用回复（v2） ──────────────────────────────────────────────────
/**
 * 当前引用目标。
 *
 * 状态放在这里而不是 composer 内部：点「回复」发生在气泡上，渲染在输入框上，
 * 父级是两侧共同的真相源（composer 只接 props + emit cancelReply）。
 */
const replyTarget = ref<ReplyRef | null>(null)

function onReply(msgId: string): void {
  const ref_ = buildReplyRef(msgId)
  if (!ref_) {
    ui.toast('被引用的消息已不在此会话', 'info')
    return
  }
  replyTarget.value = ref_
}

function cancelReply(): void {
  replyTarget.value = null
}

/** 点击引用条：滚动定位到被引用的消息并短暂高亮。 */
function onJumpTo(msgId: string): void {
  if (!msgId) return
  void jumpToMessage(msgId)
}

/**
 * 滚动定位到某条消息。
 *
 * 与 `jumpToPinned` 的差别只在「找不到时的兜底」：引用目标可能是更早的历史，
 * 这里也用 ensureLoaded 补一页再试。高亮复用 `.pane__row--flash`。
 */
async function jumpToMessage(msgId: string): Promise<void> {
  const scroll = scroller.value
  if (!scroll) return
  let node = scroll.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(msgId)}"]`)
  if (!node) {
    await msgStore.ensureLoaded(props.convId, 30)
    await nextTick()
    node = scroll.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(msgId)}"]`)
  }
  if (!node) {
    ui.toast('这条消息已不在当前会话', 'info')
    return
  }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.classList.add('pane__row--flash')
  if (highlightTimer !== null) window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    node?.classList.remove('pane__row--flash')
    highlightTimer = null
  }, HIGHLIGHT_MS)
}

// ── 撤回（v2） ──────────────────────────────────────────────────────
/**
 * 撤回一条自己发的消息。
 *
 * 服务端只允许作者本人、且 120 秒内（`RECALL_WINDOW_EXPIRED`）。成功后**必须**用
 * 返回的消息走 `upsertMessage` 覆盖本地：撤回不是删除，而是同一条消息的新版本
 * （正文清空、附件清空、recalled=true），用 `insertOrIgnore` 会被旧缓存挡住。
 * 置顶列表里可能缓存了同一条消息的旧副本，也要一并脱敏。
 */
async function onRecall(msgId: string): Promise<void> {
  if (!msgId) return
  try {
    const { recallMessage } = await import('@/api/messages')
    const recalled = await recallMessage(props.convId, msgId)
    msgStore.upsertMessage(recalled)
    sanitizePinned(recalled.msgId, recalled)
    applyRecalledSummary(recalled)
    ui.toast('已撤回', 'info')
  } catch (e) {
    const err = toApiError(e)
    if (err.code === 'RECALL_WINDOW_EXPIRED') ui.toast('超过 2 分钟，无法撤回', 'error')
    else if (err.code === 'FORBIDDEN') ui.toast('只能撤回自己发送的消息', 'error')
    else if (err.code === 'MESSAGE_NOT_FOUND') ui.toast('这条消息已不存在', 'error')
    else ui.toast(`撤回失败：${err.message}`, 'error')
  }
}

/**
 * 点对方头像 → 打开访客资料页（需求 2）。
 *
 * 复用已有 `user-profile` 路由；目标是自己时不做特殊处理 ——
 * `UserProfileView` 内部按 `relationship === 'self'` 自动降级为「我的资料」形态。
 */
function onOpenProfile(userId: string): void {
  if (!userId) return
  void router.push({ name: 'user-profile', params: { userId } })
}

/** 置顶缓存里的同一条消息也要换成脱敏版本，否则置顶条仍显示旧正文。 */
function sanitizePinned(msgId: string, message: WireMessage): void {
  const list = pinsStore.pinsOf(props.convId)
  if (list.length === 0) return
  let changed = false
  const next = list.map((p) => {
    if (p.message.msgId !== msgId) return p
    changed = true
    // 置顶缓存里的是领域 WireMessage（seq 非空），撤回回包也是，可直接替换
    return { ...p, message }
  })
  if (changed) pinsStore.applyFromWs(props.convId, next)
}

/**
 * 撤回后同步会话列表的预览。
 *
 * 服务端撤回不会推 `conversation.updated`（只有 `message.updated`），如果不本地改，
 * 左列表会一直显示被撤回的原文 —— 那是撤回功能最不能接受的泄露。
 * 这里不按 seq 比较（撤回的往往不是最后一条，但可能是）：只要 seq 等于当前
 * lastSeq 就替换。
 */
function applyRecalledSummary(recalled: WireMessage): void {
  const conv = conversation.value
  if (!conv || !conv.lastMessage || recalled.seq === null) return
  if (conv.lastMessage.seq !== recalled.seq) return
  convStore.upsertSummary(
    {
      ...conv,
      lastMessage: {
        type: 'text',
        // 后端撤回后 content 是空串，直接显示会变成「我：」；这里给一句明确文案
        content: '消息已撤回',
        senderId: conv.lastMessage.senderId,
        seq: recalled.seq,
        attachmentKind: null,
      },
    },
    { keepPosition: true },
  )
}

async function openInfo(): Promise<void> {
  void router.push({ name: 'conversation-info', params: { convId: props.convId } })
}

/** 手机返回：回会话列表（站内回退，见 composables/useBackNavigation.ts）。 */
function goBackToChats(): void {
  convStore.setActive(null)
  goBack(router, { name: 'chat-empty' })
}

/**
 * 进入会话：加载历史 + 拉详情（群聊已读要用 members[]）+ 上报已读。
 *
 * 可重入：切换会话、摘要晚到都会再调一次。用 gen 令牌让在途的旧调用作废，
 * 否则旧会话的历史加载返回后会把视口滚到新会话上。
 */
let enterGen = 0
/**
 * 摘要尚未就位（深链 / 直接刷新时 MessagePane 先于 ChatView.fetchAll 挂载）。
 * 此刻不能加载历史，但要记住「用户打开过」，等摘要到了一定要补上。
 */
let awaitingSummary = false

async function enterConversation(): Promise<void> {
  const gen = (enterGen += 1)
  const convId = props.convId
  const conv = conversation.value

  if (!conv) {
    // 【勿改回裸 return】这里直接返回会让历史**永远不会**加载 —— 表现为
    // 左侧列表有最后一条消息的预览、右侧气泡却全空（后端公网验收报的就是这个）。
    // 数据没丢，只是没人去取：刷新时 MessagePane 先挂载，ensureLoaded 压根没被调用。
    // 记下「摘要未就位」，由下面的 watch 在摘要到达时补做。
    awaitingSummary = true
    return
  }
  awaitingSummary = false

  await Promise.all([msgStore.ensureLoaded(convId, 30), convStore.ensureDetail(convId)])
  if (gen !== enterGen) return
  await nextTick()
  if (gen !== enterGen) return

  atBottom.value = true
  scrollToBottom()

  // 置顶列表：独立请求，不阻塞消息渲染。后端接口未就绪时 store 内部只记录
  // 错误不弹错，顶部条自然不显示（用户看不到一个坏掉的功能）。
  void pinsStore.ensureLoaded(convId)

  // 已读上报统一走带门禁的 syncReading —— 进入会话时要先确认正文真的可见
  // （桌面端可能是从联系人 tab 进来的，此时正文被隐藏，不该算已读）
  scheduleReadSync()

  const members = detail.value?.members.map((m) => m.user.id) ?? []
  const ids = conv.peer ? [...members, conv.peer.id] : members
  void presence.prefetch(ids)
}

onMounted(enterConversation)

watch(
  () => props.convId,
  () => {
    awaitingSummary = false
    void enterConversation()
  },
)

/**
 * 摘要就绪的补做。
 *
 * 只在「上一次进入因摘要缺失而中断」时触发 —— 不能无条件调用，否则
 * ChatView.fetchAll 每刷一次列表都会重跑进入流程（重复上报已读、重复吸底）。
 */
watch(conversation, (c) => {
  if (c && awaitingSummary) void enterConversation()
})

// 路由离开正文（回列表 / 进详情）→ 立刻退出阅读态，后续推送不得自动已读
watch(
  () => route.name,
  () => scheduleReadSync(),
)

/**
 * 未读浮动提示。
 *
 * 为什么不用「滚到顶才显示」：用户往上翻两屏就开始漏消息了，等到滚到顶
 * 才提示等于没提示。这里改成「只要离开底部且来了新消息」就出现，点一下
 * 回到底部并清零。数字用「新消息」而不是精确条数 —— 分页补偿可能一次
 * 插入很多条，精确计数反而对不上用户的直觉。
 */
const unseen = ref(0)

function jumpToBottom(): void {
  unseen.value = 0
  atBottom.value = true
  scrollToBottom()
}

// 新消息到达：仅在已贴底时自动吸底，否则保持用户当前阅读位置
watch(
  () => messages.value.length,
  async (next, prev) => {
    if (atBottom.value) {
      await nextTick()
      scrollToBottom()
      // 贴底时用户已经看到了，浮动提示不必出现
      unseen.value = 0
    } else if (typeof prev === 'number' && next > prev) {
      // 用户正在往上翻历史：不强行拽回底部，只在右下角挂一个浮动入口
      unseen.value += next - prev
    }
    // 新消息可能改变可见性判定（例如首帧渲染完成后 scroller 才有尺寸）
    scheduleReadSync()
  },
)
</script>

<template>
  <section class="pane">
    <AppEmpty
      v-if="!conversation"
      icon="chat"
      title="会话不存在或已退出"
      description="它可能已被解散，或你已被移出群聊"
    />

    <template v-else>
      <header class="pane__head">
        <!-- 手机：顶部返回。落到站内列表，不是 router.back()（深链时无处可退）。 -->
        <button
          v-if="isMobile"
          class="pane__back touch-target"
          type="button"
          aria-label="返回"
          @click="goBackToChats"
        >
          <AppIcon name="back" :size="20" />
        </button>

        <div class="pane__title-wrap">
          <span class="pane__title">{{ conversation.title }}</span>
          <span class="pane__sub">
            <PresenceDot
              v-if="conversation.type === 'single' && conversation.peer && peerOnline"
              :user-id="conversation.peer.id"
              :size="8"
            />
            {{ subtitle }}
          </span>
        </div>
        <button class="pane__more touch-target" type="button" title="会话信息" @click="openInfo">
          <AppIcon name="more" :size="18" />
        </button>
      </header>

      <!--
        置顶条（ux2-contract §九）。放在消息区**上方**——置顶的价值就是「不用翻」。
        默认收起成一行摘要，点开展开全部（最多 50 条，内部滚动）。
      -->
      <div v-if="pinnedCount > 0" class="pane__pins" :class="{ 'pane__pins--open': pinsOpen }">
        <button
          class="pane__pins-head"
          type="button"
          :aria-expanded="pinsOpen"
          @click="pinsOpen = !pinsOpen"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M9 3h6l-1 6 3.5 3.5H6.5L10 9z" fill="currentColor" />
            <path d="M12 12.5V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span class="pane__pins-title">置顶消息（{{ pinnedCount }}）</span>
          <svg
            class="pane__pins-caret"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            aria-hidden="true"
          >
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <ul class="pane__pins-list">
          <li v-for="pin in pinnedList" :key="pin.id" class="pane__pins-item">
            <button class="pane__pin-btn" type="button" @click="jumpToPinned(pin)">
              <span class="pane__pin-who">{{ nameOf(pin.message.senderId) || '消息' }}</span>
              <span class="pane__pin-text">{{ pinText(pin) }}</span>
            </button>
            <button
              class="pane__pin-x"
              type="button"
              title="取消置顶"
              aria-label="取消置顶"
              @click="onUnpin(pin.message.msgId)"
            >
              <AppIcon name="close" :size="12" />
            </button>
          </li>
        </ul>
      </div>

      <div ref="scroller" class="pane__scroll" @scroll="onScroll">
        <div v-if="loadingOlder" class="pane__loading"><AppSkeleton :count="2" :height="12" /></div>

        <div v-if="rows.length === 0" class="pane__blank">
          <p>还没有消息，打个招呼吧</p>
        </div>

        <template v-for="row in rows" :key="row.key">
          <DateDivider v-if="row.kind === 'divider'" :label="row.label" />
          <div v-else class="pane__row">
            <MessageBubble
              :message="row.msg"
              :mine="row.msg.senderId === auth.userId"
              :conv-type="conversation.type"
              :sender-name="nameOf(row.msg.senderId)"
              :sender-id="row.msg.senderId"
              :sender-avatar="avatarOf(row.msg.senderId)"
              :read-by-peer="readByPeer(row.msg)"
              :read-count="readCountOf(row.msg)"
              :pinned="isPinnedMsg(row.msg)"
              @pin="onPin"
              @unpin="onUnpin"
              @jump-to="onJumpTo"
              @reply="onReply"
              @recall="onRecall"
              @open-profile="onOpenProfile"
            />
            <button
              v-if="row.msg.status === 'failed'"
              class="pane__retry"
              type="button"
              @click="retry(row.msg)"
            >
              <AppIcon name="retry" :size="12" /> 重试
            </button>
          </div>
        </template>

        <TypingIndicator :names="typingNames" />
      </div>

      <!--
        未读浮动入口。放在 scroller 外层（不是内部）—— 内部会被滚动一起带走；
        也不能用 position:fixed（手机端会被软键盘/安全区推歪），所以给
        .pane 加 position:relative，这里绝对定位到右下角。
      -->
      <button
        v-if="unseen > 0 || !atBottom"
        class="pane__jump"
        type="button"
        :aria-label="unseen > 0 ? `有 ${unseen} 条新消息，回到底部` : '回到底部'"
        @click="jumpToBottom"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            d="M12 5v14m0 0 5.5-5.5M12 19l-5.5-5.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-if="unseen > 0" class="pane__jump-text">{{ unseen }} 条新消息</span>
      </button>

      <MessageComposer
        :conversation-id="convId"
        :reply-target="replyTarget"
        @send="onSend"
        @cancel-reply="cancelReply"
      />
    </template>
  </section>
</template>

<style scoped>
.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--chat-canvas);
  /* 未读浮动按钮以它为定位容器（不能用 fixed：手机端会被键盘/安全区推歪） */
  position: relative;
}
.pane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-border);
  flex: 0 0 auto;
}
.pane__back {
  flex: 0 0 auto;
  margin-left: -10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.pane__back:active {
  background: var(--app-hover);
}
.pane__title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pane__title {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane__sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--app-text-muted);
}
.pane__more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.pane__more:hover {
  background: var(--app-hover);
}
.pane__scroll {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 16px 18px 8px;
  min-height: 0;
  /* 聊天背景图。--chat-canvas 是纯色底，--chat-canvas-image 由主题按 bgMode
   * 给出（纯色时为 none / 渐变时为 linear-gradient / 图片时为 url(...)）。
   * 两者必须成对出现：只吃纯色的话，自定义渐变/图片背景在有消息的会话里会消失。 */
  background-color: var(--chat-canvas);
  background-image: var(--chat-canvas-image);
}
.pane__loading {
  margin-bottom: 8px;
}
.pane__blank {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--app-text-faint);
  font-size: 13px;
}
.pane__row {
  position: relative;
}
.pane__retry {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 40px;
  margin-bottom: 10px;
  padding: 2px 8px;
  border: 1px solid var(--color-danger-500);
  border-radius: 4px;
  background: transparent;
  color: var(--color-danger-500);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

/* ── 置顶条（ux2-contract §九） ─────────────────────────────────────
 * 收起时只占一行（标题 + 计数），展开时列表内部滚动，最多到 168px —— 
 * 置顶再多也不能把消息区挤没，那等于用一个功能换掉另一个功能。
 * ------------------------------------------------------------------ */
.pane__pins {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}
.pane__pins-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 0 16px;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pane__pins-head:hover {
  background: var(--app-hover);
}
.pane__pins-head:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: -2px;
}
.pane__pins-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.pane__pins-caret {
  flex: 0 0 auto;
  transition: transform 0.15s ease;
}
.pane__pins--open .pane__pins-caret {
  transform: rotate(180deg);
}
.pane__pins-list {
  display: none;
  margin: 0;
  padding: 0 0 4px;
  list-style: none;
  max-height: 168px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.pane__pins--open .pane__pins-list {
  display: block;
}
.pane__pins-item {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 0 16px;
}
.pane__pin-btn {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-height: 30px;
  padding: 4px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pane__pin-btn:hover {
  background: var(--app-hover);
}
.pane__pin-btn:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: -2px;
}
.pane__pin-who {
  flex: 0 0 auto;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-faint);
}
.pane__pin-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane__pin-x {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
}
.pane__pin-x:hover {
  background: var(--app-hover);
  color: var(--color-danger-500);
}
.pane__pin-x:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}

/* 从置顶条跳转过来时的一次性高亮（1.6s 后由 JS 移除类） */
.pane__row--flash {
  animation: pane-flash 1.6s ease-out;
  border-radius: 8px;
}
@keyframes pane-flash {
  0%,
  55% {
    background: color-mix(in srgb, var(--color-brand-500) 22%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-brand-500) 40%, transparent);
  }
  100% {
    background: transparent;
    box-shadow: 0 0 0 2px transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pane__row--flash {
    animation-duration: 0.01s;
  }
}

/* 未读浮动入口：贴在输入区正上方的右下角，不遮挡最后一屏内容 */
.pane__jump {
  position: absolute;
  right: calc(18px + var(--safe-right));
  bottom: 76px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 32px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel);
  color: var(--color-brand-600);
  box-shadow: var(--shadow-pop);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background 0.15s ease,
    transform 0.12s ease;
}
.pane__jump:hover {
  background: var(--app-hover);
}
.pane__jump:active {
  transform: scale(0.96);
}
.pane__jump:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
.pane__jump-text {
  white-space: nowrap;
}
@media (max-width: 767px) {
  .pane__jump {
    right: calc(12px + var(--safe-right));
    bottom: calc(74px + var(--safe-bottom));
    height: var(--spacing-touch-target);
    border-radius: 22px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pane__jump {
    transition: none;
  }
}

/* ── 手机：安全区 + 更紧凑的左右留白 ─────────────────────────────── */
@media (max-width: 767px) {
  .pane__head {
    /* 无刘海时 env() = 0，不影响普通机型 */
    padding-top: calc(8px + var(--safe-top));
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
    gap: 6px;
  }
  .pane__scroll {
    padding: 12px calc(12px + var(--safe-right)) 6px calc(12px + var(--safe-left));
  }
  /* 置顶条跟着安全区走，且触控热区放大到 44px */
  .pane__pins-head {
    min-height: var(--spacing-touch-target);
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
    font-size: 13px;
  }
  .pane__pins-item {
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(8px + var(--safe-right));
  }
  .pane__pin-btn {
    min-height: var(--spacing-touch-target);
    font-size: 13px;
  }
  .pane__pin-x {
    width: var(--spacing-touch-target);
    height: 36px;
  }
}
</style>
