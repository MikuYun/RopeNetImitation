<script setup lang="ts">
/**
 * 「XX 正在输入…」提示条。
 *
 * 展示由 presence store 的 TTL 驱动（收到 start 记 now+6s，每秒清理），
 * 不信任对端一定发 stop —— 关页面 / 断网就不会有 stop。
 * 群聊最多展示 2 人 + 「等 N 人」。
 */
import { computed } from 'vue'

const props = defineProps<{ names: string[] }>()

const text = computed(() => {
  const n = props.names
  if (n.length === 0) return ''
  if (n.length === 1) return `${n[0]} 正在输入…`
  if (n.length === 2) return `${n[0]}、${n[1]} 正在输入…`
  return `${n[0]}、${n[1]} 等 ${n.length} 人正在输入…`
})
</script>

<template>
  <div v-if="text" class="typing">{{ text }}</div>
</template>

<style scoped>
.typing {
  padding: 4px 6px 8px;
  font-size: 12px;
  color: var(--color-typing);
}
</style>
