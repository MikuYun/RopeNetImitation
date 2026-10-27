<script setup lang="ts">
/** 左侧窄边栏：头像 + 会话/联系人切页 + 主题切换 + 登出。 */
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

async function onLogout(): Promise<void> {
  await auth.logout()
  void router.push({ name: 'login' })
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
</script>

<template>
  <nav class="rail">
    <div class="rail__top">
      <AppAvatar :name="auth.displayName" :seed="auth.userId" :size="34" :radius="8" />
    </div>

    <div class="rail__tabs">
      <button
        class="rail__tab"
        :class="{ 'rail__tab--active': ui.railTab === 'chats' }"
        type="button"
        title="会话"
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
        @click="goTab('contacts')"
      >
        <AppIcon name="contact" :size="22" />
        <span v-if="pending > 0" class="rail__badge">{{ pending > 99 ? '99+' : pending }}</span>
      </button>
    </div>

    <div class="rail__bottom">
      <button class="rail__tab" type="button" :title="ui.theme === 'dark' ? '切换浅色' : '切换深色'" @click="ui.toggleTheme()">
        <AppIcon :name="ui.theme === 'dark' ? 'sun' : 'moon'" :size="20" />
      </button>
      <button class="rail__tab" type="button" title="退出登录" @click="onLogout">
        <AppIcon name="logout" :size="20" />
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
.rail__tabs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.rail__bottom {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  transition: background 0.15s ease;
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
