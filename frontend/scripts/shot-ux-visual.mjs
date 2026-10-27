/**
 * 视觉验收截图脚本（UX-A 视觉设计系统 / task-5）。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 用 Playwright + **真实 Chrome**（channel: 'chrome'，本机未下载 playwright
 * 自带 chromium，故不能 headless shell 默认通道）截取认证页、会话列表、
 * 消息页、空态、404、弹层、toast 以及亮/暗 × 桌面/手机共 16 张图，
 * 供人工目检「界面是否好看」。
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   环境变量 BASE     默认 http://localhost:5173
 *   环境变量 BACKEND  默认 http://127.0.0.1:3099（隔离测试后端，非生产）
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   ../docs/evidence/ux-visual-*.png（即 B:\AITrance\docs\evidence\）
 *   stdout：每张图一行 `SHOT <name>  <path>`
 *
 * ── 副作用（重要）─────────────────────────────────────────────────
 *   1. 只在**隔离测试后端** 3099 上注册 e2e_a / e2e_b 两个测试账号，
 *      并把它们加为好友、建一个私聊、补几条示例消息。**不碰生产库。**
 *   2. 只写截图文件，不改任何源码、不改配置、不重启服务。
 *   3. 不访问 mikuyun.xyz 等任何生产域名。
 *
 * ── 为什么不用 UI 登录 ────────────────────────────────────────────
 *   后端对登录限流 10 次/分/IP，本脚本要开十来个上下文。这里统一走
 *   POST /api/v1/auth/login 拿 token 后 addInitScript 注入 localStorage，
 *   令牌按账号缓存，全程每个账号只登录一次。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../../docs/evidence')

const PASSWORD = 'E2ePass!2345'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const shots = []

/** 等聊天主界面出现；失败时把 url、localStorage 与最近的控制台错误打出来。 */
async function waitChat(page, tag) {
  try {
    await page.waitForSelector('.list, .panel', { timeout: 15_000 })
  } catch (e) {
    const info = await page.evaluate(() => ({
      url: location.href,
      ls: Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith('aitrance.'))
          .map((k) => [k, String(localStorage.getItem(k)).slice(0, 24)]),
      ),
      text: (document.body.innerText || '').slice(0, 200),
    }))
    console.error(`\n!! ${tag} 未进入聊天界面`, JSON.stringify(info, null, 2))
    console.error('最近控制台输出：\n' + (page.__logs ?? []).slice(-20).join('\n'))
    throw e
  }
}

/** 记录页面控制台与失败请求，便于排查「为什么没进聊天界面」。 */
function watch(page) {
  page.__logs = []
  page.on('console', (m) => page.__logs.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => page.__logs.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', (r) =>
    page.__logs.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`),
  )
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) {
      page.__logs.push(`[http ${r.status()}] ${r.request().method()} ${r.url()}`)
    }
  })
}

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true })
  const path = resolve(SHOT_DIR, `ux-visual-${name}.png`)
  await page.screenshot({ path })
  shots.push({ name, path })
  console.log(`SHOT ${name}  ${path}`)
}

async function ensureUser(username, displayName) {
  const r = await fetch(`${BACKEND}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, displayName }),
  })
  return r.status
}

const tokenCache = new Map()

async function creds(username) {
  let c = tokenCache.get(username)
  if (!c) {
    const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    })
    if (!r.ok) throw new Error(`登录失败 ${username}: ${r.status}`)
    const j = await r.json()
    c = { token: j.token, expiresAt: j.expiresAt, userId: j.user?.id }
    tokenCache.set(username, c)
  }
  return c
}

/** 注入登录态 + 主题偏好（在页面脚本执行前跑，避免首帧闪烁）。 */
async function prime(page, username, theme = 'light') {
  const c = await creds(username)
  await page.addInitScript(
    ([t, e, th]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
      localStorage.setItem('aitrance.theme', th)
    },
    [c.token, c.expiresAt, theme],
  )
  return c
}

/** 匿名访问认证页：清掉登录态，写主题偏好。 */
async function primeAnonymous(page, theme = 'light') {
  await page.addInitScript((th) => {
    localStorage.removeItem('aitrance.session')
    localStorage.removeItem('aitrance.sessionExpiresAt')
    localStorage.setItem('aitrance.theme', th)
  }, theme)
}

/* ── 数据铺垫：A↔B 好友 + 私聊 + 若干消息 ─────────────────────────── */

const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

