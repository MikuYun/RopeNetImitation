<script setup lang="ts">
/**
 * 输入框（含 Markdown 工具条、预览态、附件上传、拖拽）。
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
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ComposerToolbar from '@/components/message/ComposerToolbar.vue'
import MarkdownView from '@/components/message/MarkdownView.vue'
import { useUiStore } from '@/stores/ui'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { wsClient } from '@/ws/client'
import { MESSAGE_TEXT_MAX, TYPING_IDLE_MS, TYPING_THROTTLE_MS } from '@/ws/constants'
import { applyCommand, type MarkdownCommand } from '@/components/message/markdownEditing'
import { checkUploadFile, formatBytes, isImageAttachment } from '@/utils/attachments'
import { uploadFile, fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import type { ComposerSendPayload } from '@/components/message/composer'
import type { Attachment } from '@/types/domain'

const props = defineProps<{ conversationId: string; disabled?: boolean }>()
const emit = defineEmits<{ send: [ComposerSendPayload] }>()

const ui = useUiStore()
const { isMobile } = useBreakpoint()

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
 * 两个独立的文件选择器（ux2-contract §十二）：
 *   - imageInputRef：`accept` 只列图片 MIME，**不加 capture** —— 加了 capture
 *     会把手机直接锁进相机，用户就没法从相册选图；
 *   - fileInputRef：不限制 accept，选什么由后端白名单裁决。
 * 合并成一个的话，图片入口的 accept 会被文件需求污染，用户也分不清自己在发什么。
 */
const imageInputRef = ref<HTMLInputElement | null>(null)
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

/** 待发送附件。上传成功才允许发送；上传中显示进度，可取消。 */
const pendingAttachment = ref<Attachment | null>(null)
const uploading = ref(false)
const uploadRatio = ref(0)
let uploadController: AbortController | null = null

/**
 * 待发送图片的缩略图（blob URL）。
 *
 * 【为什么必须在待发送区就把图显示出来】用户从相册选了一张图，如果待发送区
 * 只写「IMG_0042.jpg · 2.3 MB」，他无法确认「我选的是不是那张」—— 发错图的
 * 代价是发出去就收不回。有了缩略图，选完立刻能核对。
 *
 * 走 blob URL 而不是 attachment.url：`GET /api/v1/uploads/:id` 需要 Bearer，
 * `<img src>` 带不了头（详见 AttachmentView 顶部说明）。用完必须 revoke。
 */
const pendingThumbUrl = ref<string | null>(null)
let thumbController: AbortController | null = null

function releasePendingThumb(): void {
  revokeObjectUrl(pendingThumbUrl.value)
  pendingThumbUrl.value = null
}

watch(pendingAttachment, async (att) => {
  thumbController?.abort()
  thumbController = null
  releasePendingThumb()
  if (!att || !isImageAttachment(att)) return
  const controller = new AbortController()
  thumbController = controller
  try {
    const url = await fetchObjectUrl(att, controller.signal)
    if (controller.signal.aborted) {
      revokeObjectUrl(url)
      return
    }
    pendingThumbUrl.value = url
  } catch {
    // 缩略图拿不到不影响发送：待发送区仍有文件名与大小
  }
})

/** 拖拽高亮（整块输入区接收文件）。 */
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
    resetAttachment()
  },
)

// 本地变化 → 写回 store
watch(text, (v) => {
  ui.setDraft(props.conversationId, v)
})

const trimmed = computed(() => text.value.trim())
const canSend = computed(
  () => (trimmed.value.length > 0 || !!pendingAttachment.value) && !props.disabled && !uploading.value,
)
const overLimit = computed(() => text.value.length > MESSAGE_TEXT_MAX)
const nearLimit = computed(() => text.value.length > MESSAGE_TEXT_MAX * 0.9)
/** 有 Markdown 标记才值得开预览；纯文本开预览与直接看输入框无异。 */
const canPreview = computed(() => trimmed.value.length > 0)

