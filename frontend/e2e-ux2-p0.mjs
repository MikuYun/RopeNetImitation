/**
 * UX2 回归 —— 四项 P0 用户诉求的浏览器实证（task-12）。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 *   e2e-gates / e2e-responsive / e2e-matrix / e2e-attachment 是**既有基线**，
 *   本文件只新增、不改它们任何一条断言（工具函数复制而非 import，理由同
 *   e2e-matrix.mjs 顶部注释：既有基线是被点名验收的对照，改动会污染对照）。
 *
 * ── 覆盖（对照 task-12 的八条 P0 要求）─────────────────────────────
 *   P0-1  移动端（390x844 / 320x568）气泡工具条不再遮挡正文
 *   P0-2  移动端长按（500ms）弹操作菜单；长按后滚动不误触
 *   P0-3  桌面（1440x900）工具条在气泡外侧，与气泡矩形不重叠
 *   P0-4  附件跨用户可看可下载（含灯箱大图 + 下载字节 sha256 与源文件一致，双向）
 *   P0-5  图片 / 文件双入口 + 图片一律缩略图（不降级为文件卡片）
 *   P0-6  置顶联动：A 置顶 → B 不刷新收到 conversation.pins 广播 → 置顶条出现 → 跳转 → 取消后消失
 *   P0-7  群角色：owner 设 admin → 成员侧看到管理员徽标；admin 踢 owner/admin 403；owner 踢 admin 200
 *   P0-8  UID 登录：登录页用数字 UID（不是账号名）真实登录成功并进 /chat
 *
 * ── 输入（全部可用环境变量覆盖；默认值对齐 docs/evidence/run-ux2-p0.ps1）──
 *   BASE     默认 http://localhost:5174   （必须 --mode integration，否则 MSW mock 拦一切）
 *   BACKEND  默认 http://127.0.0.1:3098
 *   HARD_TIMEOUT_MS 默认 600000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐条 PASS / FAIL / DEFECT / SKIP + 实测值 + 汇总
 *   截图：docs/evidence/ux2-p0-*.png
 *   退出码：0 = 无 FAIL / 1 = 有 FAIL / 3 = 硬超时
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   只在隔离后端（默认 3098 的临时库）注册测试账号、发测试消息、上传测试文件；
 *   临时文件写系统 temp 目录，跑完删除。不碰生产、不 commit、不改源码。
 */

import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5174'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3098'
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

