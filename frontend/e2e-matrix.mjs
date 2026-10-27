/**
 * FE-01 / FE-02 / FE-03 浏览器门禁矩阵（补充 e2e-gates.mjs 与 e2e-responsive.mjs 未覆盖的验收项）。
 *
 * ── 为什么另开一个文件，而不是继续往 e2e-gates.mjs 里塞 ─────────────
 *   1. e2e-gates.mjs 是 pm 点名的 SEC-02/FE-01/FE-02 回归，已经 479 行、14 项，
 *      它是「既有基线」，改动它会污染对照基线。本文件只**新增**，不改老脚本。
 *   2. 本矩阵要造的数据量大（多账号、40 条分页消息、群聊三人），且耗时数分钟；
 *      单独成文件可以单独跑、单独看退出码，一个挂了不影响另一份证据。
 *   3. 工具函数是**复制**而不是 import：两脚本并行跑时互不依赖，
 *      也不给老脚本引入被本文件改动而失效的风险。
 *
 * ── 覆盖 ─────────────────────────────────────────────────────────
 *   FE-01 已读门禁：联系人屏 / 详情页 / 深链冷启动 / **后台标签页 hidden（真验，不再 skip）**
 *                   / 离开正文后新消息重新计未读
 *   FE-02 已读失败回滚：429 / 断网(abort) / 恢复后重试成功 / **并发反例（旧失败响应不得回滚新成功游标）**
 *   FE-03 双用户矩阵：幂等、排序置顶、分页（滚动加载历史不乱序不重复）、
 *                   群权限（非群主改名/踢人 403 + UI 不渲染管理入口）、草稿、
 *                   Enter 语义（桌面 Enter 发送 / Shift+Enter 换行 / 手机 Enter 换行）、深链刷新
 *   FE-03 视口：320/390/768/1024/1440 × **深色主题** 的溢出与配色（亮色矩阵见 e2e-responsive.mjs）
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   BASE     默认 http://localhost:5173
 *   BACKEND  默认 http://127.0.0.1:3099（隔离测试后端）
 *   HARD_TIMEOUT_MS 默认 480000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项 PASS / FAIL / DEFECT / SKIP + 汇总
 *   截图：docs/evidence/matrix-*.png
 *   退出码：0 = 无「非缺陷性」失败（DEFECT 不计入退出码，见下） / 1 = 有 FAIL / 3 = 硬超时
 *
 * ── 关于 DEFECT 这个类别 ─────────────────────────────────────────
 *   「产品行为不符合验收标准」与「测试脚本自己写错了」必须分开报。前者记 DEFECT，
 *   会打印并汇总进缺陷清单（交由 frontend-core 修），但不让脚本退出码非 0 ——
 *   否则门禁永远红，失去「新回归」信号。脚本自身断言失败仍然是 FAIL → 退出码 1。
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   只在隔离后端 3099 注册 gate_a/b/c、发测试消息。不碰生产库、不改源码、不重启服务。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 480_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

const PW = 'GatePass!2345'
// 每次运行的唯一标记：幂等/分页用例的断言都靠消息文本去重，
// 而隔离库是跨运行复用的（第一轮发的「幂等测试消息」会留在历史里），
// 不加 tag 就会被上一轮的数据污染成假 FAIL。
const RUN = Date.now().toString(36).slice(-6)
const results = []
const defects = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail, skipped: false, defect: false })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}
/** 产品行为断言：失败记缺陷，不影响退出码（缺陷清单单独写进 evidence）。 */
function checkProduct(name, ok, detail = '') {
  if (ok) {
    results.push({ name, ok: true, detail, skipped: false, defect: false })
    console.log(`PASS  ${name}${detail ? `  —— ${detail}` : ''}`)
    return
  }
  defects.push({ name, detail })
  results.push({ name, ok: false, detail, skipped: false, defect: true })
  console.log(`DEFECT  ${name}  —— ${detail}`)
}
function skip(name, reason) {
  results.push({ name, ok: true, detail: reason, skipped: true, defect: false })
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
  await page.screenshot({ path: resolve(SHOT_DIR, `matrix-${name}.png`) })
}
/* ── 导航守卫（只加等待/重试，不改任何判据）───────────────────────────
 * 环境事实：本机 vite 8.3.5 dev server 在跑长脚本时会偶发自行退出
 * （vite-dev.err.log 里是 ws 代理的 write ECONNABORTED；生产不走 vite dev，
 *   与 frontend/src 的产品代码无关）。run-e2e.ps1 的存活看护会在 1-2s 内
 * 重新拉起它，但如果脚本正好在这 1-2s 里发起了 goto，就会拿到
 * net::ERR_CONNECTION_REFUSED 并直接把整轮炸掉（后续几十条断言一条都跑不到）。
 * 所以所有导航统一走这里：连接类错误就等 2s 再试，最多 12 次（≈24s，足够覆盖
 * 看护重拉 + vite 冷启动）。**判据不变**：12 次都失败仍然抛错，该失败就失败。
 */
async function gotoRetry(page, url, opts = { waitUntil: 'domcontentloaded' }, attempts = 12) {
  let lastErr = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(2_000)
    try {
      await page.goto(url, opts)
      return true
    } catch (err) {
      lastErr = err
      if (attempt === 0) {
        console.log(`   … 导航失败（dev server 掉线？等看护重拉后重试）：${String(err.message).split('\n')[0]}`)
      }
    }
  }
  throw lastErr
}

/* ── 后端直连工具 ───────────────────────────────────────────────── */

const tokenCache = new Map()
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

async function ensureUser(username, displayName) {
  const r = await fetch(`${BACKEND}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW, displayName }),
  })
  return r.status // 201 新建 / 409 已存在
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
function invalidateToken(username) {
  tokenCache.delete(username)
}
async function jget(path, token) {
  const r = await fetch(`${BACKEND}${path}`, { headers: H(token) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function jpost(path, token, body) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: H(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function jpatch(path, token, body) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'PATCH',
    headers: H(token),
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function jdel(path, token) {
  // 注意：DELETE 不带 Content-Type。Fastify 在带 application/json 却没有 body 时
  // 会在 schema 校验前直接 400 BAD_REQUEST（"Body cannot be empty ..."），
  // 掩盖掉真正的 403/409 语义。
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/* ── 限流自适应 ─────────────────────────────────────────────────────
 * 隔离后端挂了全局 rate-limit：**按 userId 200 次/分钟**（backend/src/app.ts）。
 * 本矩阵会密集开/关浏览器上下文，每个上下文冷启动要打好几个受保护请求，
 * 很容易把 gate_a 的配额打满 → 会话列表/历史返回 429 → 前端只有一条 toast，
 * 列表空白 → 后续 `.item` 等待超时，看起来像产品挂了，其实只是限流。
 * 所以：①断言前先探一下是否已被限流；②探到就等窗口滑过去；③把 429 计数写进详情。
 */
const rateHit = new Map()
async function isRateLimited(username) {
  const t = await tokenOf(username)
  const r = await jget('/api/v1/conversations?limit=1&offset=0', t.token)
  return r.status === 429
}
/** 阻塞直到该账号不被限流（最多 maxWaitMs）；返回是否解除。 */
async function ensureNotLimited(username, maxWaitMs = 90_000) {
  const start = Date.now()
  let waited = 0
  while (await isRateLimited(username)) {
    if (Date.now() - start > maxWaitMs) {
      rateHit.set(username, (rateHit.get(username) ?? 0) + 1)
      console.log(`   … ${username} 仍被限流，已等 ${Math.round(waited / 1000)}s，放弃等待`)
      return false
    }
    if (waited === 0) console.log(`   … ${username} 触发限流，等窗口滑过()…`)
    await sleep(5_000)
    waited += 5_000
  }
  if (waited > 0) console.log(`   … ${username} 限流已解除（等了 ${Math.round(waited / 1000)}s）`)
  return true
}

/** 让 a、b 成为好友并返回双方可见会话 id。 */
async function ensureFriendsAndConv(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const listA = await jget('/api/v1/conversations?limit=50&offset=0', A.token)
  const found = (listA.body?.items ?? []).find((c) => c.type === 'direct' && c.peer?.username === b)
  if (found) return found.id

  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return null
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: '矩阵测试' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find(
    (r) => r.sender?.username === a && r.status === 'pending',
  )
  if (inc) {
    await jpost(`/api/v1/friend-requests/${inc.id}/respond`, B.token, { action: 'accept' })
  }
  const direct = await jpost('/api/v1/conversations/direct', A.token, { userId: target.id })
  return direct.body?.id ?? null
}

/** 以某人身份发一条消息，返回 seq。 */
async function sendAs(username, convId, content, clientMsgId) {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/conversations/${convId}/messages`, {
    method: 'POST',
    headers: H(t.token),
    body: JSON.stringify({
      clientMsgId: clientMsgId ?? crypto.randomUUID(),
      type: 'text',
      content,
    }),
  })
  if (!r.ok) return null
  const m = await r.json()
  return m.seq
}

