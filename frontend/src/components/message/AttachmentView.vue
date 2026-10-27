<script setup lang="ts">
/**
 * 附件展示：图片缩略图（可点开灯箱）或文件卡片（图标 + 名字 + 大小 + 下载）。
 *
 * 【为什么不能把 attachment.url 直接塞进 <img src>】
 * `GET /api/v1/uploads/:id` **必须带 Bearer**（不允许匿名，这是安全底线）。
 * 浏览器的 `<img src>` / `<a href>` 无法自带 Authorization 头，所以：
 *   - 拼 `?token=` → 凭据进 URL，会落进历史记录/日志/Referer，**禁止**；
 *   - 直接放 url → 401，图永远裂。
 * 唯一正确路径：axios 带 Bearer 取字节（responseType:'blob'）→
 * `URL.createObjectURL` → 把 **blob URL** 交给 `<img>`。blob URL 是同源临时
 * 句柄，不含凭据，且用完必须 revoke（否则每张图泄漏一份内存）。
 *
 * 【降级策略（UX2 修订）】旧实现「图片加载失败 → 退回文件卡片」。现在不再这么做：
 * `kind === 'image'` **永远**渲染缩略图形态，失败时在缩略图位置给出明确的
 * 「图片加载失败」+ 「重试」按钮。理由见下方 `showAsImage` 的注释 ——
 * 因为把权限 bug 伪装成「文件」会让用户完全无法判断发生了什么。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import AppModal from '@/components/base/AppModal.vue'
import { fetchAttachmentBlob, revokeObjectUrl } from '@/api/uploads'
import {
  attachmentAltText,
  attachmentIconKind,
  formatBytes,
  isImageAttachment,
  type AttachmentIconKind,
} from '@/utils/attachments'
import type { Attachment } from '@/types/domain'

const props = withDefaults(
  defineProps<{
    attachment: Attachment
    /** 是否自己发的（影响圆角/对齐，纯视觉） */
    mine?: boolean
  }>(),
  { mine: false },
)

const emit = defineEmits<{ download: [Attachment] }>()

const iconKind = computed<AttachmentIconKind>(() => attachmentIconKind(props.attachment))
const isImage = computed(() => isImageAttachment(props.attachment))

/** blob URL（图片）。null = 未就绪或已失败。 */
const imageUrl = ref<string | null>(null)
const loading = ref(false)
const failed = ref(false)
/** 灯箱（全屏预览） */
const lightboxOpen = ref(false)

let controller: AbortController | null = null
/** 需要 revoke 的 URL 统一放这里，避免不同路径漏释放。 */
function releaseUrl(): void {
  revokeObjectUrl(imageUrl.value)
  imageUrl.value = null
}

/**
 * 取图：串行化 + 可取消。
 * 附件切换（虚拟列表复用组件）或卸载时 abort，防止旧请求的 blob 覆盖新图。
 */
async function loadImage(): Promise<void> {
  releaseUrl()
  failed.value = false
  if (!isImage.value) return
  controller?.abort()
  controller = new AbortController()
  const myController = controller
  loading.value = true
  try {
    const blob = await fetchAttachmentBlob(props.attachment)
    if (myController.signal.aborted) return
    imageUrl.value = URL.createObjectURL(blob)
  } catch {
    if (!myController.signal.aborted) failed.value = true
  } finally {
    if (!myController.signal.aborted) loading.value = false
  }
}

watch(
  () => [props.attachment.id, isImage.value] as const,
  () => {
    void loadImage()
  },
  { immediate: true },
)

onUnmounted(() => {
  controller?.abort()
  controller = null
  releaseUrl()
})

/** 图片真的加载失败（blob 有效但解码失败，例如声称 png 实际不是）。 */
function onImageError(): void {
  failed.value = true
  releaseUrl()
}

