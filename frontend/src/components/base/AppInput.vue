<script setup lang="ts">
/**
 * 文本输入框（含浮起标签）。
 *
 * 【结构契约】`.field` > `.field__box` > (`.field__label` + `input.field__input`)，错误文案
 * `.field__error` 在 `.field__box` 之后。e2e 依赖 `.field__input` 的 DOM 出现顺序
 * （登录页 nth(0)=用户名、nth(1)=密码）与 `.field__error` 的文本，故顺序不可变。
 *
 * 【浮起标签】不用 JS 量尺寸：
 *   - 空且未聚焦 → 标签落在输入框内，充当占位提示（此时原生 placeholder 透明）
 *   - 聚焦或已有值 → 标签上浮到顶部，缩为小号全大写样式
 *   有值与否由 `modelValue` 直接判定（不依赖 :has），另加 `:has(:not(:placeholder-shown))`
 *   兜住浏览器自动填充这种 Vue 感知不到的情况。
 */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    type?: string
    placeholder?: string
    label?: string
    error?: string
    maxlength?: number
    /** 悬浮提示（如注册页的规则说明）。不占布局，不引入 v-html。 */
    hint?: string
  }>(),
  { type: 'text', placeholder: '', label: '', error: '', maxlength: undefined, hint: '' },
)

defineEmits<{ 'update:modelValue': [string]; enter: [] }>()

const focused = ref(false)
/** 标签是否上浮：有值或正在聚焦。 */
const floated = computed(() => focused.value || props.modelValue.length > 0)
const hasError = computed(() => props.error.length > 0)
</script>

<template>
  <label
    class="field"
    :class="{
      'field--labeled': !!label,
      'field--float': floated,
      'field--error': hasError,
      'field--hint': !!hint,
    }"
  >
    <span class="field__box">
      <span v-if="label" class="field__label">{{ label }}</span>
      <input
        class="field__input"
        :class="{ 'field__input--error': hasError }"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :maxlength="maxlength"
        :aria-invalid="hasError || undefined"
        autocomplete="off"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @focus="focused = true"
        @blur="focused = false"
        @keyup.enter="$emit('enter')"
      />
    </span>
    <span v-if="error" class="field__error">{{ error }}</span>
    <span v-else-if="hint" class="field__hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-15);
}

.field__box {
  position: relative;
  display: block;
}

.field__input {
  display: block;
  width: 100%;
  height: var(--control-h-lg);
  /* 顶部留白给浮起标签；未加标签时由下面的覆盖规则去掉 */
  padding: 17px var(--space-3) 0;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--radius-md);
  background: var(--app-panel);
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-md);
  line-height: var(--lh-normal);
  outline: none;
  transition:
    border-color var(--dur) var(--ease-both),
    box-shadow var(--dur) var(--ease-both),
    background-color var(--dur) var(--ease-both);
}

/* 未加标签的输入框不需要顶部留白 */
.field:not(.field--labeled) .field__input {
  padding-top: 0;
}

.field__input:hover:not(:focus) {
  border-color: color-mix(in srgb, var(--app-text-faint) 55%, var(--app-border-strong));
}

/* 焦点环：与边框同心，两段式（内描边 + 外柔光），比单层 outline 更精致 */
.field__input:focus {
  border-color: var(--color-brand-500);
  box-shadow: var(--focus-ring);
  background: var(--app-panel);
}

/* 浮起标签 */
.field__label {
  position: absolute;
  left: 13px;
  top: 50%;
  transform: translateY(-50%);
  max-width: calc(100% - 26px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-md);
  color: var(--app-text-faint);
  pointer-events: none;
  transform-origin: left center;
  transition:
    top var(--dur) var(--ease-out),
    font-size var(--dur) var(--ease-out),
    letter-spacing var(--dur) var(--ease-out),
    color var(--dur) var(--ease-out);
}

.field--float .field__label,
.field:has(.field__input:not(:placeholder-shown)) .field__label {
  top: 13px;
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  color: var(--app-text-muted);
}

.field:focus-within .field__label {
  color: var(--color-brand-600);
}

/* 有标签时，未聚焦且为空不显示原生 placeholder（由浮起标签兼任） */
.field--labeled:not(.field--float) .field__input::placeholder {
  color: transparent;
}
.field--labeled .field__input::placeholder {
  color: var(--app-text-faint);
}

/* ── 错误态 ─────────────────────────────────────────────────────── */
.field--error .field__input {
  border-color: var(--color-danger-500);
  background: color-mix(in srgb, var(--color-danger-500) 4%, var(--app-panel));
}
.field--error .field__input:focus {
  border-color: var(--color-danger-500);
  box-shadow: var(--focus-ring-danger);
}
.field--error .field__label,
.field--error:focus-within .field__label {
  color: var(--color-danger-500);
}

.field__error {
  display: flex;
  align-items: center;
  gap: var(--space-05);
  min-height: 15px;
  font-size: var(--text-xs);
  line-height: 1.25;
  color: var(--color-danger-500);
}
.field__error::before {
  content: '';
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.field__hint {
  font-size: var(--text-xs);
  line-height: 1.25;
  color: var(--app-text-faint);
}

/* ── 深色：输入框面比卡片略亮，才不像「挖了个洞」────────────────── */
:root[data-theme-mode='dark'] .field__input {
  background: color-mix(in srgb, var(--app-panel-raised) 88%, #000);
  border-color: var(--app-border-strong);
}
:root[data-theme-mode='dark'] .field__input:focus {
  background: var(--app-panel-raised);
}

/* 减少动效：标签直接落位，不做位移过渡 */
@media (prefers-reduced-motion: reduce) {
  .field__label {
    transition: color 1ms;
  }
}
</style>
