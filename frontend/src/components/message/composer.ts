/**
 * 输入框对外暴露的数据形状。
 *
 * 单独成文件而不是放在 `MessageComposer.vue` 的 `<script setup>` 里：
 * `<script setup>` 不允许顶层 `export`，而 MessagePane 需要这个类型来
 * 标注 `onSend` 的参数。
 */
import type { Attachment } from '@/types/domain'

export interface ComposerSendPayload {
  /** 已 trim 的正文；附件消息可以为空串。 */
  content: string
  /** 已上传成功的附件（发送时只带 attachmentId）。 */
  attachment?: Attachment
}

export type { Attachment }
