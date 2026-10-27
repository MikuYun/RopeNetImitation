<script setup lang="ts">
/**
 * 个人信息上拉抽屉（移动端，UI-V2 §3）。
 *
 * 两阶段：
 *   brief（默认，62vh）—— 头像/昵称/UID/签名 + 三入口 + 「上滑查看完整资料」
 *   full（100vh）      —— 直接复用 `<ProfileView embedded />`
 *
 * 【拖拽为什么自己写】需求只要「顶部把手上下拖 + 松手吸附」，量很小；
 * 引一个第三方手势库会给移动端首屏加几十 KB，且我们的吸附规则（位移 + 速度
 * 双判据）反而是定制的，库还得再包一层。所以这里只监听把手上的三个 touch 事件，
 * 用 `transform: translateY()` 跟随手指 —— 走合成层，不触发 layout。
 *
 * 【body 滚动锁】抽屉是 fixed 覆盖层，背后列表若还能滚会出现「两层一起动」。
 * 保存原 overflow 后设为 hidden，卸载时**恢复原值**（不是硬写 ''），
 * 否则会覆盖宿主的其它样式。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import ThemePicker from '@/components/theme/ThemePicker.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import ProfileView from '@/views/ProfileView.vue'
import { useAuthStore } from '@/stores/auth'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore, THEME_LABELS } from '@/stores/ui'
import {
  collectFocusables,
  dialogKeyAction,
  initialFocusIndex,
  type DialogKeyAction,
} from '@/utils/dialogA11y'

const auth = useAuthStore()
const ui = useUiStore()
const presence = usePresenceStore()
const router = useRouter()

/** 阶段以 store 为唯一真相：full/brief 都要被抽屉外的入口读写。 */
const stage = computed(() => ui.profileDrawerStage)
const expanded = computed(() => stage.value === 'full')

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
const sheetRef = ref<HTMLElement | null>(null)

function close(): void {
  ui.closeProfileDrawer()
}

function setStage(next: 'brief' | 'full'): void {
  ui.setProfileDrawerStage(next)
}

function toggleTheme(): void {
  themeOpen.value = !themeOpen.value
}

function openProfilePage(): void {
  close()
  void router.push({ name: 'profile' })
}

async function confirmLogout(): Promise<void> {
  logoutOpen.value = false
  close()
  await auth.logout()
  void router.replace({ name: 'login' })
}

/* ── 拖拽 ──────────────────────────────────────────────────────────── */

/** 视口高度；在 drag 开始时采样一次，避免过程中读 layout。 */
let viewportH = 0
/** 62vh 对应的高度（brief 态的基准）。 */
function briefPx(): number {
  return viewportH * 0.62
}
/** 松手判定：拖过这个像素数就翻阶段。 */
const FLIP_PX = 72
/** 松手判定：速度（px/ms）超过它就按方向翻阶段，忽略位移。 */
const FLIP_VELOCITY = 0.55
/** 关闭阈值：向下拖过 brief 高度的这个比例就关。 */
const CLOSE_RATIO = 0.3

const dragging = ref(false)
/** 实时位移（只对 brief 态生效：full 态向下拖才能回 brief）。 */
const dragY = ref(0)

let startY = 0
let startTime = 0
let lastY = 0
let lastTime = 0
/** 松手瞬间的瞬时速度（px/ms，向下为正）。 */
let velocity = 0

/** 当前态允许的位移范围（负值 = 向上，正值 = 向下）。 */
function clampDrag(y: number): number {
  if (!expanded.value) {
    // brief：向上最多拖到 full（-38vh），向下可以一直拖到屏幕底部（关闭）
    const up = -(viewportH * 0.38)
    return Math.min(0, Math.max(up, y))
  }
  // full：只能向下拖（回 brief），向上不允许
  return Math.max(0, Math.min(viewportH - briefPx(), y))
}

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  viewportH = window.innerHeight || 1
  startY = t.clientY
  lastY = startY
  startTime = e.timeStamp
  lastTime = startTime
  velocity = 0
  dragY.value = 0
  dragging.value = true
}

