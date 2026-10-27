<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router'
import { computed, watch } from 'vue'
import AppToaster from '@/components/base/AppToaster.vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const isBlank = computed(() => route.meta['layout'] === 'blank')

/**
 * 身份失效 → 立刻离开受保护页面。
 *
 * 【为什么不能只靠路由守卫】守卫只在**导航发生时**才跑。会话被服务端撤销
 * （或 WS 推来 401、或用户在另一个标签页注销）不会触发任何导航，于是页面
 * 原地不动：URL 还停在 /chat/chat/:id，消息还渲染着。pm 的公网实测正是
 * 这个现象 —— 隐私内容在注销后仍然可见。
 *
 * 这里 watch 认证状态本身，一旦变为未认证就强制跳转，与触发原因无关
 * （主动注销、会话失效、token 过期，都走同一条路径）。
 *
 * replace 而不是 push：失效页面不该留在历史里被「后退」回去。
 */
watch(
  () => auth.isAuthenticated,
  (ok) => {
    if (ok) return
    if (route.meta['public'] === true) return
    void router.replace({ name: 'login', query: { next: route.fullPath } })
  },
)
</script>

<template>
  <RouterView v-slot="{ Component }">
    <component :is="Component" :class="isBlank ? 'layout-blank' : 'layout-app'" />
  </RouterView>
  <AppToaster />
</template>

<style scoped>
.layout-app {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: var(--app-bg);
}

/*
 * 空白布局（登录/注册/404）是全站第一印象。这里不铺平涂色，而是
 * 「一层极淡的横向渐变底 + 两团离屏柔光」，让大面积留白有方向感；
 * 具体页面各自再叠内容（登录页左侧的品牌面板）。
 * 柔光用 fixed 定位的伪元素，不会引入滚动条或横向溢出。
 */
.layout-blank {
  position: relative;
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  background: var(--app-bg);
  isolation: isolate;
}

.layout-blank::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: var(--app-ambient);
}
</style>
