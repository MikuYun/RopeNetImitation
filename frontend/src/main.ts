import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { registerWsHandlers } from './ws/handlers'
import { useUiStore } from './stores/ui'
import './styles/main.css'

async function enableMocking(): Promise<void> {
  // 用点号访问，让 Vite 在构建期把 import.meta.env.VITE_USE_MOCK 替换成字面量，
  // 从而让生产构建把整个 mocks 目录（含 msw）tree-shake 掉。
  // 写成 import.meta.env['VITE_USE_MOCK'] 会保留动态 import 的分包，生产产物里
  // 会留下 400KB+ 的 mock 代码。
  //
  // 注意：生产构建里这个分支恒为 false，故 Vite 会告警「动态 import 不会被
  // 代码分割」。这是预期行为（该 import 在 dev 下才可能执行），不是缺陷。
  if (import.meta.env.VITE_USE_MOCK !== 'true') return
  const { startMocking } = await import('../mocks/browser')
  await startMocking()
}

async function bootstrap(): Promise<void> {
  await enableMocking()

  const app = createApp(App)
  app.use(createPinia())
  app.use(router)

  // 主题必须在挂载前落到 <html>，避免首帧闪白
  useUiStore().applyTheme()

  registerWsHandlers()

  app.mount('#app')
}

void bootstrap()
