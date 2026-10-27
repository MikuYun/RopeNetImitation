<script setup lang="ts">
/**
 * 主题选择面板。
 *
 * 两段结构：
 *   1) 7 张主题卡（浅色/深色/海洋/森林/樱花/午夜/自定义），每张 3 个色块，
 *      分别预览品牌色 / 面板色 / 聊天画布色 —— 选之前就能看出差别；
 *   2) 仅当选中「自定义」时展开配色表单，**改一个值就落一次 store**，
 *      没有保存按钮（实时预览），顶部给一个「当前已生效」状态提示。
 *
 * 使用方（ProfileDrawer / ProfileView）不需要传任何 props：
 *     <ThemePicker />
 * 抽屉那种 288px 窄列里传 compact 收紧间距：
 *     <ThemePicker compact />
 *
 * 【为什么卡片色块写的是具体 hex】卡片上的色块是「该主题的数据」，必须
 * 能看出各主题之间的差异；若用 var(--color-brand-500)，每张卡都会显示成
 * 当前主题的颜色，预览就没意义了。除此之外本文件不写裸色值。
 */
import { computed, ref, watch } from 'vue'
import {
  THEME_IDS,
  THEME_LABELS,
  useUiStore,
  type CustomBgMode,
  type CustomTheme,
  type ThemeId,
} from '@/stores/ui'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const ui = useUiStore()

/** 主题卡上的三色预览。数值与 styles/theme.css ⑤ 段保持一致。 */
const THEME_PREVIEWS: Record<ThemeId, { brand: string; panel: string; bubble: string }> = {
  light: { brand: '#1d88b0', panel: '#ffffff', bubble: '#eef2f7' },
  dark: { brand: '#166d92', panel: '#131820', bubble: '#212a35' },
  ocean: { brand: '#0d7f9b', panel: '#ffffff', bubble: '#e2eff6' },
  forest: { brand: '#2f7d4f', panel: '#fffef9', bubble: '#edeade' },
  sakura: { brand: '#b83f74', panel: '#ffffff', bubble: '#f8edf2' },
  midnight: { brand: '#24c4d8', panel: '#141024', bubble: '#0d0a17' },
  custom: { brand: '#1d88b0', panel: '#ffffff', bubble: '#eef2f7' },
}

/** 自定义主题的 8 个取色项（顺序即表单顺序：底色在前，字色在后）。 */
type ColorKey =
  | 'primary'
  | 'chatCanvas'
  | 'bubbleSelfBg'
  | 'bubbleSelfText'
  | 'bubblePeerBg'
  | 'bubblePeerText'
  | 'panelBg'
  | 'textColor'

const COLOR_FIELDS: { key: ColorKey; label: string }[] = [
  { key: 'primary', label: '主色' },
  { key: 'chatCanvas', label: '聊天区背景' },
  { key: 'bubbleSelfBg', label: '我的气泡背景' },
  { key: 'bubbleSelfText', label: '我的气泡文字' },
  { key: 'bubblePeerBg', label: '对方气泡背景' },
  { key: 'bubblePeerText', label: '对方气泡文字' },
  { key: 'panelBg', label: '面板背景' },
  { key: 'textColor', label: '主文字色' },
]

const BG_MODES: { id: CustomBgMode; label: string }[] = [
  { id: 'solid', label: '纯色' },
  { id: 'gradient', label: '渐变' },
  { id: 'image', label: '图片' },
]

const isCustom = computed(() => ui.theme === 'custom')

/** 自定义卡片也走实时配色，让「自定义」那张卡反映用户当前选择。 */
function previewOf(id: ThemeId): { brand: string; panel: string; bubble: string } {
  if (id === 'custom') {
    return {
      brand: ui.customTheme.primary,
      panel: ui.customTheme.panelBg,
      bubble: ui.customTheme.chatCanvas,
    }
  }
  return THEME_PREVIEWS[id]
}

function pick(id: ThemeId): void {
  ui.setTheme(id)
}

function onColor(key: ColorKey, event: Event): void {
  const el = event.target
  if (!(el instanceof HTMLInputElement)) return
  const patch: Partial<CustomTheme> = {}
  patch[key] = el.value
  ui.setCustomTheme(patch)
}

function onGradientSecond(event: Event): void {
  const el = event.target
  if (!(el instanceof HTMLInputElement)) return
  ui.setCustomTheme({ bgValue2: el.value })
}

function pickBgMode(mode: CustomBgMode): void {
  ui.setCustomTheme({ bgMode: mode })
}

/**
 * 图片地址：只有 https 才写进 store。
 * 为什么卡这么死 —— 这个值最终会拼进 CSS 的 url(...)：http 在 https 页面
 * 会被按混合内容拦掉（图裂），而任意协议还可能被用来做样式注入。
 * 非法输入留在输入框里让用户自己改，同时说明原因。
 */
