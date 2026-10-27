<script setup lang="ts">
/**
 * 访客资料页（UI-V2 §3 / API-V2 §3）。
 *
 * 入口：消息气泡头像、群成员列表、联系人列表、广场帖子作者。
 * 路由：`/chat/user/:userId`（name `user-profile`），所以本页也继承 ChatView 外壳。
 *
 * 【本页自建精简帖卡，不 import 广场的 PostCard】
 * 广场卡片是 fe-square 的活跃开发文件（还要接评论、点赞、九宫格预览、删除），
 * 跨 owner 引用会把两边锁死：它改一次 props 我就得跟着改。这里只读不写的
 * 展示需求（文字 + 最多 3 张图 + 计数 + 时间）自己实现，成本远低于耦合。
 *
 * 【关系状态由服务端给出，写操作后本地推进】
 * `GET /users/:userId` 直接返回 relationship（v1 时期是靠前端用好友列表推导，
 * 不适用于「还没加载过对方好友列表」的访客场景）。加好友/同意之后我们自己把
 * 本地 relationship 推进一格，不整页重拉 —— 重拉会闪一屏骨架，体验更差。
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppSkeleton from '@/components/base/AppSkeleton.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import { fetchUserPosts, fetchUserProfile } from '@/api/users'
import { toApiError } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { usePresenceStore } from '@/stores/presence'
import { goBack as goBackTo } from '@/composables/useBackNavigation'
import { fromNow } from '@/utils/datetime'
import type { WireAttachment, WirePost } from '@/api/wire'
import type { Relationship } from '@/types/domain'

const props = defineProps<{ userId: string }>()

const router = useRouter()
const auth = useAuthStore()
const convStore = useConversationStore()
const friendStore = useFriendStore()
const presence = usePresenceStore()

const userId = computed(() => props.userId ?? '')

/* ── 资料 ─────────────────────────────────────────────────────────── */

const profile = ref<Awaited<ReturnType<typeof fetchUserProfile>> | null>(null)
/** 本页内推进过的关系（加载后以它为准）。 */
const relationship = ref<Relationship>('none')
const loading = ref(true)
const error = ref('')
const actionBusy = ref(false)

const user = computed(() => profile.value?.user ?? null)
const nickname = computed(() => user.value?.displayName ?? '')
const avatarSrc = computed(() => user.value?.avatarUrl ?? '')
const uidText = computed(() => {
  const uid = user.value?.uid
  return uid && uid > 0 ? `#${uid}` : '—'
})
const bioText = computed(() => {
  const bio = user.value?.bio?.trim()
  return bio && bio.length > 0 ? bio : '这个人很懒，什么都没写'
})
const online = computed(() => presence.isOnline(userId.value))
/** 管理员视角下的封禁徽章（普通用户不显示，避免变成羞辱性标签展示）。 */
const showBanned = computed(() => auth.user?.role === 'admin' && user.value?.status === 'banned')
const isSelf = computed(() => relationship.value === 'self' || userId.value === auth.userId)

/** 待我处理的入站申请（request_received 时同意要用它的 id）。 */
const incomingRequest = computed(() =>
  friendStore.incoming.find((r) => r.fromUser.id === userId.value) ?? null,
)

/* ── 动态 ─────────────────────────────────────────────────────────── */

const posts = ref<WirePost[]>([])
const cursor = ref<string | null>(null)
const postsLoading = ref(false)
const postsLoadingMore = ref(false)
const postsError = ref('')
const hasMore = computed(() => cursor.value !== null)
const sentinelRef = ref<HTMLElement | null>(null)

/** 帖子里的图片走 blob 通道（附件需要 Bearer，不能直接塞进 img src）。 */
const imageUrls = reactive<Record<string, string>>({})
const imageFailed = reactive<Record<string, boolean>>({})
const pendingImages = new Set<string>()
const objectUrls = new Set<string>()
let disposed = false

function previewImages(post: WirePost): WireAttachment[] {
  const list = Array.isArray(post.attachments) ? post.attachments : []
  return list.filter((a) => a.kind === 'image' || a.mimeType.startsWith('image/')).slice(0, 3)
}

async function loadImage(att: WireAttachment): Promise<void> {
  if (imageUrls[att.id] || imageFailed[att.id] || pendingImages.has(att.id)) return
  pendingImages.add(att.id)
  try {
    const url = await fetchObjectUrl({ id: att.id })
    if (disposed) {
      revokeObjectUrl(url)
      return
    }
    imageUrls[att.id] = url
    objectUrls.add(url)
  } catch {
    imageFailed[att.id] = true
  } finally {
    pendingImages.delete(att.id)
  }
}

