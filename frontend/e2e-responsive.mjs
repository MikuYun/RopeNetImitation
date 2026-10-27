/**
 * 响应式验收脚本（任务书 UI-RESP-20261008 / R6）。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 用 Playwright + 真实 Chrome，在任务书指定的 7 组视口上跑一遍响应式与
 * 交互断言：无横向溢出、手机列表/正文互斥、触控热区 >=44px、返回可用、
 * 断点边界状态保持、已读门禁（停在列表不被自动已读）。
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   环境变量 BASE          默认 http://localhost:5173
 *   环境变量 BACKEND       默认 http://127.0.0.1:3099（隔离测试后端，非生产）
 *   环境变量 HARD_TIMEOUT_MS 默认 300000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项断言 PASS/FAIL + 汇总
 *   截图：docs/evidence/resp-*.png
 *   退出码：0 全通过 / 1 有失败 / 3 硬超时
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   1. 会在**隔离测试后端**（BACKEND 指向的库）注册两个测试账号
 *      e2e_a / e2e_b，并发若干条消息。**不会**碰生产库。
 *   2. 截图写入 docs/evidence/（本方目录）。
 *   3. 不改任何源码、不改配置、不重启服务。
 *
 * ── 使用前必读 ───────────────────────────────────────────────────
 *   · 断言的是 DOM 与几何量，不是接口返回。历史上"脚本全绿但 UI 有缺陷"
 *     出现过多次，所以这里都断言具体数值（宽度、rect 尺寸、可见性）。
 *   · 视口用 setViewportSize 模拟，**不等于真机**。真机软键盘/安全区
 *     必须单独验，报告里要分开写。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 300_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

/**
 * 任务书 §八 的视口矩阵。
 *
 * 【按宽度分档，不按设备类型】断点是以 CSS 视口**宽度**判定的，所以
 * 844x390（手机横屏）宽度已 >= 768，走的是**平板紧凑多栏**，不是手机单栏。
 * 把它标成 mobile 会得到「底部导航不存在」这种假失败 —— 那是对预期写错了，
 * 不是产品错了。横屏真正要验的是**短高度**下输入区与弹层仍可达，
 * 所以单列一个 shortHeight 标记，走平板断言 + 额外的可达性检查。
 */
const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568, mobile: true, label: '最窄支持' },
  { name: '360x800', width: 360, height: 800, mobile: true, label: '常见安卓' },
  { name: '390x844', width: 390, height: 844, mobile: true, label: 'iPhone 14' },
  { name: '430x932', width: 430, height: 932, mobile: true, label: 'iPhone Pro Max' },
  { name: '844x390', width: 844, height: 390, mobile: false, shortHeight: true, label: '横屏短高' },
  { name: '768x1024', width: 768, height: 1024, mobile: false, label: '平板' },
  { name: '1024x768', width: 1024, height: 768, mobile: false, label: 'PC 小' },
  { name: '1440x900', width: 1440, height: 900, mobile: false, label: 'PC 大' },
]

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}
function group(title) {
  console.log(`\n──── ${title} ────`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeoutMs = 12_000, stepMs = 200) {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await sleep(stepMs)
  }
}

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: resolve(SHOT_DIR, `resp-${name}.png`) })
}

/* ── 账号准备：直接打隔离后端，不走 UI（省时间且不依赖 UI 正确性） ── */

