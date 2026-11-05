<script setup lang="ts">
/**
 * 广场单条动态卡片。
 *
 * 【渲染纪律：禁止 v-html】正文是完全不可信的输入（别人的设备/客户端/历史脏数据
 * 都能决定它每个字节）。项目里唯一允许的富文本通道是 `utils/markdown.ts` 的
 * 「MD 字符串 → VNode」，而广场正文按产品定义是**纯文本**，不需要 Markdown。
 * 因此这里：换行靠 `white-space: pre-wrap`，链接靠「纯文本切分 + <a> VNode」，
 * 全程不产生 HTML 字符串 —— 安全是构造性不可达的，不是靠过滤。
 *
 * 【URL 识别】正则切成 text/link 段，href 再过一遍 `isSafeHref()`（与消息侧
 * markdown 共用同一份白名单），只认 http/https，其余降级成纯文本。链接用
 * `rel="noopener noreferrer"`、`target="_blank"`，不把 referrer 带给站外。
 *
 * 【长文折叠】>400 码点才给「全文」，避免短贴也被折叠按钮干扰；展开后仍
 * pre-wrap，且折叠按钮放在正文下方（不是遮住文字）。
 *
 * 【附件】交给 MediaGrid（独立实现，不复用 fe-msg 正在重写的 AttachmentView）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import MediaGrid from '@/components/square/MediaGrid.vue'
import { fromNow } from '@/utils/datetime'
import { writeClipboardText } from '@/utils/clipboard'
import { isSafeHref } from '@/utils/markdown'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { Post, SquareAttachment } from '@/api/posts'

const props = defineProps<{ post: Post }>()

const emit = defineEmits<{
  (e: 'delete', id: string): void
  (e: 'like', id: string): void
  (e: 'comment', postId: string): void
  (e: 'open-profile', userId: string): void
  (e: 'preview', attachments: SquareAttachment[], index: number): void
}>()

const auth = useAuthStore()
const ui = useUiStore()

/** 管理员也能删别人的贴（后端同样校验，这里只是入口可见性）。 */
const isAdmin = computed(() => auth.user?.role === 'admin')
const canDelete = computed(() => props.post.mine || isAdmin.value)

/* ── 时间 ──────────────────────────────────────────────────────── */

const timeText = computed(() => {
  try {
    return fromNow(props.post.createdAt)
  } catch {
    return ''
  }
})

/* ── 正文：长文折叠 ────────────────────────────────────────────── */

/** 超过这个码点数才出现「全文」（短贴不该被折叠按钮打扰）。 */
const COLLAPSE_AT = 400

const expanded = ref(false)

const contentChars = computed(() => Array.from(props.post.content).length)
const collapsible = computed(() => contentChars.value > COLLAPSE_AT)

const displayContent = computed(() => {
  if (expanded.value || !collapsible.value) return props.post.content
  return Array.from(props.post.content).slice(0, COLLAPSE_AT).join('')
})

// 卡片被复用（虚拟列表/切换）时收起，避免把上一条的展开态带过去
watch(
  () => props.post.id,
  () => {
    expanded.value = false
    menuOpen.value = false
  },
)

/* ── 正文：URL 切分（纯文本 → 段数组，绝不拼 HTML）─────────────── */

interface TextSeg {
  kind: 'text' | 'link'
  text: string
  href: string
}

/** 行尾常见标点不属于 URL，切出来要还回文本，否则 `看这个 https://a.com。` 会带个句号。 */
const TRAILING_PUNCT = /[),.;:!?'"，。、；：！？）】》」]+$/

function trimUrlTail(raw: string): { url: string; tail: string } {
  const m = TRAILING_PUNCT.exec(raw)
  if (!m) return { url: raw, tail: '' }
  return { url: raw.slice(0, raw.length - m[0].length), tail: m[0] }
}

/**
 * 把正文切成 text / link 段。
 *
 * 只认 http(s)；`javascript:` / `data:` 之类根本不会命中正则，即使命中也会被
 * `isSafeHref` 拦成纯文本（双重保险）。
 */
const segments = computed<TextSeg[]>(() => {
  const text = displayContent.value
  const out: TextSeg[] = []
  if (!text) return out
  const re = /https?:\/\/[^\s<>"'`]+/gi
  let last = 0
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    const raw = m[0]
    const start = m.index
    const { url, tail } = trimUrlTail(raw)
    const href = url
    const safe = !!href && isSafeHref(href)
    if (safe) {
      if (start > last) out.push({ kind: 'text', text: text.slice(last, start), href: '' })
      out.push({ kind: 'link', text: url, href })
      if (tail) out.push({ kind: 'text', text: tail, href: '' })
      last = start + raw.length
    } else {
      // 不安全/异常：整段还原成纯文本
      if (start > last) out.push({ kind: 'text', text: text.slice(last, start), href: '' })
      out.push({ kind: 'text', text: raw, href: '' })
      last = start + raw.length
    }
    m = re.exec(text)
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last), href: '' })
  return out
})

