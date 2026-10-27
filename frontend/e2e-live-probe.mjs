/**
 * 线上产物核查：直接对公网站点做一次浏览器探测，确认线上跑的到底是哪一版前端。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 打开 http://mikuyun.xyz/chat/，登录探针账号，记录：
 *   - index.html 实际引用的入口 chunk 文件名（线上到底部署了哪次构建）
 *   - 页面发出的所有 HTTP 请求中，是否有打到 /api/v1/presence 的（= 旧版特征）
 *   - MessagePane 深链是否渲染出气泡（= 修复是否生效）
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   环境变量 BASE   默认 http://mikuyun.xyz/chat
 *   环境变量 PROBE_PASS  探针账号密码（不写死在文件里）
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项结论 + 原始证据（chunk 名、请求列表）
 *   不写任何文件，无副作用（只做 GET + 一次登录 POST + 一次深链导航）
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   仅一次登录（服务端会记录一条认证会话）。不发消息、不改数据。
 */

import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://mikuyun.xyz/chat'
const PASS = process.env.PROBE_PASS
const USER = 'qja_probe'

if (!PASS) {
  console.error('缺少 PROBE_PASS 环境变量')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeoutMs = 15_000, stepMs = 250) {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await sleep(stepMs)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const requests = []
page.on('request', (r) => requests.push(r.url()))

console.log(`\n=== 线上产物核查  BASE=${BASE} ===\n`)

// 1. 入口 chunk 名
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
const entry = await page.evaluate(() =>
  [...document.querySelectorAll('script[src],link[href]')].map((e) => e.getAttribute('src') ?? e.getAttribute('href')),
)
console.log('入口 HTML 引用的资源：')
for (const e of entry) console.log(`  ${e}`)

// 2. 登录
await page.waitForSelector('.field__input', { timeout: 15_000 })
const inputs = page.locator('.field__input')
await inputs.nth(0).fill(USER)
await inputs.nth(1).fill(PASS)
await page.locator('.btn').first().click()
const loggedIn = await until(async () => page.url().includes('/chat') && !page.url().includes('/login'))
console.log(`\n登录：${loggedIn ? '成功' : '失败'}  url=${page.url()}`)

if (!loggedIn) {
  const err = await page.locator('.field__error').allInnerTexts().catch(() => [])
  console.log(`  页内错误：${err.filter(Boolean).join(' / ') || '（无）'}`)
}

// 3. 静置，收集首屏所有请求
await sleep(4000)

const presenceCalls = requests.filter((u) => u.includes('/presence'))
console.log(`\n是否探测 /api/v1/presence（旧版特征）：${presenceCalls.length ? '★ 是 —— ' + presenceCalls.join(', ') : '否（已是修复版）'}`)

// 4. 深链验证
const convs = await page.evaluate(async (base) => {
  const t = localStorage.getItem('aitrance.session') ?? ''
  const r = await fetch(`${base}/api/v1/conversations?limit=50&offset=0`, {
    headers: { Authorization: `Bearer ${t}` },
  })
  return (await r.json()).items ?? []
}, BASE)

const target = convs.find((c) => c.lastMessage) ?? convs[0]
console.log(`会话数=${convs.length}${target ? `，深链目标=${target.id}` : ''}`)

if (target) {
  const cold = await ctx.newPage()
  await cold.goto(`${BASE}/chat/${target.id}`, { waitUntil: 'domcontentloaded' })
  const ok = await until(async () => (await cold.locator('.bubble').count()) > 0, 20_000)
  const n = await cold.locator('.bubble').count()
  const blank = await cold.locator('.pane__blank').count()
  console.log(`\n冷启动深链：bubble 数=${n}  空态占位=${blank}  → ${ok ? '★ 修复生效' : '★ 仍是坏的（气泡为空）'}`)
}

await browser.close()
console.log('')
