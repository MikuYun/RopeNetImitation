<script setup lang="ts">
/**
 * 消息气泡。
 *
 * 安全硬规则：消息文本**永不**使用 v-html，一律 {{ }} 插值 ——
 * opaque token 存在 localStorage，XSS 的影响被放大，不能用富文本渲染换便利。
 *
 * 【本轮渲染 Markdown 时如何继续遵守这条规则】
 * Markdown **不是**先转成 HTML 字符串再 innerHTML —— 那样等于把 v-html 换了个
 * 马甲，规则的字面与精神都被绕过。这里的链路是：
 *
 *   message.content (不可信字符串)
 *     → renderMarkdown() 纯函数         （utils/markdown.ts）
 *     → VNode 树（h() 直接构造，无 HTML 中间态）
 *     → <MarkdownNodes :nodes>  作为子节点挂载
 *
 * Vue 对字符串子节点一律走 `createTextNode`，浏览器不会把它当 HTML 二次解析，
 * 因此「消息正文变成可执行标记」这条路径在**构造上**不存在。源码视图走
 * `<pre>{{ source }}</pre>`，同样是文本插值。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 【UX2 交互模型改造：操作按钮不再浮在气泡上】
 *
 * 旧实现把 `.bubble__tools` 用 `position: absolute; top: -10px` 贴在气泡内部
 * 上沿，手机端还改成了常显 —— 于是白色按钮直接盖住正文首行（用户原话：
 * 「浮在气泡上的按钮挡住了消息正文，手机上一整块看不到内容」）。
 *
 * 新模型：
 *   - 桌面：`.bubble__tools` 是 `.bubble` 的**兄弟节点**（包在 `.bubble-wrap`
 *     的 flex 行里），hover / focus-within 时出现在气泡**外侧**，有 6px 间距，
 *     永远不覆盖正文；纯 opacity 控制显隐，不产生布局跳动。
 *   - 手机（<= 767px）：**彻底不悬浮**。`.bubble__tools` 直接 `display: none`，
 *     改为**长按气泡**（500ms）弹出操作菜单（复用 AppModal，手机自动变底部
 *     抽屉）。菜单项：复制 / 回复 / 看源码 / 置顶 / 下载附件 / 撤回。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 【v2 契约（API 0.3.0）：一条消息可以有多个附件、可以被撤回、可以引用回复】
 *
 *   message.attachments: Attachment[]   —— 恒存在，无附件是 []
 *   message.recalled: boolean           —— true 时正文/附件都不再渲染
 *   message.replyTo: ReplyRef | null    —— 引用条，点击回到原消息
 *
 * 三个必须讲清楚的实现决定：
 *
 * 1) `recalled` 走的是「系统提示」形态，而不是把气泡灰掉。
 *    服务端在撤回后把 content 清空、attachments 清空，本地缓存里若还留着旧
 *    正文（撤回前渲染过的节点），只要继续走气泡分支就一定会把被撤回的内容
 *    画出来 —— 那是**真泄露**。所以 recalled 分支必须是「整段不渲染正文与
 *    附件」的另一个形态，而不是在气泡上加个灰滤镜。
 *
 * 2) 附件与正文**同时**渲染，不做互斥。
 *    正文与附件互不依赖：可以只有图、也可以只有字、还可以图文并存（`type`
 *    只是服务端按附件推导的分类标签，不是渲染分支依据）。若按 type 互斥
 *    渲染，用户给图片配的文字会凭空消失。
 *
 *    但 `.bubble--attach` 这个类名必须继续挂在所有带附件的消息上：
 *    `e2e-attachment.mjs` 靠 `.bubble--attach` 定位「带附件的消息」。
 *    所以「类和文案分支」解耦：类照挂，内边距用 `.bubble--attach-text` 收紧。
 *
 * 3) 引用条是个 `<button>`，不是装饰性 div。
 *    点击它要跳回原消息，键盘用户必须能 Tab 到并回车触发；用 div + @click
 *    等于对键盘用户隐藏该功能。同理 aria-label 里带上被引用者名字。
 *
 * 保留全部既有类名（`.sys`、`.line`、`.line--mine`、`.line--peer`、
 * `.line__avatar`、`.line__col`、`.line__sender`、`.bubble`、`.bubble--mine`、
 * `.bubble--peer`、`.bubble--attach`、`.bubble__text`、`.bubble__att`、
 * `.line__meta`、`.line__time`）—— e2e 依赖它们，一个都不能删。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import AttachmentView from '@/components/message/AttachmentView.vue'
import MarkdownView from '@/components/message/MarkdownView.vue'
import MessageStatusIcon from '@/components/message/MessageStatusIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { hasMarkdownSyntax } from '@/utils/markdown'
import { downloadAttachment } from '@/api/uploads'
import {
  LONG_PRESS_MS,
  canRecallMessage,
  createLongPress,
  messageMenuItems,
  shouldOpenMessageMenu,
} from '@/components/message/messageMenu'
import type { Attachment, LocalMessage, ConversationType } from '@/types/domain'
import { formatBubbleTime } from '@/utils/datetime'

const props = defineProps<{
  message: LocalMessage
  mine: boolean
  convType: ConversationType
  senderName?: string
  senderId?: string
  /**
   * 发送者头像地址（需求 1 的配套修复：气泡旁的头像也必须显示真实头像）。
   * 留空则 AppAvatar 回退到「首字母 + 派生底色」，不会出现破图。
   */
  senderAvatar?: string
  /** 单聊对方是否已读到这条。 */
  readByPeer?: boolean
  /** 群聊已读人数（不含自己）；0 表示不显示。 */
  readCount?: number
  /** 这条消息是否已在置顶列表里（决定菜单显示「置顶」还是「取消置顶」）。 */
  pinned?: boolean
}>()