/**
 * 图片一律走缩略图分支。
 *
 * 【为什么不再「失败就降级成文件卡片」】旧实现在 403 时把图片换成文件卡片，
 * 看起来是「优雅降级」，实际是把问题藏了：用户明明发了张图，对方收到的却是
 * 一个「xxx.png · 12 KB」的文件卡片，完全不知道为什么、也不知道能不能修复。
 * 而且那次 403 的根因是后端 readUpload 的权限判断（附件只允许属主读），
 * 与「这张图坏了」无关 —— 前端降级让后端 bug 看起来像前端选择。
 *
 * ux2-contract §八 已修权限：同会话成员可读。因此前端承诺：
 *   kind === 'image' → **永远**是缩略图形态；加载失败就在缩略图位置显示
 *   明确的失败态 + 「重试」按钮（见模板），不伪装成文件。
 *
 * 真正的文件（kind === 'file'）仍然走文件卡片 —— e2e-attachment.mjs 依赖
 * `.bubble--attach .att--file` 与 `.att__name--under`，两者都保住了。
 */
const showAsImage = computed(() => isImage.value)
const sizeText = computed(() => formatBytes(props.attachment.size))
/** 无障碍替代文本（纯字符串插值，不进 innerHTML）。 */
const altText = computed(() => attachmentAltText(props.attachment))

function openLightbox(): void {
  // 加载失败时点缩略图不打开灯箱（里面只会显示「图片不可用」），改为重试加载
  if (!imageUrl.value) {
    void loadImage()
    return
  }
  lightboxOpen.value = true
}

function onDownload(): void {
  emit('download', props.attachment)
}
</script>

<template>
  <!-- 图片：缩略图 + 点击灯箱。失败也不降级成文件卡片（见 script 顶部说明） -->
  <div v-if="showAsImage" class="att att--image" :class="{ 'att--mine': mine }">
    <button
      class="att__thumb-btn"
      type="button"
      :aria-label="imageUrl ? `预览图片 ${attachment.name}` : failed ? `重新加载图片 ${attachment.name}` : `正在加载 ${attachment.name}`"
      @click="openLightbox"
    >
      <img
        v-if="imageUrl"
        class="att__thumb"
        :src="imageUrl"
        :alt="altText"
        decoding="async"
        @error="onImageError"
      />
      <span v-else class="att__thumb-skeleton" :class="{ 'att__thumb-skeleton--failed': failed }">
        {{ failed ? '图片加载失败' : '加载中…' }}
      </span>
    </button>
    <a
      class="att__name att__name--under"
      href="#"
      :title="attachment.name"
      @click.prevent="onDownload"
      >{{ attachment.name }} · {{ sizeText }}</a
    >
    <!-- 失败态给一条可见的自救路径：不重进会话也能再试一次 -->
    <button v-if="failed" class="att__retry" type="button" @click="loadImage">重试</button>

    <AppModal :title="attachment.name" :open="lightboxOpen" :width="720" @close="lightboxOpen = false">
      <div class="lightbox">
        <img v-if="imageUrl" class="lightbox__img" :src="imageUrl" :alt="altText" />
        <p v-else class="lightbox__fallback">图片不可用</p>
      </div>
    </AppModal>
  </div>

  <!-- 文件卡片（仅 kind === 'file'） -->
  <button
    v-else
    class="att att--file"
    :class="{ 'att--mine': mine }"
    type="button"
    :title="`${attachment.name}（${sizeText}）`"
    @click="onDownload"
  >
    <span class="att__icon" :class="`att__icon--${failed ? 'other' : iconKind}`" aria-hidden="true">
      <!-- 图标自绘：base/AppIcon 的 name 联合里没有 file/image/pdf 这些，
           且它由视觉 agent 独占，不能加；这里用内联 SVG（无外部素材）。 -->
      <svg v-if="(failed ? 'other' : iconKind) === 'pdf'" viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M6 2h8l4 4v16H6z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M9 13h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      <svg
        v-else-if="(failed ? 'other' : iconKind) === 'zip'"
        viewBox="0 0 24 24"
        width="20"
        height="20"
      >
        <path
          d="M6 2h8l4 4v16H6z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M10 11h2M10 14h2M10 17h2" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      <svg
        v-else-if="(failed ? 'other' : iconKind) === 'text'"
        viewBox="0 0 24 24"
        width="20"
        height="20"
      >
        <path
          d="M6 2h8l4 4v16H6z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M9 11h6M9 14h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      <svg
        v-else-if="(failed ? 'other' : iconKind) === 'image'"
        viewBox="0 0 24 24"
        width="20"
        height="20"
      >
        <rect
          x="3"
          y="5"
          width="18"
          height="14"
          rx="2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
        <circle cx="9" cy="10" r="1.6" fill="currentColor" />
        <path d="M4 17l5-4 3 2.5 3-2 5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M6 2h8l4 4v16H6z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
    </span>

    <span class="att__main">
      <span class="att__name">{{ attachment.name }}</span>
      <span class="att__meta">{{ sizeText }} · 点击下载</span>
    </span>

    <span class="att__dl" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16">
        <path
          d="M12 4v11m0 0l-4-4m4 4l4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </span>
  </button>
