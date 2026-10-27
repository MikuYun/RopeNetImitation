<script setup lang="ts">
/**
 * 认证页外壳（登录 / 注册共用）。
 *
 * 布局：左侧品牌信息栏 + 右侧表单卡，桌面双栏、窄屏自动叠成单列。
 * 品牌图形全部是自绘 inline SVG 与 CSS 渐变，不使用任何第三方 logo/素材。
 *
 * 【契约】`.auth__form` 由调用方在默认插槽里提供；本组件只提供
 * `.auth` / `.auth__shell` / `.auth__aside` / `.auth__brand` / `.auth__logo` /
 * `.auth__name` / `.auth__tagline` / `.auth__card` 这些结构类，改名会破坏
 * e2e 的 `.auth__form` 定位上下文与既有样式引用，故保持不变。
 */
withDefaults(
  defineProps<{
    /** 左栏主标题，如「欢迎回来」 */
    eyebrow: string
    /** 左栏副文案 */
    pitch: string
    /** 左栏要点，逐条渲染 */
    facts?: string[]
  }>(),
  { facts: () => [] },
)
</script>

<template>
  <div class="auth">
    <div class="auth__shell">
      <aside class="auth__aside">
        <!-- 装饰几何：同心环 + 网格点阵，纯 CSS，不占布局、不引入溢出 -->
        <span class="auth__deco auth__deco--ring" aria-hidden="true" />
        <span class="auth__deco auth__deco--grid" aria-hidden="true" />

        <div class="auth__brand">
          <div class="auth__logo" aria-hidden="true">
            <svg class="auth__mark" viewBox="0 0 44 44" fill="none">
              <path class="auth__mark-a" d="M13.2 31.6 22 11.4l8.8 20.2" />
              <path class="auth__mark-bar" d="M17.3 24.4h9.4" />
              <circle class="auth__mark-dot" cx="22" cy="35.2" r="2.7" />
            </svg>
          </div>
          <div class="auth__brand-text">
            <h1 class="auth__name">aitrance-chat</h1>
            <p class="auth__tagline">轻量 · 端到端可追踪的网页聊天</p>
          </div>
        </div>

        <div class="auth__pitch-block">
          <p class="auth__eyebrow">{{ eyebrow }}</p>
          <p class="auth__pitch">{{ pitch }}</p>
        </div>

        <ul v-if="facts.length > 0" class="auth__facts">
          <li v-for="f in facts" :key="f" class="auth__fact">
            <span class="auth__fact-dot" aria-hidden="true" />
            <span>{{ f }}</span>
          </li>
        </ul>
      </aside>

      <section class="auth__card">
        <slot />
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth {
  width: 100%;
  /* 短屏/键盘弹出时整页可滚动，提交按钮不会消失 */
  height: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 安全区：横屏刘海机上左右不贴边 */
  padding: calc(var(--space-4) + var(--safe-top)) calc(var(--space-4) + var(--safe-right))
    calc(var(--space-4) + var(--safe-bottom)) calc(var(--space-4) + var(--safe-left));
}

/* 双栏容器：一块整体的「卡」，左栏铺品牌渐变，右栏是表单面 */
.auth__shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, calc(var(--auth-form-max) + 56px));
  width: 100%;
  max-width: var(--auth-card-max);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-xl);
  background: var(--app-panel);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}

/* ── 左栏 ─────────────────────────────────────────────────────────── */
.auth__aside {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding: var(--space-8) var(--space-6);
  color: #fff;
  background: var(--gradient-brand);
  overflow: hidden;
  isolation: isolate;
}

/* 底部压暗，让白字在任何一段渐变上都够对比 */
.auth__aside::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 55%;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(to top, rgb(8 24 34 / 0.34), transparent);
}

.auth__deco {
  position: absolute;
  z-index: -1;
  pointer-events: none;
}

.auth__deco--ring {
  right: -74px;
  top: -64px;
  width: 260px;
  height: 260px;
  border-radius: var(--radius-full);
  border: 1px solid rgb(255 255 255 / 0.16);
  box-shadow:
    inset 0 0 0 26px rgb(255 255 255 / 0.035),
    inset 0 0 0 60px rgb(255 255 255 / 0.03);
}

.auth__deco--grid {
  left: -20px;
  bottom: -20px;
  width: 220px;
  height: 160px;
  background-image: radial-gradient(rgb(255 255 255 / 0.22) 1px, transparent 1px);
  background-size: 14px 14px;
  mask-image: linear-gradient(120deg, #000 10%, transparent 78%);
}

.auth__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.auth__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  border-radius: var(--radius-lg);
  background: rgb(255 255 255 / 0.14);
  border: 1px solid rgb(255 255 255 / 0.24);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.25);
  backdrop-filter: blur(2px);
}

.auth__mark {
  width: 30px;
  height: 30px;
}

.auth__mark-a,
.auth__mark-bar {
  stroke: #fff;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.auth__mark-bar {
  stroke-width: 2.2;
  opacity: 0.72;
}

.auth__mark-dot {
  fill: var(--color-accent-300);
}

.auth__brand-text {
  min-width: 0;
}

.auth__name {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--lh-tight);
  white-space: nowrap;
}

.auth__tagline {
  margin: var(--space-05) 0 0;
  font-size: var(--text-xs);
  line-height: var(--lh-snug);
  color: rgb(255 255 255 / 0.74);
}

.auth__pitch-block {
  margin-top: auto;
}

.auth__eyebrow {
  margin: 0;
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: rgb(255 255 255 / 0.66);
}

.auth__pitch {
  margin: var(--space-2) 0 0;
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  line-height: var(--lh-snug);
  letter-spacing: var(--tracking-tight);
  text-wrap: balance;
}

.auth__facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.auth__fact {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  line-height: var(--lh-snug);
  color: rgb(255 255 255 / 0.82);
}

.auth__fact-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-accent-300);
  box-shadow: 0 0 0 3px rgb(255 255 255 / 0.1);
}

/* ── 右栏（表单面）────────────────────────────────────────────────── */
.auth__card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: var(--space-8) var(--space-6);
  background: var(--app-panel);
}

/* ── 窄屏：叠成单列，左栏收敛成一条品牌抬头 ─────────────────────── */
@media (max-width: 860px) {
  .auth__shell {
    grid-template-columns: minmax(0, 1fr);
    max-width: 420px;
  }

  .auth__aside {
    gap: var(--space-3);
    padding: var(--space-5) var(--space-5) var(--space-4);
  }

  /* 窄屏不需要大标题与要点，只留品牌抬头，把首屏高度让给表单 */
  .auth__pitch-block,
  .auth__facts {
    display: none;
  }

  .auth__deco--ring {
    right: -100px;
    top: -110px;
  }

  .auth__deco--grid {
    display: none;
  }

  .auth__card {
    padding: var(--space-6) var(--space-5) var(--space-5);
  }

  /* 卡与抬头之间不再有边框，视觉上是一整块 */
  .auth__aside {
    border-bottom: 1px solid rgb(255 255 255 / 0.12);
  }
}

@media (max-width: 400px) {
  .auth {
    padding: calc(var(--space-2) + var(--safe-top)) calc(var(--space-2) + var(--safe-right))
      calc(var(--space-2) + var(--safe-bottom)) calc(var(--space-2) + var(--safe-left));
  }

  .auth__card {
    padding: var(--space-5) var(--space-4);
  }
}

/* 深色：渐变左栏本来就够深，只需把卡片面与分隔线提一档 */
:root[data-theme-mode='dark'] .auth__shell {
  background: var(--app-panel);
  border-color: var(--app-border-strong);
}
</style>