function onTouchMove(e: TouchEvent): void {
  if (!dragging.value) return
  const t = e.touches[0]
  if (!t) return
  // 阻止浏览器把「拖把手」解释成页面滚动
  if (e.cancelable) e.preventDefault()
  const dy = t.clientY - startY
  const now = e.timeStamp
  const dt = now - lastTime
  if (dt > 0) velocity = (t.clientY - lastY) / dt
  lastY = t.clientY
  lastTime = now
  dragY.value = clampDrag(dy)
}

function onTouchEnd(): void {
  if (!dragging.value) return
  dragging.value = false
  const dy = dragY.value

  if (!expanded.value) {
    // brief 态松手
    const fastUp = velocity < -FLIP_VELOCITY
    const draggedUp = dy < -FLIP_PX
    if (fastUp || draggedUp) {
      dragY.value = 0
      setStage('full')
      return
    }
    // 向下拖得够远 → 直接关闭
    if (dy > briefPx() * CLOSE_RATIO) {
      dragY.value = 0
      close()
      return
    }
  } else {
    // full 态松手：向下拖过阈值就回 brief
    const fastDown = velocity > FLIP_VELOCITY
    const draggedDown = dy > FLIP_PX
    if (fastDown || draggedDown) {
      dragY.value = 0
      setStage('brief')
      return
    }
  }
  dragY.value = 0
}

/** 位移 → transform。只在 dragging 时跟随手指，其余交给 CSS 高度过渡。 */
const sheetStyle = computed(() => {
  if (!dragging.value) return {}
  return { transform: `translateY(${dragY.value}px)`, transition: 'none' }
})

/**
 * brief 与 full 的高度都由 CSS 决定（62vh / 100vh），切换走 transition；
 * 拖拽期间关掉 transition 直接跟手。
 */

/* ── body 滚动锁 ───────────────────────────────────────────────────── */

let prevBodyOverflow = ''
function lockBodyScroll(): void {
  prevBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}
function unlockBodyScroll(): void {
  document.body.style.overflow = prevBodyOverflow
}

/* ── 无障碍：焦点移入 / Esc / Tab 循环 / 归还 ──────────────────────── */

let restoreTarget: HTMLElement | null = null

function focusIndexIn(list: HTMLElement[]): number {
  const active = document.activeElement
  if (!active) return -1
  return list.indexOf(active as HTMLElement)
}

function restoreFocus(): void {
  const target = restoreTarget
  restoreTarget = null
  if (target && target.isConnected) target.focus()
}