function requestImages(): void {
  for (const post of posts.value) {
    for (const att of previewImages(post)) void loadImage(att)
  }
}

async function loadProfile(): Promise<void> {
  const id = userId.value
  if (!id) {
    loading.value = false
    error.value = '缺少用户标识'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const view = await fetchUserProfile(id)
    if (disposed || id !== userId.value) return
    profile.value = view
    relationship.value = view.relationship
  } catch (e) {
    if (disposed) return
    error.value = toApiError(e).message
  } finally {
    loading.value = false
  }
}

async function loadPosts(reset = false): Promise<void> {
  const id = userId.value
  if (!id) return
  if (reset) {
    posts.value = []
    cursor.value = null
    postsError.value = ''
  }
  const more = !reset && cursor.value !== null
  if (more) postsLoadingMore.value = true
  else postsLoading.value = true
  try {
    const q: { cursor?: string; limit?: number } = { limit: 20 }
    if (cursor.value) q.cursor = cursor.value
    const page = await fetchUserPosts(id, q)
    if (disposed || id !== userId.value) return
    posts.value = reset ? page.items : [...posts.value, ...page.items]
    cursor.value = page.nextCursor
    requestImages()
  } catch (e) {
    if (disposed) return
    postsError.value = toApiError(e).message
  } finally {
    postsLoading.value = false
    postsLoadingMore.value = false
  }
}

let observer: IntersectionObserver | null = null

function watchSentinel(): void {
  observer?.disconnect()
  observer = null
  if (typeof IntersectionObserver === 'undefined') return
  const el = sentinelRef.value
  if (!el) return
  observer = new IntersectionObserver(
    (entries) => {
      const hit = entries.some((e) => e.isIntersecting)
      if (!hit) return
      if (postsLoading.value || postsLoadingMore.value) return
      if (!hasMore.value || postsError.value) return
      void loadPosts()
    },
    { rootMargin: '160px' },
  )
  observer.observe(el)
}

/* ── 生命周期 ─────────────────────────────────────────────────────── */

void loadProfile()
void loadPosts(true)

watch(userId, () => {
  profile.value = null
  relationship.value = 'none'
  void loadProfile()
  void loadPosts(true)
})

// 哨兵节点在首屏骨架/空态/错误态下不存在，所以用轮询式的 watch 而不只是 onMounted
watch(sentinelRef, (el) => {
  if (el) watchSentinel()
})

onUnmounted(() => {
  disposed = true
  observer?.disconnect()
  observer = null
  for (const url of objectUrls) revokeObjectUrl(url)
  objectUrls.clear()
})

/* ── 操作 ─────────────────────────────────────────────────────────── */

function back(): void {
  goBackTo(router, { name: 'chat-empty' })
}

function editProfile(): void {
  void router.push({ name: 'profile' })
}

function openChat(convId: string): void {
  void router.push({ name: 'chat', params: { convId } })
}

async function sendMessage(): Promise<void> {
  const existing = profile.value?.conversationId
  if (existing) {
    openChat(existing)
    return
  }
  actionBusy.value = true
  try {
    const conv = await convStore.createDirect(userId.value)
    openChat(conv.id)
  } catch (e) {
    error.value = toApiError(e).message
  } finally {
    actionBusy.value = false
  }
}

async function addFriend(): Promise<void> {
  actionBusy.value = true
  try {
    await friendStore.sendRequest(userId.value)
    relationship.value = 'request_sent'
  } catch (e) {
    postsError.value = ''
    error.value = toApiError(e).message
  } finally {
    actionBusy.value = false
  }
}

async function acceptFriend(): Promise<void> {
  const req = incomingRequest.value
  if (!req) {
    error.value = '好友申请已失效，请到「新的朋友」处理'
    return
  }
  actionBusy.value = true
  try {
    const convId = await friendStore.accept(req.id, userId.value, req.fromUser)
    relationship.value = 'friend'
    if (profile.value) profile.value.conversationId = convId || profile.value.conversationId
  } catch (e) {
    error.value = toApiError(e).message
  } finally {
    actionBusy.value = false
  }
}

function retryAll(): void {
  error.value = ''
  void loadProfile()
  void loadPosts(true)
}

function timeText(iso: string): string {
  try {
    return fromNow(iso)
  } catch {
    return ''
  }
}
</script>

