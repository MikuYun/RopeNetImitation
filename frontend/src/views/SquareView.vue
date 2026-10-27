<script setup lang="ts">
/**
 * 广场内容屏（v2）。
 *
 * 【为什么只写内容区】路由 `square` 挂在 `/chat` 之下，由 ChatView 的
 * `<RouterView />` 渲染：手机端 `isContentScreen` 为真时 ChatView 只渲染本组件
 * （无 MobileNav、无列表屏横条），桌面端本组件是右侧内容栏。因此这里**不**做
 * 整页外壳、底部导航或二级侧栏 —— 只负责「一列信息流 + 自己的弹层」。
 *
 * 【实时性】订阅 ws/handlers.ts 暴露的 `onPostWsEvent`（自建订阅表，不碰
 * `wsClient.setEvents` 的单订阅者），远端有人发帖/删帖/点赞/评论时增量更新列表；
 * store 的 60s 可见性静默刷新保留作为兜底（WS 掉线时不至于完全静止）。
 * 自己操作的回声由 handler 按 `actorId === auth.userId` 过滤，避免乐观更新被覆盖。
 *
 * 【滚动容器】不是 window，而是 `.square__body` 自身（桌面端它嵌在多栏布局里）。
 * 所以 IntersectionObserver 必须显式传 `root`，否则哨兵在桌面端永远「没进视口」。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/base/AppButton.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppSkeleton from '@/components/base/AppSkeleton.vue'
import PostCard from '@/components/square/PostCard.vue'
import PostComposer from '@/components/square/PostComposer.vue'
import PostComments from '@/components/square/PostComments.vue'
import { attachmentKindOf, fetchPost } from '@/api/posts'
import { fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import { useSquareStore } from '@/stores/square'
import { useUiStore } from '@/stores/ui'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { goBack } from '@/composables/useBackNavigation'
import { onPostWsEvent } from '@/ws/handlers'
import { useAuthStore } from '@/stores/auth'
import type { Post, SquareAttachment } from '@/api/posts'
import type { PostWsEvent } from '@/ws/handlers'

const router = useRouter()
const route = useRoute()
const ui = useUiStore()
const store = useSquareStore()
const auth = useAuthStore()
const { posts, loading, loadingMore, hasMore, isEmpty, error } = storeToRefs(store)
const { isMobile } = useBreakpoint()

/* ── 视图状态 ─────────────────────────────────────────────────────── */

const composerOpen = ref(false)
/** 正在看评论的帖子 id；null = 评论面板关闭。 */
const commentsFor = ref<string | null>(null)
/** 远端评论到达时自增，通知已打开的评论面板静默刷新（自己的评论不走这里）。 */
const commentsRefreshKey = ref(0)

const showSkeleton = computed(() => loading.value && posts.value.length === 0)
const showError = computed(() => !!error.value && posts.value.length === 0)

const scrollerRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

/* ── 数据加载 ─────────────────────────────────────────────────────── */

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : '操作失败，请稍后重试'
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loading.value || loadingMore.value) return
  try {
    await store.fetchFeed(false)
  } catch (e) {
    // 追加失败不能清空已有内容，用 toast 提示即可
    ui.toast(messageOf(e), 'error')
  }
}

async function reload(notify = false): Promise<void> {
  try {
    await store.fetchFeed(true)
    if (notify) ui.toast('已刷新', 'success')
  } catch (e) {
    ui.toast(messageOf(e), 'error')
  }
}

/* 哨兵进入视口 → 加载下一页。`root` 必须是真正的滚动容器（见文件头注释）。 */
function bindObserver(): void {
  observer?.disconnect()
  observer = null
  if (typeof IntersectionObserver === 'undefined') return
  const sentinel = sentinelRef.value
  if (!sentinel) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    },
    { root: scrollerRef.value, rootMargin: '200px' },
  )
  observer.observe(sentinel)
}

/* ── 交互 ─────────────────────────────────────────────────────────── */

