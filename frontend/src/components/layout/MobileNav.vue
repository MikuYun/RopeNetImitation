<script setup lang="ts">
/**
 * 手机底部导航。
 *
 * 【为什么单独做一个组件而不是复用 AppRail】AppRail 是 PC 的**竖侧栏**，
 * 竖排、含头像、贴左边。手机上要的是横排、贴底部、只有两个 tab 的形态。
 * 用同一组件靠媒体查询变形会导致模板里塞满两套结构的条件渲染，难维护；
 * 分开后各自结构清晰，也让 PC 侧栏完全不进入移动端 DOM（少一批隐藏元素）。
 *
 * 结构约束（任务书 §三）：
 *   - 只保留「聊天」「联系人」两个 tab，不伪造其它产品有而本项目没有的入口
 *   - 主题与退出登录收进「更多」，保证在手机上仍然可达
 *   - 「更多」用底部面板（sheet），不用居中弹窗 —— 拇指可达性更好
 *   - 热区 >= 44x44（--spacing-touch-target）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useUiStore } from '@/stores/ui'
import {
  collectFocusables,
  dialogKeyAction,
  initialFocusIndex,
  type DialogKeyAction,
} from '@/utils/dialogA11y'

const auth = useAuthStore()
const ui = useUiStore()
const convStore = useConversationStore()
const friendStore = useFriendStore()
const router = useRouter()

const unread = computed(() => convStore.totalUnread)
const pending = computed(() => friendStore.incomingCount)

/**
 * 点击 tab：切 tab 的同时回到列表屏。
 *
 * 【为什么这里要用命名路由跳转】用户可能正停在某个会话正文里，此时底部
 * 导航是隐藏的；但仍要覆盖「详情页/深链后退回来」等场景 —— 统一在点击时
 * 显式回到 chat-empty，保证 route 与 railTab 一致，不出现「tab 亮了但屏幕
 * 还停在正文」的错位。
 */
async function goTab(tab: 'chats' | 'contacts'): Promise<void> {
  ui.setRailTab(tab)
  convStore.setActive(null)
  if (router.currentRoute.value.name !== 'chat-empty') {
    await router.push({ name: 'chat-empty' })
  }
}

async function onLogout(): Promise<void> {
  ui.closeMore()
  await auth.logout()
  void router.push({ name: 'login' })
}

/**
 * 「更多」面板的焦点管理 —— 与桌面 `AppModal` 共用 `@/utils/dialogA11y` 的判定。
 *
 * 【为什么需要】面板是 `role="dialog" aria-modal="true"`，但之前一行键盘处理都没有：
 *   - 按 Esc 关不掉（桌面弹层能关，手机面板不能 —— 同一产品的两条不一致契约）；
 *   - Tab 会从「取消」跑到 `<body>`，焦点离开可见区域，键盘/读屏用户直接卡住。
 * 现在两条都补齐，且**不碰**原有的遮罩点击关闭与「取消」按钮（那两条 e2e 已 PASS）。
 */
const sheetRef = ref<HTMLElement | null>(null)
/** 打开前的焦点位置，关闭时归还（与 AppModal 同一策略）。 */
let restoreTarget: HTMLElement | null = null

function focusIndexIn(list: HTMLElement[]): number {
  const active = document.activeElement
  if (!active) return -1
  return list.indexOf(active as HTMLElement)
}

function runAction(action: DialogKeyAction, e: KeyboardEvent, list: HTMLElement[]): void {
  if (!action) return
  if (action.type === 'close') {
    e.preventDefault()
    ui.closeMore()
    return
  }
  e.preventDefault()
  const el = action.target === 'first' ? list[0] : list[list.length - 1]
  el?.focus()
}

function onSheetKeydown(e: KeyboardEvent): void {
  const list = collectFocusables(sheetRef.value)
  runAction(
    dialogKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      dialogOpen: ui.moreSheetOpen,
      focusableCount: list.length,
      focusIndex: focusIndexIn(list),
      isComposing: e.isComposing,
    }),
    e,
    list,
  )
}

function restoreFocus(): void {
  const target = restoreTarget
  restoreTarget = null
  // 退出登录后触发按钮所在的导航可能已被卸载，isConnected 判一下再还给元素。
  if (target && target.isConnected) target.focus()
}

