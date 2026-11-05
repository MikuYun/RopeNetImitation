<script setup lang="ts">
/**
 * 输入框（含 Markdown 工具条、预览态、多附件上传、拖拽、引用回复）。
 *
 * typing 上报节流（见 ws/constants.ts）：
 *   首次按键立即发 start；此后每 3s 最多再发一次 start；
 *   停手 5s 发 stop；发送消息 / 失焦 / 切换会话立即发 stop。
 * 这样既让对方能看见「正在输入」，又不会打成消息风暴。
 *
 * 【草稿】文本落进 ui store，而不是只存在组件局部 ref 里 —— 手机端列表与
 * 正文互斥渲染，从正文返回列表会卸载本组件；存局部变量的话，切出去看一眼
 * 再回来，打了一半的字就没了（任务书 §三「保留会话草稿」）。
 *
 * 【安全】预览用的是 MarkdownView（VNode 渲染），与消息气泡同一条链路，
 * 全程没有 v-html、没有 HTML 字符串中间态。
 *
 * ═════════════════════════════════════════════════════════════════════
 * 【v2 核心需求 4：多附件 + 对 Enter 的重新定义】
 *
 * 1) 从「单附件」到「附件队列」
 *    旧实现 `pendingAttachment = ref<Attachment|null>(null)`，选第二张图会
 *    `resetAttachment()` 把第一张**静默丢掉**。v2 一条消息可带 1..9 个附件，
 *    所以这里改成队列，每个 item 各自有上传进度/取消/失败重试态。
 *    「可发送的附件」= 队列里 state==='done' 的那些（`pendingAttachments`），
 *    仍在传的不算 —— 否则用户能在图还没传完时点发送，服务端收到空 id。
 *
 * 2) 为什么「有附件时 Enter 不发送」
 *    **不是**服务端限制 —— 服务端允许只有图片/文件、没有正文的消息（纯附件消息是
 *    一等公民）。这里拦 Enter 纯粹是**防误发**：用户选完图后手还在键盘上，
 *    很容易顺手一个 Enter 把「图 + 半句话」发出去，而附件消息发出去后撤回窗口只有
 *    120 秒。把 Enter 在「有待发送附件」时降级为换行，用户要发就点按钮或按
 *    Ctrl/⌘+Enter —— 多一个确认动作，少一批发错的消息。
 *    必须保留的逃生口：Ctrl/⌘+Enter **任何时候**都能发送（含带附件时）。
 *
 * 3) canSend 的两个来源
 *    有正文 **或** 有已就绪的附件都可发送；两者都没有才禁用。上传中的附件不算
 *    （见上一条），所以 `uploading` 仍然独立阻止发送。
 *    发送按钮的 disabled 只是**提示**，真正拦截在 submit() 里也再判一次。
 *
 * 4) 附件上限
 *    合计 ≤9、视频 ≤1。超限不静默丢弃（旧实现就是这么干的），一律 toast
 *    「最多 9 个附件，视频最多 1 个」告诉用户为什么没加进去。
 *
 * 5) 缩略图用**本地 File 的 objectURL**，不是服务端的 fetchObjectUrl
 *    文件就在内存里，转 blob URL 是零成本的；再去服务端取一遍纯属浪费一次
 *    往返，还要处理 401/网络失败。用完（移除/发送/卸载）必须 revoke。
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ComposerToolbar from '@/components/message/ComposerToolbar.vue'
import MarkdownView from '@/components/message/MarkdownView.vue'
import { useUiStore } from '@/stores/ui'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { wsClient } from '@/ws/client'
import { MESSAGE_TEXT_MAX, TYPING_IDLE_MS, TYPING_THROTTLE_MS } from '@/ws/constants'
import { applyCommand, type MarkdownCommand } from '@/components/message/markdownEditing'
import {
  MAX_ATTACHMENTS,
  MAX_VIDEO_ATTACHMENTS,
  attachmentKindOf,
  checkUploadFile,
  formatBytes,
  formatDuration,
  isImageAttachment,
  isVideoAttachment,
} from '@/utils/attachments'
import { uploadFile, revokeObjectUrl } from '@/api/uploads'
import type { ComposerSendPayload } from '@/components/message/composer'
import type { Attachment, AttachmentKind, ReplyRef } from '@/types/domain'

const props = defineProps<{
  conversationId: string
  disabled?: boolean
  /**
   * 当前引用回复的目标（由 MessagePane 传入 / 清除）。
   * 组件不自己持有它的最终状态：用户点「回复」是发生在气泡上的，
   * 那把状态放在两侧共同的父级（MessagePane）才不会出现两份真相。
   */
  replyTarget?: ReplyRef | null
}>()