function openProfile(userId: string): void {
  if (!userId) return
  void router.push({ name: 'user-profile', params: { userId } })
}

function goBackToList(): void {
  // 深链直接进广场时 router.back() 无处可退，先按站内回退策略
  goBack(router, { name: 'chat-empty' })
}

async function onLike(id: string): Promise<void> {
  try {
    await store.toggleLike(id)
  } catch (e) {
    ui.toast(messageOf(e), 'error')
  }
}

async function onDelete(id: string): Promise<void> {
  try {
    await store.deletePost(id)
    ui.toast('已删除', 'success')
  } catch (e) {
    ui.toast(messageOf(e), 'error')
  }
}

function openComments(postId: string): void {
  commentsFor.value = postId
}

function closeComments(): void {
  commentsFor.value = null
}

/** 评论增删后同步卡片上的评论数（不发请求，本地加减）。 */
function onCommentCountChanged(delta: number): void {
  const postId = commentsFor.value
  if (!postId) return
  store.bumpCommentCount(postId, delta)
}

function onPostCreated(post: Post): void {
  composerOpen.value = false
  // store.createPost 内部已置顶插入；这里只负责滚动到顶部让作者看到自己的帖子
  void nextTick(() => scrollerRef.value?.scrollTo({ top: 0, behavior: 'smooth' }))
  // 兜底：极端情况下 store 没插进去（例如代际失效），再补一次
  if (!store.postOf(post.id)) store.prepend(post)
}

/* ── 实时更新：订阅广场 WS 事件 ─────────────────────────────────────── */

/** `onPostWsEvent` 返回的取消订阅函数。 */
let offPostWs: (() => void) | null = null
/**
 * `post.liked` 防抖表：同一帖 300ms 内只拉一次。
 *
 * 一场「热搜帖被连续点赞」在广播层会变成一串事件；不去重的话客户端会打出
 * 一梭子 `GET /posts/:id`，而且这些响应回来顺序不保证，反而把计数抖回旧值。
 */
const likeRefreshTimers = new Map<string, number>()

/** 自己发的操作一律跳过：本地已乐观更新，再拉一次会用旧快照盖掉新状态。 */
function isMine(actorId: string): boolean {
  const me = auth.userId
  return !!me && actorId === me
}

function scheduleLikeRefresh(postId: string): void {
  const pending = likeRefreshTimers.get(postId)
  if (pending !== undefined) return
  const timer = window.setTimeout(() => {
    likeRefreshTimers.delete(postId)
    void store.refreshPost(postId)
  }, 300)
  likeRefreshTimers.set(postId, timer)
}

function clearLikeRefreshTimers(): void {
  for (const timer of likeRefreshTimers.values()) window.clearTimeout(timer)
  likeRefreshTimers.clear()
}

/**
 * 处理远端广场事件。
 *
 * 原则：
 * - **不调 `fetchFeed`**。整页重拉会把用户正在看的位置、已加载的后续页、
 *   未读的新帖插入顺序全部打乱。只做增量：`refreshPost` / `prepend` / `remove`。
 * - **自己操作的回声全部丢弃**（`actorId === auth.userId`）：点赞本地已切、评论数
 *   本地已加、发帖已由 `onPostCreated` 置顶、删帖已本地移除。
 * - 任何一步失败都不冒泡（评论区/列表的兜底轮询仍在），最多丢一次增量。
 */