watch(
  () => ui.moreSheetOpen,
  async (open) => {
    if (open) {
      const active = document.activeElement
      restoreTarget = active instanceof HTMLElement ? active : null
      await nextTick()
      const list = collectFocusables(sheetRef.value)
      const idx = initialFocusIndex(list.length)
      // idx === -1 时退到面板本身（`.sheet` 带 tabindex="-1"）。
      if (idx >= 0) list[idx]?.focus()
      else sheetRef.value?.focus()
    } else {
      restoreFocus()
    }
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('keydown', onSheetKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onSheetKeydown)
  restoreFocus()
})
</script>

<template>
  <nav class="mnav">
    <button
      class="mnav__tab"
      :class="{ 'mnav__tab--on': ui.railTab === 'chats' }"
      type="button"
      @click="goTab('chats')"
    >
      <span class="mnav__icon">
        <AppIcon name="chat" :size="22" />
        <span v-if="unread > 0" class="mnav__badge">{{ unread > 99 ? '99+' : unread }}</span>
      </span>
      <span class="mnav__label">聊天</span>
    </button>

    <button
      class="mnav__tab"
      :class="{ 'mnav__tab--on': ui.railTab === 'contacts' }"
      type="button"
      @click="goTab('contacts')"
    >
      <span class="mnav__icon">
        <AppIcon name="contact" :size="22" />
        <span v-if="pending > 0" class="mnav__badge">{{ pending > 99 ? '99+' : pending }}</span>
      </span>
      <span class="mnav__label">联系人</span>
    </button>

    <button class="mnav__tab" type="button" @click="ui.openMore()">
      <span class="mnav__icon"><AppIcon name="more" :size="22" /></span>
      <span class="mnav__label">更多</span>
    </button>
  </nav>

  <!-- 更多：底部面板。主题与退出登录必须能在手机上到达。 -->
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="ui.moreSheetOpen" class="mask" @click.self="ui.closeMore()">
        <div
          ref="sheetRef"
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="更多"
          tabindex="-1"
        >
          <div class="sheet__handle" />
          <button class="sheet__item" type="button" @click="ui.toggleTheme()">
            <AppIcon :name="ui.theme === 'dark' ? 'sun' : 'moon'" :size="19" />
            <span>{{ ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题' }}</span>
          </button>
          <button class="sheet__item sheet__item--danger" type="button" @click="onLogout">
            <AppIcon name="logout" :size="19" />
            <span>退出登录</span>
          </button>
          <button class="sheet__cancel" type="button" @click="ui.closeMore()">取消</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mnav {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  background: var(--app-panel);
  border-top: 1px solid var(--app-border);
  /* 底部手势条不遮住 tab */
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}

.mnav__tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  /* 热区 >= 44px；图标 22 + 文字 + 间距自然超过，这里再给下限兜底 */
  min-height: var(--spacing-touch-target);
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  cursor: pointer;
}
.mnav__tab--on {
  color: var(--color-brand-500);
}

.mnav__icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mnav__label {
  font-size: 11px;
  line-height: 1;
}
.mnav__badge {
  position: absolute;
  top: -4px;
  right: -10px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--color-danger-500);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: flex-end;
  background: rgb(23 26 31 / 0.42);
}
.sheet {
  width: 100%;
  background: var(--app-panel);
  border-radius: 12px 12px 0 0;
  padding: 8px 8px calc(8px + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sheet__handle {
  width: 36px;
  height: 4px;
  margin: 4px auto 8px;
  border-radius: 2px;
  background: var(--app-border);
}
.sheet__item {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 热区 >= 44px */
  min-height: var(--spacing-touch-target);
  padding: 10px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  font-size: 15px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.sheet__item:active {
  background: var(--app-hover);
}
.sheet__item--danger {
  color: var(--color-danger-500);
}
.sheet__cancel {
  min-height: var(--spacing-touch-target);
  margin-top: 4px;
  border: none;
  border-radius: 8px;
  background: var(--app-panel-alt);
  color: var(--app-text-muted);
  font-size: 15px;
  font-family: inherit;
  cursor: pointer;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.18s ease;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
</style>