const placeholder = computed(() => {
  if (props.disabled) return '连接中断，恢复后可继续输入'
  return isMobile.value
    ? '输入消息（支持 Markdown），点右侧按钮发送'
    : '输入消息，支持 **Markdown**，Enter 发送，Shift+Enter 换行'
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

// ── 附件 ─────────────────────────────────────────────────────────────
function resetAttachment(): void {
  uploadController?.abort()
  uploadController = null
  thumbController?.abort()
  thumbController = null
  releasePendingThumb()
  uploading.value = false
  uploadRatio.value = 0
  pendingAttachment.value = null
}

/** 「图片」入口：只接受图片，选完直接进待发送区（缩略图）。 */
function pickImage(): void {
  if (props.disabled || uploading.value) return
  imageInputRef.value?.click()
}

/** 「文件」入口：不限类型。 */
function pickFile(): void {
  if (props.disabled || uploading.value) return
  fileInputRef.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许连续两次选同一个文件：不清空的话 change 不再触发
  input.value = ''
  if (file) void startUpload(file)
}

async function startUpload(file: File): Promise<void> {
  // 前端先拦：>10MiB / 空文件不必占一次往返
  const check = checkUploadFile(file)
  if (!check.ok) {
    ui.toast(check.message, 'error')
    return
  }
  if (props.disabled) {
    ui.toast('连接中断，恢复后再试', 'error')
    return
  }
  resetAttachment()
  uploading.value = true
  uploadRatio.value = 0
  const controller = new AbortController()
  uploadController = controller
  try {
    const att = await uploadFile(file, {
      signal: controller.signal,
      onProgress: (p) => {
        uploadRatio.value = p.ratio
      },
    })
    if (controller.signal.aborted) return
    pendingAttachment.value = att
    ui.toast(isImageAttachment(att) ? '图片已就绪，可发送' : '文件已就绪，可发送', 'info')
  } catch {
    if (!controller.signal.aborted) ui.toast('上传失败，请重试', 'error')
  } finally {
    if (uploadController === controller) {
      uploading.value = false
      uploadController = null
    }
  }
}

function cancelUpload(): void {
  uploadController?.abort()
  uploadController = null
  uploading.value = false
  uploadRatio.value = 0
}

function removeAttachment(): void {
  resetAttachment()
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
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  e.preventDefault()
  void startUpload(file)
}

/** 粘贴截图：剪贴板里有图片时直接当附件上传。 */
function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    e.preventDefault()
    void startUpload(file)
    return
  }
}

// ── 发送 ─────────────────────────────────────────────────────────────
function submit(): void {
  if (!canSend.value || overLimit.value) return
  const payload: ComposerSendPayload = { content: trimmed.value }
  if (pendingAttachment.value) payload.attachment = pendingAttachment.value
  emit('send', payload)
  text.value = ''
  ui.clearDraft(props.conversationId)
  resetAttachment()
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
 * 键盘行为按端区分（任务书 R3）：
 *   - 桌面：Enter 发送，Shift+Enter 换行
 *   - 手机：Enter **换行**，靠显式发送键发送。手机软键盘上 Shift+Enter 不可用，
 *     沿用桌面行为的话用户想换行只能按发送，会误发半截消息。
 *
 * 两端都保留 IME composition 保护：中文选词确认那一下的 Enter 不是发送。
 * 另加 Ctrl/⌘ + B/I/E/K 走工具条命令（浏览器默认加粗在本 textarea 上无效，
 * 但 Ctrl+B 在浏览器里是「打开书签栏」之类，需 preventDefault）。
 */
function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey) {
    const key = e.key.toLowerCase()
    const shortcut: Record<string, MarkdownCommand> = { b: 'bold', i: 'italic', e: 'inline-code', k: 'link' }
    const command = shortcut[key]
    if (command) {
      e.preventDefault()
      onFormat(command)
      return
    }
  }

  if (e.key !== 'Enter') return
  if (composing.value) return
  if (isMobile.value) return
  if (e.shiftKey) return
  e.preventDefault()
  submit()
}

