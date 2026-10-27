<script setup lang="ts">
/**
 * 全局轻提示。
 *
 * 视觉思路：玻璃质感胶囊（半透明深色 + backdrop blur + 内描边），
 * 左侧一枚按语义着色的圆点图标块，右侧文案；进场从上方滑入并轻微放大，
 * 离场向上淡出。`--success` / `--error` 换掉图标块与描边色，而不是整条变色。
 *
 * 约束：`.toaster` / `.toast` 类名与 toast 文本内容被 e2e 依赖，不可改名。
 */
import { useUiStore } from '@/stores/ui'
import AppIcon from '@/components/base/AppIcon.vue'

const ui = useUiStore()

const iconOf = (tone: string) => (tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'info')
</script>

<template>
  <div class="toaster">
    <TransitionGroup name="toast">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast"
        :class="`toast--${t.tone}`"
        role="status"
        @click="ui.dismissToast(t.id)"
      >
        <span class="toast__glyph"><AppIcon :name="iconOf(t.tone)" :size="14" /></span>
        <span class="toast__text">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toaster {
  position: fixed;
  top: calc(16px + var(--safe-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: center;
  width: max-content;
  max-width: min(440px, calc(100vw - 32px));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
  padding: var(--space-2) var(--space-4) var(--space-2) var(--space-2);
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: var(--radius-full);
  font-size: var(--text-sm);
  line-height: var(--lh-snug);
  color: #fff;
  background: color-mix(in srgb, var(--color-ink-800) 92%, transparent);
  backdrop-filter: blur(10px) saturate(140%);
  box-shadow: var(--shadow-3);
  cursor: pointer;
  pointer-events: auto;
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.toast:hover {
  transform: translateY(-1px);
}

.toast__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: rgb(255 255 255 / 0.16);
  color: #fff;
}

.toast__text {
  min-width: 0;
}

/* 语义色只换图标块与描边，主体保持深色玻璃，避免刺眼满屏色块 */
.toast--success {
  border-color: color-mix(in srgb, var(--color-success-400) 55%, transparent);
}
.toast--success .toast__glyph {
  background: var(--color-success-500);
}

.toast--error {
  border-color: color-mix(in srgb, var(--color-danger-500) 55%, transparent);
}
.toast--error .toast__glyph {
  background: var(--color-danger-500);
}

.toast--info .toast__glyph {
  background: color-mix(in srgb, var(--color-brand-400) 90%, transparent);
}

/* 滑入：上方 12px + 缩放 0.96 + 淡入；离场反向并收高度 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur) var(--ease-out);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-12px) scale(0.96);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
.toast-move {
  transition: transform var(--dur) var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .toast:hover {
    transform: none;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
