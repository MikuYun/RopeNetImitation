<script setup lang="ts">
/** 联系人面板：好友列表 + 新的朋友（申请）+ 搜索用户。 */
import { computed, ref, watch } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { useFriendStore } from '@/stores/friend'
import { useConversationStore } from '@/stores/conversation'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { toApiError } from '@/api/http'
import { useRouter } from 'vue-router'

const friendStore = useFriendStore()
const convStore = useConversationStore()
const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()

type Tab = 'friends' | 'requests' | 'search'
const tab = ref<Tab>('friends')
const keyword = ref('')
const busyId = ref<string | null>(null)

watch(keyword, (v) => {
  const k = v.trim()
  if (k) {
    tab.value = 'search'
    void friendStore.search(k)
  } else {
    friendStore.clearSearch()
    if (tab.value === 'search') tab.value = 'friends'
  }
})

const friends = computed(() => friendStore.friends)

async function openChat(userId: string): Promise<void> {
  try {
    const conv = await convStore.createDirect(userId)
    // activeId 由路由派生（见 ChatView），这里不再手动 setActive
    void router.push({ name: 'chat', params: { convId: conv.id } })
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  }
}

/**
 * 好友行内「点头像看资料」（v2 §3）。
 * 行本身是 <button> 负责开会话，所以头像只能做成 role=button 的 span；
 * 事件必须 stop，否则会连带触发整行的 openChat。
 */
function openUserProfile(userId: string): void {
  if (!userId) return
  if (userId === auth.userId) {
    void router.push({ name: 'profile' })
    return
  }
  void router.push({ name: 'user-profile', params: { userId } })
}