function check(name, ok, detail = '') {
  results.push({ name, ok, detail, skipped: false, defect: false })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}
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
  await page.screenshot({ path: resolve(SHOT_DIR, `ux2-p0-${name}.png`) })
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/* ── 合法 PNG 生成（不往仓库里加图片素材）──────────────────────── */
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
/** DELETE 绝不能带 Content-Type: application/json（无 body 时 Fastify 直接 400 掩盖真实错误码）。 */
async function jdel(path, token) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** 裸二进制上传（模拟「A 传了张图」的服务端侧路径，用于种子数据）。 */
async function uploadBytesAs(username, filename, buf, mime = 'application/octet-stream') {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/uploads?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': mime },
    body: buf,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/* ── 限流自适应（全局限流 200 次/分钟/用户）────────────────────── */
const rateHit = new Map()
async function isRateLimited(username) {
  const t = await tokenOf(username)
  const r = await jget('/api/v1/conversations?limit=1&offset=0', t.token)
  return r.status === 429
}
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

/** 建立 a → b 的好友关系（幂等）。建群要求「所有成员都得是群主的好友」
 *  （backend `service.group` → `requireFriends`，非好友直接 403 FRIEND_REQUIRED），
 *  所以 P0-7 里 gate_a 必须同时是 gate_b 和 gate_c 的好友，不能只建 AB。 */
async function ensureFriend(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const friendsA = await jget('/api/v1/friends', A.token)
  if ((friendsA.body?.items ?? []).some((f) => f.username === b)) return true
  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return false
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'UX2 P0 验证' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find((r) => r.sender?.username === a && r.status === 'pending')
  if (inc) await jpost(`/api/v1/friend-requests/${inc.id}/respond`, B.token, { action: 'accept' })
  return true
}
async function ensureFriendsAndConv(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const listA = await jget('/api/v1/conversations?limit=50&offset=0', A.token)
  const found = (listA.body?.items ?? []).find((c) => c.type === 'direct' && c.peer?.username === b)
  if (found) return found.id

  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return null
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'UX2 P0 验证' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find((r) => r.sender?.username === a && r.status === 'pending')
  if (inc) await jpost(`/api/v1/friend-requests/${inc.id}/respond`, B.token, { action: 'accept' })
  const direct = await jpost('/api/v1/conversations/direct', A.token, { userId: target.id })
  return direct.body?.id ?? null
}
async function sendTextAs(username, convId, content) {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/conversations/${convId}/messages`, {
    method: 'POST',
    headers: H(t.token),
    body: JSON.stringify({ clientMsgId: crypto.randomUUID(), content }),
  })
  return r.ok ? (await r.json()).seq : null
}
async function sendAttachmentAs(username, convId, attachmentId, content) {
  const t = await tokenOf(username)
  const r = await fetch(`${BACKEND}/api/v1/conversations/${convId}/messages`, {
    method: 'POST',
    headers: H(t.token),
    body: JSON.stringify({
      clientMsgId: crypto.randomUUID(),
      // v2 契约 §2：单数 attachmentId → 数组 attachmentIds；有附件时必须带文字。
      attachmentIds: [attachmentId],
      content,
    }),
  })
  return r.ok ? (await r.json()).seq : null
}

/* ── 浏览器工具 ─────────────────────────────────────────────────── */
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
async function contextAs(browser, username, viewport = { width: 1280, height: 800 }, extra = {}) {
  await ensureNotLimited(username, 60_000)
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...extra })
  const page = await ctx.newPage()
  watchPage(page)
  await setAuth(page, username)
  return { ctx, page }
}
async function ensureShell(page, username = 'gate_a') {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ok = await page
      .waitForSelector('.list, .panel, .rail', { timeout: attempt === 1 ? 15_000 : 10_000 })
      .then(() => true)
      .catch(() => false)
    if (ok) return true
    const onLogin = await page.locator('.auth__form').isVisible().catch(() => false)
    console.log(`   … 外壳未出现（第 ${attempt} 次${onLogin ? '，已被踢回登录页（限流/瞬时错误）' : ''}），等限流窗口后重试…`)
    await ensureNotLimited(username, 90_000)
    if (onLogin) await setAuth(page, username)
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await sleep(1500)
  }
  return false
}
async function openConv(page, title, username = 'gate_a') {
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const item = page.locator('.item', { hasText: title }).first()
      await item.waitFor({ state: 'visible', timeout: attempt === 1 ? 12_000 : 6_000 })
      await item.click()
      await page.waitForSelector('.pane__scroll', { timeout: 12_000 })
      return true
    } catch (e) {
      lastErr = e
      const limited = await isRateLimited(username).catch(() => false)
      if (limited) await ensureNotLimited(username, 60_000)
      if (!limited && attempt >= 3) break
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await sleep(1500)
    }
  }
  throw lastErr ?? new Error(`openConv 失败：${title}`)
}

/** 错误采集：未捕获异常 + 非预期 HTTP 响应（401/429 单独归类，429 是限流不是缺陷）。 */
function watchPage(page) {
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), msg: String(e?.message ?? e) }))
}

/** 点工具栏按钮 → 文件选择器 → 选文件。 */
async function pickVia(page, buttonSelector, filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.click(buttonSelector),
  ])
  await chooser.setFiles(filePath)
}

/** 等「待发送附件区」出现指定文件名（上传完成前那里显示的是「正在上传…」）。 */
async function waitComposerAtt(page, fileName, timeoutMs = 90_000) {
  return until(
    () =>
      page.evaluate((n) => {
        const el = document.querySelector('.composer__att-name')
        return !!el && (el.textContent || '').includes(n)
      }, fileName),
    timeoutMs,
    200,
  )
}

/** 等某个附件气泡出现（按文件名定位，避免命中历次运行遗留的旧附件）。 */
async function waitAttBubble(page, name, timeoutMs = 25_000) {
  return until(
    () =>
      page.evaluate((n) => {
        return [...document.querySelectorAll('.bubble--attach')].some((el) =>
          (el.textContent || '').includes(n),
        )
      }, name),
    timeoutMs,
    250,
  )
}

/* ── CDP 触摸（真实长按：touchStart → 等 → touchEnd）────────────── */
const cdpByPage = new Map()
async function cdp(page) {
  if (!cdpByPage.has(page)) cdpByPage.set(page, await page.context().newCDPSession(page))
  return cdpByPage.get(page)
}
async function touchEvent(page, type, points) {
  const c = await cdp(page)
  await c.send('Input.dispatchTouchEvent', { type, touchPoints: points })
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== UX2 P0 浏览器实证  BASE=${BASE}  BACKEND=${BACKEND}  RUN=${RUN} ===\n`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'aitr-ux2p0-'))
  const photoName = `ux2-photo-${RUN}.png`
  const seedName = `ux2-seed-${RUN}.png`
  const noteName = `ux2-note-${RUN}.txt`
  const backName = `ux2-back-${RUN}.txt`

  const photoBuf = makePng(180, 120, 21)
  const noteText = `UX2-P0-NOTE-${RUN}\n` + 'x'.repeat(600)
  const noteBuf = Buffer.from(noteText, 'utf8')
  const backText = `UX2-P0-BACK-${RUN}\n` + 'y'.repeat(500)
  const backBuf = Buffer.from(backText, 'utf8')

  const paths = {
    photo: join(tmpDir, photoName),
    note: join(tmpDir, noteName),
    back: join(tmpDir, backName),
  }
  writeFileSync(paths.photo, photoBuf)
  writeFileSync(paths.note, noteBuf)
  writeFileSync(paths.back, backBuf)
  console.log(
    `临时文件：photo=${photoBuf.length}B  note=${noteBuf.length}B  back=${backBuf.length}B（${tmpDir}）\n`,
  )

  // ── 账号与会话准备 ──
  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  await ensureUser('gate_c', '闸门 C')
  const convAB = await ensureFriendsAndConv('gate_a', 'gate_b')
  if (!convAB) throw new Error('无法建立 gate_a ↔ gate_b 会话，P0 验证无从进行')
  console.log(`会话：AB=${convAB}`)
  // P0-7 建群要求「被邀请的人都是群主好友」（service.group → requireFriends，否则 403
  // FRIEND_REQUIRED），所以这里要额外把 gate_c 也加成 gate_a 的好友。
  const friendAC = await ensureFriend('gate_a', 'gate_c')
  console.log(`好友：A↔B=ok  A↔C=${friendAC}\n`)

  const meA = await jget('/api/v1/users/me', (await tokenOf('gate_a')).token)
  const uidA = meA.body?.uid
  console.log(`gate_a uid=${uidA}（注册顺序第一位，期望 10001）\n`)

  // P0-1/P0-2/P0-3 需要「多条长文本消息」的会话；P0-2/P0-5 还需要一条图片附件消息。
  const LONG_TAG = `长文${RUN}`
  const longMsgs = [
    `**${LONG_TAG}-1** 这是一段用来验证移动端气泡不遮挡正文的长文本，包含 \`行内代码\` 与 **粗体**，` +
      '长度足以在多档视口下换行成多行，从而让气泡占据明显高度。'.repeat(2),
    `**${LONG_TAG}-2** 第二段长文本，用来确认工具条在 390 和 320 两档都不出现（display:none），` +
      '并且气泡中心点命中的元素是正文而不是任何浮层。'.repeat(2),
    `${LONG_TAG}-3 第三段：https://example.invalid/very/long/url/${'seg/'.repeat(12)}end，` +
      '用来制造长串不可断词，检验是否有横向溢出把正文挤出可视区。',
    `**${LONG_TAG}-4** 第四段带列表：\n- 项目一\n- 项目二\n- 项目三`.repeat(1),
    `${LONG_TAG}-5 第五段普通文本，用于桌面 hover 工具条的外侧位置断言。`.repeat(3),
    `${LONG_TAG}-6 第六段普通文本，最后一条。`.repeat(3),
  ]
  for (const t of longMsgs) await sendTextAs('gate_b', convAB, t)
  console.log(`已播种 ${longMsgs.length} 条长文本消息（前缀 ${LONG_TAG}）\n`)

  // 服务端侧播一条图片附件消息（给双入口/缩略图/灯箱断言用）
  const seedUp = await uploadBytesAs('gate_b', seedName, makePng(64, 48, 7), 'image/png')
  const seedAttId = seedUp.body?.id
  // v2 契约 §2：有附件必须带非空文字，否则服务端 400「发送附件时必须附带文字」
  if (seedAttId) await sendAttachmentAs('gate_b', convAB, seedAttId, `种子图片 ${seedName}`)
  /*
   * 再播一条 **txt 文件** 附件消息。
   * 为什么必须两条：`MessageBubble.vue` 的「下载附件」菜单项条件是
   * `menuItems.includes('download-attachment') && hasFileAttachment`，而
   * `hasFileAttachment = attachments.some(a => a.kind === 'file')` —— 图片（kind=image）
   * 走的是缩略图 + 灯箱，不提供「下载附件」菜单项（这是设计意图，不是缺陷：
   * 图片的保存入口在灯箱里）。所以「下载附件」只能用 kind=file 的气泡来验。
   */
  const seedDocName = `ux2-seeddoc-${RUN}.txt`
  const seedDocBuf = Buffer.from(`UX2-P0-SEED-DOC-${RUN}\n` + 'd'.repeat(300), 'utf8')
  const seedDocUp = await uploadBytesAs('gate_b', seedDocName, seedDocBuf, 'text/plain')
  const seedDocAttId = seedDocUp.body?.id
  if (seedDocAttId) await sendAttachmentAs('gate_b', convAB, seedDocAttId, `种子文件 ${seedDocName}`)
  console.log(
    `种子图片上传=${seedUp.status} id=${seedAttId ?? '(none)'} 种子文件上传=${seedDocUp.status} id=${seedDocAttId ?? '(none)'}\n`,
  )

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  let ctxA = null
  let ctxB = null
  let ctxM = null

  try {
    /* ═══ P0-1 移动端气泡工具条不遮挡正文 ═══════════════════════ */
    group('P0-1 移动端（390x844 / 320x568）气泡工具条不遮挡正文')
    for (const vp of [
      { name: '390', width: 390, height: 844 },
      { name: '320', width: 320, height: 568 },
    ]) {
      const m = await contextAs(
        browser,
        'gate_a',
        { width: vp.width, height: vp.height },
        { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
      )
      const page = m.page
      const shellOk = await ensureShell(page, 'gate_a')
      if (!shellOk) {
        skip(`P0-1 ${vp.name} 移动端外壳未就绪`, '限流/瞬时错误导致列表未渲染')
        await m.ctx.close().catch(() => {})
        continue
      }
      const opened = await openConv(page, '闸门 B', 'gate_a').catch(() => false)
      if (!opened) {
        skip(`P0-1 ${vp.name} 无法进入会话`, 'openConv 3 次重试均失败')
        await m.ctx.close().catch(() => {})
        continue
      }
      await page.waitForSelector('.bubble', { timeout: 15_000 }).catch(() => {})
      await sleep(600)

      // ① 工具条在移动端必须不可见
      const toolsState = await page.evaluate(() => {
        const list = [...document.querySelectorAll('.bubble__tools')]
        const hidden = list.filter((el) => {
          const cs = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0
        })
        const visible = list.length - hidden.length
        const displays = [...new Set(list.map((el) => getComputedStyle(el).display))]
        return { total: list.length, hidden: hidden.length, visible, displays }
      })
      check(
        `P0-1 ${vp.name} .bubble__tools 该档不可见`,
        toolsState.total > 0 && toolsState.visible === 0,
        `DOM 中=${toolsState.total} 不可见=${toolsState.hidden} 仍可见=${toolsState.visible} display=${JSON.stringify(toolsState.displays)}`,
      )

      // ②③ 每条可见气泡中心点命中正文 + 正文文字不被遮挡
      const occ = await occludeReport(page)
      check(
        `P0-1 ${vp.name} 气泡中心点命中正文（elementFromPoint）`,
        occ.bubbles > 0 && occ.occluded.length === 0,
        `气泡数=${occ.bubbles} 采样点=${occ.samples} 被遮挡=${occ.occluded.length}${occ.occluded.length ? ` 首例=${JSON.stringify(occ.occluded[0])}` : ''}`,
      )
      check(
        `P0-1 ${vp.name} .bubble__text 无横向溢出（字符未被挤出）`,
        occ.textOverflow.length === 0,
        `正文块=${occ.textBlocks} 溢出=${occ.textOverflow.length}${occ.textOverflow.length ? ` 首例=${JSON.stringify(occ.textOverflow[0])}` : ''}`,
      )
      check(
        `P0-1 ${vp.name} 正文未命中任何工具条/浮层元素`,
        occ.hitTools === 0,
        `命中 .bubble__tool* / .mask 次数=${occ.hitTools}`,
      )
      await shot(page, `mobile-${vp.name}`)
      await m.ctx.close().catch(() => {})
    }

    /* ═══ P0-2 移动端长按弹操作菜单 ═══════════════════════════════ */
    group('P0-2 移动端长按（>500ms）弹出操作菜单；长按后滚动不误触')
    {
      const m = await contextAs(
        browser,
        'gate_a',
        { width: 390, height: 844 },
        { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
      )
      ctxM = m.ctx
      const page = m.page
      const shellOk = await ensureShell(page, 'gate_a')
      const opened = shellOk ? await openConv(page, '闸门 B', 'gate_a').catch(() => false) : false
      if (!opened) {
        skip('P0-2 移动端长按菜单', '外壳/会话未就绪（限流），无法定位气泡')
      } else {
        await page.waitForSelector('.bubble', { timeout: 15_000 }).catch(() => {})
        await sleep(600)

        // 先验证：长按后「立即」滑动不弹菜单
        const target = await bubbleCenter(page)
        if (!target) {
          skip('P0-2 移动端长按菜单', '未找到可用于长按的可见气泡')
        } else {
          await touchEvent(page, 'touchStart', [{ x: target.x, y: target.y }])
          await sleep(120)
          await touchEvent(page, 'touchMove', [{ x: target.x, y: target.y - 40 }])
          await sleep(700)
          const menuAfterMove = await menuState(page)
          await touchEvent(page, 'touchEnd', [])
          await sleep(200)
          check(
            'P0-2 长按后立即滑动不误触菜单',
            menuAfterMove.visible === false,
            `touchmove 后等 700ms 菜单可见=${menuAfterMove.visible}`,
          )
          await page.keyboard.press('Escape').catch(() => {})
          await sleep(300)

          // 真长按：touchStart → 750ms → 断言菜单。
          // 必须长按一条**带 Markdown 语法**的消息：菜单项「看 Markdown 源码」只在
          // canToggleSource（hasMarkdownSyntax(content)）为真时出现，取随机的普通文本
          // 会把产品正确行为误判为缺少菜单项。
          const target2 = await bubbleCenter(page, `${LONG_TAG}-1`)
          await touchEvent(page, 'touchStart', [{ x: target2.x, y: target2.y }])
          await sleep(750)
          const menu = await menuState(page)
          await shot(page, 'longpress-menu')
          check(
            'P0-2 长按 750ms 弹出操作菜单',
            menu.visible === true,
            `菜单可见=${menu.visible} 标题="${menu.title}" 长按气泡="${target2.text}"`,
          )
          check(
            'P0-2 菜单标题为「消息操作」',
            menu.title === '消息操作',
            `标题="${menu.title}"`,
          )
          check(
            'P0-2 菜单含「复制正文」与「看 Markdown 源码」',
            menu.items.includes('复制正文') && menu.items.includes('看 Markdown 源码'),
            `菜单项=${JSON.stringify(menu.items)}`,
          )
          check(
            'P0-2 菜单含「置顶消息」（置顶可用）',
            menu.items.some((t) => t.includes('置顶')),
            `菜单项=${JSON.stringify(menu.items)}`,
          )
          await touchEvent(page, 'touchEnd', [])
          await sleep(200)

          // 关菜单（点「取消」）
          await page.locator('.mask .panel .sheet__item--cancel').click().catch(() => {})
          await sleep(400)

          /*
           * 「下载附件」只在 kind=file 的附件气泡上出现（见 MessageBubble.vue 的
           * hasFileAttachment = attachments.some(a => a.kind === 'file')）。
           * 图片走缩略图 + 灯箱，不提供该菜单项 —— 因此这里用 txt 种子气泡验证。
           */
          const attCenter = await attachBubbleCenter(page, seedDocName)
          if (!attCenter) {
            skip('P0-2 附件消息长按含「下载附件」', `未找到文件名含 ${seedDocName} 的附件气泡`)
          } else {
            await touchEvent(page, 'touchStart', [{ x: attCenter.x, y: attCenter.y }])
            await sleep(750)
            const attMenu = await menuState(page)
            await touchEvent(page, 'touchEnd', [])
            check(
              'P0-2 附件消息长按菜单含「下载附件」',
              attMenu.visible && attMenu.items.includes('下载附件'),
              `菜单可见=${attMenu.visible} 菜单项=${JSON.stringify(attMenu.items)}`,
            )
            await page.keyboard.press('Escape').catch(() => {})
            await sleep(300)
          }
        }
      }
      await m.ctx.close().catch(() => {})
      ctxM = null
    }

    /* ═══ P0-3 桌面工具条在气泡外侧 ═══════════════════════════════ */
    group('P0-3 桌面（1440x900）工具条位于气泡外侧、与气泡不重叠')
    {
      const d = await contextAs(browser, 'gate_a', { width: 1440, height: 900 })
      const page = d.page
      const shellOk = await ensureShell(page, 'gate_a')
      const opened = shellOk ? await openConv(page, '闸门 B', 'gate_a').catch(() => false) : false
      if (!opened) {
        skip('P0-3 桌面工具条外侧', '外壳/会话未就绪（限流）')
      } else {
        await page.waitForSelector('.bubble', { timeout: 15_000 }).catch(() => {})
        await sleep(600)
        /*
         * 取最后一条气泡（最新、就在视口底部）而不是第一条。
         *
         * 【实测踩坑，勿退回 .first()】原先用 `.pane__scroll .msg .bubble-wrap` 的
         * 第一个元素：它是本会话最老的消息，被 Playwright 自动滚动到视口上方才能
         * hover；但只要期间来一条 WS 新消息，消息区就会自动滚回底部，元素再次
         * 跑到屏幕外（实测 rect.top = -2015），CSS :hover 随之丢失，断言读到
         * opacity=0。最新一条本来就在视口内，没有这个竞态。
         */
        const wrap = page.locator('.pane__scroll .msg .bubble-wrap').last()
        const hovered = await wrap.hover().then(() => true).catch(() => false)
        // 把鼠标停在气泡正中心（hover() 之后坐标可能因布局微调而偏出）
        const box = await wrap.boundingBox().catch(() => null)
        if (box) {
          await page
            .mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            .catch(() => {})
        }
        await sleep(150)
        const geo = hovered
          ? await wrap
              .evaluate((el) => {
                const bubble = el.querySelector('.bubble')
                const tools = el.querySelector('.bubble__tools')
                if (!bubble || !tools) return { ok: false }
                const b = bubble.getBoundingClientRect()
                const t = tools.getBoundingClientRect()
                const cs = getComputedStyle(tools)
                const overlap = !(
                  t.bottom <= b.top ||
                  t.top >= b.bottom ||
                  t.right <= b.left ||
                  t.left >= b.right
                )
                return {
                  ok: true,
                  overlap,
                  opacity: cs.opacity,
                  display: cs.display,
                  bubble: { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) },
                  tools: { l: Math.round(t.left), t: Math.round(t.top), r: Math.round(t.right), b: Math.round(t.bottom) },
                }
              })
              .catch(() => ({ ok: false }))
          : { ok: false }
        check('P0-3 桌面可 hover 到气泡', hovered && geo.ok === true, `hovered=${hovered} geo.ok=${geo.ok}`)
        if (geo.ok) {
          check(
            'P0-3 工具条与气泡矩形不重叠',
            geo.overlap === false,
            `bubble=[${geo.bubble.l},${geo.bubble.t},${geo.bubble.r},${geo.bubble.b}] tools=[${geo.tools.l},${geo.tools.t},${geo.tools.r},${geo.tools.b}] 重叠=${geo.overlap}`,
          )
          check(
            'P0-3 hover 时工具条可见（opacity=1、非 display:none）',
            Number(geo.opacity) > 0.9 && geo.display !== 'none',
            `opacity=${geo.opacity} display=${geo.display}`,
          )
          check(
            'P0-3 工具条位于气泡水平外侧',
            geo.tools.r <= geo.bubble.l || geo.tools.l >= geo.bubble.r,
            `bubble.l=${geo.bubble.l} bubble.r=${geo.bubble.r} tools.l=${geo.tools.l} tools.r=${geo.tools.r}`,
          )
        }
        await shot(page, 'desktop-tools')
      }
      await d.ctx.close().catch(() => {})
    }

    /* ═══ P0-4 附件跨用户可看可下载 ═══════════════════════════════ */
    group('P0-4 附件跨用户可看可下载（图片渲染 + 灯箱 + 下载字节 sha256 一致，双向）')
    {
      const a = await contextAs(browser, 'gate_a', { width: 1280, height: 800 })
      ctxA = a.ctx
      const pageA = a.page
      const aOk = await ensureShell(pageA, 'gate_a')
      const aOpen = aOk ? await openConv(pageA, '闸门 B', 'gate_a').catch(() => false) : false

      const b = await contextAs(browser, 'gate_b', { width: 1280, height: 800 })
      ctxB = b.ctx
      const pageB = b.page
      const bOk = await ensureShell(pageB, 'gate_b')
      const bOpen = bOk ? await openConv(pageB, '闸门 A', 'gate_b').catch(() => false) : false

      if (!aOpen || !bOpen) {
        skip('P0-4 附件跨用户可看可下载', `会话未就绪 A=${aOpen} B=${bOpen}（限流）`)
      } else {
        /* —— 方向一：A 上传 PNG 发送，B 侧渲染 + 灯箱 —— */
        await pickVia(pageA, '.cbar__btn--image', paths.photo)
        const attachReady = await pageA
          .waitForSelector('.composer__att-name', { timeout: 60_000 })
          .then(() => true)
          .catch(() => false)
        const attNameText = attachReady
          ? (await pageA.locator('.composer__att-name').first().textContent())?.trim() ?? ''
          : ''
        // 等上传完成（按钮文案从「正在上传」回到「发送图片」）
        await until(
          () =>
            pageA.evaluate(() => {
              const b = document.querySelector('.cbar__btn--image')
              return !b || b.getAttribute('aria-label') !== '正在上传'
            }),
          60_000,
          200,
        )
        // v2 契约：带附件必须附带非空文字，否则 .composer__send 恒 disabled
        await pageA.locator('.composer__input').fill(`配图 ${photoName}`)
        await pageA.locator('.composer__send').click()
        await sleep(800)
        const bubbleOnA = await waitAttBubble(pageA, photoName)
        check(
          'P0-4 A 侧图片消息已出现在气泡中',
          attachReady && bubbleOnA,
          `缩略图待发区=${attachReady}（文件名="${attNameText}"）气泡出现=${bubbleOnA}`,
        )
        const bubbleOnB = await waitAttBubble(pageB, photoName)
        const imgB = bubbleOnB
          ? await evaluateImg(pageB, photoName, '.att--image img.att__thumb')
          : { found: false, ok: false, w: 0 }
        check(
          'P0-4 P0 修复：B 侧（非属主）图片渲染 naturalWidth>0',
          bubbleOnB && imgB.found && imgB.ok,
          `气泡出现=${bubbleOnB} 找到img=${imgB.found} naturalWidth=${imgB.w}`,
        )
        // 灯箱大图
        let lightbox = { opened: false, w: 0, closed: false }
        if (bubbleOnB) {
          const btn = pageB.locator('.bubble--attach', { hasText: photoName }).first().locator('.att__thumb-btn')
          await btn.click().catch(() => {})
          const panelOk = await pageB
            .waitForSelector('.mask .lightbox__img', { timeout: 15_000 })
            .then(() => true)
            .catch(() => false)
          if (panelOk) {
            lightbox.w = await pageB
              .locator('.mask .lightbox__img')
              .evaluate((el) => (el.complete && el.naturalWidth > 0 ? el.naturalWidth : 0))
              .catch(() => 0)
            lightbox.opened = true
            await shot(pageB, 'att-b-side')
            await pageB.keyboard.press('Escape')
            lightbox.closed = await until(
              () => pageB.locator('.mask .panel').isVisible().then((v) => !v).catch(() => true),
              8_000,
              200,
            )
          }
        }
        check(
          'P0-4 B 侧点开灯箱大图 naturalWidth>0（未降级为文件卡片）',
          lightbox.opened && lightbox.w > 0,
          `灯箱打开=${lightbox.opened} 大图 naturalWidth=${lightbox.w} Esc 关闭=${lightbox.closed}`,
        )

        /* —— 方向一续：A 上传 txt，B 侧下载字节 sha256 一致 —— */
        await pickVia(pageA, '.cbar__btn--attach', paths.note)
        const noteReady = await pageA
          .waitForSelector('.composer__att-name', { timeout: 60_000 })
          .then(() => true)
          .catch(() => false)
        await until(
          () =>
            pageA.evaluate(() => {
              const b = document.querySelector('.cbar__btn--attach')
              return !b || b.getAttribute('aria-label') !== '正在上传'
            }),
          60_000,
          200,
        )
        await pageA.locator('.composer__input').fill(`附件 ${noteName}`)
        await pageA.locator('.composer__send').click()
        await sleep(800)
        const noteOnB = await waitAttBubble(pageB, noteName)
        check('P0-4 B 侧收到 A 的 txt 文件卡片', noteReady && noteOnB, `待发区就绪=${noteReady} 气泡出现=${noteOnB}`)
        let dl = { clicked: false, ok: false, sha: '', size: 0 }
        if (noteOnB) {
          dl = await clickAndHashDownload(pageB, `.bubble--attach:has-text("${noteName}") .att--file`)
        }
        check(
          'P0-4 P0 修复：B 侧下载 A 的 txt，字节 sha256 与源文件一致',
          dl.ok && dl.sha === sha256(noteBuf),
          `下载=${dl.clicked} 大小=${dl.size}B/${noteBuf.length}B sha256=${dl.sha.slice(0, 16)}… 期望=${sha256(noteBuf).slice(0, 16)}…`,
        )

        /* —— 方向二（反向）：B 上传 txt 发送，A 侧下载 sha256 一致 —— */
        await pickVia(pageB, '.cbar__btn--attach', paths.back)
        const backReady = await pageB
          .waitForSelector('.composer__att-name', { timeout: 60_000 })
          .then(() => true)
          .catch(() => false)
        await until(
          () =>
            pageB.evaluate(() => {
              const el = document.querySelector('.cbar__btn--attach')
              return !el || el.getAttribute('aria-label') !== '正在上传'
            }),
          60_000,
          200,
        )
        await pageB.locator('.composer__input').fill(`反向附件 ${backName}`)
        await pageB.locator('.composer__send').click()
        await sleep(800)
        const backOnA = await waitAttBubble(pageA, backName)
        let dl2 = { clicked: false, ok: false, sha: '', size: 0 }
        if (backOnA) {
          dl2 = await clickAndHashDownload(pageA, `.bubble--attach:has-text("${backName}") .att--file`)
        }
        check(
          'P0-4 反向：A 侧下载 B 的 txt，字节 sha256 与源文件一致',
          backReady && backOnA && dl2.ok && dl2.sha === sha256(backBuf),
          `收到=${backOnA} 下载=${dl2.clicked} 大小=${dl2.size}B/${backBuf.length}B sha256=${dl2.sha.slice(0, 16)}… 期望=${sha256(backBuf).slice(0, 16)}…`,
        )

        /* —— P0-5 图片 / 文件双入口，图片一律缩略图 —— */
        group('P0-5 图片 / 文件双入口 + 图片一律 .att--image（不出现 .att--file）')
        const entry = await pageA.evaluate(() => {
          const imageBtn = document.querySelector('.cbar__btn--image')
          const fileBtn = document.querySelector('.cbar__btn--attach')
          const inputs = [...document.querySelectorAll('.composer__file')]
          const withoutAccept = inputs.find((el) => (el.getAttribute('accept') ?? '').trim().length === 0)
          return {
            imageBtn: !!imageBtn,
            fileBtn: !!fileBtn,
            imageLabel: imageBtn?.getAttribute('aria-label') ?? '',
            fileLabel: fileBtn?.getAttribute('aria-label') ?? '',
            inputCount: inputs.length,
            fileInputNoAccept: !!withoutAccept,
            sameNode: !!imageBtn && !!fileBtn && imageBtn === fileBtn,
          }
        })
        check(
          'P0-5 图片 / 文件是两个独立按钮',
          entry.imageBtn && entry.fileBtn && entry.sameNode === false,
          `imageBtn=${entry.imageBtn} fileBtn=${entry.fileBtn} 同一节点=${entry.sameNode}`,
        )
        check(
          'P0-5 两个入口 aria-label 分别为「发送图片」「发送文件」',
          entry.imageLabel === '发送图片' && entry.fileLabel === '发送文件',
          `图片入口="${entry.imageLabel}" 文件入口="${entry.fileLabel}"`,
        )
        /*
         * v2 实现是**单一 input + 打开前动态改写 accept**（见 MessageComposer.openPicker）。
         * 因此不能静态读 accept（初始值是多类型串），必须在真实点击入口后读它被改写成什么。
         * 这也顺带覆盖了「图片入口点下去确实只筛图片」这一行为断言。
         */
        const chooserImg = await Promise.all([
          pageA.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null),
          pageA.click('.cbar__btn--image').catch(() => {}),
        ]).then(([c]) => c)
        const imgAccept = (await pageA.locator('.composer__file').first().getAttribute('accept')) ?? ''
        check(
          'P0-5 图片入口打开的 input.accept 只含图片 MIME',
          chooserImg !== null && imgAccept.split(',').every((m) => m.trim().toLowerCase().startsWith('image/')),
          `filechooser=${chooserImg !== null} input 数=${entry.inputCount} accept="${imgAccept}"`,
        )
        await chooserImg?.setFiles([]).catch(() => {})
        check(
          'P0-5 文件入口 input 不限制 accept',
          entry.fileInputNoAccept,
          `存在无 accept 的 input=${entry.fileInputNoAccept}`,
        )
        const imgOnly = await pageA.evaluate(
          (n) => {
            const bubble = [...document.querySelectorAll('.bubble--attach')].find((el) =>
              (el.textContent || '').includes(n),
            )
            if (!bubble) return { found: false }
            return {
              found: true,
              asImage: bubble.querySelectorAll('.att--image').length,
              asFile: bubble.querySelectorAll('.att--file').length,
              thumbImg: bubble.querySelectorAll('.att__thumb').length,
              skeleton: bubble.querySelectorAll('.att__thumb-skeleton').length,
            }
          },
          photoName,
        )
        check(
          'P0-5 图片消息一律渲染为 .att--image（无 .att--file）',
          imgOnly.found && imgOnly.asImage === 1 && imgOnly.asFile === 0,
          `找到气泡=${imgOnly.found} .att--image=${imgOnly.asImage} .att--file=${imgOnly.asFile} .att__thumb=${imgOnly.thumbImg} skeleton=${imgOnly.skeleton}`,
        )
        check(
          'P0-5 种子图片消息（服务端侧发送）同样是 .att--image',
          await pageB.evaluate(
            (n) => {
              const bubble = [...document.querySelectorAll('.bubble--attach')].find((el) =>
                (el.textContent || '').includes(n),
              )
              return !!bubble && bubble.querySelectorAll('.att--image').length === 1 && bubble.querySelectorAll('.att--file').length === 0
            },
            seedName,
          ),
          `文件名 ${seedName} 在 B 侧渲染为缩略图`,
        )
      }
      await ctxA?.close().catch(() => {})
      await ctxB?.close().catch(() => {})
      ctxA = null
      ctxB = null
    }

    /* ═══ P0-6 置顶联动 ═══════════════════════════════════════════ */
    group('P0-6 置顶联动：A 置顶 → B 不刷新收到 conversation.pins → 置顶条出现 → 跳转 → 取消后消失')
    {
      const PIN_TAG = `${LONG_TAG}-5`
      const a = await contextAs(browser, 'gate_a', { width: 1280, height: 800 })
      ctxA = a.ctx
      const pageA = a.page
      const b = await contextAs(browser, 'gate_b', { width: 1280, height: 800 })
      ctxB = b.ctx
      const pageB = b.page
      const aOpen = (await ensureShell(pageA, 'gate_a')) && (await openConv(pageA, '闸门 B', 'gate_a').catch(() => false))
      const bOpen = (await ensureShell(pageB, 'gate_b')) && (await openConv(pageB, '闸门 A', 'gate_b').catch(() => false))
      if (!aOpen || !bOpen) {
        skip('P0-6 置顶联动', `会话未就绪 A=${aOpen} B=${bOpen}（限流）`)
      } else {
        await pageA.waitForSelector('.bubble', { timeout: 15_000 }).catch(() => {})
        await pageB.waitForSelector('.bubble', { timeout: 15_000 }).catch(() => {})
        await sleep(600)
        const bPinsBefore = await pageB.locator('.pane__pins').count()
        // B 侧记录当前 URL，稍后确认「没有刷新」
        const bUrlBefore = pageB.url()

        const targetWrap = pageA.locator('.msg', { hasText: PIN_TAG }).first().locator('.bubble-wrap')
        const found = (await targetWrap.count()) > 0
        if (!found) {
          skip('P0-6 置顶联动', `A 侧未找到含「${PIN_TAG}」的消息气泡`)
        } else {
          await targetWrap.hover()
          await sleep(300)
          const pinBtn = pageA.locator('.msg', { hasText: PIN_TAG }).first().locator('.bubble__tool[title="置顶消息"]')
          const pinBtnOk = (await pinBtn.count()) > 0
          if (!pinBtnOk) {
            check('P0-6 A 侧 hover 工具条出现「置顶消息」按钮', false, '未找到 .bubble__tool[title="置顶消息"]')
          } else {
            await pinBtn.click()
            const aPins = await until(
              () => pageA.locator('.pane__pins').isVisible().catch(() => false),
              15_000,
              250,
            )
            check('P0-6 A 侧置顶后置顶条出现', aPins, `.pane__pins 可见=${aPins}`)
            const bPinsVisible = await until(
              () => pageB.locator('.pane__pins').isVisible().catch(() => false),
              15_000,
              250,
            )
            const bPinText = bPinsVisible
              ? (await pageB.locator('.pane__pin-text').first().textContent())?.trim() ?? ''
              : ''
            check(
              'P0-6 B 侧未刷新即收到 conversation.pins，置顶条出现',
              bPinsVisible && bPinsBefore === 0 && pageB.url() === bUrlBefore,
              `置顶前 .pane__pins=${bPinsBefore} 置顶后可见=${bPinsVisible} URL 未变=${pageB.url() === bUrlBefore}`,
            )
            check(
              'P0-6 B 侧置顶条文案即被置顶消息内容',
              bPinText.includes(PIN_TAG),
              `置顶条文案="${bPinText.slice(0, 60)}" 期望含「${PIN_TAG}」`,
            )
            // 点置顶条跳转 → 目标消息获得一次性高亮 class。
            // 注意：`.pane__pins-list` 默认 display:none，只有 `.pane__pins--open`
            // 才展开（MessagePane.vue 的 `.pane__pins--open .pane__pins-list{display:block}`），
            // 所以必须先点 `.pane__pins-head` 展开，再点条目 —— 否则 Playwright 会
            // 报「element is not visible」并 30s 超时。
            let jumped = false
            if (bPinsVisible) {
              await pageB.locator('.pane__pins-head').first().click()
              const expanded = await until(
                () =>
                  pageB
                    .locator('.pane__pins-list')
                    .isVisible()
                    .catch(() => false),
                8_000,
                150,
              )
              check('P0-6 点置顶条标题可展开置顶列表', expanded, `展开后 .pane__pins-list 可见=${expanded}`)
              await pageB.locator('.pane__pin-btn').first().click()
              jumped = await until(
                () => pageB.locator('.pane__row--flash').count().then((n) => n > 0).catch(() => false),
                8_000,
                150,
              )
              const inView = await pageB
                .evaluate((tag) => {
                  const el = [...document.querySelectorAll('.pane__scroll .msg')].find((m) =>
                    (m.textContent || '').includes(tag),
                  )
                  if (!el) return false
                  const r = el.getBoundingClientRect()
                  return r.top >= 0 && r.bottom <= window.innerHeight + 2
                }, PIN_TAG)
                .catch(() => false)
              check('P0-6 点置顶条跳转到该消息（高亮 + 进入视口）', jumped && inView, `高亮=${jumped} 在视口内=${inView}`)
            }
            // A 取消置顶 → B 侧置顶条消失
            const unpinBtn = pageA.locator('.pane__pin-x').first()
            const unpinOk = (await unpinBtn.count()) > 0
            if (unpinOk) {
              await unpinBtn.click()
              const bGone = await until(
                () => pageB.locator('.pane__pins').isVisible().then((v) => !v).catch(() => true),
                15_000,
                250,
              )
              check('P0-6 取消置顶后 B 侧置顶条消失', bGone, `B 侧 .pane__pins 已消失=${bGone}`)
            } else {
              check('P0-6 A 侧置顶条上有取消按钮', false, '未找到 .pane__pin-x')
            }
          }
        }
        await shot(pageB, 'pins-sync')
      }
      await ctxA?.close().catch(() => {})
      await ctxB?.close().catch(() => {})
      ctxA = null
      ctxB = null
    }

    /* ═══ P0-7 群角色 ═════════════════════════════════════════════ */
    group('P0-7 群角色：owner 设 admin → 成员侧见管理员徽标；admin 踢 owner/admin 403；owner 踢 admin 200')
    {
      const A = await tokenOf('gate_a')
      const B = await tokenOf('gate_b')
      const C = await tokenOf('gate_c')
      const uidB = (await jget('/api/v1/users?q=gate_b', A.token)).body?.items?.[0]
      const uidC = (await jget('/api/v1/users?q=gate_c', A.token)).body?.items?.[0]
      if (!uidB?.id || !uidC?.id) {
        skip('P0-7 群角色', '找不到 gate_b / gate_c 的用户 id')
      } else {
        /*
         * 【不要盲信按名字复用的旧群】
         * 隔离库是长期复用的，上一轮留下的「UX2-P0群-*」里可能缺 gate_c ——
         * 因为 gate_a↔gate_c 的好友关系是**本轮**才建立的，而旧群建于好友关系之前。
         * 旧群若缺成员，后续 `members/:uid/role` 会 404 CONVERSATION_NOT_FOUND（uid 不在群里）。
         * 所以复用后必须校验成员完整性，缺谁补谁（POST /conversations/:id/members）。
         */
        const reuse = (await jget('/api/v1/conversations?limit=50&offset=0', A.token)).body?.items?.find(
          (c) => c.type === 'group' && (c.name ?? '').includes('UX2-P0群'),
        )
        const groupName = `UX2-P0群-${RUN}`
        let created = null
        if (reuse?.id) {
          const detail = await jget(`/api/v1/conversations/${reuse.id}`, A.token)
          const have = new Set((detail.body?.members ?? []).map((m) => m.user?.id))
          const missing = [uidB.id, uidC.id].filter((id) => !have.has(id))
          if (missing.length > 0) {
            const added = await jpost(`/api/v1/conversations/${reuse.id}/members`, A.token, { memberIds: missing })
            if (added.status !== 200) {
              // 补成员失败（例如已不是好友）→ 改为新建，避免后续断言被脏群带偏
              created = await jpost('/api/v1/conversations/group', A.token, { name: groupName, memberIds: [uidB.id, uidC.id] })
            }
          }
          created ??= { status: 200, body: { id: reuse.id } }
        } else {
          created = await jpost('/api/v1/conversations/group', A.token, { name: groupName, memberIds: [uidB.id, uidC.id] })
        }
        const groupId = created.body?.id
        check('P0-7 前置：群聊创建/复用成功', !!groupId, `status=${created.status} groupId=${groupId ?? '(none)'}`)
        if (!groupId) {
          skip('P0-7 群角色', '群聊未创建成功')
        } else {
          const setB = await jpost(`/api/v1/conversations/${groupId}/members/${uidB.id}/role`, A.token, { role: 'admin' })
          check(
            'P0-7 owner 把 gate_b 设为 admin（200）',
            setB.status === 200,
            `status=${setB.status} code=${setB.body?.error?.code ?? '-'}`,
          )
          // B 侧打开群信息页 → 自己那条成员显示管理员徽标
          const b = await contextAs(browser, 'gate_b', { width: 1280, height: 800 })
          ctxB = b.ctx
          const pageB = b.page
          const bShell = await ensureShell(pageB, 'gate_b')
          if (!bShell) {
            skip('P0-7 成员侧管理员徽标', '外壳未就绪（限流）')
          } else {
            await pageB.goto(`${BASE}/chat/${groupId}/info`, { waitUntil: 'domcontentloaded' })
            const infoOk = await pageB
              .waitForSelector('.info__body', { timeout: 15_000 })
              .then(() => true)
              .catch(() => false)
            const badges = infoOk
              ? await pageB.evaluate(() =>
                  [...document.querySelectorAll('.member')].map((m) => ({
                    name: (m.querySelector('.member__name')?.textContent ?? '').trim(),
                    role: m.getAttribute('data-role'),
                    badge: (m.querySelector('.member__badge')?.textContent ?? '').trim(),
                  })),
                )
              : []
            const selfBadge = badges.find((x) => x.name.includes('（我）')) ?? badges.find((x) => x.name.includes('闸门 B'))
            check(
              'P0-7 成员侧群信息页看到「管理员」徽标',
              !!selfBadge && selfBadge.badge === '管理员' && selfBadge.role === 'admin',
              `成员列表=${JSON.stringify(badges)}`,
            )
            const canRename = await pageB.locator('.info__edit').count()
            check('P0-7 admin 也看得到改群名入口（canManage）', canRename === 1, `.info__edit 数量=${canRename}`)
            await shot(pageB, 'group-admin-badge')
          }
          await ctxB?.close().catch(() => {})
          ctxB = null

          // admin 踢 owner / 踢另一位 admin → 403
          const setC = await jpost(`/api/v1/conversations/${groupId}/members/${uidC.id}/role`, A.token, { role: 'admin' })
          check('P0-7 前置：owner 把 gate_c 也设为 admin（200）', setC.status === 200, `status=${setC.status}`)
          // `GET /users?q=` 会排除自己（SQL 里 `id <> ?`），所以查不到 gate_a 自己的 id ——
          // 用 /users/me 拿到的 id，否则路径参数是 undefined，Fastify 先以
          // 400 VALIDATION_ERROR（params/userId must match format "uuid"）挡掉，
          // 权限判定根本不会被调用，断言就会拿 400 去比 403 而假 FAIL。
          const selfId = meA.body?.id ?? null
          const kickOwner = await jdel(`/api/v1/conversations/${groupId}/members/${selfId}`, B.token)
          check(
            'P0-7 admin 踢 owner 被拒（403 OWNER_REQUIRED）',
            kickOwner.status === 403 && kickOwner.body?.error?.code === 'OWNER_REQUIRED',
            `target=gate_a(${selfId ?? 'missing'}) status=${kickOwner.status} code=${kickOwner.body?.error?.code ?? '-'} msg=${kickOwner.body?.error?.message ?? '-'}`,
          )
          const kickAdmin = await jdel(`/api/v1/conversations/${groupId}/members/${uidC.id}`, B.token)
          check(
            'P0-7 admin 踢另一位 admin 被拒（403 OWNER_REQUIRED）',
            kickAdmin.status === 403 && kickAdmin.body?.error?.code === 'OWNER_REQUIRED',
            `status=${kickAdmin.status} code=${kickAdmin.body?.error?.code ?? '-'} msg=${kickAdmin.body?.error?.message ?? '-'}`,
          )
          const kickByOwner = await jdel(`/api/v1/conversations/${groupId}/members/${uidC.id}`, A.token)
          check(
            'P0-7 owner 踢 admin 成功（200）',
            kickByOwner.status === 200,
            `status=${kickByOwner.status} body=${JSON.stringify(kickByOwner.body)}`,
          )
          const detailAfter = await jget(`/api/v1/conversations/${groupId}`, A.token)
          const stillHasC = (detailAfter.body?.members ?? []).some((m) => m.user?.id === uidC.id)
          check('P0-7 被 owner 移除后成员列表不再含 gate_c', stillHasC === false, `仍含=${stillHasC}`)
        }
      }
    }

    /* ═══ P0-8 UID 登录 ═══════════════════════════════════════════ */
    group('P0-8 UID 登录：登录页用数字 UID（非账号名）真实登录')
    {
      /*
       * 【原断言 `uid === 10001` 已删除，勿恢复】
       * 隔离库是长期复用的一份（register 对已存在用户返回 409），gate_a 不一定是
       * 第一个注册的用户 —— 实测某轮 uid=10003。UID 登录能力与「是不是 10001」无关，
       * 只要求它落在系统分配的 UID 段（FIRST_USER_UID=10001 起）内且能真实登录。
       */
      check(
        'P0-8 前置：gate_a 已分配到系统 UID（≥10001）',
        Number.isInteger(Number(uidA)) && Number(uidA) >= 10001,
        `uid=${uidA}`,
      )
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      watchPage(page)
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
      const sub = (await page.locator('.auth__sub').first().textContent().catch(() => ''))?.trim() ?? ''
      check(
        'P0-8 登录页提示支持「账号名或 UID」',
        sub.includes('UID'),
        `副标题="${sub}"`,
      )
      const label = (await page.locator('.auth__form .field__label').first().textContent().catch(() => ''))?.trim() ?? ''
      check('P0-8 首个输入框标签为「账号名或 UID」', label === '账号名或 UID', `label="${label}"`)
      const fields = page.locator('.auth__form .field__input')
      await fields.nth(0).fill(String(uidA))
      await fields.nth(1).fill(PW)
      await page.locator('.auth__form .btn').first().click()
      const loggedIn = await until(
        () => page.evaluate(() => location.pathname.startsWith('/chat')).catch(() => false),
        20_000,
        250,
      )
      const avatarTitle = loggedIn
        ? (await page.locator('.rail .avatar').first().getAttribute('title').catch(() => null)) ?? ''
        : ''
      check(
        'P0-8 用 UID 登录成功并进入 /chat',
        loggedIn && avatarTitle === '闸门 A',
        `URL=${page.url()} 顶栏身份="${avatarTitle}"`,
      )
      await shot(page, 'uid-login')
      await ctx.close().catch(() => {})
    }

    /* ═══ 收尾：全程无未捕获异常 ═════════════════════════════════ */
    group('全局：无未捕获前端异常')
    check('全程无 pageerror', pageErrors.length === 0, `pageerror=${pageErrors.length}${pageErrors.length ? ` 首例=${JSON.stringify(pageErrors[0])}` : ''}`)
  } finally {
    await ctxA?.close().catch(() => {})
    await ctxB?.close().catch(() => {})
    await ctxM?.close().catch(() => {})
    await browser.close().catch(() => {})
    clearTimeout(hardTimer)
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return finish()
}

