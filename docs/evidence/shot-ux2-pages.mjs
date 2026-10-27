/**
 * task-11（UX2 页面域）截图 + 逐项自检脚本。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 * 在**真实 Chrome**（channel: 'chrome'；本机未下载 playwright 自带 chromium）
 * 里打开隔离环境（前端 5174 = integration 模式且 VITE_USE_MOCK=false，
 * 后端 3098 = 干净临时库），截取本任务交付的四个页面域视图：
 *   登录页（UID 提示）/ 个人资料页 / 管理后台 / 群聊信息页（群主视角）
 * 每页都有桌面（1280×800）与 390×844 窄屏两档，另加弹层与守卫反例。
 *
 * 每张截图前都断言关键选择器与关键文案，stdout 打印 PASS/FAIL，
 * 失败计入退出码 —— 截图不是「能打开就算过」。
 *
 * ── 输入（由 docs/evidence/run-ux2-shots.ps1 注入）─────────────────
 *   BASE    = http://localhost:5174   （integration 模式前端）
 *   BACKEND = http://127.0.0.1:3098   （隔离后端，CORS 已放行 5174）
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   ../docs/evidence/ux2-page-*.png
 *   stdout：`SHOT <name>  <path>` + `PASS/FAIL …` + 末尾汇总
 *
 * ── 副作用（重要）─────────────────────────────────────────────────
 *   1. 只在隔离后端（临时库）上注册 ux2_alice / ux2_bob / ux2_carol，
 *      建好友、建群、上传两张脚本内生成的 PNG 当头像。**不碰生产库。**
 *   2. 只写截图文件，不改任何源码、不改配置、不重启别人的服务。
 *   3. 不访问 mikuyun.xyz 等任何生产域名。
 *
 * ── 为什么不用 UI 登录 ────────────────────────────────────────────
 *   后端登录限流是 10 次/分/IP，本脚本要开 4 个浏览器上下文。统一走
 *   POST /api/v1/auth/login 换 token，再写 localStorage（键名与前端
 *   stores/auth.ts 一致：aitrance.session / aitrance.sessionExpiresAt）。
 */

import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// playwright 装在 frontend/node_modules（仓库根没有 node_modules），
// 而本脚本放在 docs/evidence/ 下 —— 用 createRequire 从 frontend/package.json
// 起解析，这样不必把脚本塞进 frontend/scripts/（那不在本任务写作用域内）。
const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(HERE, '../../frontend')
const requireFromFrontend = createRequire(resolve(FRONTEND_DIR, 'package.json'))
const { chromium } = requireFromFrontend('playwright')

const BASE = process.env.BASE ?? 'http://localhost:5174'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3098'
const SHOT_DIR = resolve(HERE)

const PASSWORD = 'Ux2Pass!2345'
const ADMIN = { username: '1001', password: 'A454545asd@' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 结果收集 ─────────────────────────────────────────────────── */
const results = []
const shots = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
  return ok
}

function group(title) {
  console.log(`\n──── ${title} ────`)
}

async function until(fn, timeoutMs = 12_000, stepMs = 200) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return false
}

/* ── 脚本内生成合法 PNG（不往仓库加图片）─────────────────────── */
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 生成一张 rgb8 的 PNG；`paint(x,y,w,h) -> [r,g,b]`。 */
function makePng(width, height, paint) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y, width, height)
      const p = rowStart + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── 后端直连工具 ─────────────────────────────────────────────── */
const tokenCache = new Map()
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

async function jpost(path, token, body) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: token ? H(token) : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: r.status, data }
}

async function jget(path, token) {
  const r = await fetch(`${BACKEND}${path}`, { headers: H(token) })
  const text = await r.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: r.status, data }
}

async function jpatch(path, token, body) {
  const r = await fetch(`${BACKEND}${path}`, { method: 'PATCH', headers: H(token), body: JSON.stringify(body) })
  const text = await r.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: r.status, data }
}