async function addFriend(userId: string): Promise<void> {
  busyId.value = userId
  try {
    await friendStore.sendRequest(userId)
    ui.toast('好友申请已发送', 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busyId.value = null
  }
}

async function accept(id: string): Promise<void> {
  const req = friendStore.incoming.find((r) => r.id === id)
  if (!req) return
  busyId.value = id
  try {
    const convId = await friendStore.accept(id, req.fromUser.id, req.fromUser)
    ui.toast('已添加为好友', 'success')
    if (convId) {
      void router.push({ name: 'chat', params: { convId } })
    }
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busyId.value = null
  }
}

async function reject(id: string): Promise<void> {
  busyId.value = id
  try {
    await friendStore.reject(id)
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <div class="panel__search">
        <AppIcon name="search" :size="15" />
        <input v-model="keyword" class="panel__input" placeholder="搜索用户名（精确匹配）" />
      </div>
    </header>

    <nav v-if="!keyword" class="panel__tabs">
      <button
        class="panel__tab"
        :class="{ 'panel__tab--active': tab === 'friends' }"
        type="button"
        @click="tab = 'friends'"
      >
        好友 {{ friends.length }}
      </button>
      <button
        class="panel__tab"
        :class="{ 'panel__tab--active': tab === 'requests' }"
        type="button"
        @click="tab = 'requests'"
      >
        新的朋友
        <span v-if="friendStore.incomingCount > 0" class="panel__dot" />
      </button>
    </nav>

    <div class="panel__body">
      <!-- 好友 -->
      <template v-if="tab === 'friends'">
        <AppEmpty
          v-if="friends.length === 0"
          icon="contact"
          title="还没有好友"
          description="在上方搜索框输入对方的用户名来添加好友"
        />
        <button
          v-for="f in friends"
          :key="f.user.id"
          class="row"
          type="button"
          @click="openChat(f.user.id)"
        >
          <!-- v2：头像单独可点 = 进访客资料；外层已是 button，这里只能用 role=button 的 span -->
          <span
            class="row__avatar row__avatar--btn"
            role="button"
            tabindex="0"
            :aria-label="`查看 ${f.user.displayName} 的资料`"
            @click.stop="openUserProfile(f.user.id)"
            @keydown.enter.stop.prevent="openUserProfile(f.user.id)"
            @keydown.space.stop.prevent="openUserProfile(f.user.id)"
          >
            <AppAvatar
              :name="f.user.displayName"
              :seed="f.user.id"
              :size="36"
              :src="f.user.avatarUrl ?? ''"
            />
            <PresenceDot class="row__dot" :user-id="f.user.id" />
          </span>
          <span class="row__name">{{ f.user.displayName }}</span>
          <span class="row__hint">发消息</span>
        </button>
      </template>

      <!-- 好友申请 -->
      <template v-else-if="tab === 'requests'">
        <AppEmpty
          v-if="friendStore.incoming.length === 0"
          icon="info"
          title="没有新的申请"
          description="别人添加你时会出现在这里"
        />
        <div v-for="r in friendStore.incoming" :key="r.id" class="row row--static">
          <AppAvatar :name="r.fromUser.displayName" :seed="r.fromUser.id" :size="36" />
          <div class="row__col">
            <span class="row__name">{{ r.fromUser.displayName }}</span>
            <span v-if="r.message" class="row__note">{{ r.message }}</span>
          </div>
          <div class="row__actions">
            <AppButton
              label="通过"
              :loading="busyId === r.id"
              @click="accept(r.id)"
            />
            <AppButton label="拒绝" tone="ghost" @click="reject(r.id)" />
          </div>
        </div>
      </template>

      <!-- 搜索结果 -->
      <template v-else>
        <div v-if="friendStore.searching" class="hint">搜索中…</div>
        <AppEmpty
          v-else-if="friendStore.searchResultsWithRelation.length === 0"
          icon="search"
          title="没有找到匹配的用户"
          description="MVP 阶段为用户名精确匹配，请完整输入对方的用户名"
        />
        <div
          v-for="r in friendStore.searchResultsWithRelation"
          :key="r.user.id"
          class="row row--static"
        >
          <AppAvatar :name="r.user.displayName" :seed="r.user.id" :size="36" />
          <div class="row__col">
            <span class="row__name">{{ r.user.displayName }}</span>
            <span class="row__note">@{{ r.user.username }}</span>
          </div>
          <div class="row__actions">
            <AppButton
              v-if="r.relationship === 'none'"
              label="加好友"
              :loading="busyId === r.user.id"
              @click="addFriend(r.user.id)"
            />
            <AppButton v-else-if="r.relationship === 'friend'" label="发消息" tone="ghost" @click="openChat(r.user.id)" />
            <span v-else-if="r.relationship === 'request_sent'" class="tag">已发送</span>
            <AppButton
              v-else-if="r.relationship === 'request_received'"
              label="去处理"
              @click="tab = 'requests'"
            />
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.panel {
  width: var(--spacing-sidebar);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  min-height: 0;
}
.panel__head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border);
}
.panel__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border-radius: 5px;
  background: var(--app-panel-alt);
  color: var(--app-text-faint);
}
.panel__input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  color: var(--app-text);
  font-size: 13px;
  font-family: inherit;
}
.panel__tabs {
  display: flex;
  border-bottom: 1px solid var(--app-border);
}
.panel__tab {
  position: relative;
  flex: 1;
  padding: 9px 0;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.panel__tab--active {
  color: var(--color-brand-500);
  border-bottom-color: var(--color-brand-500);
}
.panel__dot {
  position: absolute;
  top: 7px;
  right: 18px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-danger-500);
}
.panel__body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  min-height: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 5px + 44px 热区 = 54px，与改造前（9px + 36px）行高一致 */
  padding: 5px 14px;
  border: none;
  background: transparent;
  text-align: left;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.row--static {
  cursor: default;
}
.row:not(.row--static):hover {
  background: var(--app-hover);
}
.row__avatar {
  position: relative;
  flex: 0 0 auto;
}
/* v2：头像可点进访客资料。热区补到 44x44（e2e 会量 .row 的触控目标，头像子树也要达标） */
.row__avatar--btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-touch-target);
  height: var(--spacing-touch-target);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.row__avatar--btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.row__dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
}
.row__col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row__name {
  flex: 1;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__note {
  font-size: 12px;
  color: var(--app-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__hint {
  font-size: 12px;
  color: var(--app-text-faint);
}
.row__actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 0 0 auto;
}
.tag {
  font-size: 12px;
  color: var(--app-text-faint);
}
.hint {
  padding: 14px;
  font-size: 13px;
  color: var(--app-text-muted);
}

/* ── 手机：占满宽度，输入框与操作热区放大 ─────────────────────────── */
@media (max-width: 767px) {
  .panel {
    width: 100%;
    border-right: none;
  }
  .panel__head {
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
    padding-top: calc(10px + var(--safe-top));
  }
  .panel__search {
    height: var(--spacing-touch-target);
  }
  .panel__input {
    /* >=16px 避免 iOS Safari 聚焦时自动放大页面 */
    font-size: var(--font-input-mobile);
  }
  .panel__tab {
    min-height: var(--spacing-touch-target);
    font-size: 14px;
  }
  .row {
    min-height: var(--spacing-touch-target);
    padding: 10px calc(14px + var(--safe-right)) 10px calc(14px + var(--safe-left));
  }
  .row__name {
    font-size: 15px;
  }
}
</style>
