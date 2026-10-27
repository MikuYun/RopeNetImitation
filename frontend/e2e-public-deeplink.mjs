/**
 * 公网部署验收：直连测试（针对 backend 报的 BLOCK —— 深链/刷新后历史不显示）
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 用 Playwright 驱动**本机真实 Chrome**，打开公网 http://mikuyun.xyz/chat/，
 * 跑一组 UI 级断言，重点是复现并验证修复后的「直接刷新深链」场景。
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   环境变量 BASE   默认 http://mikuyun.xyz/chat
 *   无命令行参数。账号内联在下方常量里。
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项断言结果（PASS/FAIL）+ 末尾汇总
 *   文件：  docs/evidence/public-*.png（仅截图，覆盖同名旧图）
 *   退出码：全通过 0，有失败 1
 *
 * ── 副作用（重要）────────────────────────────────────────────────
 *  1. **会在生产库创建/登录一个探针账号**：username=qja_probe，
 *     displayName=前端验收探针。已存在则走登录，不重复创建。
 *  2. 会以该账号给 QJQ（柒玖柒）发一条文本消息 —— 生产库里会留下这条消息。
 *     内容含时间戳，便于识别与清理。
 *  3. 不改任何服务端代码、不改配置、不重启任何服务。
 *  4. 截图写入本仓库 docs/evidence/（本方目录，覆盖同名文件）。
 *
 * ── 阅读本脚本需要知道的两件事 ────────────────────────────────────
 *  · 断言的是 **DOM**，不是接口返回。缺陷 1/2/3 那一轮的教训：脚本层全绿
 *    不等于 UI 正确，所以这里只看渲染结果。
 *  · 深链测试必须在**新开页面**里直接 goto 深链，不能先点进会话再刷新 ——
 *    后者会带上前一次的前端内存状态，测不出"冷启动"路径。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://mikuyun.xyz/chat'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const PROBE = { username: 'qja_probe', password: 'Probe!2345678', displayName: '前端验收探针' }

/** 全流程硬超时：任何一步卡住都不会让脚本永久挂起（运维跑脚本最怕这个）。 */
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 150_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出。最后进度见上方 PASS/FAIL。`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${name}${detail ? `  —— ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到条件成立；返回是否在超时前成立。 */
async function until(fn, timeoutMs = 10_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: resolve(SHOT_DIR, `public-${name}.png`) })
}

/* ── 会话内 API 调用：在浏览器里 fetch，自动带 localStorage 的 token ── */
// 键名与 stores/auth.ts 的 TOKEN_KEY 一致（纯字符串，非 JSON）。
//
// 【必须用绝对 URL】页面在 /chat/chat 下，相对路径 '/api/v1/...' 会被解析成
// 站点根 —— 那会打到原站 3000 的 API 上，拿到一个 200 但内容完全不相干的响应
// （踩过：好友列表查询返回空，看起来像"自动加好友没生效"）。所以这里显式拼 BASE。
const apiIn = (page, path, init = {}) =>
  page.evaluate(
    async ([url, i]) => {
      const token = localStorage.getItem('aitrance.session') ?? ''
      const r = await fetch(url, {
        ...i,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(i.headers ?? {}),
        },
      })
      const text = await r.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { status: r.status, body }
    },
    [`${BASE}${path}`, init],
  )

async function ensureAccount(page) {
  const reg = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(PROBE),
  })
  if (reg.status === 201) return { via: 'register', status: reg.status }
  if (reg.status === 409) return { via: 'exists', status: reg.status }
  return { via: 'unexpected', status: reg.status }
}

/** 在页面里登录（走真实 UI 表单，顺带验证登录页本身没坏）。 */
async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.field__input', { timeout: 15_000 })

  const inputs = page.locator('.field__input')
  await inputs.nth(0).fill(PROBE.username)
  await inputs.nth(1).fill(PROBE.password)
  await page.locator('.btn').first().click()

  const ok = await until(async () => page.url().includes('/chat') && !page.url().includes('/login'), 15_000)
  if (!ok) {
    // 把页面上的报错原文带出来 —— 否则只知道"没跳转"，不知道后端说了什么
    const err = await page.locator('.field__error').allInnerTexts().catch(() => [])
    lastLoginError = err.filter(Boolean).join(' / ') || '(页面上没有错误提示)'
  }
  return ok
}
let lastLoginError = ''

