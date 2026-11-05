<script setup lang="ts">
/**
 * 附件集合展示（每次渲染**一组**附件，不是单个）。
 *
 * ── 为什么从「单附件」改成「集合」
 * v2 起一条消息可以带 1..9 个附件（`Message.attachments: Attachment[]`）。
 * 若仍按单附件渲染，调用点就得自己写一层 v-for 再拼网格，布局规则会散落到
 * 每个调用点；而「几张图该几列」这类规则一旦不一致，同一条消息在会话里和
 * 置顶条里会长得不一样。所以集合语义收敛在这里：**传数组进来，组件决定排版**。
 *
 * ── 布局规则（docs/v2/UI-V2.md §5）
 *   - 1 个媒体 → 单张大图（≤260×260，`object-fit: cover`，点开全屏预览）
 *   - 2–4 个媒体 → 2 列网格
 *   - 5–9 个媒体 → 3 列网格
 *   - 视频单独占一行（≤320 宽），永远给 `controls`，不做 canvas 截帧封面
 *     （截帧要拉流+解码+drawImage，跨域/CSP/编解码任一环失败就是白块，
 *      收益只是「好看一点」，不值）
 *   - 文件永远是卡片（图标 + 名字 + 大小 + 下载），不参与网格
 *
 * ── 安全硬规则：图片/视频的 src 必须是 blob URL
 * `GET /api/v1/uploads/:id` 必须带 Bearer，`<img src>` / `<video src>` 带不了头。
 *   - 拼 `?token=` → 凭据进 URL，会落进历史记录/日志/Referer，**禁止**；
 *   - 直接放 attachment.url → 401，图永远裂。
 * 唯一正确路径：axios 带 Bearer 取字节 → `URL.createObjectURL` → blob URL。
 * blob URL 是同源临时句柄、不含凭据，**用完必须 revoke**（否则每张图泄漏一份
 * 内存；一个会话翻到底能泄漏几十 MB）。
 *
 * ── 降级：失败退化为占位块，绝不崩、也不伪装成文件
 * 图片加载失败时**仍然**是 `.att--image` 形态，占位块里写「图片加载失败」+
 * 「重试」。旧实现失败就换成文件卡片，看起来是优雅降级，实际把权限 bug 藏成了
 * 「这张图就是文件」，用户完全无法判断发生了什么。
 *
 * ── e2e 类名契约（改样式前先看 e2e-attachment.mjs / e2e-ux2-p0.mjs）
 * 必须保住：`.att.att--image`、`img.att__thumb`、`.att__thumb-btn`（aria-label
 * 以「预览图片」开头）、`.att__name--under`、`.att.att--file`、
 * 灯箱里的 `.mask .panel .panel__title` 与 `.mask .lightbox__img`，以及
 * 「图片消息里不出现 .att--file」「文件消息里不出现 .att--image」。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { downloadAttachment, fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import { copyTextToClipboard, type ContextMenuItem } from '@/utils/contextMenu'
import { useUiStore } from '@/stores/ui'
import {
  attachmentAltText,
  attachmentIconKind,
  formatBytes,
  videoAltText,
  type AttachmentIconKind,
} from '@/utils/attachments'
import { collectFocusables, dialogKeyAction } from '@/utils/dialogA11y'
import type { Attachment } from '@/types/domain'

const props = withDefaults(
  defineProps<{
    /** 一组附件。空数组或 undefined 时不渲染任何东西。 */
    attachments: Attachment[]
    /** 对齐语义（只影响文件卡片的靠边与网格的排布方向，纯视觉）。 */
    align?: 'self' | 'peer'
  }>(),
  { align: 'peer' },
)

const emit = defineEmits<{
  /** 请求下载某个附件（父级负责 toast 失败提示）。 */
  download: [Attachment]
  /** 图片点击准备打开预览（供父级埋点/关闭工具条；可选）。 */
  preview: [Attachment]
}>()