const emit = defineEmits<{
  /** 请求置顶（参数是消息 UUID，不是 seq）。 */
  pin: [msgId: string]
  /** 请求取消置顶（参数是消息 UUID）。 */
  unpin: [msgId: string]
  /** 点击引用条，请求滚动定位到被引用的消息（参数是消息 UUID）。 */
  'jump-to': [msgId: string]
  /** 请求引用回复这条消息（参数是消息 UUID）。 */
  reply: [msgId: string]
  /** 请求撤回这条消息（参数是消息 UUID）。 */
  recall: [msgId: string]
  /**
   * 点击对方头像 → 打开访客资料页（需求 2）。
   * 参数是被点击消息的发送者 id；上层负责 `router.push({name:'user-profile'})`。
   * 「自己的头像」也走同一事件 —— 由上层判断等于自己时进「我的资料」，
   * 组件不重复实现这层身份判定。
   */
  'open-profile': [userId: string]
}>()

const ui = useUiStore()
const { isMobile } = useBreakpoint()

const isSystem = computed(() => props.message.type === 'system')
const time = computed(() => formatBubbleTime(props.message.createdAt))
const showSender = computed(() => props.convType === 'group' && !props.mine && !isSystem.value)

/* ── 撤回 ─────────────────────────────────────────────────────── */

/** 已撤回：正文与附件一律不渲染（见文件头注释第 1 条）。 */
const recalled = computed(() => props.message.recalled === true)

/**
 * 撤回提示文案。
 *
 * 自己撤回显示「你」——群聊里「你撤回了一条消息」比「张三撤回了一条消息」
 * 更符合各家 IM 的既有习惯，也避免昵称过长把提示撑到换行。
 */
const recallText = computed(() => {
  if (props.mine) return '你撤回了一条消息'
  const who = props.senderName?.trim()
  return who ? `${who}撤回了一条消息` : '对方撤回了一条消息'
})

/* ── 附件 ─────────────────────────────────────────────────────── */

/** 一组附件（v2：恒为数组，空数组表示无附件）。 */
const attachments = computed<Attachment[]>(() => props.message.attachments ?? [])
const hasAttachments = computed(() => attachments.value.length > 0)
const hasText = computed(() => props.message.content.trim().length > 0)

