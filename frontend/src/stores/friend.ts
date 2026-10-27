import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/friends'
import * as usersApi from '@/api/users'
import { useAuthStore } from './auth'
import { currentEpoch, epochValid } from './session'
import { deriveRelationship } from '@/api/normalize'
import type { Friend, FriendRequest, Relationship, UserSearchResult } from '@/types/domain'
import type { User } from '@/api/auth.types'

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<Friend[]>([])
  const incoming = ref<FriendRequest[]>([])
  const outgoing = ref<FriendRequest[]>([])
  /** 搜索结果（后端不返回 relationship，关系由本地推导）。 */
  const searchResults = ref<User[]>([])
  const searching = ref(false)
  const loading = ref(false)

  function selfId(): string {
    return useAuthStore().userId
  }

  const incomingCount = computed(() => incoming.value.length)
  const friendIds = computed(() => new Set(friends.value.map((f) => f.user.id)))

  function isFriend(userId: string): boolean {
    return friendIds.value.has(userId)
  }

  /** 本地推导关系（后端 /users 不返回 relationship）。 */
  function relationshipOf(userId: string): Relationship {
    return deriveRelationship(
      userId,
      selfId(),
      friendIds.value,
      new Set(outgoing.value.map((r) => r.toUser.id)),
      new Set(incoming.value.map((r) => r.fromUser.id)),
    )
  }

  const searchResultsWithRelation = computed<UserSearchResult[]>(() =>
    searchResults.value
      .filter((u) => u.id !== selfId())
      .map((user) => ({ user, relationship: relationshipOf(user.id) })),
  )

  async function fetchAll(): Promise<void> {
    const me = selfId()
    if (!me) return
    // 代际保护：注销/换账号期间回来的响应不得写入（否则新账号先看到旧账号好友）
    const gen = currentEpoch()
    loading.value = true
    try {
      const [fs, reqs] = await Promise.all([api.fetchFriends(), api.fetchFriendRequests(me)])
      if (!epochValid(gen)) return
      friends.value = fs
      // 后端不传 status 时返回全部；前端只保留 pending 供展示与操作
      const pending = reqs.filter((r) => r.status === 'pending')
      incoming.value = pending.filter((r) => r.direction === 'incoming')
      outgoing.value = pending.filter((r) => r.direction === 'outgoing')
    } finally {
      loading.value = false
    }
  }

  async function search(query: string): Promise<void> {
    const q = query.trim()
    if (!q) {
      searchResults.value = []
      return
    }
    const gen = currentEpoch()
    searching.value = true
    try {
      const res = await usersApi.searchUsers(q)
      if (!epochValid(gen)) return
      searchResults.value = res
    } finally {
      searching.value = false
    }
  }

  function clearSearch(): void {
    searchResults.value = []
  }

  async function sendRequest(toUserId: string, note?: string): Promise<void> {
    const req = await api.sendFriendRequest(note ? { toUserId, note } : { toUserId })
    outgoing.value = [{ ...req, direction: 'outgoing' }, ...outgoing.value]
  }

  /**
   * 通过申请。后端 respond 不返回会话，故额外建一次单聊
   * （/conversations/direct 幂等，见 docs/contract/diff-report.md C3）。
   */
  async function accept(requestId: string, fromUserId: string, fromUser?: Friend['user']): Promise<string> {
    const { conversationId } = await api.acceptFriendRequest(requestId, fromUserId)
    incoming.value = incoming.value.filter((r) => r.id !== requestId)
    if (fromUser && !friends.value.some((f) => f.user.id === fromUserId)) {
      friends.value = [{ user: fromUser, since: new Date().toISOString() }, ...friends.value]
    }
    return conversationId
  }

  async function reject(requestId: string): Promise<void> {
    await api.rejectFriendRequest(requestId)
    incoming.value = incoming.value.filter((r) => r.id !== requestId)
  }

  /* ── WS 推送入口 ───────────────────────────────────────────────── */

  function applyIncomingRequest(req: FriendRequest): void {
    if (incoming.value.some((r) => r.id === req.id)) return
    incoming.value = [{ ...req, direction: 'incoming' }, ...incoming.value]
  }

  function applyAccepted(friend: Friend): void {
    incoming.value = incoming.value.filter((r) => r.fromUser.id !== friend.user.id)
    outgoing.value = outgoing.value.filter((r) => r.toUser.id !== friend.user.id)
    if (!friends.value.some((f) => f.user.id === friend.user.id)) {
      friends.value = [friend, ...friends.value]
    }
  }

  /** 申请被拒绝：清掉本地 pending 项。 */
  function resolveRejected(requestId: string): void {
    incoming.value = incoming.value.filter((r) => r.id !== requestId)
    outgoing.value = outgoing.value.filter((r) => r.id !== requestId)
  }

  function applyRemoved(userId: string): void {
    friends.value = friends.value.filter((f) => f.user.id !== userId)
  }

  function reset(): void {
    friends.value = []
    incoming.value = []
    outgoing.value = []
    searchResults.value = []
  }

  return {
    friends,
    incoming,
    outgoing,
    searchResults,
    searchResultsWithRelation,
    searching,
    loading,
    incomingCount,
    friendIds,
    isFriend,
    relationshipOf,
    fetchAll,
    search,
    clearSearch,
    sendRequest,
    accept,
    reject,
    applyIncomingRequest,
    applyAccepted,
    resolveRejected,
    applyRemoved,
    reset,
  }
})
