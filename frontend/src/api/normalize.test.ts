import { describe, expect, it } from 'vitest'
import {
  deriveRelationship,
  deriveTypeFromAttachments,
  isMutedNow,
  normalizeAttachmentKind,
  normalizeConvType,
  normalizeMessageType,
  normalizeRole,
  toConversationDetail,
  toConversationSummary,
  toFriendRequest,
  toLocalMessage,
  toPinnedMessage,
  toUser,
  toUserBrief,
  toWireMessage,
} from '@/api/normalize'
import type {
  WireConversation,
  WireFriendRequest,
  WireMessage,
  WirePinnedMessage,
  WireUser,
} from '@/api/wire'

/**
 * 归一化层单测。
 *
 * 这一层是「后端字段命名」与「前端领域模型」之间唯一的缝。它错了，
 * 全站 UI 都会拿到错数据但不会报错 —— 所以必须有测试钉住行为。
 *
 * 测试数据取自 backend/openapi.json v0.2.0 的真实响应形状（见
 * docs/contract/diff-report.md），不是手编的假想结构。
 */

const SELF = 'u-self'

function wireUser(id: string, name: string, over: Partial<WireUser> = {}): WireUser {
  return {
    id,
    // ux2-contract §四新增字段：默认给「普通活跃用户」，具体用例按需覆盖。
    uid: 0,
    username: id,
    displayName: name,
    avatarUrl: '',
    bio: '',
    role: 'user',
    status: 'active',
    mutedUntil: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    online: false,
    ...over,
  }
}

function wireConversation(over: Partial<WireConversation> = {}): WireConversation {
  return {
    id: 'c1',
    type: 'single',
    name: '',
    title: 'Bob',
    avatarUrl: '',
    peer: wireUser('u-bob', 'Bob'),
    ownerId: null,
    memberCount: 2,
    myRole: 'member',
    members: [
      { user: wireUser(SELF, 'Me'), role: 'member', joinedAt: '2026-09-28T00:00:00.000Z', lastReadSeq: 3 },
      { user: wireUser('u-bob', 'Bob'), role: 'member', joinedAt: '2026-09-28T00:00:00.000Z', lastReadSeq: 5 },
    ],
    unreadCount: 2,
    lastSeq: 5,
    lastReadSeq: 3,
    lastMessage: {
      msgId: 'm5',
      conversationId: 'c1',
      senderId: 'u-bob',
      clientMsgId: 'cm5',
      seq: 5,
      type: 'text',
      content: 'last',
      createdAt: '2026-09-28T00:05:00.000Z',
    },
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:05:00.000Z',
    ...over,
  }
}

describe('normalizeConvType', () => {
  it('把 group 识别为 group，其余一律 single（容忍后端历史枚举 direct）', () => {
    expect(normalizeConvType('group')).toBe('group')
    expect(normalizeConvType('single')).toBe('single')
    // v0.1 后端曾用 direct，v0.2 已改 single —— 两者都必须落到内部 single
    expect(normalizeConvType('direct')).toBe('single')
    expect(normalizeConvType('')).toBe('single')
  })
})

describe('normalizeMessageType', () => {
  it('只有显式 system 才是 system，未知值降级为 text（宁可显示成文本也不要崩）', () => {
    expect(normalizeMessageType('system')).toBe('system')
    expect(normalizeMessageType('text')).toBe('text')
    expect(normalizeMessageType('future-type')).toBe('text')
  })
})

describe('normalizeRole', () => {
  it('白名单外的角色降级为 member', () => {
    expect(normalizeRole('owner')).toBe('owner')
    expect(normalizeRole('admin')).toBe('admin')
    expect(normalizeRole('superuser')).toBe('member')
    expect(normalizeRole('')).toBe('member')
  })
})