/** 附件下载按钮只针对第一个文件类附件（图片/视频走 Viewer 内部的下载入口）。 */
const firstFileAttachment = computed<Attachment | null>(() => {
  return attachments.value.find((a) => a.kind === 'file') ?? attachments.value[0] ?? null
})
const hasFileAttachment = computed(() => attachments.value.some((a) => a.kind === 'file'))

/* ── 引用回复 ─────────────────────────────────────────────────── */

const replyTo = computed(() => props.message.replyTo ?? null)

function onJumpTo(): void {
  const target = replyTo.value
  if (!target) return
  emit('jump-to', target.msgId)
}

/** 点对方头像 → 抛给上层跳访客资料页（需求 2）。 */
function onOpenProfile(): void {
  const target = props.senderId || props.message.senderId
  if (!target) return
  emit('open-profile', target)
}

/* ── 折叠 / 渲染态 ────────────────────────────────────────────── */

/**
 * 长消息折叠。
 *
 * 【关键约束】必须**保留正文在 DOM 里**：`frontend/e2e-matrix.mjs:774` 用
 * `.bubble` 的 textContent 找消息，若折叠改成 `v-if` 移除文本，那条断言会
 * 直接失败。所以折叠只用 CSS（max-height + overflow），展开即去掉这个类。
 */
const CLAMP_THRESHOLD = 2000
const clampable = computed(
  () => !isSystem.value && !recalled.value && props.message.content.length > CLAMP_THRESHOLD,
)
const expanded = computed(() => expandedOnce.value || !clampable.value)
const expandedOnce = ref(false)

/**
 * 渲染态 / 源码态。
 *
 * 源码态用 `<pre>{{ source }}</pre>` 插值，不是 v-html —— 依然是纯文本节点。
 * 切换不改变 message 数据，只改视图，因此不会影响发送/重试。
 */
const renderMode = ref<'rendered' | 'source'>('rendered')
const canToggleSource = computed(
  () => !isSystem.value && !recalled.value && hasText.value && hasMarkdownSyntax(props.message.content),
)

/** 消息主键：优先服务端 msgId，乐观消息则用 localId（两者都是稳定字符串）。 */
const msgId = computed(() => props.message.msgId || props.message.localId)

/* ── 手机长按菜单 ─────────────────────────────────────────────── */

/**
 * 判定逻辑（阈值、取消、是否该弹）收敛在 `messageMenu.ts` 的纯函数里，
 * 这样在 node 环境（本项目 vitest 没有 jsdom）也能直接单测 —— 组件这里
 * 只负责把 DOM 事件喂进去、把结果渲染出来。
 *
 * 【为什么用定时器而不是 `touchstart` 直接开】长按必须与「滚动/滑动」区分开：
 * 手指按在气泡上开始滚动列表是很常见的，若 touchstart 立即弹菜单，用户根本
 * 没法正常翻消息。所以 500ms 内任何 touchmove/touchend 都会取消。
 *
 * `contextmenu` 也要拦：安卓 Chrome 长按会触发原生菜单，两套菜单叠在一起。
 * 但只在移动端拦，桌面保留右键（桌面本身有 hover 工具条，右键菜单无害且
 * 是浏览器默认行为的一部分，不该被前端夺走）。
 */
const menuOpen = ref(false)

const longPress = createLongPress(() => {
  openMenu()
}, LONG_PRESS_MS)

function clearPress(): void {
  longPress.cancel()
}

function onTouchStart(): void {
  if (!shouldOpenMessageMenu(isSystem.value, isMobile.value)) return
  clearPress()
  longPress.start()
}

function onTouchEnd(): void {
  clearPress()
}

function onContextMenu(e: MouseEvent): void {
  // 移动端：接管长按（原生菜单会与我们的操作菜单打架）
  if (!shouldOpenMessageMenu(isSystem.value, isMobile.value)) return
  e.preventDefault()
  openMenu()
}

function openMenu(): void {
  // 长按在「复制不了任何内容」的系统消息上没有意义（shouldOpenMessageMenu 已拦，
  // 这里再兜一次：定时器可能在消息被替换成 system 后才触发）。
  if (isSystem.value) return
  menuOpen.value = true
}

