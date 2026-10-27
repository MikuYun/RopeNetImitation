import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useMessageStore } from '@/stores/message'
import { useFriendStore } from '@/stores/friend'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore } from '@/stores/ui'
import { registerWsHandlers } from '@/ws/handlers'

const mocked = vi.hoisted(() => ({
  logout: vi.fn(), markRead: vi.fn(), setEvents: vi.fn(), stop: vi.fn(),
  fetchConversations: vi.fn(), fetchMessages: vi.fn(),
}))

vi.mock('@/api/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/auth')>(), logout: mocked.logout,
}))
vi.mock('@/api/conversations', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/conversations')>(),
  markRead: mocked.markRead, fetchConversations: mocked.fetchConversations,
}))
vi.mock('@/api/messages', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/messages')>(), fetchMessages: mocked.fetchMessages,
}))
vi.mock('@/ws/client', () => ({
  wsClient: { stop: mocked.stop, setEvents: mocked.setEvents, connect: vi.fn(), send: vi.fn() },
}))

const summary = {
  id: 'conversation-a', type: 'single' as const, title: 'private-a',
  lastSeq: 1, lastReadSeq: 0, unreadCount: 1, updatedAt: '2026-10-08T00:00:00.000Z',
}
const message = {
  msgId: 'message-a', conversationId: summary.id, senderId: 'user-b',
  clientMsgId: null, seq: 1, type: 'text' as const, content: 'private-content-a',
  createdAt: '2026-10-08T00:00:00.000Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('document', { visibilityState: 'visible', documentElement: { dataset: {} } })
  setActivePinia(createPinia())
  mocked.logout.mockResolvedValue(undefined)
  mocked.markRead.mockResolvedValue(undefined)
  mocked.fetchConversations.mockResolvedValue([])
  mocked.fetchMessages.mockResolvedValue({ items: [], hasMore: false })
  const auth = useAuthStore()
  auth.user = { id: 'user-a', username: 'user_a', displayName: 'User A' }
  auth.token = 'a'.repeat(43)
  auth.status = 'authenticated'
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function seedPrivateState(): void {
  const conversations = useConversationStore()
  conversations.upsertSummary({ ...summary })
  conversations.setActive(summary.id)
  useMessageStore().insertOrIgnore({ ...message })
  useFriendStore().friends = [{ user: { id: 'user-b', username: 'user_b', displayName: 'User B' }, since: message.createdAt }]
  usePresenceStore().onlineByUserId.set('user-b', true)
}

function expectPrivateStateCleared(): void {
  expect.soft(useConversationStore().summariesById.size, 'previous account conversation cache').toBe(0)
  expect.soft(useConversationStore().activeId, 'previous account active conversation').toBeNull()
  expect.soft(useMessageStore().buckets.size, 'previous account message cache').toBe(0)
  expect.soft(useFriendStore().friends, 'previous account friends').toHaveLength(0)
  expect.soft(usePresenceStore().onlineByUserId.size, 'previous account presence').toBe(0)
}

describe('SEC-02 account privacy isolation', () => {
  it('explicit logout clears all previous-account data', async () => {
    seedPrivateState()
    await useAuthStore().logout()
    expect(useAuthStore().token).toBeNull()
    expectPrivateStateCleared()
  })
  it('revoked session clears private caches immediately', () => {
    seedPrivateState()
    useAuthStore().onSessionRevoked('SESSION_EXPIRED')
    expect(useAuthStore().token).toBeNull()
    expectPrivateStateCleared()
  })

  it('late conversation list from A cannot refill B account state', async () => {
    let complete!: (items: typeof summary[]) => void
    mocked.fetchConversations.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const conversations = useConversationStore()
    const pending = conversations.fetchAll()
    await useAuthStore().logout()
    const auth = useAuthStore()
    auth.user = { id: 'user-c', username: 'user_c', displayName: 'User C' }
    auth.token = 'c'.repeat(43)
    auth.status = 'authenticated'
    complete([{ ...summary }])
    await pending
    expect(conversations.summariesById.size, 'late A response must be discarded').toBe(0)
  })

  it('late message history cannot refill caches after logout', async () => {
    let complete!: (page: { items: typeof message[]; hasMore: boolean }) => void
    mocked.fetchMessages.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const messages = useMessageStore()
    const pending = messages.ensureLoaded(summary.id)
    await useAuthStore().logout()
    complete({ items: [{ ...message }], hasMore: false })
    await pending
    expect(messages.buckets.size, 'late private history must be discarded').toBe(0)
  })
})

describe('FE-01 reading requires visible conversation body', () => {
  it('visible registered reading still reports read', async () => {
    const conversations = useConversationStore()
    conversations.upsertSummary({ ...summary, lastSeq: 0 })
    conversations.setActive(summary.id)
    conversations.setReading(summary.id)
    registerWsHandlers()
    const events = mocked.setEvents.mock.calls[0]?.[0]
    events.onFrame({
      v: 1, id: 'event-a', type: 'message.created', timestamp: message.createdAt,
      data: { message: { ...message }, unreadCount: 1 },
    })
    await Promise.resolve()
    expect(mocked.markRead).toHaveBeenCalledWith(summary.id, 1)
  })
  it.each(['hidden document', 'contacts panel'])('does not report read while %s', async (condition) => {
    const conversations = useConversationStore()
    conversations.upsertSummary({ ...summary, lastSeq: 0 })
    conversations.setActive(summary.id)
    if (condition === 'hidden document') {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    } else {
      useUiStore().railTab = 'contacts'
    }
    registerWsHandlers()
    const events = mocked.setEvents.mock.calls[0]?.[0]
    expect(events?.onFrame, 'registered WS frame callback').toBeTypeOf('function')
    events.onFrame({
      v: 1, id: 'event-a', type: 'message.created', timestamp: message.createdAt,
      data: { message: { ...message }, unreadCount: 1 },
    })
    await Promise.resolve()
    expect(useMessageStore().messagesOf(summary.id), 'event actually inserted').toHaveLength(1)
    expect(mocked.markRead, 'not visible, so no read request').not.toHaveBeenCalled()
    expect(conversations.summariesById.get(summary.id)?.unreadCount, 'unread retained').toBe(1)
  })
})

describe('FE-02 read acknowledgement failure recovery', () => {
  it('older failed read cannot roll back a newer successful read', async () => {
    const conversations = useConversationStore()
    conversations.upsertSummary({ ...summary, lastSeq: 2, unreadCount: 2 })
    let fail!: (error: Error) => void
    mocked.markRead.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const oldRead = conversations.markRead(summary.id, 1).catch(() => undefined)
    await conversations.markRead(summary.id, 2)
    fail(new Error('old request failed after new success'))
    await oldRead
    expect.soft(conversations.summariesById.get(summary.id)?.lastReadSeq, 'newer successful cursor retained').toBe(2)
    expect.soft(conversations.summariesById.get(summary.id)?.unreadCount, 'newer successful read retained').toBe(0)
  })

  it('failed REST read does not leave successful-looking cursor or unread count', async () => {
    const conversations = useConversationStore()
    conversations.upsertSummary({ ...summary })
    mocked.markRead.mockRejectedValueOnce(new Error('simulated transport failure'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await conversations.markRead(summary.id, 1)
    } catch {
    }
    expect.soft(conversations.summariesById.get(summary.id)?.lastReadSeq, 'failed read cursor').toBe(0)
    expect.soft(conversations.summariesById.get(summary.id)?.unreadCount, 'failed read unread count').toBe(1)
  })
})