/* ── 页面内几何/遮挡采样 ────────────────────────────────────────── */
function occludeReport(page) {
  return page.evaluate(() => {
    const out = {
      bubbles: 0,
      samples: 0,
      occluded: [],
      textOverflow: [],
      textBlocks: 0,
      hitTools: 0,
    }
    const scroll = document.querySelector('.pane__scroll')
    if (!scroll) return out
    // 采样点必须落在**滚动容器的可视裁剪区**内：气泡滚出（或部分滚出）.pane__scroll
    // 之后，它的 rect 仍然存在，但被 overflow:hidden 裁掉，elementFromPoint 会命中
    // 上层的 .pane__head —— 那不是「正文被遮挡」，是气泡本来就不在可视区。
    // 先算裁剪区，后续所有采样都以它为界（否则 320x568 这种矮视口必然假 FAIL）。
    const sr = scroll.getBoundingClientRect()
    const clipL = Math.max(0, sr.left)
    const clipR = Math.min(innerWidth, sr.right)
    const clipT = Math.max(0, sr.top)
    const clipB = Math.min(innerHeight, sr.bottom)
    const inClip = (x, y) => x >= clipL && x <= clipR && y >= clipT && y <= clipB
    const bubbles = [...scroll.querySelectorAll('.bubble')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    })
    out.bubbles = bubbles.length
    out.clip = {
      l: Math.round(clipL),
      r: Math.round(clipR),
      t: Math.round(clipT),
      b: Math.round(clipB),
    }
    const label = (el) => {
      if (!el) return 'null'
      const cls = typeof el.className === 'string' ? el.className : ''
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}`
    }
    for (const b of bubbles) {
      const r = b.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      if (inClip(cx, cy)) {
        out.samples += 1
        const hit = document.elementFromPoint(cx, cy)
        const inBubble = !!hit && (hit === b || b.contains(hit))
        if (!inBubble) {
          out.occluded.push({ at: 'center', hit: label(hit), msgId: (b.closest('.msg')?.getAttribute('data-msg-id') ?? '').slice(0, 8) })
        }
        if (hit && (hit.closest('.bubble__tools') || hit.closest('.mask'))) out.hitTools += 1
      }
      const t = b.querySelector('.bubble__text')
      if (!t) continue
      out.textBlocks += 1
      if (t.scrollWidth > t.clientWidth + 1) {
        out.textOverflow.push({ kind: 'overflow-x', sw: t.scrollWidth, cw: t.clientWidth })
      }
      const tr = t.getBoundingClientRect()
      if (tr.width < 4 || tr.height < 4) continue
      for (let iy = 1; iy <= 3; iy += 1) {
        for (let ix = 1; ix <= 3; ix += 1) {
          const x = tr.left + (tr.width * ix) / 4
          const y = tr.top + (tr.height * iy) / 4
          if (!inClip(x, y)) continue
          out.samples += 1
          const h = document.elementFromPoint(x, y)
          if (!h) continue
          if (h.closest('.bubble__tools') || h.closest('.mask')) {
            out.hitTools += 1
            out.occluded.push({ at: `${ix},${iy}`, hit: label(h), msgId: (b.closest('.msg')?.getAttribute('data-msg-id') ?? '').slice(0, 8) })
            continue
          }
          const ok = t.contains(h) || b.contains(h)
          if (!ok) {
            out.occluded.push({ at: `${ix},${iy}`, hit: label(h), msgId: (b.closest('.msg')?.getAttribute('data-msg-id') ?? '').slice(0, 8) })
          }
        }
      }
    }
    // 去重（同一 msgId + 同一 hit 只留一条），避免详情过长
    const seen = new Set()
    out.occluded = out.occluded.filter((o) => {
      const k = `${o.msgId}|${o.hit}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return out
  })
}