const imageInput = ref(ui.customTheme.imageUrl ?? '')
const imageError = ref('')

watch(
  () => ui.customTheme.imageUrl,
  (next) => {
    imageInput.value = next ?? ''
  },
)

function onImageInput(event: Event): void {
  const el = event.target
  if (!(el instanceof HTMLInputElement)) return
  const value = el.value.trim()
  imageInput.value = el.value
  if (!value) {
    imageError.value = ''
    ui.setCustomTheme({ imageUrl: '' })
    return
  }
  if (!/^https:\/\//i.test(value)) {
    imageError.value = '仅支持 https 图片地址'
    return
  }
  imageError.value = ''
  ui.setCustomTheme({ imageUrl: value })
}

function resetCustom(): void {
  ui.resetCustomTheme()
  imageError.value = ''
}
</script>

<template>
  <section class="tp" :class="{ 'tp--compact': compact }" aria-label="主题设置">
    <div class="tp__head">
      <h3 class="tp__title">主题</h3>
      <p v-if="isCustom" class="tp__live" role="status">
        <span class="tp__live-dot" aria-hidden="true" />
        当前已生效
      </p>
    </div>

    <div class="tp__grid" role="radiogroup" aria-label="选择主题">
      <button
        v-for="id in THEME_IDS"
        :key="id"
        type="button"
        role="radio"
        class="tp__card"
        :class="{ 'is-active': ui.theme === id }"
        :aria-checked="ui.theme === id"
        :aria-label="THEME_LABELS[id]"
        @click="pick(id)"
      >
        <span class="tp__swatches" aria-hidden="true">
          <span class="tp__swatch" :style="{ '--swatch': previewOf(id).brand }" />
          <span class="tp__swatch" :style="{ '--swatch': previewOf(id).panel }" />
          <span class="tp__swatch" :style="{ '--swatch': previewOf(id).bubble }" />
        </span>
        <span class="tp__name">{{ THEME_LABELS[id] }}</span>
        <svg
          v-if="ui.theme === id"
          class="tp__check"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3.2 8.4 6.4 11.6 12.8 4.6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <p v-if="!isCustom" class="tp__hint">选择「自定义」可逐项调整配色。</p>

    <!-- ── 自定义配色表单 ─────────────────────────────────────────── -->
    <div v-if="isCustom" class="tp__custom">
      <div class="tp__group">
        <h4 class="tp__group-title">配色</h4>
        <div class="tp__colors">
          <label v-for="field in COLOR_FIELDS" :key="field.key" class="tp__color">
            <input
              class="tp__color-input"
              type="color"
              :value="ui.customTheme[field.key]"
              :aria-label="field.label"
              @input="onColor(field.key, $event)"
            />
            <span class="tp__color-meta">
              <span class="tp__color-name">{{ field.label }}</span>
              <span class="tp__color-hex">{{ ui.customTheme[field.key] }}</span>
            </span>
          </label>
        </div>
      </div>

      <div class="tp__group">
        <h4 class="tp__group-title">聊天区背景</h4>
        <div class="tp__seg" role="radiogroup" aria-label="聊天区背景类型">
          <button
            v-for="mode in BG_MODES"
            :key="mode.id"
            type="button"
            role="radio"
            class="tp__seg-btn"
            :class="{ 'is-active': ui.customTheme.bgMode === mode.id }"
            :aria-checked="ui.customTheme.bgMode === mode.id"
            @click="pickBgMode(mode.id)"
          >
            {{ mode.label }}
          </button>
        </div>

        <label v-if="ui.customTheme.bgMode === 'gradient'" class="tp__color tp__color--wide">
          <input
            class="tp__color-input"
            type="color"
            :value="ui.customTheme.bgValue2 ?? ui.customTheme.chatCanvas"
            aria-label="渐变第二色"
            @input="onGradientSecond"
          />
          <span class="tp__color-meta">
            <span class="tp__color-name">渐变第二色</span>
            <span class="tp__color-hex">
              {{ ui.customTheme.bgValue2 ?? ui.customTheme.chatCanvas }}
            </span>
          </span>
        </label>

        <div v-if="ui.customTheme.bgMode === 'image'" class="tp__field">
          <label class="tp__field-label" for="tp-image-url">图片地址（https）</label>
          <input
            id="tp-image-url"
            class="tp__text"
            type="url"
            inputmode="url"
            placeholder="https://example.com/bg.jpg"
            :value="imageInput"
            :aria-invalid="imageError ? 'true' : undefined"
            aria-describedby="tp-image-error"
            @input="onImageInput"
          />
          <p v-if="imageError" id="tp-image-error" class="tp__error" role="alert">
            {{ imageError }}
          </p>
        </div>
      </div>

      <div class="tp__foot">
        <button type="button" class="tp__reset" @click="resetCustom">恢复默认</button>
        <span class="tp__foot-note">改动即时生效，无需保存。</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ── 头部 ──────────────────────────────────────────────────────────── */