function handlePostWsEvent(event: PostWsEvent): void {
  const { postId, actorId } = event.data
  if (!postId) return

  switch (event.type) {
    case 'post.created': {
      if (isMine(actorId)) return
      // 已在本地（例如深链刚补进来的）就不用再拉
      if (store.postOf(postId)) return
      void (async () => {
        try {
          // 走 store.refreshPost 而不是直连 api.fetchPost：它内部有代际保护，
          // 登出/换账号期间回来的响应不会插进新账号的列表
          const fresh = await store.refreshPost(postId)
          if (!fresh) return
          // refreshPost 只 patch 已在列表的贴，新贴要自己置顶
          if (!store.postOf(fresh.id)) store.prepend(fresh)
          if (scrollerRef.value && scrollerRef.value.scrollTop <= 0) {
            scrollerRef.value.scrollTo({ top: 0, behavior: 'smooth' })
          }
        } catch {
          /* 403/404（例如拉黑、已删）：静默忽略 */
        }
      })()
      return
    }

    case 'post.deleted': {
      // 幂等：自己删的也不会出错（列表里已经没有）
      store.remove(postId)
      if (commentsFor.value === postId) commentsFor.value = null
      return
    }

    case 'post.liked': {
      if (isMine(actorId)) return
      // 不在列表里的帖子（已翻过 / 未加载）没必要为了一次点赞去拉详情
      if (!store.postOf(postId)) return
      scheduleLikeRefresh(postId)
      return
    }

    case 'post.commented': {
      if (isMine(actorId)) return
      if (!store.postOf(postId)) return
      store.bumpCommentCount(postId, 1)
      // 面板正开着且就是这个帖 → 让 PostComments 静默重拉（refreshKey 自增）
      if (commentsFor.value === postId) commentsRefreshKey.value += 1
      return
    }
  }
}

/* ── 图片/视频全屏预览（自建层）────────────────────────────────────── */

interface ViewerState {
  attachments: SquareAttachment[]
  index: number
}

const viewer = ref<ViewerState | null>(null)
const viewerUrls = reactive<Record<string, string>>({})
const viewerFailed = reactive<Record<string, boolean>>({})
/** 预览层代际：关掉/换组时回来的 blob 请求作废（其 URL 立即 revoke）。 */
let viewerToken = 0

const currentAttachment = computed<SquareAttachment | null>(() => {
  const state = viewer.value
  if (!state) return null
  return state.attachments[state.index] ?? null
})

const viewerCount = computed(() => viewer.value?.attachments.length ?? 0)
const viewerPosition = computed(() => (viewer.value ? viewer.value.index + 1 : 0))

async function loadViewerUrls(attachments: SquareAttachment[]): Promise<void> {
  const token = viewerToken
  await Promise.all(
    attachments.map(async (attachment) => {
      if (viewerUrls[attachment.id]) return
      try {
        const url = await fetchObjectUrl({ id: attachment.id })
        if (token !== viewerToken) {
          // 面板已关：这个 URL 没人用了，立刻释放，别等 GC
          revokeObjectUrl(url)
          return
        }
        viewerUrls[attachment.id] = url
      } catch {
        if (token === viewerToken) viewerFailed[attachment.id] = true
      }
    }),
  )
}

function clearViewerUrls(): void {
  viewerToken += 1
  for (const id of Object.keys(viewerUrls)) {
    revokeObjectUrl(viewerUrls[id])
    delete viewerUrls[id]
  }
  for (const id of Object.keys(viewerFailed)) delete viewerFailed[id]
}

function openPreview(attachments: SquareAttachment[], index: number): void {
  if (attachments.length === 0) return
  const safeIndex = Math.min(Math.max(0, index), attachments.length - 1)
  clearViewerUrls()
  viewer.value = { attachments: [...attachments], index: safeIndex }
  void loadViewerUrls(viewer.value.attachments)
}

function closePreview(): void {
  viewer.value = null
  clearViewerUrls()
}

function stepPreview(delta: number): void {
  const state = viewer.value
  if (!state || state.attachments.length < 2) return
  const total = state.attachments.length
  state.index = (state.index + delta + total) % total
}

function onViewerKeydown(event: KeyboardEvent): void {
  if (!viewer.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    stepPreview(1)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    stepPreview(-1)
  }
}

function viewerKindOf(attachment: SquareAttachment): 'image' | 'video' | 'file' {
  return attachmentKindOf(attachment)
}

function viewerUrlOf(attachment: SquareAttachment): string {
  return viewerUrls[attachment.id] ?? ''
}

function viewerFailedOf(attachment: SquareAttachment): boolean {
  return viewerFailed[attachment.id] === true
}