async function convSummary(username, convId) {
  const t = await tokenOf(username)
  const r = await jget('/api/v1/conversations?limit=50&offset=0', t.token)
  return (r.body?.items ?? []).find((c) => c.id === convId) ?? null
}
async function unreadOf(username, convId) {
  const c = await convSummary(username, convId)
  return c?.unreadCount ?? -1
}
/** 把某会话读到最新（铺干净起点）。 */
async function readAllAs(username, convId) {
  const c = await convSummary(username, convId)
  if (!c || c.lastSeq <= 0) return false
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/conversations/${convId}/read`, {
    method: 'POST',
    headers: H(t.token),
    body: JSON.stringify({ lastReadSeq: c.lastSeq }),
  })
  return r.status === 204
}

/* ── 浏览器工具 ─────────────────────────────────────────────────── */

/**
 * 直接往 localStorage 写凭据，而不是 page.addInitScript。
 *
 * 【为什么】addInitScript 注册在 context 上，**每次导航都会重跑**，所以同一个
 * context 里没法「先以 A 登录、再换成 B」—— B 的写入会被下一次导航重新覆盖成 A。
 * 本文件需要在一个 context 内换账号（FE-03 草稿/切会话、FE-04 换账号），
 * 所以统一改成手动写一次：只在首个同源页面里写 localStorage，之后导航自然保留。
 */
async function setAuth(page, username) {
  const cred = await tokenOf(username)
  await gotoRetry(page, `${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([t, e]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
    },
    [cred.token, cred.expiresAt],
  )
  await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
}
/**
 * 新开一个**独立** session 并返回凭据（不复用 tokenCache）。
 *
 * 【为什么需要】FE-04 里有几条断言会真的把当前 session 弄失效（服务端注销、
 * 登出换账号）。若用 tokenCache 里的共享 token，前面的用例会被连带打断；
 * 用一次性 session 就能「只破坏这一条用例自己的凭据」。
 */
