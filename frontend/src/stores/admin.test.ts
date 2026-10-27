/**
 * admin store 单测。
 *
 * 覆盖四类真正容易写错的行为（都是契约里写了但实现时最容易走样的点）：
 *   1. 分页：`nextOffset === null` 才是末页；`loadMore` 要能重复调用而不重复请求；
 *   2. 查询：空白关键词必须 trim 掉再发（否则后端走 `LIKE '%%'` 分支）；
 *      快速切换关键词时旧响应不得覆盖新结果（requestSeq 代数）；
 *   3. 禁言/解除：成功后本地修补对应行、不整页重拉；`minutes === 0` 就是解除；
 *   4. 删除：成功后本地移除 + 刷新统计（用户数变了）。
 *
 * 另外单测两个纯函数：`canAccessAdmin`（路由守卫判定）与 `userStateOf`
 * （列表状态列，必须复用 `isMutedNow` 才不会把过期禁言显示成禁言中）。
 *
 * 写法照 `stores/conversation.test.ts`：`vi.hoisted` 造 API 桩 +
 * `setActivePinia(createPinia())`，每个用例前 reset 桩与 store。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiCtl = vi.hoisted(() => ({
  listUsers: vi.fn(),
  muteUser: vi.fn(),
  deleteUser: vi.fn(),
  fetchAdminStats: vi.fn(),
}))

vi.mock('@/api/admin', async () => {
  const actual = await vi.importActual<typeof import('@/api/admin')>('@/api/admin')
  return {
    ...actual,
    listUsers: apiCtl.listUsers,
    muteUser: apiCtl.muteUser,
    deleteUser: apiCtl.deleteUser,
    fetchAdminStats: apiCtl.fetchAdminStats,
  }
})

import type { AdminStats } from '@/api/admin'
import type { User } from '@/api/auth.types'
import { canAccessAdmin, userStateOf, useAdminStore } from './admin'

function makeUser(over: Partial<User> = {}): User {
  return {
    id: `uuid-${over.uid ?? 10001}`,
    uid: 10001,
    username: 'alice',
    displayName: '爱丽丝',
    avatarUrl: null,
    bio: null,
    role: 'user',
    status: 'active',
    mutedUntil: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    online: false,
    ...over,
  }
}

const STATS: AdminStats = { users: 3, conversations: 2, messages: 9, uploads: 1, online: 1 }

/** 延迟一会儿再 resolve，用来构造「响应乱序回来」的时序。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiCtl.listUsers.mockReset()
  apiCtl.muteUser.mockReset()
  apiCtl.deleteUser.mockReset()
  apiCtl.fetchAdminStats.mockReset()
})

describe('canAccessAdmin（/admin 守卫判定）', () => {
  it('只有 admin 放行', () => {
    expect(canAccessAdmin('admin')).toBe(true)
    expect(canAccessAdmin('user')).toBe(false)
  })

  it('未知/未登录一律拒绝（bootstrap 未完成时 user 为 null）', () => {
    expect(canAccessAdmin(null)).toBe(false)
    expect(canAccessAdmin(undefined)).toBe(false)
  })
})

describe('userStateOf（列表状态列）', () => {
  const now = Date.parse('2026-10-23T10:00:00.000Z')

  it('banned 优先于禁言', () => {
    expect(
      userStateOf({ status: 'banned', mutedUntil: '2026-10-24T10:00:00.000Z' }, now),
    ).toBe('banned')
  })

  it('未到期的 mutedUntil 算禁言中', () => {
    expect(userStateOf({ status: 'active', mutedUntil: '2026-10-24T10:00:00.000Z' }, now)).toBe(
      'muted',
    )
  })

  it('已到期的历史禁言不算禁言（这里最容易被写成 !== null 而永久显示禁言）', () => {
    expect(userStateOf({ status: 'active', mutedUntil: '2026-10-22T10:00:00.000Z' }, now)).toBe(
      'active',
    )
  })

  it('脏数据（不可解析时间）当未禁言，不让 UI 卡住', () => {
    expect(userStateOf({ status: 'active', mutedUntil: 'not-a-date' }, now)).toBe('active')
  })
})

describe('admin store · 分页', () => {
  it('首屏只拉一页并把 nextOffset 落库', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser()], nextOffset: 30 })
    const store = useAdminStore()

    await store.load()

    expect(apiCtl.listUsers).toHaveBeenCalledTimes(1)
    expect(apiCtl.listUsers).toHaveBeenCalledWith({ query: '', limit: 30, offset: 0 })
    expect(store.users).toHaveLength(1)
    expect(store.hasMore).toBe(true)
  })

  it('nextOffset 为 null 时 hasMore 为假，loadMore 不再发请求', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser()], nextOffset: null })
    const store = useAdminStore()
    await store.load()

    expect(store.hasMore).toBe(false)
    await store.loadMore()
    expect(apiCtl.listUsers).toHaveBeenCalledTimes(1)
  })

  it('loadMore 用 nextOffset 作 offset 并追加去重', async () => {
    apiCtl.listUsers
      .mockResolvedValueOnce({ items: [makeUser({ uid: 10001 })], nextOffset: 30 })
      .mockResolvedValueOnce({
        // 故意回传一条已在列表里的用户：并发场景后端可能重排，前端必须去重
        items: [makeUser({ uid: 10001 }), makeUser({ uid: 10002, id: 'uuid-10002' })],
        nextOffset: null,
      })
    const store = useAdminStore()
    await store.load()
    await store.loadMore()

    expect(apiCtl.listUsers).toHaveBeenLastCalledWith({ query: '', limit: 30, offset: 30 })
    expect(store.users.map((u) => u.uid)).toEqual([10001, 10002])
    expect(store.hasMore).toBe(false)
  })
})

describe('admin store · 查询', () => {
  it('关键词 trim 后再发，空白词当作不过滤', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [], nextOffset: null })
    const store = useAdminStore()

    await store.load('   10001  ')
    expect(apiCtl.listUsers).toHaveBeenLastCalledWith({ query: '10001', limit: 30, offset: 0 })
    expect(store.query).toBe('10001')

    await store.load('   ')
    expect(apiCtl.listUsers).toHaveBeenLastCalledWith({ query: '', limit: 30, offset: 0 })
    expect(store.query).toBe('')
  })

  it('旧请求晚到不得覆盖新查询结果（requestSeq 代数）', async () => {
    const slow = deferred<{ items: User[]; nextOffset: number | null }>()
    apiCtl.listUsers
      .mockReturnValueOnce(slow.promise) // 第一次：慢，且查的是 10001
      .mockResolvedValueOnce({ items: [makeUser({ uid: 10002 })], nextOffset: null })
    const store = useAdminStore()

    const first = store.load('10001')
    await store.load('10002')
    slow.resolve({ items: [makeUser({ uid: 99999 })], nextOffset: null })
    await first

    expect(store.users.map((u) => u.uid)).toEqual([10002])
  })

  it('列表失败时清空列表并把错误落到 error，loading 复位', async () => {
    apiCtl.listUsers.mockRejectedValueOnce(new Error('需要管理员权限'))
    const store = useAdminStore()

    await store.load()

    expect(store.users).toEqual([])
    expect(store.nextOffset).toBeNull()
    expect(store.error).toContain('需要管理员权限')
    expect(store.loading).toBe(false)
  })
})

describe('admin store · 禁言 / 解除', () => {
  it('禁言成功后本地修补该行，不整页重拉', async () => {
    apiCtl.listUsers.mockResolvedValue({
      items: [makeUser({ uid: 10001 }), makeUser({ uid: 10002, id: 'uuid-10002' })],
      nextOffset: null,
    })
    const store = useAdminStore()
    await store.load()

    const muted = makeUser({ uid: 10002, id: 'uuid-10002', mutedUntil: '2026-10-24T00:00:00.000Z' })
    apiCtl.muteUser.mockResolvedValue(muted)
    await store.mute(10002, 60)

    expect(apiCtl.muteUser).toHaveBeenCalledWith(10002, 60)
    expect(apiCtl.listUsers).toHaveBeenCalledTimes(1) // 没有重拉整个列表
    expect(store.users.find((u) => u.uid === 10002)?.mutedUntil).toBe(
      '2026-10-24T00:00:00.000Z',
    )
    // 另一行不受影响
    expect(store.users.find((u) => u.uid === 10001)?.mutedUntil).toBeNull()
  })

  it('unmute 等价于 mute(uid, 0)', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser()], nextOffset: null })
    const store = useAdminStore()
    await store.load()
    apiCtl.muteUser.mockResolvedValue(makeUser({ mutedUntil: null }))

    await store.unmute(10001)

    expect(apiCtl.muteUser).toHaveBeenCalledWith(10001, 0)
  })

  it('禁言失败时向上抛错且不动列表（页面据此 toast）', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser()], nextOffset: null })
    const store = useAdminStore()
    await store.load()
    apiCtl.muteUser.mockRejectedValue(new Error('不能禁言管理员账号'))

    await expect(store.mute(10001, 30)).rejects.toThrow('不能禁言管理员账号')
    expect(store.users).toHaveLength(1)
    expect(store.saving).toBe(false)
  })
})

describe('admin store · 删除', () => {
  it('删除成功后本地移除该行并刷新统计', async () => {
    apiCtl.listUsers.mockResolvedValue({
      items: [makeUser({ uid: 10001 }), makeUser({ uid: 10002, id: 'uuid-10002' })],
      nextOffset: null,
    })
    apiCtl.fetchAdminStats.mockResolvedValue({ ...STATS, users: 2 })
    const store = useAdminStore()
    await store.load()
    apiCtl.deleteUser.mockResolvedValue(undefined)

    await store.remove(store.users[0]!)

    expect(apiCtl.deleteUser).toHaveBeenCalledWith(10001)
    expect(store.users.map((u) => u.uid)).toEqual([10002])
    // void refreshStats() —— 等一个微任务让它落地
    await Promise.resolve()
    expect(apiCtl.fetchAdminStats).toHaveBeenCalledTimes(1)
    expect(apiCtl.listUsers).toHaveBeenCalledTimes(1) // 不整页重拉
  })

  it('删除管理员被后端拒绝时列表不变', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser({ uid: 1001, role: 'admin' })], nextOffset: null })
    const store = useAdminStore()
    await store.load()
    apiCtl.deleteUser.mockRejectedValue(new Error('不能删除管理员账号'))

    await expect(store.remove(store.users[0]!)).rejects.toThrow('不能删除管理员账号')
    expect(store.users).toHaveLength(1)
    expect(store.saving).toBe(false)
  })
})

describe('admin store · 统计与重置', () => {
  it('refreshStats 写入 stats', async () => {
    apiCtl.fetchAdminStats.mockResolvedValue(STATS)
    const store = useAdminStore()

    await store.refreshStats()

    expect(store.stats).toEqual(STATS)
    expect(store.statsLoading).toBe(false)
  })

  it('reset 清空全部状态（登出时由 auth.clearLocal 触发）', async () => {
    apiCtl.listUsers.mockResolvedValue({ items: [makeUser()], nextOffset: 30 })
    apiCtl.fetchAdminStats.mockResolvedValue(STATS)
    const store = useAdminStore()
    await store.load()
    await store.refreshStats()

    store.reset()

    expect(store.users).toEqual([])
    expect(store.stats).toBeNull()
    expect(store.query).toBe('')
    expect(store.nextOffset).toBeNull()
    expect(store.error).toBe('')
  })
})
