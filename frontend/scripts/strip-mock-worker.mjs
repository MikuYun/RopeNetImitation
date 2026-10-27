/**
 * 从生产产物里移除 MSW 的 service worker 脚本。
 *
 * 背景：`msw init public` 会把 mockServiceWorker.js 放进 public/，Vite 会原样
 * 拷进 dist/。生产环境 VITE_USE_MOCK=false，前端代码里已经不会 import msw
 * （已 tree-shake），但 public/ 是静态资源目录，构建不会自动清理。
 *
 * 这是构建流程的收尾步骤，不触碰源码。见 docs/06-dev-setup.md 的交付检查项。
 */
import { existsSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distDir = resolve(process.cwd(), 'dist')

if (!existsSync(distDir)) {
  console.error('[strip-mock-worker] dist/ 不存在，请先执行 vite build')
  process.exit(1)
}

/* 1) 删除 service worker 脚本 */
const worker = join(distDir, 'mockServiceWorker.js')
if (existsSync(worker)) {
  rmSync(worker)
  console.log('[strip-mock-worker] 已删除 dist/mockServiceWorker.js')
} else {
  console.log('[strip-mock-worker] dist/mockServiceWorker.js 不存在，跳过')
}

/* 2) 断言产物中不含 msw 引用 —— 门禁，而不是提醒 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const offenders = []
for (const file of walk(distDir)) {
  if (!/\.(js|mjs|css|html)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  // 匹配 msw 包标识或 service worker 注册路径
  if (/\bmsw\b|mockServiceWorker/.test(text)) {
    offenders.push(file.replace(distDir + '\\', '').replace(distDir + '/', ''))
  }
}

if (offenders.length > 0) {
  console.error('[strip-mock-worker] 生产产物中仍存在 mock 引用，构建失败：')
  for (const f of offenders) console.error('  - ' + f)
  console.error('请检查 VITE_USE_MOCK 是否为 false，以及是否有代码静态 import 了 mocks/。')
  process.exit(1)
}

console.log('[strip-mock-worker] 校验通过：生产产物中无 mock 代码')