describe('toUserBrief', () => {
  it('空 avatarUrl 归一为 null，避免组件渲染空 src', () => {
    expect(toUserBrief(wireUser('u1', 'A')).avatarUrl).toBeNull()
  })

  // 回归：早期版本漏了 online，导致首屏播种拿不到值、绿点永远不亮
  it('透传 online —— presence store 靠它做首屏播种', () => {
    expect(toUserBrief({ ...wireUser('u1', 'A'), online: true }).online).toBe(true)
    expect(toUserBrief({ ...wireUser('u1', 'A'), online: false }).online).toBe(false)
  })

  it('online 缺失时为 undefined（而非 false）—— 让播种逻辑能区分「未知」与「离线」', () => {
    const u: Partial<WireUser> = { ...wireUser('u1', 'A') }
    delete u.online
    expect(toUserBrief(u as WireUser).online).toBeUndefined()
  })

  it('缺字段时不抛错，返回占位用户', () => {
    expect(toUserBrief(null).displayName).toBe('未知用户')
    expect(toUserBrief(undefined).id).toBe('')
  })
})

describe('toConversationSummary', () => {
  it('直接采用服务端给的视角化 title（不自建一套昵称解析）', () => {
    const s = toConversationSummary(wireConversation(), SELF)
    expect(s.title).toBe('Bob')
    expect(s.type).toBe('single')
    expect(s.peer?.id).toBe('u-bob')
  })

  it('lastMessage 归一化 type 字段', () => {
    const s = toConversationSummary(wireConversation(), SELF)
    expect(s.lastMessage?.type).toBe('text')
    expect(s.lastMessage?.seq).toBe(5)
  })

  it('未读数原样透传（服务端权威值，前端不得自行累加）', () => {
    expect(toConversationSummary(wireConversation(), SELF).unreadCount).toBe(2)
  })

  it('后端未给 title 时用 name 兜底', () => {
    const s = toConversationSummary(wireConversation({ title: '' }), SELF)
    // 单聊：走 peer.displayName 兜底
    expect(s.title).toBe('Bob')
  })

  it('群聊未给 title 时用群名兜底', () => {
    const g = wireConversation({
      type: 'group',
      title: '',
      name: '契约讨论组',
      peer: undefined,
      memberCount: 3,
      members: [
        { user: wireUser(SELF, 'Me'), role: 'owner', joinedAt: '', lastReadSeq: 0 },
        { user: wireUser('u-bob', 'Bob'), role: 'member', joinedAt: '', lastReadSeq: 0 },
      ],
    })
    const s = toConversationSummary(g, SELF)
    expect(s.type).toBe('group')
    expect(s.title).toBe('契约讨论组')
    expect(s.peer).toBeNull()
  })

  it('群聊的 peer 必须为 null —— 否则 UI 会把群当成单聊渲染出「对方在输入」之类', () => {
    const g = wireConversation({ type: 'group', peer: undefined, name: 'G' })
    expect(toConversationSummary(g, SELF).peer).toBeNull()
  })

  it('后端未给 lastReadSeq 时从自己的 members 项兜底', () => {
    const c = wireConversation({ lastReadSeq: undefined })
    expect(toConversationSummary(c, SELF).lastReadSeq).toBe(3)
  })
})

describe('toConversationDetail', () => {
  it('保留全部成员的 lastReadSeq —— 群聊「N 人已读」的唯一依据', () => {
    const d = toConversationDetail(wireConversation(), SELF)
    expect(d.members).toHaveLength(2)
    const bob = d.members.find((m) => m.user.id === 'u-bob')
    expect(bob?.lastReadSeq).toBe(5)
  })

  it('未给 myRole 时从自己的成员项兜底', () => {
    expect(toConversationDetail(wireConversation({ myRole: undefined }), SELF).myRole).toBe('member')
  })

  it('群主识别正确', () => {
    const g = wireConversation({
      type: 'group',
      myRole: 'owner',
      members: [{ user: wireUser(SELF, 'Me'), role: 'owner', joinedAt: '', lastReadSeq: 0 }],
    })
    expect(toConversationDetail(g, SELF).myRole).toBe('owner')
  })
})

describe('toFriendRequest', () => {
  function req(): WireFriendRequest {
    return {
      id: 'r1',
      sender: wireUser('u-bob', 'Bob'),
      recipient: wireUser(SELF, 'Me'),
      note: 'hi',
      status: 'pending',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    }
  }

  it('direction 由 sender 与自身关系推导：我是收件方 -> incoming', () => {
    expect(toFriendRequest(req(), SELF).direction).toBe('incoming')
  })

  it('我是发件方 -> outgoing', () => {
    expect(toFriendRequest(req(), 'u-bob').direction).toBe('outgoing')
  })

  it('note 为空字符串时归一为 null', () => {
    expect(toFriendRequest({ ...req(), note: '' }, SELF).message).toBeNull()
  })

  it('后端新增 status 值时原样传递，不崩', () => {
    const r = toFriendRequest({ ...req(), status: 'expired' as never }, SELF)
    expect(r.status).toBe('expired')
  })
})