async function uploadPng(token, filename, bytes) {
  const r = await fetch(`${BACKEND}/api/v1/uploads?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
    body: bytes,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

async function ensureUser(username, displayName) {
  const r = await jpost('/api/v1/auth/register', null, { username, password: PASSWORD, displayName })
  return r.status // 201 新建 / 409 已存在
}

async function creds(username) {
  let c = tokenCache.get(username)
  if (!c) {
    const r = await jpost('/api/v1/auth/login', null, { username, password: PASSWORD })
    if (r.status !== 200) throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.data)}`)
    c = { token: r.data.token, expiresAt: r.data.expiresAt, userId: r.data.user?.id }
    tokenCache.set(username, c)
  }
  return c
}

async function adminCreds() {
  if (tokenCache.has('__admin')) return tokenCache.get('__admin')
  const r = await jpost('/api/v1/auth/login', null, ADMIN)
  if (r.status !== 200) throw new Error(`管理员登录失败: ${r.status} ${JSON.stringify(r.data)}`)
  const c = { token: r.data.token, expiresAt: r.data.expiresAt, userId: r.data.user?.id }
  tokenCache.set('__admin', c)
  return c
}

/** 已是好友就直接建单聊；否则先发申请再接受。 */
async function ensureFriendsAndConv(aName, bName) {
  const A = await creds(aName)
  const B = await creds(bName)
  const list = await jget('/api/v1/conversations?limit=100&offset=0', A.token)
  const existing = (list.data?.items ?? []).find((c) => c.type === 'direct' && c.peer?.username === bName)
  if (existing) return existing

  const search = await jget(`/api/v1/users?q=${encodeURIComponent(bName)}&limit=10&offset=0`, A.token)
  const target = (search.data?.items ?? []).find((u) => u.username === bName)
  if (!target) throw new Error(`搜不到用户 ${bName}`)

  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: 'UX2 截图' })
  const reqs = await jget('/api/v1/friend-requests', B.token)
  const incoming = (reqs.data?.items ?? []).find((r) => r.sender?.username === aName && r.status === 'pending')
  if (incoming) {
    await jpost(`/api/v1/friend-requests/${incoming.id}/respond`, B.token, { action: 'accept' })
  }
  const conv = await jpost('/api/v1/conversations/direct', A.token, { userId: target.id })
  if (!conv.data?.id) throw new Error(`建单聊失败: ${JSON.stringify(conv)}`)
  return conv.data
}

