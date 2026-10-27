<script setup lang="ts">
/**
 * 广场附件九宫格。
 *
 * 【为什么不复用 message/AttachmentView】
 *   1. 消息侧附件只有 image/file 两种形态，广场允许视频，且要「哪一格点了就预览
 *      哪一格」，需要 index 语义；AttachmentView 是以「单个附件」为单位的卡片。
 *   2. AttachmentView 正由 fe-msg 重写，跨模块 import 会互相锁死。
 *   故这里独立实现，只复用底层 `fetchObjectUrl / revokeObjectUrl`（blob 通道）。
 *
 * 【安全】附件 URL 需要 Bearer，绝不能把 token 拼进 <img src>；一律经
 * `fetchObjectUrl(id)` 换 blob URL，卸载时 `revokeObjectUrl` 回收。
 *
 * 【布局规则】同消息侧九宫格：
 *   1 张 → 单张大图（上限 320px，cover）
 *   2–4 张 → 2 列
 *   5–9 张 → 3 列
 *   超过 maxVisible（默认 9）→ 最后可见格显示 `+N` 蒙层
 */
import { computed, onBeforeMount, onUnmounted, reactive, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import { attachmentKindOf } from '@/api/posts'
import type { SquareAttachment } from '@/api/posts'

const props = withDefaults(
  defineProps<{
    attachments: SquareAttachment[]
    /** 最多渲染多少格；超出的折叠成 +N（广场上限 9，留余量）。 */
    maxVisible?: number
  }>(),
  { maxVisible: 9 },
)

const emit = defineEmits<{
  (e: 'preview', index: number): void
}>()

/** blob URL 缓存：附件 id → objectURL。用 reactive 让模板能追踪。 */
const urls = reactive<Record<string, string>>({})
/** 加载失败的附件 id（显示占位块，不崩）。 */
const failed = reactive<Record<string, boolean>>({})
/** 正在拉取的 id，避免重复请求。 */
const pending = new Set<string>()
/** 已卸载标记：abort 之后回来的请求不再写状态。 */
let disposed = false

const visible = computed(() => props.attachments.slice(0, Math.max(1, props.maxVisible)))
const hiddenCount = computed(() => Math.max(0, props.attachments.length - visible.value.length))
/** 列数：1 张单列，2–4 两列，其余三列。 */
const columns = computed(() => {
  const n = visible.value.length
  if (n <= 1) return 1
  if (n <= 4) return 2
  return 3
})

/** 视频判定：上传链路会把 video 的 kind 压成 file，故 mime 优先。 */
function kindOf(att: SquareAttachment): 'image' | 'video' | 'file' {
  return attachmentKindOf(att)
}

function isImage(att: SquareAttachment): boolean {
  return kindOf(att) === 'image'
}

function isVideo(att: SquareAttachment): boolean {
  return kindOf(att) === 'video'
}

function urlOf(att: SquareAttachment): string {
  return urls[att.id] ?? ''
}

function hasFailed(att: SquareAttachment): boolean {
  return failed[att.id] === true
}

/** 逐张拉 blob URL。已经拿到的跳过。 */
async function loadOne(att: SquareAttachment): Promise<void> {
  if (urls[att.id] || pending.has(att.id) || failed[att.id]) return
  pending.add(att.id)
  try {
    const url = await fetchObjectUrl({ id: att.id })
    if (disposed) {
      revokeObjectUrl(url)
      return
    }
    urls[att.id] = url
  } catch {
    if (!disposed) failed[att.id] = true
  } finally {
    pending.delete(att.id)
  }
}

function loadAll(): void {
  for (const att of visible.value) {
    // 普通文件不渲染缩略图（广场不允许普通文件，历史数据可能残留）
    if (kindOf(att) === 'file') {
      failed[att.id] = true
      continue
    }
    void loadOne(att)
  }
}

function onPreview(index: number): void {
  const att = visible.value[index]
  // 普通文件没有预览意义（后端也会拒绝这类附件）
  if (!att || kindOf(att) === 'file') return
  emit('preview', index)
}

onBeforeMount(loadAll)
// 附件集合变化（组件复用）时补拉
watch(
  () => props.attachments,
  () => loadAll(),
  { deep: false },
)

onUnmounted(() => {
  disposed = true
  for (const id of Object.keys(urls)) {
    revokeObjectUrl(urls[id])
    delete urls[id]
  }
})

/** 单图需要特殊比例。 */
const single = computed(() => visible.value.length === 1)
</script>

<template>
  <div
    v-if="visible.length > 0"
    class="media-grid"
    :class="{ 'media-grid--single': single }"
    :style="{ '--media-cols': columns }"
  >
    <button
      v-for="(att, index) in visible"
      :key="att.id"
      type="button"
      class="cell"
      :class="{ 'cell--failed': hasFailed(att) }"
      :aria-label="isVideo(att) ? `播放视频 ${att.name}` : `预览图片 ${att.name}`"
      @click="onPreview(index)"
    >
      <!-- 图片 -->
      <img
        v-if="isImage(att) && !hasFailed(att) && urlOf(att)"
        class="cell__media"
        :src="urlOf(att)"
        :alt="att.name"
        loading="lazy"
        decoding="async"
      />
      <!-- 视频：preload=metadata，不拖慢首屏 -->
      <template v-else-if="isVideo(att) && !hasFailed(att)">
        <video
          v-if="urlOf(att)"
          class="cell__media"
          :src="urlOf(att)"
          controls
          preload="metadata"
          playsinline
          @click.stop
        />
        <span v-else class="cell__placeholder">
          <AppIcon name="video" :size="22" />
        </span>
      </template>
      <!-- 失败/未就绪占位 -->
      <span v-else class="cell__placeholder">
        <AppIcon :name="isVideo(att) ? 'video' : 'image'" :size="22" />
      </span>

      <!-- 视频角标 -->
      <span v-if="isVideo(att)" class="cell__badge" aria-hidden="true">
        <AppIcon name="play" :size="12" />
      </span>

      <!-- 超出折叠：只在最后一格显示 +N -->
      <span v-if="hiddenCount > 0 && index === visible.length - 1" class="cell__more">
        +{{ hiddenCount }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.media-grid {
  display: grid;
  grid-template-columns: repeat(var(--media-cols, 3), minmax(0, 1fr));
  gap: var(--space-1, 4px);
  margin-top: var(--space-2, 8px);
  max-width: 100%;
}

/* 单图：定宽大图，不铺满整行（长文 + 满宽图会失去呼吸感） */
.media-grid--single {
  grid-template-columns: minmax(0, 1fr);
  max-width: 320px;
}

.cell {
  position: relative;
  display: block;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--app-border, #e3e8ee);
  border-radius: var(--radius-md, 10px);
  background: var(--app-panel-alt, #f0f3f6);
  cursor: pointer;
  aspect-ratio: 1 / 1;
  transition:
    filter var(--dur-fast, 120ms) var(--ease-out, ease-out),
    transform var(--dur-fast, 120ms) var(--ease-out, ease-out);
}

.media-grid--single .cell {
  aspect-ratio: 4 / 3;
  max-height: 320px;
}

.cell:hover {
  filter: brightness(1.03);
}

.cell:active {
  transform: scale(0.995);
}

.cell:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 2px var(--color-brand-500, #1d88b0));
}

.cell__media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 0;
  background: #000;
}

/* 视频自带原生控件，格子不再整块可点 */
.cell:has(video) {
  cursor: default;
}

.cell--failed {
  cursor: default;
}

.cell__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--app-text-faint, #9aa6b2);
}

.cell__badge {
  position: absolute;
  left: var(--space-1, 4px);
  bottom: var(--space-1, 4px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full, 999px);
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  pointer-events: none;
}

.cell__more {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  font-size: var(--text-lg, 18px);
  font-weight: var(--weight-semibold, 600);
  pointer-events: none;
}
</style>
