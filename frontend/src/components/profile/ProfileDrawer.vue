<script setup lang="ts">
/**
 * 个人信息抽屉（桌面端，UI-V2 §3）。
 *
 * 【为什么是「覆盖整列」而不是居中弹窗】侧栏头像点开的东西是「我是谁」，
 * 它紧挨着会话/联系人列表，用同宽度的一列滑出比居中弹窗更符合空间关系：
 * 用户的视线从左上角往下扫，抽屉就从那里长出来，不打断右侧会话区。
 *
 * 【props 为什么是可选的】ChatView（Lead 独占）里的渲染点是 `<ProfileDrawer />`
 * —— 没有传参。所以 `open` 缺省时自取 `ui.profileDrawerOpen`；显式传参时以
 * props 为准（受控用法，便于测试/复用）。关闭时同时 `emit('close')` 与写 store，
 * 保证两条通路都能关掉它。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import ThemePicker from '@/components/theme/ThemePicker.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { useAuthStore } from '@/stores/auth'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore, THEME_LABELS } from '@/stores/ui'
import {
  collectFocusables,
  dialogKeyAction,
  initialFocusIndex,
  type DialogKeyAction,
} from '@/utils/dialogA11y'

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: undefined })
const emit = defineEmits<{ close: [] }>()

const auth = useAuthStore()
const ui = useUiStore()
const presence = usePresenceStore()
const router = useRouter()

/** 受控优先；未传 props.open 时看 store（ChatView 的无参用法）。 */
const isOpen = computed(() => (props.open === undefined ? ui.profileDrawerOpen : props.open))

const user = computed(() => auth.user)
const nickname = computed(() => auth.displayName || '未登录')
const username = computed(() => user.value?.username ?? '')
const uidText = computed(() => {
  const uid = user.value?.uid
  return uid && uid > 0 ? `#${uid}` : '—'
})
const bioText = computed(() => {
  const bio = user.value?.bio?.trim()
  return bio && bio.length > 0 ? bio : '这个人很懒，什么都没写'
})
const avatarSrc = computed(() => user.value?.avatarUrl ?? '')
const online = computed(() => presence.isOnline(auth.userId))
const themeName = computed(() => THEME_LABELS[ui.theme] ?? '自定义')

const themeOpen = ref(false)
const logoutOpen = ref(false)

function close(): void {
  emit('close')
  ui.closeProfileDrawer()
}

function openProfilePage(): void {
  close()
  void router.push({ name: 'profile' })
}

function toggleTheme(): void {
  themeOpen.value = !themeOpen.value
}

async function confirmLogout(): Promise<void> {
  logoutOpen.value = false
  close()
  await auth.logout()
  void router.replace({ name: 'login' })
}

/* ── 无障碍：焦点移入 / Esc / Tab 循环 / 归还 ──────────────────────── */

const panelRef = ref<HTMLElement | null>(null)
let restoreTarget: HTMLElement | null = null

function focusIndexIn(list: HTMLElement[]): number {
  const active = document.activeElement
  if (!active) return -1
  return list.indexOf(active as HTMLElement)
}

function restoreFocus(): void {
  const target = restoreTarget
  restoreTarget = null
  // 触发按钮可能已随路由切换卸载，isConnected 判一下再还。
  if (target && target.isConnected) target.focus()
}

function onKeydown(e: KeyboardEvent): void {
  const list = collectFocusables(panelRef.value)
  const action: DialogKeyAction = dialogKeyAction({
    key: e.key,
    shiftKey: e.shiftKey,
    dialogOpen: isOpen.value,
    focusableCount: list.length,
    focusIndex: focusIndexIn(list),
    isComposing: e.isComposing,
  })
  if (!action) return
  if (action.type === 'close') {
    e.preventDefault()
    close()
    return
  }
  e.preventDefault()
  const el = action.target === 'first' ? list[0] : list[list.length - 1]
  el?.focus()
}

