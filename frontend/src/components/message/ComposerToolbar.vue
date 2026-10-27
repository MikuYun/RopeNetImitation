<script setup lang="ts">
/**
 * 输入框上方的 Markdown 工具条。
 *
 * 只负责「按钮 → 命令」，不碰 textarea：所有文本变换都在
 * `markdownEditing.ts` 的纯函数里，组件侧只把结果写回并恢复选区。
 * 这样工具条的边界情况（空选区、二次点击取消、多行加前缀）可以被单测逐条锁死。
 *
 * 按钮顺序按使用频率排：粗体、斜体、删除线、行内码、代码块、引用、列表、
 * 有序列表、链接、表格、标题。
 *
 * 【手机端为什么默认收起】11 个格式按钮横排最窄也要 480px，塞进 390px 的
 * 手机只会挤成一行小方块、还要和输入区抢高度。所以手机默认只露一个「Aa」
 * 开关 + 附件 + 预览；点「Aa」才展开格式按钮，展开后**横向滚动**（不换行，
 * 避免把输入框往下顶），每个按钮 44×44 满足触控热区。桌面端始终全展开，
 * 由 CSS 媒体查询切换，不需要 JS 感知断点，窗口缩放也不会出现状态错位。
 */
import { ref } from 'vue'
import type { MarkdownCommand } from '@/components/message/markdownEditing'

withDefaults(
  defineProps<{
    /** 预览态：工具条按钮禁用（预览时不可编辑，但仍可切回编辑）。 */
    preview?: boolean
    /** 正在上传附件：附件按钮显示转圈并禁用。 */
    uploading?: boolean
    /** 连接中断：整条禁用。 */
    disabled?: boolean
  }>(),
  { preview: false, uploading: false, disabled: false },
)

/**
 * 手机端格式按钮组的展开态。默认收起（见上面注释）。
 * 桌面端 `.cbar__group` 恒为 flex，这个值不生效。
 */
const open = ref(false)

function toggleOpen(): void {
  open.value = !open.value
}

const emit = defineEmits<{
  format: [MarkdownCommand]
  togglePreview: []
  /** 选图片：只接受图片 MIME（图库/拍照由系统决定，不加 capture）。 */
  pickImage: []
  /** 选视频：v2 起支持 mp4/webm（单个 ≤100 MiB，一条消息最多 1 个）。 */
  pickVideo: []
  /** 选文件：不限类型，由后端白名单决定成败。 */
  pickFile: []
}>()

interface ToolItem {
  cmd: MarkdownCommand
  label: string
  title: string
}

const tools: ToolItem[] = [
  { cmd: 'bold', label: 'B', title: '粗体 **文字** (Ctrl+B)' },
  { cmd: 'italic', label: 'I', title: '斜体 *文字* (Ctrl+I)' },
  { cmd: 'strike', label: 'S', title: '删除线 ~~文字~~' },
  { cmd: 'inline-code', label: '</>', title: '行内代码 `代码` (Ctrl+E)' },
  { cmd: 'code-block', label: '```', title: '代码块' },
  { cmd: 'quote', label: '❝', title: '引用 >' },
  { cmd: 'ul', label: '•—', title: '无序列表 - ' },
  { cmd: 'ol', label: '1.', title: '有序列表 1. ' },
  { cmd: 'link', label: '🔗', title: '链接 [文字](url) (Ctrl+K)' },
  { cmd: 'table', label: '▦', title: '表格' },
  { cmd: 'heading', label: 'H2', title: '标题 ## ' },
]
</script>

<template>
  <div class="cbar" :class="{ 'cbar--open': open }" role="toolbar" aria-label="Markdown 格式工具条">
    <button
      class="cbar__btn cbar__btn--toggle"
      type="button"
      :title="open ? '收起格式按钮' : '展开格式按钮'"
      :aria-label="open ? '收起格式按钮' : '展开格式按钮'"
      :aria-expanded="open"
      :disabled="disabled"
      @click="toggleOpen"
    >
      Aa
    </button>
    <div class="cbar__group">
      <button
        v-for="tool in tools"
        :key="tool.cmd"
        class="cbar__btn"
        :class="[`cbar__btn--${tool.cmd}`]"
        type="button"
        :title="tool.title"
        :aria-label="tool.title"
        :disabled="preview || disabled"
        @mousedown.prevent
        @click="emit('format', tool.cmd)"
      >
        {{ tool.label }}
      </button>
    </div>

    <div class="cbar__group cbar__group--end">
      <!--
        图片与文件是**两个**入口（ux2-contract §十二）：
        - 图片：accept 只列图片 MIME，选完立即可见缩略图；不加 capture，
          让系统自己决定走相册还是拍照（加了 capture 会强制调相机，
          用户没法从相册选图）。
        - 文件：不限 accept，用户选什么都行，后端白名单负责拒绝。
        合成一个「附件」按钮的话，用户在系统文件选择器里根本分不清
        「我是要发图还是发文件」，而且图片入口的 accept 会被文件入口污染。
      -->
      <button
        class="cbar__btn cbar__btn--image"
        type="button"
        :title="uploading ? '正在上传…' : '发送图片'"
        :aria-label="uploading ? '正在上传' : '发送图片'"
        :disabled="uploading || disabled"
        @click="emit('pickImage')"
      >
        <svg v-if="!uploading" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <rect
            x="3"
            y="5"
            width="18"
            height="14"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          />
          <circle cx="9" cy="10" r="1.5" fill="currentColor" />
          <path
            d="M4 17l5-4 3 2.5 3-2 5 3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-else class="cbar__spinner" aria-hidden="true" />
      </button>
      <!--
        视频是独立入口（v2 新增）：accept 只列 mp4/webm。
        与图片分开的原因同「图片 vs 文件」——用户在系统选择器里要有明确心智：
        视频上限是 100 MiB 且一条消息只能带 1 个，跟图片的 10 MiB / 9 张不是一回事。
      -->
      <button
        class="cbar__btn cbar__btn--video"
        type="button"
        :title="uploading ? '正在上传…' : '发送视频（MP4 / WebM，≤100 MB）'"
        :aria-label="uploading ? '正在上传' : '发送视频'"
        :disabled="uploading || disabled"
        @click="emit('pickVideo')"
      >
        <svg v-if="!uploading" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7" />
          <path
            d="M16 10l5-3v10l-5-3z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linejoin="round"
          />
        </svg>
        <span v-else class="cbar__spinner" aria-hidden="true" />
      </button>
      <button
        class="cbar__btn cbar__btn--attach"
        type="button"
        :title="uploading ? '正在上传…' : '发送文件（≤10 MB）'"
        :aria-label="uploading ? '正在上传' : '发送文件'"
        :disabled="uploading || disabled"
        @click="emit('pickFile')"
      >
        <svg v-if="!uploading" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <!-- 回形针：文件入口的通用隐喻 -->
          <path
            d="M9 12.5V8a3 3 0 0 1 6 0v7.5a5 5 0 0 1-10 0V9"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-else class="cbar__spinner" aria-hidden="true" />
      </button>
      <button
        class="cbar__btn cbar__btn--preview"
        type="button"
        :title="preview ? '返回编辑' : '预览 Markdown 效果'"
        :aria-label="preview ? '返回编辑' : '预览 Markdown 效果'"
        :aria-pressed="preview"
        :disabled="disabled"
        @click="emit('togglePreview')"
      >
        <svg v-if="!preview" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7" />
        </svg>
        <span v-else>编辑</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
  margin-bottom: 4px;
  /* 手机上按钮多，允许横向滚动而不换行把输入区挤扁 */
  overflow: hidden;
}