<template>
  <section class="up">
    <header class="up__head">
      <button class="up__back touch-target" type="button" aria-label="返回" @click="back">
        <AppIcon name="back" :size="18" />
      </button>
      <span class="up__head-title">资料</span>
    </header>

    <!-- 骨架 -->
    <div v-if="loading" class="up__body" aria-hidden="true">
      <div class="up__hero">
        <span class="up__skel-avatar" />
        <div class="up__hero-text">
          <span class="up__skel-line up__skel-line--lg" />
          <span class="up__skel-line" />
          <span class="up__skel-line up__skel-line--sm" />
        </div>
      </div>
      <AppSkeleton :count="4" />
    </div>

    <!-- 首屏错误 -->
    <div v-else-if="error && !profile" class="up__state">
      <AppEmpty icon="alert" title="资料加载失败" :description="error" />
      <AppButton label="重试" tone="primary" @click="retryAll" />
    </div>

    <div v-else-if="profile" class="up__body">
      <!-- 资料区 -->
      <div class="up__hero">
        <AppAvatar :name="nickname" :seed="userId" :size="80" :radius="16" :src="avatarSrc" />
        <div class="up__hero-text">
          <div class="up__name-row">
            <span class="up__name">{{ nickname }}</span>
            <span v-if="showBanned" class="up__banned">
              <AppIcon name="shield" :size="12" />
              已封禁
            </span>
          </div>
          <div class="up__account">@{{ user?.username }}</div>
          <div class="up__uid">UID {{ uidText }}</div>
          <div class="up__presence">
            <PresenceDot :user-id="userId" :size="8" />
            <span>{{ online ? '在线' : '离线' }}</span>
          </div>
        </div>
      </div>

      <p class="up__bio" :class="{ 'up__bio--empty': bioText === '这个人很懒，什么都没写' }">
        {{ bioText }}
      </p>

      <!-- 统计 -->
      <div class="up__stats">
        <div class="up__stat">
          <span class="up__stat-num">{{ profile.postCount }}</span>
          <span class="up__stat-label">动态</span>
        </div>
        <div class="up__stat">
          <span class="up__stat-num">{{ profile.friendCount }}</span>
          <span class="up__stat-label">好友</span>
        </div>
      </div>

      <!-- 操作区：按关系分支 -->
      <div class="up__actions">
        <template v-if="isSelf">
          <AppButton label="编辑资料" tone="primary" block @click="editProfile" />
        </template>

        <template v-else-if="relationship === 'friend'">
          <AppButton
            label="发消息"
            tone="primary"
            block
            :loading="actionBusy"
            @click="sendMessage"
          />
        </template>

        <template v-else-if="relationship === 'request_received'">
          <AppButton
            label="同意好友申请"
            tone="primary"
            block
            :loading="actionBusy"
            @click="acceptFriend"
          />
        </template>

        <template v-else-if="relationship === 'request_sent'">
          <AppButton label="好友申请已发送" block disabled />
        </template>

        <template v-else>
          <AppButton
            label="加好友"
            tone="primary"
            block
            :loading="actionBusy"
            @click="addFriend"
          />
        </template>
      </div>

      <p v-if="error" class="up__inline-error">{{ error }}</p>

      <!-- TA 的动态 -->
      <section class="up__posts">
        <h2 class="up__posts-title">TA 的动态</h2>

        <div v-if="postsLoading" aria-hidden="true">
          <AppSkeleton :count="3" :height="16" />
        </div>

        <div v-else-if="postsError && posts.length === 0" class="up__posts-state">
          <p class="up__posts-hint">{{ postsError }}</p>
          <AppButton label="重新加载" tone="ghost" size="sm" @click="loadPosts(true)" />
        </div>

        <AppEmpty
          v-else-if="profile.postCount === 0 || posts.length === 0"
          icon="chat"
          title="还没有动态"
          :description="isSelf ? '发布一条动态，让别人认识你' : 'TA 还没有发布过动态'"
        />

        <template v-else>
          <article v-for="post in posts" :key="post.id" class="post">
            <p v-if="post.content" class="post__text">{{ post.content }}</p>

            <div
              v-if="previewImages(post).length"
              class="post__imgs"
              :class="`post__imgs--${previewImages(post).length}`"
            >
              <template v-for="att in previewImages(post)" :key="att.id">
                <img
                  v-if="imageUrls[att.id]"
                  class="post__img"
                  :src="imageUrls[att.id]"
                  :alt="att.name"
                  loading="lazy"
                />
                <span v-else class="post__img post__img--ph" :title="att.name" />
              </template>
            </div>

            <footer class="post__meta">
              <span class="post__time">{{ timeText(post.createdAt) }}</span>
              <span class="post__count">
                <AppIcon name="heart" :size="13" />
                {{ post.likeCount }}
              </span>
              <span class="post__count">
                <AppIcon name="comment" :size="13" />
                {{ post.commentCount }}
              </span>
            </footer>
          </article>

          <!-- 无限滚动哨兵：常驻 DOM，靠 IntersectionObserver 触发 -->
          <div ref="sentinelRef" class="up__sentinel" aria-hidden="true" />
          <p v-if="postsLoadingMore" class="up__posts-hint">加载中…</p>
          <p v-else-if="!hasMore" class="up__posts-hint">没有更多了</p>
          <p v-if="postsError" class="up__posts-hint up__posts-hint--error">{{ postsError }}</p>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.up {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex: 1;
  background: var(--chat-canvas);
  background-image: var(--chat-canvas-image);
}

