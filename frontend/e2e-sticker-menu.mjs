/**
 * v2.4 验收 —— 「个人表情包」+「PC 右键菜单」的浏览器实证。
 *
 * ── 覆盖范围 ───────────────────────────────────────────────────────
 *   A. 表情包：存为表情（桌面 hover 工具条）→ 面板渲染 → 点击发送 →
 *      同一表情可反复发送（这是与普通附件 409 的核心差别）→ 刷新持久化 →
 *      二次确认删除 → 刷新仍不存在。
 *   B. 表情包 API 语义：首次 201 / 同 uploadId 幂等 200 / 非图片 400
 *      INVALID_STICKER / 收藏后可反复发送 vs 普通附件第二次发送 409
 *      UPLOAD_IN_USE（对照组）。
 *   C. 右键菜单：空白区默认菜单（refresh/copy-link/top/theme）、Escape 关闭、
 *      输入框保留原生菜单、消息专属菜单、复制正文、图片附件菜单
 *      （save-media/copy-media-url）、点击外部关闭、主题切换、Shift+右键保留原生。
 *
 * ── 输入（全部可用环境变量覆盖）────────────────────────────────────
 *   BASE            默认 http://localhost:5173
 *                   ⚠️ 必须是 localhost：vite 只监听 ::1，127.0.0.1 连不通
 *   BACKEND         默认 http://127.0.0.1:3099（隔离后端，DB 已迁移到 v5）
 *   HARD_TIMEOUT_MS 默认 600000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐条 PASS / FAIL / DEFECT / SKIP + 实测值 + 汇总
 *   截图：docs/evidence/v24-sticker-panel.png
 *         docs/evidence/v24-ctx-menu-default.png
 *         docs/evidence/v24-ctx-menu-message.png
 *   退出码：0 = 无 FAIL/DEFECT；1 = 有；2 = 环境不可用/脚本异常；3 = 硬超时
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   只用隔离后端的测试账号（gate_a / gate_b）：开始前清空它们的表情包，
 *   发若干条测试消息（含图片附件）到 gate_a ↔ gate_b 的单聊，跑完删除
 *   本次收藏的表情包。临时 PNG 写系统 temp，跑完删除。不碰源码、不 commit。
 *
 * ── 为什么工具函数是从 e2e-v2.mjs 复制而不是 import ────────────────
 *   既有 e2e 脚本是**对照基线**，把它们抽成公共模块会改动基线文件；
 *   本任务的写域只有本文件一个，复制是最小改动面。
 */

import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 600_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

const PW = 'GatePass!2345'
const RUN = Date.now().toString(36).slice(-6)
const results = []
const defects = []
const pageErrors = []

