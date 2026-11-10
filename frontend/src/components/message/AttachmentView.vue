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
 * ── 布局规则（docs/v2/UI-V2.md §5，v2.6 起**按原图比例**）
 *   - 1 个媒体 → 单张图，只限最大宽/高（320×min(400, 46vh)），`object-fit: contain`
 *   - 2–4 个媒体 → 2 列网格；5–9 个 → 3 列网格；每格 `aspect-ratio` 取该图
 *     真实比例（`--att-ratio`，由 `<img @load>` 写入），不再是死板的 1:1
 *   - 加载策略：组件进入视口 400px 范围才开始取字节（IntersectionObserver），
 *     避免长会话滚动时把整屏外的图片一起拉下来
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
 * 以「预览图片」开头）、`.att.att--file`、
 * 灯箱里的 `.mask .panel .panel__title` 与 `.mask .lightbox__img`，以及
 * 「图片消息里不出现 .att--file」「文件消息里不出现 .att--image」。
 *
 * v2.5 起图片/视频**不再显示文件名与下载链接**（媒体消息只有媒体，下载走右键菜单），
 * 但文件名仍以 `.sr-only` 文本保留：e2e 用气泡 textContent 含文件名来定位消息。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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

/*
 * ── 视口懒加载（v2.6）
 *
 * 【为什么不能挂载即拉】一个会话翻到底有几百条带图消息，每条都要 1..9 份字节。
 * 旧实现 `watch(..., { immediate: true })` 意味着**节点一被 v-for 创建就发请求**：
 * 进会话瞬间几百个请求同时打出去，把「滚动导致请求风暴」从滚动阶段挪到了挂载阶段。
 * `MessagePane` 那边用 `content-visibility: auto` 只省了布局/绘制，省不掉这里的 fetch
 * —— 真正的问题必须在**取字节**这一步解决，所以懒加载放在本组件。
 *
 * 【为什么用 400px 提前量】等到元素真正进入视口才加载，滚动时用户会先看到一片
 * 灰占位再「啪」地变成图，快速滚动下尤其像卡顿。400px 约等于一屏的 1/3：
 * 手指/滚轮还在往上滑时图片已经取好，进入视口即出图，同时不会把远处几十屏的
 * 图一起拉下来。
 *
 * 【降级】没有 IntersectionObserver（老浏览器 / SSR 测试环境）就直接置 true，
 * 行为回到「挂载即加载」——宁可多拉几份字节，也不能让图永远不显示。
 */
const rootRef = ref<HTMLElement | null>(null)
/** 是否已进入「视口 + 400px」范围；一旦为 true 就不再回退（避免来回抖动重复拉取）。 */
const nearViewport = ref(false)
let viewportObserver: IntersectionObserver | null = null

function scheduleLoad(): void {
  if (!nearViewport.value) return
  void loadMedia()
}

watch(
  () => props.attachments.map((a) => `${a.id}:${a.kind}`).join(','),
  () => {
    scheduleLoad()
  },
)

watch(nearViewport, (near) => {
  if (near) scheduleLoad()
})

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') {
    nearViewport.value = true
    return
  }
  const target = rootRef.value
  if (!target) {
    nearViewport.value = true
    return
  }
  viewportObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        nearViewport.value = true
        // 只关心「第一次靠近」，之后组件会随消息一起销毁，没必要继续观察。
        viewportObserver?.disconnect()
        viewportObserver = null
      }
    },
    { root: null, rootMargin: '400px 0px', threshold: 0 },
  )
  viewportObserver.observe(target)
})

onUnmounted(() => {
  controller?.abort()
  controller = null
  viewportObserver?.disconnect()
  viewportObserver = null
  revokeAll()
})

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
/** 舞台节点：缩放锚点与拖拽平移都以它为坐标系原点。 */
const stageRef = ref<HTMLElement | null>(null)
/** 打开前的焦点，关闭时归还（无障碍：弹层不得吞焦点，e2e 有断言）。 */
let restoreFocus: HTMLElement | null = null