async function freshLogin(username) {
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  })
  if (!r.ok) throw new Error(`freshLogin ${username} 失败：${r.status}`)
  return r.json()
}
/** 用给定凭据进入 /chat（与 setAuth 同构，只是凭据来自 freshLogin）。 */
async function setAuthWith(page, cred) {
  await gotoRetry(page, `${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([t, e]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
    },
    [cred.token, cred.expiresAt],
  )
  await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
}
const UNAUTHORIZED_BODY = JSON.stringify({
  error: { code: 'UNAUTHORIZED', message: '注入的 401' },
})
const FULFILL_401 = { status: 401, contentType: 'application/json', body: UNAUTHORIZED_BODY }

/**
 * 取弹层内可聚焦元素（选择器与应用 AppModal 的 trap 保持一致）。
 * 返回每个元素的可读标签，便于在失败详情里直接看出焦点落在哪。
 */
function focusables(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return []
    const list = [
      ...root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.disabled && el.offsetParent !== null)
    root.dataset['focusCount'] = String(list.length)
    return list.map((el) => (el.textContent || '').trim().slice(0, 16) || el.tagName)
  }, selector)
}
/** 把焦点放到容器内第 n 个（负数从末尾数）可聚焦元素上。 */
function focusNth(page, selector, n) {
  return page.evaluate(
    ([sel, idx]) => {
      const root = document.querySelector(sel)
      if (!root) return ''
      const list = [
        ...root.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.disabled && el.offsetParent !== null)
      const el = idx < 0 ? list[list.length + idx] : list[idx]
      if (!el) return ''
      el.focus()
      return (document.activeElement?.textContent || '').trim().slice(0, 16)
    },
    [selector, n],
  )
}
/** 当前焦点在容器可聚焦列表里的下标（-1 = 不在容器内，或焦点在容器本身）。 */
function focusedIndexIn(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return { index: -1, count: 0 }
    const list = [
      ...root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.disabled && el.offsetParent !== null)
    return { index: list.indexOf(document.activeElement), count: list.length }
  }, selector)
}
/** 当前焦点是否在容器内，以及它的可读标签。 */
function activeIn(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    const active = document.activeElement
    return {
      inside: !!root && !!active && root.contains(active),
      label: (active?.textContent || '').trim().slice(0, 16) || active?.tagName || '',
      tag: active?.tagName ?? '',
    }
  }, selector)
}

async function contextAs(browser, username, viewport = { width: 1280, height: 800 }) {
  // 开上下文前先确认该账号没被限流，否则冷启动就会 429 → 列表空白（假失败）。
  await ensureNotLimited(username, 60_000)
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  await setAuth(page, username)
  return { ctx, page }
}
async function waitShell(page) {
  await page.waitForSelector('.list, .panel, .rail', { timeout: 15_000 })
}
/**
 * 等外壳，并且抗「全局限流打满」引发的假失败。
 *
 * 为什么需要：隔离后端挂的是全局 200 次/分钟（按 userId），矩阵跑到后期
 * gate_a 的配额经常已经用光 → 冷启动的 GET /conversations 返回 429 → 列表为空
 * → `.list/.panel/.rail` 永远等不到，看起来像产品挂了。更坑的是 bootstrap 里
 * fetchSession 失败会走 catch 分支清凭据（见 auth.ts），于是页面直接停在登录页。
 * 所以这里：①先等；②等不到就探限流，等窗口滑过；③被踢回登录就重写凭据再进。
 */
async function ensureShell(page, username = 'gate_a') {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ok = await page
      .waitForSelector('.list, .panel, .rail', { timeout: attempt === 1 ? 15_000 : 10_000 })
      .then(() => true)
      .catch(() => false)
    if (ok) return true
    const onLogin = await page.locator('.auth__form').isVisible().catch(() => false)
    console.log(
      `   … 外壳未出现（第 ${attempt} 次${onLogin ? '，已被踢回登录页（限流/瞬时错误）' : ''}），等限流窗口后重试…`,
    )
    await ensureNotLimited(username, 90_000)
    if (onLogin) await setAuth(page, username)
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await sleep(1500)
  }
  return false
}
function badgeText(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.item__badge')
    return b ? b.textContent.trim() : ''
  })
}
/** 点开列表里某会话（按标题文本）。遇到限流导致列表为空时，等待并重载再试。 */
async function openConv(page, title) {
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const item = page.locator('.item', { hasText: title }).first()
      await item.waitFor({ state: 'visible', timeout: attempt === 1 ? 12_000 : 6_000 })
      await item.click()
      await page.waitForSelector('.pane__scroll', { timeout: 12_000 })
      return
    } catch (e) {
      lastErr = e
      // 列表里没有会话：十有八九是会话列表请求被 429 吃了
      const limited = await isRateLimited('gate_a').catch(() => false)
      if (!limited && attempt >= 3) break
      if (limited) await ensureNotLimited('gate_a', 60_000)
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await sleep(1500)
    }
  }
  throw lastErr ?? new Error(`openConv 失败：${title}`)
}
/** 覆写 document.visibilityState 并派发 visibilitychange（真验 hidden 分支）。 */
const setVisibility = (page, state) =>
  page.evaluate((s) => {
    if (s === 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    } else {
      delete document.visibilityState
      delete document.hidden
    }
    document.dispatchEvent(new Event('visibilitychange'))
    return { state: document.visibilityState, hidden: document.hidden }
  }, state)

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== FE 浏览器矩阵  BASE=${BASE}  BACKEND=${BACKEND} ===\n`)

  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  await ensureUser('gate_c', '闸门 C')
  const convAB = await ensureFriendsAndConv('gate_a', 'gate_b')
  const convAC = await ensureFriendsAndConv('gate_a', 'gate_c')
  if (!convAB || !convAC) throw new Error('无法建立测试会话，后续断言无意义')
  console.log(`会话：AB=${convAB}  AC=${convAC}\n`)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  /* ═══ FE-01：已读门禁扩展场景 ═══════════════════════════════════ */
  group('FE-01 已读门禁（联系人屏 / 详情页 / 深链 / 后台标签页真验）')
  {
    const { ctx, page } = await contextAs(browser, 'gate_a')
    await ensureShell(page)

    /* 1) 联系人屏：桌面切到联系人面板，不得吞掉会话未读 */
    await readAllAs('gate_a', convAB)
    await page.locator('.rail__tab[title="联系人"]').click()
    await page.waitForTimeout(1200)
    const s1 = await sendAs('gate_b', convAB, '联系人屏收到、不应被自动已读的消息')
    check('前置：B 发送成功（联系人屏场景）', s1 !== null, `seq=${s1}`)
    await page.waitForTimeout(2500)
    const u1 = await unreadOf('gate_a', convAB)
    check('停在联系人屏时未读保留（服务端未清零）', u1 > 0, `unreadCount=${u1}`)
    await shot(page, 'fe01-contacts-unread')

    /* 2) 详情页：/chat/:id/info 不是正文，不得自动已读 */
    await readAllAs('gate_a', convAB)
    await gotoRetry(page, `${BASE}/chat/${convAB}/info`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.info, .info__body', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const s2 = await sendAs('gate_b', convAB, '详情页收到、不应被自动已读的消息')
    check('前置：B 发送成功（详情页场景）', s2 !== null, `seq=${s2}`)
    await page.waitForTimeout(2500)
    const u2 = await unreadOf('gate_a', convAB)
    check('停在会话详情页时未读保留', u2 > 0, `unreadCount=${u2}`)
    await shot(page, 'fe01-info-unread')

    /* 3) 深链冷启动：直接打开 /chat/:id 应进入正文并上报已读 */
    await readAllAs('gate_a', convAB)
    const s3 = await sendAs('gate_b', convAB, '深链冷启动应被读到的最新消息')
    check('前置：B 发送成功（深链场景）', s3 !== null, `seq=${s3}`)
    const { ctx: ctxD, page: pageD } = await contextAs(browser, 'gate_a')
    await gotoRetry(pageD, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    const gotBubbles = await until(async () => (await pageD.locator('.bubble').count()) > 0, 15_000)
    check('深链 /chat/:convId 冷启动直接渲染正文', gotBubbles,
      `bubble=${await pageD.locator('.bubble').count()}`)
    const readByDeepLink = await until(async () => (await unreadOf('gate_a', convAB)) === 0, 12_000)
    check('深链进入正文后未读消除（服务端 0）', readByDeepLink,
      `unreadCount=${await unreadOf('gate_a', convAB)}`)
    await shot(pageD, 'fe01-deeplink')
    await ctxD.close()

    /* 4) 后台标签页：覆写 visibilityState 真实触发 hidden 分支 */
    await readAllAs('gate_a', convAB)
    await gotoRetry(page, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    await until(async () => (await page.locator('.bubble').count()) > 0, 15_000)
    await page.waitForTimeout(1500)
    const visHidden = await setVisibility(page, 'hidden')
    check('前置：已把页面 visibilityState 切到 hidden', visHidden.state === 'hidden',
      JSON.stringify(visHidden))
    const s4 = await sendAs('gate_b', convAB, '后台标签页收到、不得自动已读的消息')
    check('前置：B 发送成功（后台场景）', s4 !== null, `seq=${s4}`)
    await page.waitForTimeout(2500)
    const uBg = await unreadOf('gate_a', convAB)
    check('后台标签页(hidden)收到消息未被自动已读', uBg > 0, `unreadCount=${uBg}`)

    // 先恢复可见再截图：screenshot 在自造的 hidden 状态下不稳定，且证据要的是「后台期间的未读」
    const visVisible = await setVisibility(page, 'visible')
    check('前置：恢复 visibilityState=visible', visVisible.state === 'visible',
      JSON.stringify(visVisible))
    await shot(page, 'fe01-background-hidden')
    const caughtUp = await until(async () => (await unreadOf('gate_a', convAB)) === 0, 12_000)
    check('回到前台后补上已读', caughtUp, `unreadCount=${await unreadOf('gate_a', convAB)}`)

    /* 5) 离开正文后新消息重新计未读 */
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await readAllAs('gate_a', convAB)
    await page.waitForTimeout(1200)
    const s5 = await sendAs('gate_b', convAB, '离开正文后收到、应重新计未读的消息')
    check('前置：B 发送成功（离开正文场景）', s5 !== null, `seq=${s5}`)
    await page.waitForTimeout(2500)
    const u5 = await unreadOf('gate_a', convAB)
    check('离开正文后新消息重新计未读', u5 > 0, `unreadCount=${u5}`)
    const badge5 = await badgeText(page)
    check('离开正文后列表红点出现', badge5 !== '', `badge="${badge5}"`)
    await shot(page, 'fe01-leave-pane')

    await ctx.close()
  }

  /* ═══ FE-02：已读失败回滚（429 / 断网 / 并发反例 / 恢复重试） ═══ */
  group('FE-02 已读失败回滚（429 / 断网 / 并发反例）')
  {
    const { ctx, page } = await contextAs(browser, 'gate_a')
    await ensureShell(page)

    /* 1) 429 */
    await readAllAs('gate_a', convAB)
    await sendAs('gate_b', convAB, '用于 429 回滚验证的消息')
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await until(async () => (await page.locator('.item').count()) > 0, 15_000)
    await page.waitForTimeout(1500)
    const badge429Before = await badgeText(page)
    check('前置：429 场景列表有未读', badge429Before !== '', `badge="${badge429Before}"`)

    await page.route('**/api/v1/conversations/*/read', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: '注入的限流' } }),
      }),
    )
    await openConv(page, '闸门 B')
    await page.waitForTimeout(2500)
    const u429 = await unreadOf('gate_a', convAB)
    check('已读 429 后服务端仍未读（未伪装成功）', u429 > 0, `unreadCount=${u429}`)
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await page.waitForTimeout(1500)
    const badge429After = await badgeText(page)
    check('已读 429 后红点回滚（UI 与服务端一致）', badge429After !== '',
      `失败前="${badge429Before}" 失败后="${badge429After}"`)
    await shot(page, 'fe02-429-rollback')
    await page.unroute('**/api/v1/conversations/*/read')

    /* 2) 断网 */
    await readAllAs('gate_a', convAB)
    await sendAs('gate_b', convAB, '用于断网回滚验证的消息')
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await until(async () => (await page.locator('.item').count()) > 0, 15_000)
    await page.waitForTimeout(1500)
    await page.route('**/api/v1/conversations/*/read', (route) => route.abort('failed'))
    await openConv(page, '闸门 B')
    await page.waitForTimeout(2500)
    const uNet = await unreadOf('gate_a', convAB)
    check('已读上报断网后服务端仍未读', uNet > 0, `unreadCount=${uNet}`)
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await page.waitForTimeout(1500)
    const badgeNet = await badgeText(page)
    check('已读上报断网后红点回滚', badgeNet !== '', `badge="${badgeNet}"`)
    await shot(page, 'fe02-offline-rollback')
    await page.unroute('**/api/v1/conversations/*/read')

    /* 3) 并发反例：旧请求延迟失败，新请求成功 → 旧失败不得回滚新游标
     *
     * 【为什么整段可重试】隔离后端挂着全局 200 次/分钟（按 userId）的限流，矩阵跑到
     *   这里时 gate_a 的配额往往已接近用光。本段一旦中途撞上 429：列表拉不到 →
     *   `.item` 为空；历史拉不到 → 消息没渲染 → `lastSeq=0` → 一发已读都发不出去
     *   （readHits=0）。此时「旧失败不回滚新游标」根本没有前置可言，红的是环境不是产品。
     *   所以：先等配额滑过 → 跑一遍 → 若前置（两发已读 + 能读到权威未读）没建立，
     *   清场重铺数据再来，最多 3 次；3 次都建不起来才判 FAIL（诚实红灯，不伪造 PASS）。
     */
    let readHits = 0
    let uRacy = -1
    let racyBubbles = 0
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ensureNotLimited('gate_a', 90_000)
      await readAllAs('gate_a', convAB)
      const seeded = await sendAs('gate_b', convAB, `用于并发反例验证的消息（第 ${attempt} 次）`)
      if (seeded === null) {
        console.log(`   … 并发反例：第 ${attempt} 次铺数据失败（B 发送拿不到 seq），重置后重试…`)
        continue
      }
      await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
      await ensureShell(page)
      const listOk = await until(async () => (await page.locator('.item').count()) > 0, 15_000)
      if (!listOk) {
        console.log(`   … 并发反例：第 ${attempt} 次列表为空（疑似 429），重置后重试…`)
        continue
      }
      await page.waitForTimeout(1500)

      readHits = 0
      uRacy = -1
      racyBubbles = 0
      await page.route('**/api/v1/conversations/*/read', async (route) => {
        readHits += 1
        const mine = readHits
        if (mine === 1) {
          // 第一发（旧）：拖 1800ms 再返回 500
          await sleep(1800)
          await route
            .fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '注入的旧失败' } }),
            })
            .catch(() => {})
          return
        }
        // 第 2 发（新）：真实打到后端，让服务端真的落库已读游标；
        // 若在这里本地伪造 204，服务端游标不会变，断言就测不到产品逻辑。
        await route.continue().catch(() => {})
      })

      // 进入会话触发第 1 发（会被延迟）；随后立刻滚动正文触发第 2 发（立即成功）
      try {
        await openConv(page, '闸门 B')
      } catch (e) {
        await page.unroute('**/api/v1/conversations/*/read')
        console.log(
          `   … 并发反例：第 ${attempt} 次打不开会话（${String(e).slice(0, 60)}），重置后重试…`,
        )
        continue
      }
      // 消息必须真的渲染出来，否则 lastSeq=0 → 一发已读都不会发（前置不成立）
      racyBubbles = (await page.locator('.bubble').count().catch(() => 0)) || 0
      if (racyBubbles === 0) {
        await until(async () => (await page.locator('.bubble').count()) > 0, 15_000)
        racyBubbles = (await page.locator('.bubble').count().catch(() => 0)) || 0
      }
      await sleep(250)
      await page.evaluate(() => {
        const el = document.querySelector('.pane__scroll')
        if (el) {
          el.scrollTop = Math.max(0, el.scrollTop - 10)
          el.dispatchEvent(new Event('scroll'))
        }
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sleep(4000)
      await page.unroute('**/api/v1/conversations/*/read')
      await ensureNotLimited('gate_a', 90_000)
      uRacy = await unreadOf('gate_a', convAB)
      if (readHits >= 2 && uRacy >= 0) break
      console.log(
        `   … 并发反例前置未建立（第 ${attempt} 次）：read 请求数=${readHits} unreadCount=${uRacy} bubble=${racyBubbles}，重置后重试…`,
      )
    }
    check('并发反例：旧失败响应未回滚已成功的新游标（服务端仍已读）', uRacy === 0,
      `read 请求数=${readHits} unreadCount=${uRacy} bubble=${racyBubbles}`)
    check('并发反例：确实发生了两发以上已读请求（前置成立）', readHits >= 2, `read 请求数=${readHits}`)
    await shot(page, 'fe02-concurrent-race')

    /* 4) 恢复后重试成功 */
    await readAllAs('gate_a', convAB)
    await sendAs('gate_b', convAB, '恢复后应能正常已读的消息')
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await until(async () => (await page.locator('.item').count()) > 0, 15_000)
    await page.waitForTimeout(1500)
    await openConv(page, '闸门 B')
    const recovered = await until(async () => (await unreadOf('gate_a', convAB)) === 0, 12_000)
    check('拦截移除后重试成功、权威状态已读', recovered,
      `unreadCount=${await unreadOf('gate_a', convAB)}`)

    await ctx.close()
  }

  /* ═══ FE-03：双用户矩阵 ════════════════════════════════════════ */
  group('FE-03 幂等 / 排序置顶')
  {
    /* 1) 幂等：同 clientMsgId 重发不得产生重复消息 */
    const cmid = crypto.randomUUID()
    const idemText = `幂等测试消息 ${RUN}`
    const seqFirst = await sendAs('gate_c', convAC, idemText, cmid)
    const t = await tokenOf('gate_c')
    const again = await jpost(`/api/v1/conversations/${convAC}/messages`, t.token, {
      clientMsgId: cmid,
      type: 'text',
      content: idemText,
    })
    check('幂等：同 clientMsgId 重发返回 200（非 201）', again.status === 200, `status=${again.status}`)
    check('幂等：重发返回同一 seq', again.body?.seq === seqFirst,
      `首次 seq=${seqFirst} 重发 seq=${again.body?.seq}`)
    const hist = await jget(`/api/v1/conversations/${convAC}/messages?limit=100`, t.token)
    // 按 clientMsgId 精确统计（比内容匹配可靠：历史里可能有同文本的旧用例消息）
    const dupCount = (hist.body?.items ?? []).filter((m) => m.clientMsgId === cmid).length
    check('幂等：历史里只有一条（未产生重复）', dupCount === 1, `同 clientMsgId 条数=${dupCount}`)

    /* 2) 排序置顶：最后收到消息的会话排第一 */
    await sendAs('gate_c', convAC, '置顶测试：先让 AC 有动静')
    await sleep(300)
    await sendAs('gate_b', convAB, '置顶测试：AB 应是更新的')
    await sleep(300)
    const ta = await tokenOf('gate_a')
    const listA = await jget('/api/v1/conversations?limit=50&offset=0', ta.token)
    const firstId = (listA.body?.items ?? [])[0]?.id
    check('后端排序：最新消息的会话排第一', firstId === convAB,
      `first=${firstId}（期望 AB=${convAB}）`)

    const { ctx, page } = await contextAs(browser, 'gate_a')
    await ensureShell(page)
    await until(async () => (await page.locator('.item').count()) >= 2, 15_000)
    const firstItemTitle = await page.locator('.item').first().locator('.item__title').textContent()
    check('前端列表排序：最新会话在首位', (firstItemTitle ?? '').includes('闸门 B'),
      `首位标题="${firstItemTitle?.trim()}"`)
    await shot(page, 'fe03-sort-top')
    await ctx.close()
  }

  group('FE-03 分页：滚动加载历史不乱序不重复')
  {
    const PREFIX = `分页测试${RUN}`
    // 清一个干净起点：给 AB 再发 25 条（b 侧的发送配额 < 60/分，前面只发了几条）
    let sent = 0
    let failedAt = -1
    for (let i = 1; i <= 25; i += 1) {
      const seq = await sendAs('gate_b', convAB, `${PREFIX} #${i}`)
      if (seq === null) {
        failedAt = i
        break
      }
      sent += 1
    }
    check('前置：分页测试消息全部发出', failedAt === -1, `sent=${sent} failedAt=${failedAt}`)

    const { ctx, page } = await contextAs(browser, 'gate_a')
    await gotoRetry(page, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    await until(async () => (await page.locator('.bubble').count()) > 0, 20_000)
    await page.waitForTimeout(1000)

    const collect = () =>
      page.evaluate((prefix) =>
        [...document.querySelectorAll('.bubble')]
          .map((el) => (el.textContent ?? '').trim())
          .filter((t) => t.includes(prefix)), PREFIX)
      ,
      initial = await collect()
    check('分页：首屏只加载一页（<=30 条）', initial.length > 0 && initial.length <= 30,
      `首屏条数=${initial.length}`)

    // 反复滚到顶触发 beforeSeq 前翻，直到没有新消息进来
    let lastCount = initial.length
    let rounds = 0
    for (; rounds < 12; rounds += 1) {
      await page.evaluate(() => {
        const el = document.querySelector('.pane__scroll')
        if (el) {
          el.scrollTop = 0
          el.dispatchEvent(new Event('scroll'))
        }
      })
      await page.waitForTimeout(900)
      const now = await collect()
      if (now.length === lastCount) break
      lastCount = now.length
    }
    const all = await collect()
    const nums = all
      .map((t) => Number((t.match(/#(\d+)/) ?? [])[1]))
      .filter((n) => Number.isFinite(n))
    const uniqueNums = [...new Set(nums)]
    check('分页：加载到全部 25 条', nums.length >= 25, `条数=${nums.length} 滚动轮次=${rounds}`)
    check('分页：无重复消息', uniqueNums.length === nums.length,
      `总条数=${nums.length} 去重后=${uniqueNums.length}`)
    const ascending = nums.every((n, i) => i === 0 || n > nums[i - 1])
    check('分页：DOM 顺序按 seq 升序（不乱序）', ascending,
      ascending ? `首=${nums[0]} 尾=${nums.at(-1)}` : `乱序：${nums.slice(0, 12).join(',')}`)
    await shot(page, 'fe03-paging')

    // 深链刷新：刷新后仍渲染正文（历史不被清空）
    // 抗环境抖动守卫（只加等待/重试，判据不变）：dev server 偶发自行退出
    // （vite 8.3.5 的 ws 代理 write ECONNABORTED，见 docs/evidence/verify-browser.md §三），
    // 此时 reload 直接 ERR_CONNECTION_REFUSED 把整轮断掉。run-e2e.ps1 的存活看护
    // 会在 1-2s 内把服务重拉起来，所以这里隔几秒重试几次即可。
    let reloadOk = false
    for (let attempt = 0; attempt < 6 && !reloadOk; attempt += 1) {
      if (attempt > 0) await sleep(3_000)
      reloadOk = await page
        .reload({ waitUntil: 'domcontentloaded' })
        .then(() => true)
        .catch(() => false)
    }
    const afterReload =
      reloadOk && (await until(async () => (await page.locator('.bubble').count()) > 0, 20_000))
    check('深链刷新后正文仍渲染（历史未丢）', afterReload,
      `bubble=${await page.locator('.bubble').count()}${reloadOk ? '' : '（reload 重试全部失败：dev server 掉线）'}`)
    await shot(page, 'fe03-deeplink-reload')
    await ctx.close()
  }

  group('FE-03 群权限：非群主改名/踢人 403 且 UI 不渲染管理入口')
  {
    const A = await tokenOf('gate_a')
    const B = await tokenOf('gate_b')
    const C = await tokenOf('gate_c')
    const idB = (await jget('/api/v1/users?q=gate_b', A.token)).body?.items?.[0]?.id
    const idC = (await jget('/api/v1/users?q=gate_c', A.token)).body?.items?.[0]?.id
    const group = await jpost('/api/v1/conversations/group', A.token, {
      name: '矩阵群',
      memberIds: [idB, idC],
    })
    const gid = group.body?.id
    check('前置：群聊创建成功（a 为群主）', group.status === 201 && !!gid,
      `status=${group.status} id=${gid}`)

    if (gid) {
      const rename = await jpatch(`/api/v1/conversations/${gid}`, B.token, { name: '被成员改名' })
      check('非群主改名被拒（403 OWNER_REQUIRED）',
        rename.status === 403 && rename.body?.error?.code === 'OWNER_REQUIRED',
        `status=${rename.status} code=${rename.body?.error?.code}`)
      const kick = await jdel(`/api/v1/conversations/${gid}/members/${idC}`, B.token)
      check('非群主踢人被拒（403 OWNER_REQUIRED）',
        kick.status === 403 && kick.body?.error?.code === 'OWNER_REQUIRED',
        `status=${kick.status} code=${kick.body?.error?.code}`)

      // UI：成员（b）不应看到「修改群名」入口，群主（a）应看到
      // 注意：本段前两个服务端用例已经打了好几个请求，加上前面 FE-03 的密集流量，
      // gate_a/gate_b 很容易已踩在 200次/分钟的限流线上下——一旦 429，列表/详情请求被拒、
      // .info__body 不会渲染，看起来像「群主看不到管理入口」，其实是限流。
      await ensureNotLimited('gate_b')
      const { ctx: ctxB, page: pageB } = await contextAs(browser, 'gate_b')
      await gotoRetry(pageB, `${BASE}/chat/${gid}/info`, { waitUntil: 'domcontentloaded' })
      await pageB.waitForSelector('.info__body', { timeout: 15_000 }).catch(() => {})
      await pageB.waitForTimeout(1200)
      const memberSeesEdit = (await pageB.locator('.info__edit').count()) > 0
      check('UI：普通成员看不到「修改群名」按钮', !memberSeesEdit,
        `.info__edit 数量=${await pageB.locator('.info__edit').count()}`)
      await shot(pageB, 'fe03-group-member-info')
      await ctxB.close()

      await ensureNotLimited('gate_a')
      const { ctx: ctxA, page: pageA } = await contextAs(browser, 'gate_a')
      await gotoRetry(pageA, `${BASE}/chat/${gid}/info`, { waitUntil: 'domcontentloaded' })
      await pageA.waitForSelector('.info__body', { timeout: 15_000 }).catch(() => {})
      await pageA.waitForTimeout(1200)
      const ownerSeesEdit = (await pageA.locator('.info__edit').count()) > 0
      check('UI：群主看得到「修改群名」按钮', ownerSeesEdit,
        `.info__edit 数量=${await pageA.locator('.info__edit').count()}`)
      const ownerSeesRemove = (await pageA.locator('.member__remove').count()) > 0
      check('UI：群主看得到移除成员入口', ownerSeesRemove,
        `.member__remove 数量=${await pageA.locator('.member__remove').count()}`)
      await shot(pageA, 'fe03-group-owner-info')
      await ctxA.close()

      // 群主改名成功后成员侧应看到新名字（429 时等窗口滑过后重试）
      let okRename = { status: 0 }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        okRename = await jpatch(`/api/v1/conversations/${gid}`, A.token, { name: '矩阵群-已改名' })
        if (okRename.status !== 429) break
        await ensureNotLimited('gate_a')
      }
      check('群主改名成功（200）', okRename.status === 200, `status=${okRename.status}`)
      globalThis.__matrixGroupId = gid
    }
  }

  group('FE-03 草稿 / Enter 语义')
  {
    // 用手机视口做草稿与「返回列表」的切换：桌面端列表常驻、没有 .pane__back，
    // 而手机端「列表 ↔ 正文」互斥才是草稿真正可能丢的路径（正文组件被卸载）。
    const mob = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await mob.newPage()
    const cred = await tokenOf('gate_a')
    await gotoRetry(page, `${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(
      ([t, e]) => {
        localStorage.setItem('aitrance.session', t)
        localStorage.setItem('aitrance.sessionExpiresAt', e)
      },
      [cred.token, cred.expiresAt],
    )
    await gotoRetry(page, `${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(page)
    await until(async () => (await page.locator('.item').count()) >= 2, 15_000)

    /* 草稿：切换会话保留未发送文本 */
    await openConv(page, '闸门 B')
    await page.locator('.composer__input').fill('草稿保留测试：不应丢失')
    await page.waitForTimeout(500)
    await page.locator('.pane__back').click()
    await page.waitForTimeout(800)
    await openConv(page, '闸门 C')
    await page.waitForTimeout(800)
    const otherDraft = await page.locator('.composer__input').inputValue()
    check('草稿：切换到另一个会话不串内容', otherDraft === '', `另一会话输入框="${otherDraft}"`)
    await page.locator('.pane__back').click()
    await page.waitForTimeout(800)
    await openConv(page, '闸门 B')
    await page.waitForTimeout(900)
    const backDraft = await page.locator('.composer__input').inputValue()
    check('草稿：切回原会话后草稿仍在', backDraft === '草稿保留测试：不应丢失',
      `输入框="${backDraft}"`)
    await shot(page, 'fe03-draft')
    await page.locator('.composer__input').fill('')

    /* 手机视口：Enter 应换行而非发送 */
    const beforeM = await page.locator('.bubble').count()
    await page.locator('.composer__input').fill('手机 Enter 应换行')
    await page.locator('.composer__input').press('Enter')
    await page.waitForTimeout(800)
    const valueM = await page.locator('.composer__input').inputValue()
    const bubblesM = await page.locator('.bubble').count()
    check('手机视口 Enter 换行、不发送', valueM.includes('\n') && bubblesM === beforeM,
      `值=${JSON.stringify(valueM)} bubble ${beforeM}→${bubblesM}`)
    await shot(page, 'fe03-mobile-enter')
    // 发送按钮仍可发送
    await page.locator('.composer__send').click()
    const sentM = await until(async () => (await page.locator('.bubble').count()) > beforeM, 8_000)
    check('手机视口点发送键能发出', sentM, `bubble=${await page.locator('.bubble').count()}`)
    await mob.close()

    /* Enter 语义：桌面 Enter 发送 / Shift+Enter 换行 */
    const { ctx, page: pageD } = await contextAs(browser, 'gate_a')
    await gotoRetry(pageD, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    await pageD.waitForSelector('.composer__input', { timeout: 15_000 })
    await pageD.waitForTimeout(1200)

    const before = await pageD.locator('.bubble').count()
    await pageD.locator('.composer__input').fill('桌面 Enter 应发送')
    await pageD.locator('.composer__input').press('Enter')
    const sentByEnter = await until(async () => (await pageD.locator('.bubble').count()) > before, 8_000)
    const inputAfter = await pageD.locator('.composer__input').inputValue()
    check('桌面 Enter 键发送消息', sentByEnter && inputAfter === '',
      `bubble 前=${before} 后=${await pageD.locator('.bubble').count()} 输入框="${inputAfter}"`)

    const beforeShift = await pageD.locator('.bubble').count()
    await pageD.locator('.composer__input').fill('第一行')
    await pageD.locator('.composer__input').press('Shift+Enter')
    await pageD.waitForTimeout(600)
    const shiftValue = await pageD.locator('.composer__input').inputValue()
    const shiftBubbles = await pageD.locator('.bubble').count()
    check('桌面 Shift+Enter 换行且不发送', shiftValue.includes('\n') && shiftBubbles === beforeShift,
      `值=${JSON.stringify(shiftValue)} bubble ${beforeShift}→${shiftBubbles}`)
    await pageD.locator('.composer__input').fill('')
    await ctx.close()
  }

  group('FE-03 视口 × 深色主题：无横向溢出')
  {
    const VIEWS = [
      { name: '320x568', width: 320, height: 568, mobile: true },
      { name: '390x844', width: 390, height: 844, mobile: true },
      { name: '768x1024', width: 768, height: 1024, mobile: false },
      { name: '1024x768', width: 1024, height: 768, mobile: false },
      { name: '1440x900', width: 1440, height: 900, mobile: false },
    ]
    // 前序用例对 gate_a 打了大量请求，后端全局限流是「按 userId 200 次/分钟」
    // （backend/src/app.ts）——这一组密集冷启动很容易撞上，表现为会话/消息 429、正文渲染不出来。
    // 用「轮候等待 + 逐档重试」把它和真实产品缺陷区分开，并把 429 计数写进断言详情。
    await sleep(20_000)
    for (const vp of VIEWS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        ...(vp.mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
      })
      const page = await ctx.newPage()
      const rateLimited = []
      page.on('response', (res) => {
        if (res.status() === 429) rateLimited.push(res.url())
      })
      const cred = await tokenOf('gate_a')
      let ready = false
      for (let attempt = 1; attempt <= 3 && !ready; attempt += 1) {
        if (attempt > 1) {
          await sleep(25_000) // 等限流窗口滑过去再试
          rateLimited.length = 0
        }
        await gotoRetry(page, `${BASE}/login`, { waitUntil: 'domcontentloaded' })
        await page.evaluate(
          ([t, e]) => {
            localStorage.setItem('aitrance.session', t)
            localStorage.setItem('aitrance.sessionExpiresAt', e)
            localStorage.setItem('aitrance.theme', 'dark')
          },
          [cred.token, cred.expiresAt],
        )
        await gotoRetry(page, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
        ready = await page
          .waitForSelector('.pane__scroll', { timeout: 12_000 })
          .then(() => true)
          .catch(() => false)
      }
      check(`深色 ${vp.name} 正文冷启动渲染成功`, ready,
        ready
          ? ''
          : `三次重试均未渲染；期间 429 数=${rateLimited.length} ${rateLimited.slice(0, 3).join(' ')}`)
      if (!ready) {
        await shot(page, `fe03-dark-${vp.name}-FAILED`)
        await ctx.close()
        continue
      }
      await page.waitForTimeout(800)
      const m = await page.evaluate(() => ({
        theme: document.documentElement.dataset['theme'] ?? '',
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        viewW: window.innerWidth,
        bg: getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim(),
      }))
      check(`深色 ${vp.name} 主题已应用`, m.theme === 'dark', `data-theme="${m.theme}"`)
      check(`深色 ${vp.name} 无横向溢出`,
        m.docW <= m.viewW + 1 && m.bodyW <= m.viewW + 1,
        `doc=${m.docW} body=${m.bodyW} view=${m.viewW} 429数=${rateLimited.length}`)
      if (vp.mobile) await shot(page, `fe03-dark-${vp.name}`)
      await ctx.close()
    }
  }

  /* ═══ FE-04：失效回退与 refresh 死锁 ═══════════════════════════════ */
  group('FE-04 失效回退（401 / WS 4003 / refresh 死锁 / 旧 401 隔离 / 离线）')
  {
    const apiPath = (prefix) => (u) => u.pathname.startsWith(prefix)
    const only = (path) => (u) => u.pathname === path

    /* 1) 业务请求 401 → 必须回 /login，且带 next 以便登录后回原地。 */
    {
      const { ctx, page } = await contextAs(browser, 'gate_a')
      await ensureShell(page)
      await page.route(apiPath('/api/v1/'), (r) => r.fulfill(FULFILL_401))
      await gotoRetry(page, `${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
      const landed = await until(
        async () => page.locator('.auth__form').isVisible().catch(() => false),
        10_000,
      )
      const u = page.url()
      check('业务请求 401 后回到登录页', landed, `url=${u}`)
      check('401 回退带上 next 参数（登录后能回原地）', u.includes('/login') && u.includes('next='),
        `url=${u}`)
      const localCleared = await page.evaluate(() => localStorage.getItem('aitrance.session') === null)
      check('401 回退后本地凭据已清理', localCleared)
      await shot(page, 'fe04-401-relogin')
      await ctx.close()
    }

    /* 2) WS 4003（会话被服务端吊销）→ 同样回 /login，并给出 toast 提示。 */
    {
      const cred = await freshLogin('gate_a')
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await setAuthWith(page, cred)
      const shellOk = await ensureShell(page)
      if (!shellOk) {
        skip('前置：服务端注销会话成功（触发 WS 4003）', '前置失败：外壳未就绪（限流）')
        skip('WS 4003 后给出「登录状态已失效」提示', '前置失败：外壳未就绪（限流）')
        skip('WS 4003 后回到登录页', '前置失败：外壳未就绪（限流）')
        await ctx.close()
      } else {
      await sleep(2000) // 等 WS 建连完成，否则 4003 无处投递
      const logoutStatus = await page.evaluate(
        (t) => fetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } })
          .then((r) => r.status),
        cred.token,
      )
      // 契约：POST /api/v1/auth/logout 返回 200 {ok:true}（不是 204），两种都接受
      check('前置：服务端注销会话成功（触发 WS 4003）',
        logoutStatus === 200 || logoutStatus === 204, `status=${logoutStatus}`)
      const gotToast = await until(async () => {
        const texts = await page.locator('.toast').allTextContents().catch(() => [])
        return texts.some((t) => t.includes('登录状态已失效'))
      }, 8_000)
      check('WS 4003 后给出「登录状态已失效」提示', gotToast, `url=${page.url()}`)
      const backLogin = await until(async () => page.url().includes('/login'), 8_000)
      check('WS 4003 后回到登录页', backLogin, `url=${page.url()}`)
      await shot(page, 'fe04-ws-4003')
      await ctx.close()
      }
    }

    /* 3) refresh 自身 401：单飞 + 终局闸门，不得无限续期。 */
    {
      const { ctx, page } = await contextAs(browser, 'gate_a')
      await ensureShell(page)
      let refreshHits = 0
      let listHits = 0
      await page.route(only('/api/v1/auth/session/refresh'), (r) => {
        refreshHits += 1
        return r.fulfill(FULFILL_401)
      })
      await page.route(only('/api/v1/conversations'), (r) => {
        listHits += 1
        return r.fulfill(FULFILL_401)
      })
      const waitKicked = () =>
        until(async () => page.locator('.auth__form').isVisible().catch(() => false), 12_000)
      // 用 reload 而不是 goto：此时页面已在外壳内，reload 会重跑 bootstrap（fetchSession 是
      // 真实请求、不拦），再由 onMounted 打 /conversations 撞进 401 分支 → 才是本用例要的场景。
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      let kicked = await waitKicked()
      if (listHits === 0) {
        // 冷启动若撞上全局限流，fetchSession 429 → 静默跳登录，拦截一次都没命中；
        // 等窗口滑过后重来一次，避免把「没触发」误判成「产品不死循环」。
        await ensureNotLimited('gate_a', 90_000)
        await setAuth(page, 'gate_a')
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        kicked = await waitKicked()
      }
      await page.waitForTimeout(2500) // 留出「本该继续重试」的窗口
      check('前置：受保护请求确实撞到了注入的 401（单飞前提）', listHits > 0,
        `listHits=${listHits} refreshHits=${refreshHits}`)
      check('refresh 自身 401 后终止并回登录页（不死循环）', kicked, `url=${page.url()}`)
      if (listHits === 0) {
        skip('refresh 自身 401 只发起一次（单飞）', '前置未成立：受保护请求未被拦截（冷启动限流噪声）')
      } else {
        check('refresh 自身 401 只发起一次（单飞）', refreshHits >= 1 && refreshHits <= 2,
          `refreshHits=${refreshHits} listHits=${listHits}`)
      }
      await shot(page, 'fe04-refresh-401')
      await ctx.close()
    }

    /* 4) 旧代际 401 不得伤及新登录账号（isStaleAuthFailure）。 */
    {
      const credA = await freshLogin('gate_a')
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await setAuthWith(page, credA)
      let delayed = 0
      // page.route 的正则匹配的是**完整 URL**，所以不能写 /^\/api\/v1\/…/；
      // 用 predicate 对 pathname 做全等判断（与同类用例 apiPath() 的风格一致）。
      // 延迟 2600ms 是必要的：要让它落在「换账号成功之后」才能验旧代际隔离。
      const detailOnly = (u) => /^\/api\/v1\/conversations\/[^/]+$/.test(u.pathname)
      const installDetailRoute = async () => {
        await page.unroute(detailOnly).catch(() => {})
        await page.route(detailOnly, async (r) => {
          delayed += 1
          await sleep(2600)
          await r.fulfill(FULFILL_401).catch(() => {})
        })
      }
      // 抗限流守卫（只加等待/重试，判据与条数一条不变）：
      // 撞上全局限流时，冷启动的 fetchSession 会被 429 → 静默跳登录页，这次 goto 的详情请求
      // 一次都不会发出（delayed=0），随后 `.rail__tab[title="退出登录"]` 也点不到，
      // 旧写法会以 30s locator 超时异常中断整轮（FE-04 后面 30 条一条都跑不到）。
      // 现在的做法：等窗口滑过 + 重新登录进外壳 + 重装拦截 + 重试 goto，最多 3 次；
      // 仍不成立时把「前置」如实判 FAIL、把依赖它的 3 条判 SKIP（与本脚本其它段的前置守卫同风格），
      // 绝不静默放宽判据。
      let fired = false
      for (let attempt = 0; attempt < 3 && !fired; attempt += 1) {
        if (attempt > 0) {
          await page.unroute(detailOnly).catch(() => {})
          await ensureNotLimited('gate_a', 90_000)
          await setAuthWith(page, credA)
        }
        const shellOk = await ensureShell(page).then(() => true).catch(() => false)
        if (!shellOk) continue
        await installDetailRoute()
        // 用「进会话详情页」作为必打单会话详情接口的把手（点列表项可能命中 store 缓存）
        await gotoRetry(page, `${BASE}/chat/${convAC}/info`, { waitUntil: 'commit' }).catch(() => {})
        fired = await until(async () => delayed > 0, 10_000)
        if (!fired) await page.unroute(detailOnly).catch(() => {})
      }
      check('前置：确实发出了被延迟的详情请求', fired, `delayed=${delayed}`)
      // 点开退出登录用短超时 + 容错：拿不到外壳时只跳过本段依赖断言，不让异常炸掉整轮
      const logoutOpened =
        fired &&
        (await page
          .locator('.rail__tab[title="退出登录"]')
          .click({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false))
      if (!logoutOpened) {
        const why = fired ? '前置未成立：外壳内找不到退出登录入口' : '前置未成立：详情请求未发出（冷启动限流噪声）'
        skip('前置：旧 401 悬空期间完成换账号登录', why)
        skip('旧代际 401 落地后仍在新账号（未被踢回登录页）', why)
        skip('旧代际 401 不影响当前身份', why)
        await shot(page, 'fe04-stale-401-skipped')
        await ctx.close()
      } else {
        await page.waitForTimeout(300)
        await page.waitForSelector('.auth__form', { timeout: 15_000 })
        const fields = page.locator('.field__input')
        await fields.nth(0).fill('gate_b')
        await fields.nth(1).fill(PW)
        await page.locator('.auth__form .btn').click()
        const relogged = await until(async () => page.url().includes('/chat'), 15_000)
        check('前置：旧 401 悬空期间完成换账号登录', relogged, `url=${page.url()}`)
        await page.waitForTimeout(3200) // 等旧的延迟 401 落地
        const stillIn = page.url().includes('/chat')
        check('旧代际 401 落地后仍在新账号（未被踢回登录页）', stillIn, `url=${page.url()}`)
        const identity = await page.locator('.rail .avatar').first().getAttribute('title').catch(() => '')
        check('旧代际 401 不影响当前身份', identity === '闸门 B', `title=${identity}`)
        await shot(page, 'fe04-stale-401')
        await ctx.close()
      }
    }

    /* 5) 断网 / 短网络错误不得登出（status=0 不进 401 分支）。 */
    {
      const { ctx, page } = await contextAs(browser, 'gate_a')
      // 这里**不能**用 ensureShell：它的重试会 reload/重新 setAuth，而下一行装上的 abort
      // 拦截会让每次重试的导航都失败 —— 抗限流的重试与「故意断网」的用例意图直接冲突。
      // 所以：先按普通路径等外壳，只等不到时手动补一次（拦截尚未安装，此时重试是安全的）。
      let shellOk = await waitShell(page).then(() => true).catch(() => false)
      if (!shellOk) {
        await ensureNotLimited('gate_a', 90_000)
        await setAuth(page, 'gate_a')
        shellOk = await waitShell(page).then(() => true).catch(() => false)
      }
      if (!shellOk) {
        skip('断网期间不登出（仍在应用内）', '前置失败：外壳未就绪（冷启动被限流）')
        skip('断网期间本地凭据保留', '前置失败：外壳未就绪（冷启动被限流）')
      } else {
        await page.route(apiPath('/api/v1/'), (r) => r.abort('failed'))
        await page.locator('.item', { hasText: '闸门 B' }).first().click().catch(() => {})
        await page.waitForTimeout(3000)
        const loginVisible = await page.locator('.auth__form').isVisible().catch(() => false)
        check('断网期间不登出（仍在应用内）', !loginVisible && page.url().includes('/chat'),
          `url=${page.url()}`)
        const tokenKept = await page.evaluate(() => localStorage.getItem('aitrance.session') !== null)
        check('断网期间本地凭据保留', tokenKept)
        await shot(page, 'fe04-offline')
      }
      await ctx.close()
    }

    /* 6) 弹层可访问性：Tab 循环 / Esc 关闭 / 打开聚焦 / 关闭归还焦点。 */
    {
      const { ctx, page } = await contextAs(browser, 'gate_a')
      const shellReady = await ensureShell(page)
      const addBtn = page.locator('.list__add[title="发起群聊"]')
      // 不用 30s 裸 click 直接等：先短超时确认按钮真的在，失败就整段 skip，
      // 避免把「外壳虽然起来了但列表被 429 吃掉」拖成脚本异常。
      const btnReady = shellReady &&
        (await page.waitForSelector('.list__add[title="发起群聊"]', { timeout: 15_000 })
          .then(() => true).catch(() => false))
      if (!btnReady) {
        for (const n of [
          '弹层打开时焦点自动进入弹层',
          '弹层打开时焦点落在第一个可聚焦元素（非容器兜底）',
          '弹层内可聚焦元素 >= 3（Tab 循环前提）',
          '弹层 Tab 在最后一个元素处循环回首个',
          '弹层 Shift+Tab 在首个元素处循环到末尾',
          '弹层 Esc 可关闭（节点从 DOM 移除）',
          '弹层关闭后焦点归还触发按钮',
          '弹层二次打开焦点仍自动进入（往返稳定）',
          '弹层二次关闭焦点仍归还触发按钮',
        ]) skip(n, '前置失败：会话列表未渲染（限流）')
        await ctx.close()
      } else {
      // 修复复验（frontend-core 2026-10-22 13:29 改 AppModal.vue + dialogA11y.ts）：
      // 原 3 条 DEFECT（打开不聚焦 / sheet Esc 无效 / sheet Tab 逃逸）本轮全部改成**真断言**：
      //   - 不用「焦点还在容器内」这种宽松判据，而是断言文档焦点在可聚焦列表里的**精确下标**；
      //   - 「关闭」断言节点从 DOM 移除（v-if），不是 opacity:0 的假隐藏；
      //   - 「归还」断言 document.activeElement 就是触发按钮本身。
      await addBtn.click()
      await page.waitForSelector('.mask .panel', { timeout: 10_000 })
      await page.waitForTimeout(500)
      /* ① 打开瞬间焦点必须已进入弹层，且落在弹层内第一个可聚焦元素上。 */
      const openFocus = await activeIn(page, '.mask .panel')
      const openIdx = await focusedIndexIn(page, '.mask .panel')
      check('弹层打开时焦点自动进入弹层', openFocus.inside,
        `焦点=${openFocus.tag}/${openFocus.label} index=${openIdx.index}/${openIdx.count}`)
      check('弹层打开时焦点落在第一个可聚焦元素（非容器兜底）', openIdx.index === 0,
        `index=${openIdx.index}/${openIdx.count} 焦点=${openFocus.label}`)
      // 先勾一个成员，让 footer「创建」从 disabled 变可聚焦（否则 trap 的 last 不可聚焦）
      await page.locator('.create__item').first().click()
      await page.waitForTimeout(200)
      const fs = await focusables(page, '.mask .panel')
      check('弹层内可聚焦元素 >= 3（Tab 循环前提）', fs.length >= 3,
        `count=${fs.length} [${fs.join(' | ')}]`)
      /* ② Tab 在末尾应循环回首个 —— 断言焦点真的到 index 0，而不只是「还在容器内」。 */
      await focusNth(page, '.mask .panel', -1)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(200)
      const afterTab = await activeIn(page, '.mask .panel')
      const afterTabIdx = await focusedIndexIn(page, '.mask .panel')
      check('弹层 Tab 在最后一个元素处循环回首个',
        afterTab.inside && afterTabIdx.index === 0,
        `焦点=${afterTab.tag}/${afterTab.label} index=${afterTabIdx.index}/${afterTabIdx.count}`)
      /* ③ Shift+Tab 在首个应循环到末尾 —— 断言落到 index === count-1。 */
      await focusNth(page, '.mask .panel', 0)
      await page.keyboard.press('Shift+Tab')
      await page.waitForTimeout(200)
      const afterShift = await activeIn(page, '.mask .panel')
      const afterShiftIdx = await focusedIndexIn(page, '.mask .panel')
      check('弹层 Shift+Tab 在首个元素处循环到末尾',
        afterShift.inside && afterShiftIdx.count > 0 &&
          afterShiftIdx.index === afterShiftIdx.count - 1,
        `焦点=${afterShift.tag}/${afterShift.label} index=${afterShiftIdx.index}/${afterShiftIdx.count}`)
      await shot(page, 'fe04-modal-focus')
      /* ④ Esc 关闭：断言弹层节点从 DOM 移除（v-if），不是 opacity:0 假隐藏。 */
      await page.keyboard.press('Escape')
      const closed = await until(async () => (await page.locator('.mask .panel').count()) === 0, 6_000)
      const panelInvisible = !(await page.locator('.mask .panel').isVisible().catch(() => false))
      check('弹层 Esc 可关闭（节点从 DOM 移除）', closed && panelInvisible,
        `剩余节点=${await page.locator('.mask .panel').count()} visible=${!panelInvisible}`)
      /* ⑤ 关闭后焦点必须归还触发按钮。 */
      await page.waitForTimeout(400)
      const returned = await page.evaluate(() => {
        const a = document.activeElement
        return { tag: a?.tagName ?? '', title: a?.getAttribute('title') ?? '' }
      })
      check('弹层关闭后焦点归还触发按钮', returned.title === '发起群聊',
        `焦点=${returned.tag} title=${returned.title}`)
      /* ⑥ 再开再关一次，确认往返稳定（不是一次性副作用）。 */
      await addBtn.click()
      await page.waitForSelector('.mask .panel', { timeout: 10_000 })
      await page.waitForTimeout(400)
      const reopenIdx = await focusedIndexIn(page, '.mask .panel')
      check('弹层二次打开焦点仍自动进入（往返稳定）', reopenIdx.index === 0,
        `index=${reopenIdx.index}/${reopenIdx.count}`)
      await page.keyboard.press('Escape')
      await until(async () => (await page.locator('.mask .panel').count()) === 0, 6_000)
      await page.waitForTimeout(400)
      const returned2 = await page.evaluate(() => document.activeElement?.getAttribute('title') ?? '')
      check('弹层二次关闭焦点仍归还触发按钮', returned2 === '发起群聊', `title=${returned2}`)
      await ctx.close()
      }
    }

    /* 7) 手机「更多」面板：Esc / Tab 焦点管理。
     *
     * 修复复验（frontend-core 2026-10-22 13:39 改 MobileNav.vue + dialogA11y.ts）：原为
     * checkProduct 预期 DEFECT，现全部改为**真断言**（用 check，失败即计入退出码）：
     *   - Tab 不逃逸：断言焦点在 `.sheet` 可聚焦列表里的**精确下标**（末尾 Tab → 0，
     *     首个 Shift+Tab → count-1），而不是以前的「还在容器内就行」；
     *   - Esc 可关闭：断言 `.sheet` 节点从 DOM 移除（v-if）且焦点归还触发按钮。
     * 这样就不会出现「修好后流程变化便默认 SKIP」的掩盖。
     */
    {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      })
      const page = await ctx.newPage()
      await setAuth(page, 'gate_a')
      const shellOk = await ensureShell(page)
      if (!shellOk) {
        for (const n of [
          '手机「更多」面板可打开',
          '手机「更多」面板打开时焦点自动进入面板',
          '手机「更多」面板 Tab 在末尾循环回首个（不逃逸）',
          '手机「更多」面板 Shift+Tab 在首个循环到末尾',
          '手机「更多」面板 Esc 可关闭（节点从 DOM 移除）',
          '手机「更多」面板 Esc 关闭后焦点归还「更多」触发件',
          '手机「更多」面板可关闭（取消）',
        ]) skip(n, '前置失败：外壳未就绪（限流）')
        await ctx.close()
      } else {
      const moreBtn = page.locator('.mnav__tab').nth(2)
      await moreBtn.click()
      await page.waitForSelector('.sheet', { timeout: 10_000 })
      await page.waitForTimeout(400)
      check('手机「更多」面板可打开', await page.locator('.sheet').isVisible())
      /* ① 打开瞬间焦点自动进入面板，且落在首个可聚焦元素。 */
      const sheetFocus = await activeIn(page, '.sheet')
      const sheetIdx = await focusedIndexIn(page, '.sheet')
      check('手机「更多」面板打开时焦点自动进入面板',
        sheetFocus.inside && sheetIdx.index === 0,
        `焦点=${sheetFocus.tag}/${sheetFocus.label} index=${sheetIdx.index}/${sheetIdx.count}`)
      /* ② Tab 焦点不逃逸：精确断言末尾 → 首个、首个 → 末尾。 */
      const sheetFs = await focusables(page, '.sheet')
      await focusNth(page, '.sheet', -1)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(200)
      const sTab = await focusedIndexIn(page, '.sheet')
      check('手机「更多」面板 Tab 在末尾循环回首个（不逃逸）',
        sTab.count >= 3 && sTab.index === 0,
        `index=${sTab.index}/${sTab.count} 可聚焦=${sheetFs.join(' | ')}`)
      await focusNth(page, '.sheet', 0)
      await page.keyboard.press('Shift+Tab')
      await page.waitForTimeout(200)
      const sShift = await focusedIndexIn(page, '.sheet')
      check('手机「更多」面板 Shift+Tab 在首个循环到末尾',
        sShift.count >= 3 && sShift.index === sShift.count - 1,
        `index=${sShift.index}/${sShift.count}`)
      await shot(page, 'fe04-mobile-sheet')
      /* ③ Esc 关闭：断言节点移除 + 焦点归还触发按钮。 */
      await page.keyboard.press('Escape')
      const escClosed = await until(async () => (await page.locator('.sheet').count()) === 0, 6_000)
      check('手机「更多」面板 Esc 可关闭（节点从 DOM 移除）', escClosed,
        `元素数=${await page.locator('.sheet').count()}`)
      await page.waitForTimeout(400)
      const sheetReturned = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.mnav__tab')]
        const a = document.activeElement
        return {
          isMoreTab: tabs.length >= 3 && a === tabs[2],
          label: (a?.textContent ?? '').trim().slice(0, 16),
          tag: a?.tagName ?? '',
        }
      })
      check('手机「更多」面板 Esc 关闭后焦点归还「更多」触发件', sheetReturned.isMoreTab,
        `焦点=${sheetReturned.tag}/${sheetReturned.label} 是第3个tab=${sheetReturned.isMoreTab}`)
      /* ④「取消」按钮关闭（既有行为，不能因新增键盘逻辑而回归）。 */
      await moreBtn.click()
      await page.waitForSelector('.sheet', { timeout: 10_000 })
      await page.locator('.sheet__cancel').click()
      const sheetClosed = await until(async () => (await page.locator('.sheet').count()) === 0, 6_000)
      check('手机「更多」面板可关闭（取消）', sheetClosed)
      await ctx.close()
      }
    }
  }

  await browser.close()
  return finish()
}

function finish() {
  clearTimeout(hardTimer)
  const failed = results.filter((r) => !r.ok && !r.defect)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.filter((r) => r.ok && !r.skipped)
  console.log(
    `\n=== 汇总：${results.length} 项 —— 通过 ${passed.length}，失败 ${failed.length}，` +
      `产品缺陷 ${defects.length}，待验 ${skipped.length} ===`,
  )
  for (const f of failed) console.log(`  FAIL  ${f.name}  —— ${f.detail}`)
  for (const d of defects) console.log(`  DEFECT  ${d.name}  —— ${d.detail}`)
  for (const s of skipped) console.log(`  SKIP  ${s.name}  —— ${s.detail}`)
  console.log(`\n截图见 docs/evidence/matrix-*.png`)
  console.log(`数据仅写入隔离后端 ${BACKEND}，未触碰生产。`)
  console.log(`DEFECT 是产品行为不符合验收标准（不计入退出码，交由 frontend-core 修）。\n`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  clearTimeout(hardTimer)
  console.error('脚本异常：', e)
  // 崩溃时必须显式退出：只设 exitCode 时残留的 Chrome/定时器会让 node 挂住不退出。
  process.exit(1)
})