/* ── 分享链接 ?post=<id> ──────────────────────────────────────────── */

const flashId = ref('')

/** 把某条帖子滚进视口并短暂高亮（深链进入时的落点提示）。 */
async function focusPost(postId: string): Promise<void> {
  await nextTick()
  const el = document.getElementById(`post-${postId}`)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashId.value = postId
  window.setTimeout(() => {
    if (flashId.value === postId) flashId.value = ''
  }, 1600)
}

/**
 * 消费 `?post=<id>`：分享出去的链接点开要能看到那条帖子。
 * 不在当前首页里就单拉一次详情补进列表（帖子可能已翻到后面几页）。
 */
async function consumeDeepLink(): Promise<void> {
  const raw = route.query.post
  const postId = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
  if (typeof postId !== 'string' || !postId) return
  // 先清 query：避免刷新/回退时重复触发，也避免地址栏留着分享参数
  void router.replace({ name: 'square' })
  if (!store.postOf(postId)) {
    try {
      const fresh = await fetchPost(postId)
      store.prepend(fresh)
    } catch {
      ui.toast('这条动态不存在或已被删除', 'error')
      return
    }
  }
  await focusPost(postId)
}

/* ── 生命周期 ─────────────────────────────────────────────────────── */

onMounted(async () => {
  store.startAutoRefresh()
  bindObserver()
  window.addEventListener('keydown', onViewerKeydown)
  try {
    // 订阅失败不能阻断页面渲染：轮询兜底仍工作（见 stores/square.ts 文件头）
    offPostWs = onPostWsEvent(handlePostWsEvent)
  } catch (e) {
    console.warn('[square] 订阅广场 WS 事件失败，回退到轮询刷新', e)
  }
  try {
    // 回到广场时保留已加载内容，只有空列表才重新拉首屏
    if (posts.value.length === 0) await store.fetchFeed(true)
  } catch {
    /* 错误文案已由 store.error 呈现（首屏有错误态 + 重试）*/
  }
  await consumeDeepLink()
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
  store.stopAutoRefresh()
  offPostWs?.()
  offPostWs = null
  clearLikeRefreshTimers()
  clearViewerUrls()
  window.removeEventListener('keydown', onViewerKeydown)
})

watch(sentinelRef, (el) => {
  if (el) bindObserver()
})

watch(
  () => route.query.post,
  () => {
    void consumeDeepLink()
  },
)
</script>

