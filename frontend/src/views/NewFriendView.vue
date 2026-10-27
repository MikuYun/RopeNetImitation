<script setup lang="ts">
/**
 * 「新的朋友」路由。
 *
 * 【为什么不在这里渲染 ContactPanel】联系人面板由 ChatView 统一渲染
 * （桌面：`v-show="ui.railTab === 'contacts'"`；手机：`isContactsScreen`）。
 * 早期这里自己也渲染了一个 ContactPanel，于是桌面端访问 /chat/new 时
 * 会同时出现两块联系人面板。本组件只负责右侧内容区（桌面）或空占位。
 *
 * 手机上本组件不会渲染 —— ChatView 在手机端只对「正文屏」渲染 RouterView，
 * 联系人屏直接由它自己渲染 ContactPanel。
 */
import AppEmpty from '@/components/base/AppEmpty.vue'
</script>

<template>
  <section class="new-friend">
    <AppEmpty
      icon="contact"
      title="添加好友"
      description="在左侧联系人面板搜索用户名，或处理收到的好友申请"
    />
  </section>
</template>

<style scoped>
.new-friend {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  background: var(--chat-canvas);
}
</style>