</template>

<style scoped>
/* ── 图片 ─────────────────────────────────────────────────────── */
.att--image {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
}
.att__thumb-btn {
  display: block;
  padding: 0;
  border: none;
  background: transparent;
  cursor: zoom-in;
  border-radius: 8px;
  overflow: hidden;
  line-height: 0;
  /* 触摸热区：图片本身够大，但空态骨架也要能点 */
  min-width: 80px;
}
.att__thumb {
  display: block;
  max-width: min(280px, 70vw);
  max-height: 280px;
  width: auto;
  height: auto;
  border-radius: 8px;
  object-fit: cover;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att__thumb-btn:focus-visible {
  outline: 2px solid var(--color-brand-500, currentColor);
  outline-offset: 2px;
}
.att__thumb-skeleton {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 120px;
  min-height: 80px;
  padding: 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--app-text-muted);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att__thumb-skeleton--failed {
  color: var(--color-danger-500);
}
.att__name--under {
  font-size: 11px;
  color: inherit;
  opacity: 0.72;
  text-decoration: none;
  max-width: min(280px, 70vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att__name--under:hover {
  text-decoration: underline;
}
/* 图片加载失败时的自救按钮（不再降级成文件卡片，必须给出可见出路） */
.att__retry {
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--color-danger-500, currentColor) 45%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--color-danger-500, inherit);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  min-height: 28px;
}
.att__retry:hover {
  background: color-mix(in srgb, var(--color-danger-500, currentColor) 12%, transparent);
}

/* ── 文件卡片 ─────────────────────────────────────────────────── */
.att--file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(280px, 68vw);
  max-width: 100%;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 5%, transparent);
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}
.att--file:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.att--file:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
.att__icon {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--att-icon-color, currentColor);
}
.att__icon--pdf {
  color: #d64545;
}
.att__icon--zip {
  color: #c08a2e;
}
.att__icon--text {
  color: #4a86b8;
}
.att__icon--image {
  color: #2f9e6e;
}
.att__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.att__name {
  display: block;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att__meta {
  font-size: 11px;
  opacity: 0.68;
}
.att__dl {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: inherit;
  opacity: 0.65;
}
.att--file:hover .att__dl {
  opacity: 1;
}

/* ── 灯箱 ─────────────────────────────────────────────────────── */
.lightbox {
  display: flex;
  align-items: center;
  justify-content: center;
  max-height: 72vh;
  overflow: auto;
}
.lightbox__img {
  max-width: 100%;
  max-height: 72vh;
  width: auto;
  height: auto;
  border-radius: 6px;
  object-fit: contain;
}
.lightbox__fallback {
  margin: 0;
  font-size: 13px;
  color: var(--app-text-muted);
}

/* ── 手机 ─────────────────────────────────────────────────────── */
@media (max-width: 767px) {
  .att__thumb {
    max-width: min(240px, 62vw);
    max-height: 240px;
  }
  /* 文件卡片至少 44px 高，满足触控热区 */
  .att--file {
    min-height: 44px;
    width: min(240px, 62vw);
  }
  .att--file:hover {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
}
</style>
