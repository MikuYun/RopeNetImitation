import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { canAccessAdmin } from '@/stores/admin'
import { countRouteChange } from '@/composables/useBackNavigation'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, layout: 'blank' },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { public: true, layout: 'blank' },
    },
    {
      path: '/',
      redirect: '/chat',
    },
    {
      path: '/chat',
      component: () => import('@/views/ChatView.vue'),
      children: [
        { path: '', name: 'chat-empty', component: () => import('@/views/ChatEmptyView.vue') },
        // 注意顺序：静态段（'new' / 'profile' / 'admin'）必须声明在 ':convId'
        // 之前，否则 vue-router 会把它们当成 convId 去匹配 —— 症状是打开
        // /chat/profile 时右侧渲染 MessagePane 并去拉一个叫 "profile" 的会话。
        { path: 'new', name: 'new-friend', component: () => import('@/views/NewFriendView.vue') },
        // ux2-contract §十四-2/4：个人资料页与管理后台都挂在 ChatView 下，
        // 这样它们自动继承 layout-app 外壳（三栏）与登录守卫；
        // 作为顶层路由的话会拿到 layout-blank，变成一张脱离外壳的孤页。
        {
          path: 'profile',
          name: 'profile',
          component: () => import('@/views/ProfileView.vue'),
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('@/views/AdminView.vue'),
          // adminOnly 是全局守卫的判据；beforeEnter 是第二道（进入该路由即裁决）。
          // 两层都保留：beforeEnter 在懒加载组件之前就能拦下，全局守卫兜住
          // 「meta 声明但漏写 beforeEnter」的将来新增路由。
          meta: { adminOnly: true },
          beforeEnter: () => {
            const auth = useAuthStore()
            return canAccessAdmin(auth.user?.role) ? true : { name: 'chat-empty' }
          },
        },
        {
          path: ':convId',
          name: 'chat',
          component: () => import('@/views/MessagePane.vue'),
          props: true,
        },
        {
          path: ':convId/info',
          name: 'conversation-info',
          component: () => import('@/views/ConversationInfoView.vue'),
          props: true,
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { public: true, layout: 'blank' },
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // 冷启动只校验一次
  await auth.bootstrap()

  const isPublic = to.meta['public'] === true

  if (!isPublic && !auth.isAuthenticated) {
    return { name: 'login', query: { next: to.fullPath } }
  }

  if (isPublic && auth.isAuthenticated && (to.name === 'login' || to.name === 'register')) {
    return { name: 'chat-empty' }
  }

  // 管理后台：非管理员一律回会话列表（ux2-contract §十四-4）。
  // 这里与路由上的 beforeEnter 是两层：beforeEnter 在「进入该路由」时生效，
  // 全局守卫还能拦住「已登录用户从别处导航过来」以及未来可能新增的 admin 子路由。
  // 判定逻辑收敛在 stores/admin.ts 的 canAccessAdmin 里并有单测。
  // 注意 bootstrap 之后 auth.user 才可靠 —— 上面已经 await 过，此处可以直判。
  if (to.meta['adminOnly'] === true && !canAccessAdmin(auth.user?.role)) {
    return { name: 'chat-empty' }
  }

  return true
})

// 记录站内导航次数，供返回按钮判断「是否真的可以 back()」。
// 见 composables/useBackNavigation.ts 的说明。
router.afterEach(() => {
  countRouteChange()
})

export default router
