<script setup lang="ts">
/**
 * 广场评论区面板。
 *
 * 【形态】桌面/平板：`AppModal` 居中弹层（宽 560）。手机：AppModal 自带底部抽屉，
 * 这里不改它 —— 抽屉 + 固定在底部的输入框正好符合手机评论的习惯，键盘弹起时
 * 输入框仍在拇指区。
 *
 * 【为什么自己分页而不复用列表 store】评论是「按帖」的局部数据：跟着帖子走、
 * 关掉面板即弃。塞进全局 store 会在切帖时残留上一条的游标，还可能把别人的
 * 评论渲染到当前帖。这里用组件内 ref，`open` 变化时重置。
 *
 * 【删除后的计数】删除走乐观更新（本地移除 + emit 负数），失败再拉回列表——
 * 评论删除是幂等操作，用户对「点掉立刻消失」的期待远高于「转圈等 300ms」。
 *
 * 【回复】`replyToId` 只能指向**同一帖**内的评论（后端 INVALID_REPLY_TARGET），
 * 所以切换帖子必须清空回复目标。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import { createComment, deleteComment, fetchComments, COMMENT_MAX_CHARS } from '@/api/posts'
import { fromNow } from '@/utils/datetime'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { PostComment } from '@/api/posts'

const props = defineProps<{
  postId: string
  open: boolean
  /** 外部（WS）要求静默刷新：自增即触发第一页重拉，不显示骨架也不抢焦点。 */
  refreshKey?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'count-changed', delta: number): void
  (e: 'open-profile', userId: string): void
}>()

const auth = useAuthStore()
const ui = useUiStore()

const isAdmin = computed(() => auth.user?.role === 'admin')

/* ── 列表状态 ─────────────────────────────────────────────────── */

const comments = ref<PostComment[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref('')
const sending = ref(false)

/** 已卸载/切换帖子：回来的响应不再写入。 */
let generation = 0

const hasMore = computed(() => nextCursor.value !== null)
const isEmpty = computed(() => !loading.value && comments.value.length === 0)

async function load(reset: boolean, silent = false): Promise<void> {
  if (reset ? loading.value : loadingMore.value) return
  if (!reset && nextCursor.value === null) return
  const gen = ++generation
  const cursor = reset ? null : nextCursor.value
  if (reset) {
    // silent：WS 触发的重拉不显示骨架（列表已在屏幕上，闪一下反而像 bug）
    if (!silent) loading.value = true
    loadError.value = ''
  } else {
    loadingMore.value = true
  }
  try {
    const page = await fetchComments(props.postId, { cursor })
    if (gen !== generation) return
    if (reset) {
      comments.value = page.items
    } else {
      // 翻页期间若有人删评论，游标页可能与已加载区间重叠 → 按 id 去重
      const seen = new Set(comments.value.map((c) => c.id))
      comments.value = [...comments.value, ...page.items.filter((c) => !seen.has(c.id))]
    }
    nextCursor.value = page.nextCursor
  } catch (e) {
    if (gen !== generation) return
    const message = e instanceof Error && e.message ? e.message : '评论加载失败'
    // silent（WS 触发的背景刷新）失败不能把已在屏幕上的列表换成错误页，只吐个 toast
    if (reset && !silent) loadError.value = message
    else if (!reset) ui.toast(message, 'error')
  } finally {
    if (gen === generation) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

/** 滚动到底部哨兵 → 加载更多。 */
const bodyRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

function bindObserver(): void {
  observer?.disconnect()
  if (typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore.value && !loading.value) {
        void load(false)
      }
    },
    // 进入视口前 120px 就开始加载，滚动不会「顿一下」
    { root: bodyRef.value, rootMargin: '120px' },
  )
  if (sentinelRef.value) observer.observe(sentinelRef.value)
}

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})

/* ── 打开/切帖 ─────────────────────────────────────────────────── */

