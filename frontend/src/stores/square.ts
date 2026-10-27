/**
 * 广场信息流 store。
 *
 * 【为什么是独立的 store】广场与消息/会话完全解耦：不同端点、不同分页语义
 * （不透明 cursor 而非 seq）、不同附件规则（允许视频）。混进 conversation /
 * message store 只会让两套分页互相污染。
 *
 * 【代际保护】所有异步响应回来先核对 `currentEpoch()`：登出/换账号期间回来
 * 的响应绝不能写进新账号的列表（否则新用户先看到上一个账号的广场内容）。
 * 与 stores/friend.ts、stores/message.ts 的做法一致。
 *
 * 【实时性】广场的实时更新分两层：
 * 1) WS 增量（主路径）：`ws/handlers.ts` 暴露了 `onPostWsEvent(listener)` —— 它是
 *    自建订阅表（`Set<PostEventListener>`），不碰 `wsClient.setEvents()` 的单订阅者，
 *    因此广场可以安全订阅 `post.created/deleted/liked/commented`。订阅点在
 *    `views/SquareView.vue`（组件生命周期，随页面挂载/卸载），store 只提供
 *    `prepend/patch/remove/bumpCommentCount/refreshPost` 这些幂等的增量入口。
 * 2) 低频兜底：WS 掉线/后端未广播时，`startAutoRefresh()` 在页面可见时每 180s
 *    静默刷新首屏，切到后台自动停表。两条路径都不会重置列表（除非用户手动刷新）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/posts'
import { toApiError } from '@/api/http'
import { currentEpoch, epochValid } from './session'
import type { Post, PostPage } from '@/api/posts'

export const useSquareStore = defineStore('square', () => {
  /** 信息流（`createdAt` 降序，与后端一致；本 store 不做排序）。 */
  const posts = ref<Post[]>([])
  /** 下一页游标；null = 没有更多。 */
  const nextCursor = ref<string | null>(null)
  /** 首屏/刷新中。 */
  const loading = ref(false)
  /** 加载更多中。 */
  const loadingMore = ref(false)
  /** 发帖请求在飞（防重复提交）。 */
  const composing = ref(false)
  /** 首屏错误文案；空串表示无错误。 */
  const error = ref('')

  const hasMore = computed(() => nextCursor.value !== null)
  const isEmpty = computed(() => !loading.value && posts.value.length === 0)

  /** 自动刷新定时器（页面可见时才存在）。 */
  let refreshTimer: number | null = null

  function indexOf(id: string): number {
    return posts.value.findIndex((p) => p.id === id)
  }

  function postOf(id: string): Post | null {
    return posts.value.find((p) => p.id === id) ?? null
  }

  /**
   * 拉取信息流。
   *
   * @param reset true（默认）= 重新拉首屏；false = 用 `nextCursor` 追加下一页。
   * @returns 是否真的发起了请求（并发重入时返回 false）
   */
  async function fetchFeed(reset = true): Promise<boolean> {
    if (reset ? loading.value : loadingMore.value) return false
    if (!reset && nextCursor.value === null) return false

    const gen = currentEpoch()
    const cursor = reset ? null : nextCursor.value
    if (reset) {
      loading.value = true
      error.value = ''
    } else {
      loadingMore.value = true
    }
    try {
      const page: PostPage = await api.fetchPosts({ cursor })
      if (!epochValid(gen)) return false
      if (reset) {
        posts.value = page.items
      } else {
        // 追加时按 id 去重：翻页期间有人发新帖会让游标页与本页重叠
        const seen = new Set(posts.value.map((p) => p.id))
        posts.value = [...posts.value, ...page.items.filter((p) => !seen.has(p.id))]
      }
      nextCursor.value = page.nextCursor
      return true
    } catch (e) {
      if (!epochValid(gen)) return false
      const message = toApiError(e).message || '加载失败'
      // 加载更多失败不该清空已有内容，只在首屏失败时占据错误态
      if (reset) error.value = message
      throw toApiError(e)
    } finally {
      if (epochValid(gen)) {
        loading.value = false
        loadingMore.value = false
      }
    }
  }

  /** 发帖成功：置顶插入，返回新帖。 */
  async function createPost(content: string, attachmentIds: string[]): Promise<Post> {
    const gen = currentEpoch()
    composing.value = true
    try {
      const post = await api.createPost({
        content: content.trim(),
        attachmentIds: [...attachmentIds],
      })
      if (epochValid(gen)) prepend(post)
      return post
    } finally {
      composing.value = false
    }
  }

  /** 删除：先从列表移除（失败回滚到原位置），再调接口。 */
  async function deletePost(id: string): Promise<void> {
    const gen = currentEpoch()
    const index = indexOf(id)
    const snapshot = index >= 0 ? posts.value[index] ?? null : null
    if (index >= 0) posts.value = posts.value.filter((p) => p.id !== id)
    try {
      await api.deletePost(id)
    } catch (e) {
      // 失败回滚：放回原位置，避免「帖子凭空消失又刷新出来」
      if (epochValid(gen) && snapshot && indexOf(id) < 0) {
        const next = [...posts.value]
        next.splice(Math.min(index, next.length), 0, snapshot)
        posts.value = next
      }
      throw toApiError(e)
    }
  }

  /**
   * 点赞开关：乐观更新 → 失败回滚。
   *
   * @returns 操作后的最终状态（失败会抛，调用方弹 toast）
   */
  async function toggleLike(id: string): Promise<{ liked: boolean; likeCount: number } | null> {
    const gen = currentEpoch()
    const post = postOf(id)
    if (!post) return null
    const before = { liked: post.likedByMe, likeCount: post.likeCount }
    // 乐观：立即翻转
    post.likedByMe = !before.liked
    post.likeCount = Math.max(0, before.likeCount + (before.liked ? -1 : 1))
    try {
      const result = before.liked ? await api.unlikePost(id) : await api.likePost(id)
      if (!epochValid(gen)) return null
      const target = postOf(id)
      if (target) {
        target.likedByMe = result.liked
        target.likeCount = result.likeCount
      }
      return result
    } catch (e) {
      const target = postOf(id)
      if (target) {
        target.likedByMe = before.liked
        target.likeCount = before.likeCount
      }
      throw toApiError(e)
    }
  }

  /**
   * 重新拉单帖并原地替换（评论数变化、外部事件后对齐计数）。
   *
   * @returns 最新帖子；不在列表里或代际失效时返回 null
   */
  async function refreshPost(id: string): Promise<Post | null> {
    const gen = currentEpoch()
    try {
      const fresh = await api.fetchPost(id)
      if (!epochValid(gen)) return null
      patch(fresh)
      return fresh
    } catch {
      // 计数对齐失败是噪声，不弹错（帖子可能已被删除）
      return null
    }
  }

  /** 评论数 +delta（PostComments 提交成功后调用）。 */
  function bumpCommentCount(id: string, delta: number): void {
    const post = postOf(id)
    if (!post) return
    post.commentCount = Math.max(0, post.commentCount + delta)
  }

  /** 置顶插入（发帖成功；WS 的 post.created 也能复用）。已存在则替换。 */
  function prepend(post: Post): void {
    const rest = posts.value.filter((p) => p.id !== post.id)
    posts.value = [post, ...rest]
  }

  /** 原地替换（按 id）。不存在则忽略。 */
  function patch(post: Post): void {
    const i = indexOf(post.id)
    if (i < 0) return
    const next = [...posts.value]
    next[i] = post
    posts.value = next
  }

  /** 移除（WS 的 post.deleted / 本地删除后同步）。 */
  function remove(id: string): void {
    posts.value = posts.value.filter((p) => p.id !== id)
  }

  /* ── 低频自动刷新（WS 掉线时的兜底）────────────────────────────── */

  /**
   * 页面可见时每 180s 静默刷新首屏；不可见时停表，省流量也省电。
   *
   * 主路径是 `ws/handlers.ts` 的 `onPostWsEvent`（见文件头）；把间隔从 60s 放宽到
   * 180s 是因为 WS 正常时这条循环基本是空跑，只在掉线期间才真正起作用。
   */
  const REFRESH_MS = 180_000

  function refreshSilently(): void {
    // 正在首屏加载/加载更多时不插队（避免两组响应互相覆盖）
    if (loading.value || loadingMore.value) return
    void fetchFeed(true).catch(() => {
      /* 静默刷新失败不打扰用户，下一次再试 */
    })
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') refreshSilently()
  }

  /** 挂载自动刷新。调用方（SquareView）负责在卸载时 `stopAutoRefresh()`。 */
  function startAutoRefresh(): void {
    stopAutoRefresh()
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshSilently()
    }, REFRESH_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stopAutoRefresh(): void {
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer)
      refreshTimer = null
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  /** 登出/换账号时清空（auth store 尚未接入本 reset，视图挂载时也会校验）。 */
  function reset(): void {
    stopAutoRefresh()
    posts.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    composing.value = false
    error.value = ''
  }

  return {
    // state
    posts,
    nextCursor,
    loading,
    loadingMore,
    composing,
    error,
    // getters
    hasMore,
    isEmpty,
    // actions
    fetchFeed,
    createPost,
    deletePost,
    toggleLike,
    refreshPost,
    bumpCommentCount,
    prepend,
    patch,
    remove,
    postOf,
    refreshSilently,
    startAutoRefresh,
    stopAutoRefresh,
    reset,
  }
})
