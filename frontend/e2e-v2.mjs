/**
 * v2 需求验收 —— 六项用户诉求（m00016）的浏览器实证。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 *   e2e-gates / e2e-responsive / e2e-matrix / e2e-attachment / e2e-ux2-p0
 *   是**既有基线**，各自覆盖它们被点名验收的诉求。本文件只新增，不改它们
 *   任何一条断言（工具函数复制而非 import：既有基线是对照组，抽公共模块
 *   会污染对照）。
 *
 * ── 覆盖（对照 m00016 的六条）───────────────────────────────────────
 *   需求1  个人信息重构：桌面左上角头像 → 左侧抽屉；抽屉宽度覆盖会话列表列；
 *          详细资料/主题/退出登录都在抽屉里；退出登录必须二次确认；
 *          移动端底部导航第三位＝个人信息（不再是「更多」）→ 底部上拉抽屉，
 *          展开后变全屏详细资料。
 *   需求2  点别人头像进访客资料页：聊天气泡旁头像、广场动态头像两条入口。
 *   需求3  主题：≥5 套预置 + 1 套自定义（8 个取色器 + 3 种聊天区背景）；
 *          切换后 <html> 的 data-theme/data-theme-mode 正确；自定义刷新后仍在。
 *   需求4  消息附件：多图多文件（≤9，视频≤1）、有附件必须带文字、
 *          带文字发附件时文字不被吞、有附件时 Enter 不发送（Ctrl+Enter 或按钮）。
 *   需求5  管理员初始化：root/12345678 可登录且是 admin；reset-db.mjs 有
 *          --confirm 门禁（**只验负向，不真清库**）。
 *   需求6  广场：入口、发帖（文字/图片）、5000 字上限、点赞、评论、删除、
 *          通用文件附件被拒、未登录不可达。
 *
 * ── 输入（全部可用环境变量覆盖）────────────────────────────────────
 *   BASE            默认 http://localhost:5173
 *                   ⚠️ 必须 `--mode integration` 起 dev，否则 MSW mock 拦一切
 *   BACKEND         默认 http://127.0.0.1:3099
 *   HARD_TIMEOUT_MS 默认 600000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐条 PASS / FAIL / DEFECT / SKIP + 实测值 + 汇总
 *   截图：docs/evidence/v2-*.png
 *   退出码：0 = 无 FAIL/DEFECT；1 = 有；3 = 硬超时
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   只在隔离后端注册/登录测试账号、发测试消息与动态、上传测试文件，
 *   跑完删除本次创建的动态。临时文件写系统 temp，跑完删除。
 *   不碰生产、不改源码、不 commit。
 */

import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')
const REPO_ROOT = resolve(HERE, '..')

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
  await page.screenshot({ path: resolve(SHOT_DIR, `v2-${name}.png`) })
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

/**
 * 最小可过魔数的 MP4。
 * 后端 detectMimeType 判 video/mp4 的条件是 `bytes.subarray(4,8) === 'ftyp'`，
 * 前 4 字节是 box 长度 —— 所以只要偏移 4..8 是 'ftyp' 就够，不需要真能播放。
 */