/*
 * ── 缩放 / 平移（v2.6）
 *
 * 【为什么要自己实现】用户反馈「图片点开时不能放大缩小」—— 浏览器对 `<img>` 的
 * 默认行为就是只显示、不缩放；而引一个灯箱库（photoswipe 之类）要动整个预览层
 * 结构，还会破坏 e2e 依赖的 `.mask .panel .panel__title` / `.lightbox__img`。
 * 缩放本身是纯 CSS transform，自己写只有几十行，且完全可控。
 *
 * 【坐标系】缩放用 `translate3d + scale`，`transform-origin: center`。锚点缩放时把
 * 光标相对舞台中心的偏移也乘上比例，视觉上就是「以鼠标位置为中心缩放」；否则
 * 放大后目标总是跑到屏幕外，用户得自己拖回来 —— 这是滚轮缩放的常见坑。
 */
const ZOOM_MIN = 1
const ZOOM_MAX = 6
const ZOOM_STEP = 1.25
/** 双击直接放到的倍率（再双击回 1x）。 */
const ZOOM_DOUBLE = 2.5

const zoomScale = ref(1)
const zoomX = ref(0)
const zoomY = ref(0)
const panning = ref(false)
let panStart = { x: 0, y: 0, ox: 0, oy: 0 }
/*
 * 这一串手势最后是否真的拖动过。
 *
 * 【为什么需要】舞台上的 pointerdown/up 会**再补一个 click**：拖完图松手，
 * 浏览器仍然认为那是一次 click，而 `@click.self="closeLightbox"` 会立刻把灯箱关掉
 * —— 用户「拖着看图，一松手全没了」。所以拖动过就吃掉这一次 click。
 */
let panMoved = false

const zoomed = computed(() => zoomScale.value > ZOOM_MIN + 0.001)
const zoomPercent = computed(() => Math.round(zoomScale.value * 100))
const imgStyle = computed(() => ({
  transform: `translate3d(${zoomX.value}px, ${zoomY.value}px, 0) scale(${zoomScale.value})`,
}))

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
  resetZoom()
  const target = restoreFocus
  restoreFocus = null
  if (target && target.isConnected) target.focus()
}

function stepImage(delta: number): void {
  const total = images.value.length
  if (total <= 1) return
  lightboxIndex.value = (lightboxIndex.value + delta + total) % total
  resetZoom()
}

/** 复位到 1x 居中。切图、关闭、双击回退都走这里，保证不留下残位移。 */
function resetZoom(): void {
  zoomScale.value = 1
  zoomX.value = 0
  zoomY.value = 0
  panning.value = false
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_MIN
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/**
 * 设置倍率；给了 `anchor`（视口坐标）就绕该点缩放。
 *
 * 落回 1x 时顺手清掉位移 —— 1x 还带着平移会让图片停在半空中。
 */
function applyZoom(next: number, anchor?: { x: number; y: number }): void {
  const target = clampZoom(next)
  if (Math.abs(target - zoomScale.value) < 1e-4) return
  if (anchor && stageRef.value) {
    const rect = stageRef.value.getBoundingClientRect()
    const cx = anchor.x - rect.left - rect.width / 2
    const cy = anchor.y - rect.top - rect.height / 2
    const ratio = target / zoomScale.value
    zoomX.value = cx - (cx - zoomX.value) * ratio
    zoomY.value = cy - (cy - zoomY.value) * ratio
  }
  zoomScale.value = target
  if (target <= ZOOM_MIN) {
    zoomX.value = 0
    zoomY.value = 0
    panning.value = false
  }
}

function zoomBy(factor: number): void {
  applyZoom(zoomScale.value * factor)
}

function onStageWheel(e: WheelEvent): void {
  // 指数缩放：deltaY 是像素还是「行」因设备而异，取 exp 后手感一致
  const factor = Math.exp(-e.deltaY / 400)
  applyZoom(zoomScale.value * factor, { x: e.clientX, y: e.clientY })
}

/** 双击：1x ↔ 2.5x，以双击点为中心。 */
function onStageDblClick(e: MouseEvent): void {
  if (zoomed.value) resetZoom()
  else applyZoom(ZOOM_DOUBLE, { x: e.clientX, y: e.clientY })
}

/*
 * 拖拽平移：只在已放大时生效。1x 下拖动没有意义（图本来就在正中）。
 *
 * 【为什么先判 target】翻页按钮也长在舞台里，pointerdown 会冒泡上来。
 * 一旦对舞台 `setPointerCapture`，后续 pointer 事件全被舞台接走，按钮就收不到
 * 自己的 click 了 —— 放大状态下点「下一张」会没反应。点在按钮上的手势一律不管。
 */
function fromStageControl(e: Event): boolean {
  const target = e.target as HTMLElement | null
  return !!target?.closest('button')
}

function onStagePointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !zoomed.value || fromStageControl(e)) return
  panning.value = true
  panMoved = false
  panStart = { x: e.clientX, y: e.clientY, ox: zoomX.value, oy: zoomY.value }
  const el = e.currentTarget as HTMLElement | null
  el?.setPointerCapture?.(e.pointerId)
}