/* ── ⋯ 菜单 ────────────────────────────────────────────────────── */

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}

function onDocPointerDown(e: PointerEvent): void {
  if (!menuOpen.value) return
  const root = menuRef.value
  if (root && !root.contains(e.target as Node)) menuOpen.value = false
}

// 只在菜单打开时挂全局监听：常驻监听 × N 张卡片会拖慢滚动
watch(menuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocPointerDown, true)
  else document.removeEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
})

const deleteOpen = ref(false)

function askDelete(): void {
  menuOpen.value = false
  deleteOpen.value = true
}

function confirmDelete(): void {
  deleteOpen.value = false
  emit('delete', props.post.id)
}

/* ── 计数展示 ──────────────────────────────────────────────────── */

/** 大数收敛成「1.2万」，避免操作条被数字撑变形。 */
function formatCount(n: number): string {
  if (n <= 0) return ''
  if (n < 10_000) return String(n)
  return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
}

/* ── 分享 ──────────────────────────────────────────────────────── */

/** 站内帖子链接；详情页消费 `?post=` 参数（SquareView 已支持）。 */
const shareUrl = computed(() => `${location.origin}/chat/square?post=${props.post.id}`)

/**
 * 剪贴板写入。
 *
 * 【为什么是 import 而不是本地实现】`navigator.clipboard` 在非安全上下文
 * （http + 非 localhost）不存在，必须有 textarea + `execCommand` 降级。
 * 这段降级原先在仓库里有四份（本文件、消息气泡、markdown 代码块、Profile 的
 * UID 复制），改一处漏三处 —— 现在唯一实现在 `@/utils/clipboard`。
 */
const writeClipboard = writeClipboardText

const sharing = ref(false)

async function onShare(): Promise<void> {
  if (sharing.value) return
  sharing.value = true
  try {
    const ok = await writeClipboard(shareUrl.value)
    if (ok) ui.toast('链接已复制', 'success')
    else ui.toast('复制失败，请手动复制地址栏链接', 'error')
  } finally {
    sharing.value = false
  }
}

/* ── 交互转发 ──────────────────────────────────────────────────── */

function onOpenProfile(): void {
  if (!props.post.author.id) return
  emit('open-profile', props.post.author.id)
}

function onComment(): void {
  emit('comment', props.post.id)
}

function onPreview(index: number): void {
  emit('preview', props.post.attachments, index)
}
</script>

<template>
  <article class="post">
    <!-- 头部：头像 + 昵称 + @username + 相对时间 + ⋯ -->
    <header class="post__head">
      <button type="button" class="post__avatar touch-target" aria-label="查看主页" @click="onOpenProfile">
        <AppAvatar
          :src="post.author.avatarUrl ?? ''"
          :name="post.author.displayName"
          :seed="post.author.id"
          :size="40"
        />
      </button>
      <div class="post__who">
        <button type="button" class="post__name" @click="onOpenProfile">
          {{ post.author.displayName }}
        </button>
        <div class="post__meta">
          <span class="post__handle">@{{ post.author.username }}</span>
          <span v-if="timeText" class="post__dot" aria-hidden="true">·</span>
          <time v-if="timeText" class="post__time" :datetime="post.createdAt">{{ timeText }}</time>
        </div>
      </div>

      <div v-if="canDelete" ref="menuRef" class="post__menu-wrap">
        <button
          type="button"
          class="post__icon-btn touch-target"
          :aria-expanded="menuOpen"
          aria-label="更多操作"
          @click="toggleMenu"
        >
          <AppIcon name="more" :size="20" />
        </button>
        <div v-if="menuOpen" class="post__menu" role="menu">
          <button type="button" class="post__menu-item post__menu-item--danger" role="menuitem" @click="askDelete">
            <AppIcon name="trash" :size="16" />
            <span>删除</span>
          </button>
        </div>
      </div>
    </header>

    <!-- 正文：纯文本，不 v-html -->
    <div v-if="displayContent" class="post__body">
      <p class="post__text">
        <template v-for="(seg, i) in segments" :key="i">
          <a
            v-if="seg.kind === 'link'"
            class="post__link"
            :href="seg.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ seg.text }}</a
          >
          <template v-else>{{ seg.text }}</template>
        </template>
      </p>
      <button v-if="collapsible" type="button" class="post__more-text" @click="expanded = !expanded">
        {{ expanded ? '收起' : '全文' }}
      </button>
    </div>

    <!-- 附件 -->
    <MediaGrid
      v-if="post.attachments.length > 0"
      :attachments="post.attachments"
      @preview="onPreview"
    />

    <!-- 操作条 -->
    <footer class="post__actions">
      <button
        type="button"
        class="action touch-target"
        :class="{ 'action--liked': post.likedByMe }"
        :aria-pressed="post.likedByMe"
        aria-label="点赞"
        @click="emit('like', post.id)"
      >
        <AppIcon :name="post.likedByMe ? 'heart-filled' : 'heart'" :size="18" />
        <span v-if="post.likeCount > 0" class="action__count">{{ formatCount(post.likeCount) }}</span>
      </button>

      <button type="button" class="action touch-target" aria-label="评论" @click="onComment">
        <AppIcon name="comment" :size="18" />
        <span v-if="post.commentCount > 0" class="action__count">{{ formatCount(post.commentCount) }}</span>
      </button>

      <button
        type="button"
        class="action touch-target"
        :disabled="sharing"
        aria-label="复制链接"
        @click="onShare"
      >
        <AppIcon name="share" :size="18" />
      </button>
    </footer>

    <!-- 删除二次确认 -->
    <AppModal title="删除动态" :open="deleteOpen" :width="380" @close="deleteOpen = false">
      <p class="confirm">
        删除后无法恢复，评论与点赞也会一并消失。确定删除这条动态吗？
      </p>
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="deleteOpen = false" />
        <AppButton label="删除" tone="danger" @click="confirmDelete" />
      </template>
    </AppModal>
  </article>
