/**
 * WS 帧 → store 的分发层。
 *
 * 单独成文件是为了避免循环依赖：client 不认识 store，store 也不认识 client，
 * 由这里把两者接起来（在 main.ts 启动时注册一次）。
 *
 * 契约基准：backend/API.md §6（v0.2.0）。
 * 注意：**发送消息与已读走 REST**，本层只处理服务端推送的事件。
 */
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useMessageStore } from '@/stores/message'
import { usePinsStore } from '@/stores/pins'
import { usePresenceStore } from '@/stores/presence'
import { useUiStore } from '@/stores/ui'
import { wsClient, type ConnState } from './client'
import type { z } from 'zod'
import {
  S2C,
  zConversationEventData,
  zConversationPinsData,
  zConversationRemovedData,
  zErrorData,
  zFriendRequestData,
  zMessageCreatedData,
  zPresenceData,
  zReadUpdatedData,
  zReadyData,
  zTypingData,
  zConversation,
  type InboundEnvelope,
} from './schema'
import { toPinnedMessage } from '@/api/normalize'
import type { ConversationSummary } from '@/types/domain'

/**
 * 补偿编排（契约 §5「重连建议」六步，此处为可执行版本）：
 *   1. 拿票据建 WS 并缓存事件（由 client 完成，本函数在 ready 后运行）
 *   2. REST 刷新所有会话列表
 *   3. 对仍有权限的会话按本地 seq 逐页 sync
 *   4. 合并并去重（由 message store 的 insertOrIgnore 保证）
 *   5. 收到 404 先刷新列表移除已退群项后重试
 *   6. 校准在线状态
 */
async function runCompensation(): Promise<void> {
  const conversationStore = useConversationStore()
  const messageStore = useMessageStore()
  const presenceStore = usePresenceStore()

  // 步骤 2：刷新会话列表（同时校准 lastMessage / unreadCount / lastReadSeq / 排序）
  try {
    await conversationStore.fetchAll()
  } catch (e) {
    console.warn('[ws] 补偿：会话列表拉取失败，跳过后续补偿', e)
    return
  }

  // 步骤 3：按本地 seq 补齐缺口。REST 是唯一可靠来源（服务端不重放 WS 事件）。
  //
  // 【关键约束】只补偿**用户已打开过**的会话。
  //
  // 原因：从未打开过的会话本地 lastSeq 为 0，若按「serverSeq > localSeq」判断，
  // 每个未打开的会话都会被判定为「有缺口」并把**全部历史**拉进内存 —— 20 个活跃群
  // × 数百条消息 = 一次登录拉几万条，首屏直接卡死；而且会话被打开时会发现消息
  // 已经全在了，用户看不到「向上加载更多」，分页逻辑形同虚设。
  //
  // 未打开的会话只需会话摘要里的 lastMessage/unreadCount（第 2 步已刷新），
  // 消息体等用户点进去时由 MessagePane 的 ensureLoaded 拉最新一页。
  const stale = [...conversationStore.summariesById.entries()]
    .map(([id, c]) => ({
      id,
      localSeq: messageStore.lastSeqOf(id),
      serverSeq: c.lastSeq,
      opened: messageStore.isLoaded(id),
    }))
    .filter((x) => x.opened && x.serverSeq > x.localSeq)
    .slice(0, 20)

  for (const item of stale) {
    try {
      await messageStore.catchUp(item.id)
    } catch (e) {
      // 步骤 5：404 说明已无权限 → 从列表移除
      const err = e as { status?: number }
      if (err.status === 404) {
        conversationStore.removeSummary(item.id)
        console.info(`[ws] 补偿：会话 ${item.id} 已无权限，已从列表移除`)
      } else {
        console.warn(`[ws] 补偿：会话 ${item.id} 补齐失败`, e)
      }
    }
  }

  // 步骤 6：在线状态校准（后端无 /presence 端点，故用列表内嵌的 online 快照）
  presenceStore.seedFromLists()

  // 重发 outbox 中待发消息？—— v0.2.0 无 WS 发消息通道，
  // 失败的 REST 发送由用户在气泡上点「重试」触发，复用原 clientMsgId 保证幂等。
}