onUnmounted(() => {
  stopTyping()
  uploadController?.abort()
  thumbController?.abort()
  releasePendingThumb()
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
      <span>松手即可上传（≤10 MB）</span>
    </div>

    <div v-if="nearLimit" class="composer__limit" :class="{ 'composer__limit--over': overLimit }">
      {{ text.length }} / {{ MESSAGE_TEXT_MAX }}
    </div>

    <!-- 待发送附件 / 上传进度 -->
    <div v-if="uploading || pendingAttachment" class="composer__att">
      <div class="composer__att-body">
        <!--
          图片：选完立刻显示缩略图，让用户能核对「我选的是不是这张」。
          文件：仍是图标 + 名字 + 大小（文件没有可看的缩略内容）。
        -->
        <img
          v-if="pendingThumbUrl"
          class="composer__att-thumb"
          :src="pendingThumbUrl"
          :alt="pendingAttachment?.name ?? '待发送图片'"
          decoding="async"
        />
        <span class="composer__att-name">{{
          pendingAttachment ? pendingAttachment.name : '正在上传…'
        }}</span>
        <span v-if="pendingAttachment" class="composer__att-size">{{
          formatBytes(pendingAttachment.size)
        }}</span>
        <div v-else class="composer__att-track" role="progressbar" :aria-valuenow="Math.round(uploadRatio * 100)" aria-valuemin="0" aria-valuemax="100">
          <div class="composer__att-fill" :style="{ width: `${Math.max(4, Math.round(uploadRatio * 100))}%` }" />
        </div>
      </div>
      <button
        class="composer__att-x"
        type="button"
        :title="uploading ? '取消上传' : '移除附件'"
        :aria-label="uploading ? '取消上传' : '移除附件'"
        @click="uploading ? cancelUpload() : removeAttachment()"
      >
        <AppIcon name="close" :size="13" />
      </button>
    </div>

    <ComposerToolbar
      :preview="preview"
      :uploading="uploading"
      :disabled="disabled"
      @format="onFormat"
      @toggle-preview="togglePreview"
      @pick-image="pickImage"
      @pick-file="pickFile"
    />

    <!-- 预览态：Markdown → VNode（与消息气泡同一渲染器，无 v-html） -->
    <div v-if="preview" class="composer__preview">
      <MarkdownView :source="text" code-label="代码" />
    </div>

    <!-- textarea 用 v-show 保留在 DOM：切换预览不丢草稿与光标 -->
    <textarea
      v-show="!preview"
      ref="textareaRef"
      v-model="text"
      class="composer__input"
      :placeholder="placeholder"
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
      两个独立的隐藏 input（ux2-contract §十二）。不共用一个：
      图片入口的 accept 必须是纯图片 MIME，文件入口才该放开限制。
      都保持 1px 隐藏 + tabindex=-1（不能用 display:none，某些浏览器对
      display:none 的 input 调用 click() 不弹选择器）。
    -->
    <input
      ref="imageInputRef"
      class="composer__file"
      type="file"
      tabindex="-1"
      aria-hidden="true"
      accept="image/png,image/jpeg,image/webp,image/gif"
      @change="onFileChange"
    />
    <input
      ref="fileInputRef"
      class="composer__file"
      type="file"
      tabindex="-1"
      aria-hidden="true"
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
        title="发送"
        aria-label="发送"
        @click="submit"
      >
        <AppIcon name="send" :size="17" />
      </button>
    </div>
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

/* ── 待发送附件 ── */
.composer__att {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 6px 5px 9px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel-alt);
}
.composer__att-body {
  display: flex;
  align-items: center;
  gap: 8px;
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
}
.composer__att-size {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--app-text-faint);
}
.composer__att-track {
  flex: 1 1 auto;
  height: 3px;
  min-width: 40px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text) 14%, transparent);
  overflow: hidden;
}
.composer__att-fill {
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

/* 待发送区里的图片缩略图：让用户能核对选中的图 */
.composer__att-thumb {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--app-active);
  border: 1px solid var(--app-border);
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
  }
  .composer__att-x {
    width: var(--spacing-touch-target);
    height: 32px;
  }
}
</style>
