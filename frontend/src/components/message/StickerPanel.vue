<script setup lang="ts">
/**
 * 表情包面板（v2.4）。
 *
 * 【为什么不做成弹窗】表情包是「发消息的原料」，不是一次性的对话框：用户
 * 常常要连发好几个、边发边看聊天区。做成 AppModal 会遮住消息流，选完一个
 * 就得重新打开。所以这里是**贴在 composer 上方的常驻面板**，宽度跟随
 * composer，最大 360×320（再大就把手机输入区挤没了）。
 *
 * 【图片地址必须换 blob】`Sticker.url` 是 `/api/v1/uploads/<id>`，需要 Bearer，
 * 直接塞 `<img src>` 会 401 且拿不到任何提示。这里一律走
 * `fetchObjectUrl({ id: uploadId })` 换 blob URL，卸载/换列表时
 * `revokeObjectUrl` 回收 —— 与 `AttachmentView` / `AppAvatar` 同一纪律。
 *
 * 【删除是二次确认】表情只有用户自己能看到、删了也找不回来（服务端只删
 * 表情记录，不保留回收站），所以必须确认。仓库既有惯例是 AppModal + AppButton
 * （见 `square/PostCard.vue` 的删除动态），不用 window.confirm。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import { fetchObjectUrl, revokeObjectUrl } from '@/api/uploads'
import type { Sticker } from '@/api/stickers'

const props = withDefaults(
  defineProps<{
    items: Sticker[]
    loading?: boolean
    /** 加载失败的展示文案（后端未上线时会 404，属于正常态）。 */
    error?: string | null
  }>(),
  { loading: false, error: null },
)

const emit = defineEmits<{
  /** 点了某个表情 —— 上层负责组一条纯图片消息发出去。 */
  pick: [sticker: Sticker]
  /** 确认删除后抛给上层（上层调 store，自己不做网络请求）。 */
  remove: [sticker: Sticker]
  /** 加载失败后的「重试」。 */
  retry: []
  /** 收起面板。 */
  close: []
}>()

/** blob URL 缓存：uploadId → objectURL。reactive 让模板能追踪。 */
const urls = reactive<Record<string, string>>({})
/** 拉取失败的 uploadId（显示占位块，不崩）。 */
const failed = reactive<Record<string, boolean>>({})
const pending = new Set<string>()
/** 已卸载标记：卸载后才回来的请求不再写状态，但仍要 revoke。 */
let disposed = false

const isEmpty = computed(() => !props.loading && props.items.length === 0)

function urlOf(sticker: Sticker): string {
  return urls[sticker.uploadId] ?? ''
}

function hasFailed(sticker: Sticker): boolean {
  return failed[sticker.uploadId] === true
}

async function loadOne(sticker: Sticker): Promise<void> {
  const key = sticker.uploadId
  if (!key || urls[key] || pending.has(key) || failed[key]) return
  pending.add(key)
  try {
    const url = await fetchObjectUrl({ id: key })
    if (disposed) {
      revokeObjectUrl(url)
      return
    }
    urls[key] = url
  } catch {
    if (!disposed) failed[key] = true
  } finally {
    pending.delete(key)
  }
}

/** 只拉当前列表里还没拿到的那几张。 */
function loadAll(): void {
  for (const sticker of props.items) void loadOne(sticker)
}

function releaseAll(): void {
  for (const key of Object.keys(urls)) {
    revokeObjectUrl(urls[key])
    delete urls[key]
  }
}

// 列表变化（新增/删除/换账号）时：回收旧 URL，重新按新列表拉
watch(
  () => props.items,
  () => {
    releaseAll()
    for (const key of Object.keys(failed)) delete failed[key]
    loadAll()
  },
)

/**
 * 挂载时就得拉一轮。
 *
 * 【踩过的坑】只写 `watch(items, ..., { immediate: true })` 也不行 —— store 里
 * 的列表在面板第二次打开时**已经就位**，watch 的 immediate 只会跑一次，
 * 而首轮挂载时 `props.items` 是同一个数组引用，之后列表不变就再没机会拉图。
 * 所以挂载时无条件 loadAll()（内部按 uploadId 去重，重复调用安全）。
 */
onMounted(loadAll)

onUnmounted(() => {
  disposed = true
  releaseAll()
})

/* ── 删除确认 ───────────────────────────────────────────────────── */

const pendingDelete = ref<Sticker | null>(null)

function askDelete(sticker: Sticker): void {
  pendingDelete.value = sticker
}

function cancelDelete(): void {
  pendingDelete.value = null
}

function confirmDelete(): void {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (target) emit('remove', target)
}

