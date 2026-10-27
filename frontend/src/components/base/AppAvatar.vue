<script setup lang="ts">
/**
 * 原创视觉：头像不用任何第三方素材，而是「首字符 + 由 id 派生的底色」。
 * 群聊用九宫格成员首字组合。
 *
 * 【三种 src 形态，本组件统一收敛】（ux2-contract §十）
 *   1. 空串 —— 绝大多数调用方（9 处）都不传 src，走首字母兜底；
 *   2. `https://...` 外链 —— 直接给 `<img src>`，带 `referrerpolicy="no-referrer"`
 *      不把站内 URL 泄露给第三方图床；
 *   3. `/api/v1/uploads/<uuid>` 站内附件 —— **绝对不能直接塞进 `<img src>`**：
 *      `GET /api/v1/uploads/:id` 要 Bearer token，浏览器发 `<img>` 请求不会带
 *      Authorization，结果是 401 + 破图。必须先 `fetchAttachmentBlob` 拿到 blob，
 *      再 `URL.createObjectURL` 换成 `blob:` URL 渲染，并在卸载/换图时 revoke
 *      释放（否则每换一次头像漏一个几十 KB 的 blob，长会话页会持续涨内存）。
 *
 * 失败兜底：blob 拉取失败（403 非属主 / 404 已清理 / 网络断）与 `<img>@error`
 * 都退回首字母，不留破图、不抛错。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { avatarColorOf } from '@/utils/datetime'
import { fetchAttachmentBlob, revokeObjectUrl } from '@/api/uploads'

const props = withDefaults(
  defineProps<{
    name: string
    seed?: string
    size?: number
    radius?: number
    /** 头像地址：空串（首字母）/ https 外链 / `/api/v1/uploads/<uuid>`（走 blob）。 */
    src?: string
  }>(),
  { seed: '', size: 40, radius: 6, src: '' },
)

/** 远端图加载失败后永久退回首字母，避免破图闪烁 */
const imgFailed = ref(false)
/** 站内附件的 blob URL（`blob:` 前缀）或 https 外链原值；空串表示没有可渲染的图。 */
const resolved = ref('')
/** 自己创建的 blob URL，只有它需要（也只能）被 revoke。 */
let ownedUrl: string | null = null
/** 在途请求令牌：换头像/卸载时作废，防止旧响应把刚释放的 URL 又写回来。 */
let loadGen = 0

const trimmed = computed(() => props.src.trim())

/** `/api/v1/uploads/<uuid>` → uuid；不是站内附件路径则返回 null。 */
function uploadIdOf(url: string): string | null {
  const m = /^\/api\/v1\/uploads\/([^/?#]+)$/.exec(url)
  return m && m[1] ? m[1] : null
}

function releaseOwned(): void {
  if (ownedUrl !== null) {
    // revokeObjectUrl 只处理 blob: 且幂等，但 ownedUrl 本就只可能是 blob:
    revokeObjectUrl(ownedUrl)
    ownedUrl = null
  }
}

function resetSrc(): void {
  loadGen += 1
  releaseOwned()
  resolved.value = ''
  imgFailed.value = false
}

async function resolveSrc(url: string): Promise<void> {
  resetSrc()
  if (url.length === 0) return
  const uploadId = uploadIdOf(url)
  if (uploadId === null) {
    // https 外链（或调用方已给好的 blob:/data:）—— 直接用
    resolved.value = url
    return
  }
  const gen = loadGen
  try {
    const blob = await fetchAttachmentBlob({ id: uploadId })
    if (gen !== loadGen) return // 期间换图/卸载，丢弃
    const objectUrl = URL.createObjectURL(blob)
    if (gen !== loadGen) {
      revokeObjectUrl(objectUrl)
      return
    }
    ownedUrl = objectUrl
    resolved.value = objectUrl
  } catch {
    // 403/404/网络：保持首字母兜底（这里不能弹 toast，头像失败是噪声）
    if (gen === loadGen) resolved.value = ''
  }
}

watch(trimmed, (url) => void resolveSrc(url), { immediate: true })

onBeforeUnmount(() => {
  loadGen += 1
  releaseOwned()
})

const showImage = computed(() => resolved.value.length > 0 && !imgFailed.value)

const initial = computed(() => {
  const n = props.name.trim()
  return n.length > 0 ? n.slice(0, 1).toUpperCase() : '?'
})

const bg = computed(() => avatarColorOf(props.seed || props.name))

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  borderRadius: `${props.radius}px`,
  background: bg.value,
  fontSize: `${Math.round(props.size * 0.42)}px`,
}))
</script>

<template>
  <div class="avatar" :style="style" :title="name">
    <img
      v-if="showImage"
      class="avatar-img"
      :src="resolved"
      :alt="name"
      :style="style"
      referrerpolicy="no-referrer"
      loading="lazy"
      decoding="async"
      @error="imgFailed = true"
    />
    <template v-else>{{ initial }}</template>
  </div>
</template>

<style scoped>
/*
 * 质感做法：不引素材，只用两层叠加把纯色块变成「有光照的实体」——
 *   ::before  左上角高光 + 自下而上淡出的白，模拟天光方向；
 *   内阴影    1px 顶部内高光 + 1px 外描边（半透明白），让边缘不发灰；
 *   字        轻微投影，避免浅色底上字发飘。
 * 头像图片模式不叠高光层，否则等于给真实照片蒙了一层雾。
 */
.avatar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  isolation: isolate;
  overflow: hidden;
  color: #fff;
  font-weight: var(--weight-semibold);
  letter-spacing: 0.01em;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.22);
  user-select: none;
  flex: 0 0 auto;
  line-height: 1;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.28),
    inset 0 0 0 1px rgb(255 255 255 / 0.14);
}

.avatar::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(120% 90% at 22% 12%, rgb(255 255 255 / 0.34), transparent 62%),
    linear-gradient(168deg, rgb(255 255 255 / 0.1) 0%, rgb(0 0 0 / 0.1) 100%);
}

/* 有真实图片时不叠光照层 */
.avatar:has(.avatar-img)::before {
  display: none;
}

.avatar-img {
  object-fit: cover;
  display: block;
}
</style>