describe('deriveRelationship', () => {
  const none = new Set<string>()

  it('自己 -> self（前端应据此禁用加好友按钮）', () => {
    expect(deriveRelationship(SELF, SELF, none, none, none)).toBe('self')
  })

  it('已在好友列表 -> friend', () => {
    expect(deriveRelationship('u-bob', SELF, new Set(['u-bob']), none, none)).toBe('friend')
  })

  it('已发出申请 -> request_sent', () => {
    expect(deriveRelationship('u-bob', SELF, none, new Set(['u-bob']), none)).toBe('request_sent')
  })

  it('收到申请 -> request_received', () => {
    expect(deriveRelationship('u-bob', SELF, none, none, new Set(['u-bob']))).toBe(
      'request_received',
    )
  })

  it('好友优先级高于申请（双方同时是好友且有过申请时）', () => {
    expect(
      deriveRelationship('u-bob', SELF, new Set(['u-bob']), new Set(['u-bob']), none),
    ).toBe('friend')
  })

  it('无关系 -> none', () => {
    expect(deriveRelationship('u-x', SELF, none, none, none)).toBe('none')
  })
})

/**
 * ux2-contract §四：User 新增 uid / role / status / mutedUntil。
 *
 * 这一组的重点是**两种缺失语义不能混**：
 *  - `toUserBrief`（精简投影）：字段缺失时保持 `undefined`，让消费方自行兜底，
 *    这样才能区分「后端没给」与「后端明确给了 user/active」；
 *  - `toUser`（当前登录用户）：`User` 类型要求四个字段必需，必须给出确定值。
 */
describe('User 的 ux2 新增字段（uid / role / status / mutedUntil）', () => {
  it('toUserBrief：字段齐全时原样保留（含 admin/banned）', () => {
    const brief = toUserBrief(
      wireUser('u-admin', 'Admin', {
        uid: 42,
        role: 'admin',
        status: 'banned',
        mutedUntil: '2026-11-01T00:00:00.000Z',
      }),
    )
    expect(brief.uid).toBe(42)
    expect(brief.role).toBe('admin')
    expect(brief.status).toBe('banned')
    expect(brief.mutedUntil).toBe('2026-11-01T00:00:00.000Z')
  })

  it('toUserBrief：字段缺失时保持 undefined（而不是填默认值）', () => {
    const raw = {
      id: 'u-old',
      username: 'old',
      displayName: 'Old',
      avatarUrl: '',
      bio: '',
      createdAt: '2026-09-28T00:00:00.000Z',
      online: false,
    } as unknown as WireUser
    const brief = toUserBrief(raw)
    expect(brief.uid).toBeUndefined()
    expect(brief.role).toBeUndefined()
    expect(brief.status).toBeUndefined()
    expect(brief.mutedUntil).toBeUndefined()
  })

  it('toUserBrief：role 非白名单值不写入（防止脏值污染 UI）', () => {
    const brief = toUserBrief(wireUser('u1', 'A', { role: 'superuser' as never }))
    expect(brief.role).toBeUndefined()
  })

  it('toUser：字段齐全时原样返回', () => {
    const u = toUser(
      wireUser('u-admin', 'Admin', {
        uid: 7,
        role: 'admin',
        status: 'banned',
        mutedUntil: '2026-11-01T00:00:00.000Z',
      }),
    )
    expect(u.uid).toBe(7)
    expect(u.role).toBe('admin')
    expect(u.status).toBe('banned')
    expect(u.mutedUntil).toBe('2026-11-01T00:00:00.000Z')
  })

  it('toUser：字段缺失时给出确定兜底值（uid 0 / user / active / null）', () => {
    const raw = {
      id: 'u-old',
      username: 'old',
      displayName: 'Old',
      avatarUrl: '',
      bio: '',
      createdAt: '2026-09-28T00:00:00.000Z',
      online: false,
    } as unknown as WireUser
    const u = toUser(raw)
    expect(u.uid).toBe(0)
    expect(u.role).toBe('user')
    expect(u.status).toBe('active')
    expect(u.mutedUntil).toBeNull()
  })

  it('toUser：role 为 admin 时保留 admin（群内 role 与账号 role 不是一回事）', () => {
    expect(toUser(wireUser('u1', 'A', { role: 'admin' })).role).toBe('admin')
  })

  it('toUser：status 非 banned 一律归为 active（字段漂移不该把所有人当封禁）', () => {
    expect(toUser(wireUser('u1', 'A', { status: 'weird' as never })).status).toBe('active')
  })
})