/* ── 分组 ─────────────────────────────────────────────────────── */

/** 参与网格排版的媒体（图片 + 视频），保持服务端给定顺序。 */
const media = computed(() =>
  props.attachments.filter((a) => a.kind === 'image' || a.kind === 'video'),
)
const images = computed(() => props.attachments.filter((a) => a.kind === 'image'))
const files = computed(() => props.attachments.filter((a) => a.kind === 'file'))

/**
 * 网格列数：2–4 个 2 列，5–9 个 3 列。
 * 1 个走「单张」分支（不套网格），否则单格会占满整行且被 aspect-ratio 压扁。
 */
const columns = computed(() => (media.value.length <= 4 ? 2 : 3))
const isSingle = computed(() => media.value.length === 1)
/** 单个媒体是视频时，整条消息就是一块视频（不套 aspect-ratio 方框）。 */
const singleIsVideo = computed(() => isSingle.value && media.value[0]?.kind === 'video')

/**
 * 单媒体分支读取的那个附件。
 *
 * 【为什么要有这个 computed】tsconfig 开了 `noUncheckedIndexedAccess`，模板里
 * 直接写 `single.id` 会被判为 `Attachment | undefined`（31 处报错）。模板表达式
 * 无法用非空断言收窄，所以在这里给出一个**结构完整**的兜底对象：只有当 media 为空
 * 时才会取到它，而那种情况下模板的 `v-if="isSingle && !singleIsVideo"` / 
 * `v-else-if="singleIsVideo"` 两个分支都不会渲染 —— 兜底对象永远不会出现在 DOM 里。
 */
const PLACEHOLDER_ATTACHMENT: Attachment = {
  id: '',
  name: '',
  mimeType: '',
  size: 0,
  kind: 'file',
  url: '',
  createdAt: '',
}
const single = computed<Attachment>(() => media.value[0] ?? PLACEHOLDER_ATTACHMENT)

/* ── blob URL 管理 ────────────────────────────────────────────── */

/** attachmentId → blob URL。 */
const urls = ref<Record<string, string>>({})
/** attachmentId → 加载失败标记。 */
const failed = ref<Record<string, boolean>>({})
/** attachmentId → 正在加载。 */
const loadingIds = ref<Record<string, boolean>>({})

let controller: AbortController | null = null

function revokeAll(): void {
  for (const url of Object.values(urls.value)) revokeObjectUrl(url)
  urls.value = {}
}

/**
 * 取齐所有媒体的 blob URL。
 *
 * 每次入参变化都整批重取（已取到的跳过），并 revoke 掉不再需要的旧 URL。
 * 用单一 AbortController 串行化：附件列表切换（虚拟列表复用节点）时旧请求
 * 必须作废，否则旧 blob 会覆盖新图 —— 表现为「图片串到别的消息上」。
 */
async function loadMedia(): Promise<void> {
  controller?.abort()
  controller = new AbortController()
  const ctrl = controller

  const wanted = media.value
  const wantedIds = new Set(wanted.map((a) => a.id))

  // 清掉不再需要的 URL（也覆盖「服务端换了一批附件」的情况）
  for (const [id, url] of Object.entries(urls.value)) {
    if (!wantedIds.has(id)) {
      revokeObjectUrl(url)
      const nextUrls = { ...urls.value }
      delete nextUrls[id]
      urls.value = nextUrls
    }
  }
  for (const id of Object.keys(failed.value)) {
    if (!wantedIds.has(id)) {
      const next = { ...failed.value }
      delete next[id]
      failed.value = next
    }
  }

  await Promise.all(
    wanted.map(async (att) => {
      if (urls.value[att.id]) return
      const nextLoading = { ...loadingIds.value, [att.id]: true }
      loadingIds.value = nextLoading
      try {
        const url = await fetchObjectUrl({ id: att.id }, ctrl.signal)
        if (ctrl.signal.aborted) {
          // 迟到的结果也要释放，否则这份 blob 永远没人 revoke
          revokeObjectUrl(url)
          return
        }
        urls.value = { ...urls.value, [att.id]: url }
        const nextFailed = { ...failed.value }
        delete nextFailed[att.id]
        failed.value = nextFailed
      } catch {
        if (!ctrl.signal.aborted) failed.value = { ...failed.value, [att.id]: true }
      } finally {
        const done = { ...loadingIds.value }
        delete done[att.id]
        loadingIds.value = done
      }
    }),
  )
}

