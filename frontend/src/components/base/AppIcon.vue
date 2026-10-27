<script setup lang="ts">
/**
 * 自绘 SVG 图标集。
 *
 * 合规硬要求：不得使用任何第三方图标素材包，全部 path 手写。
 *
 * v2 新增（广场 / 多附件消息 / 主题 / 个人信息）：
 *   compass, image, video, play, heart, heart-filled, comment,
 *   palette, shield, reply, undo, expand-more, drag, trash, user
 */
withDefaults(
  defineProps<{
    name:
      | 'chat'
      | 'contact'
      | 'plus'
      | 'search'
      | 'send'
      | 'back'
      | 'more'
      | 'sun'
      | 'moon'
      | 'close'
      | 'check'
      | 'alert'
      | 'info'
      | 'user-plus'
      | 'users'
      | 'logout'
      | 'retry'
      | 'double-check'
      | 'compass'
      | 'image'
      | 'video'
      | 'play'
      | 'heart'
      | 'heart-filled'
      | 'comment'
      | 'palette'
      | 'shield'
      | 'reply'
      | 'undo'
      | 'expand-more'
      | 'drag'
      | 'trash'
      | 'user'
      | 'download'
      | 'share'
      | 'refresh'
      | 'lock'
    size?: number
  }>(),
  { size: 20 },
)

const paths: Record<string, string> = {
  chat: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-5 4z',
  contact:
    'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 4.5V20h14v-1.5C19 16 16 14 12 14Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.5-1.5L21 21',
  send: 'M4 11.5 20 4l-7.5 16-2-6.5z',
  back: 'M15 5l-7 7 7 7',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 13l4 4L19 7',
  'double-check': 'M2 13l4 4L15 8m-3 9 2 2 9-9',
  alert: 'M12 8v5m0 3.5h.01M12 3l9 16H3z',
  info: 'M12 11v6m0-9.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  'user-plus': 'M15 20v-1.5c0-2-1.8-3.5-4-3.5s-4 1.5-4 3.5V20M11 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1v6m-3-3h6',
  users:
    'M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 1.5c-3 0-5.5 1.6-5.5 3.5V19h11v-2c0-1.9-2.5-3.5-5.5-3.5Zm7.5-1a3 3 0 1 0 0-6m1 7.2c1.8.5 3 1.7 3 3.1V19h-4',
  logout: 'M15 12H4m4-4-4 4 4 4m4-11h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4',
  retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  // —— v2 ——
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.8 0-7 1.8-7 4v2h14v-2c0-2.2-3.2-4-7-4Z',
  compass:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2.1 5.4-5.4 2.1 2.1-5.4z',
  image:
    'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-4.2 8.3 5-5 3.2 3.2 2.3-2.3 4.7 4.7',
  video:
    'M4 8.5A2.5 2.5 0 0 1 6.5 6h6A2.5 2.5 0 0 1 15 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 4 15.5zM15 10.5l5-3v9l-5-3z',
  play: 'M9 6.5 18 12l-9 5.5z',
  heart:
    'M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 3.1C19.5 15.4 12 20 12 20Z',
  'heart-filled':
    'M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 3.1C19.5 15.4 12 20 12 20Z',
  comment:
    'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-5 4z',
  palette:
    'M12 21a9 9 0 1 1 0-18c5 0 9 3.6 9 8 0 2.2-1.8 4-4 4h-2.2a1.8 1.8 0 0 0-1.3 3.1A1.8 1.8 0 0 1 12 21Zm-4.5-8h.01M9 8.5h.01M14 7.5h.01M17 10.5h.01',
  shield: 'M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6zM9 12l2.2 2.2L15.5 10',
  reply: 'M9 7 4 12l5 5M4 12h8.5c4 0 7.5 3 7.5 7',
  undo: 'M4 9h9a5 5 0 1 1 0 10H8M4 9l4-4M4 9l4 4',
  'expand-more': 'M6 9.5 12 15.5l6-6',
  drag: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 19h14',
  share: 'M14 7V4l7 6-7 6v-3M4 20v-3a5 5 0 0 1 5-5h5',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- heart-filled 是唯一实心图标：fill=currentColor 才看得出「已点赞」 -->
    <path
      :d="paths[name]"
      :fill="name === 'heart-filled' ? 'currentColor' : 'none'"
    />
  </svg>
</template>
