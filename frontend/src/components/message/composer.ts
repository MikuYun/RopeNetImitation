/**
 * 输入框对外暴露的数据形状。
 *
 * 单独成文件而不是放在 `MessageComposer.vue` 的 `<script setup>` 里：
 * `<script setup>` 不允许顶层 `export`，而 MessagePane 需要这个类型来
 * 标注 `onSend` 的参数。
 */
import type { Attachment } from '@/types/domain'
import type { ReplyRef } from '@/types/domain'

export interface ComposerSendPayload {
  /**
   * 已 trim 的正文。
   *
   * 永远是「用户实际输入正文」的原样值，**可以为空串**（纯图片/纯文件消息）。
   * 无论有没有附件都不能丢掉它 —— v1 在带附件时把 content 整个丢弃，
   * 导致「发了图片，配的文字丢了」，那正是 v2 修的根因。
   */
  content: string
  /**
   * 已上传成功的附件（**有序**，发送时按顺序转成 `attachmentIds`）。
   *
   * 空数组表示纯文本消息；不要用 `undefined`，下游可以无条件 `.length`。
   */
  attachments: Attachment[]
  /** 引用回复的目标消息 id；`null` 表示普通消息。 */
  replyToMsgId: string | null
}

/** 供 MessagePane 复用的引用快照类型（与气泡里的 `ReplyRef` 是同一个）。 */
export type { Attachment, ReplyRef }
