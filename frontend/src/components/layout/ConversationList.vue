<script setup lang="ts">
/** 会话列表（第二栏）。排序完全依服务端给的 orderedIds，前端不二次排。 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import AppSkeleton from '@/components/base/AppSkeleton.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import ConversationItem from '@/components/layout/ConversationItem.vue'
import { useConversationStore } from '@/stores/conversation'
import { useUiStore } from '@/stores/ui'

const convStore = useConversationStore()
const ui = useUiStore()
const router = useRouter()

const keyword = ref('')

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return convStore.list
  return convStore.list.filter((c) => c.title.toLowerCase().includes(k))
})

function select(id: string): void {
  // activeId 由路由派生（见 ChatView），这里只负责跳转，避免两处状态打架
  void router.push({ name: 'chat', params: { convId: id } })
}
</script>

<template>
  <section class="list">
    <header class="list__head">
      <div class="list__search">
        <AppIcon name="search" :size="15" />
        <input v-model="keyword" class="list__input" placeholder="搜索会话" />
      </div>
      <button class="list__add" type="button" title="发起群聊" @click="ui.groupCreateOpen = true">
        <AppIcon name="plus" :size="18" />
      </button>
    </header>

    <div class="list__body">
      <AppSkeleton v-if="convStore.loading && convStore.list.length === 0" :count="5" />
      <AppEmpty
        v-else-if="filtered.length === 0"
        icon="chat"
        title="暂无会话"
        description="去联系人里找个朋友聊聊，或者发起一个群聊"
      />
      <ConversationItem
        v-for="c in filtered"
        :key="c.id"
        :conversation="c"
        :active="convStore.activeId === c.id"
        @select="select(c.id)"
      />
    </div>
  </section>
</template>

<style scoped>
/* 断点见 src/composables/useBreakpoint.ts 的 BP（mobile<=767 / tablet 768-1023 / desktop>=1024）。
   --spacing-sidebar 已由 main.css 在平板区间覆盖为紧凑值，这里无需再分支。 */
.list {
  width: var(--spacing-sidebar);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  min-height: 0;
}
.list__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  /* 手机有刘海时顶部标题不被遮住 */
  padding-top: calc(10px + var(--safe-top));
  border-bottom: 1px solid var(--app-border);
}
.list__search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border-radius: 5px;
  background: var(--app-panel-alt);
  color: var(--app-text-faint);
}
.list__input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  color: var(--app-text);
  font-size: 13px;
  font-family: inherit;
}
.list__add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 5px;
  background: var(--app-panel-alt);
  color: var(--app-text-muted);
  cursor: pointer;
}
.list__add:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.list__body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  min-height: 0;
}

/* ── 手机：占满宽度，热区放大到 44px ─────────────────────────────── */
@media (max-width: 767px) {
  .list {
    width: 100%;
    border-right: none;
  }
  .list__head {
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
  }
  .list__search {
    height: var(--spacing-touch-target);
    /* 手机上搜索框也是可点热区，字号 >=16 避免 iOS 聚焦放大 */
    font-size: var(--font-input-mobile);
  }
  .list__input {
    font-size: var(--font-input-mobile);
  }
  .list__add {
    width: var(--spacing-touch-target);
    height: var(--spacing-touch-target);
  }
}
</style>