/** 点图片主体 = 发送。按钮承担语义，img 只是内容。 */
function onPick(sticker: Sticker): void {
  emit('pick', sticker)
}
</script>

<template>
  <section class="sp" aria-label="表情包">
    <header class="sp__head">
      <span class="sp__title">表情包</span>
      <span class="sp__count">{{ items.length }}</span>
      <button class="sp__close" type="button" title="收起表情包" aria-label="收起表情包" @click="emit('close')">
        <AppIcon name="close" :size="13" />
      </button>
    </header>

    <p v-if="loading && items.length === 0" class="sp__state" aria-live="polite">正在加载表情包…</p>

    <div v-else-if="error && items.length === 0" class="sp__state">
      <span class="sp__state-text">{{ error }}</span>
      <button class="sp__retry" type="button" @click="emit('retry')">重试</button>
    </div>

    <p v-else-if="isEmpty" class="sp__state">
      还没有表情包，右键（手机长按）图片消息可保存
    </p>

    <div v-else class="sp__grid" role="list">
      <div v-for="sticker in items" :key="sticker.id" class="sp__cell" role="listitem">
        <button
          class="sp__pick"
          type="button"
          :title="`发送表情 ${sticker.name}`"
          :aria-label="`发送表情 ${sticker.name}`"
          @click="onPick(sticker)"
        >
          <img
            v-if="urlOf(sticker) && !hasFailed(sticker)"
            class="sp__img"
            :src="urlOf(sticker)"
            :alt="sticker.name"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="sp__placeholder" aria-hidden="true">
            <AppIcon name="image" :size="18" />
          </span>
        </button>
        <button
          class="sp__del"
          type="button"
          :title="`删除表情 ${sticker.name}`"
          :aria-label="`删除表情 ${sticker.name}`"
          @click.stop="askDelete(sticker)"
        >
          <AppIcon name="close" :size="11" />
        </button>
      </div>
    </div>

    <!-- 删除二次确认（仓库惯例：AppModal + AppButton，不用 window.confirm） -->
    <AppModal :open="!!pendingDelete" title="删除表情" :width="340" @close="cancelDelete">
      <p class="sp__confirm">
        确定删除「{{ pendingDelete?.name }}」吗？删除后需要重新从图片消息保存。
      </p>
      <div class="sp__confirm-actions">
        <AppButton label="取消" tone="ghost" @click="cancelDelete" />
        <AppButton label="删除" tone="danger" @click="confirmDelete" />
      </div>
    </AppModal>
  </section>
</template>

<style scoped>
.sp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  max-width: 360px;
  max-height: 320px;
  margin-bottom: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: var(--app-panel-alt);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}

.sp__head {
  display: flex;
  align-items: center;
  gap: var(--space-15);
  flex: 0 0 auto;
}

.sp__title {
  font-size: 12px;
  font-weight: var(--weight-medium, 500);
  color: var(--app-text);
}

.sp__count {
  font-size: 11px;
  color: var(--app-text-faint);
}

.sp__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}

.sp__close:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.sp__close:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}

.sp__state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-1);
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-text-muted);
}

.sp__state-text {
  min-width: 0;
}

.sp__retry {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-brand-600);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp__retry:hover {
  background: var(--app-hover);
}

.sp__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-15);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.sp__cell {
  position: relative;
}

.sp__pick {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  padding: 2px;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-sm);
  background: var(--app-panel);
  cursor: pointer;
  overflow: hidden;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.sp__pick:hover {
  border-color: var(--color-brand-500);
}

.sp__pick:active {
  transform: scale(0.97);
}

.sp__pick:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}

.sp__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.sp__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-faint);
}

.sp__del {
  position: absolute;
  top: 1px;
  right: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-panel) 82%, transparent);
  color: var(--app-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

/* 桌面 hover 才露出，避免一排叉号盖住图；手机没有 hover，常显 */
.sp__cell:hover .sp__del,
.sp__del:focus-visible {
  opacity: 1;
}

.sp__del:hover {
  color: var(--color-danger-500);
}

.sp__confirm {
  margin: 0 0 var(--space-3);
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text);
}

.sp__confirm-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

/* 窄屏：4 列挤成 5 列会看不清表情，任务要求窄屏 5 列反而更密，
   这里按需求给 5 列（格子小但能一屏看更多），热区靠 gap 撑开。 */
@media (max-width: 767px) {
  .sp {
    max-width: none;
    max-height: 260px;
  }
  .sp__grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .sp__del {
    opacity: 1;
    width: 22px;
    height: 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sp__pick,
  .sp__del {
    transition: none;
  }
}
</style>