const emit = defineEmits<{
  send: [ComposerSendPayload]
  /** 取消引用回复（父级负责把 replyTarget 清空）。 */
  cancelReply: []
}>()

const ui = useUiStore()
const { isMobile } = useBreakpoint()

/** 附件数量上限的统一提示文案（超限时 toast 用，和 utils 里的判定配套）。 */
const LIMIT_TEXT = `最多 ${MAX_ATTACHMENTS} 个附件，视频最多 ${MAX_VIDEO_ATTACHMENTS} 个`

/**
 * 输入缓冲。与 store 草稿单向同步：
 *   进入/切换会话时 store -> 本地；本地每次变化 -> store。
 * 不做双向绑定，避免每次按键都走一遍 Map 拷贝影响手感。
 */
const text = ref(ui.draftOf(props.conversationId))
const composing = ref(false)
let lastTypingSentAt = 0
let idleTimer: number | null = null
let isTyping = false

const textareaRef = ref<HTMLTextAreaElement | null>(null)
/**
 * 单一文件选择器，`accept` 在打开前按入口动态改写（图片 / 视频 / 文件）。
 *
 * 【为什么只留一个 input】三个常驻 router 的 input 会让「上一次选的文件、
 * 上一次的 accept」出现残留竞态；而 accept 本身只是个 *建议*，用户仍可在
 * 系统选择器里切到「所有文件」，真正的裁决在后端白名单 + checkUploadFile，
 * 所以这里不需要靠 accept 保证安全。
 *
 * 【为什么必须 multiple】v2 支持一次选 9 张图。旧的单文件实现（index 0）
 * 会让用户在系统选择器里框选多张后只发出去第一张，且没有任何提示。
 */
const fileInputRef = ref<HTMLInputElement | null>(null)

/**
 * 预览态：把 textarea 换成渲染结果（textarea 用 v-show 保留在 DOM，草稿不丢）。
 *
 * 【为什么预览态也要跟着草稿走】任务要求「草稿保存文本 + 是否预览态」：
 * 用户写到一半切去看别的会话、再切回来，如果预览态被重置成编辑态，
 * 就会出现「我明明在预览里」的认知断裂。`ui.drafts` 是 `Map<string,string>`
 * （stores 属别人所有权、只能是 string），所以预览态放在这个模块级 Map 里，
 * 与草稿同生命周期：按 conversationId 存取，组件卸载也不丢。
 */
const previewByConv = new Map<string, boolean>()
const preview = ref(previewByConv.get(props.conversationId) ?? false)

watch(preview, (v) => {
  previewByConv.set(props.conversationId, v)
})

/* ── 待发送附件队列 ───────────────────────────────────────────── */

interface PendingUpload {
  /** 队列内唯一键（File 没有稳定 id，用自增序号）。 */
  key: string
  /** 原始 File：重试时直接用，不必让用户重新选。 */
  file: File
  name: string
  size: number
  kind: AttachmentKind
  state: 'uploading' | 'done' | 'failed'
  /** 0..1；仅 uploading 时有意义。 */
  ratio: number
  /** 上传成功后的服务端附件（state==='done' 时非空）。 */
  attachment: Attachment | null
  /** 本地缩略图 / 视频首帧的 blob URL（用后 revoke）。 */
  localUrl: string | null
  /** 视频时长（秒），拿不到就是 null。 */
  duration: number | null
  controller: AbortController | null
}

const queue = reactive<PendingUpload[]>([])
let queueSeq = 0

/** 可发送的附件（= 已上传完成）。上传中的绝不放进去。 */
const pendingAttachments = computed<Attachment[]>(() =>
  queue.filter((q) => q.state === 'done' && q.attachment).map((q) => q.attachment as Attachment),
)

const hasAttachments = computed(() => queue.length > 0)
const uploading = computed(() => queue.some((q) => q.state === 'uploading'))
/** 总进度文案用：「已完成 n / 共 m」。 */
const doneCount = computed(() => pendingAttachments.value.length)
const totalCount = computed(() => queue.length)

function releaseLocalUrl(item: PendingUpload): void {
  revokeObjectUrl(item.localUrl)
  item.localUrl = null
}

function removeQueueItem(key: string): void {
  const idx = queue.findIndex((q) => q.key === key)
  if (idx < 0) return
  const [item] = queue.splice(idx, 1)
  if (!item) return
  item.controller?.abort()
  releaseLocalUrl(item)
}