async function seedConversation() {
  const A = await creds('e2e_a')
  const B = await creds('e2e_b')

  const listA = await (
    await fetch(`${BACKEND}/api/v1/conversations?limit=50&offset=0`, { headers: H(A.token) })
  ).json()
  let conv = (listA.items ?? []).find((c) => c.peer?.username === 'e2e_b')

  if (!conv) {
    const search = await (await fetch(`${BACKEND}/api/v1/users?q=e2e_b`, { headers: H(A.token) })).json()
    const target = (search.items ?? [])[0]
    if (!target) return null
    await fetch(`${BACKEND}/api/v1/friend-requests`, {
      method: 'POST',
      headers: H(A.token),
      body: JSON.stringify({ userId: target.id, note: '视觉验收' }),
    })
    const reqs = await (await fetch(`${BACKEND}/api/v1/friend-requests`, { headers: H(B.token) })).json()
    const incoming = (reqs.items ?? []).find(
      (r) => r.sender?.username === 'e2e_a' && r.status === 'pending',
    )
    if (incoming) {
      await fetch(`${BACKEND}/api/v1/friend-requests/${incoming.id}/respond`, {
        method: 'POST',
        headers: H(B.token),
        body: JSON.stringify({ action: 'accept' }),
      })
    }
    conv = await (
      await fetch(`${BACKEND}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: H(A.token),
        body: JSON.stringify({ userId: target.id }),
      })
    ).json()
  }

  if (!conv?.id) return null

  // 只在消息太少时补，重复跑脚本不会把气泡堆成瀑布
  const existing = await (
    await fetch(`${BACKEND}/api/v1/conversations/${conv.id}/messages?limit=50&offset=0`, {
      headers: H(A.token),
    })
  ).json()
  const have = (existing.items ?? []).length

  const lines = [
    { who: A, text: '在吗？刚把界面的视觉层整个重做了一版，你帮我看看还有哪里寡淡。' },
    { who: B, text: '在的。这次主色方向没变吧？' },
    { who: A, text: '没变，还是青蓝往青绿走。但令牌层拆成了色阶 / 度量 / 语义三段，组件里不再有裸 hex。' },
    { who: B, text: '那深色模式呢，别又是简单反个色。' },
    { who: A, text: '深色是重新配平的：面逐层提亮 4–6 个明度点，投影换纯黑加不透明度。' },
    { who: B, text: '听起来靠谱。\n多行文本也顺便验一下换行。' },
  ]

  for (let i = have; i < lines.length; i += 1) {
    await fetch(`${BACKEND}/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: H(lines[i].who.token),
      body: JSON.stringify({
        clientMsgId: crypto.randomUUID(),
        type: 'text',
        content: lines[i].text,
      }),
    })
    await sleep(60)
  }

  return conv.id
}

/* ── 主流程 ──────────────────────────────────────────────────────── */