function closeMenu(): void {
  menuOpen.value = false
}

onUnmounted(clearPress)

/* ── 菜单可用性 ───────────────────────────────────────────────── */

/**
 * 能否引用回复。
 *
 * 必须有**服务端 msgId** 且已发送成功：乐观消息的 id 是本地 `localId`，
 * 服务端不认识，拿它当 replyToMsgId 发出去会 400/404。与其让用户点了回复
 * 再看到失败，不如这条消息在发送成功前干脆不给「回复」。
 * 已撤回的消息也不给回复 —— 引用一条「已撤回」没有信息价值。
 */
const canReply = computed(
  () =>
    !isSystem.value &&
    !recalled.value &&
    props.message.status === 'sent' &&
    props.message.msgId.length > 0,
)

/**
 * 能否撤回。
 *
 * 「作者本人 + 未撤回 + 已发送成功 + 距 createdAt ≤ 120s」四条判定全部收敛在
 * `messageMenu.ts` 的纯函数里（可单测），组件只喂当前时间进去。
 * 注意这里的结果只决定**菜单里显不显示**；真正拦截仍在服务端（403
 * RECALL_WINDOW_EXPIRED）—— 本地时钟不准时也不该让请求发不出去。
 */
const canRecall = computed(() =>
  canRecallMessage({
    isMine: props.mine,
    recalled: recalled.value,
    status: props.message.status,
    createdAt: props.message.createdAt,
  }),
)

/** 菜单项清单（顺序与出现条件都在 messageMenu.ts 里定）。 */
const menuItems = computed(() =>
  messageMenuItems({
    hasText: hasText.value,
    canReply: canReply.value,
    canToggle: canToggleSource.value,
    pinned: props.pinned === true,
    hasAttachment: hasAttachments.value,
    canRecall: canRecall.value,
  }),
)

const copyState = ref<'idle' | 'done' | 'failed'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function copyContent(): Promise<void> {
  if (!hasText.value) return
  try {
    // clipboard 在非安全上下文/无权限时会抛；降级提示不让按钮静默无反应
    await navigator.clipboard.writeText(props.message.content)
    copyState.value = 'done'
  } catch {
    copyState.value = 'failed'
    ui.toast('复制失败，请手动选择文本', 'error')
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, 1600)
}

function toggleSource(): void {
  renderMode.value = renderMode.value === 'source' ? 'rendered' : 'source'
}

function expand(): void {
  expandedOnce.value = true
}

async function onDownload(att: Attachment): Promise<void> {
  try {
    await downloadAttachment(att)
  } catch {
    ui.toast('下载失败，附件可能已被清理', 'error')
  }
}

/** 菜单里的「置顶/取消置顶」：先关菜单再发事件，避免弹窗盖住结果反馈。 */
function togglePin(): void {
  closeMenu()
  if (props.pinned) emit('unpin', msgId.value)
  else emit('pin', msgId.value)
}

function menuToggleSource(): void {
  closeMenu()
  toggleSource()
}

function menuCopy(): void {
  closeMenu()
  void copyContent()
}

function menuDownload(): void {
  closeMenu()
  const att = firstFileAttachment.value
  if (att) void onDownload(att)
}

/** 菜单「回复」：关菜单后把 msgId 抛给上层（上层负责设置 composer 的 replyTarget）。 */
function menuReply(): void {
  closeMenu()
  emit('reply', msgId.value)
}

/** 菜单「撤回」：关菜单后抛给上层（上层负责调接口 + toast）。 */
function menuRecall(): void {
  closeMenu()
  emit('recall', msgId.value)
}

watch(
  () => props.message.localId,
  () => {
    // 虚拟列表复用节点时，视图态必须跟着消息走，否则上一条的「源码态」会串到新消息
    renderMode.value = 'rendered'
    expandedOnce.value = false
    menuOpen.value = false
  },
)
</script>

