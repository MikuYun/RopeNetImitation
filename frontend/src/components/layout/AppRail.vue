<script setup lang="ts">
/**
 * 左侧窄边栏：我的头像（打开个人信息抽屉）+ 会话/联系人/广场切页。
 *
 * v2 变更（UI-V2 §3/§4）：
 *  1. 头像按钮**必须传 `:src`** —— 这是「左上角头像不是我的头像」的根因：
 *     旧实现没传 src，AppAvatar 永远只会渲染昵称首字母。点击头像改为打开
 *     个人信息抽屉（`ui.openProfileDrawer()`）。
 *  2. 中间图标区新增第三个 tab「广场」。
 *  3. 底部「主题切换」「退出登录」删除 —— 二者已移进个人信息抽屉/详细资料页。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useUiStore } from '@/stores/ui'

const auth = useAuthStore()
const ui = useUiStore()
const convStore = useConversationStore()
const friendStore = useFriendStore()
const router = useRouter()

const unread = computed(() => convStore.totalUnread)
const pending = computed(() => friendStore.incomingCount)

/** 头像选中态：抽屉打开时高亮，给用户「点的是它」的反馈。 */
const avatarActive = computed(() => ui.profileDrawerOpen)

/** 广场 tab 选中态。 */
const squareActive = computed(() => router.currentRoute.value.name === 'square')

function openProfile(): void {
  ui.openProfileDrawer()
}

/**
 * 切 tab 时同时回到列表屏 —— 用户可能正停在会话正文里，
 * 此时点侧栏的「联系人」应当离开正文，而不是把 tab 切了但屏幕没动。
 */
async function goTab(tab: 'chats' | 'contacts'): Promise<void> {
  ui.setRailTab(tab)
  convStore.setActive(null)
  if (router.currentRoute.value.name !== 'chat-empty') {
    await router.push({ name: 'chat-empty' })
  }
}

async function goSquare(): Promise<void> {
  convStore.setActive(null)
  if (router.currentRoute.value.name !== 'square') {
    await router.push({ name: 'square' })
  }
}
</script>

<template>
  <nav class="rail">
    <div class="rail__top">
      <button
        class="rail__avatar"
        :class="{ 'rail__avatar--active': avatarActive }"
        type="button"
        aria-label="打开个人信息"
        aria-haspopup="dialog"
        :aria-expanded="avatarActive"
        title="个人信息"
        @click="openProfile"
      >
        <AppAvatar
          :name="auth.displayName"
          :seed="auth.userId"
          :src="auth.user?.avatarUrl ?? ''"
          :size="34"
          :radius="10"
        />
      </button>
    </div>

    <div class="rail__tabs">
      <button
        class="rail__tab"
        :class="{ 'rail__tab--active': ui.railTab === 'chats' }"
        type="button"
        title="会话"
        aria-label="会话"
        @click="goTab('chats')"
      >
        <AppIcon name="chat" :size="22" />
        <span v-if="unread > 0" class="rail__badge">{{ unread > 99 ? '99+' : unread }}</span>
      </button>

      <button
        class="rail__tab"
        :class="{ 'rail__tab--active': ui.railTab === 'contacts' }"
        type="button"
        title="联系人"
        aria-label="联系人"
        @click="goTab('contacts')"
      >
        <AppIcon name="contact" :size="22" />
        <span v-if="pending > 0" class="rail__badge">{{ pending > 99 ? '99+' : pending }}</span>
      </button>

      <button
        class="rail__tab"
        :class="{ 'rail__tab--active': squareActive }"
        type="button"
        title="广场"
        aria-label="广场"
        @click="goSquare"
      >
        <AppIcon name="compass" :size="22" />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: var(--spacing-rail);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  background: var(--app-panel-alt);
  border-right: 1px solid var(--app-border);
  gap: 16px;
}
.rail__top {
  flex: 0 0 auto;
}
.rail__avatar {
  display: block;
  padding: 3px;
  border: none;
  border-radius: 13px;
  background: transparent;
  cursor: pointer;
  line-height: 0;
  transition: background var(--dur, 0.15s) var(--ease-out, ease);
}
.rail__avatar:hover {
  background: var(--app-hover);
}
.rail__avatar--active {
  background: var(--app-hover);
  box-shadow: 0 0 0 2px var(--color-brand-500);
}
.rail__tabs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.rail__tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  transition: background var(--dur, 0.15s) var(--ease-out, ease);
}
.rail__tab:hover {
  background: var(--app-hover);
}
.rail__tab--active {
  color: var(--color-brand-500);
  background: var(--app-hover);
}
.rail__badge {
  position: absolute;
  top: 2px;
  right: 2px;
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
</style>
