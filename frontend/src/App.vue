<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router'
import { computed, onUnmounted, watch } from 'vue'
import AppContextMenu from '@/components/base/AppContextMenu.vue'
import AppToaster from '@/components/base/AppToaster.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { copyTextToClipboard, shouldKeepNativeMenu, type ContextMenuItem } from '@/utils/contextMenu'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()

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

/* ============================================================================
 * 项目自有右键菜单
 * ----------------------------------------------------------------------------
 * 用户报的问题：PC 端在页面里右键，弹出的是浏览器菜单（「查看网页源代码」
 * 「检查」「另存为」…），完全找不到本项目操作。这里接管全局右键，换成项目
 * 自己的菜单。
 *
 * 【三条必须放行的例外】
 *  1. 输入框 / textarea / 富文本里一律放行原生菜单 —— 否则用户没法「粘贴」，
 *     拼写检查也一起没了。这是功能损失，比「菜单不统一」严重得多。
 *  2. `Shift + 右键` 放行原生菜单 —— 开发调试、以及「我就想要浏览器那个另存为」
 *     的高级用户需要一条逃生通道。
 *  3. 子组件已经处理过的（`defaultPrevented`）不再接管 —— 图片、消息气泡会
 *     自己 `@contextmenu.stop.prevent` 弹它们专属的菜单项，全局处理器必须让位。
 *
 * 【为什么监听 window 而不是根元素】聊天页/个人页/404 的根节点各不相同，
 * 挂在 window 上才能覆盖所有路由；同时 `contextmenu` 在 window 上能被
 * capture 阶段的菜单组件先看到（用于「右键别处 = 移动菜单」）。
 * ========================================================================== */

/** 从右键位置向上找最近的可滚动容器（「回到顶部」滚的就是它）。 */
function findScrollableAncestor(target: EventTarget | null): HTMLElement | null {
  let node: HTMLElement | null = target instanceof HTMLElement ? target : null
  while (node) {
    const style = window.getComputedStyle(node)
    const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (scrollable && node.scrollHeight > node.clientHeight + 4) return node
    node = node.parentElement
  }
  const root = document.scrollingElement
  return root instanceof HTMLElement ? root : null
}

/**
 * 项目级默认菜单项。
 *
 * @param scrollTarget 「回到顶部」要滚的容器；缺省时滚整页。
 *        只有一处非默认入口（图片/消息有自己的菜单），所以不额外造一套注册表。
 */
function defaultMenuItems(scrollTarget: HTMLElement | null = null): ContextMenuItem[] {
  const canScroll = scrollTarget !== null && scrollTarget.scrollTop > 2
  return [
    {
      id: 'refresh',
      label: '刷新页面',
      hint: 'F5',
      run: () => {
        window.location.reload()
      },
    },
    {
      id: 'copy-link',
      label: '复制页面链接',
      run: async () => {
        const ok = await copyTextToClipboard(window.location.href)
        ui.toast(ok ? '页面链接已复制' : '复制失败，请手动复制地址栏', ok ? 'success' : 'error')
      },
    },
    {
      id: 'top',
      label: '回到顶部',
      // 已经在顶部时禁用而不是隐藏：位置固定、菜单高度不跳，
      // 用户也能看出「这里本来就有这个功能」。
      disabled: !canScroll,
      run: () => {
        scrollTarget?.scrollTo({ top: 0, behavior: 'smooth' })
      },
    },
    {
      id: 'theme',
      label: '切换深浅色',
      hint: ui.themeMode === 'dark' ? '当前深色' : '当前浅色',
      run: () => {
        ui.toggleTheme()
      },
    },
  ]
}

function onGlobalContextMenu(e: MouseEvent): void {
  if (e.defaultPrevented) return // 子组件已经处理
  if (e.shiftKey) return // 逃生通道：Shift + 右键 = 浏览器原生菜单
  if (shouldKeepNativeMenu(e.target)) return
  e.preventDefault()
  ui.openContextMenu(e.clientX, e.clientY, defaultMenuItems(findScrollableAncestor(e.target)))
}

window.addEventListener('contextmenu', onGlobalContextMenu)

onUnmounted(() => {
  window.removeEventListener('contextmenu', onGlobalContextMenu)
})
</script>

<template>
  <RouterView v-slot="{ Component }">
    <component :is="Component" :class="isBlank ? 'layout-blank' : 'layout-app'" />
  </RouterView>
  <AppToaster />
  <AppContextMenu />
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