/** 取一个可见气泡的中心坐标（移动端长按用）。 */
/** 取一个可见气泡的中心坐标（移动端长按用）。
 *  needle 给了就优先选「正文含该串」的气泡 —— 长按菜单项跟消息内容有关
 *  （没有 Markdown 语法的消息不会出现「看 Markdown 源码」），所以用例必须
 *  自己指定要长按哪一类消息，不能随便取中间那条。 */
function bubbleCenter(page, needle) {
  return page.evaluate((n) => {
    const scroll = document.querySelector('.pane__scroll')
    if (!scroll) return null
    const all = [...scroll.querySelectorAll('.bubble')].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 4 && r.height > 4
    })
    if (!all.length) return null
    let el = n ? all.find((b) => (b.textContent || '').includes(n)) ?? null : null
    if (el) {
      // 指定了 needle：目标可能滚出可视区，先把它滚到中间再取坐标。
      el.scrollIntoView({ block: 'center' })
    } else {
      // 没指定（或没命中）：退化为「完全落在滚动区可视范围内」的中间那条。
      const sr = scroll.getBoundingClientRect()
      const vis = all.filter((b) => {
        const r = b.getBoundingClientRect()
        return r.top >= sr.top && r.bottom <= sr.bottom && r.bottom <= innerHeight
      })
      if (!vis.length) return null
      el = vis[Math.floor(vis.length / 2)]
    }
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: (el.textContent || '').slice(0, 40),
    }
  }, needle ?? '')
}