/** 清空整个队列（发送成功 / 切换会话 / 卸载）。 */
function resetAttachments(): void {
  for (const item of queue) {
    item.controller?.abort()
    releaseLocalUrl(item)
  }
  queue.splice(0, queue.length)
}

/**
 * 拖拽高亮（整块输入区接收文件）。
 *
 * dragDepth 计数是必要的：dragenter/dragleave 会在子元素之间反复冒泡，
 * 只看单个事件会让遮罩疯狂闪烁。
 */
const dragging = ref(false)
let dragDepth = 0

/**
 * 切换会话：先把旧会话的草稿落定，再载入新会话的草稿。
 * 附件属于「当前这次编辑」，切会话必须清掉 —— 否则会把 A 会话选好的图片
 * 带到 B 会话发出去。预览态则与会话草稿一起保存/恢复。
 */
watch(
  () => props.conversationId,
  (id, prevId) => {
    stopTyping()
    if (prevId) {
      ui.setDraft(prevId, text.value)
      previewByConv.set(prevId, preview.value)
    }
    text.value = ui.draftOf(id)
    // 只有草稿非空时才恢复预览态：空草稿进预览是一片空白，反而是干扰
    preview.value = text.value.trim().length > 0 && (previewByConv.get(id) ?? false)
    resetAttachments()
  },
)

// 本地变化 → 写回 store
watch(text, (v) => {
  ui.setDraft(props.conversationId, v)
})

const trimmed = computed(() => text.value.trim())

/**
 * 能否发送：**有文字或有已就绪的附件**，二者其一即可。
 *
 * 纯图片/纯文件消息是被支持的发送方式（不需要配文字）。只有「一个字都没有、
 * 也没有任何已上传完成的附件」时才禁用 —— 这种消息服务端会以
 * 「消息内容不能为空」拒绝，前端先行拦住省一次往返。
 *
 * 仍然要求 `!uploading`：只要队列里还有上传中的条目就整体禁用，
 * 否则用户能点发送而服务端收到的是残缺/空的 attachmentIds。
 */
const canSend = computed(
  () =>
    (trimmed.value.length > 0 || pendingAttachments.value.length > 0) &&
    !props.disabled &&
    !uploading.value &&
    queue.length <= MAX_ATTACHMENTS,
)

const overLimit = computed(() => text.value.length > MESSAGE_TEXT_MAX)
const nearLimit = computed(() => text.value.length > MESSAGE_TEXT_MAX * 0.9)
/** 有 Markdown 标记才值得开预览；纯文本开预览与直接看输入框无异。 */
const canPreview = computed(() => trimmed.value.length > 0)

const placeholder = computed(() => {
  if (props.disabled) return '连接中断，恢复后可继续输入'
  if (hasAttachments.value) {
    // 有附件时 Enter 只换行（见文件头第 2 条），提示必须同步改口，
    // 否则用户会按 Enter 期待发送、实际只换行，以为输入框坏了。
    return isMobile.value
      ? '可以只发图片/文件，也可以补充文字，点右侧按钮发送'
      : '可只发图片/文件，也可补充文字；Enter 换行，Ctrl/⌘+Enter 发送'
  }
  return isMobile.value
    ? '输入消息（支持 Markdown），点右侧按钮发送'
    : '输入消息，支持 **Markdown**，Enter 发送，Shift+Enter 换行'
})

/** 发送按钮/输入框的补充说明（aria-describedby 指向它）。 */
const sendHintId = 'composer-send-hint'
const sendHint = computed(() => {
  if (props.disabled) return '连接中断，暂时无法发送'
  if (uploading.value) return '附件正在上传，完成后再发送'
  if (overLimit.value) return `超出 ${MESSAGE_TEXT_MAX} 字上限，请删减后再发送`
  return ''
})

// ── typing 节流 ──────────────────────────────────────────────────────
function stopTyping(): void {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer)
    idleTimer = null
  }
  if (isTyping) {
    isTyping = false
    wsClient.send('typing', { conversationId: props.conversationId, active: false })
  }
}

function notifyTyping(): void {
  const now = Date.now()
  if (!isTyping || now - lastTypingSentAt >= TYPING_THROTTLE_MS) {
    isTyping = true
    lastTypingSentAt = now
    wsClient.send('typing', { conversationId: props.conversationId, active: true })
  }
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(stopTyping, TYPING_IDLE_MS)
}

function onInput(): void {
  if (composing.value) return
  autoGrow()
  if (trimmed.value.length === 0) {
    stopTyping()
    return
  }
  notifyTyping()
}

/** 中文输入法：组字期间不触发 typing，组字结束再补一次。 */
function onCompositionStart(): void {
  composing.value = true
}