/** 单个附件重试（失败占位块上的「重试」按钮）。 */
async function retryOne(att: Attachment): Promise<void> {
  const nextFailed = { ...failed.value }
  delete nextFailed[att.id]
  failed.value = nextFailed
  try {
    const url = await fetchObjectUrl({ id: att.id })
    urls.value = { ...urls.value, [att.id]: url }
  } catch {
    failed.value = { ...failed.value, [att.id]: true }
  }
}

watch(
  () => props.attachments.map((a) => `${a.id}:${a.kind}`).join(','),
  () => {
    void loadMedia()
  },
  { immediate: true },
)

onUnmounted(() => {
  controller?.abort()
  controller = null
  revokeAll()
})

/* ── 视频元信息 ───────────────────────────────────────────────── */

/** attachmentId → 时长（秒）。拿不到就留空，UI 不显示时长而不是显示 0:00。 */
const durations = ref<Record<string, number>>({})

function onVideoMeta(att: Attachment, e: Event): void {
  const el = e.target as HTMLVideoElement | null
  const d = el?.duration
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
    durations.value = { ...durations.value, [att.id]: d }
  }
}

function durationText(att: Attachment): string {
  const secs = durations.value[att.id]
  if (secs === undefined) return ''
  const total = Math.round(secs)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/* ── 灯箱（全屏预览） ─────────────────────────────────────────── */

/** 预览中的图片下标；-1 = 灯箱关闭。 */
const lightboxIndex = ref(-1)
const lightboxOpen = computed(() => lightboxIndex.value >= 0)
const currentImage = computed<Attachment | null>(() =>
  lightboxIndex.value >= 0 ? (images.value[lightboxIndex.value] ?? null) : null,
)
const currentUrl = computed<string | null>(() => {
  const att = currentImage.value
  return att ? (urls.value[att.id] ?? null) : null
})

const panelRef = ref<HTMLElement | null>(null)
/** 打开前的焦点，关闭时归还（无障碍：弹层不得吞焦点，e2e 有断言）。 */
let restoreFocus: HTMLElement | null = null

function openLightbox(att: Attachment): void {
  const idx = images.value.findIndex((a) => a.id === att.id)
  if (idx < 0) {
    // 还没取到 blob（或取失败）：不打开灯箱（里面只会是「图片不可用」），改为重试
    if (!urls.value[att.id]) void retryOne(att)
    return
  }
  emit('preview', att)
  const active = document.activeElement
  restoreFocus = active instanceof HTMLElement ? active : null
  lightboxIndex.value = idx
  void nextTick(() => {
    const list = collectFocusables(panelRef.value)
    const close = list.find((el) => el.getAttribute('aria-label') === '关闭')
    ;(close ?? list[0] ?? panelRef.value)?.focus()
  })
}

function closeLightbox(): void {
  lightboxIndex.value = -1
  const target = restoreFocus
  restoreFocus = null
  if (target && target.isConnected) target.focus()
}

function stepImage(delta: number): void {
  const total = images.value.length
  if (total <= 1) return
  lightboxIndex.value = (lightboxIndex.value + delta + total) % total
}

function focusIndexIn(list: HTMLElement[]): number {
  const active = document.activeElement
  if (!active) return -1
  return list.indexOf(active as HTMLElement)
}

/**
 * 灯箱键盘处理。
 *
 * 复用 `@/utils/dialogA11y` 的判定（与 AppModal / MobileNav 同一份规则），
 * 只额外接管左右方向键切图 —— Tab 循环、Esc 关闭都不自己再写一遍。
 */
function onLightboxKeydown(e: KeyboardEvent): void {
  if (!lightboxOpen.value) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (images.value.length > 1) {
      e.preventDefault()
      stepImage(e.key === 'ArrowLeft' ? -1 : 1)
    }
    return
  }
  const list = collectFocusables(panelRef.value)
  const action = dialogKeyAction({
    key: e.key,
    shiftKey: e.shiftKey,
    dialogOpen: true,
    focusableCount: list.length,
    focusIndex: focusIndexIn(list),
    isComposing: e.isComposing,
  })
  if (!action) return
  if (action.type === 'close') {
    e.preventDefault()
    closeLightbox()
    return
  }
  e.preventDefault()
  const el = action.target === 'first' ? list[0] : list[list.length - 1]
  el?.focus()
}

