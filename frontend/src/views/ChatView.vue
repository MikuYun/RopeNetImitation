<script setup lang="ts">
/**
 * 主聊天布局。
 *
 * 三种宽度模式（断点见 composables/useBreakpoint.ts）：
 *   desktop >=1024  侧栏 + 列表 + 内容区（三块并存）
 *   tablet  768–1023 侧栏缩窄 + 列表缩窄 + 内容区
 *   mobile  <=767    单栏全屏：列表屏 **或** 正文屏，二者互斥
 *
 * 【路由是屏幕状态的唯一事实源】不再维护第二套 selectedConversation：
 * activeId 由路由参数派生。否则「点了会话但路由没跳」「返回了但高亮还在」
 * 这类失同步迟早出现，而且在手机端会直接表现为显示错屏。
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppRail from '@/components/layout/AppRail.vue'
import MobileNav from '@/components/layout/MobileNav.vue'
import ConversationList from '@/components/layout/ConversationList.vue'
import ContactPanel from '@/components/layout/ContactPanel.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppToaster from '@/components/base/AppToaster.vue'
import GroupCreateModal from '@/components/group/GroupCreateModal.vue'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore } from '@/stores/ui'
import { canAccessAdmin } from '@/stores/admin'
import { wsClient } from '@/ws/client'
import { toApiError } from '@/api/http'

const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()

const auth = useAuthStore()
const convStore = useConversationStore()
const friendStore = useFriendStore()
const presence = usePresenceStore()
const ui = useUiStore()

/* ── 路由 → 当前会话 ──────────────────────────────────────────────── */

const routeConvId = computed<string | null>(() => {
  const id = route.params['convId']
  return typeof id === 'string' && id.length > 0 ? id : null
})

// immediate：冷启动直接深链时，首帧就要把 activeId 定下来，
// 否则列表高亮会闪一下「没有选中」。
watch(routeConvId, (id) => convStore.setActive(id), { immediate: true })

// 「新的朋友」路由落到联系人 tab；离开时不动用户的 tab 选择。
watch(
  () => route.name,
  (name) => {
    if (name === 'new-friend') ui.setRailTab('contacts')
  },
  { immediate: true },
)

/* ── 手机端屏幕切换 ───────────────────────────────────────────────── */

/** 正文屏：会话内容、会话详情，以及 ux2 新增的个人资料页 / 管理后台。 */
const isContentScreen = computed(
  () =>
    route.name === 'chat' ||
    route.name === 'conversation-info' ||
    route.name === 'profile' ||
    route.name === 'admin',
)

/** 手机上的联系人屏。 */
const isContactsScreen = computed(
  () => !isContentScreen.value && (route.name === 'new-friend' || ui.railTab === 'contacts'),
)

/** 手机上的会话列表屏。 */
const isListScreen = computed(() => !isContentScreen.value && !isContactsScreen.value)

/* ── ux2：个人资料 / 管理后台入口 ─────────────────────────────────── */

/**
 * 管理后台入口只对 role==='admin' 可见。
 *
 * 【为什么还要判一次】真正的边界在后端（`requireAdmin` → 403 ADMIN_REQUIRED）
 * 与路由守卫（`canAccessAdmin`）。这里只是「不给用户看一个点进去必被弹回的
 * 按钮」的可见性收敛，不承担安全职责。用 `canAccessAdmin` 而不是内联
 * `role === 'admin'`，是为了让它和守卫共用同一处判定、同一份单测。
 */
const showAdminEntry = computed(() => canAccessAdmin(auth.user?.role))

/** 当前是否已经在这个页面上（用于给入口按钮置 aria-current）。 */
const onProfile = computed(() => route.name === 'profile')
const onAdmin = computed(() => route.name === 'admin')

/** 入口跳转：这两个页面都是 /chat 的子路由，push 即可保留外壳。 */
function openProfile(): void {
  if (!onProfile.value) void router.push({ name: 'profile' })
}
function openAdmin(): void {
  if (!onAdmin.value) void router.push({ name: 'admin' })
}

/* ── 首屏数据 ─────────────────────────────────────────────────────── */

onMounted(async () => {
  try {
    await Promise.all([convStore.fetchAll(), friendStore.fetchAll()])
    // 首屏在线状态：不要只等 presence.changed 推送，否则首屏全显示离线
    presence.seedFromLists()
    const ids = new Set<string>()
    for (const c of convStore.list) {
      if (c.peer) ids.add(c.peer.id)
      const d = convStore.detailsById.get(c.id)
      for (const m of d?.members ?? []) ids.add(m.user.id)
    }
    void presence.prefetch([...ids])

    // 群聊的会话列表预览要显示「发送者：内容」，而 senderId -> 昵称的映射
    // 只有会话详情（members[]）里有。故为**有消息的群聊**预取详情（限量，
    // 避免会话很多时打出一串请求）。拿不到时预览会省略前缀，不会显示成
    // 「：内容」这种残缺形式（见 ConversationItem.preview）。
    const groups = convStore.list
      .filter((c) => c.type === 'group' && c.lastMessage)
      .slice(0, 10)
    void Promise.all(groups.map((c) => convStore.ensureDetail(c.id)))
  } catch (e) {
    ui.toast(`加载失败：${toApiError(e).message}`, 'error')
  }

  // 确保 WS 已连接（登录时已连；刷新后由 router bootstrap 连）
  void wsClient.connect()
})
</script>