describe('isMutedNow（契约 §四的禁言语义）', () => {
  const NOW = Date.parse('2026-10-23T00:00:00.000Z')

  it('mutedUntil 为 null → 未禁言', () => {
    expect(isMutedNow({ mutedUntil: null }, NOW)).toBe(false)
  })

  it('mutedUntil 缺失 → 未禁言', () => {
    expect(isMutedNow({}, NOW)).toBe(false)
  })

  it('到期时间晚于现在 → 禁言中', () => {
    expect(isMutedNow({ mutedUntil: '2026-10-24T00:00:00.000Z' }, NOW)).toBe(true)
  })

  it('到期时间早于现在 → 已解禁（最容易写错的一条：不能只判 !== null）', () => {
    expect(isMutedNow({ mutedUntil: '2026-10-22T00:00:00.000Z' }, NOW)).toBe(false)
  })

  it('到期时间正好等于现在 → 视为已解禁（严格大于才算禁言）', () => {
    expect(isMutedNow({ mutedUntil: '2026-10-23T00:00:00.000Z' }, NOW)).toBe(false)
  })

  it('脏数据（无法 parse）当作未禁言，不让 UI 卡在禁言态', () => {
    expect(isMutedNow({ mutedUntil: 'not-a-date' }, NOW)).toBe(false)
  })
})

describe('toPinnedMessage（ux2-contract §九）', () => {
  function wirePinned(over: Partial<WirePinnedMessage> = {}): WirePinnedMessage {
    return {
      id: 'pin-1',
      message: {
        msgId: 'm-1',
        conversationId: 'c1',
        senderId: 'u-bob',
        clientMsgId: 'cm-1',
        seq: 12,
        type: 'text',
        content: '被置顶的消息',
        createdAt: '2026-10-22T00:00:00.000Z',
      },
      pinnedBy: wireUser('u-self', 'Me', { uid: 1 }),
      pinnedAt: '2026-10-23T00:00:00.000Z',
      ...over,
    }
  }

  it('pin 记录 id 与消息 msgId 是两个不同字段，不能混淆', () => {
    const p = toPinnedMessage(wirePinned())
    expect(p.id).toBe('pin-1')
    expect(p.message.msgId).toBe('m-1')
  })

  it('message 走 toWireMessage（容量/类型兜底与普通消息一致）', () => {
    const p = toPinnedMessage(wirePinned({ message: { ...wirePinned().message, type: 'image' } }))
    // 声明 image 但没有 attachment → 应被降级回 text（避免永远加载不出的空卡片）
    expect(p.message.type).toBe('text')
  })

  it('pinnedBy 走 toUserBrief，保留 uid', () => {
    expect(toPinnedMessage(wirePinned()).pinnedBy.uid).toBe(1)
  })

  it('带附件的置顶消息能保留 attachments（v2 数组形状）', () => {
    const msg: WireMessage = {
      ...wirePinned().message,
      type: 'image',
      content: '',
      attachments: [
        {
          id: 'a-1',
          name: 'a.png',
          mimeType: 'image/png',
          size: 100,
          kind: 'image',
          url: '/api/v1/uploads/a-1',
          createdAt: '2026-10-22T00:00:00.000Z',
        },
      ],
    }
    const p = toPinnedMessage(wirePinned({ message: msg }))
    expect(p.message.attachments.map((a) => a.id)).toEqual(['a-1'])
    expect(p.message.type).toBe('image')
  })

  it('旧后端（单数 attachment）在置顶消息里也能被扮平成数组', () => {
    const msg: WireMessage = {
      ...wirePinned().message,
      type: 'image',
      content: '',
      attachment: {
        id: 'a-old',
        name: 'old.png',
        mimeType: 'image/png',
        size: 10,
        kind: 'image',
        url: '/api/v1/uploads/a-old',
        createdAt: '2026-10-22T00:00:00.000Z',
      },
    }
    const p = toPinnedMessage(wirePinned({ message: msg }))
    expect(p.message.attachments.map((a) => a.id)).toEqual(['a-old'])
  })
})