watch(lightboxOpen, (open) => {
  if (open) window.addEventListener('keydown', onLightboxKeydown)
  else window.removeEventListener('keydown', onLightboxKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onLightboxKeydown)
})

/* ── 文件卡片 ─────────────────────────────────────────────────── */

const downloadBusy = ref<Record<string, boolean>>({})

function iconKindOf(att: Attachment): AttachmentIconKind {
  return attachmentIconKind(att)
}

function sizeTextOf(att: Attachment): string {
  return formatBytes(att.size)
}

function onFileDownload(att: Attachment): void {
  emit('download', att)
}

/* ── 图片右键菜单 ───────────────────────────────────────────── */

const ui = useUiStore()

/**
 * 图片的右键菜单项。
 *
 * 【为什么从附件自己的方法里发】这里能拿到完整的 `Attachment`
 * 和已经取好的 blob URL；交给全局菜单只需要「菜单项 + 坐标」。
 *
 * 【关于「复制图片地址」的语义】附件 `Attachment.url` 是
 * `/api/v1/uploads/<id>`，**需要 Bearer 鉴权**，粘到浏览器地址栏会 401。
 * 所以复制的不能是它 —— 这里复制的是当前页面的图片直链：
 * 有 blob URL 时复制 `blob:` 地址（同一标签页内可打开预览）。
 * 这不是「能分享给别人的链接」，所以文案写「复制图片地址」而不是「复制链接」。
 * 真要分享必须走服务端签名 URL，那是后端能力，本轮不做。
 */
function imageMenuItems(att: Attachment): ContextMenuItem[] {
  const blobUrl = urls.value[att.id]
  const isVideo = att.kind === 'video'
  const noun = isVideo ? '视频' : '图片'
  return [
    {
      id: 'save-media',
      label: `保存${noun}`,
      disabled: !blobUrl,
      run: async () => {
        try {
          await downloadAttachment(att)
        } catch {
          // 与 MessageBubble 的下载失败文案对齐；不在菜单层自己拼接细节
          ui.toast('下载失败，附件可能已被清理', 'error')
        }
      },
    },
    {
      id: 'copy-media-url',
      label: `复制${noun}地址`,
      disabled: !blobUrl,
      run: async () => {
        const ok = await copyTextToClipboard(blobUrl ?? '')
        ui.toast(ok ? `${noun}地址已复制` : '复制失败，请稍后重试', ok ? 'success' : 'error')
      },
    },
  ]
}

/**
 * 图片/视频格右键：弹出本项目菜单。
 *
 * 这里必须 `preventDefault` —— 全局处理器看到 `defaultPrevented` 才会让位
 * （见 `App.vue` 的 `onGlobalContextMenu`），否则会先弹图片菜单、
 * 紧接着被全局默认菜单盖掉。
 *
 * 触屏设备上长按不会触发 `contextmenu`，而是浏览器自己的图片长按菜单；
 * 那条路径属于移动端长按场景（task-3），这里不加触摸处理，避免与长按手势
 * 冲突：手指压在图片上准备滚动时会误弹菜单。
 */