function onCompositionEnd(): void {
  composing.value = false
  onInput()
}

// ── 自适应高度（上限由 CSS max-height 兜住，超出滚动） ─────────────────
function autoGrow(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`
}

// ── Markdown 工具条 ──────────────────────────────────────────────────
function onFormat(command: MarkdownCommand): void {
  const el = textareaRef.value
  const state = {
    text: text.value,
    selectionStart: el?.selectionStart ?? text.value.length,
    selectionEnd: el?.selectionEnd ?? text.value.length,
  }
  const result = applyCommand(state, command)
  text.value = result.text
  if (preview.value) preview.value = false
  // 等 v-model 写回 DOM 后再恢复选区，否则 selectionStart 会被重置到末尾
  void nextTick(() => {
    const node = textareaRef.value
    if (!node) return
    node.focus()
    node.setSelectionRange(result.selectionStart, result.selectionEnd)
    autoGrow()
  })
}

// ── 附件入口 ─────────────────────────────────────────────────────────

/**
 * 打开系统文件选择器。
 *
 * accept 只是**建议**：安卓/iOS 多数实现允许用户切到「所有文件」，
 * 因此真正的类型裁决必须在 checkUploadFile（以及后端白名单）里做。
 */
function openPicker(accept: string): void {
  if (props.disabled) return
  const input = fileInputRef.value
  if (!input) return
  input.accept = accept
  input.click()
}

function pickImage(): void {
  openPicker('image/*')
}

function pickVideo(): void {
  // v2.3：不再限死 mp4/webm 两个 mime。选了浏览器不能播的容器（avi/mkv 等）
  // 也不至于发不出去 —— 服务端按魔数收下，附件卡片退化成下载入口。
  openPicker('video/*')
}

function pickFile(): void {
  openPicker('')
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  // 允许连续两次选同一个文件：不清空的话 change 不再触发
  input.value = ''
  if (files.length > 0) addFiles(files)
}

/**
 * 把一批文件加进队列并开始上传。
 *
 * 校验顺序刻意分成「能全拦的都先拦」：
 *   1. 单个文件（空文件 / 类型 / 大小）—— checkUploadFile，失败逐个提示；
 *   2. 数量上限（合计 9、视频 1）—— 超了就 toast 一句并**停止继续加**，
 *      不做「加一部分」：用户一次拖 12 张过来，得到 9 张 + 一句提示比得到
 *      12 张里随机 9 张更好理解。
 */
function addFiles(files: File[]): void {
  if (props.disabled) {
    ui.toast('连接中断，恢复后再试', 'error')
    return
  }
  if (files.length === 0) return

  const accepted: File[] = []
  // 用「当前队列 + 已接受的」推演，避免并发选择时超限
  let total = queue.length
  let videos = queue.filter((q) => q.kind === 'video').length

  for (const file of files) {
    const check = checkUploadFile(file)
    if (!check.ok) {
      ui.toast(check.message, 'error')
      continue
    }
    const kind = attachmentKindOf(file.type, file.name)
    const nextVideos = videos + (kind === 'video' ? 1 : 0)
    if (total + 1 > MAX_ATTACHMENTS || nextVideos > MAX_VIDEO_ATTACHMENTS) {
      ui.toast(LIMIT_TEXT, 'error')
      break
    }
    accepted.push(file)
    total += 1
    videos = nextVideos
  }

  for (const file of accepted) void startUpload(file)
}

/** 单个文件入库 + 上传。失败只把该条标红，不影响其它附件。 */
async function startUpload(file: File): Promise<void> {
  const kind = attachmentKindOf(file.type, file.name)
  queueSeq += 1
  const item: PendingUpload = {
    key: `att-${queueSeq}`,
    file,
    name: file.name || (kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'),
    size: file.size,
    kind,
    state: 'uploading',
    ratio: 0,
    attachment: null,
    // 本地 File 直接转 blob URL：缩略图/视频首帧立刻可见，零往返
    localUrl: URL.createObjectURL(file),
    duration: null,
    controller: new AbortController(),
  }
  queue.push(item)
  /*
   * 【必须把 item 换成队列里的那个响应式代理，不能继续用上面的原始对象】
   *
   * `queue` 是 `reactive([])`，push 进去的是**原始对象**；模板 v-for 读到的
   * 是 Vue 为它生成的 Proxy。此后所有 `item.state = 'done'` / `item.ratio = p`
   * 都写在原始对象上，Proxy 的 set 陷阱没被经过 ⇒ 不触发依赖更新 ⇒ 界面永远停在
   * 「上传中 0%」且发送按钮永久 disabled，直到用户再敲一个字导致父级重渲染，
   * 才会通过 Proxy 读到已更新的原始值（表现为「打字后突然就绪」）。
   *
   * 这个 bug 在 e2e-attachment 上暴露过：上传接口 201 已返回，`composer__att--uploading`
   * 却 20s 不消失。取回队列末尾元素即是 Proxy，后续赋值才会正常触发渲染。
   */
  const live = queue[queue.length - 1] as PendingUpload
  await runUpload(live)
}

/** 真正执行一次上传（首发与重试共用）。 */
async function runUpload(item: PendingUpload): Promise<void> {
  item.state = 'uploading'
  item.ratio = 0
  item.attachment = null
  item.controller = new AbortController()
  const controller = item.controller
  try {
    const att = await uploadFile(item.file, {
      signal: controller.signal,
      onProgress: (p) => {
        item.ratio = p.ratio
      },
    })
    if (controller.signal.aborted) return
    item.attachment = att
    item.state = 'done'
    item.ratio = 1
    item.controller = null
    ui.toast(
      isImageAttachment(att)
        ? '图片已就绪，可发送'
        : isVideoAttachment(att)
          ? '视频已就绪，可发送'
          : '文件已就绪，可发送',
      'info',
    )
  } catch {
    if (controller.signal.aborted) {
      // 用户主动取消：整条从队列里去掉，不留一个红色失败卡
      removeQueueItem(item.key)
      return
    }
    item.state = 'failed'
    item.attachment = null
    item.controller = null
    ui.toast(`「${item.name}」上传失败，可点重试`, 'error')
  }
}

/** 取消某一条（等价于移除；请求会被 abort）。 */
function cancelUpload(key: string): void {
  removeQueueItem(key)
}

/** 重试某一条失败的上传。File 还在手里，直接重发，不必让用户重选。 */
function retryUpload(key: string): void {
  const item = queue.find((q) => q.key === key)
  if (!item || item.state !== 'failed') return
  void runUpload(item)
}

// ── 拖拽 ─────────────────────────────────────────────────────────────
function onDragEnter(e: DragEvent): void {
  if (props.disabled) return
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth += 1
  dragging.value = true
}

function onDragOver(e: DragEvent): void {
  if (props.disabled) return
  if (!e.dataTransfer?.types.includes('Files')) return
  // 必须阻止默认才允许 drop（否则浏览器会直接打开文件）
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  if (props.disabled) return
  // v2：拖进来几个文件就收几个（旧实现只取 files[0]，其余静默丢弃）
  const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
  if (files.length === 0) return
  e.preventDefault()
  addFiles(files)
}

/**
 * 粘贴文件。
 *
 * 剪贴板里可能有多张截图（例如从聊天工具里一次复制多图）。
 * 旧实现只处理第一张 image/*，其余全部丢掉。
 *
 * 注意 `clipboardData.files` 在部分浏览器里对「复制的文件」才有值，
 * 截图通常要通过 `items` 的 getAsFile() 取，所以两条路都要走。
 */
function onPaste(e: ClipboardEvent): void {
  if (props.disabled) return
  const dt = e.clipboardData
  if (!dt) return

  const files: File[] = []
  const direct = dt.files ? Array.from(dt.files) : []
  if (direct.length > 0) files.push(...direct)
  if (files.length === 0 && dt.items) {
    for (const item of dt.items) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length === 0) return
  // 有文件才 preventDefault：普通文本粘贴必须保持默认行为
  e.preventDefault()
  addFiles(files)
}

/** 视频首帧时长（待发送卡上显示）。不做 canvas 截帧，只读 metadata。 */
function onLocalVideoMeta(item: PendingUpload, e: Event): void {
  const el = e.target as HTMLVideoElement | null
  const d = el?.duration
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) item.duration = d
}

// ── 发送 ─────────────────────────────────────────────────────────────

/**
 * 提交。
 *
 * 【关键修复：content 永远带上】旧实现有附件的分支只发 `{clientMsgId,
 * attachmentId}`，把用户打的文字整段丢了（用户原话「文字被吞」）。
 * v2 契约本来就是 content + attachmentIds 并存，这里必须两个都发。
 */
function submit(): void {
  if (!canSend.value || overLimit.value) return
  const payload: ComposerSendPayload = {
    content: trimmed.value,
    attachments: pendingAttachments.value.slice(),
    replyToMsgId: props.replyTarget?.msgId ?? null,
  }
  emit('send', payload)
  text.value = ''
  ui.clearDraft(props.conversationId)
  resetAttachments()
  preview.value = false
  stopTyping()
  void nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto'
      textareaRef.value.focus()
    }
  })
}

function togglePreview(): void {
  if (!canPreview.value && !preview.value) return
  preview.value = !preview.value
  if (!preview.value) {
    void nextTick(() => textareaRef.value?.focus())
  }
}

/**
 * 键盘行为（v2）：
 *   - 有附件 → Enter **不发送**，只换行（原因见文件头第 2 条）；
 *   - 无附件 + 桌面 → Enter 发送；Shift+Enter 换行；
 *   - 手机 → Enter 一律换行（软键盘没有 Shift，统一走显式发送键）；
 *   - Ctrl/⌘+Enter → **任何情况**都发送（含带附件、含手机）。
 *
 * 两端都保留 IME composition 保护：中文选词确认那一下的 Enter 不是发送。
 * 另加 Ctrl/⌘ + B/I/E/K 走工具条命令（浏览器默认 Ctrl+B 是书签栏之类，
 * 需 preventDefault）。
 */
function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey

  if (mod && !e.altKey && e.key !== 'Enter') {
    const key = e.key.toLowerCase()
    const shortcut: Record<string, MarkdownCommand> = {
      b: 'bold',
      i: 'italic',
      e: 'inline-code',
      k: 'link',
    }
    const command = shortcut[key]
    if (command) {
      e.preventDefault()
      onFormat(command)
      return
    }
  }

  if (e.key !== 'Enter') return
  if (composing.value) return

  // Ctrl/⌘+Enter：强制发送逃生口（必须在「有附件不发送」之前判定）
  if (mod && !e.altKey) {
    e.preventDefault()
    submit()
    return
  }

  // 有附件：Enter 只换行，绝不发送（防误发半成品，见文件头第 2 条）
  // 【不要 preventDefault】
  // 这里原本是 `e.preventDefault(); return`，结果 Enter 被完全吃掉 ——
  // 既不发送也不换行，用户按 Enter 毫无反应（e2e-v2 实测：textarea 里
  // 按完 Enter 仍不含 \n）。只有让默认行为跑完，Enter 才是「换行」。
  if (hasAttachments.value) return

  if (isMobile.value) return
  if (e.shiftKey) return
  e.preventDefault()
  submit()
}

onUnmounted(() => {
  stopTyping()
  resetAttachments()
})

defineExpose({ stopTyping })
</script>

<template>
  <footer
    class="composer"
    :class="{ 'composer--dragging': dragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 拖拽遮罩 -->
    <div v-if="dragging" class="composer__drop" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>松手即可上传（图片/文件 ≤10 MB，视频 ≤100 MB）</span>
    </div>

    <div v-if="nearLimit" class="composer__limit" :class="{ 'composer__limit--over': overLimit }">
      {{ text.length }} / {{ MESSAGE_TEXT_MAX }}
    </div>

    <!--
      引用回复预览条：显示被引用的对象 + 取消。
      「回复」动作发生在气泡上，状态却要在这里体现，所以有两处入口
      （气泡菜单 / 气泡引用条），唯一真相在 MessagePane。
    -->
    <div v-if="replyTarget" class="composer__reply">
      <span class="composer__reply-body">
        <span class="composer__reply-tag">回复 {{ replyTarget.senderName }}</span>
        <span class="composer__reply-text">{{ replyTarget.preview }}</span>
      </span>
      <button
        class="composer__reply-x"
        type="button"
        title="取消引用"
        aria-label="取消引用回复"
        @click="emit('cancelReply')"
      >
        <AppIcon name="close" :size="13" />
      </button>
    </div>

    <!--
      待发送附件列表。
      role="list" 让屏幕阅读器能报「第 n 项，共 m 项」；每个删除按钮都有
      aria-label（只写「删除」在列表里等于没写，无法区分删的是哪一个）。
    -->
    <div v-if="queue.length > 0" class="composer__atts" role="list" aria-label="待发送附件">
      <div
        v-for="item in queue"
        :key="item.key"
        class="composer__att"
        :class="`composer__att--${item.state}`"
        role="listitem"
      >
        <!-- 图片：本地 blob 缩略图，选完立刻能核对「我选的是不是这张」 -->
        <img
          v-if="item.kind === 'image' && item.localUrl"
          class="composer__att-thumb"
          :src="item.localUrl"
          :alt="item.name"
          decoding="async"
        />
        <!-- 视频：用 <video> 的 metadata 首帧当封面（不做 canvas 截帧） -->
        <video
          v-else-if="item.kind === 'video' && item.localUrl"
          class="composer__att-thumb composer__att-thumb--video"
          :src="item.localUrl"
          preload="metadata"
          muted
          playsinline
          :aria-label="item.name"
          @loadedmetadata="onLocalVideoMeta(item, $event)"
        ></video>
        <!-- 文件：图标（AppIcon 的 name 联合里没有通用 file，用内联 SVG） -->
        <span v-else class="composer__att-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>

        <span class="composer__att-main">
          <span class="composer__att-name" :title="item.name">{{ item.name }}</span>
          <span class="composer__att-size">
            {{ formatBytes(item.size) }}
            <template v-if="item.kind === 'video' && item.duration">
              · {{ formatDuration(item.duration) }}
            </template>
            <template v-if="item.state === 'uploading'">
              · 上传中 {{ Math.round(item.ratio * 100) }}%
            </template>
            <template v-else-if="item.state === 'failed'"> · 上传失败</template>
          </span>
          <span
            v-if="item.state === 'uploading'"
            class="composer__att-track"
            role="progressbar"
            :aria-label="`${item.name} 上传进度`"
            :aria-valuenow="Math.round(item.ratio * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span
              class="composer__att-fill"
              :style="{ width: `${Math.max(4, Math.round(item.ratio * 100))}%` }"
            />
          </span>
        </span>

        <button
          v-if="item.state === 'failed'"
          class="composer__att-retry"
          type="button"
          :aria-label="`重试上传 ${item.name}`"
          @click="retryUpload(item.key)"
        >
          重试
        </button>
        <button
          class="composer__att-x"
          type="button"
          :title="item.state === 'uploading' ? '取消上传' : '移除附件'"
          :aria-label="item.state === 'uploading' ? `取消上传 ${item.name}` : `移除附件 ${item.name}`"
          @click="cancelUpload(item.key)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </div>
    </div>

    <!-- 总进度：多附件时用户需要知道「还差几个」，单个进度条不够 -->
    <div v-if="uploading" class="composer__att-total" aria-live="polite">
      已完成 {{ doneCount }} / 共 {{ totalCount }}
    </div>

    <ComposerToolbar
      :preview="preview"
      :uploading="uploading"
      :disabled="disabled"
      @format="onFormat"
      @toggle-preview="togglePreview"
      @pick-image="pickImage"
      @pick-video="pickVideo"
      @pick-file="pickFile"
    />

    <!-- 预览态：Markdown → VNode（与消息气泡同一渲染器，无 v-html） -->
    <div v-if="preview" class="composer__preview">
      <MarkdownView :source="text" />
    </div>

    <!-- textarea 用 v-show 保留在 DOM：切换预览不丢草稿与光标 -->
    <textarea
      v-show="!preview"
      ref="textareaRef"
      v-model="text"
      class="composer__input"
      :placeholder="placeholder"
      :aria-describedby="sendHintId"
      rows="3"
      :disabled="disabled"
      @input="onInput"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="stopTyping"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
    />

    <!--
      单一文件选择器：multiple 让用户能一次选多张（v2 多附件）。
      accept 在打开前按入口动态改写（图片/视频/文件），见 openPicker()。
      保持 1px 隐藏 + tabindex=-1（不能用 display:none，某些浏览器对
      display:none 的 input 调用 click() 不弹选择器）。
    -->
    <input
      ref="fileInputRef"
      class="composer__file"
      type="file"
      multiple
      tabindex="-1"
      aria-hidden="true"
      accept="image/*,video/*,audio/*,.pdf,.zip,.rar,.7z,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.csv"
      @change="onFileChange"
    />

    <div class="composer__bar">
      <span class="composer__hint">{{
        isMobile ? 'Enter 换行 · 点右侧发送' : 'Enter 发送 · Shift+Enter 换行'
      }}</span>
      <button
        class="composer__send"
        type="button"
        :disabled="!canSend || overLimit"
        :aria-describedby="sendHintId"
        :title="sendHint || '发送'"
        aria-label="发送"
        @click="submit"
      >
        <AppIcon name="send" :size="17" />
      </button>
    </div>

    <!-- 无障碍提示：aria-describedby 指向这里，读屏软件会一并读出原因 -->
    <span :id="sendHintId" class="composer__sr" aria-live="polite">{{ sendHint }}</span>
  </footer>
</template>

<style scoped>
.composer {
  position: relative;
  flex: 0 0 auto;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel);
  padding: 8px 12px 10px;
  /* 底部手势条不遮住发送键；无刘海设备上 env() = 0 */
  padding-bottom: calc(10px + var(--safe-bottom));
  padding-left: calc(12px + var(--safe-left));
  padding-right: calc(12px + var(--safe-right));
  transition: box-shadow 0.15s ease;
}

/* 拖拽中：整块输入区描边 + 遮罩，明确「松手就上传」 */
.composer--dragging {
  box-shadow: inset 0 0 0 2px var(--color-brand-500);
}

.composer__drop {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: inherit;
  background: color-mix(in srgb, var(--app-panel) 88%, var(--color-brand-500));
  color: var(--color-brand-600);
  font-size: 13px;
  pointer-events: none;
}

.composer__limit {
  position: absolute;
  top: -20px;
  right: 16px;
  font-size: 11px;
  color: var(--app-text-muted);
  background: var(--app-panel);
  padding: 1px 6px;
  border-radius: 3px;
}
.composer__limit--over {
  color: var(--color-danger-500);
}

/* ── 引用回复预览条 ── */
.composer__reply {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 6px 5px 9px;
  border-left: 2px solid var(--color-brand-500);
  border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--color-brand-500) 9%, transparent);
}
.composer__reply-body {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  font-size: 12px;
  color: var(--app-text-muted);
}
.composer__reply-tag {
  flex: 0 0 auto;
  font-weight: var(--weight-medium, 500);
  color: var(--color-brand-600, var(--app-text));
}
.composer__reply-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer__reply-x {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.composer__reply-x:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

/* ── 待发送附件队列 ── */
.composer__atts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.composer__att {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: min(260px, 100%);
  padding: 5px 6px 5px 7px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel-alt);
}
.composer__att--failed {
  border-color: color-mix(in srgb, var(--color-danger-500) 45%, var(--app-border));
}
.composer__att-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}
.composer__att-name {
  font-size: 12px;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 150px;
}
.composer__att-size {
  font-size: 11px;
  color: var(--app-text-faint);
  white-space: nowrap;
}
.composer__att-thumb {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 5px;
  object-fit: cover;
  background: var(--app-active);
  border: 1px solid var(--app-border);
}
.composer__att-thumb--video {
  /* 视频首帧常是黑的，加个底色让边框可见 */
  background: var(--color-ink-900);
}
.composer__att-icon {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-text-muted);
}
.composer__att-track {
  display: block;
  width: 100%;
  height: 3px;
  min-width: 40px;
  margin-top: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text) 14%, transparent);
  overflow: hidden;
}
.composer__att-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-500);
  transition: width 0.15s linear;
}
.composer__att-x {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.composer__att-x:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.composer__att-retry {
  flex: 0 0 auto;
  padding: 2px 8px;
  min-height: 24px;
  border: 1px solid color-mix(in srgb, var(--color-danger-500) 45%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--color-danger-500);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.composer__att-total {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--app-text-faint);
}

/* ── 预览态 ── */
.composer__preview {
  min-height: 74px;
  max-height: 240px;
  overflow-y: auto;
  padding: 2px 0 6px;
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.6;
}

.composer__input {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--app-text);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.6;
  max-height: 140px;
  overflow-y: auto;
}
.composer__input::placeholder {
  color: var(--app-text-faint);
}

/* 原生 file input 只作为触发入口，绝不露出来 */
.composer__file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* 只给屏幕阅读器的状态文案（视觉上不可见，但可被 aria-describedby 读到） */
.composer__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  gap: 8px;
}
.composer__hint {
  font-size: 11px;
  color: var(--app-text-faint);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer__send {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: var(--color-brand-500);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s ease;
}
.composer__send:hover:not(:disabled) {
  background: var(--color-brand-600);
}
.composer__send:disabled {
  background: var(--app-active);
  color: var(--app-text-faint);
  cursor: not-allowed;
}

/* ── 手机 ─────────────────────────────────────────────────────────── */
@media (max-width: 767px) {
  .composer__input {
    /* >=16px 避免 iOS Safari 聚焦时自动放大整个页面 */
    font-size: var(--font-input-mobile);
  }
  .composer__preview {
    font-size: var(--font-input-mobile);
    max-height: 200px;
  }
  .composer__send {
    /* 触控热区 44x44；图标仍是 17px，靠尺寸撑开可点区域 */
    width: var(--spacing-touch-target);
    height: var(--spacing-touch-target);
    border-radius: 8px;
  }
  .composer__hint {
    font-size: 12px;
  }
  .composer__att {
    min-height: 44px;
    max-width: 100%;
  }
  .composer__att-x {
    width: var(--spacing-touch-target);
    height: 32px;
  }
  .composer__att-retry {
    min-height: 32px;
  }
}
</style>
