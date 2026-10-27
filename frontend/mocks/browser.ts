/**
 * MSW 启动器（浏览器侧）。
 *
 * 只在 VITE_USE_MOCK === 'true' 时被 main.ts 动态 import，
 * 因此生产构建中整个 mocks 目录会被 tree-shake 掉。
 */
import { setupWorker } from 'msw/browser'
import { handlers } from './rest/handlers'

export const worker = setupWorker(...handlers)

export async function startMocking(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: false,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })
  console.info('[mock] MSW 已启动 —— 当前不依赖任何后端进程')
}