<template>
  <div class="msg" :data-msg-id="msgId" :data-pinned="pinned ? 'true' : undefined">
    <div v-if="isSystem" class="sys">
      <span class="sys__text">{{ message.content }}</span>
    </div>

    <!--
      已撤回：整段不渲染正文与附件，只留一条居中灰色系统提示。
      这不是「视觉降级」，是**数据脱敏**——撤回后 content 已由服务端清空，
      但本地缓存/乐观消息里可能还留着撤回前的正文，走气泡分支就会画出来。
    -->
    <div v-else-if="recalled" class="sys sys--recall">
      <span class="sys__text">{{ recallText }}</span>
    </div>

    <div
      v-else
      class="line"
      :class="mine ? 'line--mine' : 'line--peer'"
      @touchstart.passive="onTouchStart"
      @touchend="onTouchEnd"
      @touchmove="onTouchEnd"
      @touchcancel="onTouchEnd"
      @contextmenu="onContextMenu"
    >
      <!--
        对方头像（需求 2：点消息里的头像进访客资料页）。
        用 <button> 包住而不是给 AppAvatar 加 click —— AppAvatar 是纯展示组件
        （无 emit），给它塞交互会把 a11y 责任散到 9 个调用方。这里保持
        「可点的是按钮、按钮里有头像」，键盘可 Tab 到、回车可触发。
        `touch-target` 保证移动端热区 ≥44px（图标只有 34px）。
      -->
      <button
        v-if="!mine"
        class="line__avatar-btn touch-target"
        type="button"
        :aria-label="`查看 ${senderName || '对方'} 的资料`"
        @click="onOpenProfile"
      >
        <AppAvatar
          class="line__avatar"
          :name="senderName || '?'"
          :seed="senderId || message.senderId"
          :src="senderAvatar ?? ''"
          :size="34"
        />
      </button>

      <div class="line__col">
        <span v-if="showSender" class="line__sender">{{ senderName }}</span>

        <!--
          气泡与工具条是**兄弟节点**：工具条在气泡外侧，不覆盖正文。
          手机端工具条 display:none（改长按菜单），因此这一层在窄屏上是单列。
        -->
        <div class="bubble-wrap">
          <div
            class="bubble"
            :class="[
              mine ? 'bubble--mine' : 'bubble--peer',
              hasAttachments ? 'bubble--attach' : '',
              hasAttachments && hasText ? 'bubble--attach-text' : '',
              clampable && !expanded ? 'bubble--clamped' : '',
            ]"
          >
            <!--
              引用条：气泡顶部一行（引用者昵称 + 被引用内容预览）。
              必须可点击跳回原消息，所以是 button（键盘可达），不是装饰 div。
            -->
            <button
              v-if="replyTo"
              class="quote"
              type="button"
              :aria-label="`跳到 ${replyTo.senderName} 的这条消息`"
              @click="onJumpTo"
            >
              <span class="quote__name">{{ replyTo.senderName }}</span>
              <span class="quote__preview">{{ replyTo.preview }}</span>
            </button>

            <!-- 附件集合：图片网格 / 单个视频 / 文件卡片。点图片开灯箱，点文件下载。 -->
            <AttachmentView
              v-if="hasAttachments"
              class="bubble__att"
              :attachments="attachments"
              :align="mine ? 'self' : 'peer'"
              @download="onDownload"
            />

            <!-- 正文：Markdown → VNode 树。**永不** v-html。 -->
            <div v-if="hasText" class="bubble__text">
              <MarkdownView :source="message.content" :render-mode="renderMode" />
            </div>

            <!-- 折叠遮罩 + 展开按钮（正文始终留在 DOM） -->
            <button
              v-if="clampable && !expanded"
              class="bubble__expand"
              type="button"
              @click="expand"
            >
              展开全文（{{ message.content.length }} 字）
            </button>
          </div>

          <!--
            桌面悬浮操作：在气泡**外侧**（mine 在左、peer 在右，都朝屏幕中间），
            有 6px 间距。只要不 absolute，就不可能盖住正文。
          -->
          <div class="bubble__tools">
            <button
              v-if="hasText"
              class="bubble__tool"
              type="button"
              :title="copyState === 'done' ? '已复制' : '复制正文'"
              :aria-label="copyState === 'done' ? '已复制' : '复制正文'"
              @click="copyContent"
            >
              <svg v-if="copyState !== 'done'" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <rect
                  x="9"
                  y="9"
                  width="11"
                  height="11"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
                <path
                  d="M15 5H6a2 2 0 0 0-2 2v9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M5 12.5l4.5 4.5L19 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              v-if="canReply"
              class="bubble__tool"
              type="button"
              title="回复"
              aria-label="回复"
              @click="emit('reply', msgId)"
            >
              <AppIcon name="reply" :size="14" />
            </button>
            <button
              v-if="canToggleSource"
              class="bubble__tool"
              type="button"
              :title="renderMode === 'source' ? '看渲染效果' : '看 Markdown 源码'"
              :aria-label="renderMode === 'source' ? '看渲染效果' : '看 Markdown 源码'"
              :aria-pressed="renderMode === 'source'"
              @click="toggleSource"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M9 7l-5 5 5 5M15 7l5 5-5 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              class="bubble__tool"
              :class="{ 'bubble__tool--active': pinned }"
              type="button"
              :title="pinned ? '取消置顶' : '置顶消息'"
              :aria-label="pinned ? '取消置顶' : '置顶消息'"
              :aria-pressed="pinned ? 'true' : 'false'"
              @click="pinned ? emit('unpin', msgId) : emit('pin', msgId)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M9 3h6l-1 6 3.5 3.5H6.5L10 9z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linejoin="round"
                />
                <path d="M12 12.5V21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div class="line__meta">
          <span v-if="pinned" class="line__pin" title="已置顶" aria-label="已置顶">
            <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
              <path
                d="M9 3h6l-1 6 3.5 3.5H6.5L10 9z"
                fill="currentColor"
              />
              <path d="M12 12.5V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </span>
          <span class="line__time">{{ time }}</span>
          <MessageStatusIcon
            v-if="mine"
            :status="message.status"
            :read-by-peer="readByPeer"
            :read-count="readCount"
          />
        </div>
      </div>
    </div>

    <!--
      手机长按操作菜单。复用 AppModal：它在 <=767px 会自动变成贴底抽屉，
      自带焦点陷阱与 Esc 关闭，不需要为「底部 sheet」另写一套。
    -->
    <AppModal
      v-if="!isSystem"
      :open="menuOpen"
      title="消息操作"
      :width="360"
      @close="closeMenu"
    >
      <div class="sheet">
        <button v-if="menuItems.includes('copy')" class="sheet__item" type="button" @click="menuCopy">
          <span class="sheet__label">复制正文</span>
          <span class="sheet__hint">纯文本</span>
        </button>
        <button v-if="menuItems.includes('reply')" class="sheet__item" type="button" @click="menuReply">
          <span class="sheet__label">回复</span>
          <span class="sheet__hint">引用这条消息</span>
        </button>
        <button
          v-if="menuItems.includes('toggle-source')"
          class="sheet__item"
          type="button"
          @click="menuToggleSource"
        >
          <span class="sheet__label">{{ renderMode === 'source' ? '看渲染效果' : '看 Markdown 源码' }}</span>
          <span class="sheet__hint">{{ renderMode === 'source' ? '渲染' : '源码' }}</span>
        </button>
        <button v-if="menuItems.includes('toggle-pin')" class="sheet__item" type="button" @click="togglePin">
          <span class="sheet__label">{{ pinned ? '取消置顶' : '置顶消息' }}</span>
          <span class="sheet__hint">{{ pinned ? '从置顶条移除' : '在会话顶部固定' }}</span>
        </button>
        <button
          v-if="menuItems.includes('download-attachment') && hasFileAttachment"
          class="sheet__item"
          type="button"
          @click="menuDownload"
        >
          <span class="sheet__label">下载附件</span>
          <span class="sheet__hint">{{ firstFileAttachment?.name }}</span>
        </button>
        <button
          v-if="menuItems.includes('recall')"
          class="sheet__item sheet__item--danger"
          type="button"
          @click="menuRecall"
        >
          <span class="sheet__label">撤回</span>
          <span class="sheet__hint">2 分钟内可撤回</span>
        </button>
        <button class="sheet__item sheet__item--cancel" type="button" @click="closeMenu">
          <span class="sheet__label">取消</span>
        </button>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.sys {
  display: flex;
  justify-content: center;
  margin: 10px 0;
}
.sys__text {
  padding: 3px 10px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-text) 7%, transparent);
  color: var(--color-system-msg);
  font-size: 12px;
}
/* 撤回提示：与系统消息同形态（居中、灰色），只是语气更弱一点 */
.sys--recall .sys__text {
  font-style: normal;
  opacity: 0.88;
}