watch(
  () => [props.open, props.postId] as const,
  async ([open]) => {
    if (!open) return
    // 切帖必须清空：上一条帖的评论不能出现在新帖下
    comments.value = []
    nextCursor.value = null
    loadError.value = ''
    replyTo.value = null
    draft.value = ''
    generation += 1
    await load(true)
    await nextTick()
    bindObserver()
    inputRef.value?.focus()
  },
  { immediate: true },
)

/* ── 外部（WS）触发的静默刷新 ───────────────────────────────── */

watch(
  () => props.refreshKey,
  async (key, prev) => {
    // 只在面板开着、且是真正的自增时刷新；避免切帖瞬间多拉一次
    if (!props.open || !key || key === prev) return
    // 评论是**升序**（旧 → 新），新评论总是落在尾部：除非「全部评论正好一页装下」
    // （nextCursor 为 null，重拉一次就能拿全），否则重拉第一页根本不会包含新评论，
    // 反而会把用户已经翻出来的后续页丢掉。此时只靠 store 把卡片上的数字 +1，
    // 列表保持不动（下次打开面板或继续下滚自然就能看到）。
    const fitsOnePage = nextCursor.value === null || comments.value.length === 0
    if (!fitsOnePage) return
    await load(true, true)
  },
)

/* ── 输入 ─────────────────────────────────────────────────────── */

const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
/** 正在回复的评论（null = 发新评论）。 */
const replyTo = ref<PostComment | null>(null)

const draftChars = computed(() => Array.from(draft.value).length)
const overLimit = computed(() => draftChars.value > COMMENT_MAX_CHARS)
const canSend = computed(
  () => !sending.value && !overLimit.value && draft.value.trim().length > 0,
)

const counterTone = computed(() => {
  if (overLimit.value) return 'danger'
  return draftChars.value > COMMENT_MAX_CHARS * 0.9 ? 'warn' : ''
})

function startReply(comment: PostComment): void {
  replyTo.value = comment
  inputRef.value?.focus()
}

function cancelReply(): void {
  replyTo.value = null
}

async function send(): Promise<void> {
  if (!canSend.value) return
  sending.value = true
  const text = draft.value.trim()
  const replyTargetId = replyTo.value?.id ?? null
  try {
    const created = await createComment(props.postId, {
      content: text,
      replyToId: replyTargetId,
    })
    // 追加到末尾：后端按 createdAt 升序下发，新评论天然在最后
    comments.value = [...comments.value, created]
    draft.value = ''
    replyTo.value = null
    emit('count-changed', 1)
    await nextTick()
    // 滚到最新一条，否则用户发完看不到自己刚说的话
    sentinelRef.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  } catch (e) {
    const message = e instanceof Error && e.message ? e.message : '发送失败，请稍后重试'
    ui.toast(message, 'error')
  } finally {
    sending.value = false
  }
}

/** Enter 发送 / Shift+Enter 换行；输入法组合中的 Enter 不算。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  void send()
}

/* ── 删除 ─────────────────────────────────────────────────────── */

const deleteTarget = ref<PostComment | null>(null)
const deleteOpen = ref(false)

function canDelete(comment: PostComment): boolean {
  return comment.author.id === auth.userId || isAdmin.value
}

function askDelete(comment: PostComment): void {
  deleteTarget.value = comment
  deleteOpen.value = true
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  deleteOpen.value = false
  deleteTarget.value = null
  if (!target) return
  // 乐观移除：删评论的反馈延迟比「删错了」的代价更影响体验（可刷新恢复）
  const snapshot = [...comments.value]
  comments.value = comments.value.filter((c) => c.id !== target.id)
  if (replyTo.value?.id === target.id) replyTo.value = null
  emit('count-changed', -1)
  try {
    await deleteComment(props.postId, target.id)
  } catch (e) {
    comments.value = snapshot
    emit('count-changed', 1)
    const message = e instanceof Error && e.message ? e.message : '删除失败，请稍后重试'
    ui.toast(message, 'error')
  }
}

/* ── 展示 ─────────────────────────────────────────────────────── */

function timeOf(iso: string): string {
  try {
    return fromNow(iso)
  } catch {
    return ''
  }
}