function makeMp4(seed = 1) {
  const head = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('isom', 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2', 'latin1'),
  ])
  return Buffer.concat([head, Buffer.alloc(4096, seed & 0xff)])
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
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'v2 验收' })
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
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'v2 验收' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const inc = (reqs.body?.items ?? []).find(
    (r) => r.sender?.username === a && r.status === 'pending',
  )
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
    hasTouch: viewport.width <= 767,
    isMobile: false,
    ...extra,
  })
  const page = await ctx.newPage()
  watchPage(page)
  await setAuth(page, username)
  return { ctx, page }
}
async function pickFiles(page, buttonSelector, filePaths) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.click(buttonSelector),
  ])
  await chooser.setFiles(filePaths)
}
async function openConv(page, title) {
  await page.locator('.item', { hasText: title }).first().click()
  await page.waitForSelector('.pane__scroll', { timeout: 15_000 })
}
/** 页面上 `.pane__row` 的数量（用来看「有没有多出一条消息」）。 */
const rowCount = (page) => page.locator('.pane__row').count()
/** textarea 当前值。 */
const inputValue = (page, sel) => page.locator(sel).inputValue()

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== v2 需求验收  BASE=${BASE}  BACKEND=${BACKEND}  RUN=${RUN} ===\n`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'aitr-v2-'))
  const imgA = `v2-a-${RUN}.png`
  const imgB = `v2-b-${RUN}.png`
  const mp4A = `v2-a-${RUN}.mp4`
  const mp4B = `v2-b-${RUN}.mp4`
  const paths = {
    a: join(tmpDir, imgA),
    b: join(tmpDir, imgB),
    mp4a: join(tmpDir, mp4A),
    mp4b: join(tmpDir, mp4B),
  }
  writeFileSync(paths.a, makePng(220, 150, 11))
  writeFileSync(paths.b, makePng(140, 180, 29))
  writeFileSync(paths.mp4a, makeMp4(3))
  writeFileSync(paths.mp4b, makeMp4(9))
  console.log(`临时素材：${tmpDir}\n`)

  /* ── 账号与会话准备 ── */
  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  await jpatch(
    '/api/v1/users/me',
    (await tokenOf('gate_a')).token,
    { displayName: '闸门 A' },
  )
  await jpatch(
    '/api/v1/users/me',
    (await tokenOf('gate_b')).token,
    { displayName: '闸门 B' },
  )
  await ensureFriend('gate_a', 'gate_b')
  const convAB = await ensureDirectConv('gate_a', 'gate_b')
  if (!convAB) throw new Error('无法建立 gate_a ↔ gate_b 会话')
  const meA = await jget('/api/v1/users/me', (await tokenOf('gate_a')).token)
  const meB = await jget('/api/v1/users/me', (await tokenOf('gate_b')).token)
  const uidB = meB.body?.uid
  console.log(`会话 AB=${convAB}  B.uid=${uidB}\n`)

  /*
   * 给 gate_a 设一个真实的站内头像（需求 1 的核心 bug 是「rail 头像不传 src，
   * 永远只显示首字母」）。不设头像的话下面那条断言只能 SKIP —— 而 SKIP 意味着
   * 「抽屉外头像显示真实图片」这个**最该被证伪的回归点**没被覆盖。
   * 走真实链路：上传 PNG → PATCH /users/me 的 avatarUrl。
   */
  const avatarUp = await uploadBytesAs('gate_a', `v2-avatar-${RUN}.png`, makePng(96, 96, 7), 'image/png')
  const avatarSet = avatarUp.status === 200 || avatarUp.status === 201
    ? await jpatch('/api/v1/users/me', (await tokenOf('gate_a')).token, {
        avatarUrl: `/api/v1/uploads/${avatarUp.body?.id}`,
      })
    : { status: avatarUp.status, body: null }
  console.log(`gate_a 头像：upload=${avatarUp.status} patch=${avatarSet.status} url=${avatarSet.body?.avatarUrl ?? '(失败)'}\n`)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const createdPostIds = []

  try {
    /* ══════════════════════════════════════════════════════════════
     * 需求 5（先跑，纯 API，不依赖 UI）
     * ══════════════════════════════════════════════════════════════ */
    group('需求 5：管理员初始化与重置门禁')
    const rootLogin = await login('root', '12345678')
    checkProduct(
      'root/12345678 可登录',
      rootLogin.status === 200,
      `status=${rootLogin.status}${rootLogin.body?.error ? ` code=${rootLogin.body.error.code}` : ''}`,
    )
    checkProduct('root 是管理员且 uid=1001', rootLogin.body?.user?.role === 'admin' && rootLogin.body?.user?.uid === 1001, `role=${rootLogin.body?.user?.role} uid=${rootLogin.body?.user?.uid}`)
    const rootTok = rootLogin.body?.token
    if (rootTok) {
      const adminUsers = await jget('/api/v1/admin/users?limit=100&offset=0', rootTok)
      const admins = (adminUsers.body?.items ?? []).filter((u) => u.role === 'admin')
      checkProduct(
        'root 是唯一管理员',
        admins.length === 1 && admins[0].username === 'root',
        `admins=${admins.map((u) => u.username).join(',') || '(空)'}`,
      )
    } else {
      skip('root 是唯一管理员', 'root 登录失败，无法取 admin 列表')
    }
    // reset-db.mjs 的 --confirm 门禁：只验「不给 --confirm 会拒绝」，绝不真清库
    const resetScript = resolve(REPO_ROOT, 'backend/scripts/reset-db.mjs')
    const noConfirm = spawnSync(process.execPath, [resetScript], {
      env: { ...process.env, DATABASE_PATH: resolve(tmpDir, 'never-created.sqlite') },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const noConfirmOut = `${noConfirm.stdout ?? ''}${noConfirm.stderr ?? ''}`
    checkProduct(
      'reset-db.mjs 没有 --confirm 时拒绝执行',
      noConfirm.status !== 0 && /confirm/i.test(noConfirmOut),
      `exit=${noConfirm.status} 输出含 confirm=${/confirm/i.test(noConfirmOut)}`,
    )

    /* ══════════════════════════════════════════════════════════════
     * 需求 1 桌面：左上角头像 → 左侧抽屉
     * ══════════════════════════════════════════════════════════════ */
    group('需求 1：桌面个人信息抽屉')
    const { ctx: deskCtx, page: desk } = await contextAs(browser, 'gate_a', {
      width: 1280,
      height: 800,
    })
    check('桌面外壳就绪', await ensureShell(desk, 'gate_a'), `url=${desk.url()}`)

    const railAvatar = desk.locator('.rail__avatar')
    checkProduct(
      '左上角头像可点（aria-haspopup=dialog）',
      (await railAvatar.count()) === 1 &&
        (await railAvatar.getAttribute('aria-haspopup')) === 'dialog',
      `count=${await railAvatar.count()} haspopup=${await railAvatar.getAttribute('aria-haspopup')}`,
    )
    // 需求 1 的原始 bug：rail 头像不传 src（只显示首字母）。这里断言头像里确有 <img>。
    // 上面已给 gate_a 上传并设置过站内头像，所以这条不该再走 SKIP 分支；
    // 若仍无 <img>，说明「头像接线」这个需求 1 的核心缺陷回归了 → 记为产品缺陷。
    const avatarHasImg = await desk
      .locator('.rail__avatar img.avatar-img')
      .count()
      .catch(() => 0)
    const avatarImgVisible = avatarHasImg > 0 ? await desk.locator('.rail__avatar img.avatar-img').first().isVisible().catch(() => false) : false
    checkProduct(
      '抽屉外头像显示真实图片（需求 1 的原始 bug）',
      avatarHasImg > 0 && avatarImgVisible,
      `img=${avatarHasImg} 可见=${avatarImgVisible}`,
    )

    checkProduct(
      '侧栏底部不再有主题/退出按钮',
      (await desk.locator('.rail button[title="退出登录"]').count()) === 0 &&
        (await desk.locator('.rail button[title="切换深色"]').count()) === 0,
      `退出按钮=${await desk.locator('.rail button[title="退出登录"]').count()}`,
    )

    await railAvatar.click()
    const drawer = desk.locator('.pdrawer')
    checkProduct(
      '点左上角头像打开左侧抽屉',
      await drawer.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      `可见=${await drawer.isVisible().catch(() => false)}`,
    )
    // 抽屉有 0.18s 的 enter 过渡（`translateX(-8%)` → 0）。必须在过渡结束后
    // 再量位置，否则会量到动画中途的 x —— 那不是缺陷，是测量时机错了。
    await sleep(500)
    const dbox = await drawer.boundingBox().catch(() => null)
    const sidebarW = await desk.evaluate(() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--spacing-sidebar')
      return parseFloat(raw) || 0
    })
    const railW = await desk.evaluate(() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--spacing-rail')
      return parseFloat(raw) || 0
    })
    // 需求原文「宽度覆盖联系人栏」：抽屉左缘贴着 rail，宽度等于会话列表列宽
    checkProduct(
      '抽屉宽度覆盖会话列表列且紧贴侧栏',
      !!dbox &&
        Math.abs(dbox.width - sidebarW) <= 2 &&
        Math.abs(dbox.x - railW) <= 2,
      `drawer(x=${dbox?.x?.toFixed(1)},w=${dbox?.width?.toFixed(1)}) sidebarW=${sidebarW} railW=${railW}`,
    )

    const entryLabels = await desk.locator('.pdrawer__entry-label').allInnerTexts()
    checkProduct(
      '抽屉含「详细资料 / 主题 / 退出登录」三项',
      ['详细资料', '主题', '退出登录'].every((t) => entryLabels.includes(t)),
      `entries=${JSON.stringify(entryLabels)}`,
    )
    // 主题面板默认是折叠的（themeOpen=false），必须先点「主题」行把面板展开。
    await desk.locator('.pdrawer__entry', { hasText: '主题' }).first().click()
    const themePanelShown = await desk
      .waitForSelector('.pdrawer #pdrawer-theme-panel .tp__card', { timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    const drawerThemeCards = await desk.locator('.pdrawer #pdrawer-theme-panel .tp__card').count()
    checkProduct(
      '抽屉内主题入口可展开出主题选择器',
      themePanelShown && drawerThemeCards === 7,
      `展开=${themePanelShown} tp__card=${drawerThemeCards}（期望 7）`,
    )
    await shot(desk, 'req1-drawer')

    // 退出登录二次确认：打开后点「取消」，必须仍在抽屉、仍在 /chat
    await desk.locator('.pdrawer__entry--danger').click()
    const logoutDialog = desk.locator('.mask .panel')
    const dialogShown = await logoutDialog
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    const dialogText = dialogShown ? await logoutDialog.innerText().catch(() => '') : ''
    checkProduct(
      '退出登录弹二次确认',
      dialogShown && /确定要退出|退出/.test(dialogText),
      `可见=${dialogShown} 文案含「退出」=${/退出/.test(dialogText)}`,
    )
    await shot(desk, 'req1-logout-confirm')
    const cancelBtn = desk.locator('.mask .panel .panel__foot .btn', { hasText: '取消' })
    if (await cancelBtn.count()) {
      await cancelBtn.first().click()
      await sleep(400)
    }
    const stillChat = new URL(desk.url()).pathname.startsWith('/chat')
    checkProduct(
      '取消后不退出登录',
      stillChat && (await logoutDialog.isVisible().catch(() => false)) === false,
      `url=${new URL(desk.url()).pathname} 弹层仍可见=${await logoutDialog.isVisible().catch(() => false)}`,
    )
    // 关抽屉，别影响后续
    await desk.locator('.pdrawer__close').click().catch(() => {})
    await sleep(300)

    /* ══════════════════════════════════════════════════════════════
     * 需求 3：主题（桌面抽屉内，7 套预置 + 自定义）
     * ══════════════════════════════════════════════════════════════ */
    group('需求 3：主题系统')
    await railAvatar.click()
    // 抽屉重新打开后 themeOpen 已被 watch 复位为 false（ProfileDrawer.vue:137），
    // 所以这里同样要先点「主题」行展开。
    await desk.locator('.pdrawer__entry', { hasText: '主题' }).first().click()
    await desk.waitForSelector('.pdrawer #pdrawer-theme-panel .tp__card', { timeout: 8_000 })
    const themeLabels = await desk.locator('.pdrawer .tp__card').evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label')),
    )
    checkProduct(
      '预置主题 ≥5 套 + 自定义',
      themeLabels.length >= 6 && themeLabels.includes('自定义'),
      `themes=${JSON.stringify(themeLabels)}`,
    )

    async function pickTheme(label) {
      await desk.locator('.pdrawer .tp__card', { hasText: label }).first().click()
      await sleep(350)
      return desk.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.themeMode,
      }))
    }
    const dark = await pickTheme('深色')
    checkProduct(
      '切「深色」→ data-theme=dark / mode=dark',
      dark.theme === 'dark' && dark.mode === 'dark',
      JSON.stringify(dark),
    )
    const ocean = await pickTheme('海洋')
    checkProduct(
      '切「海洋」→ data-theme=ocean / mode=light',
      ocean.theme === 'ocean' && ocean.mode === 'light',
      JSON.stringify(ocean),
    )
    const midnight = await pickTheme('午夜')
    checkProduct(
      '切「午夜」→ data-theme=midnight / mode=dark',
      midnight.theme === 'midnight' && midnight.mode === 'dark',
      JSON.stringify(midnight),
    )
    await shot(desk, 'req3-midnight')

    // 自定义：8 个取色器 + 3 种聊天区背景 + 变量实时生效
    await desk.locator('.pdrawer .tp__card', { hasText: '自定义' }).first().click()
    await desk.waitForSelector('.pdrawer .tp__custom', { timeout: 8_000 })
    const colorLabels = await desk.locator('.pdrawer .tp__color-input').evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label')),
    )
    const needLabels = [
      '主色',
      '聊天区背景',
      '我的气泡背景',
      '我的气泡文字',
      '对方气泡背景',
      '对方气泡文字',
      '面板背景',
      '主文字色',
    ]
    checkProduct(
      '自定义提供 8 个取色器（含聊天框/字体/背景）',
      needLabels.every((l) => colorLabels.includes(l)),
      `labels=${JSON.stringify(colorLabels)}`,
    )
    const segLabels = await desk
      .locator('.pdrawer .tp__seg-btn')
      .evaluateAll((els) => els.map((e) => e.textContent.trim()))
    checkProduct(
      '自定义背景支持 纯色/渐变/图片',
      ['纯色', '渐变', '图片'].every((t) => segLabels.some((s) => s.includes(t))),
      `seg=${JSON.stringify(segLabels)}`,
    )

    const CUSTOM_PRIMARY = '#c81e5a'
    await desk.evaluate((v) => {
      const el = document.querySelector('.pdrawer input.tp__color-input[aria-label="主色"]')
      if (!el) throw new Error('找不到主色取色器')
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, CUSTOM_PRIMARY)
    await sleep(400)
    const brandVar = await desk.evaluate(() =>
      document.documentElement.style.getPropertyValue('--color-brand-500').trim(),
    )
    checkProduct(
      '自定义主色实时落到 --color-brand-500',
      brandVar.toLowerCase() === CUSTOM_PRIMARY,
      `--color-brand-500=${brandVar || '(空)'}`,
    )

    // 渐变背景：--chat-canvas-image 应变成 linear-gradient
    await desk.locator('.pdrawer .tp__seg-btn', { hasText: '渐变' }).first().click()
    await sleep(400)
    const canvasImageVar = await desk.evaluate(() =>
      document.documentElement.style.getPropertyValue('--chat-canvas-image').trim(),
    )
    checkProduct(
      '选「渐变」后聊天区背景变量为渐变',
      /linear-gradient/.test(canvasImageVar),
      `--chat-canvas-image=${canvasImageVar.slice(0, 60)}…`,
    )
    await shot(desk, 'req3-custom')

    // 刷新后自定义主题仍在（落盘）
    await desk.reload({ waitUntil: 'domcontentloaded' })
    await ensureShell(desk, 'gate_a')
    await sleep(600)
    const afterReload = await desk.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      primary: document.documentElement.style.getPropertyValue('--color-brand-500').trim(),
      stored: localStorage.getItem('aitrance.theme'),
      custom: localStorage.getItem('aitrance.theme.custom'),
    }))
    checkProduct(
      '自定义主题刷新后仍生效',
      afterReload.theme === 'custom' &&
        afterReload.primary.toLowerCase() === CUSTOM_PRIMARY &&
        afterReload.stored === 'custom' &&
        !!afterReload.custom,
      `theme=${afterReload.theme} primary=${afterReload.primary} stored=${afterReload.stored}`,
    )

    // 恢复浅色，避免污染后续断言
    await desk.evaluate(() => {
      localStorage.setItem('aitrance.theme', 'light')
      localStorage.removeItem('aitrance.theme.custom')
    })
    await desk.reload({ waitUntil: 'domcontentloaded' })
    await ensureShell(desk, 'gate_a')

    /* ══════════════════════════════════════════════════════════════
     * 需求 4：多附件消息
     * ══════════════════════════════════════════════════════════════ */
    group('需求 4：多图多文件 / 必带文字 / Enter 规则')
    await openConv(desk, '闸门 B')
    checkProduct('进入会话成功', await desk.locator('.pane__scroll').isVisible(), '')

    // 4-a 只有附件没有文字 → 发送按钮 disabled 且提示要求带文字
    const beforeRows = await rowCount(desk)
    await pickFiles(desk, '.cbar__btn--image', [paths.a, paths.b])
    const twoReady = await until(
      async () => (await desk.locator('.composer__att--done').count()) === 2,
      60_000,
      250,
    )
    checkProduct('多选两张图片都能进入待发送队列', twoReady, `done=${await desk.locator('.composer__att--done').count()}`)
    const sendBtnNoText = desk.locator('.composer__send')
    checkProduct(
      '只有附件、没有文字时发送按钮不可用',
      await sendBtnNoText.isDisabled(),
      `disabled=${await sendBtnNoText.isDisabled()} title=${await sendBtnNoText.getAttribute('title')}`,
    )
    const noTextHint = (await sendBtnNoText.getAttribute('title')) ?? ''
    checkProduct(
      '提示要求附带文字',
      /附带文字/.test(noTextHint),
      `title=${noTextHint}`,
    )

    // 4-b 有附件时按 Enter 不发送（只换行）
    const draftA = `多图${RUN}`
    await desk.locator('.composer__input').fill(draftA)
    await desk.locator('.composer__input').press('Enter')
    await sleep(800)
    const afterEnterRows = await rowCount(desk)
    const afterEnterValue = await inputValue(desk, '.composer__input')
    checkProduct(
      '有附件时 Enter 不发送（只换行）',
      afterEnterRows === beforeRows && afterEnterValue.includes('\n'),
      `rows ${beforeRows}→${afterEnterRows} textarea 含换行=${afterEnterValue.includes('\n')}`,
    )

    // 4-c Ctrl+Enter 发送，且文字与两张图都在同一条消息里
    await desk.locator('.composer__input').fill(`${draftA} · 图文同条`)
    await desk.locator('.composer__input').press('Control+Enter')
    const sent = await until(async () => (await rowCount(desk)) > beforeRows, 30_000, 250)
    checkProduct('Ctrl+Enter 可发送带附件的消息', sent, `rows=${await rowCount(desk)}`)
    const bubbleInfo = await desk.evaluate((tag) => {
      const bubbles = [...document.querySelectorAll('.bubble')]
      const hit = bubbles.filter((b) => (b.textContent || '').includes(tag))
      const last = hit.at(-1)
      if (!last) return null
      return {
        atts: last.querySelectorAll('.att').length,
        imgs: last.querySelectorAll('.att--image').length,
        text: (last.querySelector('.bubble__text')?.textContent || '').trim(),
      }
    }, `${draftA} · 图文同条`)
    checkProduct(
      '一条消息里同时有文字与 2 张图',
      !!bubbleInfo && bubbleInfo.atts === 2 && bubbleInfo.imgs === 2,
      `atts=${bubbleInfo?.atts} imgs=${bubbleInfo?.imgs} text=${JSON.stringify(bubbleInfo?.text ?? '')}`,
    )
    checkProduct(
      '带文字发图片时文字不被吞（需求 4 的核心 bug）',
      !!bubbleInfo && bubbleInfo.text.includes(draftA),
      `气泡正文=${JSON.stringify(bubbleInfo?.text ?? '')}`,
    )
    await shot(desk, 'req4-multi-image')

    // 4-d 图片上限 9：一次塞 10 张，队列不得超过 9
    await pickFiles(
      desk,
      '.cbar__btn--image',
      Array.from({ length: 10 }, (_, i) => paths[(i % 2 === 0 ? 'a' : 'b')]),
    )
    await sleep(1_200)
    const queueCount = await desk.locator('.composer__att').count()
    checkProduct(
      '图片附件数量被限制在 9 以内',
      queueCount <= 9 && queueCount > 0,
      `队列=${queueCount}（塞了 10 个文件）`,
    )

    // 清空队列，避免影响视频用例
    await desk.evaluate(() => {
      const btns = [...document.querySelectorAll('.composer__att-del, .composer__att-x, .composer__att button')]
      btns.forEach((b) => b.click())
    })
    await sleep(600)
    const queueAfterClear = await desk.locator('.composer__att').count()
    if (queueAfterClear > 0) {
      // 用「刷新页面」兜底清空（草稿不恢复附件）
      await desk.reload({ waitUntil: 'domcontentloaded' })
      await ensureShell(desk, 'gate_a')
      await openConv(desk, '闸门 B')
    }

    // 4-e 视频上限 1：塞 2 个 mp4，队列里视频只能 1 个
    await pickFiles(desk, '.cbar__btn--video', [paths.mp4a, paths.mp4b])
    await sleep(1_500)
    const videoCount = await desk.locator('.composer__att').count()
    checkProduct(
      '视频附件最多 1 个',
      videoCount === 1,
      `队列=${videoCount}（塞了 2 个 mp4）`,
    )
    await shot(desk, 'req4-video')

    /* ══════════════════════════════════════════════════════════════
     * 需求 2：点对方头像进访客资料页
     * ══════════════════════════════════════════════════════════════ */
    group('需求 2：点对方头像 → 访客资料页')
    // 前置：gate_b 必须**真的**发过一条消息，gate_a 才可能看到「对方气泡」。
    // 之前这里隐含依赖「同一隔离库里上一轮 e2e 遗留的 gate_b 消息」——换新库后
    // 一条对方消息都没有，`.line__avatar-btn` 自然是 0，会被误判成产品缺陷。
    const peerLine = `需求2 对方气泡 ${RUN}`
    const peerSeq = await sendTextAs('gate_b', convAB, peerLine)
    checkProduct('前置：gate_b 已发出消息', peerSeq !== null, `seq=${peerSeq}`)
    await desk.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(desk, 'gate_a')
    await openConv(desk, '闸门 B')
    const peerBubbleShown = await until(
      async () =>
        (await desk.locator('.bubble').filter({ hasText: peerLine }).count()) > 0,
      20_000,
      250,
    )
    checkProduct('前置：对方气泡已渲染', peerBubbleShown, `文本=${peerLine}`)
    const peerAvatarBtn = desk.locator('.line__avatar-btn').first()
    const hasPeerAvatar = (await peerAvatarBtn.count()) > 0
    checkProduct('对方气泡旁头像可点（存在按钮包裹）', hasPeerAvatar, `count=${await peerAvatarBtn.count()}`)
    if (hasPeerAvatar) {
      await peerAvatarBtn.click()
      const onVisit = await until(
        async () => /\/chat\/user\//.test(desk.url()),
        8_000,
        200,
      )
      checkProduct(
        '点对方头像跳到 /chat/user/:userId',
        onVisit,
        `url=${new URL(desk.url()).pathname}`,
      )
      const up = desk.locator('.up')
      const upShown = await up
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      const upName = upShown ? await desk.locator('.up__name').innerText().catch(() => '') : ''
      checkProduct(
        '访客资料页渲染对方昵称',
        upShown && upName.includes('闸门 B'),
        `可见=${upShown} name=${JSON.stringify(upName)}`,
      )
      const upUid = upShown ? await desk.locator('.up__uid').innerText().catch(() => '') : ''
      checkProduct(
        '访客资料页显示对方 UID',
        upUid.includes(String(uidB)),
        `uid 文本=${JSON.stringify(upUid)} 期望含 ${uidB}`,
      )
      const upActions = upShown ? await desk.locator('.up__actions .btn__label').allInnerTexts() : []
      checkProduct(
        '好友关系下动作是「发消息」',
        upActions.includes('发消息'),
        `actions=${JSON.stringify(upActions)}`,
      )
      await shot(desk, 'req2-visitor-profile')
      await desk.goBack().catch(() => {})
      await sleep(400)
    } else {
      skip('点对方头像跳转 /chat/user/:userId', '当前会话没有对方气泡')
    }

    /* ══════════════════════════════════════════════════════════════
     * 需求 6：广场
     * ══════════════════════════════════════════════════════════════ */
    group('需求 6：广场')
    await desk.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
    await ensureShell(desk, 'gate_a')
    const squareTab = desk.locator('.rail__tab[title="广场"]')
    checkProduct('桌面侧栏有广场入口', (await squareTab.count()) === 1, `count=${await squareTab.count()}`)
    await squareTab.click()
    await desk.waitForSelector('.square', { timeout: 10_000 })
    checkProduct(
      '进入广场页',
      (await desk.locator('.square__title').innerText().catch(() => '')).includes('广场'),
      `url=${new URL(desk.url()).pathname}`,
    )

    // 6-a 发一条纯文字动态
    const postText = `v2 广场 ${RUN}：第一条动态`
    await desk.locator('.square__publish').click()
    await desk.waitForSelector('.layer[aria-label="发布动态"]', { timeout: 8_000 })
    await desk.locator('textarea.editor').fill(postText)
    await desk.locator('.head-btn--primary').click()
    const postShown = await until(
      () =>
        desk
          .evaluate((t) => [...document.querySelectorAll('.post__text')].some((e) => (e.textContent || '').includes(t)), postText),
      20_000,
      250,
    )
    checkProduct('发帖成功后信息流出现该动态', postShown, `文案=${postText}`)
    const postId = await desk.evaluate((t) => {
      const card = [...document.querySelectorAll('.feed__item')].find((e) =>
        (e.textContent || '').includes(t),
      )
      return card?.id?.replace('post-', '') ?? null
    }, postText)
    if (postId) createdPostIds.push(postId)

    // 6-b 5000 字上限：超限时发布按钮不可用且计数变红
    await desk.locator('.square__publish').click()
    await desk.waitForSelector('.layer[aria-label="发布动态"]', { timeout: 8_000 })
    await desk.locator('textarea.editor').fill('字'.repeat(5001))
    await sleep(500)
    const overState = await desk.evaluate(() => ({
      count: document.querySelector('.meta__count')?.textContent?.trim() ?? '',
      danger: !!document.querySelector('.meta__count--danger'),
      disabled: !!document.querySelector('.head-btn--primary')?.disabled,
    }))
    checkProduct(
      '正文超过 5000 字时不允许发布',
      overState.danger && overState.disabled && overState.count.includes('5001'),
      `count=${JSON.stringify(overState.count)} danger=${overState.danger} disabled=${overState.disabled}`,
    )
    await shot(desk, 'req6-overlimit')
    // 取消（会弹「放弃编辑？」确认）
    await desk.locator('.sheet__head .head-btn', { hasText: '取消' }).click()
    const discard = desk.locator('.mask .panel .panel__foot .btn', { hasText: '放弃' })
    if (await discard.count()) await discard.first().click()
    await sleep(600)

    // 6-c 发一条图文动态（1 张图）
    const imgPostText = `v2 广场图文 ${RUN}`
    await desk.locator('.square__publish').click()
    await desk.waitForSelector('.layer[aria-label="发布动态"]', { timeout: 8_000 })
    await desk.locator('textarea.editor').fill(imgPostText)
    await pickFiles(desk, '.layer .tool', [paths.a])
    const thumbReady = await until(
      async () => (await desk.locator('.layer .thumb').count()) >= 1 &&
        (await desk.locator('.layer .thumb__progress').count()) === 0,
      60_000,
      250,
    )
    checkProduct('广场发帖可上传图片', thumbReady, `thumbs=${await desk.locator('.layer .thumb').count()}`)
    await desk.locator('.head-btn--primary').click()
    const imgPostShown = await until(
      () =>
        desk.evaluate((t) => [...document.querySelectorAll('.post__text')].some((e) => (e.textContent || '').includes(t)), imgPostText),
      20_000,
      250,
    )
    checkProduct('图文动态发布成功', imgPostShown, `文案=${imgPostText}`)
    const imgPostId = await desk.evaluate((t) => {
      const card = [...document.querySelectorAll('.feed__item')].find((e) => (e.textContent || '').includes(t))
      return card?.id?.replace('post-', '') ?? null
    }, imgPostText)
    if (imgPostId) createdPostIds.push(imgPostId)
    const imgRendered = await desk.evaluate((t) => {
      const card = [...document.querySelectorAll('.feed__item')].find((e) => (e.textContent || '').includes(t))
      return !!card && card.querySelectorAll('img').length > 0
    }, imgPostText)
    checkProduct('图文动态里图片真渲染（img 存在）', imgRendered, `img 存在=${imgRendered}`)

    // 6-d 点赞
    const likeBtn = desk.locator('.feed__item', { hasText: postText }).locator('.action[aria-label="点赞"]')
    const beforeLiked = await likeBtn.getAttribute('aria-pressed')
    await likeBtn.click()
    const liked = await until(async () => (await likeBtn.getAttribute('aria-pressed')) === 'true', 10_000, 200)
    checkProduct('点赞后 aria-pressed=true', liked, `${beforeLiked} → ${await likeBtn.getAttribute('aria-pressed')}`)
    await likeBtn.click()
    const unliked = await until(async () => (await likeBtn.getAttribute('aria-pressed')) === 'false', 10_000, 200)
    checkProduct('再点取消点赞回到 aria-pressed=false', unliked, `pressed=${await likeBtn.getAttribute('aria-pressed')}`)

    // 6-e 评论
    const commentText = `v2 评论 ${RUN}`
    await desk.locator('.feed__item', { hasText: postText }).locator('.action[aria-label="评论"]').click()
    await desk.waitForSelector('.mask .panel .comments', { timeout: 8_000 })
    await desk.locator('.mask .panel .comments .composer__input').fill(commentText)
    await desk.locator('.mask .panel .comments .composer__send').click()
    const commentShown = await until(
      () =>
        desk.evaluate((t) => [...document.querySelectorAll('.comment__text')].some((e) => (e.textContent || '').includes(t)), commentText),
      20_000,
      250,
    )
    checkProduct('发表评论后出现在评论区', commentShown, `评论=${commentText}`)
    await shot(desk, 'req6-comments')
    await desk.locator('.mask .panel .panel__close').click().catch(() => {})
    await sleep(500)

    // 6-f 删除自己刚发的图文动态
    if (imgPostId) {
      const card = desk.locator(`#post-${imgPostId}`)
      await card.locator('.post__icon-btn[aria-label="更多操作"]').click()
      await card.locator('.post__menu-item--danger').click()
      const delConfirm = desk.locator('.mask .panel .panel__foot .btn', { hasText: '删除' })
      const confirmShown = await delConfirm
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      checkProduct('删除动态需二次确认', confirmShown, `可见=${confirmShown}`)
      if (confirmShown) await delConfirm.first().click()
      const gone = await until(async () => (await desk.locator(`#post-${imgPostId}`).count()) === 0, 15_000, 250)
      checkProduct('删除后动态从信息流消失', gone, `#post-${imgPostId} count=${await desk.locator(`#post-${imgPostId}`).count()}`)
      if (gone) {
        const i = createdPostIds.indexOf(imgPostId)
        if (i >= 0) createdPostIds.splice(i, 1)
      }
    } else {
      skip('删除动态需二次确认', '上一轮没拿到动态 id')
    }

    // 6-g 广场禁止通用文件附件（后端契约）→ 400 ATTACHMENT_LIMIT
    const upFile = await uploadBytesAs('gate_a', `v2-doc-${RUN}.txt`, Buffer.from(`v2 文件 ${RUN}\n`), 'text/plain')
    if (upFile.status === 201 && upFile.body?.id) {
      const t = await tokenOf('gate_a')
      const r = await fetch(`${BACKEND}/api/v1/posts`, {
        method: 'POST',
        headers: H(t.token),
        body: JSON.stringify({ content: `带文件 ${RUN}`, attachmentIds: [upFile.body.id] }),
      })
      const err = await r.json().catch(() => null)
      checkProduct(
        '广场拒绝通用文件附件（400 ATTACHMENT_LIMIT）',
        r.status === 400 && err?.error?.code === 'ATTACHMENT_LIMIT',
        `status=${r.status} code=${err?.error?.code}`,
      )
    } else {
      skip('广场拒绝通用文件附件', `txt 上传失败 status=${upFile.status}`)
    }

    // 6-h 未登录不可达广场
    const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const anonPage = await anonCtx.newPage()
    watchPage(anonPage)
    await anonPage.goto(`${BASE}/chat/square`, { waitUntil: 'domcontentloaded' })
    await sleep(1_200)
    const anonPath = new URL(anonPage.url()).pathname
    checkProduct(
      '未登录访问 /chat/square 被重定向到登录页',
      anonPath.startsWith('/login'),
      `url=${anonPath}`,
    )
    await anonCtx.close()

    await deskCtx.close()

    /* ══════════════════════════════════════════════════════════════
     * 需求 1 移动端：底部导航第三位＝个人信息 → 上拉抽屉
     * ══════════════════════════════════════════════════════════════ */
    group('需求 1：移动端个人信息上拉抽屉')
    const { ctx: mobCtx, page: mob } = await contextAs(browser, 'gate_a', { width: 390, height: 844 })
    check('移动端外壳就绪', await ensureShell(mob, 'gate_a'), `url=${mob.url()}`)
    const navLabels = await mob.locator('.mnav__label').allInnerTexts()
    checkProduct(
      '底部导航第三位是「个人信息」而不是「更多」',
      navLabels.length === 3 && navLabels[2] === '个人信息' && !navLabels.includes('更多'),
      `labels=${JSON.stringify(navLabels)}`,
    )
    const navTabs = mob.locator('.mnav__tab')
    await navTabs.nth(2).click()
    const sheet = mob.locator('.psheet')
    const sheetShown = await sheet
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    checkProduct('点第三位打开底部上拉抽屉', sheetShown, `可见=${sheetShown}`)
    const briefTitle = sheetShown ? await mob.locator('.psheet__title').innerText().catch(() => '') : ''
    checkProduct('初始为简要态（标题「个人信息」）', briefTitle.includes('个人信息'), `title=${JSON.stringify(briefTitle)}`)
    const sheetEntries = await mob.locator('.psheet__entry-label').allInnerTexts()
    checkProduct(
      '简要态含详细资料/主题/退出登录',
      ['详细资料', '主题', '退出登录'].every((t) => sheetEntries.includes(t)),
      `entries=${JSON.stringify(sheetEntries)}`,
    )
    await shot(mob, 'req1-mobile-brief')
    // 展开成全屏详细资料
    await mob.locator('.psheet__expand').first().click()
    const fullShown = await until(async () => (await mob.locator('.psheet--full').count()) === 1, 8_000, 200)
    checkProduct('上拉/点「展开」切到全屏详细资料', fullShown, `psheet--full=${await mob.locator('.psheet--full').count()}`)
    const fullHasProfile = (await mob.locator('.psheet__full .profile').count()) === 1
    checkProduct('全屏态渲染详细资料（ProfileView）', fullHasProfile, `profile=${await mob.locator('.psheet__full .profile').count()}`)
    const fullTitle = await mob.locator('.psheet__title').innerText().catch(() => '')
    checkProduct('全屏态标题变「详细资料」', fullTitle.includes('详细资料'), `title=${JSON.stringify(fullTitle)}`)
    await shot(mob, 'req1-mobile-full')

    // 移动端退出登录二次确认也必须存在（z-index 不能被面板盖住）
    await mob.locator('.psheet__close').click()
    await sleep(400)
    await ensureShell(mob, 'gate_a')
    await mob.locator('.mnav__tab').nth(2).click()
    await mob.waitForSelector('.psheet', { timeout: 8_000 })
    await mob.locator('.psheet__entry--danger').click()
    const mobDialog = mob.locator('.mask .panel')
    const mobDialogShown = await mobDialog
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    // 关键：二次确认必须能被点到（曾经被 z-index 更高的面板遮住）
    const mobCancel = mob.locator('.mask .panel .panel__foot .btn', { hasText: '取消' })
    let cancelClickable = false
    if (mobDialogShown && (await mobCancel.count())) {
      cancelClickable = await mobCancel
        .first()
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    }
    checkProduct(
      '移动端退出登录二次确认可见且可点击（不被抽屉遮住）',
      mobDialogShown && cancelClickable,
      `可见=${mobDialogShown} 可点=${cancelClickable}`,
    )
    await shot(mob, 'req1-mobile-logout')
    await mobCtx.close()
  } finally {
    // 清理本次创建的动态（尽力而为，已删的会 404，无副作用）
    try {
      const t = await tokenOf('gate_a')
      for (const id of createdPostIds) await jdel(`/api/v1/posts/${id}`, t.token)
    } catch {
      /* 忽略 */
    }
    await browser.close().catch(() => {})
    rmSync(tmpDir, { recursive: true, force: true })
  }

  /* ── 汇总 ── */
  const pass = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped).length
  const failed = results.filter((r) => !r.ok)
  const defectCount = defects.length

  console.log(`\n════════ 汇总 ════════`)
  console.log(`总计 ${results.length} 项：PASS ${pass} / FAIL ${failed.length} / DEFECT ${defectCount} / SKIP ${skipped}`)
  if (failed.length) {
    console.log(`\n未通过清单：`)
    for (const f of failed) console.log(`  ${f.defect ? 'DEFECT' : 'FAIL'}  ${f.name}  —— ${f.detail}`)
  }
  if (pageErrors.length) {
    console.log(`\n页面未捕获异常 ${pageErrors.length} 条（前 5）：`)
    for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.msg}  @ ${e.url}`)
  }
  console.log(`\n截图目录：${SHOT_DIR}`)

  clearTimeout(hardTimer)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\n!! 脚本异常终止：', err)
  clearTimeout(hardTimer)
  process.exit(2)
})