export function registerWsHandlers(): void {
  wsClient.setEvents({
    onState(state: ConnState, detail) {
      const ui = useUiStore()
      if (state === 'reconnecting' && detail?.attempt === 1) {
        ui.toast('连接已断开，正在重连…', 'info')
      }
    },

    onReady(env: InboundEnvelope) {
      const parsed = zReadyData.safeParse(env.data)
      if (!parsed.success) {
        console.warn('[ws] ready 帧字段不符合契约', parsed.error.issues)
      }
      void runCompensation()
    },

    onFrame(env: InboundEnvelope) {
      dispatch(env)
    },

    onAuthFailed(reason) {
      const auth = useAuthStore()
      const ui = useUiStore()
      ui.toast('登录状态已失效，请重新登录', 'error')
      auth.onSessionRevoked(reason === 'ticket_auth' ? 'UNAUTHORIZED' : 'SESSION_EXPIRED')
    },

    onProtocolMismatch(remote) {
      const ui = useUiStore()
      ui.toast(`协议版本不匹配（服务端 v${remote}），请刷新页面`, 'error')
    },

    onPersistentFailure(attempts) {
      const ui = useUiStore()
      ui.toast(`网络异常，已重试 ${attempts} 次`, 'error')
    },
  })
}

/**
 * 把 WS 推送的会话对象归一化为内部摘要。
 * WS 与 REST 共用同一套字段（v0.2.0），但 WS 帧里 members 可能被省略，
 * 故这里对可选字段做兜底。
 */
function toSummary(raw: z.infer<typeof zConversation>): ConversationSummary {
  return {
    id: raw.id,
    type: raw.type,
    title: raw.title || raw.name,
    avatarUrl: raw.avatarUrl || null,
    peer: raw.peer
      ? {
          id: raw.peer.id,
          username: raw.peer.username,
          displayName: raw.peer.displayName,
          avatarUrl: raw.peer.avatarUrl || null,
        }
      : null,
    memberCount: raw.memberCount ?? null,
    lastMessage: raw.lastMessage
      ? {
          type: raw.lastMessage.type,
          content: raw.lastMessage.content,
          senderId: raw.lastMessage.senderId,
          seq: raw.lastMessage.seq,
          attachmentKind: raw.lastMessage.attachment?.kind ?? null,
        }
      : null,
    lastSeq: raw.lastSeq ?? 0,
    lastReadSeq: raw.lastReadSeq ?? 0,
    unreadCount: raw.unreadCount ?? 0,
    updatedAt: raw.updatedAt,
  }
}