<template>
  <div class="shell" :class="{ 'shell--mobile': isMobile }">
    <!-- ── 手机：单栏互斥 ─────────────────────────────────────────── -->
    <template v-if="isMobile">
      <template v-if="isContentScreen">
        <RouterView />
      </template>

      <template v-else>
        <!--
          ux2：手机上的「个人资料 / 管理后台」入口。
          做成**列表屏顶部的一条横条**，而不是浮在内容上的悬浮按钮 ——
          task-10 刚修完「浮层遮挡正文」的缺陷，这里不再引入新的遮挡源。
          正文屏（isContentScreen）不显示它：进入页面自带返回按钮。
        -->
        <div class="shell__me">
          <button
            class="shell__me-btn"
            type="button"
            :class="{ 'shell__me-btn--on': onProfile }"
            :aria-current="onProfile ? 'page' : undefined"
            @click="openProfile"
          >
            <AppIcon name="contact" :size="16" />
            <span class="shell__me-text">个人资料</span>
          </button>
          <button
            v-if="showAdminEntry"
            class="shell__me-btn"
            type="button"
            :class="{ 'shell__me-btn--on': onAdmin }"
            :aria-current="onAdmin ? 'page' : undefined"
            @click="openAdmin"
          >
            <AppIcon name="users" :size="16" />
            <span class="shell__me-text">管理后台</span>
          </button>
        </div>
        <ContactPanel v-if="isContactsScreen" class="shell__pane" />
        <ConversationList v-else-if="isListScreen" class="shell__pane" />
        <MobileNav />
      </template>
    </template>

    <!-- ── 平板 / 桌面：多栏 ──────────────────────────────────────── -->
    <template v-else>
      <AppRail class="shell__rail" />
      <ConversationList v-show="ui.railTab === 'chats'" />
      <ContactPanel v-show="ui.railTab === 'contacts'" />
      <RouterView />

      <!--
        ux2：桌面入口贴在左侧竖栏（rail）的下半部空白区里，绝对定位在
        `.shell` 上，`left:0; width: var(--spacing-rail)` 与 rail 同宽。
        【为什么不放在内容区右上角】那里是 `.pane__more`（会话信息）的位置，
        浮层会盖住它，和 task-10 修掉的「浮层遮挡」是同一类问题。
        【为什么不改 AppRail】它属于 task-10 的写作用域。
      -->
      <div class="shell__me shell__me--rail">
        <button
          class="shell__me-btn shell__me-btn--icon"
          type="button"
          title="个人资料"
          aria-label="个人资料"
          :class="{ 'shell__me-btn--on': onProfile }"
          :aria-current="onProfile ? 'page' : undefined"
          @click="openProfile"
        >
          <AppIcon name="contact" :size="18" />
        </button>
        <button
          v-if="showAdminEntry"
          class="shell__me-btn shell__me-btn--icon"
          type="button"
          title="管理后台"
          aria-label="管理后台"
          :class="{ 'shell__me-btn--on': onAdmin }"
          :aria-current="onAdmin ? 'page' : undefined"
          @click="openAdmin"
        >
          <AppIcon name="users" :size="18" />
        </button>
      </div>
    </template>

    <GroupCreateModal />
    <AppToaster />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}
/* 手机上列表/正文互斥，纵向排列：内容区在上、底部导航在下 */
.shell--mobile {
  flex-direction: column;
}
.shell__pane {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* 手机上列表占满宽度，不再是固定 280px 的一栏 */
  border-right: none;
}

/* ── ux2 入口 ──────────────────────────────────────────────────── */

.shell__me {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  padding-top: calc(6px + var(--safe-top));
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-border);
  /* 手机上这一条属于「列表屏」，不该被正文屏的层级压住 */
  position: relative;
  z-index: 1;
}

.shell__me-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: var(--spacing-touch-target);
  padding: 0 12px;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--app-text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.shell__me-btn:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.shell__me-btn--on {
  border-color: var(--color-brand-500);
  color: var(--color-brand-500);
}
.shell__me-btn:focus-visible {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}

/* 桌面：贴进 rail 列的下半部空白区，与 rail 同宽，不遮挡内容区 */
.shell__me--rail {
  position: absolute;
  left: 0;
  bottom: 124px;
  width: var(--spacing-rail);
  flex-direction: column;
  gap: 6px;
  padding: 0;
  background: transparent;
  border-bottom: none;
  z-index: 2;
}
.shell__me-btn--icon {
  justify-content: center;
  width: 40px;
  height: 40px;
  min-height: 0;
  padding: 0;
  margin: 0 auto;
  border-color: transparent;
}
.shell__me-btn--icon:hover {
  background: var(--app-hover);
}
.shell__me-btn--icon.shell__me-btn--on {
  border-color: transparent;
  background: var(--app-hover);
}
.shell__me-text {
  white-space: nowrap;
}
</style>

<style scoped>
.shell {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}
/* 手机上列表/正文互斥，纵向排列：内容区在上、底部导航在下 */
.shell--mobile {
  flex-direction: column;
}
.shell__pane {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* 手机上列表占满宽度，不再是固定 280px 的一栏 */
  border-right: none;
}
</style>
