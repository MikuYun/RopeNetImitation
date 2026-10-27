<script setup lang="ts">
/**
 * 会话列表项。
 *
 * 预览优先级：正在输入 > 最后一条消息 > 空态。
 * 未读数只信服务端（store 里的 unreadCount），本地清零仅乐观显示。
 */
import { computed } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { usePresenceStore } from '@/stores/presence'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { formatListTime } from '@/utils/datetime'
import type { ConversationSummary } from '@/types/domain'

const props = defineProps<{ conversation: ConversationSummary; active: boolean }>()
defineEmits<{ select: [] }>()

const presence = usePresenceStore()
const auth = useAuthStore()
const convStore = useConversationStore()

const typingUsers = computed(() =>
  presence.typingUsersOf(props.conversation.id, auth.userId),
)
const isTyping = computed(() => typingUsers.value.length > 0)

/**
 * 群聊预览要显示「发送者：内容」，而 ConversationSummary 里只有 senderId，
 * 没有 senderName —— 靠 `peer` 查名字对群聊无效（群聊恒为 null），
 * 于是前缀会退化成空串，出现「：群实时消息」这种残缺显示。
 *
 * 名字来源按可靠性排序：
 *   1. 会话详情的 members[]（打开过该群时已有缓存）
 *   2. conversation.lastMessage 若后端将来补 senderName 则直接用
 *   3. 都取不到时**不显示前缀**，只显示正文 —— 宁可少一个前缀，也不要留一个孤零零的冒号
 */
/**
 * 附件消息的预览前缀。
 *
 * 附件消息的 `content` 可能是空串（图片恒为空），直接用会把列表项变成
 * 「我：」这种残缺文案；`ConversationSummary` 只回带 `attachmentKind`
 * （避免列表里塞完整 attachment），足够渲染 `[图片]` / `[文件]`。
 */
function previewBody(last: NonNullable<ConversationSummary['lastMessage']>): string {
  const kind = last.attachmentKind ?? (last.type === 'image' || last.type === 'file' ? last.type : null)
  if (kind === 'image') return last.content ? `[图片] ${last.content}` : '[图片]'
  if (kind === 'file') return last.content ? `[文件] ${last.content}` : '[文件]'
  return last.content
}

const preview = computed(() => {
  if (isTyping.value) {
    const n = typingUsers.value.length
    return props.conversation.type === 'group' ? `${n} 人正在输入…` : '正在输入…'
  }
  const last = props.conversation.lastMessage
  if (!last) return '暂无消息'

  const body = previewBody(last)
  if (last.senderId === auth.userId) {
    return `我：${body}`
  }
  if (props.conversation.type === 'group') {
    const name = senderName(last.senderId)
    // 拿不到名字时省略前缀，避免出现「：内容」
    return name ? `${name}：${body}` : body
  }
  return body
})

/** 在会话详情的成员表里找发送者昵称；找不到返回空串。 */
function senderName(userId: string): string {
  const peer = props.conversation.peer
  if (peer && peer.id === userId) return peer.displayName
  const detail = convStore.detailsById.get(props.conversation.id)
  const member = detail?.members.find((m) => m.user.id === userId)
  return member?.user.displayName ?? ''
}

const time = computed(() => formatListTime(props.conversation.updatedAt))
const showPresence = computed(
  () => props.conversation.type === 'single' && !!props.conversation.peer,
)
</script>

<template>
  <button class="item" :class="{ 'item--active': active }" type="button" @click="$emit('select')">
    <div class="item__avatar">
      <AppAvatar
        :name="conversation.title"
        :seed="conversation.peer?.id ?? conversation.id"
        :size="40"
      />
      <PresenceDot
        v-if="showPresence && conversation.peer"
        class="item__dot"
        :user-id="conversation.peer.id"
      />
    </div>

    <div class="item__main">
      <div class="item__row">
        <span class="item__title">{{ conversation.title }}</span>
        <span class="item__time">{{ time }}</span>
      </div>
      <div class="item__row">
        <span class="item__preview" :class="{ 'item__preview--typing': isTyping }">
          {{ preview }}
        </span>
        <span v-if="conversation.unreadCount > 0" class="item__badge">
          {{ conversation.unreadCount > 99 ? '99+' : conversation.unreadCount }}
        </span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  color: inherit;
}
.item:hover {
  background: var(--app-hover);
}
.item--active {
  background: var(--app-active);
}

.item__avatar {
  position: relative;
  flex: 0 0 auto;
}
.item__dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
}

.item__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.item__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.item__title {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__time {
  font-size: 11px;
  color: var(--app-text-faint);
  flex: 0 0 auto;
}
.item__preview {
  font-size: 12px;
  color: var(--app-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.item__preview--typing {
  color: var(--color-typing);
}
.item__badge {
  flex: 0 0 auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--color-danger-500);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
</style>