describe('normalizeRole / normalizeMessageType 的 ux2 扩展', () => {
  it('群角色 admin 不再被吞成 member', () => {
    expect(normalizeRole('admin')).toBe('admin')
    expect(normalizeRole('owner')).toBe('owner')
    expect(normalizeRole('member')).toBe('member')
    expect(normalizeRole('weird')).toBe('member')
  })

  it('消息类型 image/file 保留', () => {
    expect(normalizeMessageType('image')).toBe('image')
    expect(normalizeMessageType('file')).toBe('file')
    expect(normalizeMessageType('text')).toBe('text')
    expect(normalizeMessageType('system')).toBe('system')
    expect(normalizeMessageType('weird')).toBe('text')
  })

  it('v2 新增的 video / mixed 也保留（缺这两个值，视频消息会被降级成文本）', () => {
    expect(normalizeMessageType('video')).toBe('video')
    expect(normalizeMessageType('mixed')).toBe('mixed')
  })
})

/*
 * ── v2（API 0.3.0）契约：attachments 数组 / recalled / replyTo / video ──
 *
 * 灰度期旧后端的帧里只有单数 `attachment`，甚至三个新字段一个都没有。
 * 归一化层必须把这些全部兜住：漏一个就会让整条消息在 UI 上错形
 * （图片变空气泡、撤回消息泄露原文、引用条消失），而 TS 检查不到 ——
 * 因为 wire 类型里这些字段是可选的。所以全部钉在这里。
 */
