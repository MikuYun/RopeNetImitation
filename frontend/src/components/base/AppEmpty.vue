<script setup lang="ts">
/**
 * 空态。
 *
 * 视觉思路：不用现成插画素材，而是用「原创几何对话插画 + 居中品牌徽章」组成一个
 * 有纵深的小场景 —— 后面一枚空心气泡、前面一枚渐变气泡、虚线弧托底、三颗浮点，
 * 中间的圆形徽章承载语义图标（chat/contact/search/…）。
 *
 * 约束：`.empty` / `.empty__icon` / `.empty__title` / `.empty__desc` 四个类名被多处
 * 消费者与 e2e 间接依赖，不可改名。插画整体 aria-hidden，语义由标题文案承担。
 */
import AppIcon from '@/components/base/AppIcon.vue'

withDefaults(
  defineProps<{
    icon?: 'chat' | 'contact' | 'search' | 'users' | 'alert' | 'info'
    title: string
    description?: string
  }>(),
  { icon: 'chat', description: '' },
)
</script>

<template>
  <div class="empty">
    <div class="empty__art" aria-hidden="true">
      <svg class="empty__illus" viewBox="0 0 176 132" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse class="empty__halo" cx="88" cy="66" rx="78" ry="56" />
        <path class="empty__arc" d="M26 110c26 16 106 16 132-8" />
        <g class="empty__bubble empty__bubble--back">
          <rect x="12" y="12" width="96" height="62" rx="19" />
          <path d="M34 74v13l15-13" />
        </g>
        <g class="empty__bubble empty__bubble--front">
          <rect x="70" y="60" width="94" height="62" rx="19" />
          <path d="M144 122v13l-15-13" />
          <circle class="empty__dot" cx="93" cy="91" r="3.4" />
          <circle class="empty__dot" cx="106" cy="91" r="3.4" />
          <circle class="empty__dot" cx="119" cy="91" r="3.4" />
        </g>
        <circle class="empty__spark empty__spark--a" cx="150" cy="34" r="3.6" />
        <circle class="empty__spark empty__spark--b" cx="24" cy="92" r="2.6" />
        <circle class="empty__spark empty__spark--c" cx="132" cy="22" r="2" />
      </svg>
      <div class="empty__icon"><AppIcon :name="icon" :size="26" /></div>
    </div>
    <p class="empty__title">{{ title }}</p>
    <p v-if="description" class="empty__desc">{{ description }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-8) var(--space-6);
  text-align: center;
}

/* ── 插画 ───────────────────────────────────────────────────────── */
.empty__art {
  position: relative;
  width: 176px;
  max-width: 100%;
  aspect-ratio: 4 / 3;
  margin-bottom: var(--space-1);
}

.empty__illus {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.empty__halo {
  fill: var(--color-brand-500);
  opacity: 0.07;
}
:root[data-theme-mode='dark'] .empty__halo {
  opacity: 0.12;
}

.empty__arc {
  stroke: var(--color-brand-400);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-dasharray: 3 7;
  opacity: 0.5;
}

.empty__bubble--back rect,
.empty__bubble--back path {
  fill: color-mix(in srgb, var(--color-brand-500) 5%, var(--app-panel));
  stroke: color-mix(in srgb, var(--color-brand-400) 55%, var(--app-border));
  stroke-width: 1.5;
  stroke-linejoin: round;
}

.empty__bubble--front rect,
.empty__bubble--front path {
  fill: color-mix(in srgb, var(--color-brand-500) 12%, var(--app-panel));
  stroke: color-mix(in srgb, var(--color-brand-500) 62%, var(--app-border));
  stroke-width: 1.6;
  stroke-linejoin: round;
}

.empty__dot {
  fill: color-mix(in srgb, var(--color-brand-600) 70%, var(--app-panel));
}

.empty__spark--a {
  fill: var(--color-accent-400);
  opacity: 0.75;
}
.empty__spark--b {
  fill: var(--color-brand-400);
  opacity: 0.6;
}
.empty__spark--c {
  fill: var(--color-brand-300);
  opacity: 0.7;
}

/* 居中徽章：把语义图标做成「实体按钮」而不是灰色小字 */
.empty__icon {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-full);
  background: var(--gradient-brand);
  color: #fff;
  box-shadow:
    0 0 0 5px color-mix(in srgb, var(--app-panel) 70%, transparent),
    var(--shadow-2),
    inset 0 1px 0 rgb(255 255 255 / 0.3);
}

/* ── 文案 ───────────────────────────────────────────────────────── */
.empty__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
  line-height: var(--lh-snug);
  color: var(--app-text);
}

.empty__desc {
  margin: 0;
  max-width: 340px;
  font-size: var(--text-xs);
  line-height: var(--lh-relaxed);
  color: var(--app-text-faint);
}

/* 窄屏收缩插画，避免小屏空态把正文挤下去 */
@media (max-width: 480px) {
  .empty__art {
    width: 148px;
  }
  .empty {
    gap: var(--space-2);
    padding: var(--space-6) var(--space-4);
  }
}
</style>