function onStagePointerMove(e: PointerEvent): void {
  if (!panning.value) return
  const dx = e.clientX - panStart.x
  const dy = e.clientY - panStart.y
  // 3px 死区：手抖不算拖动，否则「点一下关灯箱」也会被吞
  if (!panMoved && Math.abs(dx) + Math.abs(dy) > 3) panMoved = true
  zoomX.value = panStart.ox + dx
  zoomY.value = panStart.oy + dy
}

function onStagePointerUp(e: PointerEvent): void {
  if (!panning.value) return
  panning.value = false
  const el = e.currentTarget as HTMLElement | null
  el?.releasePointerCapture?.(e.pointerId)
}

/**
 * 舞台根节点被点击 → 关灯箱。
 *
 * 用 `.self` 保证点图片本身不算（看图时点一下图不该退出），而拖拽平移后
 * 浏览器补发的那个 click 必须吃掉，否则「拖完松手」= 关闭预览。
 */
function onStageClick(e: MouseEvent): void {
  if (e.target !== e.currentTarget) return
  if (panMoved) {
    panMoved = false
    return
  }
  closeLightbox()
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
  // 缩放快捷键：+ / - 逐档，0 复位（与常见看图工具一致）
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    zoomBy(ZOOM_STEP)
    return
  }
  if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    zoomBy(1 / ZOOM_STEP)
    return
  }
  if (e.key === '0') {
    e.preventDefault()
    resetZoom()
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
  else {
    window.removeEventListener('keydown', onLightboxKeydown)
    resetZoom()
  }
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
  const items: ContextMenuItem[] = [
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
  // 只有图片能进灯箱；视频的播放入口就是卡片本身的 controls，多摆一项只会是死链
  if (!isVideo) {
    items.push({
      // 缩略图上右键也要能进大图 —— 灯箱里右键又是另一套（见 lightboxMenuItems）
      id: 'open-preview',
      label: '查看大图',
      disabled: !blobUrl,
      run: () => openLightbox(att),
    })
  }
  return items
}

/**
 * 灯箱里图片的右键菜单（v2.6）。
 *
 * 【为什么灯箱必须单独挂】灯箱是 `Teleport to="body"` 渲染的，**不在** `.att--image`
 * 子树里，所以缩略图上的 `@contextmenu` 覆盖不到它；右键点在灯箱图上会一路冒泡到
 * window，被 `App.vue` 的全局处理器拦成「刷新页面 / 复制页面链接 / 回到顶部 /
 * 切换深浅色」—— 用户反馈的「右键图片弹的是总菜单」正是这条路径。
 *
 * 菜单内容按「看图的当下能做什么」组织：缩放三档在前，图片操作在后。
 */
function lightboxMenuItems(): ContextMenuItem[] {
  const att = currentImage.value
  if (!att) return []
  return [
    {
      id: 'zoom-in',
      label: '放大',
      hint: '滚轮 / +',
      disabled: zoomScale.value >= ZOOM_MAX - 0.001,
      run: () => zoomBy(ZOOM_STEP),
    },
    {
      id: 'zoom-out',
      label: '缩小',
      hint: '滚轮 / -',
      disabled: zoomScale.value <= ZOOM_MIN + 0.001,
      run: () => zoomBy(1 / ZOOM_STEP),
    },
    {
      id: 'zoom-reset',
      label: '原始大小',
      hint: '双击 / 0',
      disabled: !zoomed.value,
      run: resetZoom,
    },
    ...imageMenuItems(att),
  ]
}

function onLightboxContextMenu(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  ui.openContextMenu(e.clientX, e.clientY, lightboxMenuItems())
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

/**
 * 已加载图片的宽高比（宽 ÷ 高），键是附件 id。
 *
 * 【为什么需要】`Attachment` 类型里**没有宽高字段**，服务端也不下发。多图网格
 * 如果一律按 1:1 裁切，竖图会被切掉大半、宽图两侧留黑，这就是用户说的
 * 「小图片和大图片一样的大小」。只能等 `<img>` 的 `load` 事件给出真实比例，
 * 再把格子撑成同样的比例 —— 图片自己不需要任何额外数据。
 */
const ratios = ref<Record<string, number>>({})

/** 极端长条（全景图、截长图）夹到 [1/2, 2]，否则一格里能拉出三屏高。 */
function rememberRatio(att: Attachment, e: Event): void {
  const img = e.target as HTMLImageElement | null
  const w = img?.naturalWidth ?? 0
  const h = img?.naturalHeight ?? 0
  if (w <= 0 || h <= 0) return
  const ratio = Math.min(2, Math.max(0.5, w / h))
  if (ratios.value[att.id] === ratio) return
  ratios.value = { ...ratios.value, [att.id]: ratio }
}

/** 格子按已知比例撑开；未加载时退回 1:1 方形占位，避免加载前后跳动。 */
function cellStyle(att: Attachment): Record<string, string> {
  const ratio = ratios.value[att.id]
  return ratio ? { '--att-ratio': String(ratio) } : { '--att-ratio': '1' }
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
    ref="rootRef"
    class="atts"
    :class="[`atts--${align}`, { 'atts--single': isSingle && !singleIsVideo }]"
  >
    <!-- ── 媒体区（图片 / 视频） ─────────────────────────────────── -->
    <template v-if="media.length > 0">
      <!--
        单张图片：**按原图比例**撑开（v2.6）。

        旧实现是 `max-width/max-height: 260px` + `object-fit: cover`：一张 40×40 的图标
        被拉成 260×260（模糊），一张 1200×300 的横图被裁掉大半。现在只限最大宽/高，
        不强制等比于 260 —— 小图保持小、长图保持长，靠 `naturalWidth/naturalHeight`
        记住真实比例写进 `--att-ratio`，加载前后不会有跳动。
      -->
      <div
        v-if="isSingle && !singleIsVideo"
        class="att att--image att--hero"
        :style="cellStyle(single)"
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
            @load="rememberRatio(single, $event)"
            @error="failed = { ...failed, [single.id]: true }"
          />
          <span
            v-else
            class="att__thumb-skeleton"
            :class="{ 'att__thumb-skeleton--failed': failed[single.id] }"
            >{{ failed[single.id] ? '图片加载失败' : '加载中…' }}</span
          >
        </button>
        <!--
          图片消息不显示文件名/大小的图注，也不给下载链接（v2.5）：媒体消息就该只有媒体。
          文件名用 sr-only 保留 —— 一是读屏需要，二是 e2e 靠气泡的 textContent 含文件名
          来定位「这条消息」（e2e-attachment.mjs / e2e-ux2-p0.mjs 十几处这么用）。
        -->
        <span class="sr-only">{{ single.name }}</span>
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
        ></video>
        <div v-else class="att__video-skeleton" :class="{ 'att__video-skeleton--failed': failed[single.id] }">
          <span>{{ failed[single.id] ? '视频加载失败' : '加载中…' }}</span>
          <button v-if="failed[single.id]" class="att__retry" type="button" @click="retryOne(single)">
            重试
          </button>
        </div>
        <!-- 视频同样不挂文件名/下载链接；时长在原生 controls 里已经能看到。 -->
        <span class="sr-only">{{ single.name }}</span>
      </div>

      <!-- 2–9 个媒体：网格（2–4 → 2 列，5–9 → 3 列），每格按自己图片的比例 -->
      <div v-else class="att__grid" :style="{ '--att-cols': columns }">
        <div
          v-for="att in media"
          :key="att.id"
          class="att att--cell"
          :class="`att--${att.kind}`"
          :style="cellStyle(att)"
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
                @load="rememberRatio(att, $event)"
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
          <span class="att__meta">{{ sizeTextOf(att) }}</span>
        </span>

        <span class="att__dl" aria-hidden="true">
          <AppIcon name="download" :size="16" />
        </span>
      </button>
    </div>

    <!-- ── 全屏预览层（Teleport 到 body，脱离气泡的 overflow/层叠上下文） ──
         v2.6：去掉白面板边框，改成深色全屏；支持滚轮/双击/拖拽缩放。
         必须保留 `.mask .panel` `.panel__title` `.lightbox__img` 三个 e2e 依赖的
         类名与层级：e2e-attachment.mjs ATT-02 / e2e-ux2-p0.mjs 逐条断言。 -->
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
            @contextmenu="onLightboxContextMenu"
          >
            <header class="panel__head lb__head">
              <h3 class="panel__title">{{ currentImage?.name }}</h3>
              <div class="lb__tools">
                <button
                  class="lb__tool"
                  type="button"
                  aria-label="缩小"
                  :disabled="zoomScale <= ZOOM_MIN + 0.001"
                  @click="zoomBy(1 / ZOOM_STEP)"
                >
                  −
                </button>
                <button
                  class="lb__zoom"
                  type="button"
                  aria-label="恢复原始大小"
                  :disabled="!zoomed"
                  @click="resetZoom"
                >
                  {{ zoomPercent }}%
                </button>
                <button
                  class="lb__tool"
                  type="button"
                  aria-label="放大"
                  :disabled="zoomScale >= ZOOM_MAX - 0.001"
                  @click="zoomBy(ZOOM_STEP)"
                >
                  +
                </button>
                <button class="panel__close" type="button" aria-label="关闭" @click="closeLightbox">
                  <AppIcon name="close" :size="16" />
                </button>
              </div>
            </header>
            <div
              ref="stageRef"
              class="panel__body lb__body"
              :class="{ 'lb__body--zoomed': zoomed, 'lb__body--panning': panning }"
              @click="onStageClick"
              @wheel.prevent="onStageWheel"
              @dblclick="onStageDblClick"
              @pointerdown="onStagePointerDown"
              @pointermove="onStagePointerMove"
              @pointerup="onStagePointerUp"
              @pointercancel="onStagePointerUp"
            >
              <button
                v-if="images.length > 1"
                class="lb__nav lb__nav--prev"
                type="button"
                aria-label="上一张"
                @click="stepImage(-1)"
              >
                ‹
              </button>
              <img
                v-if="currentUrl"
                class="lightbox__img"
                :src="currentUrl"
                :alt="currentImage?.name ?? '图片'"
                :style="imgStyle"
                draggable="false"
                @dragstart.prevent
              />
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
            <footer class="lb__foot">
              <span v-if="images.length > 1" class="lb__count">{{ lightboxIndex + 1 }} / {{ images.length }}</span>
              <span class="lb__hint">滚轮缩放 · 拖拽平移 · Esc 关闭</span>
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
  /*
   * 单图：**按原图比例**显示（v2.6）。
   *
   * 只给上限、不强制填满方框：小图保持原尺寸（不放大就不用虚），横图/竖图各自
   * 按 naturalWidth/naturalHeight 缩放。旧实现固定 max 260×260 + cover，会让
   * 40×40 的小图和 1200×300 的横图看起来一样大。
   */
  width: auto;
  height: auto;
  max-width: min(320px, 62vw);
  max-height: min(400px, 46vh);
  object-fit: contain;
  border-radius: var(--radius-md, 8px);
  background: color-mix(in srgb, currentColor 8%, transparent);
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

/* ── 网格：2–4 → 2 列，5–9 → 3 列，每格按自己图片的比例 ──────── */
.att__grid {
  display: grid;
  grid-template-columns: repeat(var(--att-cols, 2), minmax(0, 1fr));
  gap: 4px;
  width: min(280px, 62vw);
  max-width: 100%;
  /*
   * 不拉伸格子（v2.6）：格子高度由各自的 `aspect-ratio` 决定。默认 `stretch` 会把
   * 同一行里较矮的那张撑到行高 —— 灰底背景随之铺开，看着就像给图片加了半截边框。
   */
  align-items: start;
}
.att--cell {
  position: relative;
  /* `--att-ratio` 由 `<img @load>` 写入（宽÷高，夹在 0.5~2）；未加载时退回方形 */
  aspect-ratio: var(--att-ratio, 1);
  max-height: 260px;
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
/*
 * 格子里的图：contain 而非 cover（v2.6）。
 * `--att-ratio` 被夹在 0.5~2，极端长图（4:1、1:5）的格子比例和图片真实比例会有偏差，
 * cover 就会裁掉一截；contain 最多留一点底色，但**绝不裁图**。
 */
.att--cell .att__thumb {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: contain;
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

/* ── 全屏预览层（v2.6：无边框 / 可缩放）──────────────────────────── */
/*
 * 用户反馈是「预览有边界」：旧实现是白底 .panel + 1px 边框 + 16px 圆角 + 阴影，
 * 图片被包在一张卡片里，四周还留着 padding。现在整个屏幕就是画布：
 * 面板透明、无边框、铺满，工具栏/翻页/计数都浮在图片上方，图片按 contain 居中。
 */
.mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 9, 12, 0.96);
  padding: 0;
}
.lb__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  max-height: none;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow: hidden;
  outline: none;
}
/* 顶栏浮在图片之上：不用白底，用自上而下的黑色渐变，避免挡住图片内容 */
.lb__head {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding: calc(10px + var(--safe-top)) calc(12px + var(--safe-right)) 10px calc(12px + var(--safe-left));
  border-bottom: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.68), rgba(0, 0, 0, 0));
}
.panel__title {
  margin: 0;
  min-width: 0;
  font-size: var(--text-sm, 13px);
  font-weight: var(--weight-medium, 500);
  color: rgba(255, 255, 255, 0.92);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lb__tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.lb__tool,
.lb__zoom,
.panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: 30px;
  min-width: 30px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  font-family: inherit;
  font-size: var(--text-2xs, 11px);
  line-height: 1;
  cursor: pointer;
}
.lb__tool {
  width: 30px;
  padding: 0;
}
.lb__zoom {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}
.lb__tool:hover,
.lb__zoom:hover,
.panel__close:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.lb__tool:disabled,
.lb__zoom:disabled {
  opacity: 0.35;
  cursor: default;
  background: rgba(255, 255, 255, 0.06);
}
.lb__tool:focus-visible,
.lb__zoom:focus-visible,
.panel__close:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
/* 舞台：满屏、不滚动（缩放/平移全走 transform），触控手势交给 pointer 事件 */
.lb__body {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.lb__body--zoomed {
  cursor: grab;
}
.lb__body--panning {
  cursor: grabbing;
}
.lightbox__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  border-radius: 0;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  transition: transform 140ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
/* 已放大时不做过渡：拖拽平移要跟手，留 transition 会让图片「追」指针 */
.lb__body--zoomed .lightbox__img {
  transition: none;
}
.lightbox__fallback {
  margin: 0;
  font-size: var(--text-sm, 13px);
  color: rgba(255, 255, 255, 0.6);
}
/* 翻页按钮浮在图片上，不占布局宽度 */
.lb__nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  transform: translateY(-50%);
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.lb__nav--prev {
  left: calc(12px + var(--safe-left));
}
.lb__nav--next {
  right: calc(12px + var(--safe-right));
}
.lb__nav:hover {
  background: rgba(255, 255, 255, 0.22);
}
.lb__nav:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
/* 底部状态条：同样浮在图片上，不占高度 */
.lb__foot {
  position: absolute;
  right: 0;
  bottom: calc(10px + var(--safe-bottom));
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 12px;
  pointer-events: none;
  font-size: var(--text-2xs, 11px);
  color: rgba(255, 255, 255, 0.72);
  font-variant-numeric: tabular-nums;
}
.lb__count {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
}
.lb__hint {
  display: none;
}
/* 只有桌面（有鼠标）才提示滚轮/拖拽；触屏上这行没意义 */
@media (hover: hover) and (pointer: fine) {
  .lb__hint {
    display: inline;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.5);
  }
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
    max-width: min(260px, 66vw);
    max-height: min(320px, 42vh);
  }
  .att__grid {
    width: min(260px, 66vw);
  }
  .att--video {
    width: min(300px, 70vw);
  }
  .att--file:hover {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  /* 触控：导航/关闭都放大到 44px */
  .panel__close,
  .lb__tool,
  .lb__zoom,
  .lb__nav {
    height: 44px;
    min-width: 44px;
  }
  .lb__nav {
    width: 44px;
  }
}
</style>
