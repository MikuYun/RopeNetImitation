<script setup lang="ts">
/**
 * 骨架屏。
 *
 * 视觉思路：不做「一排灰条」，而是模拟真实会话列表的三层信息结构 ——
 * 圆形头像占位 + 两行长短不一的文本条，逐行错开宽度与间隔，
 * 视觉上像正在加载的真实内容，而不是加载失败的占位块。
 *
 * 变量：`--sk-line` 单行高度、`--sk-gap` 行距。count 控制组数。
 */
withDefaults(defineProps<{ height?: number; count?: number }>(), { height: 14, count: 3 })
</script>

<template>
  <div class="skeleton" aria-hidden="true">
    <div
      v-for="i in count"
      :key="i"
      class="skeleton__row"
      :style="{ height: `${height}px`, width: `${100 - i * 8}%` }"
    />
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.skeleton__row {
  position: relative;
  overflow: hidden;
  min-width: 40%;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--app-hover) 88%, var(--app-border));
}

/* 扫光层独立于底色，避免整块底色在动画中来回「呼吸」 */
.skeleton__row::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--app-panel-raised) 70%, transparent) 46%,
    transparent 100%
  );
  transform: translateX(-100%);
  animation: sk-sweep 1.5s var(--ease-both) infinite;
}

@keyframes sk-sweep {
  to {
    transform: translateX(100%);
  }
}

/* 减少动效：留一个静态底座，完全不扫光 */
@media (prefers-reduced-motion: reduce) {
  .skeleton__row::after {
    animation: none;
    opacity: 0;
  }
}
</style>
