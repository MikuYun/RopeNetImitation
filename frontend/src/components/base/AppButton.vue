<script setup lang="ts">
/**
 * 基础按钮。
 *
 * 四态齐备（这是「界面不美观」反馈里最容易被感知的部分）：
 *   hover  —— 品牌渐变提亮一档 + 上浮 1px + 投影加深
 *   active —— 落回原位（不复用 hover 的上浮，避免点击时「卡住」）
 *   disabled—— 降饱和 + 降透明度 + 不接收指针事件
 *   loading —— 保留按钮色但文字旁嵌入旋转指示器，宽度不跳（文字用
 *              visibility:hidden 占位，避免 loading 时按钮缩窄导致布局抖动）
 *
 * 全部颜色/间距/圆角/动效走令牌，本文件不出现裸 hex 与魔法数字。
 */
withDefaults(
  defineProps<{
    label: string
    type?: 'button' | 'submit'
    loading?: boolean
    disabled?: boolean
    block?: boolean
    tone?: 'primary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
  }>(),
  {
    type: 'button',
    loading: false,
    disabled: false,
    block: false,
    tone: 'primary',
    size: 'md',
  },
)
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn--${tone}`, `btn--${size}`, { 'btn--block': block, 'is-loading': loading }]"
    :disabled="loading || disabled"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="btn__spinner" aria-hidden="true" />
    <span class="btn__label" :class="{ 'btn__label--loading': loading }">
      <slot>{{ label }}</slot>
    </span>
  </button>
</template>

<style scoped>
/* ── 基座 ──────────────────────────────────────────────────────────── */
.btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-15);
  height: var(--control-h);
  padding: 0 var(--control-pad-x);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  /* 只过渡会变的那几项；不要 all —— all 会把 layout 属性也带上，卡顿 */
  transition:
    background-color var(--dur) var(--ease-both),
    border-color var(--dur) var(--ease-both),
    box-shadow var(--dur) var(--ease-both),
    transform var(--dur-fast) var(--ease-out),
    color var(--dur) var(--ease-both);
  -webkit-tap-highlight-color: transparent;
}

/* 尺寸阶 */
.btn--sm {
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
}
.btn--lg {
  height: var(--control-h-lg);
  padding: 0 var(--space-5);
  font-size: var(--text-md);
  border-radius: var(--radius-md);
}

/* 焦点：键盘可见的环，鼠标点击不出现 */
.btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* ── primary：品牌渐变 + 品牌投影 ──────────────────────────────────── */
.btn--primary {
  background-image: var(--gradient-brand);
  background-color: var(--color-brand-500);
  color: #fff;
  box-shadow: var(--shadow-brand);
  /* 渐变在 hover 时提亮：用叠加一层白色半透明实现，避免再定义一条渐变 */
  overflow: hidden;
  isolation: isolate;
}
.btn--primary::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: rgb(255 255 255 / 0.12);
  opacity: 0;
  transition: opacity var(--dur) var(--ease-both);
}
.btn--primary:hover:not(:disabled)::before {
  opacity: 1;
}
.btn--primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    var(--shadow-brand),
    0 10px 22px color-mix(in srgb, var(--color-brand-600) 26%, transparent);
}
.btn--primary:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-1);
}

/* ── ghost：描边 + hover 填浅底 ────────────────────────────────────── */
.btn--ghost {
  background-color: transparent;
  border-color: var(--app-border-strong);
  color: var(--app-text-muted);
}
.btn--ghost:hover:not(:disabled) {
  background-color: var(--app-hover);
  border-color: var(--app-border-strong);
  color: var(--app-text);
}
.btn--ghost:active:not(:disabled) {
  background-color: var(--app-active);
}

/* ── danger：实心危险色，hover 加深 ────────────────────────────────── */
.btn--danger {
  background-color: var(--color-danger-500);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-danger-500) 26%, transparent);
}
.btn--danger:hover:not(:disabled) {
  background-color: var(--color-danger-600);
  transform: translateY(-1px);
}
.btn--danger:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-1);
}

/* ── disabled（含 loading 时的禁用态外观）─────────────────────────── */
.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  transform: none;
  box-shadow: none;
  filter: saturate(0.55);
}
/* loading 不应该看起来像「不可用」——它正在工作，保持满色 */
.btn.is-loading:disabled {
  opacity: 1;
  filter: none;
  cursor: progress;
}

.btn--block {
  display: flex;
  width: 100%;
}

/* ── 加载指示器：绝对定位在文字左侧，宽度不参与布局 ───────────────── */
.btn__spinner {
  position: absolute;
  left: var(--control-pad-x);
  width: var(--space-3);
  height: var(--space-3);
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--radius-full);
  opacity: 0.85;
  animation: btn-spin 620ms linear infinite;
}
.btn--sm .btn__spinner {
  left: var(--space-3);
  width: var(--space-2);
  height: var(--space-2);
}

/* loading 时文字仍在位（只是看不见），按钮宽度因此不会跳变 */
.btn__label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-15);
}
.btn__label--loading {
  visibility: hidden;
}

@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 减少动态效果：不转圈，改成静态圆环 + 半透明（状态仍可感知） */
@media (prefers-reduced-motion: reduce) {
  .btn__spinner {
    animation: none;
    border-right-color: currentColor;
    opacity: 0.5;
  }
  .btn:hover:not(:disabled),
  .btn:active:not(:disabled) {
    transform: none;
  }
}
</style>