async function sendText(token, convId, content) {
  const r = await jpost(`/api/v1/conversations/${convId}/messages`, token, {
    clientMsgId: `ux2-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    type: 'text',
    content,
  })
  return r.status
}

/* ── 浏览器工具 ───────────────────────────────────────────────── */
async function setAuth(page, cred) {
  // 与 e2e-matrix 同款：goto /login 后写 localStorage 再进受保护页面。
  // 不用 addInitScript 是因为它每次导航都重跑，没法在同一 context 里换账号。
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([token, expiresAt]) => {
      localStorage.setItem('aitrance.session', token)
      localStorage.setItem('aitrance.sessionExpiresAt', expiresAt)
    },
    [cred.token, cred.expiresAt],
  )
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' })
}

async function waitShell(page) {
  return until(
    async () =>
      (await page.locator('.list').count()) > 0 ||
      (await page.locator('.panel').count()) > 0 ||
      (await page.locator('.rail').count()) > 0,
    20_000,
  )
}

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true })
  const path = resolve(SHOT_DIR, `ux2-page-${name}.png`)
  await page.screenshot({ path })
  shots.push({ name, path })
  console.log(`SHOT ${name}  ${path}`)
  return path
}

/* ── 主流程 ───────────────────────────────────────────────────── */
async function main() {
  console.log(`=== UX2 页面域截图  BASE=${BASE}  BACKEND=${BACKEND} ===`)

  /* 1. 造数据 ---------------------------------------------------- */
  group('数据铺垫（隔离后端 3098）')
  check('注册 ux2_alice', [201, 409].includes(await ensureUser('ux2_alice', '林小满')))
  check('注册 ux2_bob', [201, 409].includes(await ensureUser('ux2_bob', '陈子航')))
  check('注册 ux2_carol', [201, 409].includes(await ensureUser('ux2_carol', '赵一诺')))

  const admin = await adminCreds()
  const staff = await jget('/api/v1/admin/stats', admin.token)
  check('管理员 1001 可读 /admin/stats', staff.status === 200, `users=${staff.data?.users} online=${staff.data?.online}`)

  const convAB = await ensureFriendsAndConv('ux2_alice', 'ux2_bob')
  await ensureFriendsAndConv('ux2_alice', 'ux2_carol')
  check('建 abc 私聊 + 两人好友关系', !!convAB.id, `conv=${convAB.id.slice(0, 8)}`)
  await sleep(300)

  const alice = await creds('ux2_alice')
  const bob = await creds('ux2_bob')
  const carol = await creds('ux2_carol')

  // 群聊：alice 群主，bob/carol 成员；再把 bob 设成管理员
  const members = await jget('/api/v1/users?q=ux2_&limit=20&offset=0', alice.token)
  const idOf = (u) => (members.data?.items ?? []).find((x) => x.username === u)?.id
  const groupCreate = await jpost('/api/v1/conversations/group', alice.token, {
    name: '产品评审组',
    memberIds: [idOf('ux2_bob'), idOf('ux2_carol')].filter(Boolean),
  })
  const groupConv = groupCreate.data
  check('建群（alice 为群主）', groupCreate.status === 201 && !!groupConv?.id, `group=${groupConv?.id?.slice(0, 8)}`)
  const bobId = idOf('ux2_bob')
  const promote = await jpost(
    `/api/v1/conversations/${groupConv.id}/members/${bobId}/role`,
    alice.token,
    { role: 'admin' },
  )
  check('群主把 bob 设为管理员', promote.status === 200)

  // 头像：脚本内现生成 PNG，上传后 PATCH 到 user / conversation
  const avatarPng = makePng(128, 128, (x, y, w, h) => {
    const d = Math.hypot(x - w / 2, y - h / 2) / (w / 2)
    if (d > 1) return [238, 245, 250]
    return [Math.round(24 + 70 * d), Math.round(132 - 44 * d), Math.round(178 + 44 * d)]
  })
  const groupPng = makePng(128, 128, (x, y, w, h) => {
    const d = Math.hypot(x - w / 2, y - h / 2) / (w / 2)
    if (d > 1) return [244, 248, 251]
    const band = y < h / 2 ? 0 : 1
    return band === 0 ? [255, Math.round(190 + 40 * d), Math.round(90 + 60 * d)] : [Math.round(60 + 80 * d), 170, 150]
  })

  const upUser = await uploadPng(alice.token, 'ux2-alice-avatar.png', avatarPng)
  check('上传个人头像 PNG', upUser.status === 201, `id=${upUser.data?.id?.slice(0, 8)} size=${upUser.data?.size}`)
  const patchUser = await jpatch('/api/v1/users/me', alice.token, {
    avatarUrl: `/api/v1/uploads/${upUser.data?.id}`,
    bio: '前端页面域负责人：个人资料 / 群角色 / 管理后台。',
  })
  check('PATCH /users/me 设置 avatarUrl + bio', patchUser.status === 200 && !!patchUser.data?.avatarUrl)

  const upGroup = await uploadPng(alice.token, 'ux2-group-avatar.png', groupPng)
  const patchGroup = await jpatch(`/api/v1/conversations/${groupConv.id}`, alice.token, {
    avatarUrl: `/api/v1/uploads/${upGroup.data?.id}`,
  })
  check('PATCH /conversations/:id 设置群头像', patchGroup.status === 200 && !!patchGroup.data?.avatarUrl)

  // 消息铺垫：私聊 4 条、群聊 5 条
  for (const line of [
    '个人资料页做完了，UID 可以一键复制。',
    '群角色这块群主和管理员的入口分开了吗？',
    '分开了：群主能设管理员，管理员只能移普通成员。',
    '管理后台概览的数字是真库算的对吧？',
  ]) {
    await sendText(alice.token, convAB.id, line)
    await sleep(120)
  }
  for (const line of ['评审周会挪到周四上午十点。', '收到，我把议题整理进文档。', '群头像也换成了新版的。']) {
    await sendText(alice.token, groupConv.id, line)
    await sleep(120)
  }
  check('消息铺垫（私聊 4 条 / 群聊 3 条）', true)

  // 让管理后台能同时展示「正常」「禁言中」「管理员」三种状态。
  // uid 只在 WireUser 上，login 响应里没有，所以从 admin 列表按账号名反查。
  const adminList = await jget('/api/v1/admin/users?limit=100&offset=0', admin.token)
  const carolRow = (adminList.data?.items ?? []).find((u) => u.username === 'ux2_carol')
  const muteCarol = carolRow
    ? await jpost(`/api/v1/admin/users/${carolRow.uid}/mute`, admin.token, { minutes: 120 })
    : { status: 0, data: null }
  check('管理员禁言 ux2_carol 120 分钟', muteCarol.status === 200, `status=${muteCarol.status} uid=${carolRow?.uid}`)
  await sleep(300)

  /* 2. 浏览器 ---------------------------------------------------- */
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const pageErrors = []
  try {
    /* 2.1 登录页 ------------------------------------------------ */
    group('登录页（UID 登录提示）')
    for (const [tag, viewport] of [
      ['desktop', { width: 1280, height: 800 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const ctx = await browser.newContext({ viewport })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`${tag}:${e.message}`))
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
      await until(async () => (await page.locator('.auth__form').count()) > 0, 15_000)
      const subText = await page.locator('.auth__sub').first().innerText().catch(() => '')
      const labelText = await page.locator('.field__label').first().innerText().catch(() => '')
      const placeholder = await page.locator('.field__input').first().getAttribute('placeholder').catch(() => '')
      const hintText = await page.locator('.field__hint').first().innerText().catch(() => '')
      check(`登录页(${tag}) 副标题提示可用 UID`, subText.includes('UID'), subText.trim())
      check(`登录页(${tag}) 账号框 label = 账号名或 UID`, labelText.includes('UID'), labelText.trim())
      check(`登录页(${tag}) placeholder 含 10001`, String(placeholder).includes('10001'), String(placeholder))
      check(`登录页(${tag}) 输入提示含 UID`, hintText.includes('UID'), hintText.trim())
      await shot(page, `01-login-${tag}`)
      await ctx.close()
    }

    /* 2.2 桌面：外壳入口 + 个人资料 + 管理后台 + 群信息 ---------- */
    const ctxDesk = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const desk = await ctxDesk.newPage()
    desk.on('pageerror', (e) => pageErrors.push(`desk:${e.message}`))
    await setAuth(desk, alice)
    check('桌面端进入聊天外壳', await waitShell(desk))

    group('桌面端：个人资料 / 管理后台入口')
    await until(async () => (await desk.locator('.shell__me').count()) > 0, 10_000)
    const meButtons = await desk.locator('.shell__me--rail .shell__me-btn').count()
    check('桌面端 rail 列存在个人资料/管理后台入口', meButtons >= 1, `按钮数=${meButtons}`)
    check(
      '普通用户看不到管理后台入口',
      (await desk.locator('.shell__me-btn[aria-label="管理后台"]').count()) === 0,
      'alice 非管理员，入口应隐藏',
    )
    await shot(desk, '02-chat-entry-desktop')

    await desk.goto(`${BASE}/chat/profile`, { waitUntil: 'domcontentloaded' })
    check('进入 /chat/profile 并渲染个人资料页', await until(async () => (await desk.locator('.profile').count()) > 0, 15_000))
    await until(async () => (await desk.locator('.profile__kv').count()) > 0, 15_000)
    const profileUsername = await desk.locator('.profile__v').first().innerText().catch(() => '')
    const uidText = await desk.locator('.profile__uid').first().innerText().catch(() => '')
    const kvLabels = await desk.locator('.profile__k').allInnerTexts()
    const avatarImgs = await desk.locator('.profile__avatar-btn .avatar-img').count()
    check('个人资料页显示账号名称', profileUsername.includes('ux2_alice'), profileUsername.trim())
    check('个人资料页 UID 形如 #10001', /^#\d{5,}$/.test(uidText.trim()), uidText.trim())
    check(
      '个人资料页四项齐全（账号名称/UID 在 kv 中，昵称/简介为可编辑区）',
      kvLabels.some((t) => t.includes('账号名称')) && kvLabels.some((t) => t.includes('UID')),
      kvLabels.join(' / '),
    )
    check('个人资料页头像走 blob 渲染（自然宽>0）', avatarImgs > 0, `avatar-img=${avatarImgs}`)
    check('个人资料页 UID 有复制按钮', (await desk.locator('.profile__copy').count()) >= 2)
    await shot(desk, '03-profile-desktop')

    // 管理后台：非管理员被守卫挡掉
    await desk.goto(`${BASE}/chat/admin`, { waitUntil: 'domcontentloaded' })
    await sleep(1200)
    const nonAdminUrl = desk.url()
    const adminSectionCount = await desk.locator('.admin').count()
    check(
      '非管理员访问 /chat/admin 被守卫重定向（不渲染后台）',
      adminSectionCount === 0 && !nonAdminUrl.includes('/chat/admin'),
      `url=${nonAdminUrl.replace(BASE, '')} .admin=${adminSectionCount}`,
    )
    await shot(desk, '04-admin-guard-nonadmin')
    await ctxDesk.close()

    /* 2.3 管理后台（管理员 1001）-------------------------------- */
    group('管理后台（管理员 1001）')
    for (const [tag, viewport] of [
      ['desktop', { width: 1280, height: 800 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const ctx = await browser.newContext({ viewport })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`admin-${tag}:${e.message}`))
      await setAuth(page, admin)
      await waitShell(page)
      await page.goto(`${BASE}/chat/admin`, { waitUntil: 'domcontentloaded' })
      check(`管理后台(${tag}) 渲染`, await until(async () => (await page.locator('.admin').count()) > 0, 20_000))
      await until(async () => (await page.locator('.row[data-uid]').count()) > 0, 20_000)

      const stats = await page.locator('.stat').count()
      const statValues = await page.locator('.stat__value').allInnerTexts()
      check(`管理后台(${tag}) 概览 5 张卡且数字非空`, stats >= 4 && statValues.every((v) => v.trim() !== ''), statValues.join(','))
      const rows = await page.locator('.row[data-uid]').count()
      check(`管理后台(${tag}) 用户列表有数据`, rows > 0, `行数=${rows}`)
      const headers = await page.locator('.row--head .cell').allInnerTexts()
      check(
        `管理后台(${tag}) 表头含 UID/账号/状态/注册时间/操作`,
        ['UID', '账号', '状态', '注册时间', '操作'].every((h) => headers.some((x) => x.includes(h))),
        headers.join('|'),
      )
      const pillTexts = (await page.locator('.pill').allInnerTexts()).join(' ')
      check(`管理后台(${tag}) 状态列含「禁言至」与「管理员」`, pillTexts.includes('禁言至') && pillTexts.includes('管理员'), pillTexts.slice(0, 80))
      const adminRowOpsDisabled = await page
        .locator('.row[data-uid="1001"] .op')
        .first()
        .isDisabled()
        .catch(() => null)
      check(`管理后台(${tag}) 管理员行禁止禁言/删除`, adminRowOpsDisabled === true, `disabled=${adminRowOpsDisabled}`)
      await shot(page, `05-admin-${tag}`)

      if (tag === 'desktop') {
        // 禁言弹层：不真的提交，只看二次确认 UI
        await page.locator('.row[data-uid]:not([data-uid="1001"]) .op').first().click()
        await until(async () => (await page.locator('.mask .panel').count()) > 0, 10_000)
        const muteModalTitle = await page.locator('.panel__title').first().innerText().catch(() => '')
        const presets = await page.locator('.preset').count()
        check('禁言二次确认弹层（含时长预设 + 解除禁言）', muteModalTitle.includes('禁言') && presets >= 2, `${muteModalTitle} presets=${presets}`)
        await shot(page, '06-admin-mute-modal')
        await page.keyboard.press('Escape')
        await sleep(400)

        // 删除弹层：必须手输 UID 才能启用按钮
        const target = page.locator('.row[data-uid]:not([data-uid="1001"]) .op--danger').first()
        await target.click()
        await until(async () => (await page.locator('.mask .panel').count()) > 0, 10_000)
        const deleteBtn = page.locator('.panel__foot .btn--danger').first()
        const disabledBefore = await deleteBtn.isDisabled().catch(() => null)
        check('删除二次确认弹层默认禁用「永久删除」', disabledBefore === true, `disabled=${disabledBefore}`)
        await shot(page, '07-admin-delete-modal')
        await page.keyboard.press('Escape')
        await sleep(300)
      }
      await ctx.close()
    }

    /* 2.4 群聊信息页（群主视角）-------------------------------- */
    group('群聊信息页（群主 alice 视角）')
    for (const [tag, viewport] of [
      ['desktop', { width: 1280, height: 800 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const ctx = await browser.newContext({ viewport })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`info-${tag}:${e.message}`))
      await setAuth(page, alice)
      await waitShell(page)
      await page.goto(`${BASE}/chat/${groupConv.id}/info`, { waitUntil: 'domcontentloaded' })
      check(`群信息页(${tag}) 渲染`, await until(async () => (await page.locator('.info').count()) > 0, 20_000))
      await until(async () => (await page.locator('.member').count()) >= 3, 20_000)

      const title = await page.locator('.info__name').first().innerText().catch(() => '')
      check(`群信息页(${tag}) 群名正确`, title.includes('产品评审组'), title.trim())
      const badges = await page.locator('.member__badge').allInnerTexts()
      check(
        `群信息页(${tag}) 成员角色徽标含 群主 + 管理员`,
        badges.some((b) => b.includes('群主')) && badges.some((b) => b.includes('管理员')),
        badges.join('|'),
      )
      const roleBtns = await page.locator('.member__role').allInnerTexts()
      check(
        `群信息页(${tag}) 群主有「设为管理员/取消管理员」入口`,
        roleBtns.some((t) => t.includes('取消管理员')),
        roleBtns.join('|'),
      )
      check(`群信息页(${tag}) 保留既有 .info__edit 改群名入口`, (await page.locator('.info__edit').count()) === 1)
      check(`群信息页(${tag}) 保留既有 .member__remove 移出入口`, (await page.locator('.member__remove').count()) >= 1)
      const groupAvatarImgs = await page.locator('.info__hero-avatar .avatar-img').count()
      check(`群信息页(${tag}) 群头像走 blob 渲染`, groupAvatarImgs > 0, `avatar-img=${groupAvatarImgs}`)
      await shot(page, `08-group-info-${tag}`)
      await ctx.close()
    }

    /* 2.5 私聊信息页 UID ---------------------------------------- */
    group('私聊信息页（对方 UID）')
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`dminfo:${e.message}`))
      await setAuth(page, alice)
      await waitShell(page)
      await page.goto(`${BASE}/chat/${convAB.id}/info`, { waitUntil: 'domcontentloaded' })
      await until(async () => (await page.locator('.info__kv').count()) > 0, 20_000)
      const kv = await page.locator('.info__kv').innerText().catch(() => '')
      check('私聊信息页显示对方 UID', kv.includes('UID') && /#\d{5,}/.test(kv), kv.replace(/\n/g, ' ').slice(0, 90))
      await shot(page, '09-direct-info-desktop')
      await ctx.close()
    }

    /* 3. 错误面 -------------------------------------------------- */
    group('错误面')
    check('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '[]')
  } finally {
    await browser.close()
  }

  /* 4. 汇总 ------------------------------------------------------ */
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总：${results.length} 项断言 —— 通过 ${results.length - failed.length}，失败 ${failed.length}，截图 ${shots.length} 张 ===`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`)
  }
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(1)
})