async function main() {
  console.log(`\n=== 视觉验收截图  BASE=${BASE}  BACKEND=${BACKEND} ===\n`)

  // 先确认后端与前端都活着，免得截出一堆白屏还以为是「设计成这样」
  const health = await (await fetch(`${BACKEND}/api/v1/health`)).json()
  console.log(`后端健康：${health.status} v${health.version}`)
  const page0 = await fetch(`${BASE}/login`)
  console.log(`前端 /login：HTTP ${page0.status}\n`)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  console.log(
    `账号准备：e2e_a=${await ensureUser('e2e_a', 'A 先生')} e2e_b=${await ensureUser('e2e_b', 'B 女士')}（201=新建 409=已存在）`,
  )
  const convId = await seedConversation()
  console.log(`会话数据：${convId ? `convId=${convId}` : '★ 未建成，消息页/列表截图会退化为空态'}\n`)

  const ctxDesktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  })

  /* ── 1. 认证页 · 亮色桌面 ─────────────────────────────────────── */
  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await primeAnonymous(page, 'light')
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.auth__form', { timeout: 15_000 })
    await sleep(400)
    await shot(page, '01-login-light-1440x900')
    await page.close()
  }

  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await primeAnonymous(page, 'light')
    await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.auth__form', { timeout: 15_000 })
    await sleep(400)
    await shot(page, '02-register-light-1440x900')
    await page.close()
  }

  /* ── 2. 会话列表 / 空态 / 消息页 · 亮色桌面 ────────────────────── */
  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await prime(page, 'e2e_a', 'light')
    await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' })
    await waitChat(page, 'desktop-chat')
    await sleep(800)
    await shot(page, '03-chat-empty-light-1440x900')

    if (convId) {
      await page.goto(`${BASE}/chat/${convId}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.pane__scroll', { timeout: 15_000 })
      await sleep(900)
      await shot(page, '04-chat-pane-light-1440x900')

      // 弹层（发起群聊）：验 scale+fade 进场与面板质感
      const trigger = page.locator('.list__add').first()
      if (await trigger.count()) {
        await trigger.click()
        await page.waitForSelector('.mask .panel', { timeout: 10_000 })
        await sleep(600)
        await shot(page, '05-modal-light-1440x900')
        await page.keyboard.press('Escape')
        await sleep(500)
      }

      // toast：触发一次错误提示（点开一个不存在的会话 → 后端 404 → toast）
      await page.goto(`${BASE}/chat/does-not-exist-ux-visual`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.toast', { timeout: 10_000 }).catch(() => {})
      await sleep(350)
      if (await page.locator('.toast').count()) await shot(page, '06-toast-light-1440x900')
    }
    await page.close()
  }

  /* ── 3. 404 · 亮色桌面（保持匿名，避免被守卫重定向）───────────── */
  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await primeAnonymous(page, 'light')
    await page.goto(`${BASE}/no-such-page-ux-visual`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.nf', { timeout: 15_000 })
    await sleep(500)
    await shot(page, '07-404-light-1440x900')
    await page.close()
  }

  /* ── 4. 深色 · 桌面两张（认证页 + 会话页）────────────────────── */
  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await primeAnonymous(page, 'dark')
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.auth__form', { timeout: 15_000 })
    await sleep(400)
    await shot(page, '08-login-dark-1440x900')
    await page.close()
  }

  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await prime(page, 'e2e_a', 'dark')
    const target = convId ? `${BASE}/chat/${convId}` : `${BASE}/chat`
    await page.goto(target, { waitUntil: 'networkidle' })
    await waitChat(page, 'desktop-chat')
    await sleep(900)
    await shot(page, '09-chat-dark-1440x900')
    await page.close()
  }

  {
    const page = await ctxDesktop.newPage()
    watch(page)
    await primeAnonymous(page, 'dark')
    await page.goto(`${BASE}/no-such-page-ux-visual`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.nf', { timeout: 15_000 })
    await sleep(500)
    await shot(page, '10-404-dark-1440x900')
    await page.close()
  }

  await ctxDesktop.close()

  /* ── 5. 手机 390x844 两张 ─────────────────────────────────────── */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })

    const login = await ctx.newPage()
    watch(login)
    await primeAnonymous(login, 'light')
    await login.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await login.waitForSelector('.auth__form', { timeout: 15_000 })
    await sleep(400)
    await shot(login, '11-login-mobile-390x844')
    await login.close()

    const page = await ctx.newPage()
    watch(page)
    await prime(page, 'e2e_a', 'light')
    await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' })
    await waitChat(page, 'desktop-chat')
    await sleep(800)
    await shot(page, '12-chat-list-mobile-390x844')

    // 顺手验一下手机端是否横向溢出（视觉脚本也当一次烟测）
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      viewW: window.innerWidth,
    }))
    console.log(
      `\n390x844 横向：doc=${m.docW} view=${m.viewW} ${m.docW <= m.viewW + 1 ? 'OK' : '★ 横向溢出'}`,
    )
    await page.close()
    await ctx.close()
  }

  /* ── 6. 最窄 320x568 一张 ─────────────────────────────────────── */
  {
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 568 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    watch(page)
    await prime(page, 'e2e_a', 'light')
    await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' })
    await waitChat(page, 'desktop-chat')
    await sleep(800)
    await shot(page, '13-chat-list-mobile-320x568')
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      viewW: window.innerWidth,
    }))
    console.log(`320x568 横向：doc=${m.docW} view=${m.viewW} ${m.docW <= m.viewW + 1 ? 'OK' : '★ 横向溢出'}`)
    await page.close()
    await ctx.close()
  }

  /* ── 7. 兜底：320 宽认证页（最窄下双栏必须叠成单列）───────────── */
  {
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 568 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    watch(page)
    await primeAnonymous(page, 'light')
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.auth__form', { timeout: 15_000 })
    await sleep(400)
    await shot(page, '14-login-mobile-320x568')
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      viewW: window.innerWidth,
    }))
    console.log(`320 认证页横向：doc=${m.docW} view=${m.viewW} ${m.docW <= m.viewW + 1 ? 'OK' : '★ 横向溢出'}`)
    await page.close()
    await ctx.close()
  }

  await browser.close()

  console.log(`\n=== 共 ${shots.length} 张截图 → ${SHOT_DIR} ===`)
  for (const s of shots) console.log(`  ${s.name}`)
}

main().catch((e) => {
  console.error('\n!! 截图脚本失败：', e)
  process.exit(1)
})