function onKeydown(e: KeyboardEvent): void {
  // 二次确认 Modal 开着时让它自己处理键盘，避免两层同时响应 Esc
  if (logoutOpen.value) return
  const list = collectFocusables(sheetRef.value)
  const action: DialogKeyAction = dialogKeyAction({
    key: e.key,
    shiftKey: e.shiftKey,
    dialogOpen: true,
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

onMounted(() => {
  const active = document.activeElement
  restoreTarget = active instanceof HTMLElement ? active : null
  lockBodyScroll()
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => {
    const list = collectFocusables(sheetRef.value)
    const idx = initialFocusIndex(list.length)
    if (idx >= 0) list[idx]?.focus()
    else sheetRef.value?.focus()
  })
})

// 切到 full 时把焦点收进抽屉（内容整体换掉后原焦点元素已不存在）
watch(expanded, async () => {
  await nextTick()
  const list = collectFocusables(sheetRef.value)
  const idx = initialFocusIndex(list.length)
  if (idx >= 0 && !sheetRef.value?.contains(document.activeElement)) list[idx]?.focus()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  unlockBodyScroll()
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <div class="pmask" @click.self="close">
      <section
        ref="sheetRef"
        class="psheet"
        :class="{ 'psheet--full': expanded, 'psheet--dragging': dragging }"
        :style="sheetStyle"
        role="dialog"
        aria-modal="true"
        aria-label="个人信息"
        tabindex="-1"
      >
        <!-- 把手：只有这一块响应拖拽 -->
        <div
          class="psheet__handle"
          aria-hidden="true"
          @touchstart.passive="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
          @touchcancel="onTouchEnd"
        >
          <span class="psheet__handle-bar" />
        </div>

        <header class="psheet__head">
          <span class="psheet__title">{{ expanded ? '详细资料' : '个人信息' }}</span>
          <div class="psheet__head-actions">
            <button
              v-if="!expanded"
              class="psheet__expand"
              type="button"
              @click="setStage('full')"
            >
              展开
            </button>
            <button
              v-else
              class="psheet__expand"
              type="button"
              @click="setStage('brief')"
            >
              收起
            </button>
            <button class="psheet__close" type="button" aria-label="关闭个人信息" @click="close">
              <AppIcon name="close" :size="16" />
            </button>
          </div>
        </header>

        <!-- full：完整资料（复用 ProfileView，隐藏返回栏） -->
        <div v-if="expanded" class="psheet__full">
          <ProfileView embedded />
        </div>

        <!-- brief：概要 + 三入口 -->
        <div v-else class="psheet__body">
          <div class="psheet__hero">
            <AppAvatar
              :name="nickname"
              :seed="auth.userId"
              :size="72"
              :radius="16"
              :src="avatarSrc"
            />
            <div class="psheet__hero-text">
              <div class="psheet__name">{{ nickname }}</div>
              <div v-if="username" class="psheet__account">@{{ username }}</div>
              <div class="psheet__uid">UID {{ uidText }}</div>
              <div class="psheet__presence">
                <PresenceDot :user-id="auth.userId" :size="8" />
                <span>{{ online ? '在线' : '离线' }}</span>
              </div>
            </div>
          </div>

          <p
            class="psheet__bio"
            :class="{ 'psheet__bio--empty': bioText === '这个人很懒，什么都没写' }"
          >
            {{ bioText }}
          </p>

          <div class="psheet__entries">
            <button class="psheet__entry" type="button" @click="openProfilePage">
              <span class="psheet__entry-icon"><AppIcon name="user" :size="18" /></span>
              <span class="psheet__entry-label">详细资料</span>
              <span class="psheet__entry-chev" aria-hidden="true">
                <AppIcon name="expand-more" :size="16" />
              </span>
            </button>

            <button
              class="psheet__entry"
              type="button"
              :aria-expanded="themeOpen"
              aria-controls="psheet-theme-panel"
              @click="toggleTheme"
            >
              <span class="psheet__entry-icon"><AppIcon name="sun" :size="18" /></span>
              <span class="psheet__entry-label">主题</span>
              <span class="psheet__entry-value">{{ themeName }}</span>
              <span
                class="psheet__entry-chev"
                :class="{ 'psheet__entry-chev--open': themeOpen }"
                aria-hidden="true"
              >
                <AppIcon name="expand-more" :size="16" />
              </span>
            </button>

            <button
              class="psheet__entry psheet__entry--danger"
              type="button"
              @click="logoutOpen = true"
            >
              <span class="psheet__entry-icon"><AppIcon name="logout" :size="18" /></span>
              <span class="psheet__entry-label">退出登录</span>
            </button>
          </div>

          <div v-if="themeOpen" id="psheet-theme-panel" class="psheet__theme">
            <ThemePicker compact />
          </div>

          <button class="psheet__hint" type="button" @click="setStage('full')">
            <AppIcon name="expand-more" :size="14" />
            上滑查看完整资料
          </button>
        </div>
      </section>
    </div>
  </Teleport>

  <!-- 退出登录二次确认 -->
  <AppModal title="退出登录" :open="logoutOpen" :width="340" @close="logoutOpen = false">
    <p class="psheet__confirm">退出后需要重新输入账号与密码才能继续使用，确定要退出吗？</p>
    <template #footer>
      <AppButton label="取消" tone="ghost" @click="logoutOpen = false" />
      <AppButton label="退出登录" tone="danger" @click="confirmLogout" />
    </template>
  </AppModal>
</template>

<style scoped>
.pmask {
  position: fixed;
  inset: 0;
  /* 遮罩必须在 tab 栏/页面内容之上、Modal 之下。
     注意不能直接用 --z-sheet(160)：AppModal 走的是 --z-modal(150)，
     抽屉里的「退出登录」二次确认会被遮罩整个盖住（点开看不见）。
     所以压在 modal 下面一层。 */
  z-index: calc(var(--z-modal, 150) - 1);
  display: flex;
  align-items: flex-end;
  background: rgb(0 0 0 / 0.38);
}
.psheet {
  width: 100%;
  height: 62vh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--app-panel);
  border-radius: var(--radius-xl, 14px) var(--radius-xl, 14px) 0 0;
  box-shadow: 0 -8px 28px rgb(0 0 0 / 0.18);
  outline: none;
  overflow: hidden;
  /* 高度/位移过渡：拖拽时由 :style 的 transition:none 覆盖 */
  transition: height var(--dur, 0.2s) var(--ease-out, ease);
  padding-bottom: var(--safe-bottom);
}
.psheet--full {
  height: 100vh;
}
.psheet--dragging {
  transition: none;
}
/* 把手 32px 高，是唯一的拖拽热区（含 8px 视觉条外的留白） */
.psheet__handle {
  flex: 0 0 auto;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  cursor: grab;
}
.psheet__handle-bar {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--app-border);
}
.psheet__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px 8px;
}
.psheet__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text);
}
.psheet__head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.psheet__expand {
  /* 移动端热区下限 44px（useBreakpoint 的 MIN_TOUCH_TARGET）：
     视觉上仍然是一个轻量文字按钮，但可点区域不能小于 44×44。 */
  min-height: 44px;
  min-width: 44px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-brand-500);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.psheet__expand:active {
  background: var(--app-hover);
}
.psheet__close {
  display: flex;
  align-items: center;
  justify-content: center;
  /* 角标图标只有 16px，但热区必须是 44×44 —— 否则手机上很难点中，
     也是 e2e-responsive 的「热区 >= 44x44」断言。 */
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.psheet__close:active {
  background: var(--app-hover);
}
.psheet__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 4px 16px calc(16px + var(--safe-bottom));
}
.psheet__full {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.psheet__hero {
  display: flex;
  align-items: center;
  gap: 12px;
}
.psheet__hero-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.psheet__name {
  font-size: 17px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.psheet__account {
  font-size: 12px;
  color: var(--app-text-muted);
}
.psheet__uid {
  font-size: 11px;
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}
.psheet__presence {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--app-text-faint);
}
.psheet__bio {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text-muted);
  word-break: break-word;
  white-space: pre-wrap;
}
.psheet__bio--empty {
  color: var(--app-text-faint);
}
.psheet__entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
}
.psheet__entry {
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
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.psheet__entry:active {
  background: var(--app-hover);
}
.psheet__entry-icon {
  display: flex;
  align-items: center;
  color: var(--app-text-muted);
  flex: 0 0 auto;
}
.psheet__entry-label {
  flex: 1;
  min-width: 0;
}
.psheet__entry-value {
  font-size: 12px;
  color: var(--app-text-faint);
}
.psheet__entry-chev {
  display: flex;
  align-items: center;
  color: var(--app-text-faint);
  transition: transform var(--dur-fast, 0.15s) var(--ease-both, ease);
}
.psheet__entry-chev--open {
  transform: rotate(180deg);
}
.psheet__entry--danger {
  color: var(--color-danger-500);
}
.psheet__entry--danger .psheet__entry-icon {
  color: var(--color-danger-500);
}
.psheet__theme {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-alt);
}
.psheet__hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  margin-top: 14px;
  padding: 8px 0;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.psheet__confirm {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text-muted);
}
</style>