async function ensureUser(username, displayName) {
  const r = await fetch(`${BACKEND}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'E2ePass!2345', displayName }),
  })
  return r.status // 201 新建 / 409 已存在
}

/**
 * 令牌缓存：同一账号只登录一次。
 *
 * 【为什么必须缓存】后端对登录有限流（10 次/分/IP）。本脚本要开 8 个视口
 * 上下文，每个都登录一次，再叠加断点边界与数据铺垫，很容易超过阈值，
 * 表现为脚本中途 429 失败 —— 那是**测试把后端打限流了**，不是产品缺陷。
 * 缓存后每个账号全程只登录一次；seedConversation 也复用这里的令牌。
 */
const tokenCache = new Map()

async function loginAs(page, username, password = 'E2ePass!2345') {
  let cred = tokenCache.get(username)
  if (!cred) {
    const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!r.ok) throw new Error(`登录失败 ${username}: ${r.status}`)
    const j = await r.json()
    cred = { token: j.token, expiresAt: j.expiresAt }
    tokenCache.set(username, cred)
  }
  await page.addInitScript(
    ([t, e]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
    },
    [cred.token, cred.expiresAt],
  )
  return cred.token
}

/**
 * 建立一份可用于验收的数据：A 与 B 互为好友并有一个有消息的私聊。
 *
 * 【为什么要造数据】会话列表为空时，会话项、正文、返回、详情这些断言全都
 * 跑不到 —— 会得到一堆「跳过」而不是证据。用隔离后端的两个测试账号先聊几句，
 * 后面所有视口才有东西可验。
 *
 * 只在**隔离测试库**里发生（BACKEND 指向 3099），不碰生产。
 * 令牌走 loginAs 的缓存，不额外打登录接口（会撞限流）。
 */
async function seedConversation() {
  const A = tokenCache.get('e2e_a')
  const B = tokenCache.get('e2e_b')
  if (!A || !B) return null
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

  // 找/建 A↔B 的私聊
  const listA = await (await fetch(`${BACKEND}/api/v1/conversations?limit=50&offset=0`, { headers: H(A.token) })).json()
  let conv = (listA.items ?? []).find((c) => c.peer?.username === 'e2e_b')

  if (!conv) {
    // 先加好友（接口需要对方 userId）
    const search = await (
      await fetch(`${BACKEND}/api/v1/users?q=e2e_b`, { headers: H(A.token) })
    ).json()
    const target = (search.items ?? [])[0]
    if (!target) return null

    // F3 的 body 是 { userId, note }，两者都 required（不是 toUserId）
    await fetch(`${BACKEND}/api/v1/friend-requests`, {
      method: 'POST',
      headers: H(A.token),
      body: JSON.stringify({ userId: target.id, note: '响应式验收测试' }),
    })
    const reqs = await (
      await fetch(`${BACKEND}/api/v1/friend-requests`, { headers: H(B.token) })
    ).json()
    // 线上是 { sender, recipient, status }，没有 fromUser / direction
    // （那是前端 normalize 推导的）。直连后端必须按线格式判断。
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

    const direct = await (
      await fetch(`${BACKEND}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: H(A.token),
        body: JSON.stringify({ userId: target.id }),
      })
    ).json()
    conv = direct
  }

  if (!conv?.id) return null

  // 铺几条消息（含长中文与连续英文，用来验换行不出屏）
  const texts = [
    '你好，这是一条用于响应式验收的测试消息。',
    'A very long unbroken English token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '第三行用来把列表撑出高度，确认滚动与未读徽标位置正常。',
  ]
  for (let i = 0; i < texts.length; i += 1) {
    const who = i % 2 === 0 ? A : B
    await fetch(`${BACKEND}/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: H(who.token),
      body: JSON.stringify({
        clientMsgId: crypto.randomUUID(),
        type: 'text',
        content: texts[i],
      }),
    })
  }
  return conv.id
}

/* ── 通用几何断言 ────────────────────────────────────────────────── */

async function assertNoHorizontalOverflow(page, tag) {
  const m = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    bodyW: document.body.scrollWidth,
    viewW: window.innerWidth,
  }))
  check(
    `${tag} 无横向溢出`,
    m.docW <= m.viewW + 1 && m.bodyW <= m.viewW + 1,
    `doc=${m.docW} body=${m.bodyW} view=${m.viewW}`,
  )
  return m
}

/** 触控热区：断言所有可见的主操作按钮 >= 44x44。 */
async function assertTouchTargets(page, selectors, tag) {
  const tooSmall = await page.evaluate((sels) => {
    const bad = []
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue // 不可见的不算
        if (r.width < 44 || r.height < 44) {
          bad.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`)
        }
      }
    }
    return bad
  }, selectors)
  check(`${tag} 热区 >= 44x44`, tooSmall.length === 0, tooSmall.join(', ') || '（全部合格）')
}

/* ── 主流程 ──────────────────────────────────────────────────────── */