.line {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  align-items: flex-start;
}
.line--mine {
  flex-direction: row-reverse;
}
.line--peer {
  flex-direction: row;
}

/*
 * 头像按钮：视觉上仍是「无边框的头像」，但热区是 44×44。
 * 用负 margin 抵消多出来的点击区域，保证视觉间距与改造前一致
 * （改造前 .line__avatar 只有 margin-top:2px）。
 */
.line__avatar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: -5px -5px 0 -5px;
  padding: 5px;
  background: none;
  border: 0;
  border-radius: calc(var(--radius-md, 10px) + 5px);
  cursor: pointer;
}
.line__avatar-btn:hover {
  background: var(--app-hover);
}
.line__avatar-btn:focus-visible {
  outline: 2px solid var(--color-brand-500, #1d88b0);
  outline-offset: 2px;
}

.line__avatar {
  margin-top: 2px;
  pointer-events: none;
}

.line__col {
  display: flex;
  flex-direction: column;
  max-width: min(60%, 520px);
  min-width: 0;
}
.line--mine .line__col {
  align-items: flex-end;
}

.line__sender {
  font-size: 12px;
  color: var(--app-text-faint);
  margin-bottom: 3px;
}

/*
 * 气泡 + 工具条的横向容器。
 *
 * 【P0 关键】工具条是气泡的兄弟，不是绝对定位的浮层 —— 所以「按钮压字」
 * 在布局层面就不可能发生。`row-reverse` 让自己的消息把工具条放到气泡左侧
 * （朝屏幕中间），对方的放右侧，两者都不会顶到头像/屏幕边缘。
 */
.bubble-wrap {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.line--mine .bubble-wrap {
  flex-direction: row-reverse;
}

/*
 * 气泡。
 *
 * `white-space: pre-wrap` 是**留给纯文本/系统消息**的兜底；Markdown 渲染时
 * 段落由 .md-p 自行控制换行，重复的 pre-wrap 只会把结构化空白放大，故在
 * .bubble__text 上改回 normal（见下）。
 */
.bubble {
  position: relative;
  min-width: 0;
  padding: 8px 12px;
  border-radius: var(--radius-bubble);
  word-break: break-word;
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.55;
  max-width: 100%;
}
.bubble--mine {
  background: var(--bubble-self-bg);
  color: var(--bubble-self-text);
}
.bubble--peer {
  background: var(--bubble-peer-bg);
  color: var(--bubble-peer-text);
  box-shadow: var(--shadow-panel);
}

/*
 * 附件气泡：收紧内边距，避免缩略图被「框」住。
 * 这个类名 e2e 依赖（`.bubble--attach` 用来定位带附件的消息），必须保留。
 */
.bubble--attach {
  padding: 6px;
}
/* 附件 + 正文同时存在时，文字一侧要留出正常呼吸空间 */
.bubble--attach-text {
  padding: 6px 10px 9px;
}

/* ── 引用条 ───────────────────────────────────────────────────── */
.quote {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  max-width: 100%;
  margin: 0 0 6px;
  padding: 5px 8px;
  border: none;
  /* 左侧竖条是「引用」的通用视觉语言，比整块底色更轻 */
  border-left: 2px solid color-mix(in srgb, currentColor 42%, transparent);
  border-radius: 0 5px 5px 0;
  background: color-mix(in srgb, currentColor 9%, transparent);
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
}
.quote:hover {
  background: color-mix(in srgb, currentColor 15%, transparent);
}
.quote:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}
.quote__name {
  flex: 0 0 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium, 500);
  opacity: 0.9;
}
/* 预览只显示一行（要求：1 行省略） */
.quote__preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.68;
}