.cbar__group {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.cbar__group::-webkit-scrollbar {
  display: none;
}

.cbar__group--end {
  margin-left: auto;
  gap: 2px;
  overflow: visible;
  flex: 0 0 auto;
}

.cbar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.cbar__btn:hover:not(:disabled) {
  background: var(--app-hover);
  color: var(--app-text);
}

.cbar__btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.cbar__btn:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}

.cbar__btn--bold {
  font-weight: 800;
}
.cbar__btn--italic {
  font-style: italic;
  font-weight: 600;
}
.cbar__btn--strike {
  text-decoration: line-through;
  font-weight: 600;
}
.cbar__btn--inline-code,
.cbar__btn--code-block {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.cbar__btn--heading {
  font-weight: 700;
}
.cbar__btn--link {
  font-size: 13px;
}

.cbar__btn--table {
  font-size: 13px;
}

.cbar__btn--image,
.cbar__btn--attach,
.cbar__btn--preview {
  min-width: 28px;
  color: var(--app-text-muted);
}

/* 图片/文件是两个独立入口：留一道细分隔线，避免看成一枚按钮的两个图标 */
.cbar__btn--attach {
  margin-left: 2px;
}

.cbar__btn--preview {
  padding: 0 8px;
  font-size: 12px;
}

.cbar__btn--preview[aria-pressed='true'] {
  background: color-mix(in srgb, var(--color-brand-500) 16%, transparent);
  color: var(--color-brand-600);
}

.cbar__spinner {
  width: 13px;
  height: 13px;
  border: 2px solid color-mix(in srgb, var(--color-brand-500) 26%, transparent);
  border-top-color: var(--color-brand-500);
  border-radius: 50%;
  animation: cbar-spin 0.7s linear infinite;
}

@keyframes cbar-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 桌面端格式按钮始终展开，「Aa」开关不出现 */
.cbar__btn--toggle {
  display: none;
}

/* 手机：热区放大到 44px（触控热区），格式按钮默认收起、展开后横向滚动 */
@media (max-width: 767px) {
  .cbar {
    gap: 4px;
    padding-bottom: 5px;
  }
  .cbar__btn {
    min-width: 44px;
    height: 44px;
    font-size: 13px;
  }
  .cbar__btn--image,
  .cbar__btn--attach,
  .cbar__btn--preview {
    min-width: 44px;
  }
  /* 手机上把「Aa」开关露出来 */
  .cbar__btn--toggle {
    display: inline-flex;
    flex: 0 0 auto;
    font-weight: 700;
    color: var(--app-text-muted);
  }
  .cbar__btn--toggle[aria-expanded='true'] {
    background: color-mix(in srgb, var(--color-brand-500) 16%, transparent);
    color: var(--color-brand-600);
  }
  /* 收起态：**格式**按钮组隐藏，只剩 Aa + 图片 + 文件 + 预览。
     注意必须用 :not(.cbar__group--end) 排除右侧附件组——
     后者同样带 .cbar__group 类，早期写法会让手机端的图片/文件/预览
     一起被 display:none 掉，看起来就像「手机上没有发送图片和文件」。 */
  .cbar__group:not(.cbar__group--end) {
    display: none;
  }
  .cbar--open .cbar__group:not(.cbar__group--end) {
    display: flex;
    flex: 1 1 auto;
    /* 展开后横向滚动，不换行（换行会把输入框往下顶） */
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .cbar--open .cbar__group:not(.cbar__group--end)::-webkit-scrollbar {
    display: none;
  }
  /* 附件组在手机上必须始终可见、不可被压缩 */
  .cbar__group--end {
    display: flex;
    flex: 1 0 auto;
    justify-content: flex-end;
    margin-left: auto;
    overflow: visible;
  }
}

/* 减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .cbar__spinner {
    animation-duration: 2.4s;
  }
}
</style>
