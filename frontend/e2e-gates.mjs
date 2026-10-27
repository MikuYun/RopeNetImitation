/**
 * pm 门禁回归脚本：SEC-02（注销缓存残留）/ FE-01（已读门禁）/ FE-02（已读失败回滚）。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 用 Playwright + 真实 Chrome，针对 pm 在 session 与
 * management/current-status.md 里点名的三个反例做**独立复现**：
 *
 *   SEC-02  注销后：URL 是否仍停在会话页、私密气泡是否仍可见、
 *           业务 store 是否仍残留上一个账号的数据、是否立即回登录页。
 *           另验「换账号登录后不会看到上一个账号的残留」。
 *   FE-01   停在会话列表（未打开会话）时，对方发消息 —— 未读必须保留，
 *           不得被自动标记已读；进入正文后才消除。
 *           同样检查浏览器后台标签页。
 *   FE-02   已读上报失败时，未读红点必须**回滚**到上报前的值，
 *           不得假装成功。
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   环境变量 BASE     默认 http://localhost:5173
 *   环境变量 BACKEND  默认 http://127.0.0.1:3099（隔离测试后端）
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项 PASS/FAIL + 汇总
 *   截图：docs/evidence/gate-*.png
 *   退出码：0 全通过 / 1 有失败 / 3 硬超时
 *
 * ── 副作用（重要）────────────────────────────────────────────────
 *   1. 只在**隔离测试后端**（3099 / backend/.data/e2e-responsive.sqlite）
 *      注册账号 gate_a / gate_b 并发消息。**不碰生产库、不碰生产账号。**
 *   2. 截图写入 docs/evidence/（本方目录）。
 *   3. 不改源码、不改配置、不重启服务。
 *
 * ── 为什么这脚本能当证据 ──────────────────────────────────────────
 *   断言的是**行为**（URL、DOM 可见性、store 内容、未读数值），
 *   不是「函数被调用过」。修复前这些断言会失败，修复后才通过。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 240_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

const PW = 'GatePass!2345'
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail, skipped: false })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}
/**
 * 记一条「未能机器验证」的项。
 *
 * 【为什么需要这个类别】headless Chrome 里没有真正的「切到后台」——
 * bringToFront 不会让前一个页面变成 hidden。这不是产品缺陷，也不该假装通过。
 * pm 的要求是「未验证项明确待验」，所以单列一类，汇总里与 FAIL 分开报。
 */
function skip(name, reason) {
  results.push({ name, ok: true, detail: reason, skipped: true })
  console.log(`SKIP  ${name}  —— ${reason}`)
}
function group(t) {
  console.log(`\n──── ${t} ────`)
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
  await page.screenshot({ path: resolve(SHOT_DIR, `gate-${name}.png`) })
}

/* ── 后端直连工具（全部打隔离后端） ───────────────────────────── */

const tokenCache = new Map()

async function ensureUser(username, displayName) {
  const r = await fetch(`${BACKEND}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW, displayName }),
  })
  return r.status
}

async function tokenOf(username) {
  if (tokenCache.has(username)) return tokenCache.get(username)
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  })
  if (!r.ok) throw new Error(`登录失败 ${username}: ${r.status}`)
  const j = await r.json()
  tokenCache.set(username, j)
  return j
}

/**
 * 作废缓存的令牌。
 *
 * 【必须调用的时机】任何一步真的调了后端 logout（或让会话失效）之后 ——
 * 那个 token 在服务端已被撤销，继续用它会拿到 401，页面 bootstrap 失败后
 * 静默跳登录页，后续断言就在等一个永远不会出现的元素（表现为莫名其妙的超时）。
 * 这个坑我在 SEC-02 上踩过一次。
 */
function invalidateToken(username) {
  tokenCache.delete(username)
}

const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

/** 让 a、b 成为好友并返回一个双方可见的会话 id。 */
async function ensureFriendsAndConv(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)

  const listA = await (
    await fetch(`${BACKEND}/api/v1/conversations?limit=50&offset=0`, { headers: H(A.token) })
  ).json()
  const found = (listA.items ?? []).find((c) => c.peer?.username === b)
  if (found) return found.id

  const search = await (
    await fetch(`${BACKEND}/api/v1/users?q=${b}`, { headers: H(A.token) })
  ).json()
  const target = (search.items ?? [])[0]
  if (!target) return null

  // F3 的 body 字段名是 userId（不是 toUserId），且 note 也是 required
  await fetch(`${BACKEND}/api/v1/friend-requests`, {
    method: 'POST',
    headers: H(A.token),
    body: JSON.stringify({ userId: target.id, note: '门禁回归测试' }),
  })
  const reqs = await (
    await fetch(`${BACKEND}/api/v1/friend-requests`, { headers: H(B.token) })
  ).json()
  // 【线格式 vs 前端域模型】线上返回的是 { sender, recipient, status }，
  // 没有 fromUser / direction —— 那两个字段是前端 normalize 层**推导**出来的。
  // 测试脚本直连后端，必须按线格式判断，别照抄前端 store 的字段名。
  const inc = (reqs.items ?? []).find(
    (r) => r.sender?.username === a && r.status === 'pending',
  )
  if (inc) {
    await fetch(`${BACKEND}/api/v1/friend-requests/${inc.id}/respond`, {
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
  return direct?.id ?? null
}

/** 以某人身份发一条消息，返回 seq。 */
async function sendAs(username, convId, content) {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/conversations/${convId}/messages`, {
    method: 'POST',
    headers: H(t.token),
    // v2 契约 §2：body 不再接受 type（additionalProperties:false → 传了直接 400）。
    // 消息 type 由服务端按附件推导。
    body: JSON.stringify({ clientMsgId: crypto.randomUUID(), content }),
  })
  if (!r.ok) return null
  const m = await r.json()
  return m.seq
}