function onImageContextMenu(att: Attachment, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  ui.openContextMenu(e.clientX, e.clientY, imageMenuItems(att))
}

/** 视频时长文案（无 metadata 时为空串）。 */
function videoTime(att: Attachment): string {
  return durationText(att)
}

function imageAlt(att: Attachment): string {
  return attachmentAltText(att)
}

function videoAlt(att: Attachment): string {
  return videoAltText(att)
}
</script>

<template>
  <div
    v-if="attachments.length > 0"
    class="atts"
    :class="[`atts--${align}`, { 'atts--single': isSingle && !singleIsVideo }]"
  >
    <!-- ── 媒体区（图片 / 视频） ─────────────────────────────────── -->
    <template v-if="media.length > 0">
      <!-- 单张图片：大图，≤260×260 -->
      <div
        v-if="isSingle && !singleIsVideo"
        class="att att--image att--hero"
        @contextmenu="onImageContextMenu(single, $event)"
      >
        <button
          class="att__thumb-btn"
          type="button"
          :aria-label="
            urls[single.id]
              ? `预览图片 ${single.name}`
              : failed[single.id]
                ? `重新加载图片 ${single.name}`
                : `正在加载 ${single.name}`
          "
          @click="openLightbox(single)"
        >
          <img
            v-if="urls[single.id]"
            class="att__thumb"
            :src="urls[single.id]"
            :alt="imageAlt(single)"
            decoding="async"
            @error="failed = { ...failed, [single.id]: true }"
          />
          <span
            v-else
            class="att__thumb-skeleton"
            :class="{ 'att__thumb-skeleton--failed': failed[single.id] }"
            >{{ failed[single.id] ? '图片加载失败' : '加载中…' }}</span
          >
        </button>
        <!-- e2e-attachment.mjs 依赖 `.att__name--under` 里的「文件名 · 大小」 -->
        <a class="att__name att__name--under" href="#" :title="single.name" @click.prevent="onFileDownload(single)"
          >{{ single.name }} · {{ sizeTextOf(single) }}</a
        >
        <button v-if="failed[single.id]" class="att__retry" type="button" @click="retryOne(single)">
          重试
        </button>
      </div>

      <!-- 单个视频：占满宽度，≤320px -->
      <div
        v-else-if="singleIsVideo"
        class="att att--video att--video-single"
        @contextmenu="onImageContextMenu(single, $event)"
      >
        <video
          v-if="urls[single.id]"
          class="att__video"
          :src="urls[single.id]"
          controls
          preload="metadata"
          playsinline
          :aria-label="videoAlt(single)"
          @loadedmetadata="onVideoMeta(single, $event)"
        ></video>
        <div v-else class="att__video-skeleton" :class="{ 'att__video-skeleton--failed': failed[single.id] }">
          <span>{{ failed[single.id] ? '视频加载失败' : '加载中…' }}</span>
          <button v-if="failed[single.id]" class="att__retry" type="button" @click="retryOne(single)">
            重试
          </button>
        </div>
        <div class="att__video-bar">
          <a class="att__name att__name--under" href="#" :title="single.name" @click.prevent="onFileDownload(single)">
            {{ single.name }}
          </a>
          <span v-if="videoTime(single)" class="att__duration">{{ videoTime(single) }}</span>
        </div>
      </div>

      <!-- 2–9 个媒体：网格（2–4 → 2 列，5–9 → 3 列） -->
      <div v-else class="att__grid" :style="{ '--att-cols': columns }">
        <div
          v-for="att in media"
          :key="att.id"
          class="att att--cell"
          :class="`att--${att.kind}`"
          @contextmenu="onImageContextMenu(att, $event)"
        >
          <!-- 图片格 -->
          <template v-if="att.kind === 'image'">
            <button
              class="att__thumb-btn"
              type="button"
              :aria-label="urls[att.id] ? `预览图片 ${att.name}` : `正在加载 ${att.name}`"
              @click="openLightbox(att)"
            >
              <img
                v-if="urls[att.id]"
                class="att__thumb"
                :src="urls[att.id]"
                :alt="imageAlt(att)"
                decoding="async"
                @error="failed = { ...failed, [att.id]: true }"
              />
              <span v-else class="att__thumb-skeleton" :class="{ 'att__thumb-skeleton--failed': failed[att.id] }">{{
                failed[att.id] ? '加载失败' : ''
              }}</span>
            </button>
          </template>
          <!-- 视频格 -->
          <template v-else>
            <video
              v-if="urls[att.id]"
              class="att__video att__video--cell"
              :src="urls[att.id]"
              controls
              preload="metadata"
              playsinline
              :aria-label="videoAlt(att)"
              @loadedmetadata="onVideoMeta(att, $event)"
            ></video>
            <span v-else class="att__thumb-skeleton" :class="{ 'att__thumb-skeleton--failed': failed[att.id] }">{{
              failed[att.id] ? '加载失败' : ''
            }}</span>
          </template>
        </div>
      </div>
    </template>

    <!-- ── 文件卡片区 ────────────────────────────────────────────── -->
    <div v-if="files.length > 0" class="att__files">
      <button
        v-for="att in files"
        :key="att.id"
        class="att att--file"
        type="button"
        :title="`${att.name}（${sizeTextOf(att)}）`"
        :aria-label="`下载文件 ${att.name}（${sizeTextOf(att)}）`"
        :disabled="downloadBusy[att.id] === true"
        @click="onFileDownload(att)"
      >
        <span class="att__icon" :class="`att__icon--${iconKindOf(att)}`" aria-hidden="true">
          <!-- 图标自绘：AppIcon 的 name 联合里没有 pdf/zip/text/file 这些分类，
               且它由视觉 agent 独占，不能加；这里用内联 SVG（无外部素材）。 -->
          <svg v-if="iconKindOf(att) === 'pdf'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M9 13h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'zip'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M10 11h2M10 14h2M10 17h2" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'text'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M9 11h6M9 14h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'image'" viewBox="0 0 24 24" width="20" height="20">
            <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
            <circle cx="9" cy="10" r="1.6" fill="currentColor" />
            <path d="M4 17l5-4 3 2.5 3-2 5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'video'" viewBox="0 0 24 24" width="20" height="20">
            <rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M16 10l5-3v10l-5-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'audio'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M9 18V6l9-2v12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <circle cx="7" cy="18" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" />
            <circle cx="16" cy="16" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'doc'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M9 12h6M9 15h6M9 18h3" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'sheet'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M9 11h6M9 14h6M9 17h6M12 11v6" fill="none" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <svg v-else-if="iconKindOf(att) === 'slide'" viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <rect x="9" y="11" width="6" height="5" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M12 16v2" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20">
            <path d="M6 2h8l4 4v16H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M14 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>

        <span class="att__main">
          <span class="att__name">{{ att.name }}</span>
          <span class="att__meta">{{ sizeTextOf(att) }} · 点击下载</span>
        </span>

        <span class="att__dl" aria-hidden="true">
          <AppIcon name="download" :size="16" />
        </span>
      </button>
    </div>

    <!-- ── 全屏预览层（Teleport 到 body，脱离气泡的 overflow/层叠上下文） ──
         保留 `.mask .panel .panel__title` 与 `.lightbox__img` 三个 e2e 依赖的
         类名：e2e-attachment.mjs ATT-02 逐条断言它们存在且标题=文件名。 -->
    <Teleport to="body">
      <Transition name="lb">
        <div v-if="lightboxOpen" class="mask lb" @click.self="closeLightbox">
          <div
            ref="panelRef"
            class="panel lb__panel"
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            tabindex="-1"
          >
            <header class="panel__head lb__head">
              <h3 class="panel__title">{{ currentImage?.name }}</h3>
              <button class="panel__close" type="button" aria-label="关闭" @click="closeLightbox">
                <AppIcon name="close" :size="16" />
              </button>
            </header>
            <div class="panel__body lb__body">
              <button
                v-if="images.length > 1"
                class="lb__nav lb__nav--prev"
                type="button"
                aria-label="上一张"
                @click="stepImage(-1)"
              >
                ‹
              </button>
              <img v-if="currentUrl" class="lightbox__img" :src="currentUrl" :alt="currentImage?.name ?? '图片'" />
              <p v-else class="lightbox__fallback">图片不可用</p>
              <button
                v-if="images.length > 1"
                class="lb__nav lb__nav--next"
                type="button"
                aria-label="下一张"
                @click="stepImage(1)"
              >
                ›
              </button>
            </div>
            <footer v-if="images.length > 1" class="lb__foot">
              {{ lightboxIndex + 1 }} / {{ images.length }}
            </footer>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── 容器 ─────────────────────────────────────────────────────── */