/** 取某个附件气泡的中心坐标。 */
function attachBubbleCenter(page, name) {
  return page.evaluate((n) => {
    const el = [...document.querySelectorAll('.bubble--attach')].find((b) => (b.textContent || '').includes(n))
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    el.scrollIntoView({ block: 'center' })
    const r2 = el.getBoundingClientRect()
    return { x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) }
  }, name)
}

/** 读取长按菜单状态。 */
function menuState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.mask .panel')
    if (!panel) return { visible: false, title: '', items: [] }
    const r = panel.getBoundingClientRect()
    const title = (panel.querySelector('.panel__title')?.textContent ?? '').trim()
    const items = [...panel.querySelectorAll('.sheet__item .sheet__label')].map((e) => (e.textContent ?? '').trim())
    return { visible: r.width > 0 && r.height > 0, title, items }
  })
}

async function evaluateImg(page, fileName, selector) {
  return page.evaluate(
    ([n, sel]) => {
      const root = [...document.querySelectorAll('.bubble--attach')].find((el) => (el.textContent || '').includes(n))
      if (!root) return { found: false, ok: false, w: 0 }
      const img = root.querySelector(sel)
      if (!img) return { found: false, ok: false, w: 0 }
      return { found: true, ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth }
    },
    [fileName, selector],
  )
}

