/**
 * 消息置顶端点（ux2-contract §九）。
 *
 * 三个端点：
 *   GET    /api/v1/conversations/:conversationId/pins           → { items: PinnedMessage[] }
 *   POST   /api/v1/conversations/:conversationId/pins           body { msgId } → 201/200 PinnedMessage
 *   DELETE /api/v1/conversations/:conversationId/pins/:msgId    → 204
 *
 * 【最容易搞混的一点】返回里的 `id` 是 **pin 记录** 的 id，而 POST/DELETE 收的
 * 是 **消息的 msgId**。两者都是 UUID，长得一模一样，传错了后端只会回
 * 400 INVALID_MESSAGE / 404 PIN_NOT_FOUND，不会给你任何提示。所以本文件把
 * 「按消息 id 操作」写进函数签名（`pinMessage(convId, msgId)` / `unpinMessage`），
 * 调用方永远不需要接触 pin 记录 id。
 *
 * 错误码（§十三）：400 `INVALID_MESSAGE`、409 `PIN_LIMIT`（单会话上限 50）、
 * 404 `PIN_NOT_FOUND`。调用方按 `ApiError.code` 给不同文案。
 */
import { http } from './http'
import { toPinnedMessage } from './normalize'
import type { WirePinnedMessage, WirePinsPage } from './wire'
import type { PinnedMessage } from '@/types/domain'

function pinsPath(conversationId: string): string {
  return `/api/v1/conversations/${encodeURIComponent(conversationId)}/pins`
}

/**
 * 拉取会话的置顶列表。
 *
 * 后端按 `pinned_at DESC` 排序（最近置顶的在最前）。前端**不再二次排序** ——
 * 顺序是服务端语义的一部分（「最新置顶」最显眼）。
 */
export async function listPins(conversationId: string): Promise<PinnedMessage[]> {
  const { data } = await http.get<WirePinsPage>(pinsPath(conversationId))
  const items = data.items ?? []
  return items.map(toPinnedMessage)
}

/**
 * 置顶一条消息。
 *
 * 幂等：同一条消息重复置顶，后端返回 **200 + 原记录**（不是 201）。因此本函数
 * 不需要自己判重 —— 拿回来直接并进列表即可。
 *
 * `msgId` 必须是**消息 UUID**，不是 seq。
 */
export async function pinMessage(conversationId: string, msgId: string): Promise<PinnedMessage> {
  const { data } = await http.post<WirePinnedMessage>(pinsPath(conversationId), { msgId })
  return toPinnedMessage(data)
}

/**
 * 取消置顶。
 *
 * 用**消息 UUID**（`:msgId`），不是 pin 记录 id。成功 204 无正文；
 * 不存在 → 404 `PIN_NOT_FOUND`（调用方可以当作「已经不在了」吞掉）。
 */
export async function unpinMessage(conversationId: string, msgId: string): Promise<void> {
  await http.delete(`${pinsPath(conversationId)}/${encodeURIComponent(msgId)}`)
}