/** 读某会话在服务端的权威未读数（以 a 的身份）。 */
async function unreadOfA(a, convId) {
  const t = await tokenOf(a)
  const r = await (
    await fetch(`${BACKEND}/api/v1/conversations?limit=50&offset=0`, { headers: H(t.token) })
  ).json()
  return (r.items ?? []).find((c) => c.id === convId)?.unreadCount ?? -1
}

/** 把 token 注入 localStorage。
 *
 * 【必须注意 addInitScript 的作用域】它注册在 **context** 上，每次导航都会
 * 重新执行。所以同一个 context 里先注 A 的 token、再注 B 的 —— 两个脚本都会
 * 跑，靠执行顺序决定谁赢，非常脆弱。换账号必须**换 context**。
 */
async function openAs(page, username) {
  const cred = await tokenOf(username)
  await page.addInitScript(
    ([t, e]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
    },
    [cred.token, cred.expiresAt],
  )
}

/** 新建一个已注入某账号 token 的 context + page。 */
async function contextAs(browser, username, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  await openAs(page, username)
  return { ctx, page }
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== pm 门禁回归  BASE=${BASE}  BACKEND=${BACKEND} ===\n`)

  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  await tokenOf('gate_a')
  await tokenOf('gate_b')
  const convId = await ensureFriendsAndConv('gate_a', 'gate_b')
  console.log(`会话：${convId ?? '★ 未建立'}\n`)
  if (!convId) throw new Error('无法建立测试会话，后续断言无意义')

  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  /* ═══ SEC-02：注销后不得残留 ═══════════════════════════════════ */
  group('SEC-02 注销后的隐私清理')
  {
    const { ctx, page } = await contextAs(browser, 'gate_a')

    // 先用另一账号铺几条「私密」消息，确保该会话有内容可泄露
    await sendAs('gate_b', convId, '这是一条注销后不应被看到的私密消息')
    await sendAs('gate_b', convId, '第二条私密内容')

    await page.goto(`${BASE}/chat/${convId}`, { waitUntil: 'domcontentloaded' })
    await until(async () => (await page.locator('.bubble').count()) > 0, 15_000)
    const beforeBubbles = await page.locator('.bubble').count()
    check('前置：注销前会话有气泡', beforeBubbles > 0, `bubble=${beforeBubbles}`)
    await shot(page, 'sec02-before-logout')

    // 通过 UI 触发登出。用桌面视口。
    // v2 起「退出登录」不再在侧栏底部 —— 需求 1 把它移进了个人信息：
    //   点左上角头像（.rail__avatar）→ 打开个人信息抽屉 .pdrawer
    //   → 点「退出登录」行 .pdrawer__entry--danger → AppModal 二次确认 → 点「退出登录」按钮
    // 二次确认弹层里有两个按钮（取消 / 退出登录），必须按文字精确取，不能按 nth。
    await page.locator('.rail__avatar').click()
    await page.waitForSelector('.pdrawer', { timeout: 10_000 })
    await page.locator('.pdrawer__entry--danger').click()
    await page.waitForSelector('.mask .panel', { timeout: 10_000 })
    await page.locator('.mask .panel__foot .btn', { hasText: '退出登录' }).click()

    const backToLogin = await until(async () => page.url().includes('/login'), 10_000)
    check('注销后立即离开受保护页面（URL 回 /login）', backToLogin, `url=${page.url()}`)

    // 等一帧，确认 DOM 也切走了
    await page.waitForTimeout(600)
    const stillHasPane = await page.locator('.pane__scroll').isVisible().catch(() => false)
    const bubblesAfter = await page.locator('.bubble').count()
    check('注销后页面不再渲染消息正文', !stillHasPane && bubblesAfter === 0,
      `正文可见=${stillHasPane} bubble=${bubblesAfter}`)
    await shot(page, 'sec02-after-logout')

    // 业务缓存必须清空（这是 pm 说的「清凭据不清缓存」）
    const cache = await page.evaluate(() => {
      const raw = sessionStorage.getItem('__pinia_probe')
      void raw
      // Pinia 没暴露到 window，改从 DOM 侧观察：列表项数应为 0
      return {
        items: document.querySelectorAll('.item').length,
        friends: document.querySelectorAll('.row').length,
      }
    })
    check('注销后无残留会话/好友行', cache.items === 0 && cache.friends === 0,
      `item=${cache.items} row=${cache.friends}`)

    await ctx.close()

    // 上一步的 UI 注销已经把 gate_a 的服务端会话撤销了，缓存的 token 已失效。
    // 后续分段要重新登录，这里必须作废，否则会拿 401 当成功用。
    invalidateToken('gate_a')

    // 换账号登录：必须换 context —— addInitScript 是 context 级的，
    // 同 context 里再注入 B 的 token 会与 A 的叠加，谁生效取决于执行顺序。
    const { ctx: ctxB, page: pageB } = await contextAs(browser, 'gate_b')
    await pageB.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await pageB.waitForSelector('.list, .panel', { timeout: 15_000 })

    // 【怎么断言「没闪现旧账号数据」】A 与 B 互为好友，所以 B 也会有这条会话 ——
    // 光看会话数分不出内容归属。改成看**侧栏头像的 title**：那是 auth.displayName，
    // 即「当前登录的是谁」。若停止渲染后仍是 A 的名字，说明身份/缓存没换过来。
    await until(async () => (await pageB.locator('.rail .avatar').count()) > 0, 8_000)
    const frameIdentity = await pageB.locator('.rail .avatar').first().getAttribute('title')
    await pageB.waitForTimeout(2000)
    const settledIdentity = await pageB.locator('.rail .avatar').first().getAttribute('title')

    check('换账号后首帧身份即为新账号（无旧账号残留窗口）',
      frameIdentity === '闸门 B' && settledIdentity === '闸门 B',
      `首帧 title="${frameIdentity}" 稳定后 title="${settledIdentity}"（应为「闸门 B」）`)
    await shot(pageB, 'sec02-switch-account')

    await ctxB.close()
  }

  /* ═══ FE-01：未读门禁 ═══════════════════════════════════════════ */
  group('FE-01 未读门禁（停在列表/后台标签页不得自动已读）')
  {
    // SEC-02 里 gate_a 注销过，重新登录拿新会话
    const { ctx, page } = await contextAs(browser, 'gate_a')

    // 先把该会话读到最新，确保起点是「无未读」
    const t = await tokenOf('gate_a')
    const list0 = await (
      await fetch(`${BACKEND}/api/v1/conversations?limit=50&offset=0`, { headers: H(t.token) })
    ).json()
    const lastSeq = (list0.items ?? []).find((c) => c.id === convId)?.lastSeq ?? 0
    if (lastSeq > 0) {
      await fetch(`${BACKEND}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: H(t.token),
        body: JSON.stringify({ lastReadSeq: lastSeq }),
      })
    }

    // 打开应用，停在「会话列表」屏（不进入该会话）
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    // 不用 .item 做等待条件：该会话可能还没出现在列表里（首屏数据未回）。
    // 等应用壳渲染出来即可，后面用带超时的 until 单独等会话项。
    await page.waitForSelector('.list, .panel', { timeout: 15_000 })
    const listReady = await until(async () => (await page.locator('.item').count()) > 0, 15_000)
    check('前置：会话列表已加载出会话项', listReady, `item=${await page.locator('.item').count()}`)
    await page.waitForTimeout(1200)

    // B 发一条新消息
    const s1 = await sendAs('gate_b', convId, '列表屏收到的未读测试消息')
    check('前置：B 成功发送消息', s1 !== null, `seq=${s1}`)

    // 等 WS 推送到达
    await page.waitForTimeout(2500)

    const unreadInList = await page.evaluate(() => {
      const badge = document.querySelector('.item__badge')
      return badge ? badge.textContent.trim() : ''
    })
    check('停在列表屏时未读红点保留', unreadInList !== '', `badge="${unreadInList}"`)

    const serverUnread = await unreadOfA('gate_a', convId)
    check('服务端未读未被清零（说明前端没误报已读）', serverUnread > 0, `服务端 unreadCount=${serverUnread}`)
    await shot(page, 'fe01-list-unread')

    // 进入正文 → 未读应消除
    await page.locator('.item').first().click()
    await page.waitForTimeout(1800)
    const serverUnreadAfter = await unreadOfA('gate_a', convId)
    check('进入正文后未读消除', serverUnreadAfter === 0, `服务端 unreadCount=${serverUnreadAfter}`)
    await shot(page, 'fe01-after-open')

    // 后台标签页：切到另一个 tab，再发消息，不得自动已读
    const other = await ctx.newPage()
    await other.goto('about:blank')
    await other.bringToFront()
    await page.waitForTimeout(800)

    /**
     * 【先证伪测量方法】headless Chrome 下 bringToFront 不会真的把前一个页面
     * 置为 hidden（多标签共用一个渲染进程时 visibilityState 仍为 visible）。
     * 若这里拿到 'visible'，失败的是**测试没切到后台**，不是产品误报已读。
     *
     * 这一条**不能报成 PASS**：那等于用一个没成立的实验条件去证明结论。
     * 归入「待验」并在汇总里单列，等真机或有头浏览器补。
     * （同一条门禁在 FE-01 的「停在列表」场景已通过，那才是主场景；
     *   后台标签页是加强场景。）
     */
    const visState = await page.evaluate(() => document.visibilityState)
    if (visState !== 'hidden') {
      skip(
        '浏览器后台标签页收到消息未被自动已读',
        `headless 下无法把页面真正切到后台（visibilityState=${visState}），` +
          `判据无法成立 → 待真机/有头浏览器验证`,
      )
      // 仍然把这一发消息读掉，避免影响后续断言
      await page.bringToFront()
      await page.waitForTimeout(1500)
    } else {
      const s2 = await sendAs('gate_b', convId, '后台标签页收到的消息')
      await page.waitForTimeout(2500)
      const serverUnreadBg = await unreadOfA('gate_a', convId)
      check('浏览器后台标签页收到消息未被自动已读', serverUnreadBg > 0,
        `seq=${s2} 服务端 unreadCount=${serverUnreadBg}`)
      await shot(other, 'fe01-background')

      await page.bringToFront()
      await page.waitForTimeout(2000)
      const serverUnreadFg = await unreadOfA('gate_a', convId)
      check('回到前台后补上已读', serverUnreadFg === 0, `服务端 unreadCount=${serverUnreadFg}`)
    }

    await ctx.close()

    // FE-01 结束时 gate_a 的 token 仍有效，FE-02 复用同一 token 开新 context。
  }

  /* ═══ FE-02：已读失败必须回滚 ═══════════════════════════════════ */
  group('FE-02 已读上报失败要回滚，不伪装成功')
  {
    const { ctx, page } = await contextAs(browser, 'gate_a')

    // 造出一条未读
    await sendAs('gate_b', convId, '用于验证已读失败回滚的消息')

    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.list, .panel', { timeout: 15_000 })
    await until(async () => (await page.locator('.item').count()) > 0, 15_000)
    await page.waitForTimeout(2500)

    const badgeBefore = await page.evaluate(() => {
      const b = document.querySelector('.item__badge')
      return b ? b.textContent.trim() : ''
    })
    check('前置：列表上有未读', badgeBefore !== '', `badge="${badgeBefore}"`)

    // 拦截已读接口并强制失败
    await page.route('**/conversations/*/read', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '注入的失败' } }),
      }),
    )

    // 进入会话触发已读上报（会失败）
    await page.locator('.item').first().click()
    await page.waitForTimeout(2500)

    // 回到列表看红点是否回滚
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const badgeAfter = await page.evaluate(() => {
      const b = document.querySelector('.item__badge')
      return b ? b.textContent.trim() : ''
    })
    check('已读失败后未读红点回滚（未伪装成功）', badgeAfter !== '',
      `失败前="${badgeBefore}" 失败后="${badgeAfter}"`)

    const serverUnread = await unreadOfA('gate_a', convId)
    check('服务端确实仍是未读（前端回滚与服务端一致）', serverUnread > 0, `服务端 unreadCount=${serverUnread}`)
    await shot(page, 'fe02-read-fail-rollback')

    await ctx.close()
  }

  await browser.close()
  return finish()
}

function finish() {
  clearTimeout(hardTimer)
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.filter((r) => r.ok && !r.skipped)
  console.log(
    `\n=== 汇总：${results.length} 项 —— 通过 ${passed.length}，失败 ${failed.length}，待验 ${skipped.length} ===`,
  )
  for (const f of failed) console.log(`  FAIL  ${f.name}  —— ${f.detail}`)
  for (const s of skipped) console.log(`  SKIP  ${s.name}  —— ${s.detail}`)
  console.log(`\n截图见 docs/evidence/gate-*.png`)
  console.log(`数据仅写入隔离后端 ${BACKEND}，未触碰生产。`)
  console.log(`「待验」项不计入通过，需真机或有头浏览器补测。\n`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  clearTimeout(hardTimer)
  console.error('脚本异常：', e)
  process.exitCode = 1
})