function onOpenProfile(userId: string): void {
  if (userId) emit('open-profile', userId)
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <AppModal title="评论" :open="open" :width="560" @close="onClose">
    <div class="comments">
      <!-- 顶部回复提示 -->
      <div v-if="replyTo" class="reply-bar">
        <span class="reply-bar__text">回复 @{{ replyTo.author.displayName }}</span>
        <button type="button" class="reply-bar__x" aria-label="取消回复" @click="cancelReply">
          <AppIcon name="close" :size="14" />
        </button>
      </div>

      <div ref="bodyRef" class="list">
        <!-- 加载骨架 -->
        <div v-if="loading" class="skel">
          <div v-for="i in 3" :key="i" class="skel__row">
            <span class="skel__avatar" />
            <span class="skel__lines">
              <span class="skel__line" />
              <span class="skel__line skel__line--short" />
            </span>
          </div>
        </div>

        <!-- 错误态 -->
        <div v-else-if="loadError" class="state">
          <p class="state__text">{{ loadError }}</p>
          <AppButton label="重试" tone="ghost" size="sm" @click="load(true)" />
        </div>

        <!-- 空态 -->
        <p v-else-if="isEmpty" class="state__text state__text--center">
          还没有评论，来说第一句吧
        </p>

        <!-- 评论列表 -->
        <ul v-else class="items">
          <li v-for="comment in comments" :key="comment.id" class="comment">
            <button
              type="button"
              class="comment__avatar touch-target"
              aria-label="查看主页"
              @click="onOpenProfile(comment.author.id)"
            >
              <AppAvatar
                :src="comment.author.avatarUrl ?? ''"
                :name="comment.author.displayName"
                :seed="comment.author.id"
                :size="32"
              />
            </button>
            <div class="comment__main">
              <div class="comment__head">
                <button
                  type="button"
                  class="comment__name"
                  @click="onOpenProfile(comment.author.id)"
                >
                  {{ comment.author.displayName }}
                </button>
                <span class="comment__time">{{ timeOf(comment.createdAt) }}</span>
              </div>
              <p class="comment__text">
                <span v-if="comment.replyToAuthorName" class="comment__replyto">
                  回复 @{{ comment.replyToAuthorName }}：
                </span>{{ comment.content }}
              </p>
              <div class="comment__ops">
                <button type="button" class="op" @click="startReply(comment)">回复</button>
                <button
                  v-if="canDelete(comment)"
                  type="button"
                  class="op op--danger"
                  @click="askDelete(comment)"
                >
                  删除
                </button>
              </div>
            </div>
          </li>
        </ul>

        <!-- 分页哨兵 -->
        <div ref="sentinelRef" class="sentinel" aria-hidden="true" />
        <div v-if="loadingMore" class="more">加载中…</div>
        <div v-else-if="!hasMore && comments.length > 0" class="more">没有更多评论了</div>
      </div>

      <!-- 输入条 -->
      <div class="composer">
        <input
          ref="inputRef"
          v-model="draft"
          class="composer__input"
          type="text"
          :placeholder="replyTo ? `回复 @${replyTo.author.displayName}` : '说点什么…'"
          :aria-label="replyTo ? '回复评论' : '写评论'"
          enterkeyhint="send"
          @keydown="onKeydown"
        />
        <span class="composer__count" :class="`composer__count--${counterTone}`">
          {{ draftChars }} / {{ COMMENT_MAX_CHARS }}
        </span>
        <button
          type="button"
          class="composer__send"
          :disabled="!canSend"
          aria-label="发送评论"
          @click="send"
        >
          <AppIcon name="send" :size="18" />
        </button>
      </div>
    </div>
  </AppModal>

  <!-- 删除二次确认 -->
  <AppModal title="删除评论" :open="deleteOpen" :width="360" @close="deleteOpen = false">
    <p class="confirm">删除后无法恢复，确定删除这条评论吗？</p>
    <template #footer>
      <AppButton label="取消" tone="ghost" @click="deleteOpen = false" />
      <AppButton label="删除" tone="danger" @click="confirmDelete" />
    </template>
  </AppModal>
</template>

<style scoped>
.comments {
  display: flex;
  flex-direction: column;
  /* 面板 body 已经是 flex:1，这里用负 margin 抵消 AppModal 的 padding，
     让滚动区贴边、输入条固定在底部 */
  margin: calc(var(--space-4) * -1);
}

/* ── 回复提示 ── */
.reply-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--app-brand-tint);
  border-bottom: 1px solid var(--app-border);
}