function dispatch(env: InboundEnvelope): void {
  const messageStore = useMessageStore()
  const conversationStore = useConversationStore()
  const friendStore = useFriendStore()
  const presenceStore = usePresenceStore()
  const pinsStore = usePinsStore()
  const auth = useAuthStore()
  const ui = useUiStore()

  switch (env.type) {
    case S2C.MESSAGE_CREATED: {
      const r = zMessageCreatedData.safeParse(env.data)
      if (!r.success) return
      const { message: msg, unreadCount } = r.data
      const isMine = msg.senderId === auth.userId

      // 缺口检测：seq 跳跃说明中间丢帧，立即补齐
      if (messageStore.detectGap(msg.conversationId, msg.seq)) {
        void messageStore.catchUp(msg.conversationId)
      }

      // 三层去重入口：会按 clientMsgId 兑现乐观消息、按 msgId 去重
      messageStore.insertOrIgnore({
        msgId: msg.msgId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        clientMsgId: msg.clientMsgId ?? null,
        seq: msg.seq,
        type: msg.type,
        content: msg.content,
        // 附件必须逐字段透传 —— 少这一行，WS 推来的图片/文件消息就只剩空气泡
        attachment: msg.attachment ?? null,
        createdAt: msg.createdAt,
      })

      const conv = conversationStore.summariesById.get(msg.conversationId)
      if (conv) {
        /**
         * 【已读门禁】只有「正在真正阅读」该会话才自动上报已读。
         *
         * 判定用 `isReading`（由 MessagePane 在正文可见 **且** 页面可见时置位），
         * **不是** activeId。两者必须分开，否则下面两种场景会把未读静默吞掉：
         *   - 手机端用户停在会话列表，activeId 仍指向上次打开的会话；
         *   - 桌面端用户切到联系人 tab / 浏览器后台标签，正文仍在 DOM 里。
         * 用户根本没看见消息，红点却没了。
         */
        const isReading = conversationStore.isReading(msg.conversationId)
        conversationStore.upsertSummary(
          {
            ...conv,
            lastMessage: {
              type: msg.type,
              content: msg.content,
              senderId: msg.senderId,
              seq: msg.seq,
              attachmentKind: msg.attachment?.kind ?? null,
            },
            lastSeq: msg.seq,
            // P0-9：未读数只信服务端个性化值。缺字段时**不做本地 +1**
            // （本地累加必然与服务端漂移），改为保持原值并触发一次列表刷新校准。
            unreadCount:
              typeof unreadCount === 'number'
                ? unreadCount
                : isReading || isMine
                  ? 0
                  : conv.unreadCount,
            updatedAt: msg.createdAt,
          },
          { keepPosition: false },
        )
        if (typeof unreadCount !== 'number') {
          void conversationStore.fetchAll()
        }
        // 门禁：必须真的在阅读中才上报（且不是自己发的）
        if (isReading && !isMine && msg.seq > conv.lastReadSeq) {
          // markRead 失败会回滚乐观显示并抛出；这里显式兜住，避免未处理的 rejection
          void conversationStore.markRead(msg.conversationId, msg.seq).catch((e) => {
            console.warn('[ws] 自动已读上报失败，显示已回滚', e)
          })
        }
      } else {
        // 新会话（别人给我建的 / 我被拉进群）
        void conversationStore.fetchAll()
      }
      break
    }

    case S2C.CONVERSATION_READ: {
      const r = zReadUpdatedData.safeParse(env.data)
      if (!r.success) return
      const { conversationId, userId, lastReadSeq, unreadCount } = r.data

      if (userId === auth.userId) {
        // 我自己（可能是另一台设备）读了 → 用服务端权威值校准未读，保证多端红点一致
        const conv = conversationStore.summariesById.get(conversationId)
        if (conv) {
          conversationStore.upsertSummary(
            {
              ...conv,
              lastReadSeq: Math.max(conv.lastReadSeq, lastReadSeq),
              unreadCount: unreadCount ?? conv.unreadCount,
            },
            { keepPosition: true },
          )
        }
        break
      }

      // 别人读了 → 更新群聊「N 人已读」的成员游标
      messageStore.applyMemberReadSeq(conversationId, userId, lastReadSeq)
      conversationStore.applyReadReceipt(conversationId, userId, lastReadSeq)
      break
    }

    case S2C.TYPING_CHANGED: {
      const r = zTypingData.safeParse(env.data)
      if (!r.success) return
      if (r.data.userId === auth.userId) return
      presenceStore.applyTyping(r.data.conversationId, r.data.userId, r.data.active)
      break
    }

    case S2C.PRESENCE_CHANGED: {
      const r = zPresenceData.safeParse(env.data)
      if (!r.success) return
      // v0.2.0 的 presence.changed 只带 {userId, online}，无 lastSeenAt
      presenceStore.applyPresenceUpdated(r.data.userId, r.data.online)
      break
    }

    case S2C.CONVERSATION_CREATED:
    case S2C.CONVERSATION_UPDATED: {
      const r = zConversationEventData.safeParse(env.data)
      if (!r.success) return
      conversationStore.upsertSummary(toSummary(r.data.conversation))
      // 详情缓存可能已过期（成员变更走 conversation.updated），主动重取
      if (conversationStore.detailsById.has(r.data.conversation.id)) {
        void conversationStore.fetchDetail(r.data.conversation.id).catch(() => {
          /* 忽略：404 表示已无权限，列表下次刷新会同步 */
        })
      }
      break
    }

    case S2C.CONVERSATION_REMOVED: {
      const r = zConversationRemovedData.safeParse(env.data)
      if (!r.success) return
      conversationStore.removeSummary(r.data.conversationId)
      messageStore.dropBucket(r.data.conversationId)
      // 被移出会话后置顶缓存也要丢：否则置顶条还挂着再也拉不到的正文
      pinsStore.dropConv(r.data.conversationId)
      ui.toast('你已被移出该会话', 'info')
      break
    }

    /**
     * 置顶列表变化（ux2-contract §九.4）。
     *
     * 服务端推的是**完整列表**，因此这里整体替换，不做增量合并 ——
     * 合并需要在客户端重现服务端的排序与去重规则，只会制造不一致。
     * 谁操作的无所谓（自己/别人/另一台设备），列表是会话级共享状态。
     */
    case S2C.CONVERSATION_PINS: {
      const r = zConversationPinsData.safeParse(env.data)
      if (!r.success) return
      pinsStore.applyFromWs(r.data.conversationId, r.data.pins.map(toPinnedMessage))
      break
    }

    case S2C.FRIEND_REQUESTED: {
      const r = zFriendRequestData.safeParse(env.data)
      if (!r.success) return
      const req = r.data.request
      if (req.recipient.id === auth.userId) {
        friendStore.applyIncomingRequest({
          id: req.id,
          fromUser: {
            id: req.sender.id,
            username: req.sender.username,
            displayName: req.sender.displayName,
            avatarUrl: req.sender.avatarUrl ?? null,
          },
          toUser: {
            id: req.recipient.id,
            username: req.recipient.username,
            displayName: req.recipient.displayName,
            avatarUrl: req.recipient.avatarUrl ?? null,
          },
          direction: 'incoming',
          status: req.status,
          message: req.note || null,
          createdAt: req.createdAt,
        })
        ui.toast(`${req.sender.displayName} 请求添加你为好友`, 'info')
      }
      break
    }

    case S2C.FRIEND_RESOLVED: {
      const r = zFriendRequestData.safeParse(env.data)
      if (!r.success) return
      const req = r.data.request
      if (req.status === 'accepted') {
        // 我是申请方 → 对方通过了
        if (req.sender.id === auth.userId) {
          friendStore.applyAccepted({
            user: {
              id: req.recipient.id,
              username: req.recipient.username,
              displayName: req.recipient.displayName,
              avatarUrl: req.recipient.avatarUrl ?? null,
            },
            since: req.updatedAt ?? new Date().toISOString(),
          })
          ui.toast(`${req.recipient.displayName} 已通过你的好友申请`, 'success')
        } else {
          // 我是接收方（可能是另一台设备处理的）
          friendStore.applyAccepted({
            user: {
              id: req.sender.id,
              username: req.sender.username,
              displayName: req.sender.displayName,
              avatarUrl: req.sender.avatarUrl ?? null,
            },
            since: req.updatedAt ?? new Date().toISOString(),
          })
        }
        void conversationStore.fetchAll()
      } else {
        friendStore.resolveRejected(req.id)
      }
      break
    }

    case S2C.ERROR: {
      const r = zErrorData.safeParse(env.data)
      if (!r.success) return
      console.warn('[ws] 服务端错误帧', r.data.code, r.data.message)
      break
    }

    default:
      // pong 由 client 层消化；未知帧静默忽略，保证向后兼容
      break
  }
}