.bubble__text {
  display: block;
  min-width: 0;
  /* Markdown 自己负责换行；pre-wrap 会让列表/代码块的缩进和空行叠加 */
  white-space: normal;
}

.bubble__att {
  margin-bottom: 6px;
}
.bubble__att:last-child {
  margin-bottom: 0;
}

/* ── 长消息折叠：纯 CSS，正文仍在 DOM 里（e2e 依赖 .bubble 的 textContent） ── */
.bubble--clamped {
  max-height: 340px;
  overflow: hidden;
  /* 底部渐隐，暗示还有内容 */
  mask-image: linear-gradient(to bottom, #000 calc(100% - 62px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 62px), transparent 100%);
}
.bubble__expand {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  margin-top: 6px;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bubble__expand:hover {
  background: color-mix(in srgb, currentColor 15%, transparent);
}

/* ── 气泡外侧操作条（桌面临时显形；手机彻底不显示，改长按菜单） ── */
.bubble__tools {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  box-shadow: var(--shadow-pop);
  opacity: 0;
  transition: opacity 0.14s ease;
  pointer-events: none;
}
.bubble-wrap:hover .bubble__tools,
.bubble-wrap:focus-within .bubble__tools {
  opacity: 1;
  pointer-events: auto;
}
/* 键盘用户：focus 到气泡内的可聚焦元素时，工具条也要能 Tab 进去 */
.bubble__tools:focus-within {
  opacity: 1;
  pointer-events: auto;
}
.bubble__tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.bubble__tool:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.bubble__tool:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 1px;
}
.bubble__tool[aria-pressed='true'],
.bubble__tool--active {
  background: var(--app-active);
  color: var(--color-brand-600, var(--app-text));
}

.line__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
}
.line__pin {
  display: inline-flex;
  align-items: center;
  color: var(--color-brand-600, var(--color-brand-500));
}
.line__time {
  font-size: 11px;
  color: var(--app-text-faint);
}