/** 点击触发下载并计算字节 sha256。 */
async function clickAndHashDownload(page, selector) {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25_000 }),
      page.locator(selector).first().click(),
    ])
    const p = await download.path()
    if (!p) return { clicked: true, ok: false, sha: '', size: 0 }
    const buf = readFileSync(p)
    return { clicked: true, ok: true, sha: sha256(buf), size: buf.length }
  } catch (e) {
    console.log(`   … 下载失败：${String(e?.message ?? e).slice(0, 160)}`)
    return { clicked: false, ok: false, sha: '', size: 0 }
  }
}

function finish() {
  const failed = results.filter((r) => !r.ok && !r.defect)
  const skipped = results.filter((r) => r.skipped)
  const passed = results.filter((r) => r.ok && !r.skipped)

  console.log(
    `\n=== 汇总：${results.length} 项 —— 通过 ${passed.length}，失败 ${failed.length}，产品缺陷 ${defects.length}，待验 ${skipped.length} ===`,
  )
  if (failed.length) {
    console.log('\nFAIL：')
    for (const f of failed) console.log(`  - ${f.name}  —— ${f.detail}`)
  }
  if (defects.length) {
    console.log('\nDEFECT（产品行为不符合验收）：')
    for (const d of defects) console.log(`  - ${d.name}  —— ${d.detail}`)
  }
  if (skipped.length) {
    console.log('\nSKIP：')
    for (const s of skipped) console.log(`  - ${s.name}  —— ${s.detail}`)
  }
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  clearTimeout(hardTimer)
  console.error('脚本异常：', e)
  process.exit(1)
})
