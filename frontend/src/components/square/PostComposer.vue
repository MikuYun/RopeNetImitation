<script setup lang="ts">
/**
 * 广场发帖弹层。
 *
 * 【为什么不用 AppModal 直接包一层】
 * 产品要求两端形态不同：桌面是 640px 居中弹层，手机是 `position: fixed; inset: 0`
 * 的整屏编辑页（顶部「取消 / 发布」）。AppModal 在手机上固定渲染成底部抽屉，其
 * 样式是 scoped 的，父组件无法覆盖 —— 硬套只会在手机上得到一张「半屏小抽屉」，
 * 键盘弹起后输入框被挤到视口外。
 *
 * 代价是要自己管焦点，所以这里**直接复用** `utils/dialogA11y` 的同一套判定
 * （Esc 关闭、Tab 循环、初始焦点），不另写一份分支——那正是该模块存在的理由：
 * 一旦第三份实现出现，行为必然漂移。
 *
 * 【上传时序】选完文件**立即上传**并显示进度，而不是等「发布」才一起传：
 *   1. 大视频上传要几十秒，用户先点了「发布」再卡住会以为按钮坏了；
 *   2. 失败能立刻反馈，不用丢掉整段已打的文字。
 * 因此提交时只需要把已完成的 attachment id 交出去。仍在传/失败的文件不计入。
 *
 * 【校验】文字或附件至少一个；图片 ≤9、视频 ≤1、合计 ≤9；普通文件一律拒收
 * （后端同样会拒，前端提前拦是为了不让用户白等一次上传）。
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import { uploadFile } from '@/api/uploads'
import {
  POST_MAX_CHARS,
  POST_MAX_ATTACHMENTS,
  POST_MAX_VIDEOS,
  createPost as createPostApi,
} from '@/api/posts'
import { attachmentKindOf } from '@/api/posts'
import { formatBytes } from '@/utils/attachments'
import { collectFocusables, dialogKeyAction } from '@/utils/dialogA11y'
import { useUiStore } from '@/stores/ui'
import type { Post } from '@/api/posts'
import type { Attachment } from '@/types/domain'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', post: Post): void
}>()

const ui = useUiStore()

/** 单个待发附件（含上传进度）。 */
interface PendingItem {
  /** 本地上传完成后才有。上传中为 null。 */
  attachment: Attachment | null
  /** 本地文件（用于按文件名/大小校验与展示）。 */
  file: File
  kind: 'image' | 'video'
  progress: number
  uploading: boolean
  error: string
}

const content = ref('')
const items = reactive<PendingItem[]>([])
const submitting = ref(false)
const discardOpen = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const layerRef = ref<HTMLElement | null>(null)

/** 每个上传的取消句柄（卸载/取消时 abort，避免组件没了还在写状态）。 */
const controllers = new Map<File, AbortController>()

/* ── 字数（按 Unicode 码点，与服务端 Array.from 口径一致）───────── */

const charCount = computed(() => Array.from(content.value).length)
const overLimit = computed(() => charCount.value > POST_MAX_CHARS)
const counterTone = computed(() => {
  if (overLimit.value) return 'danger'
  // 剩余不足 10% 时提前示警，别等超了才变红
  return charCount.value > POST_MAX_CHARS * 0.9 ? 'warn' : ''
})

/* ── 附件统计 ─────────────────────────────────────────────────── */

const imageCount = computed(() => items.filter((i) => i.kind === 'image').length)
const videoCount = computed(() => items.filter((i) => i.kind === 'video').length)
/** 还没传完或传失败的不计入可提交数量。 */
const readyIds = computed(() =>
  items.filter((i) => i.attachment !== null).map((i) => (i.attachment as Attachment).id),
)
const uploading = computed(() => items.some((i) => i.uploading))
const hasDraft = computed(() => content.value.trim().length > 0 || items.length > 0)

const canSubmit = computed(
  () =>
    !submitting.value &&
    !uploading.value &&
    !overLimit.value &&
    (content.value.trim().length > 0 || readyIds.value.length > 0),
)

const submitHint = computed(() => {
  if (uploading.value) return '附件上传中…'
  if (overLimit.value) return `超出 ${charCount.value - POST_MAX_CHARS} 字`
  if (content.value.trim().length === 0 && readyIds.value.length === 0) return '写点什么或添加图片/视频'
  return ''
})

/* ── 焦点与键盘（复用 dialogA11y，与 AppModal 同一套规则）───────── */

let restoreTarget: HTMLElement | null = null

