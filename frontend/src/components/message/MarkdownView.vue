<script setup lang="ts">
/**
 * Markdown 正文渲染视图。
 *
 * 【安全硬规则（与 MessageBubble 顶部那条同源）】
 * 消息正文**永不**使用 v-html，也永不把 Markdown 先拼成 HTML 串再 innerHTML。
 * 本组件把 `@/utils/markdown` 产出的 **VNode 树**直接挂成子节点：
 *   renderMarkdown(source) → VNode[] → h('div', null, nodes)
 * 全链路没有 HTML 字符串，Vue 对文本节点用 createTextNode 落地，
 * 因此消息正文在构造上就不可能出现「被解析成 HTML」的路径。
 *
 * 源码模式（render-mode="source"）走 `{{ source }}` 插值，同样不产生 HTML。
 *
 * 【为什么这里不再放一份「去标记纯文本」给屏幕阅读器】
 * 早先版本额外渲染 `<span class="md-sr">{{ toPlainText(source) }}</span>` 作为
 * 无障碍副本。实测发现它有两个害处：
 *   1) 屏幕阅读器会把同一句正文**读两遍**（副本一遍 + 真实段落一遍），是可访问性
 *      倒退，而不是改进；
 *   2) 视觉隐藏节点的文本仍参与 DOM 文本匹配，PM 门禁
 *      `management/browser-check.mjs` 的 `getByText(content, { exact: true })`
 *      因此命中 2 个元素并抛 strict mode violation，把真实回归卡红。
 * 渲染出的 VNode 树本身就是可读语义（`<p>` / `<strong>` / `<code>` / 列表），
 * 已经满足无障碍需求，不需要也不应该再叠一层隐藏副本。
 */
import { computed } from 'vue'
import MarkdownNodes from './MarkdownNodes'
import { renderMarkdown } from '@/utils/markdown'

const props = withDefaults(
  defineProps<{
    /** Markdown 源串（完全不可信输入）。 */
    source: string
    /** 'rendered' 渲染；'source' 原样显示源码。 */
    renderMode?: 'rendered' | 'source'
    /** 代码块缺少语言标注时的徽标文案。 */
    codeLabel?: string
  }>(),
  { renderMode: 'rendered', codeLabel: '代码' },
)

const nodes = computed(() =>
  props.renderMode === 'source' ? [] : renderMarkdown(props.source, { codeLabel: props.codeLabel }),
)
</script>

<template>
  <div class="md" :class="`md--${renderMode}`">
    <pre v-if="renderMode === 'source'" class="md-source">{{ source }}</pre>
    <template v-else>
      <!-- VNode 数组作为子节点：Vue createTextNode，无 HTML 解析 -->
      <MarkdownNodes :nodes="nodes" />
    </template>
  </div>
</template>

<style>
/*
 * 全局样式（无 scoped）：成员是 renderMarkdown 生成的普通 DOM，scoped 的
 * data-v 属性覆盖不到它们。所有选择器都以 `.md` / `.md-` 前缀收敛，不污染别处。
 * 颜色只用语义变量 / currentColor 混合，保证在「浅色对方面板」「品牌色自方气泡」
 * 「深色主题」三种背景下都可读。
 */
.md {
  min-width: 0;
  max-width: 100%;
}

.md__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.md__body > :first-child {
  margin-top: 0;
}

.md__body > :last-child {
  margin-bottom: 0;
}

/* ── 段落与换行 ── */
.md-p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.md-h {
  margin: 0;
  font-weight: 600;
  line-height: 1.35;
}

.md-h--1 {
  font-size: 1.3em;
}
.md-h--2 {
  font-size: 1.2em;
}
.md-h--3 {
  font-size: 1.1em;
}
.md-h--4,
.md-h--5,
.md-h--6 {
  font-size: 1em;
}

.md-hr {
  border: none;
  border-top: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  margin: 2px 0;
}

/* ── 行内 ── */
.md-strong {
  font-weight: 650;
}

.md-em {
  font-style: italic;
}

.md-del {
  text-decoration: line-through;
  opacity: 0.72;
}

.md-code-inline {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.9em;
  padding: 0.1em 0.36em;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 14%, transparent);
  overflow-wrap: anywhere;
}

.md-link {
  color: var(--md-link, currentColor);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
  overflow-wrap: anywhere;
}

.md-link:hover {
  opacity: 0.85;
}

/* ── 代码块（深底浅字：在浅色气泡与品牌色气泡上都稳） ── */
.md-code {
  border-radius: 6px;
  overflow: hidden;
  background: var(--md-code-bg, #151b23);
  color: var(--md-code-fg, #e6edf3);
  border: 1px solid color-mix(in srgb, #000 28%, transparent);
}

.md-code__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 4px 3px 9px;
  background: color-mix(in srgb, #fff 7%, transparent);
  font-size: 11px;
  line-height: 1.6;
  color: color-mix(in srgb, var(--md-code-fg, #e6edf3) 68%, transparent);
}

.md-code__lang {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  letter-spacing: 0.02em;
  text-transform: lowercase;
}

.md-code__copy {
  flex: 0 0 auto;
  border: none;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  background: color-mix(in srgb, #fff 12%, transparent);
  color: inherit;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.md-code__copy:hover {
  background: color-mix(in srgb, #fff 22%, transparent);
}

.md-code__copy--done {
  background: color-mix(in srgb, var(--color-success-500, #2f9e6e) 78%, transparent);
  color: #fff;
}

.md-code__pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  max-width: 100%;
}

.md-code__code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
  tab-size: 2;
}

/* ── 引用 ── */
.md-quote {
  margin: 0;
  padding: 1px 0 1px 9px;
  border-left: 3px solid color-mix(in srgb, currentColor 32%, transparent);
  color: color-mix(in srgb, currentColor 82%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── 列表 ── */
.md-ul,
.md-ol {
  margin: 0;
  padding-left: 1.35em;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.md-ul {
  list-style: disc;
}

.md-ol {
  list-style: decimal;
}

.md-li {
  margin: 0;
  overflow-wrap: anywhere;
}

.md-li > .md-ul,
.md-li > .md-ol {
  margin-top: 2px;
}

.md-task {
  display: inline-block;
  width: 1.15em;
  margin-right: 0.15em;
  color: color-mix(in srgb, currentColor 78%, transparent);
}

/* ── 表格 ── */
.md-table-wrap {
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
}

.md-table {
  border-collapse: collapse;
  font-size: 0.95em;
  min-width: 100%;
}

.md-table th,
.md-table td {
  padding: 4px 9px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.md-table th {
  font-weight: 600;
  background: color-mix(in srgb, currentColor 9%, transparent);
}

.md-table tbody tr:last-child td {
  border-bottom: none;
}

/* ── 源码模式 ── */
.md--source {
  min-width: 0;
}

.md-source {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  opacity: 0.92;
}

/* ── 手机：字号与点按 ── */
@media (max-width: 767px) {
  .md__body {
    gap: 7px;
  }

  .md-code__code {
    font-size: 12px;
  }

  .md-table {
    font-size: 0.9em;
  }
}
</style>