.reply-bar__text {
  color: var(--color-brand-600);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reply-bar__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}

.reply-bar__x:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

/* ── 列表 ── */
.list {
  flex: 1;
  min-height: 200px;
  max-height: min(52vh, 460px);
  overflow-y: auto;
  padding: var(--space-3) var(--space-4);
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.comment {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.comment + .comment {
  border-top: 1px solid var(--app-border);
}

.comment__avatar {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  cursor: pointer;
}

.comment__main {
  flex: 1;
  min-width: 0;
}

.comment__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.comment__name {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment__name:hover {
  color: var(--color-brand-600);
}

.comment__time {
  flex: none;
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
}

.comment__text {
  margin: var(--space-1) 0 0;
  color: var(--app-text);
  font-size: var(--text-md);
  line-height: var(--lh-normal);
  /* 纯文本渲染；保留换行，绝不 v-html */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.comment__replyto {
  color: var(--color-brand-600);
}

.comment__ops {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
}

.op {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text-faint);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.op:hover {
  color: var(--color-brand-600);
}

.op--danger:hover {
  color: var(--color-danger-500);
}

/* ── 分页 ── */
.sentinel {
  height: 1px;
}

.more {
  padding: var(--space-2) 0;
  color: var(--app-text-faint);
  font-size: var(--text-xs);
  text-align: center;
}

/* ── 状态 ── */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
}

.state__text {
  margin: 0;
  color: var(--app-text-muted);
  font-size: var(--text-sm);
}

.state__text--center {
  padding: var(--space-6) 0;
  text-align: center;
}

/* 骨架 */
.skel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.skel__row {
  display: flex;
  gap: var(--space-2);
}

.skel__avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--app-panel-alt);
}

.skel__lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-15);
  padding-top: var(--space-1);
}

.skel__line {
  display: block;
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
}

.skel__line--short {
  width: 55%;
}

/* ── 输入条 ── */
.composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-top: 1px solid var(--app-border);
  background: var(--app-panel);
}

.composer__input {
  flex: 1;
  min-width: 0;
  height: var(--control-h);
  padding: 0 var(--space-3);
  border: 1px solid var(--app-border-strong);
  border-radius: var(--radius-full);
  background: var(--app-panel-alt);
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-md);
  outline: none;
}

.composer__input:focus {
  border-color: var(--color-brand-500);
  box-shadow: var(--focus-ring);
  background: var(--app-panel);
}

.composer__count {
  flex: none;
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
}

.composer__count--warn {
  color: var(--color-accent-600, #0f8a7d);
}

.composer__count--danger {
  color: var(--color-danger-500);
  font-weight: var(--weight-semibold);
}

.composer__send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background-image: var(--gradient-brand);
  background-color: var(--color-brand-500);
  color: #fff;
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-both);
}

.composer__send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer__send:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.confirm {
  margin: 0;
  color: var(--app-text-muted);
  font-size: var(--text-sm);
  line-height: var(--lh-normal);
}

/* ── 手机 ── */
@media (max-width: 767px) {
  .list {
    max-height: none;
    /* 抽屉里靠父容器定高；给个下限避免空列表时面板塌成一条 */
    min-height: 40vh;
  }
  .composer__input {
    font-size: var(--font-input-mobile);
  }
  .op {
    /* 触控热区 */
    padding: var(--space-1) 0;
    min-height: calc(var(--spacing-touch-target) / 2);
  }
}
</style>