function onKeydown(e: KeyboardEvent): void {
  const action = dialogKeyAction({
    key: e.key,
    shiftKey: e.shiftKey,
    dialogOpen: props.open,
    focusableCount: collectFocusables(layerRef.value).length,
    focusIndex: collectFocusables(layerRef.value).indexOf(document.activeElement as HTMLElement),
    isComposing: e.isComposing,
  })
  if (!action) return
  e.preventDefault()
  if (action.type === 'close') requestClose()
  else {
    const list = collectFocusables(layerRef.value)
    const el = action.target === 'first' ? list[0] : list[list.length - 1]
    el?.focus()
  }
}

/** 关闭：有草稿先确认（「放弃编辑？」）。 */
function requestClose(): void {
  if (submitting.value) return
  if (hasDraft.value) {
    discardOpen.value = true
    return
  }
  emit('close')
}

function confirmDiscard(): void {
  discardOpen.value = false
  resetDraft()
  emit('close')
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
      window.addEventListener('keydown', onKeydown)
      await nextTick()
      textareaRef.value?.focus()
    } else {
      window.removeEventListener('keydown', onKeydown)
      // 关掉时归还焦点（触发按钮还在，就不会「焦点掉到 body」）
      if (restoreTarget?.isConnected) restoreTarget.focus()
      restoreTarget = null
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  abortAllUploads()
})

/* ── 附件选择 ─────────────────────────────────────────────────── */

function abortAllUploads(): void {
  for (const c of controllers.values()) c.abort()
  controllers.clear()
}

function pickFiles(): void {
  fileInputRef.value?.click()
}

function onFilesPicked(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // 同一个文件连选两次也要能触发 change
  input.value = ''
  if (files.length > 0) addFiles(files)
}

/**
 * 加入待上传队列。
 *
 * 逐条校验并**即时反馈**：被拒的文件单独提示，不影响其他合格文件继续上传。
 */
function addFiles(files: File[]): void {
  for (const file of files) {
    const kind = attachmentKindOf({ mimeType: file.type })
    if (kind !== 'image' && kind !== 'video') {
      ui.toast('广场仅支持图片和视频', 'error')
      continue
    }
    // 视频只认 mp4/webm（后端按容器格式嗅探）
    if (kind === 'video' && !['video/mp4', 'video/webm'].includes(file.type.toLowerCase())) {
      ui.toast('仅支持 MP4 / WebM 视频', 'error')
      continue
    }
    if (kind === 'image' && items.filter((i) => i.kind === 'image').length >= POST_MAX_ATTACHMENTS) {
      ui.toast(`最多 ${POST_MAX_ATTACHMENTS} 个附件`, 'error')
      continue
    }
    if (kind === 'video' && videoCount.value >= POST_MAX_VIDEOS) {
      ui.toast(`视频最多 ${POST_MAX_VIDEOS} 个`, 'error')
      continue
    }
    if (items.length >= POST_MAX_ATTACHMENTS) {
      ui.toast(`最多 ${POST_MAX_ATTACHMENTS} 个附件`, 'error')
      continue
    }
    if (file.size <= 0) {
      ui.toast(`「${file.name}」是空文件`, 'error')
      continue
    }
    const limit = kind === 'video' ? 100 * 1024 * 1024 : 10 * 1024 * 1024
    if (file.size > limit) {
      ui.toast(
        `${kind === 'video' ? '视频' : '图片'}「${file.name}」超过 ${formatBytes(limit)}（${formatBytes(file.size)}）`,
        'error',
      )
      continue
    }

    const item: PendingItem = {
      attachment: null,
      file,
      kind,
      progress: 0,
      uploading: true,
      error: '',
    }
    items.push(item)
    /*
     * 【必须用队列里的响应式代理，不能用上面这个原始对象】
     * `items` 是 `reactive<PendingItem[]>`，push 进去的是原始对象；后续
     * `item.progress = ...` / `item.uploading = false` 全写在这个原始对象上，
     * Proxy 的 set 陷阱根本没被经过 —— 模板 v-for 读的是 Vue 生成的 Proxy，
     * 所以进度条永远停在 0%、`uploading` 永远是 true，`canSubmit` 恒 false，
     * 发布按钮永久 disabled。
     *
     * 实测暴露：e2e-v2 里选完图片等 60s，`.thumb` 有了但发布按钮一直不可点。
     * 取回数组末尾元素即是 Proxy，之后赋值才会触发渲染。
     */
    const live = items[items.length - 1] as PendingItem
    void startUpload(live)
  }
}