describe('v2 消息形状：attachments / recalled / replyTo / video', () => {
  function wireMsg(over: Partial<WireMessage> = {}): WireMessage {
    return {
      msgId: 'm-1',
      conversationId: 'c1',
      senderId: 'u-bob',
      clientMsgId: null,
      seq: 7,
      type: 'text',
      content: 'hello',
      createdAt: '2026-10-22T00:00:00.000Z',
      ...over,
    }
  }

  function wireAtt(id: string, kind: 'image' | 'video' | 'file', name: string) {
    return {
      id,
      name,
      mimeType: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'text/plain',
      size: 1234,
      kind,
      url: `/api/v1/uploads/${id}`,
      createdAt: '2026-10-22T00:00:00.000Z',
    }
  }

  it('多附件原样保留顺序（顺序即 UI 宫格排布，不能按 id 重排）', () => {
    const w = toWireMessage(wireMsg({ attachments: [wireAtt('a2', 'image', '2.png'), wireAtt('a1', 'image', '1.png')] }))
    expect(w.attachments.map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(w.type).toBe('image')
  })

  it('旧后端只有单数 attachment 时包成单元素数组（灰度期最关键的一条）', () => {
    const w = toWireMessage(wireMsg({ type: 'image', content: '', attachment: wireAtt('a-old', 'image', 'old.png') }))
    expect(w.attachments.map((a) => a.id)).toEqual(['a-old'])
    expect(w.type).toBe('image')
  })

  it('attachments 为 null / 缺失 / 含脏元素时一律得到干净数组', () => {
    expect(toWireMessage(wireMsg()).attachments).toEqual([])
    expect(toWireMessage(wireMsg({ attachments: null })).attachments).toEqual([])
    // 脏元素（null）被过滤掉，不能让下游 `attachments[0].kind` 炸
    const dirty = toWireMessage(
      wireMsg({ type: 'image', content: '', attachments: [null as never, wireAtt('a1', 'image', 'ok.png')] }),
    )
    expect(dirty.attachments.map((a) => a.id)).toEqual(['a1'])
  })

  it('recalled / recalledAt / replyTo 缺失时补 false / null / null', () => {
    const w = toWireMessage(wireMsg())
    expect(w.recalled).toBe(false)
    expect(w.recalledAt).toBeNull()
    expect(w.replyTo).toBeNull()
  })

  it('recalled=true 与 recalledAt 原样透传（撤回态不能丢，否则 UI 会渲染原文）', () => {
    const w = toWireMessage(
      wireMsg({ content: '', recalled: true, recalledAt: '2026-10-22T00:01:00.000Z' }),
    )
    expect(w.recalled).toBe(true)
    expect(w.recalledAt).toBe('2026-10-22T00:01:00.000Z')
  })

  it('replyTo 逐字段透传（引用条要显示 senderName 与 preview）', () => {
    const w = toWireMessage(
      wireMsg({
        replyTo: { msgId: 'm-0', senderId: 'u-alice', senderName: 'Alice', preview: '被引用的原文' },
      }),
    )
    expect(w.replyTo).toEqual({
      msgId: 'm-0',
      senderId: 'u-alice',
      senderName: 'Alice',
      preview: '被引用的原文',
    })
  })

  it('replyTo 展示字段缺失时保留 msgId、preview 兜空串（丢了 msgId 就没法点击跳转）', () => {
    expect(toWireMessage(wireMsg({ replyTo: null })).replyTo).toBeNull()
    // 没有任何 msgId 的引用是废数据，整条丢掉
    expect(toWireMessage(wireMsg({ replyTo: { preview: 'x' } as never })).replyTo).toBeNull()
    // 有 msgId 但缺 senderName/preview：仍要能渲染 + 能跳转，展示字段兜空串
    const partial = toWireMessage(wireMsg({ replyTo: { msgId: 'm-0' } as never }))
    expect(partial.replyTo?.msgId).toBe('m-0')
    expect(partial.replyTo?.preview).toBe('')
  })

  it('video 附件：kind 保留 video，type 推导为 video', () => {
    const w = toWireMessage(wireMsg({ type: 'video', content: '', attachments: [wireAtt('v1', 'video', 'a.mp4')] }))
    expect(w.attachments[0]?.kind).toBe('video')
    expect(w.type).toBe('video')
  })

  it('混合附件推导为 mixed（图片 + 视频）', () => {
    const w = toWireMessage(
      wireMsg({
        type: 'text',
        content: '看这个',
        attachments: [wireAtt('a1', 'image', '1.png'), wireAtt('v1', 'video', 'a.mp4')],
      }),
    )
    expect(w.type).toBe('mixed')
  })

  it('声称 image 但没有任何附件 → 降级 text（避免永远加载不出的空卡片）', () => {
    expect(toWireMessage(wireMsg({ type: 'image', content: '' })).type).toBe('text')
  })

  it('normalizeAttachmentKind：未知 kind 一律降级 file（不能让 UI 拿到不存在的分支）', () => {
    expect(normalizeAttachmentKind('image')).toBe('image')
    expect(normalizeAttachmentKind('video')).toBe('video')
    expect(normalizeAttachmentKind('file')).toBe('file')
    expect(normalizeAttachmentKind('audio')).toBe('file')
    expect(normalizeAttachmentKind('weird')).toBe('file')
  })

  it('toLocalMessage 与 toWireMessage 对 v2 字段保持同一份真值', () => {
    const raw = wireMsg({
      type: 'image',
      content: '',
      attachments: [wireAtt('a1', 'image', '1.png')],
      recalled: true,
      recalledAt: '2026-10-22T00:01:00.000Z',
      replyTo: { msgId: 'm-0', senderId: 'u-alice', senderName: 'Alice', preview: 'x' },
    })
    const w = toWireMessage(raw)
    const l = toLocalMessage(raw)
    expect(l.attachments).toEqual(w.attachments)
    expect(l.recalled).toBe(w.recalled)
    expect(l.recalledAt).toBe(w.recalledAt)
    expect(l.replyTo).toEqual(w.replyTo)
    expect(l.status).toBe('sent')
  })

  it('deriveTypeFromAttachments 与服务端推导规则逐字一致', () => {
    expect(deriveTypeFromAttachments([])).toBe('text')
    expect(deriveTypeFromAttachments([{ kind: 'image' } as never])).toBe('image')
    expect(deriveTypeFromAttachments([{ kind: 'video' } as never])).toBe('video')
    expect(deriveTypeFromAttachments([{ kind: 'file' } as never])).toBe('file')
    expect(deriveTypeFromAttachments([{ kind: 'file' } as never, { kind: 'file' } as never])).toBe('file')
    expect(
      deriveTypeFromAttachments([{ kind: 'image' } as never, { kind: 'video' } as never]),
    ).toBe('mixed')
  })
})