</template>

<style scoped>
.post {
  display: flex;
  flex-direction: column;
  padding: var(--space-4, 16px);
  background: var(--app-panel, #fff);
  border: 1px solid var(--app-border, #e3e8ee);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--shadow-1, 0 1px 2px rgb(16 24 40 / 0.04));
}

/* ── 头部 ── */
.post__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3, 12px);
}

.post__avatar {
  flex: none;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  cursor: pointer;
}

.post__who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.post__name {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-text, #16202a);
  font-size: var(--text-md, 15px);
  font-weight: var(--weight-semibold, 600);
  line-height: var(--lh-snug, 1.35);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.post__name:hover {
  color: var(--color-brand-500, #1d88b0);
}

.post__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  min-width: 0;
  color: var(--app-text-faint, #9aa6b2);
  font-size: var(--text-xs, 12px);
}

.post__handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post__dot {
  flex: none;
}

.post__time {
  flex: none;
}

/* ── ⋯ 菜单 ── */
.post__menu-wrap {
  position: relative;
  flex: none;
}

.post__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--app-text-muted, #64717d);
  cursor: pointer;
}

.post__icon-btn:hover {
  background: var(--app-hover, #f0f3f6);
  color: var(--app-text, #16202a);
}

.post__menu {
  position: absolute;
  top: calc(100% + var(--space-1, 4px));
  right: 0;
  z-index: var(--z-sticky, 10);
  min-width: 132px;
  padding: var(--space-1, 4px);
  background: var(--app-panel-raised, #fff);
  border: 1px solid var(--app-border, #e3e8ee);
  border-radius: var(--radius-md, 10px);
  box-shadow: var(--shadow-2, 0 8px 24px rgb(16 24 40 / 0.12));
}

.post__menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  width: 100%;
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border: 0;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--app-text, #16202a);
  font-size: var(--text-sm, 13px);
  text-align: left;
  cursor: pointer;
}

.post__menu-item--danger {
  color: var(--color-danger-500, #d64545);
}

.post__menu-item--danger:hover {
  background: var(--app-hover, #f0f3f6);
}

/* ── 正文 ── */
.post__body {
  margin-top: var(--space-3, 12px);
}

.post__text {
  margin: 0;
  color: var(--app-text, #16202a);
  font-size: var(--text-md, 15px);
  line-height: var(--lh-relaxed, 1.65);
  /* 保留用户输入的换行与连续空格；同时允许超长 URL 断行 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.post__link {
  color: var(--color-brand-600, #166f92);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.post__link:hover {
  text-decoration: underline;
}

.post__more-text {
  margin-top: var(--space-1, 4px);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-brand-600, #166f92);
  font-size: var(--text-sm, 13px);
  cursor: pointer;
}

/* ── 操作条 ── */
.post__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  margin-top: var(--space-3, 12px);
  padding-top: var(--space-2, 8px);
  border-top: 1px solid var(--app-border, #e3e8ee);
}

.action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  min-height: 32px;
  padding: 0 var(--space-2, 8px);
  border: 0;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--app-text-muted, #64717d);
  font-size: var(--text-sm, 13px);
  cursor: pointer;
  transition:
    background var(--dur-fast, 120ms) var(--ease-out, ease-out),
    color var(--dur-fast, 120ms) var(--ease-out, ease-out);
}

.action:hover {
  background: var(--app-hover, #f0f3f6);
}

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.action:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 2px var(--color-brand-500, #1d88b0));
}

/* 点赞态：用危险色（心形是唯一的高饱和强调，和消息侧的「未读」语义区分开） */
.action--liked,
.action--liked:hover {
  color: var(--color-danger-500, #d64545);
}

.action__count {
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.confirm {
  margin: 0;
  color: var(--app-text-muted, #64717d);
  font-size: var(--text-sm, 13px);
  line-height: var(--lh-normal, 1.5);
}
</style>
