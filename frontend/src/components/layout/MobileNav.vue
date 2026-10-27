<script setup lang="ts">
/**
 * 手机底部导航。
 *
 * 【为什么单独做一个组件而不是复用 AppRail】AppRail 是 PC 的**竖侧栏**，
 * 竖排、含头像、贴左边。手机上要的是横排、贴底部、只有三个 tab 的形态。
 *
 * v2 变更（UI-V2 §3）：
 *   - 第三位「更多」→「个人信息」，点击弹出上拉抽屉 `ProfileSheet`；
 *     原来的「更多」底部面板（主题 / 退出登录）整体删除 —— 这两项已收进
 *     个人信息抽屉与详细资料页。
 *   - tab 仍带 `.mnav__tab` / `.mnav__label` 类名（e2e 选择器契约）。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import ProfileSheet from '@/components/profile/ProfileSheet.vue'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useUiStore } from '@/stores/ui'

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

function openProfile(): void {
  ui.openProfileDrawer()
}
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

    <button
      class="mnav__tab"
      :class="{ 'mnav__tab--on': ui.profileDrawerOpen }"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="ui.profileDrawerOpen"
      @click="openProfile"
    >
      <span class="mnav__icon"><AppIcon name="user" :size="22" /></span>
      <span class="mnav__label">个人信息</span>
    </button>
  </nav>

  <!-- 个人信息上拉抽屉：自身 Teleport 到 body，这里只按需挂载。 -->
  <ProfileSheet v-if="ui.profileDrawerOpen" />
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
</style>