<template>
  <section class="square">
    <!-- 顶部标题栏（sticky）：手机带返回，桌面只有标题与动作 -->
    <header class="square__head">
      <button
        v-if="isMobile"
        type="button"
        class="square__back touch-target"
        aria-label="返回"
        @click="goBackToList"
      >
        <AppIcon name="back" :size="20" />
      </button>

      <div class="square__title-wrap">
        <h1 class="square__title">广场</h1>
        <p class="square__sub">看看大家在聊什么</p>
      </div>

      <div class="square__acts">
        <button
          type="button"
          class="square__icon-btn touch-target"
          :disabled="loading"
          :aria-busy="loading || undefined"
          title="刷新"
          aria-label="刷新"
          @click="reload(true)"
        >
          <AppIcon name="refresh" :size="18" />
        </button>
        <button type="button" class="square__publish" @click="composerOpen = true">
          <AppIcon name="plus" :size="18" />
          <span class="square__publish-text">发布</span>
        </button>
      </div>
    </header>

    <!-- 信息流（自己就是滚动容器，见文件头注释） -->
    <div ref="scrollerRef" class="square__body">
      <!-- 骨架：3 张卡片外框自建，内部条用 AppSkeleton -->
      <div v-if="showSkeleton" class="feed" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="card card--skeleton">
          <div class="card__skel-head">
            <span class="card__skel-avatar" />
            <span class="card__skel-meta">
              <span class="card__skel-name" />
              <span class="card__skel-time" />
            </span>
          </div>
          <AppSkeleton :count="3" />
        </div>
      </div>

      <!-- 首屏错误：整屏提示 + 重试 -->
      <div v-else-if="showError" class="state">
        <AppEmpty icon="alert" title="信息流加载失败" :description="error" />
        <AppButton label="重试" tone="primary" @click="reload()" />
      </div>

      <!-- 空态 -->
      <div v-else-if="isEmpty" class="state">
        <AppEmpty
          icon="chat"
          title="还没有动态，发布第一条吧"
          description="分享一张图、一段话，广场会实时更新"
        />
        <AppButton label="发布动态" tone="primary" @click="composerOpen = true" />
      </div>

      <!-- 列表 -->
      <div v-else class="feed">
        <div
          v-for="post in posts"
          :id="`post-${post.id}`"
          :key="post.id"
          class="feed__item"
          :class="{ 'feed__item--flash': flashId === post.id }"
        >
          <PostCard
            :post="post"
            @delete="onDelete"
            @like="onLike"
            @comment="openComments"
            @open-profile="openProfile"
            @preview="openPreview"
          />
        </div>
      </div>

      <!-- 无限滚动哨兵：常驻 DOM，靠 IntersectionObserver 触发 -->
      <div ref="sentinelRef" class="feed__sentinel" aria-hidden="true" />
      <p v-if="loadingMore" class="feed__more">加载中…</p>
      <p v-else-if="posts.length > 0 && !hasMore" class="feed__more">没有更多了</p>
    </div>

    <!-- 发帖 -->
    <PostComposer :open="composerOpen" @close="composerOpen = false" @created="onPostCreated" />

    <!-- 评论（refresh-key 由 WS 的 post.commented 自增，让面板静默重拉） -->
    <PostComments
      :post-id="commentsFor ?? ''"
      :open="commentsFor !== null"
      :refresh-key="commentsRefreshKey"
      @close="closeComments"
      @count-changed="onCommentCountChanged"
      @open-profile="openProfile"
    />

    <!-- 全屏预览层 -->
    <Teleport to="body">
      <div
        v-if="viewer"
        class="viewer"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        @click.self="closePreview"
      >
        <div class="viewer__bar">
          <span class="viewer__pos">{{ viewerPosition }} / {{ viewerCount }}</span>
          <button type="button" class="viewer__close" aria-label="关闭预览" @click="closePreview">
            <AppIcon name="close" :size="20" />
          </button>
        </div>

        <button
          v-if="viewerCount > 1"
          type="button"
          class="viewer__nav viewer__nav--prev"
          aria-label="上一张"
          @click="stepPreview(-1)"
        >
          <AppIcon name="back" :size="22" />
        </button>

        <div class="viewer__stage">
          <template v-if="currentAttachment">
            <p v-if="viewerFailedOf(currentAttachment)" class="viewer__fail">媒体加载失败</p>
            <video
              v-else-if="viewerKindOf(currentAttachment) === 'video' && viewerUrlOf(currentAttachment)"
              class="viewer__media"
              :src="viewerUrlOf(currentAttachment)"
              controls
              autoplay
              playsinline
              preload="metadata"
            />
            <img
              v-else-if="viewerUrlOf(currentAttachment)"
              class="viewer__media"
              :src="viewerUrlOf(currentAttachment)"
              :alt="currentAttachment.name"
            />
            <p v-else class="viewer__loading">加载中…</p>
          </template>
        </div>

        <button
          v-if="viewerCount > 1"
          type="button"
          class="viewer__nav viewer__nav--next"
          aria-label="下一张"
          @click="stepPreview(1)"
        >
          <AppIcon name="expand-more" :size="22" class="viewer__nav-icon" />
        </button>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ── 外壳 ── */
.square {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--chat-canvas);
  background-image: var(--chat-canvas-image);
}

.square__head {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  padding-top: calc(var(--space-2) + var(--safe-top));
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 88%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  flex: none;
}

.square__back {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
}

.square__title-wrap {
  flex: 1;
  min-width: 0;
}