async function main() {
  console.log(`\n=== 公网直连验收  BASE=${BASE} ===\n`)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // 带上 URL —— 只记消息文本的话，"404" 是 favicon 还是接口根本分不出来
    const loc = m.location?.()
    consoleErrors.push(`${m.text()}  @${loc?.url ?? '?'}`)
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  // 404 的具体 URL —— 只看 "Failed to load resource" 无法定位是哪支资源。
  const badResponses = []
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`)
  })

  /* ── 0. WS 连接（公网 /chat/ws 是否真的连上）──────────────────── */
  const wsUrls = []
  let readyFrames = 0
  page.on('websocket', (ws) => {
    wsUrls.push(ws.url())
    ws.on('framereceived', (f) => {
      // ready 帧是服务端首个 JSON 文本帧，形如 {"v":1,"type":"ready",...}
      const p = typeof f.payload === 'string' ? f.payload : ''
      if (p.includes('"type":"ready"') || p.includes('"type": "ready"')) readyFrames += 1
    })
  })

  /* ── 1. 账号 ──────────────────────────────────────────────────── */
  const acct = await ensureAccount(page)
  check('注册探针账号（201 新建 / 409 已存在）', acct.via !== 'unexpected',
    `status=${acct.status} via=${acct.via}`)

  /* ── 2. 登录 ──────────────────────────────────────────────────── */
  const loggedIn = await login(page)
  check('登录后跳转到 /chat', loggedIn, `url=${page.url()} 页内错误="${lastLoginError}"`)
  if (!loggedIn) { await shot(page, 'login-fail'); await browser.close(); return finish() }

  /* ── 3. 自动好友（backend 冻结的 DEFAULT_FRIEND_USERNAME 行为）── */
  // 注意：后端只建**好友关系**，不建会话。所以新用户首屏会话列表是空的，
  // 要去联系人里点一下才会出现会话 —— 这里照样复现：先看有没有，没有就建。
  const friends = await apiIn(page, '/api/v1/friends')
  const qjq = (friends.body?.items ?? []).find(
    (f) => f.username === 'QJQ' || f.username === 'qjq' || f.displayName === '柒玖柒',
  )
  check('新用户自动与 QJQ 成为好友（好友关系已建立，无需审批）', !!qjq,
    `好友数=${(friends.body?.items ?? []).length}${qjq ? ` 对方=${qjq.displayName}` : ''}`)

  if (!qjq) { await shot(page, 'no-qjq'); await browser.close(); return finish() }

  let convs = await apiIn(page, '/api/v1/conversations?limit=50&offset=0')
  let convId = (convs.body?.items ?? []).find(
    (c) => c.peer?.id === qjq.id || c.peer?.username === qjq.username,
  )?.id

  if (!convId) {
    const created = await apiIn(page, '/api/v1/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ userId: qjq.id }),
    })
    convId = created.body?.id
    check('联系人 → 发起单聊（C2 建会话）', created.status === 200 || created.status === 201,
      `status=${created.status} convId=${convId}`)
  } else {
    check('与 QJQ 的单聊会话已存在', true, `convId=${convId}`)
  }

  if (!convId) { await shot(page, 'no-conv'); await browser.close(); return finish() }

  /* ── 4. 打开会话 + 发一条消息（给深链测试造出"列表有预览"）──── */
  await page.goto(`${BASE}/chat/${convId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bubble, .pane__blank', { timeout: 15_000 })
  await shot(page, 'chat')

  const stamp = `公网验收 ${new Date().toISOString().slice(11, 19)}`
  const composer = page.locator('.composer__input')
  await composer.fill(stamp)
  await page.locator('.composer__send').click()

  const sentOk = await until(async () =>
    (await page.locator('.bubble', { hasText: stamp }).count()) > 0, 12_000)
  check('发送消息后气泡出现（WS/REST 链路通）', sentOk, `内容="${stamp}"`)

  /* ── 5. WS 是否连上 ───────────────────────────────────────────── */
  // 断言依据是**连接真的打开并收到了 ready 帧**，不是 URL 里恰好含 "/chat/ws"：
  // 本机 dev 代理下 WS 也走 localhost:5174/ws，URL 里根本没有 /chat 前缀。
  // 用 Playwright 的 framereceived 抓帧，不去改生产源码埋钩子。
  const wsOk = await until(async () => readyFrames > 0, 10_000)
  check('WebSocket 已连上并收到 ready 帧', wsOk,
    `ready 帧=${readyFrames}，建连 ${wsUrls.length} 次：${wsUrls[wsUrls.length - 1] ?? '（无 ws）'}`)

  /* ── 6. ★ 核心：冷启动直连深链（backend BLOCK 的那个场景）─────── */
  // 关键：**新开一个 page**，冷启动直接 goto 深链。不走点击进入。
  const cold = await ctx.newPage()
  const coldErrors = []
  const coldBad = []
  cold.on('console', (m) => {
    if (m.type() !== 'error') return
    const loc = m.location?.()
    coldErrors.push(`${m.text()}  @${loc?.url ?? '?'}`)
  })
  cold.on('pageerror', (e) => coldErrors.push(`pageerror: ${e.message}`))
  cold.on('response', (r) => {
    if (r.status() >= 400) coldBad.push(`${r.status()} ${r.url()}`)
  })

  await cold.goto(`${BASE}/chat/${convId}`, { waitUntil: 'domcontentloaded' })

  // 等气泡渲染出来。给足时间——修复前后差别不是"慢"，是"永远不出现"。
  const bubblesAppeared = await until(async () => (await cold.locator('.bubble').count()) > 0, 20_000)
  const bubbleCount = await cold.locator('.bubble').count()
  const sawOurMsg = (await cold.locator('.bubble', { hasText: stamp }).count()) > 0

  check('冷启动直连深链：消息气泡渲染', bubblesAppeared && sawOurMsg,
    `bubble 数=${bubbleCount}，含刚发的那条=${sawOurMsg}`)

  // 负面断言：不能是"空的但也不报错"
  const blank = await cold.locator('.pane__blank').count()
  check('深链不是空态（未命中"还没有消息"占位）', blank === 0, `.pane__blank=${blank}`)

  // 空态到底是「会话不存在」还是「没有消息」——两者修法完全不同
  const emptyText = blank ? (await cold.locator('.pane__blank').first().innerText()).trim() : ''
  const paneExists = (await cold.locator('.pane').count()) > 0
  check('诊断：深链页面已识别到会话（非"会话不存在"分支）', paneExists && !emptyText.includes('会话不存在'),
    `pane=${paneExists} 空态文案="${emptyText}"`)

  // 404 明细：直接指出是哪支资源/哪个接口
  const allBad = [...badResponses, ...coldBad]
  check('无 4xx/5xx 响应', allBad.length === 0,
    allBad.slice(0, 4).join('  ‖  ') || '（无）')

  await shot(cold, 'deeplink-cold')

  /* ── 7. 浏览器刷新（F5）路径 ──────────────────────────────────── */
  await cold.reload({ waitUntil: 'domcontentloaded' })
  const afterReload = await until(async () =>
    (await cold.locator('.bubble', { hasText: stamp }).count()) > 0, 20_000)
  check('原地刷新（F5）后消息仍在', afterReload,
    `bubble 数=${await cold.locator('.bubble').count()}`)
  await shot(cold, 'deeplink-reload')

  /* ── 8. 控制台干净度 ──────────────────────────────────────────── */
  // 只留**JS 运行时**错误。"Failed to load resource" 这类纯网络层消息由上面的
  // 「无 4xx/5xx 响应」断言负责，那边带完整 URL 与状态码，更准；放在这里会
  // 因浏览器是否重发 favicon 请求而时有时无，把断言变成掷骰子。
  const realErrors = [...consoleErrors, ...coldErrors].filter(
    (e) =>
      !/Failed to load resource/i.test(e) &&
      !/favicon|Download the Vue Devtools|ResizeObserver/i.test(e),
  )
  check('无未预期的 JS 运行时错误', realErrors.length === 0,
    realErrors.slice(0, 3).join(' ‖ ') || '（无）')

  await browser.close()
  return finish()
}

function finish() {
  clearTimeout(hardTimer)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总：${results.length} 项断言，${failed.length} 项失败 ===`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL  ${f.name}  —— ${f.detail}`)
  }
  console.log('\n提示：本脚本在生产库留下了探针账号 qja_probe 与一条消息，')
  console.log('      清理方式见交付说明（需 backend 执行，本方不跨目录操作）。\n')
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exitCode = 1
})