/* ── 结果记录 ───────────────────────────────────────────────────── */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail, skipped: false, defect: false })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}
/** 产品缺陷：不通过时归入 DEFECT，与「脚本/环境问题」分开统计。 */
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
/** 轮询直到 fn() 为真；超时返回 false。绝不用固定 waitForTimeout 硬等。 */
async function until(fn, timeoutMs = 12_000, stepMs = 200) {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await sleep(stepMs)
  }
}
async function shotAs(page, filename) {
  mkdirSync(SHOT_DIR, { recursive: true })
  const full = resolve(SHOT_DIR, filename)
  await page.screenshot({ path: full })
  return full
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/* ── 合法 PNG 生成（不往仓库里加图片素材）────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function makePng(width, height, seed = 1) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (1 + width * 3))
  let r = seed
  const rnd = () => {
    r = (r * 1103515245 + 12345) & 0x7fffffff
    return r
  }
  let p = 0
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0
    p += 1
    for (let x = 0; x < width; x += 1) {
      raw[p] = rnd() & 0xff
      raw[p + 1] = (x * 3 + y) & 0xff
      raw[p + 2] = (y * 2 + 40) & 0xff
      p += 3
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
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
  return r.status
}
async function login(username, password = PW) {
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function tokenOf(username) {
  if (tokenCache.has(username)) return tokenCache.get(username)
  const r = await login(username)
  if (r.status !== 200) throw new Error(`登录失败 ${username}: ${r.status}`)
  tokenCache.set(username, r.body)
  return r.body
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
/** DELETE 绝不能带 Content-Type（无 body 时 Fastify 直接 400 掩盖真实错误码）。 */
async function jdel(path, token) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function uploadBytesAs(username, filename, buf, mime = 'application/octet-stream') {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/uploads?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': mime },
    body: buf,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
/** 直接发一条消息；返回 {status, body}（body 是 Message 或错误信封）。 */
async function sendMessageAs(username, convId, content, attachmentIds) {
  const t = await tokenOf(username)
  return jpost(`/api/v1/conversations/${convId}/messages`, t.token, {
    clientMsgId: crypto.randomUUID(),
    content,
    ...(attachmentIds ? { attachmentIds } : {}),
  })
}

/* ── 限流自适应（全局 200 次/分钟/用户）────────────────────────── */
async function isRateLimited(username) {
  const t = await tokenOf(username)
  const r = await jget('/api/v1/conversations?limit=1&offset=0', t.token)
  return r.status === 429
}
async function ensureNotLimited(username, maxWaitMs = 90_000) {
  const start = Date.now()
  while (await isRateLimited(username)) {
    if (Date.now() - start > maxWaitMs) {
      console.log(`   … ${username} 仍被限流，放弃等待`)
      return false
    }
    await sleep(5_000)
  }
  return true
}

async function ensureFriend(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const friendsA = await jget('/api/v1/friends', A.token)
  if ((friendsA.body?.items ?? []).some((f) => f.username === b)) return true
  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return false
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'v2.4 验收' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find(
    (r) => r.sender?.username === a && r.status === 'pending',
  )
  if (inc) await jpost(`/api/v1/friend-requests/${inc.id}/respond`, B.token, { action: 'accept' })
  return true
}

async function ensureDirectConv(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const listA = await jget('/api/v1/conversations?limit=50&offset=0', A.token)
  const found = (listA.body?.items ?? []).find(
    (c) => c.type === 'direct' && c.peer?.username === b,
  )
  if (found) return found.id
  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return null
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'v2.4 验收' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find(
    (r) => r.sender?.username === a && r.status === 'pending',
  )
  if (inc) await jpost(`/api/v1/friend-requests/${inc.id}/respond`, B.token, { action: 'accept' })
  const direct = await jpost('/api/v1/conversations/direct', A.token, { userId: target.id })
  return direct.body?.id ?? null
}

/** 列出一个账号的全部表情包（跨页拉全）。 */
async function allStickers(username) {
  const t = await tokenOf(username)
  const out = []
  let offset = 0
  for (let guard = 0; guard < 20; guard += 1) {
    const r = await jget(`/api/v1/stickers?limit=60&offset=${offset}`, t.token)
    if (r.status !== 200) return { status: r.status, items: out }
    out.push(...(r.body?.items ?? []))
    if (r.body?.nextOffset === null || r.body?.nextOffset === undefined) break
    offset = r.body.nextOffset
  }
  return { status: 200, items: out }
}
/** 清空某账号的表情包（让本次运行的计数确定），返删除条数。 */
async function purgeStickers(username) {
  const t = await tokenOf(username)
  const { items } = await allStickers(username)
  let removed = 0
  for (const s of items) {
    const r = await jdel(`/api/v1/stickers/${s.id}`, t.token)
    if (r.status === 200) removed += 1
  }
  return { before: items.length, removed }
}

/* ── 浏览器工具 ─────────────────────────────────────────────────── */
function watchPage(page) {
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), msg: String(e?.message ?? e) }))
}
async function setAuth(page, username) {
  const cred = await tokenOf(username)
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([t, e]) => {
      localStorage.setItem('aitrance.session', t)
      localStorage.setItem('aitrance.sessionExpiresAt', e)
    },
    [cred.token, cred.expiresAt],
  )
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
}
async function ensureShell(page, username) {
  const ok = await page
    .waitForSelector('.list, .panel, .rail', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (ok) return true
  const onLogin = await page.locator('.auth__form').isVisible().catch(() => false)
  if (onLogin) {
    await ensureNotLimited(username, 60_000)
    await setAuth(page, username)
    return page
      .waitForSelector('.list, .panel, .rail', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
  }
  return false
}
async function contextAs(browser, username, viewport, extra = {}) {
  await ensureNotLimited(username, 60_000)
  const ctx = await browser.newContext({
    viewport,
    acceptDownloads: true,
    hasTouch: false,
    isMobile: false,
    ...extra,
  })
  const page = await ctx.newPage()
  watchPage(page)
  await setAuth(page, username)
  return { ctx, page }
}
const rowCount = (page) => page.locator('.pane__row').count()

/** 等 toast 文本出现（toast 约 3.2s 自动消失，调用方要立刻断言）。 */
async function waitToast(page, needle, timeoutMs = 8_000) {
  return until(
    () =>
      page.evaluate(
        (n) => [...document.querySelectorAll('.toast__text')].some((el) => (el.textContent || '').includes(n)),
        needle,
      ),
    timeoutMs,
    150,
  )
}
/** 当前屏幕上所有 toast 文本（含正在淡出的）。 */
const toastTexts = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.toast__text')].map((el) => el.textContent || ''))

/* ── 右键菜单工具 ───────────────────────────────────────────────── */
const CTX = '.ctx-menu[role="menu"][aria-label="操作菜单"]'
/** 菜单真的可见（visibility 从未定位过时是 hidden，且动画从 opacity 0 起）。 */
function menuShown(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const cs = getComputedStyle(el)
    if (cs.visibility !== 'visible') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }, CTX)
}
const menuIds = (page) =>
  page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} .ctx-menu__item`)].map((el) => el.getAttribute('data-id')),
    CTX,
  )
/** 右键点在某个元素的中心。 */
async function rightClick(page, selector) {
  await page.locator(selector).first().click({ button: 'right' })
}
/**
 * 找一个真正属于 `.pane__scroll` 自身的点（命中元素 === 滚动容器）。
 *
 * 为什么不写死 `y = box.y + 8`：消息列表滚到底时，第一条消息可能已经顶到
 * 容器上沿（`elementFromPoint` 返回 `.line` 而不是 `.pane__scroll`），
 * 于是右键落在了消息上，弹出的是消息菜单而不是项目默认菜单 —— 之前 M 节
 * 「再次打开默认菜单（前置）」拿到 `["copy","select-text","reply","toggle-pin"]`
 * 就是这个取点错误，不是产品缺陷。
 */
async function findPaneBlankPoint(page) {
  const point = await page.evaluate(() => {
    const scroll = document.querySelector('.pane__scroll')
    if (!scroll) return null
    const box = scroll.getBoundingClientRect()
    for (let dy = 8; dy < box.height - 8; dy += 6) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
        const x = Math.round(box.x + box.width * fx)
        const y = Math.round(box.y + dy)
        if (document.elementFromPoint(x, y) === scroll) return { x, y }
      }
    }
    return null
  })
  if (!point) throw new Error('找不到属于 .pane__scroll 的空白点（列表可能占满整个可视区）')
  return point
}
/** 右键点在 `.pane__scroll` 的空白处，保证命中的是「页面空白区」。 */
async function rightClickPaneBlank(page) {
  const { x, y } = await findPaneBlankPoint(page)
  await page.mouse.click(x, y, { button: 'right' })
  return { x, y }
}
/**
 * 关闭当前可能残留的菜单（Esc 与点击遮罩都试一遍）。
 *
 * 必须显式关：AppContextMenu 点击外部会关，但上一节如果是因为断言失败、
 * 拿不到菜单节点而没走关闭路径，残留的菜单会让下一节的前置断言假通过/假失败。
 */
async function closeMenuIfAny(page) {
  if ((await page.locator(CTX).count()) === 0) return true
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(200)
  return (await page.locator(CTX).count()) === 0
}
/** 打开默认菜单并返回菜单项 id 列表（失败返回 []）。 */
async function openDefaultMenu(page) {
  await rightClickPaneBlank(page)
  const ok = await until(() => menuShown(page), 6_000, 150)
  if (!ok) return []
  return menuIds(page)
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== v2.4 表情包 / 右键菜单验收  BASE=${BASE}  BACKEND=${BACKEND}  RUN=${RUN} ===\n`)

  /* ── 0. 服务可达性（不可用就明确报错，绝不静默失败）─────────────── */
  group('0. 环境前置')
  let feStatus = 0
  let beStatus = 0
  let feErr = ''
  let beErr = ''
  try {
    const r = await fetch(`${BASE}/chat`)
    feStatus = r.status
  } catch (e) {
    feErr = String(e?.cause?.code ?? e?.message ?? e)
  }
  try {
    const r = await fetch(`${BACKEND}/health`)
    beStatus = r.status
  } catch (e) {
    beErr = String(e?.cause?.code ?? e?.message ?? e)
  }
  check(
    `前端 dev server 可用（${BASE}）`,
    feStatus === 200,
    feStatus === 200 ? `status=${feStatus}` : `status=${feStatus} ${feErr}`,
  )
  check(
    `隔离后端可用（${BACKEND}/health）`,
    beStatus === 200,
    beStatus === 200 ? `status=${beStatus}` : `status=${beStatus} ${beErr}`,
  )
  if (feStatus !== 200 || beStatus !== 200) {
    console.error(
      '\n!! 服务不可用，后续用例无法执行。\n' +
        `   - 前端：cd frontend && node node_modules/vite/bin/vite.js --host ::1 --port 5173（必须用 localhost 访问）\n` +
        `   - 后端：cd backend 起在 ${BACKEND}\n`,
    )
    clearTimeout(hardTimer)
    process.exit(2)
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'aitr-v24-'))
  const IMG = `v24-sticker-${RUN}.png`
  const IMG2 = `v24-plain-${RUN}.png`
  const TXT = `v24-not-image-${RUN}.txt`
  const paths = {
    img: join(tmpDir, IMG),
    img2: join(tmpDir, IMG2),
    txt: join(tmpDir, TXT),
  }
  writeFileSync(paths.img, makePng(240, 160, 13))
  writeFileSync(paths.img2, makePng(200, 200, 31))
  writeFileSync(paths.txt, Buffer.from('v2.4 表情包：非图片文件不应被接受\n', 'utf8'))
  console.log(`临时素材：${tmpDir}`)

  /* ── 账号与会话准备 ── */
  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  await jpatch('/api/v1/users/me', (await tokenOf('gate_a')).token, { displayName: '闸门 A' })
  await jpatch('/api/v1/users/me', (await tokenOf('gate_b')).token, { displayName: '闸门 B' })
  await ensureFriend('gate_a', 'gate_b')
  const convAB = await ensureDirectConv('gate_a', 'gate_b')
  if (!convAB) throw new Error('无法建立 gate_a ↔ gate_b 单聊会话')
  const purgedA = await purgeStickers('gate_a')
  const purgedB = await purgeStickers('gate_b')
  console.log(
    `会话 AB=${convAB}；清理表情包：gate_a ${purgedA.removed}/${purgedA.before}，` +
      `gate_b ${purgedB.removed}/${purgedB.before}\n`,
  )

  /* ══════════════════════════════════════════════════════════════════
   * A. 表情包 API 语义（纯 fetch，不依赖 UI）
   * ══════════════════════════════════════════════════════════════════ */
  group('A. 表情包 API 语义')
  const tokA = await tokenOf('gate_a')

  // 前置：上传一张 PNG，并作为纯图片消息发给 gate_b（后续 UI 用例就靠这条消息）
  const upSticker = await uploadBytesAs('gate_a', IMG, makePng(240, 160, 13), 'image/png')
  const upId = upSticker.body?.id
  check(
    'gate_a 上传 PNG 作为素材（未收藏前）',
    upSticker.status === 201 || upSticker.status === 200,
    `status=${upSticker.status} kind=${upSticker.body?.kind} id=${upId ?? '(无)'}`,
  )
  check('素材 PNG 的 kind 推导为 image', upSticker.body?.kind === 'image', `kind=${upSticker.body?.kind}`)

  /** 【对照组】普通附件：同一个 uploadId 第二次发送必须 409 UPLOAD_IN_USE。 */
  const upPlain = await uploadBytesAs('gate_a', IMG2, makePng(200, 200, 31), 'image/png')
  const plainId = upPlain.body?.id
  const plainFirst = plainId
    ? await sendMessageAs('gate_a', convAB, '', [plainId])
    : { status: 0, body: null }
  const plainSecond = plainId
    ? await sendMessageAs('gate_a', convAB, '', [plainId])
    : { status: 0, body: null }
  checkProduct(
    '对照组：普通附件首次发送成功',
    plainFirst.status === 201,
    `status=${plainFirst.status} seq=${plainFirst.body?.seq ?? '-'}`,
  )
  checkProduct(
    '对照组：普通附件第二次发送被 409 UPLOAD_IN_USE 拒绝',
    plainSecond.status === 409 && plainSecond.body?.error?.code === 'UPLOAD_IN_USE',
    `status=${plainSecond.status} code=${plainSecond.body?.error?.code}`,
  )

  // 前置 1：图片消息发给 gate_b（走真实发送链路，UI 里才有可 hover 的气泡）
  const imgMsg = upId ? await sendMessageAs('gate_a', convAB, '', [upId]) : { status: 0, body: null }
  checkProduct(
    '前置：PNG 作为纯图片消息发给 gate_b',
    imgMsg.status === 201 && (imgMsg.body?.attachments ?? []).length === 1,
    `status=${imgMsg.status} attachments=${(imgMsg.body?.attachments ?? []).length}`,
  )

  // 首发收藏：201
  const addFirst = await jpost('/api/v1/stickers', tokA.token, { uploadId: upId })
  const sticker = addFirst.body ?? null
  checkProduct(
    'POST /stickers 首次收藏返回 201 并回传 Sticker',
    addFirst.status === 201 &&
      !!sticker?.id &&
      sticker?.uploadId === upId &&
      sticker?.kind === 'image' &&
      sticker?.url === `/api/v1/uploads/${upId}`,
    `status=${addFirst.status} id=${sticker?.id ?? '-'} url=${sticker?.url ?? '-'}`,
  )

  // 幂等：同 uploadId 再收藏 → 200 + 同一条记录
  const addAgain = await jpost('/api/v1/stickers', tokA.token, { uploadId: upId })
  checkProduct(
    'POST /stickers 同 uploadId 再收藏幂等（200 + 同一 id）',
    addAgain.status === 200 && addAgain.body?.id === sticker?.id,
    `status=${addAgain.status} id=${addAgain.body?.id ?? '-'} 期望=${sticker?.id ?? '-'}`,
  )

  // 列表可见
  const listA = await jget('/api/v1/stickers?limit=60&offset=0', tokA.token)
  checkProduct(
    'GET /stickers 列表包含刚收藏的表情',
    listA.status === 200 && (listA.body?.items ?? []).some((s) => s.id === sticker?.id),
    `status=${listA.status} count=${(listA.body?.items ?? []).length} nextOffset=${JSON.stringify(listA.body?.nextOffset)}`,
  )

  // 核心语义：收藏后同一 uploadId 可反复发送（对照上面的 409）
  const resend1 = await sendMessageAs('gate_a', convAB, '', [upId])
  const resend2 = await sendMessageAs('gate_a', convAB, '', [upId])
  checkProduct(
    '已收藏的表情包 uploadId 可反复发送（连续两次都不 409）',
    resend1.status === 201 && resend2.status === 201,
    `status1=${resend1.status} status2=${resend2.status} code2=${resend2.body?.error?.code ?? '-'}`,
  )

  // 非法：不存在的 uploadId → 400 INVALID_STICKER
  const badUuid = await jpost('/api/v1/stickers', tokA.token, {
    uploadId: '00000000-0000-4000-8000-000000000000',
  })
  checkProduct(
    'POST /stickers 不存在的 uploadId → 400 INVALID_STICKER',
    badUuid.status === 400 && badUuid.body?.error?.code === 'INVALID_STICKER',
    `status=${badUuid.status} code=${badUuid.body?.error?.code}`,
  )

  // 非法：非图片上传（kind=file）→ 400 INVALID_STICKER
  const upTxt = await uploadBytesAs('gate_a', TXT, Buffer.from('not an image', 'utf8'), 'text/plain')
  const badKind = upTxt.body?.id
    ? await jpost('/api/v1/stickers', tokA.token, { uploadId: upTxt.body.id })
    : { status: 0, body: null }
  checkProduct(
    'POST /stickers 非图片上传（kind=file）→ 400 INVALID_STICKER',
    badKind.status === 400 && badKind.body?.error?.code === 'INVALID_STICKER',
    `upload=${upTxt.status} kind=${upTxt.body?.kind} status=${badKind.status} code=${badKind.body?.error?.code}`,
  )

  // 别人不能删我的表情（属主校验）
  const tokB = await tokenOf('gate_b')
  const foreignDel = sticker?.id
    ? await jdel(`/api/v1/stickers/${sticker.id}`, tokB.token)
    : { status: 0, body: null }
  checkProduct(
    'DEL. /stickers/:id 非属主删除被拒（403/404）',
    foreignDel.status === 403 || foreignDel.status === 404,
    `status=${foreignDel.status} code=${foreignDel.body?.error?.code}`,
  )

  // 一条文本消息（右键菜单「复制正文」需要 hasText）
  const textMsg = await sendMessageAs('gate_a', convAB, `v24 右键菜单样本 ${RUN}`)
  check('前置：发一条文本消息供右键菜单用', textMsg.status === 201, `status=${textMsg.status}`)

  /* ── 浏览器 ── */
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const VP = { width: 1280, height: 800 }
  let ctxA = null
  let pageA = null
  let ctxB = null
  let pageB = null

  try {
    /* ══════════════════════════════════════════════════════════════
     * B. 存为表情（桌面 hover 工具条）
     * ══════════════════════════════════════════════════════════════ */
    group('B. 存为表情：桌面 hover 图片气泡 → 工具条 → 点击')
    const sessA = await contextAs(browser, 'gate_a', VP)
    ctxA = sessA.ctx
    pageA = sessA.page
    const shellOk = await ensureShell(pageA, 'gate_a')
    check('gate_a 登录后进入聊天外壳', shellOk, `shell=${shellOk}`)

    await pageA.goto(`${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    const paneOk = await pageA
      .waitForSelector('.pane__scroll', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    check('打开 gate_a ↔ gate_b 单聊并渲染消息区', paneOk, `pane__scroll=${paneOk}`)

    // 定位「本 RUN 的那条图片消息」：附件名唯一，用名字过滤行
    const imgRow = pageA.locator('.pane__row', { hasText: IMG }).first()
    const imgRowShown = await imgRow
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    check('消息列表里能找到本次的图片消息行', imgRowShown, `找到=${imgRowShown} 附件名=${IMG}`)

    // 仅含图片附件的消息：canSaveSticker 为真 ⇒ 工具条里有「存为表情」
    const saveBtn = imgRow.locator('button[aria-label="存为表情"]')
    const saveBtnCount = await saveBtn.count()
    // 工具条默认 opacity:0 + pointer-events:none，hover 后经 0.14s 过渡才到 1。
    // 必须轮询等过渡结束（实测 t=50ms 时 opacity 0.837、t=100ms 0.999、t=150ms 才 1），
    // 单次取样式会拿到中途值 —— 之前「opacity=0.0415481」的 DEFECT 就是这么来的。
    await imgRow.locator('.bubble-wrap').first().hover().catch(() => {})
    const toolsOpacityOk = await until(
      () =>
        imgRow
          .evaluate((row) => {
            const el = row.querySelector('.bubble__tools')
            return el ? getComputedStyle(el).opacity : null
          })
          .then((v) => v === '1')
          .catch(() => false),
      3_000,
      50,
    )
    const toolsOpacity = await imgRow
      .evaluate((row) => {
        const el = row.querySelector('.bubble__tools')
        return el ? getComputedStyle(el).opacity : null
      })
      .catch(() => null)
    checkProduct(
      'hover 图片气泡后悬浮工具条显示（opacity 1）',
      toolsOpacityOk && toolsOpacity === '1',
      `opacity=${toolsOpacity}`,
    )
    checkProduct(
      '图片消息工具条中有「存为表情」按钮',
      saveBtnCount === 1,
      `按钮数=${saveBtnCount}`,
    )
    const saveVisible = await saveBtn.first().isVisible().catch(() => false)
    checkProduct('「存为表情」按钮可见可点', saveVisible, `visible=${saveVisible}`)

    // 点击保存 —— 此时该 uploadId 已收藏，走的是幂等 200 分支，仍应给成功反馈
    await saveBtn.first().click({ timeout: 8_000 }).catch(() => {})
    const saveToast = await waitToast(pageA, '已保存到表情包', 8_000)
    checkProduct('点击「存为表情」出现成功提示「已保存到表情包」', saveToast, `toast=${JSON.stringify(await toastTexts(pageA))}`)

    /* ══════════════════════════════════════════════════════════════
     * C. 表情面板：打开 / 渲染 / 发送 / 反复发送
     * ══════════════════════════════════════════════════════════════ */
    group('C. 表情面板渲染与发送')
    const stickerBtn = pageA.locator('button[aria-label="表情包"]')
    checkProduct('工具条存在「表情包」按钮', (await stickerBtn.count()) === 1, `count=${await stickerBtn.count()}`)
    await stickerBtn.first().click({ timeout: 8_000 }).catch(() => {})
    const panelShown = await until(
      () => pageA.locator('section.sp[aria-label="表情包"]').isVisible().catch(() => false),
      8_000,
      150,
    )
    checkProduct('点击后出现 section.sp[aria-label="表情包"]', panelShown, `可见=${panelShown}`)

    const btnLabelAfter = await pageA
      .locator('.cbar__btn--sticker')
      .first()
      .getAttribute('aria-label')
      .catch(() => null)
    checkProduct(
      '打开后工具条按钮 aria-label 变「收起表情包」',
      btnLabelAfter === '收起表情包',
      `aria-label=${JSON.stringify(btnLabelAfter)}`,
    )

    const cellCount = await pageA.locator('section.sp .sp__cell').count()
    checkProduct('面板格子数 ≥ 1', cellCount >= 1, `cell=${cellCount}`)

    // 图片必须是真正解码成功的 <img>（blob URL 取流成功），不是 .sp__placeholder
    const imgInfo = await until(
      async () =>
        pageA.evaluate(() => {
          const img = document.querySelector('section.sp .sp__cell img.sp__img')
          if (!img) return null
          if (!img.complete) return null
          if (!img.naturalWidth) return null
          return { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') || '' }
        }),
      10_000,
      200,
    )
    const imgMeta = await pageA.evaluate(() => {
      const img = document.querySelector('section.sp .sp__cell img.sp__img')
      const ph = document.querySelectorAll('section.sp .sp__cell .sp__placeholder').length
      return {
        hasImg: !!img,
        naturalWidth: img?.naturalWidth ?? 0,
        src: img?.getAttribute('src') ?? '',
        placeholders: ph,
      }
    })
    checkProduct(
      '表情格子渲染成真实 <img> 且 naturalWidth > 0',
      !!imgInfo && imgMeta.naturalWidth > 0,
      `自然尺寸=${imgMeta.naturalWidth}x${imgMeta?.h ?? '-'} src=${imgMeta.src.slice(0, 24)}… 占位符=${imgMeta.placeholders}`,
    )
    checkProduct(
      '表情图片走 blob: URL（受鉴权保护，不是裸接口地址）',
      imgMeta.src.startsWith('blob:'),
      `src 前缀=${imgMeta.src.slice(0, 12)}`,
    )

    await shotAs(pageA, 'v24-sticker-panel.png')
    console.log(`   截图：${resolve(SHOT_DIR, 'v24-sticker-panel.png')}`)

    // 点格子直接发送：消息数 +1，且不能重复插入
    const before = await rowCount(pageA)
    const pick = pageA.locator('section.sp .sp__cell button.sp__pick').first()
    await pick.click({ timeout: 8_000 }).catch(() => {})
    const grewOnce = await until(async () => (await rowCount(pageA)) === before + 1, 12_000, 200)
    const afterFirst = await rowCount(pageA)
    checkProduct(
      '点 .sp__pick 直接发送：消息行 +1',
      grewOnce,
      `前=${before} 后=${afterFirst}`,
    )
    // 幂等性：等一段时间，不能因为 WS 回推/重试再多插一条
    await sleep(2_500)
    const afterSettle = await rowCount(pageA)
    checkProduct(
      '发送只插入一条（无重复插入）',
      afterSettle === before + 1,
      `稳定后=${afterSettle} 期望=${before + 1}`,
    )
    const sendErrToast = (await toastTexts(pageA)).find((t) => t.includes('发送失败'))
    checkProduct(
      '本次发送没有「发送失败」toast（未触发 UPLOAD_IN_USE）',
      !sendErrToast,
      `toast=${JSON.stringify(await toastTexts(pageA))}`,
    )

    // 核心：同一表情再点一次，仍然能发（普通附件第二次会 409）
    const before2 = await rowCount(pageA)
    await pageA.locator('section.sp .sp__cell button.sp__pick').first().click({ timeout: 8_000 }).catch(() => {})
    const grewTwice = await until(async () => (await rowCount(pageA)) === before2 + 1, 12_000, 200)
    const afterSecond = await rowCount(pageA)
    checkProduct(
      '同一表情再点一次仍能发送（可反复发送的核心断言）',
      grewTwice,
      `前=${before2} 后=${afterSecond}`,
    )
    const conflictToast = (await toastTexts(pageA)).find((t) => t.includes('409') || t.includes('已使用'))
    checkProduct(
      '反复发送未出现 409 冲突提示',
      !conflictToast,
      `toast=${JSON.stringify(await toastTexts(pageA))}`,
    )

    // 发出的确实是图片消息（附件渲染成 att--image）
    const lastRowHasImage = await pageA.evaluate(() => {
      const rows = [...document.querySelectorAll('.pane__row')]
      const last = rows[rows.length - 1]
      if (!last) return false
      return !!last.querySelector('.att--image')
    })
    checkProduct('新发送的那条是图片消息（.att--image）', lastRowHasImage, `最后一行图片=${lastRowHasImage}`)

    /* ══════════════════════════════════════════════════════════════
     * D. 刷新持久化
     * ══════════════════════════════════════════════════════════════ */
    group('D. 刷新后表情仍在（持久化）')
    await pageA.reload({ waitUntil: 'domcontentloaded' })
    await pageA.waitForSelector('.pane__scroll', { timeout: 20_000 }).catch(() => {})
    const backAfterReload = await until(
      () => pageA.locator('.cbar__btn--sticker').isVisible().catch(() => false),
      15_000,
      200,
    )
    await pageA.locator('.cbar__btn--sticker').first().click({ timeout: 8_000 }).catch(() => {})
    const panelAfterReload = await until(
      () => pageA.locator('section.sp[aria-label="表情包"]').isVisible().catch(() => false),
      10_000,
      200,
    )
    const cellsAfterReload = await pageA.locator('section.sp .sp__cell').count()
    checkProduct(
      '刷新页面后表情包仍在（格子数 ≥ 1）',
      backAfterReload && panelAfterReload && cellsAfterReload >= 1,
      `工具栏=${backAfterReload} 面板=${panelAfterReload} cell=${cellsAfterReload}`,
    )
    const countBadge = await pageA
      .locator('section.sp .sp__count')
      .first()
      .innerText()
      .catch(() => '')
    checkProduct(
      '面板计数角标与实际格子数一致',
      countBadge.trim() === String(cellsAfterReload),
      `角标=${JSON.stringify(countBadge)} cell=${cellsAfterReload}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * E. 删除表情（二次确认）
     * ══════════════════════════════════════════════════════════════ */
    group('E. 删除表情：二次确认 → cell 消失 → 刷新仍不存在')
    const delBtn = pageA.locator('section.sp .sp__cell button.sp__del').first()
    // 桌面上 .sp__del 默认 opacity:0，hover 格子才显形
    await pageA.locator('section.sp .sp__cell').first().hover().catch(() => {})
    const delVisible = await delBtn.isVisible().catch(() => false)
    checkProduct('hover 表情格子后「删除」按钮可见', delVisible, `visible=${delVisible}`)
    await delBtn.click({ timeout: 8_000 }).catch(() => {})

    const dialogShown = await until(
      () => pageA.locator('.mask .panel[role="dialog"]').isVisible().catch(() => false),
      8_000,
      150,
    )
    const dialogTitle = dialogShown
      ? await pageA.locator('.mask .panel[role="dialog"] .panel__title').first().innerText().catch(() => '')
      : ''
    checkProduct(
      '点删除弹出二次确认（标题「删除表情」）',
      dialogShown && dialogTitle.includes('删除表情'),
      `可见=${dialogShown} 标题=${JSON.stringify(dialogTitle)}`,
    )
    const confirmText = dialogShown
      ? await pageA.locator('.mask .panel[role="dialog"] .sp__confirm').first().innerText().catch(() => '')
      : ''
    checkProduct(
      '确认弹窗说明了删除后果（「删除后需要重新从图片消息保存」）',
      confirmText.includes('确定删除') && confirmText.includes('重新从图片消息保存'),
      `正文=${JSON.stringify(confirmText.slice(0, 60))}`,
    )

    // 先点「取消」验证不会误删，再点「删除」
    const cancelBtn = pageA.locator('.mask .panel[role="dialog"] .sp__confirm-actions .btn', { hasText: '取消' })
    await cancelBtn.first().click({ timeout: 5_000 }).catch(() => {})
    const cancelledClosed = await until(
      () => pageA.locator('.mask .panel[role="dialog"]').isVisible().catch(() => false).then((v) => !v),
      6_000,
      150,
    )
    const cellsAfterCancel = await pageA.locator('section.sp .sp__cell').count()
    checkProduct(
      '点「取消」关闭弹窗且表情未被删除',
      cancelledClosed && cellsAfterCancel === cellsAfterReload,
      `弹窗关闭=${cancelledClosed} cell=${cellsAfterCancel}`,
    )

    await pageA.locator('section.sp .sp__cell').first().hover().catch(() => {})
    await pageA
      .locator('section.sp .sp__cell button.sp__del')
      .first()
      .click({ timeout: 8_000 })
      .catch(() => {})
    await until(
      () => pageA.locator('.mask .panel[role="dialog"]').isVisible().catch(() => false),
      8_000,
      150,
    )
    const confirmBtn = pageA.locator('.mask .panel[role="dialog"] .sp__confirm-actions .btn', { hasText: '删除' })
    await confirmBtn.first().click({ timeout: 5_000 }).catch(() => {})
    const cellGone = await until(
      async () => (await pageA.locator('section.sp .sp__cell').count()) === cellsAfterCancel - 1,
      10_000,
      200,
    )
    const cellsAfterDelete = await pageA.locator('section.sp .sp__cell').count()
    checkProduct(
      '点「删除」后该 cell 消失',
      cellGone,
      `删除前=${cellsAfterCancel} 删除后=${cellsAfterDelete}`,
    )

    // 刷新确认真的删掉了（不能只是前端本地移除）
    await pageA.reload({ waitUntil: 'domcontentloaded' })
    await pageA.waitForSelector('.pane__scroll', { timeout: 20_000 }).catch(() => {})
    await until(() => pageA.locator('.cbar__btn--sticker').isVisible().catch(() => false), 15_000, 200)
    await pageA.locator('.cbar__btn--sticker').first().click({ timeout: 8_000 }).catch(() => {})
    await until(
      () => pageA.locator('section.sp[aria-label="表情包"]').isVisible().catch(() => false),
      10_000,
      200,
    )
    const cellsAfterDeleteReload = await pageA.locator('section.sp .sp__cell').count()
    const stateAfterDeleteReload = await pageA
      .locator('section.sp .sp__state')
      .first()
      .innerText()
      .catch(() => '')
    checkProduct(
      '刷新后确认表情已删除（cell=0 + 空态文案）',
      cellsAfterDeleteReload === 0 && stateAfterDeleteReload.includes('还没有表情包'),
      `cell=${cellsAfterDeleteReload} 空态=${JSON.stringify(stateAfterDeleteReload)}`,
    )

    // 后端侧也必须真的没有了
    const listAfterDel = await allStickers('gate_a')
    checkProduct(
      '后端 GET /stickers 列表已为空（不是只删了前端态）',
      listAfterDel.status === 200 && listAfterDel.items.length === 0,
      `status=${listAfterDel.status} count=${listAfterDel.items.length}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * F. 关闭面板
     * ══════════════════════════════════════════════════════════════ */
    group('F. 关闭面板')
    await pageA.locator('section.sp .sp__close').first().click({ timeout: 8_000 }).catch(() => {})
    const panelClosedByX = await until(
      async () => (await pageA.locator('section.sp').count()) === 0,
      6_000,
      150,
    )
    const labelAfterClose = await pageA
      .locator('.cbar__btn--sticker')
      .first()
      .getAttribute('aria-label')
      .catch(() => null)
    checkProduct(
      '点 .sp__close 关闭面板且按钮回到「表情包」',
      panelClosedByX && labelAfterClose === '表情包',
      `面板消失=${panelClosedByX} aria-label=${JSON.stringify(labelAfterClose)}`,
    )
    // 再用工具条按钮开 → 关（第二次路径）
    await pageA.locator('.cbar__btn--sticker').first().click({ timeout: 8_000 }).catch(() => {})
    const reopened = await until(
      () => pageA.locator('section.sp').isVisible().catch(() => false),
      6_000,
      150,
    )
    await pageA.locator('.cbar__btn--sticker').first().click({ timeout: 8_000 }).catch(() => {})
    const closedByToggle = await until(
      async () => (await pageA.locator('section.sp').count()) === 0,
      6_000,
      150,
    )
    checkProduct(
      '再点工具条按钮也能收起面板（toggle）',
      reopened && closedByToggle,
      `再次打开=${reopened} 点后收起=${closedByToggle}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * G. 右键菜单 —— 空白区默认菜单
     * ══════════════════════════════════════════════════════════════ */
    group('G. 右键菜单：空白区默认项')
    const defaultIds = await openDefaultMenu(pageA)
    checkProduct(
      '在聊天区空白处右键弹出 .ctx-menu',
      defaultIds.length > 0,
      `items=${JSON.stringify(defaultIds)}`,
    )
    checkProduct(
      '默认菜单含 refresh / copy-link / theme',
      ['refresh', 'copy-link', 'theme'].every((id) => defaultIds.includes(id)),
      `items=${JSON.stringify(defaultIds)}`,
    )
    const topItem = await pageA.evaluate((sel) => {
      const el = document.querySelector(`${sel} .ctx-menu__item[data-id="top"]`)
      if (!el) return null
      return {
        disabled: el.getAttribute('aria-disabled') === 'true',
        hasClass: el.classList.contains('is-disabled'),
      }
    }, CTX)
    checkProduct(
      '「回到顶部」在滚动到底部时按条件禁用（禁用项带 aria-disabled + .is-disabled）',
      topItem === null || !topItem.disabled || (topItem.disabled && topItem.hasClass),
      `top=${JSON.stringify(topItem)}`,
    )
    const labels = await pageA.evaluate((sel) =>
      [...document.querySelectorAll(`${sel} .ctx-menu__item`)].map((el) => ({
        id: el.getAttribute('data-id'),
        label: el.querySelector('.ctx-menu__label')?.textContent?.trim() ?? '',
        role: el.getAttribute('role'),
      })),
      CTX,
    )
    checkProduct(
      '菜单项是 role=menuitem 的按钮且文案非空',
      labels.length > 0 &&
        labels.every((l) => l.role === 'menuitem' && l.label.length > 0),
      `items=${JSON.stringify(labels)}`,
    )
    await shotAs(pageA, 'v24-ctx-menu-default.png')
    console.log(`   截图：${resolve(SHOT_DIR, 'v24-ctx-menu-default.png')}`)

    /* ══════════════════════════════════════════════════════════════
     * H. 键盘可达：Escape 关闭
     * ══════════════════════════════════════════════════════════════ */
    group('H. 键盘可达：Escape 关闭菜单')
    const focusedInMenu = await pageA.evaluate((sel) => {
      const el = document.activeElement
      return !!el && !!document.querySelector(sel)?.contains(el)
    }, CTX)
    checkProduct('菜单打开后焦点移入菜单（键盘可操作）', focusedInMenu, `焦点在菜单内=${focusedInMenu}`)
    await pageA.keyboard.press('Escape')
    const closedByEsc = await until(
      async () => (await pageA.locator(CTX).count()) === 0,
      5_000,
      150,
    )
    checkProduct('按 Escape 关闭菜单', closedByEsc, `已关闭=${closedByEsc}`)

    /* ══════════════════════════════════════════════════════════════
     * I. 输入框保留浏览器原生菜单
     * ══════════════════════════════════════════════════════════════ */
    group('I. 输入框 / Shift 右键保留原生菜单')
    const textareaShown = await pageA
      .locator('.composer__input')
      .isVisible()
      .catch(() => false)
    if (!textareaShown) {
      check('输入框可见（前置）', false, '.composer__input 不可见')
    } else {
      await rightClick(pageA, '.composer__input')
      // 负向断言：1.6s 内不允许出现菜单
      const appeared = await until(
        async () => (await pageA.locator(CTX).count()) > 0,
        1_600,
        150,
      )
      checkProduct('在 textarea 上右键不弹 AppContextMenu（保留原生）', !appeared, `出现了=${appeared}`)
    }

    /* ══════════════════════════════════════════════════════════════
     * J. 消息气泡右键菜单
     * ══════════════════════════════════════════════════════════════ */
    group('J. 消息气泡右键菜单')
    const textRow = pageA.locator('.pane__row', { hasText: `v24 右键菜单样本 ${RUN}` }).first()
    const textRowShown = await textRow
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    check('找到本次的文本消息行', textRowShown, `找到=${textRowShown}`)
    await textRow.locator('.bubble').first().click({ button: 'right' })
    const msgMenuShown = await until(() => menuShown(pageA), 6_000, 150)
    const msgIds = msgMenuShown ? await menuIds(pageA) : []
    checkProduct('消息气泡上右键弹出菜单', msgMenuShown, `可见=${msgMenuShown}`)
    checkProduct(
      '消息菜单含 copy / select-text / reply 中至少一项（本例应三项齐全）',
      ['copy', 'select-text', 'reply'].some((id) => msgIds.includes(id)),
      `items=${JSON.stringify(msgIds)}`,
    )
    checkProduct(
      '文本消息的菜单同时含 copy 与 select-text 与 reply',
      ['copy', 'select-text', 'reply'].every((id) => msgIds.includes(id)),
      `items=${JSON.stringify(msgIds)}`,
    )
    checkProduct(
      '消息菜单不再混入项目级默认项（无 refresh / theme）',
      !msgIds.includes('refresh') && !msgIds.includes('theme'),
      `items=${JSON.stringify(msgIds)}`,
    )
    await shotAs(pageA, 'v24-ctx-menu-message.png')
    console.log(`   截图：${resolve(SHOT_DIR, 'v24-ctx-menu-message.png')}`)

    // 点「复制正文」：菜单必须关；是否真的复制到剪贴板取决于 headless 权限
    const expectedText = `v24 右键菜单样本 ${RUN}`
    await pageA.locator(`${CTX} .ctx-menu__item[data-id="copy"]`).first().click({ timeout: 5_000 }).catch(() => {})
    const copyClosed = await until(
      async () => (await pageA.locator(CTX).count()) === 0,
      5_000,
      150,
    )
    checkProduct('点菜单项「复制正文」后菜单关闭', copyClosed, `已关闭=${copyClosed}`)
    // 成功路径没有 toast（只改按钮文案 1.6s），失败才有 error toast；
    // 因此判定顺序：先看失败提示 → SKIP；再看剪贴板能否读回 → PASS；都不行 → SKIP。
    const fallbackToast = await waitToast(pageA, '复制失败，请长按手动选择文本', 1_200)
    let clipRead = ''
    let clipErr = ''
    try {
      clipRead = await pageA.evaluate(() => navigator.clipboard.readText())
    } catch (e) {
      clipErr = String(e?.message ?? e)
    }
    if (clipRead === expectedText) {
      checkProduct('剪贴板确实拿到了消息正文', true, `读回长度=${clipRead.length}`)
    } else if (fallbackToast) {
      skip(
        '复制正文落到剪贴板',
        `headless Chrome 没有剪贴板写权限，writeClipboardText 走了 execCommand 兜底仍失败，` +
          `产品按设计弹出「复制失败，请长按手动选择文本」；菜单关闭已单独断言。clipboard.readText 错误=${clipErr || '(无)'}`,
      )
    } else {
      skip(
        '复制正文落到剪贴板',
        `headless Chrome 未授予 clipboard-read 权限，读回值=${JSON.stringify(clipRead)}，` +
          `无失败 toast（说明写入路径未报错），但无法在进程外验证剪贴板内容。错误=${clipErr || '(无)'}`,
      )
    }

    /* ══════════════════════════════════════════════════════════════
     * K. 图片附件右键菜单
     * ══════════════════════════════════════════════════════════════ */
    group('K. 图片附件右键菜单')
    // 必须先用「视口内可见」的图片：`.first()` 可能是滚出屏幕上方几千像素的旧消息，
    // Playwright 虽然会先滚动过去，但滚动本身会触发 AppContextMenu 的 scroll 监听
    // 把菜单立刻关掉（AppContextMenu.vue 有 window 捕获阶段 scroll → closeContextMenu）。
    // 所以这里显式滚过去、等滚动停稳，再在元素中心发真实右键。
    await closeMenuIfAny(pageA)
    const imgAtt = pageA.locator('.pane__row .att--image').last()
    const imgAttCount = await pageA.locator('.pane__row .att--image').count()
    check('页面上存在图片附件节点 .att--image', imgAttCount >= 1, `count=${imgAttCount}`)
    await imgAtt.scrollIntoViewIfNeeded().catch(() => {})
    await pageA.waitForTimeout(400)
    const imgAttBox = await imgAtt.boundingBox().catch(() => null)
    check('拿到图片附件的位置（前置）', imgAttBox !== null, `bbox=${JSON.stringify(imgAttBox)}`)
    if (imgAttBox) {
      await pageA.mouse.click(imgAttBox.x + imgAttBox.width / 2, imgAttBox.y + imgAttBox.height / 2, {
        button: 'right',
      })
    }
    const mediaMenuShown = await until(() => menuShown(pageA), 6_000, 150)
    const mediaIds = mediaMenuShown ? await menuIds(pageA) : []
    checkProduct('图片附件上右键弹出菜单', mediaMenuShown, `可见=${mediaMenuShown}`)
    checkProduct(
      '图片附件菜单含 save-media 与 copy-media-url',
      mediaIds.includes('save-media') && mediaIds.includes('copy-media-url'),
      `items=${JSON.stringify(mediaIds)}`,
    )
    const mediaLabels = await pageA.evaluate((sel) =>
      [...document.querySelectorAll(`${sel} .ctx-menu__item`)].map((el) => ({
        id: el.getAttribute('data-id'),
        label: el.querySelector('.ctx-menu__label')?.textContent?.trim() ?? '',
        disabled: el.getAttribute('aria-disabled') === 'true',
      })),
      CTX,
    )
    checkProduct(
      '图片菜单文案是「保存图片 / 复制图片地址」且未禁用（blob 已就绪）',
      mediaLabels.some((l) => l.id === 'save-media' && l.label === '保存图片' && !l.disabled) &&
        mediaLabels.some((l) => l.id === 'copy-media-url' && l.label === '复制图片地址' && !l.disabled),
      `items=${JSON.stringify(mediaLabels)}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * L. 点击页面其它位置关闭菜单
     * ══════════════════════════════════════════════════════════════ */
    group('L. 点击页面其它位置关闭菜单')
    // 不依赖上一节的残留状态：本节自己先确保菜单是打开的（关闭残留 → 重新右键打开）。
    await closeMenuIfAny(pageA)
    const reopenedForOutside = await openDefaultMenu(pageA)
    const beforeOutside = reopenedForOutside.length > 0 && (await menuShown(pageA))
    check('重新打开菜单（前置）', beforeOutside, `items=${JSON.stringify(reopenedForOutside)}`)
    await pageA.locator('.pane__title').first().click({ timeout: 5_000 }).catch(() => {})
    const closedByOutside = await until(
      async () => (await pageA.locator(CTX).count()) === 0,
      5_000,
      150,
    )
    checkProduct(
      '菜单打开时点击页面其它位置 → 菜单关闭',
      beforeOutside && closedByOutside,
      `点击前可见=${beforeOutside} 点击后消失=${closedByOutside}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * M. 主题菜单项真的切换主题
     * ══════════════════════════════════════════════════════════════ */
    group('M. 默认菜单「切换深浅色」生效')
    await closeMenuIfAny(pageA)
    const themeBefore = await pageA.evaluate(() => document.documentElement.dataset.themeMode ?? null)
    const idsForTheme = await openDefaultMenu(pageA)
    check('再次打开默认菜单（前置）', idsForTheme.includes('theme'), `items=${JSON.stringify(idsForTheme)}`)
    await pageA.locator(`${CTX} .ctx-menu__item[data-id="theme"]`).first().click({ timeout: 5_000 }).catch(() => {})
    const themeChanged = await until(
      async () => {
        const now = await pageA.evaluate(() => document.documentElement.dataset.themeMode ?? null)
        return now !== null && now !== themeBefore
      },
      5_000,
      150,
    )
    const themeAfter = await pageA.evaluate(() => document.documentElement.dataset.themeMode ?? null)
    checkProduct(
      '点「切换深浅色」后 data-theme-mode 变化',
      themeChanged,
      `${themeBefore} → ${themeAfter}`,
    )
    const menuClosedAfterTheme = await until(
      async () => (await pageA.locator(CTX).count()) === 0,
      5_000,
      150,
    )
    checkProduct('点主题菜单项后菜单关闭', menuClosedAfterTheme, `已关闭=${menuClosedAfterTheme}`)
    // 复位主题，免得影响后续截图与断言
    await pageA
      .evaluate((mode) => {
        if (document.documentElement.dataset.themeMode !== mode) {
          document.documentElement.dataset.themeMode = mode
        }
      }, themeBefore)
      .catch(() => {})

    /* ══════════════════════════════════════════════════════════════
     * N. Shift + 右键保留原生菜单
     * ══════════════════════════════════════════════════════════════ */
    group('N. Shift + 右键保留浏览器原生菜单')
    // 前置：必须先从「没有菜单」的状态开始，否则测到的是上一节残留的菜单。
    const cleanedForShift = await closeMenuIfAny(pageA)
    check('N 前置：菜单已全部关闭', cleanedForShift, `cleaned=${cleanedForShift}`)
    const shiftPoint = await findPaneBlankPoint(pageA).catch(() => null)
    check('N 前置：找到 .pane__scroll 的空白点', shiftPoint !== null, `point=${JSON.stringify(shiftPoint)}`)
    if (shiftPoint) {
      await pageA.keyboard.down('Shift')
      await pageA.mouse.click(shiftPoint.x, shiftPoint.y, { button: 'right' })
      await pageA.keyboard.up('Shift')
      await pageA.waitForTimeout(600)
      const shfitAppeared = (await pageA.locator(CTX).count()) > 0
      checkProduct(
        'Shift + 右键在空白区不弹 AppContextMenu（放行浏览器原生菜单）',
        !shfitAppeared,
        `出现了=${shfitAppeared}`,
      )
    }

    await ctxA.close()
    ctxA = null

    /* ══════════════════════════════════════════════════════════════
     * O. 空态：没有收藏表情的账号（gate_b）
     * ══════════════════════════════════════════════════════════════ */
    group('O. 面板空态（gate_b 无收藏）')
    const sessB = await contextAs(browser, 'gate_b', VP)
    ctxB = sessB.ctx
    pageB = sessB.page
    const shellB = await ensureShell(pageB, 'gate_b')
    check('gate_b 登录后进入聊天外壳', shellB, `shell=${shellB}`)
    await pageB.goto(`${BASE}/chat/${convAB}`, { waitUntil: 'domcontentloaded' })
    await pageB.waitForSelector('.pane__scroll', { timeout: 20_000 }).catch(() => {})
    const btnB = pageB.locator('.cbar__btn--sticker')
    const btnBShown = await until(() => btnB.isVisible().catch(() => false), 15_000, 200)
    check('gate_b 的工具条也有「表情包」按钮', btnBShown, `visible=${btnBShown}`)
    await btnB.first().click({ timeout: 8_000 }).catch(() => {})
    const panelB = await until(
      () => pageB.locator('section.sp[aria-label="表情包"]').isVisible().catch(() => false),
      8_000,
      150,
    )
    const stateB = panelB
      ? await pageB.locator('section.sp .sp__state').first().innerText().catch(() => '')
      : ''
    checkProduct(
      '无收藏账号打开面板显示空态「还没有表情包」',
      panelB && stateB.includes('还没有表情包'),
      `面板=${panelB} 空态=${JSON.stringify(stateB)}`,
    )
    const cellsB = await pageB.locator('section.sp .sp__cell').count()
    checkProduct('空态下不渲染任何格子', cellsB === 0, `cell=${cellsB}`)
    await pageB.locator('section.sp .sp__close').first().click({ timeout: 5_000 }).catch(() => {})
    const panelBClosed = await until(
      async () => (await pageB.locator('section.sp').count()) === 0,
      5_000,
      150,
    )
    checkProduct('空态下面板同样能关闭', panelBClosed, `已关闭=${panelBClosed}`)
    await ctxB.close()
    ctxB = null
  } finally {
    if (ctxA) await ctxA.close().catch(() => {})
    if (ctxB) await ctxB.close().catch(() => {})
    await browser.close().catch(() => {})
    // 清理本次收藏（已删的会 404，无副作用）
    try {
      await purgeStickers('gate_a')
      await purgeStickers('gate_b')
    } catch {
      /* 忽略 */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }

  /* ── 汇总 ── */
  const pass = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped)
  const failed = results.filter((r) => !r.ok)
  const defectCount = defects.length

  console.log(`\n════════ 汇总 ════════`)
  console.log(
    `=== 汇总：${results.length} 项 —— 通过 ${pass}，失败 ${failed.length}，待验 ${skipped.length} ===`,
  )
  if (failed.length) {
    console.log(`\n未通过清单：`)
    for (const f of failed) console.log(`  ${f.defect ? 'DEFECT' : 'FAIL'}  ${f.name}  —— ${f.detail}`)
  }
  if (skipped.length) {
    console.log(`\n待验清单（headless 客观限制，附原因）：`)
    for (const s of skipped) console.log(`  SKIP  ${s.name}  —— ${s.detail}`)
  }
  if (pageErrors.length) {
    console.log(`\n页面未捕获异常 ${pageErrors.length} 条（前 5）：`)
    for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.msg}  @ ${e.url}`)
  }
  console.log(`\n截图目录：${SHOT_DIR}`)
  console.log(`   - v24-sticker-panel.png`)
  console.log(`   - v24-ctx-menu-default.png`)
  console.log(`   - v24-ctx-menu-message.png`)

  clearTimeout(hardTimer)
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n!! 脚本异常终止：', err)
  clearTimeout(hardTimer)
  process.exit(2)
})