watch(
  isOpen,
  async (open) => {
    if (open) {
      const active = document.activeElement
      restoreTarget = active instanceof HTMLElement ? active : null
      // 只在打开期间挂全局键盘监听：抽屉常驻挂载（ChatView 无参渲染），
      // 关闭后再挂着一个 keydown 监听既浪费也会和别的弹层抢 Esc。
      window.addEventListener('keydown', onKeydown)
      await nextTick()
      const list = collectFocusables(panelRef.value)
      const idx = initialFocusIndex(list.length)
      if (idx >= 0) list[idx]?.focus()
      else panelRef.value?.focus()
    } else {
      window.removeEventListener('keydown', onKeydown)
      themeOpen.value = false
      restoreFocus()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  restoreFocus()
})
</script>

<template>
  <Transition name="pdrawer">
    <div v-if="isOpen" class="pdrawer-mask" @click.self="close">
      <aside
        ref="panelRef"
        class="pdrawer"
        role="dialog"
        aria-modal="true"
        aria-label="个人信息"
        tabindex="-1"
      >
        <header class="pdrawer__head">
          <span class="pdrawer__title">个人信息</span>
          <button class="pdrawer__close" type="button" aria-label="关闭个人信息" @click="close">
            <AppIcon name="close" :size="16" />
          </button>
        </header>

        <div class="pdrawer__body">
          <div class="pdrawer__hero">
            <AppAvatar
              :name="nickname"
              :seed="auth.userId"
              :size="72"
              :radius="16"
              :src="avatarSrc"
            />
            <div class="pdrawer__hero-text">
              <div class="pdrawer__name">{{ nickname }}</div>
              <div v-if="username" class="pdrawer__account">@{{ username }}</div>
              <div class="pdrawer__uid">UID {{ uidText }}</div>
              <div class="pdrawer__presence">
                <PresenceDot :user-id="auth.userId" :size="8" />
                <span>{{ online ? '在线' : '离线' }}</span>
              </div>
            </div>
          </div>

          <p class="pdrawer__bio" :class="{ 'pdrawer__bio--empty': bioText === '这个人很懒，什么都没写' }">
            {{ bioText }}
          </p>

          <div class="pdrawer__entries">
            <button class="pdrawer__entry" type="button" @click="openProfilePage">
              <span class="pdrawer__entry-icon"><AppIcon name="user" :size="18" /></span>
              <span class="pdrawer__entry-label">详细资料</span>
              <span class="pdrawer__entry-chev" aria-hidden="true">
                <AppIcon name="expand-more" :size="16" />
              </span>
            </button>

            <button
              class="pdrawer__entry"
              type="button"
              :aria-expanded="themeOpen"
              aria-controls="pdrawer-theme-panel"
              @click="toggleTheme"
            >
              <span class="pdrawer__entry-icon"><AppIcon name="sun" :size="18" /></span>
              <span class="pdrawer__entry-label">主题</span>
              <span class="pdrawer__entry-value">{{ themeName }}</span>
              <span
                class="pdrawer__entry-chev"
                :class="{ 'pdrawer__entry-chev--open': themeOpen }"
                aria-hidden="true"
              >
                <AppIcon name="expand-more" :size="16" />
              </span>
            </button>

            <button
              class="pdrawer__entry pdrawer__entry--danger"
              type="button"
              @click="logoutOpen = true"
            >
              <span class="pdrawer__entry-icon"><AppIcon name="logout" :size="18" /></span>
              <span class="pdrawer__entry-label">退出登录</span>
            </button>
          </div>

          <!-- 主题选择器内联展开：抽屉内容变高，自身滚动 -->
          <div v-if="themeOpen" id="pdrawer-theme-panel" class="pdrawer__theme">
            <ThemePicker compact />
          </div>
        </div>

        <footer class="pdrawer__foot">
          <span class="pdrawer__foot-theme">{{ themeName }}</span>
          <span class="pdrawer__foot-ver">AITrance v2</span>
        </footer>
      </aside>
    </div>
  </Transition>

  <!-- 退出登录二次确认（UI-V2 §3 明确要求） -->
  <AppModal title="退出登录" :open="logoutOpen" :width="380" @close="logoutOpen = false">
    <p class="pdrawer__confirm">退出后需要重新输入账号与密码才能继续使用，确定要退出吗？</p>
    <template #footer>
      <AppButton label="取消" tone="ghost" @click="logoutOpen = false" />
      <AppButton label="退出登录" tone="danger" @click="confirmLogout" />
    </template>
  </AppModal>
</template>

<style scoped>
/* 遮罩 + 定位：父级是 ChatView 的 `.shell`（100% 高、相对定位）。
   这里用 fixed 是为了不依赖父级是否真的有 position: relative —— 抽屉永远
   贴住 rail 右缘、撑满视口高。 */
.pdrawer-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay, 100);
  display: flex;
  background: rgb(14 20 26 / 0.32);
}
.pdrawer {
  position: absolute;
  inset-block: 0;
  left: var(--spacing-rail);
  width: var(--spacing-sidebar);
  max-width: 100vw;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  box-shadow: var(--shadow-3, 0 8px 28px rgb(0 0 0 / 0.16));
  outline: none;
}
@media (max-width: 1023px) {
  .pdrawer {
    left: var(--spacing-rail-compact, var(--spacing-rail));
    width: var(--spacing-sidebar-compact, var(--spacing-sidebar));
  }
}
.pdrawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--app-border);
  flex: 0 0 auto;
}
.pdrawer__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-muted);
}
.pdrawer__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.pdrawer__close:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.pdrawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 14px 16px;
}
.pdrawer__hero {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pdrawer__hero-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pdrawer__name {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdrawer__account {
  font-size: 12px;
  color: var(--app-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdrawer__uid {
  font-size: 11px;
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}
.pdrawer__presence {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--app-text-faint);
}
.pdrawer__bio {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-text-muted);
  word-break: break-word;
  white-space: pre-wrap;
}
.pdrawer__bio--empty {
  color: var(--app-text-faint);
}
.pdrawer__entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
}
.pdrawer__entry {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  box-sizing: border-box;
  min-height: var(--spacing-touch-target, 44px);
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast, 0.15s) var(--ease-both, ease);
}
.pdrawer__entry:hover {
  background: var(--app-hover);
}
.pdrawer__entry-icon {
  display: flex;
  align-items: center;
  color: var(--app-text-muted);
  flex: 0 0 auto;
}
.pdrawer__entry-label {
  flex: 1;
  min-width: 0;
}
.pdrawer__entry-value {
  font-size: 12px;
  color: var(--app-text-faint);
}
.pdrawer__entry-chev {
  display: flex;
  align-items: center;
  color: var(--app-text-faint);
  transition: transform var(--dur-fast, 0.15s) var(--ease-both, ease);
}
.pdrawer__entry-chev--open {
  transform: rotate(180deg);
}
.pdrawer__entry--danger {
  color: var(--color-danger-500);
}
.pdrawer__entry--danger .pdrawer__entry-icon {
  color: var(--color-danger-500);
}
.pdrawer__theme {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-alt);
}
.pdrawer__foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--app-border);
  font-size: 11px;
  color: var(--app-text-faint);
}
.pdrawer__confirm {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text-muted);
}

/* 从左侧淡入滑出 */
.pdrawer-enter-active,
.pdrawer-leave-active {
  transition: opacity var(--dur, 0.18s) var(--ease-out, ease);
}
.pdrawer-enter-active .pdrawer,
.pdrawer-leave-active .pdrawer {
  transition: transform var(--dur, 0.18s) var(--ease-out, ease);
}
.pdrawer-enter-from,
.pdrawer-leave-to {
  opacity: 0;
}
.pdrawer-enter-from .pdrawer,
.pdrawer-leave-to .pdrawer {
  transform: translateX(-8%);
}
</style>
