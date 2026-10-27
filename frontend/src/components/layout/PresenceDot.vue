<script setup lang="ts">
/**
 * 在线状态小圆点。tooltip 显示「最后在线 x 分钟前」。
 * 离线且无 lastSeenAt 时不渲染（信息缺失优于显示错误信息）。
 */
import { computed } from 'vue'
import { usePresenceStore } from '@/stores/presence'
import { fromNow } from '@/utils/datetime'

const props = withDefaults(defineProps<{ userId: string; size?: number }>(), { size: 9 })

const presence = usePresenceStore()

const online = computed(() => presence.isOnline(props.userId))
const tooltip = computed(() => {
  if (online.value) return '在线'
  const last = presence.lastSeenOf(props.userId)
  return last ? `最后在线 ${fromNow(last)}` : '离线'
})
</script>

<template>
  <span
    class="dot"
    :class="online ? 'dot--on' : 'dot--off'"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="tooltip"
    :aria-label="tooltip"
  />
</template>

<style scoped>
.dot {
  display: inline-block;
  border-radius: 50%;
  border: 1.5px solid var(--app-panel);
  flex: 0 0 auto;
}
.dot--on {
  background: var(--color-presence-online);
}
.dot--off {
  background: var(--color-presence-offline);
}
</style>