async function startUpload(target: PendingItem): Promise<void> {
  const controller = new AbortController()
  controllers.set(target.file, controller)
  try {
    const att = await uploadFile(target.file, {
      signal: controller.signal,
      onProgress: (p) => {
        target.progress = p.ratio
      },
    })
    target.attachment = att
  } catch {
    target.error = '上传失败，点击重试'
  } finally {
    target.uploading = false
    controllers.delete(target.file)
  }
}

function retryUpload(item: PendingItem): void {
  if (item.uploading) return
  item.error = ''
  item.progress = 0
  item.uploading = true
  void startUpload(item)
}

function removeItem(index: number): void {
  const item = items[index]
  if (!item) return
  // 先 abort：否则请求回来还会往已经移除的条目上写状态
  controllers.get(item.file)?.abort()
  controllers.delete(item.file)
  items.splice(index, 1)
}

/* ── 提交 ─────────────────────────────────────────────────────── */

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const post = await createPostApi({
      content: content.value.trim(),
      attachmentIds: readyIds.value,
    })
    ui.toast('发布成功', 'success')
    resetDraft()
    emit('created', post)
    emit('close')
  } catch (e) {
    const message = e instanceof Error && e.message ? e.message : '发布失败，请稍后重试'
    ui.toast(message, 'error')
  } finally {
    submitting.value = false
  }
}

function resetDraft(): void {
  content.value = ''
  abortAllUploads()
  items.splice(0, items.length)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="composer">
      <div v-if="open" ref="layerRef" class="layer" role="dialog" aria-modal="true" aria-label="发布动态">
        <div class="sheet" tabindex="-1">
          <!-- 顶部条：移动端「取消 / 发布」，桌面端同一份结构只是换了描边样式 -->
          <header class="sheet__head">
            <button type="button" class="head-btn" @click="requestClose">取消</button>
            <h2 class="sheet__title">发布动态</h2>
            <button
              type="button"
              class="head-btn head-btn--primary"
              :disabled="!canSubmit"
              :aria-busy="submitting || undefined"
              @click="onSubmit"
            >
              {{ submitting ? '发布中…' : '发布' }}
            </button>
          </header>

          <div class="sheet__body">
            <textarea
              ref="textareaRef"
              v-model="content"
              class="editor"
              :maxlength="POST_MAX_CHARS * 2"
              placeholder="分享点什么…"
              rows="6"
              aria-label="动态正文"
              spellcheck="false"
            />

            <div class="meta">
              <span v-if="submitHint" class="meta__hint">{{ submitHint }}</span>
              <span v-else class="meta__spacer" />
              <span class="meta__count" :class="`meta__count--${counterTone}`">
                {{ charCount }} / {{ POST_MAX_CHARS }}
              </span>
            </div>

            <!-- 已选附件 -->
            <ul v-if="items.length > 0" class="thumbs">
              <li v-for="(item, index) in items" :key="`${item.file.name}-${index}`" class="thumb">
                <div class="thumb__box" :class="{ 'thumb__box--error': !!item.error }">
                  <AppIcon :name="item.kind === 'video' ? 'video' : 'image'" :size="22" />
                  <span v-if="item.uploading" class="thumb__progress" :style="{ width: `${Math.round(item.progress * 100)}%` }" />
                  <span v-else-if="item.error" class="thumb__err" @click="retryUpload(item)">重试</span>
                </div>
                <button type="button" class="thumb__del" aria-label="移除附件" @click="removeItem(index)">
                  <AppIcon name="close" :size="12" />
                </button>
                <span class="thumb__name">{{ item.file.name }}</span>
              </li>
            </ul>

            <div class="tools">
              <button
                type="button"
                class="tool"
                :disabled="items.length >= POST_MAX_ATTACHMENTS"
                @click="pickFiles"
              >
                <AppIcon name="image" :size="18" />
                <span>图片 / 视频</span>
              </button>
              <span class="tools__stat">
                图片 {{ imageCount }}/{{ POST_MAX_ATTACHMENTS }} · 视频 {{ videoCount }}/{{ POST_MAX_VIDEOS }}
              </span>
            </div>

            <input
              ref="fileInputRef"
              class="sr-only"
              type="file"
              multiple
              accept="image/*,video/mp4,video/webm"
              @change="onFilesPicked"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 放弃编辑二次确认 -->
  <AppModal title="放弃编辑？" :open="discardOpen" :width="360" @close="discardOpen = false">
    <p class="discard">当前内容尚未发布，关闭后将丢失。</p>
    <template #footer>
      <AppButton label="继续编辑" tone="ghost" @click="discardOpen = false" />
      <AppButton label="放弃" tone="danger" @click="confirmDiscard" />
    </template>
  </AppModal>
</template>

<style scoped>
/* ── 遮罩层 ── */
.layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--space-4) + var(--safe-top)) calc(var(--space-4) + var(--safe-right))
    calc(var(--space-4) + var(--safe-bottom)) calc(var(--space-4) + var(--safe-left));
  background: rgb(14 20 26 / 0.46);
  backdrop-filter: blur(3px) saturate(120%);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: 640px;
  max-width: 100%;
  max-height: 100%;
  overflow: hidden;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
  outline: none;
}

.sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--app-border);
}

.sheet__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--app-text);
  letter-spacing: var(--tracking-tight);
}

.head-btn {
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-muted);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
}

.head-btn:hover:not(:disabled) {
  color: var(--app-text);
  background: var(--app-hover);
}

.head-btn--primary {
  color: var(--color-brand-600);
  font-weight: var(--weight-semibold);
}

.head-btn--primary:disabled {
  color: var(--app-text-faint);
  cursor: not-allowed;
  background: transparent;
}

.head-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.sheet__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-4);
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

/* ── 编辑区 ── */
.editor {
  display: block;
  width: 100%;
  min-height: 140px;
  max-height: 40vh;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  /* 移动端字号 <16px 会触发 iOS 自动缩放 */
  font-family: inherit;
  font-size: var(--font-input-mobile);
  line-height: var(--lh-relaxed);
  resize: none;
  outline: none;
}

.editor::placeholder {
  color: var(--app-text-faint);
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-2);
  min-height: 18px;
}

.meta__hint {
  color: var(--app-text-faint);
  font-size: var(--text-xs);
}

.meta__spacer {
  flex: 1;
}

.meta__count {
  color: var(--app-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.meta__count--warn {
  color: var(--color-accent-600, #0f8a7d);
}

.meta__count--danger {
  color: var(--color-danger-500);
  font-weight: var(--weight-semibold);
}

/* ── 附件缩略 ── */
.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.thumb {
  position: relative;
  width: 84px;
}

.thumb__box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 84px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: var(--app-panel-alt);
  color: var(--app-text-faint);
}

.thumb__box--error {
  border-color: var(--color-danger-500);
  color: var(--color-danger-500);
}

.thumb__progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--gradient-brand);
  transition: width var(--dur-fast) linear;
}

.thumb__err {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(255 255 255 / 0.72);
  color: var(--color-danger-500);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  cursor: pointer;
}

.thumb__del {
  position: absolute;
  top: -6px;
  right: -6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-full);
  background: var(--app-panel-raised);
  color: var(--app-text-muted);
  cursor: pointer;
}

.thumb__del:hover {
  color: var(--color-danger-500);
  border-color: var(--color-danger-500);
}

.thumb__name {
  display: block;
  margin-top: var(--space-1);
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 工具条 ── */
.tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--app-border);
}

.tool {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 32px;
  padding: 0 var(--space-2);
  border: 1px dashed var(--app-border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  color: var(--color-brand-600);
  border-color: var(--color-brand-500);
  background: var(--app-brand-tint);
}

.tool:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tool:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.tools__stat {
  color: var(--app-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.discard {
  margin: 0;
  color: var(--app-text-muted);
  font-size: var(--text-sm);
  line-height: var(--lh-normal);
}

/* ── 手机：整屏编辑页 ── */
@media (max-width: 767px) {
  .layer {
    display: block;
    padding: 0;
    background: var(--app-bg);
    backdrop-filter: none;
  }
  .sheet {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding-top: var(--safe-top);
    padding-bottom: var(--safe-bottom);
  }
  .sheet__head {
    padding: var(--space-2) var(--space-3);
  }
  .sheet__body {
    padding: var(--space-3) var(--space-3)
      calc(var(--space-6) + var(--safe-bottom));
  }
  .editor {
    min-height: 30vh;
  }
  /* 触控热区：顶部按钮至少 44px 高 */
  .head-btn {
    min-height: var(--spacing-touch-target);
    padding: 0 var(--space-3);
  }
}

/* ── 进场动画（只动 opacity/transform）───────────────────────────── */
.composer-enter-active {
  transition: opacity var(--dur) var(--ease-both);
}
.composer-leave-active {
  transition: opacity var(--dur-fast) var(--ease-both);
}
.composer-enter-from,
.composer-leave-to {
  opacity: 0;
}
.composer-enter-active .sheet {
  transition: transform var(--dur-slow) var(--ease-out);
}
.composer-enter-from .sheet {
  transform: translateY(12px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .composer-enter-from .sheet {
    transform: none;
  }
}
</style>