.atts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}
.atts--self {
  align-items: flex-end;
}
.atts--peer {
  align-items: flex-start;
}

/* ── 图片：单张大图 ───────────────────────────────────────────── */
.att {
  min-width: 0;
  max-width: 100%;
}
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
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  line-height: 0;
  min-width: 80px;
  max-width: 100%;
}
.att__thumb-btn:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
.att__thumb {
  display: block;
  /* 单图上限 260×260（docs/v2/UI-V2.md §5）；cover 保证不变形 */
  width: auto;
  height: auto;
  max-width: min(260px, 62vw);
  max-height: 260px;
  object-fit: cover;
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att__name--under {
  font-size: var(--text-2xs, 11px);
  color: inherit;
  opacity: 0.72;
  text-decoration: none;
  max-width: min(260px, 62vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att__name--under:hover {
  text-decoration: underline;
}

/* ── 占位 / 失败态 ────────────────────────────────────────────── */
.att__thumb-skeleton {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 120px;
  min-height: 80px;
  padding: 12px;
  border-radius: var(--radius-md, 8px);
  font-size: var(--text-xs, 12px);
  line-height: 1.4;
  color: var(--app-text-muted);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att__thumb-skeleton--failed {
  color: var(--color-danger-500);
}
.att__retry {
  padding: 3px 10px;
  min-height: 28px;
  border: 1px solid color-mix(in srgb, var(--color-danger-500) 45%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--color-danger-500);
  font-family: inherit;
  font-size: var(--text-2xs, 11px);
  cursor: pointer;
}
.att__retry:hover {
  background: color-mix(in srgb, var(--color-danger-500) 12%, transparent);
}

/* ── 网格：2–4 → 2 列，5–9 → 3 列，每格 1:1 ──────────────────── */
.att__grid {
  display: grid;
  grid-template-columns: repeat(var(--att-cols, 2), minmax(0, 1fr));
  gap: 4px;
  width: min(260px, 62vw);
  max-width: 100%;
}
.att--cell {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att--cell .att__thumb-btn {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  border-radius: 0;
}
.att--cell .att__thumb {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: cover;
  border-radius: 0;
}
.att--cell .att__thumb-skeleton {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  border-radius: 0;
}

/* ── 视频 ─────────────────────────────────────────────────────── */
.att--video {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 单个视频占满气泡宽度，但不超过 320px */
  width: min(320px, 66vw);
  max-width: 100%;
}
.att__video {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-md, 8px);
  background: var(--color-ink-900);
}
.att__video--cell {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 0;
}
.att__video-skeleton {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md, 8px);
  font-size: var(--text-xs, 12px);
  color: var(--app-text-muted);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.att__video-skeleton--failed {
  color: var(--color-danger-500);
}
.att__video-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.att__duration {
  flex: 0 0 auto;
  font-size: var(--text-2xs, 11px);
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}

/* ── 文件卡片 ─────────────────────────────────────────────────── */
.att__files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 100%;
}
.att--file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(280px, 62vw);
  max-width: 100%;
  padding: 9px 10px;
  min-height: 44px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, currentColor 5%, transparent);
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast, 0.15s) ease;
}
.att--file:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.att--file:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
.att--file:disabled {
  cursor: progress;
  opacity: 0.6;
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
  color: var(--app-text-muted);
}
/* 分类色全部走主题变量，不写死十六进制（浅色/深色主题都能自适应） */
.att__icon--pdf {
  color: var(--color-danger-500);
}
.att__icon--zip {
  color: var(--color-warn-500);
}
.att__icon--text {
  color: var(--color-brand-500);
}
.att__icon--image {
  color: var(--color-success-500);
}
.att__icon--video {
  color: var(--color-accent-500);
}
.att__icon--audio {
  color: var(--color-accent-500);
}
.att__icon--doc {
  color: var(--color-brand-500);
}
.att__icon--sheet {
  color: var(--color-success-500);
}
.att__icon--slide {
  color: var(--color-warn-500);
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
  font-size: var(--text-sm, 13px);
  font-weight: var(--weight-medium, 500);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att__meta {
  font-size: var(--text-2xs, 11px);
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

/* ── 全屏预览层 ───────────────────────────────────────────────── */
.mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 预览层要压暗到底，否则图片边缘与背景混在一起看不清边界 */
  background: color-mix(in srgb, var(--color-ink-900) 92%, transparent);
  padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right)) calc(16px + var(--safe-bottom))
    calc(16px + var(--safe-left));
}
.lb__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(920px, 100%);
  max-height: 100%;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-xl, 16px);
  background: var(--app-panel);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  outline: none;
}
.lb__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding: var(--space-4, 16px) var(--space-4, 16px) var(--space-3, 12px);
  border-bottom: 1px solid var(--app-border);
}
.panel__title {
  margin: 0;
  font-size: var(--text-lg, 16px);
  font-weight: var(--weight-semibold, 600);
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.panel__close:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.panel__close:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}
.lb__body {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--space-3, 12px);
  min-height: 0;
  overflow: auto;
}
.lightbox__img {
  max-width: 100%;
  max-height: 74vh;
  width: auto;
  height: auto;
  border-radius: var(--radius-sm, 6px);
  object-fit: contain;
}
.lightbox__fallback {
  margin: 0;
  font-size: var(--text-sm, 13px);
  color: var(--app-text-muted);
}
.lb__nav {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--app-border);
  border-radius: 50%;
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.lb__nav:hover {
  background: var(--app-hover);
}
.lb__nav:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
.lb__foot {
  padding: 6px 12px 10px;
  text-align: center;
  font-size: var(--text-2xs, 11px);
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}
.lb-enter-active,
.lb-leave-active {
  transition: opacity var(--dur-fast, 0.15s) ease;
}
.lb-enter-from,
.lb-leave-to {
  opacity: 0;
}

/* ── 手机 ─────────────────────────────────────────────────────── */
@media (max-width: 767px) {
  .att__thumb {
    max-width: min(240px, 62vw);
    max-height: 240px;
  }
  .att__grid {
    width: min(240px, 62vw);
  }
  .att--video {
    width: min(300px, 70vw);
  }
  .att--file:hover {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  .lightbox__img {
    max-height: 68vh;
  }
  /* 触控：导航/关闭都放大到 44px */
  .panel__close,
  .lb__nav {
    width: 44px;
    height: 44px;
  }
}
</style>
