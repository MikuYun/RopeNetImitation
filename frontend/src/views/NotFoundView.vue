<script setup lang="ts">
/**
 * 404。
 *
 * 视觉：自绘一幅「断线气球 / 迷失坐标」的几何插画 —— 一枚脱离网格的气泡、
 * 虚线轨迹与散点，寓意「链接断在这里」。全部 inline SVG，原创，无第三方素材。
 * 页面按 layout:'blank' 渲染，中心卡片式排版，窄屏自动收窄字号与插画。
 */
import { useRouter } from 'vue-router'
import AppButton from '@/components/base/AppButton.vue'

const router = useRouter()
</script>

<template>
  <div class="nf">
    <div class="nf__card">
      <div class="nf__art" aria-hidden="true">
        <svg viewBox="0 0 200 150" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse class="nf__halo" cx="100" cy="76" rx="86" ry="58" />
          <path class="nf__trail" d="M18 120c22-26 40-40 62-46" />
          <g class="nf__bubble">
            <rect x="76" y="22" width="102" height="66" rx="20" />
            <path d="M100 88v14l16-14" />
            <path class="nf__dash" d="M96 55h62" />
            <path class="nf__dash" d="M96 68h40" />
          </g>
          <circle class="nf__dot nf__dot--a" cx="44" cy="44" r="4" />
          <circle class="nf__dot nf__dot--b" cx="168" cy="112" r="3" />
          <circle class="nf__dot nf__dot--c" cx="30" cy="92" r="2.4" />
          <path class="nf__cross" d="M162 30l10 10m0-10-10 10" />
        </svg>
        <span class="nf__code">404</span>
      </div>

      <h1 class="nf__title">页面走丢了</h1>
      <p class="nf__text">这个地址不存在，或者内容已经被移走。检查一下链接是否完整。</p>
      <AppButton label="回到聊天" @click="router.push('/chat')" />
    </div>
  </div>
</template>

<style scoped>
.nf {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: calc(var(--space-4) + var(--safe-top)) calc(var(--space-4) + var(--safe-right))
    calc(var(--space-4) + var(--safe-bottom)) calc(var(--space-4) + var(--safe-left));
}

.nf__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  max-width: 400px;
  padding: var(--space-8) var(--space-6) var(--space-6);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-xl);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  box-shadow: var(--shadow-3);
  text-align: center;
  backdrop-filter: blur(6px);
}

/* ── 插画 ───────────────────────────────────────────────────────── */
.nf__art {
  position: relative;
  width: 200px;
  max-width: 100%;
  margin-bottom: var(--space-2);
}

.nf__art svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.nf__halo {
  fill: var(--color-brand-500);
  opacity: 0.08;
}
:root[data-theme-mode='dark'] .nf__halo {
  opacity: 0.14;
}

.nf__trail {
  stroke: var(--color-brand-400);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-dasharray: 4 7;
  opacity: 0.55;
}

.nf__bubble rect,
.nf__bubble path {
  fill: color-mix(in srgb, var(--color-brand-500) 9%, var(--app-panel));
  stroke: color-mix(in srgb, var(--color-brand-500) 48%, var(--app-border));
  stroke-width: 1.6;
  stroke-linejoin: round;
}

.nf__dash {
  stroke: color-mix(in srgb, var(--color-brand-600) 42%, var(--app-border));
  stroke-width: 3;
  stroke-linecap: round;
  fill: none !important;
}

.nf__dot--a {
  fill: var(--color-accent-400);
  opacity: 0.8;
}
.nf__dot--b {
  fill: var(--color-brand-400);
  opacity: 0.65;
}
.nf__dot--c {
  fill: var(--color-brand-300);
  opacity: 0.7;
}

.nf__cross {
  stroke: var(--color-warn-500);
  stroke-width: 1.8;
  stroke-linecap: round;
  opacity: 0.75;
}

/* 404 数字压在插画下方，用渐变文字做层次 */
.nf__code {
  position: absolute;
  left: 50%;
  bottom: -14px;
  transform: translateX(-50%);
  font-size: 44px;
  font-weight: var(--weight-bold);
  line-height: 1;
  letter-spacing: var(--tracking-tight);
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  opacity: 0.9;
  pointer-events: none;
}

/* ── 文案 ───────────────────────────────────────────────────────── */
.nf__title {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--app-text);
}

.nf__text {
  margin: 0 0 var(--space-3);
  max-width: 320px;
  font-size: var(--text-sm);
  line-height: var(--lh-relaxed);
  color: var(--app-text-muted);
}

@media (max-width: 380px) {
  .nf__card {
    padding: var(--space-6) var(--space-4) var(--space-5);
  }
  .nf__art {
    width: 168px;
  }
  .nf__code {
    font-size: 36px;
  }
}
</style>