/* ── 长按操作菜单（AppModal 内容） ── */
.sheet {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sheet__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.sheet__item:hover,
.sheet__item:focus-visible {
  background: var(--app-hover);
}
.sheet__item:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: -2px;
}
/* 撤回是破坏性操作：危险色 + 与其它项隔开一点 */
.sheet__item--danger {
  margin-top: 2px;
  color: var(--color-danger-500);
}
.sheet__item--danger:hover {
  background: color-mix(in srgb, var(--color-danger-500) 12%, transparent);
}
.sheet__hint {
  flex: 0 0 auto;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-text-faint);
}
.sheet__item--danger .sheet__hint {
  color: inherit;
  opacity: 0.72;
}
.sheet__item--cancel {
  justify-content: center;
  color: var(--app-text-muted);
}

/* ── 窄屏：气泡可用宽度放开 ───────────────────────────────────────
 * 桌面 60% 是合理的（太宽难读），但 320px 屏上 60% 只有 ~170px，
 * 长中文会碎成一列单字。手机上放宽到 76%，并收紧头像与间距。
 * ------------------------------------------------------------------ */
@media (max-width: 767px) {
  .line {
    gap: 6px;
    margin-bottom: 12px;
  }
  .line__col {
    max-width: 76%;
  }
  .bubble {
    /* 长 URL / 连续英文也要能断 */
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .bubble--clamped {
    max-height: 260px;
  }
  /*
   * 【P0】手机**不再**有悬浮操作条 —— 旧实现把它常显贴在气泡上沿，
   * 直接盖住正文。手机改用长按菜单（见模板里的 AppModal），
   * 这里必须彻底 display:none，而不只是 opacity:0（否则仍占位、仍可能
   * 被误认为可点，且会挤压气泡宽度）。
   */
  .bubble__tools {
    display: none;
  }
  .bubble__expand {
    min-height: 32px;
  }
  .quote {
    min-height: 32px;
  }
}
</style>