.square__title {
  margin: 0;
  color: var(--app-text);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: var(--lh-snug);
  letter-spacing: var(--tracking-tight);
}

.square__sub {
  margin: 1px 0 0;
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  line-height: var(--lh-snug);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.square__acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.square__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-full);
  background: var(--app-panel);
  color: var(--app-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-both),
    background var(--dur-fast) var(--ease-both);
}

.square__icon-btn:hover:not(:disabled) {
  background: var(--app-hover);
  color: var(--app-text);
}

.square__icon-btn:disabled {
  opacity: 0.5;
  cursor: progress;
}

.square__icon-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.square__publish {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: 34px;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-full);
  background-image: var(--gradient-brand);
  background-color: var(--color-brand-500);
  color: #fff;
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-both),
    filter var(--dur-fast) var(--ease-both);
}

.square__publish:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
}

.square__publish:active {
  transform: none;
}

.square__publish:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* ── 滚动区 ── */
.square__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-3) var(--space-4) calc(var(--space-6) + var(--safe-bottom));
}

.feed {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
}

.feed__item {
  border-radius: var(--radius-lg);
  transition: box-shadow var(--dur) var(--ease-both);
}

/* 深链落点高亮：短暂描边，随后淡出 */
.feed__item--flash {
  box-shadow: 0 0 0 2px var(--color-brand-500);
}

.feed__sentinel {
  width: 100%;
  height: 1px;
}

.feed__more {
  margin: var(--space-3) 0 0;
  color: var(--app-text-faint);
  font-size: var(--text-xs);
  text-align: center;
}

/* ── 状态区 ── */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  min-height: 60%;
  padding: var(--space-8) var(--space-4);
  text-align: center;
}

/* ── 骨架卡片 ── */
.card {
  padding: var(--space-4);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-lg);
  background: var(--app-panel);
}

.card--skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.card__skel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card__skel-avatar {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--app-panel-alt);
}

.card__skel-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-15);
}

.card__skel-name {
  width: 30%;
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
}

.card__skel-time {
  width: 18%;
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
}

/* ── 全屏预览层 ── */
.viewer {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--space-6) + var(--safe-top)) var(--space-3)
    calc(var(--space-6) + var(--safe-bottom));
  background: rgba(8, 12, 16, 0.92);
}

.viewer__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(var(--space-2) + var(--safe-top)) var(--space-3) var(--space-2);
  color: rgba(255, 255, 255, 0.86);
}

.viewer__pos {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.viewer__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-touch-target);
  height: var(--spacing-touch-target);
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  cursor: pointer;
}

.viewer__close:hover {
  background: rgba(255, 255, 255, 0.18);
}

.viewer__stage {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.viewer__media {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-md);
  background: #000;
}

.viewer__loading,
.viewer__fail {
  margin: 0;
  color: rgba(255, 255, 255, 0.72);
  font-size: var(--text-sm);
}

.viewer__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-touch-target);
  height: var(--spacing-touch-target);
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  cursor: pointer;
}

.viewer__nav:hover {
  background: rgba(255, 255, 255, 0.2);
}

.viewer__nav--prev {
  left: var(--space-2);
}

.viewer__nav--next {
  right: var(--space-2);
}

/* expand-more 是向下箭头，旋转后当「下一张」用 */
.viewer__nav-icon {
  transform: rotate(-90deg);
}

/* ── 手机 ── */
@media (max-width: 767px) {
  .square__head {
    padding-left: var(--space-3);
    padding-right: var(--space-3);
  }
  .square__sub {
    display: none;
  }
  .square__body {
    padding: var(--space-2) var(--space-3) calc(var(--space-6) + var(--safe-bottom));
  }
  .feed {
    max-width: none;
    gap: var(--space-2);
  }
  .square__publish-text {
    display: none;
  }
  .square__publish {
    width: 34px;
    padding: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .square__publish:hover {
    transform: none;
  }
  .feed__item {
    transition: none;
  }
}
</style>