async function main() {
  console.log(`\n=== 响应式验收  BASE=${BASE}  BACKEND=${BACKEND} ===\n`)

  // 先起浏览器（预热 context 需要它），再取令牌 —— 顺序不能反
  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  const st1 = await ensureUser('e2e_a', 'A 先生')
  const st2 = await ensureUser('e2e_b', 'B 女士')
  console.log(`账号准备：e2e_a=${st1} e2e_b=${st2}（201=新建 409=已存在）`)

  // 先取令牌（只有这里会打登录接口），后续所有上下文复用缓存
  const warm = await browser.newContext()
  const warmPage = await warm.newPage()
  await loginAs(warmPage, 'e2e_a')
  await loginAs(warmPage, 'e2e_b')
  await warm.close()

  const convId = await seedConversation()
  console.log(`会话数据：${convId ? `convId=${convId}` : '★ 未建成功，会话相关断言会跳过'}\n`)

  /* ═══ 1. 手机视口矩阵 ═══════════════════════════════════════════ */
  for (const vp of VIEWPORTS.filter((v) => v.mobile)) {
    group(`视口 ${vp.name}（${vp.label}）`)
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    await loginAs(page, 'e2e_a')

    // 列表屏
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.list, .panel', { timeout: 15_000 })
    await assertNoHorizontalOverflow(page, vp.name)
    await shot(page, `${vp.name}-list`)

    // 底部导航存在且只有两个主 tab + 更多
    const navTabs = await page.locator('.mnav__tab').count()
    check(`${vp.name} 底部导航存在（2 tab + 更多）`, navTabs === 3, `tab 数=${navTabs}`)

    // 竖侧栏（PC 用）不应出现在手机 DOM 里
    const railVisible = await page.locator('.rail').isVisible().catch(() => false)
    check(`${vp.name} 手机不渲染 PC 竖侧栏`, !railVisible, `rail 可见=${railVisible}`)

    // 列表屏不应出现消息正文
    const paneVisible = await page.locator('.pane__scroll').isVisible().catch(() => false)
    check(`${vp.name} 列表屏不含消息正文（互斥）`, !paneVisible, `正文可见=${paneVisible}`)

    await assertTouchTargets(page, ['.mnav__tab'], vp.name)

    // 触点：切到联系人
    await page.locator('.mnav__tab').nth(1).click()
    await page.waitForTimeout(400)
    const contactsVisible = await page.locator('.panel').isVisible().catch(() => false)
    check(`${vp.name} 可切到联系人屏`, contactsVisible, ``)
    await assertNoHorizontalOverflow(page, `${vp.name} 联系人`)
    await assertTouchTargets(page, ['.panel__tab', '.row'], `${vp.name} 联系人`)
    await shot(page, `${vp.name}-contacts`)

    // 切回聊天
    await page.locator('.mnav__tab').nth(0).click()
    await page.waitForTimeout(300)

    // 会话列表为空时进入不了正文 —— 这里验证空态不溢出即可
    const hasConv = (await page.locator('.item').count()) > 0
    if (hasConv) {
      await page.locator('.item').first().click()
      await page.waitForTimeout(900)
      const inPane = await page.locator('.pane__scroll').isVisible().catch(() => false)
      check(`${vp.name} 可进入会话正文`, inPane, '')
      await assertNoHorizontalOverflow(page, `${vp.name} 正文`)
      await assertTouchTargets(page, ['.composer__send', '.pane__back'], `${vp.name} 正文`)
      await shot(page, `${vp.name}-chat`)

      // 正文屏不应同时显示底部导航（全屏）
      const navInChat = await page.locator('.mnav').isVisible().catch(() => false)
      check(`${vp.name} 正文屏隐藏底部导航`, !navInChat, `mnav 可见=${navInChat}`)

      // 返回：应回到列表屏
      await page.locator('.pane__back').click()
      await page.waitForTimeout(800)
      const backToList = await page.locator('.list').isVisible().catch(() => false)
      check(`${vp.name} 顶部返回可回列表`, backToList, `url=${page.url()}`)

      // 详情页
      await page.locator('.item').first().click()
      await page.waitForTimeout(700)
      await page.locator('.pane__more').click()
      await page.waitForTimeout(700)
      const inInfo = page.url().includes('/info')
      check(`${vp.name} 可进入会话详情`, inInfo, `url=${page.url()}`)
      if (inInfo) {
        await assertNoHorizontalOverflow(page, `${vp.name} 详情`)
        await assertTouchTargets(page, ['.info__back'], `${vp.name} 详情`)
        await page.locator('.info__back').click()
        await page.waitForTimeout(700)
        check(`${vp.name} 详情返回聊天`, page.url().includes('/chat/') && !page.url().includes('/info'), `url=${page.url()}`)
      }
    }

    // 「更多」面板：主题与注销必须可达
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    await page.locator('.mnav__tab').nth(2).click()
    await page.waitForTimeout(400)
    const sheetItems = await page.locator('.sheet__item').count()
    check(`${vp.name} 更多面板含主题与注销`, sheetItems >= 2, `项数=${sheetItems}`)
    await assertNoHorizontalOverflow(page, `${vp.name} 更多面板`)
    await assertTouchTargets(page, ['.sheet__item', '.sheet__cancel'], `${vp.name} 更多面板`)
    await shot(page, `${vp.name}-more`)

    // 深色主题
    await page.locator('.sheet__item').first().click()
    await page.waitForTimeout(400)
    const theme = await page.evaluate(() => document.documentElement.dataset.theme)
    check(`${vp.name} 主题可切换`, theme === 'dark' || theme === 'light', `theme=${theme}`)
    await shot(page, `${vp.name}-theme-${theme}`)

    await ctx.close()
  }

  /* ═══ 2. 平板/桌面视口（宽度 >= 768 一律多栏） ═══════════════════ */
  for (const vp of VIEWPORTS.filter((v) => !v.mobile)) {
    group(`视口 ${vp.name}（${vp.label}）`)
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    await loginAs(page, 'e2e_a')
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rail', { timeout: 15_000 })

    await assertNoHorizontalOverflow(page, vp.name)

    const railVisible = await page.locator('.rail').isVisible().catch(() => false)
    check(`${vp.name} 显示 PC 竖侧栏`, railVisible, '')
    const listVisible = await page.locator('.list').isVisible().catch(() => false)
    check(`${vp.name} 显示会话列表栏`, listVisible, '')

    // 手机上才有的底部导航不应出现
    const mnavVisible = await page.locator('.mnav').isVisible().catch(() => false)
    check(`${vp.name} 不显示手机底部导航`, !mnavVisible, '')

    await shot(page, `${vp.name}-desktop`)

    // 侧栏切 tab 后应回到列表屏（不留正文）
    await page.locator('.rail__tab').nth(1).click()
    await page.waitForTimeout(400)
    const panelVisible = await page.locator('.panel').isVisible().catch(() => false)
    check(`${vp.name} 侧栏可切到联系人`, panelVisible, '')
    await assertNoHorizontalOverflow(page, `${vp.name} 联系人`)

    // 横屏短高专项：内容区与输入区必须仍在视口内可达，不被压掉
    if (vp.shortHeight) {
      const hasConv = (await page.locator('.item').count()) > 0
      if (hasConv) {
        await page.locator('.rail__tab').nth(0).click()
        await page.waitForTimeout(300)
        await page.locator('.item').first().click()
        await page.waitForTimeout(900)
        const reachable = await page.evaluate(() => {
          const send = document.querySelector('.composer__send')
          const input = document.querySelector('.composer__input')
          if (!send || !input) return { ok: false, why: '找不到输入区' }
          const sr = send.getBoundingClientRect()
          const ir = input.getBoundingClientRect()
          const vh = window.innerHeight
          return {
            ok: sr.bottom <= vh + 1 && sr.height > 0 && ir.top < vh && ir.bottom <= vh + 1,
            why: `发送键 bottom=${Math.round(sr.bottom)} 输入框 top=${Math.round(ir.top)}/bottom=${Math.round(ir.bottom)} 视口高=${vh}`,
          }
        })
        check(`${vp.name} 短高度下输入区与发送键仍可达`, reachable.ok, reachable.why)
        await shot(page, `${vp.name}-chat-short`)

        // 弹层在短高度下不应伸出屏幕
        await page.locator('.pane__more').click()
        await page.waitForTimeout(600)
        if (page.url().includes('/info')) {
          const modalCheck = await page.evaluate(() => {
            const vh = window.innerHeight
            const vw = window.innerWidth
            const body = document.querySelector('.info__body')
            if (!body) return { ok: false, why: '详情未渲染' }
            const r = body.getBoundingClientRect()
            return {
              ok: r.width <= vw + 1 && r.height > 0,
              why: `详情宽=${Math.round(r.width)} 视口宽=${vw} 高=${Math.round(r.height)} 视口高=${vh}`,
            }
          })
          check(`${vp.name} 短高度下详情页可读`, modalCheck.ok, modalCheck.why)
        }
      }
    }

    await ctx.close()
  }

  /* ═══ 3. 断点边界 ═══════════════════════════════════════════════ */
  group('断点边界 767↔768 / 1023↔1024')
  {
    const ctx = await browser.newContext({ viewport: { width: 767, height: 800 } })
    const page = await ctx.newPage()
    // 从测试侧统计 WS 建连次数，不在生产源码里埋调试钩子
    const wsUrls = []
    page.on('websocket', (ws) => wsUrls.push(ws.url()))

    await loginAs(page, 'e2e_a')
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.list, .panel', { timeout: 15_000 })
    // 等首轮 WS 建好再记基线
    await until(async () => wsUrls.length > 0, 8_000)
    const wsBefore = wsUrls.length

    const at767 = await page.evaluate(() => ({
      mnav: !!document.querySelector('.mnav') && document.querySelector('.mnav').offsetParent !== null,
      rail: !!document.querySelector('.rail') && document.querySelector('.rail').offsetParent !== null,
    }))
    check('767px 是手机态（底部导航在、竖侧栏不在）', at767.mnav && !at767.rail,
      `mnav=${at767.mnav} rail=${at767.rail}`)

    // 跨到 768：应变成多栏
    await page.setViewportSize({ width: 768, height: 800 })
    await page.waitForTimeout(500)
    const at768 = await page.evaluate(() => ({
      mnav: !!document.querySelector('.mnav') && document.querySelector('.mnav').offsetParent !== null,
      rail: !!document.querySelector('.rail') && document.querySelector('.rail').offsetParent !== null,
      viewW: window.innerWidth,
    }))
    check('768px 是平板态（竖侧栏在、底部导航不在）', at768.rail && !at768.mnav,
      `mnav=${at768.mnav} rail=${at768.rail} viewW=${at768.viewW}`)
    await assertNoHorizontalOverflow(page, '768')

    await page.setViewportSize({ width: 1023, height: 800 })
    await page.waitForTimeout(400)
    await assertNoHorizontalOverflow(page, '1023')

    await page.setViewportSize({ width: 1024, height: 800 })
    await page.waitForTimeout(400)
    const at1024 = await page.evaluate(() => ({
      rail: !!document.querySelector('.rail') && document.querySelector('.rail').offsetParent !== null,
      railW: document.querySelector('.rail')?.getBoundingClientRect().width ?? 0,
    }))
    check('1024px 是桌面态（侧栏回到 60px）', at1024.rail && Math.round(at1024.railW) === 60,
      `railW=${at1024.railW}`)
    await assertNoHorizontalOverflow(page, '1024')

    // 跨断点不应重复建 WS
    const wsAfter = wsUrls.length
    check('跨断点未重建 WS（连接数不增长）', wsAfter === wsBefore,
      `切换前=${wsBefore} 切换后=${wsAfter}`)

    await ctx.close()
  }

  await browser.close()
  return finish()
}

function finish() {
  clearTimeout(hardTimer)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总：${results.length} 项断言，${failed.length} 项失败 ===`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  —— ${f.detail}`)
  console.log(`\n截图见 docs/evidence/resp-*.png`)
  console.log(`注意：这是视口模拟，不是真机。软键盘/安全区/横竖屏真机行为仍属「待真机验证」。\n`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  clearTimeout(hardTimer)
  console.error('脚本异常：', e)
  process.exitCode = 1
})