/* ── 顶部返回栏 ── */
.up__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  padding-top: calc(var(--space-2) + var(--safe-top));
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}
.up__back {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
}
.up__head-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text);
}

.up__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-4);
  padding-bottom: calc(var(--space-6) + var(--safe-bottom));
}

.up__state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6);
}

/* ── 资料区 ── */
.up__hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.up__hero-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.up__name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.up__name {
  font-size: 18px;
  font-weight: 600;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up__banned {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-danger-500) 14%, transparent);
  color: var(--color-danger-500);
  font-size: 11px;
  line-height: 1.6;
}
.up__account {
  font-size: 12px;
  color: var(--app-text-muted);
}
.up__uid {
  font-size: 11px;
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}
.up__presence {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--app-text-faint);
}
.up__bio {
  margin: var(--space-4) 0 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--app-text-muted);
  word-break: break-word;
  white-space: pre-wrap;
}
.up__bio--empty {
  color: var(--app-text-faint);
}

/* ── 统计 ── */
.up__stats {
  display: flex;
  gap: var(--space-6);
  margin-top: var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--app-border);
  border-bottom: 1px solid var(--app-border);
}
.up__stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.up__stat-num {
  font-size: 16px;
  font-weight: 600;
  color: var(--app-text);
  font-variant-numeric: tabular-nums;
}
.up__stat-label {
  font-size: 12px;
  color: var(--app-text-faint);
}

.up__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.up__inline-error {
  margin: var(--space-2) 0 0;
  font-size: 12px;
  color: var(--color-danger-500);
}

/* ── 动态列表 ── */
.up__posts {
  margin-top: var(--space-5);
}
.up__posts-title {
  margin: 0 0 var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-muted);
}
.up__posts-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
}
.up__posts-hint {
  margin: var(--space-2) 0;
  text-align: center;
  font-size: 12px;
  color: var(--app-text-faint);
}
.up__posts-hint--error {
  color: var(--color-danger-500);
}
.up__sentinel {
  height: 1px;
}

/* ── 精简帖卡 ── */
.post {
  padding: var(--space-3);
  margin-bottom: var(--space-3);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-lg);
  background: var(--app-panel);
}
.post__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--app-text);
  word-break: break-word;
  white-space: pre-wrap;
}
.post__imgs {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.post__imgs--1 {
  grid-template-columns: 1fr;
}
.post__imgs--2 {
  grid-template-columns: repeat(2, 1fr);
}
.post__imgs--3 {
  grid-template-columns: repeat(3, 1fr);
}
.post__img {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
}
.post__img--ph {
  border: 1px dashed var(--app-border);
}
.post__meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
  font-size: 11px;
  color: var(--app-text-faint);
}
.post__time {
  flex: 1;
  min-width: 0;
}
.post__count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}

/* ── 骨架占位 ── */
.up__skel-avatar {
  width: 80px;
  height: 80px;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--app-panel-alt);
}
.up__skel-line {
  display: block;
  width: 120px;
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
}
.up__skel-line--lg {
  width: 88px;
  height: 16px;
}
.up__skel-line--sm {
  width: 64px;
  height: 10px;
}

/* 手机：输入/正文 16px 起，避免 iOS 聚焦缩放 */
@media (max-width: 767px) {
  .up__body {
    padding: var(--space-3);
    padding-bottom: calc(var(--space-6) + var(--safe-bottom));
  }
  .up__hero {
    gap: var(--space-3);
  }
}
</style>
