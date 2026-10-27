<script setup lang="ts">
/**
 * 发起群聊。
 *
 * 时序纪律（见 docs/04-frontend-architecture.md 风险 E.5）：
 * **不做乐观插入** —— 会话 id 需服务端生成，等 POST 返回后再入列表。
 * 否则要用临时 id 造一条假会话，返回后还得替换，中间任何一次推送都会打架。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppModal from '@/components/base/AppModal.vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppInput from '@/components/base/AppInput.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useMessageStore } from '@/stores/message'
import { useUiStore } from '@/stores/ui'
import { toApiError } from '@/api/http'

const convStore = useConversationStore()
const friendStore = useFriendStore()
const msgStore = useMessageStore()
const ui = useUiStore()
const router = useRouter()

const name = ref('')
const keyword = ref('')
const selected = ref<Set<string>>(new Set())
const submitting = ref(false)

const open = computed({
  get: () => ui.groupCreateOpen,
  set: (v: boolean) => {
    ui.groupCreateOpen = v
  },
})

const candidates = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const list = friendStore.friends
  if (!k) return list
  return list.filter(
    (f) =>
      f.user.displayName.toLowerCase().includes(k) || f.user.username.toLowerCase().includes(k),
  )
})

const canSubmit = computed(() => selected.value.size >= 1 && name.value.trim().length > 0)

function toggle(userId: string): void {
  const next = new Set(selected.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  selected.value = next
  // 未手填群名时，用已选成员昵称自动建议一个
  if (!name.value.trim()) {
    const names = [...next]
      .map((id) => friendStore.friends.find((f) => f.user.id === id)?.user.displayName ?? '')
      .filter(Boolean)
    name.value = names.length > 0 ? `${names.slice(0, 3).join('、')}` : ''
  }
}

watch(open, (v) => {
  if (!v) {
    name.value = ''
    keyword.value = ''
    selected.value = new Set()
  }
})

async function submit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const conv = await convStore.createGroup(name.value.trim(), [...selected.value])
    ui.groupCreateOpen = false
    ui.toast('群聊已创建', 'success')
    // 建群后系统消息由服务端生成，进会话时 ensureLoaded 会拉到
    await msgStore.ensureLoaded(conv.id, 30)
    // activeId 由路由派生（见 ChatView）
    void router.push({ name: 'chat', params: { convId: conv.id } })
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppModal title="发起群聊" :open="open" :width="440" @close="ui.groupCreateOpen = false">
    <div class="create">
      <AppInput v-model="name" label="群名称" placeholder="给群聊起个名字" :maxlength="30" />

      <div class="create__field">
        <span class="create__label">选择成员（已选 {{ selected.size }} 人）</span>
        <div class="create__search">
          <AppIcon name="search" :size="14" />
          <input v-model="keyword" class="create__input" placeholder="搜索好友" />
        </div>
      </div>

      <div class="create__list">
        <AppEmpty
          v-if="candidates.length === 0"
          icon="contact"
          title="没有可选的好友"
          description="先去联系人里添加好友，才能拉群"
        />
        <button
          v-for="f in candidates"
          :key="f.user.id"
          class="create__item"
          :class="{ 'create__item--on': selected.has(f.user.id) }"
          type="button"
          @click="toggle(f.user.id)"
        >
          <span class="create__check">
            <AppIcon v-if="selected.has(f.user.id)" name="check" :size="13" />
          </span>
          <AppAvatar :name="f.user.displayName" :seed="f.user.id" :size="30" />
          <span class="create__name">{{ f.user.displayName }}</span>
        </button>
      </div>
    </div>

    <template #footer>
      <AppButton label="取消" tone="ghost" @click="ui.groupCreateOpen = false" />
      <AppButton
        label="创建"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </AppModal>
</template>

<style scoped>
.create {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.create__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.create__label {
  font-size: 12px;
  color: var(--app-text-muted);
}
.create__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  color: var(--app-text-faint);
}
.create__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--app-text);
  font-size: 13px;
  font-family: inherit;
}
.create__list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--app-border);
  border-radius: 6px;
}
.create__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.create__item:hover {
  background: var(--app-hover);
}
.create__item--on {
  background: color-mix(in srgb, var(--color-brand-500) 10%, transparent);
}
.create__check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  color: #fff;
  flex: 0 0 auto;
}
.create__item--on .create__check {
  background: var(--color-brand-500);
  border-color: var(--color-brand-500);
}
.create__name {
  font-size: 13px;
}
</style>
