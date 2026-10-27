<script setup lang="ts">
/**
 * 发送状态 + 已读标记。
 *
 * 单聊：对方已读 -> 双勾；已发送未读 -> 单勾；发送中 -> 转圈；失败 -> 叹号。
 * 群聊：显示「N 人已读」，避免用勾号表达不确定的语义。
 */
import { computed } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import type { LocalSendStatus } from '@/types/domain'

const props = defineProps<{
  status: LocalSendStatus
  readByPeer?: boolean
  readCount?: number
}>()

const showCount = computed(() => (props.readCount ?? 0) > 0)
</script>

<template>
  <span class="status">
    <template v-if="status === 'sending'">
      <span class="spinner" title="发送中" />
    </template>
    <template v-else-if="status === 'failed'">
      <AppIcon name="alert" :size="13" class="status--failed" />
    </template>
    <template v-else>
      <span v-if="showCount" class="status__count">{{ readCount }} 人已读</span>
      <AppIcon
        v-else
        :name="readByPeer ? 'double-check' : 'check'"
        :size="14"
        :class="readByPeer ? 'status--read' : 'status--sent'"
      />
    </template>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
}
.spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid color-mix(in srgb, var(--app-text-faint) 45%, transparent);
  border-top-color: var(--app-text-faint);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.status--failed {
  color: var(--color-danger-500);
}
.status--sent {
  color: var(--app-text-faint);
}
.status--read {
  color: var(--color-brand-400);
}
.status__count {
  font-size: 11px;
  color: var(--color-receipt);
}
</style>