.tp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.tp__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--app-text);
  line-height: var(--lh-tight);
}

.tp__live {
  display: inline-flex;
  align-items: center;
  gap: var(--space-15);
  margin: 0;
  padding: var(--space-05) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--app-brand-tint);
  color: var(--app-text-muted);
  font-size: var(--text-xs);
  line-height: var(--lh-snug);
}

.tp__live-dot {
  width: var(--space-15);
  height: var(--space-15);
  border-radius: var(--radius-full);
  background: var(--color-brand-500);
}

/* ── 主题卡网格 ────────────────────────────────────────────────────── */
.tp__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.tp__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-15);
  padding: var(--space-2);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: var(--app-panel);
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: var(--lh-snug);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-both),
    box-shadow var(--dur-fast) var(--ease-both),
    background-color var(--dur-fast) var(--ease-both);
}

.tp__card:hover {
  background: var(--app-hover);
  border-color: var(--app-border-strong);
}

.tp__card.is-active {
  border-color: var(--color-brand-500);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-brand-500) 32%, transparent);
  color: var(--app-text);
}

.tp__swatches {
  display: flex;
  gap: var(--space-05);
  height: var(--space-6);
}

.tp__swatch {
  flex: 1 1 0;
  min-width: 0;
  border-radius: var(--radius-sm);
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-text) 10%, transparent);
}

.tp__name {
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp__check {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: var(--space-4);
  height: var(--space-4);
  padding: var(--space-05);
  border-radius: var(--radius-full);
  background: var(--color-brand-500);
  color: var(--app-panel);
}

/* 288px 的抽屉列里 4 列会挤，compact 收紧内边距与字号 */
.tp--compact .tp__grid {
  gap: var(--space-15);
}

.tp--compact .tp__card {
  padding: var(--space-1);
  gap: var(--space-1);
  font-size: var(--text-2xs);
}

.tp--compact .tp__swatches {
  height: var(--space-4);
}

.tp--compact .tp__check {
  width: var(--space-3);
  height: var(--space-3);
}

.tp__hint {
  margin: 0;
  color: var(--app-text-faint);
  font-size: var(--text-xs);
  line-height: var(--lh-snug);
}

/* ── 自定义表单 ────────────────────────────────────────────────────── */
.tp__custom {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--app-border);
}

.tp__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tp__group-title {
  margin: 0;
  color: var(--app-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-wide);
}

.tp__colors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.tp__color {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-sm);
  background: var(--app-panel-alt);
  cursor: pointer;
}

.tp__color--wide {
  align-self: flex-start;
}

.tp__color-input {
  flex: 0 0 auto;
  width: var(--space-6);
  height: var(--space-6);
  padding: 0;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
}

/* 原生取色器在部分浏览器里有内边距，抹平才和外壳对齐 */
.tp__color-input::-webkit-color-swatch-wrapper {
  padding: var(--space-05);
}

.tp__color-input::-webkit-color-swatch {
  border: 0;
  border-radius: var(--radius-sm);
}

.tp__color-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: var(--lh-tight);
}

.tp__color-name {
  overflow: hidden;
  color: var(--app-text);
  font-size: var(--text-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp__color-hex {
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
}

/* 背景类型：三选一分段控件 */
.tp__seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-05);
  padding: var(--space-05);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: var(--app-panel-alt);
}

.tp__seg-btn {
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-both),
    color var(--dur-fast) var(--ease-both);
}

.tp__seg-btn:hover {
  color: var(--app-text);
}

.tp__seg-btn.is-active {
  background: var(--app-panel);
  color: var(--app-text);
  box-shadow: var(--shadow-1);
}

.tp__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tp__field-label {
  color: var(--app-text-muted);
  font-size: var(--text-2xs);
}

.tp__text {
  width: 100%;
  height: var(--control-h);
  padding: 0 var(--space-3);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: var(--app-panel);
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-sm);
}

.tp__text:focus-visible {
  border-color: var(--color-brand-400);
  outline: 2px solid var(--color-brand-400);
  outline-offset: 1px;
}

.tp__error {
  margin: 0;
  color: var(--color-danger-500);
  font-size: var(--text-2xs);
  line-height: var(--lh-snug);
}

.tp__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.tp__reset {
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--app-border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-both),
    color var(--dur-fast) var(--ease-both);
}

.tp__reset:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.tp__foot-note {
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  text-align: right;
}

@media (max-width: 767px) {
  .tp__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .tp__colors {
    grid-template-columns: minmax(0, 1fr);
  }

  /* iOS 聚焦输入框会放大页面，移动端必须 ≥16px */
  .tp__text {
    font-size: var(--font-input-mobile);
  }
}
</style>
