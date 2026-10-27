/**
 * 附件端到端浏览器验证（真实浏览器内上传 / 渲染 / 灯箱 / 下载 / 预检拦截 / 取消）。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 *   e2e-gates / e2e-responsive / e2e-matrix 是**既有基线**，本文件只新增、不改它们
 *   （工具函数复制而非 import，理由同 e2e-matrix.mjs 顶部注释）。
 *
 * ── 覆盖（对照 task-8 的 8 条要求）─────────────────────────────────
 *   ATT-01  双上下文 gate_a/gate_b 进私聊；composer 附件入口选图 → 进度 → 上传完成
 *           → A 侧 <img> 真渲染（naturalWidth>0，证明 blob URL 生效）
 *   ATT-02  灯箱：点击缩略图放大（.mask .panel + .lightbox__img）+ Esc 关闭 + 焦点归还
 *   ATT-03  B 侧实时收到 A 的图片消息（WS 实时），并如实记录「非属主取图 403 → 降级」
 *           这个**已知限制**（task-8 明确：不判 FAIL）
 *   ATT-04  txt 文件卡片：文件名 + 人类可读大小 + 点击下载后字节正确（sha256 比对）
 *   ATT-05  >10MiB 前端预检拦截：出 toast、**不产生任何上传网络请求**
 *   ATT-06  上传中取消：`.composer__att-x`(title=取消上传) → 上传态清空、无失败 toast
 *   ATT-07  全程无 pageerror；A 侧无 >=400 响应（401 除外）；B 侧的 uploads 403 逐条核对
 *
 * ── 关于「进度」的可观测性（实测踩坑记录，勿重犯）─────────────────
 *   ① 隔离后端在本地回环，1~2 MiB 的文件上传常常 <100ms 完成，进度条一闪而过，
 *      「进度出现」会变成偶发断言。
 *   ② **绝对不要用 `page.route()` + `route.fetch()` 去延迟上传请求**：实测
 *      `route.request().postDataBuffer()` 对这类裸二进制 POST 返回 null，
 *      route.fetch() 重放时丢了 body → 后端 400 `上传内容不能为空`，
 *      于是「上传完成」必然失败（已实测：场景 2 直接 400，toasts 为空）。
 *   ③ 采用的办法：CDP `Network.emulateNetworkConditions({uploadThroughput})` 限速，
 *      让上传真实持续 ~1s，进度事件自然产生中间值（实测 valuenow 序列 = [0,18,69]）。
 *      这是测试侧的网络条件模拟，产品代码与请求体都没被改动。
 *   ④ 取消（ATT-06）用另一种办法：`page.route()` 命中 POST 后**不 continue 也不
 *      fulfill**，请求停在浏览器网络栈里 → uploading 态稳定存在，点取消即可断言。
 *      因为请求从未真正发出，取消后不会在服务端留下 4xx，ATT-07 的错误面保持干净。
 *
 * ── 输入 ─────────────────────────────────────────────────────────
 *   BASE     默认 http://localhost:5173
 *   BACKEND  默认 http://127.0.0.1:3099
 *   HARD_TIMEOUT_MS 默认 420000
 *
 * ── 输出 ─────────────────────────────────────────────────────────
 *   stdout：逐项 PASS / FAIL / SKIP + 汇总
 *   截图：docs/evidence/ux-att-*.png
 *   退出码：0 = 无失败 / 1 = 有 FAIL / 3 = 硬超时
 *
 * ── 副作用 ───────────────────────────────────────────────────────
 *   只在隔离后端 3099 上传临时文件、发测试消息；临时文件写系统 temp 目录，跑完删除。
 *   不碰生产、不 commit、不改源码、不重启任何服务。
 */

import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../docs/evidence')

const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 420_000)
const hardTimer = setTimeout(() => {
  console.error(`\n!! 硬超时 ${HARD_TIMEOUT_MS}ms，强制退出`)
  process.exit(3)
}, HARD_TIMEOUT_MS)

const PW = 'GatePass!2345'
const RUN = Date.now().toString(36).slice(-6)
const results = []
const defects = []

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
  await page.screenshot({ path: resolve(SHOT_DIR, `ux-att-${name}.png`) })
}

/* ── 与服务端同源的体积格式化（期望值必须与产品实现一致）───────────
 * 复制 frontend/src/utils/attachments.ts 的 formatBytes：
 * B 取整；其余 >=100 取整，否则 toFixed(1)。测试侧独立实现，避免「从被测代码
 * import 期望值」把 bug 一起复制进来。
 */
function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3))
  let r = seed
  const rnd = () => {
    r = (r * 1103515245 + 12345) & 0x7fffffff
    return r
  }
  let p = 0
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0 // filter type 0
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

/* ── 后端直连工具（与 e2e-matrix.mjs 同构）──────────────────────── */
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

/* ── 限流自适应（200 次/分钟/用户，同 e2e-matrix.mjs）───────────── */
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

async function ensureFriendsAndConv(a, b) {
  const A = await tokenOf(a)
  const B = await tokenOf(b)
  const listA = await jget('/api/v1/conversations?limit=50&offset=0', A.token)
  const found = (listA.body?.items ?? []).find((c) => c.type === 'direct' && c.peer?.username === b)
  if (found) return found.id

  const search = await jget(`/api/v1/users?q=${b}`, A.token)
  const target = (search.body?.items ?? [])[0]
  if (!target) return null
  await jpost('/api/v1/friend-requests', A.token, { userId: target.id, note: '附件验证' })
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
    // v2 契约 §2：body 不再接受 type（additionalProperties:false → 传了直接 400）。
    body: JSON.stringify({ clientMsgId: crypto.randomUUID(), content }),
  })
  return r.ok ? (await r.json()).seq : null
}

/* ── 浏览器工具（与 e2e-matrix.mjs 同构）────────────────────────── */
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
async function contextAs(browser, username, viewport = { width: 1280, height: 800 }) {
  await ensureNotLimited(username, 60_000)
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
  const page = await ctx.newPage()
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
      return
    } catch (e) {
      lastErr = e
      const limited = await isRateLimited(username).catch(() => false)
      if (!limited && attempt >= 3) break
      if (limited) await ensureNotLimited(username, 60_000)
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await sleep(1500)
    }
  }
  throw lastErr ?? new Error(`openConv 失败：${title}`)
}

/** 在 composer 上装采样器，记录上传态是否真的渲染过（进度条/文案/按钮）。
 *  为什么用 setInterval(40ms) 而不是只靠 MutationObserver：进度元素在被采样到之前
 *  就可能被「上传完成」的 pendingAttachment 换掉（同一次 flush 内），MutationObserver
 *  回调里再 querySelector 就取不到了，会漏掉真实出现过的中间值。定时采样能稳定捕获。 */
async function armComposerObserver(page) {
  await page.evaluate(() => {
    const w = window
    w.__attObs = { progressSeen: false, ratios: [], names: [], labels: [] }
    const sample = () => {
      const track = document.querySelector('.composer__att-track')
      if (track) {
        w.__attObs.progressSeen = true
        const v = Number(track.getAttribute('aria-valuenow') || 0)
        if (Number.isFinite(v) && !w.__attObs.ratios.includes(v)) w.__attObs.ratios.push(v)
      }
      const nameNode = document.querySelector('.composer__att-name')
      if (nameNode) {
        const t = (nameNode.textContent || '').trim()
        if (w.__attObs.names.indexOf(t) === -1) w.__attObs.names.push(t)
      }
      const btn = document.querySelector('.cbar__btn--attach')
      if (btn) {
        const l = btn.getAttribute('aria-label') || ''
        if (w.__attObs.labels.indexOf(l) === -1) w.__attObs.labels.push(l)
      }
    }
    sample()
    const timer = setInterval(sample, 40)
    const mo = new MutationObserver(sample)
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-valuenow', 'aria-label'],
    })
    w.__attObsStop = () => {
      clearInterval(timer)
      mo.disconnect()
    }
  })
}
const readComposerObserver = (page) => page.evaluate(() => window.__attObs)
const stopComposerObserver = (page) =>
  page.evaluate(() => (window.__attObsStop ? window.__attObsStop() : null))

/** 用 composer 的附件入口（点击 .cbar__btn--attach → filechooser）选文件。 */
async function pickViaComposer(page, filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.click('.cbar__btn--attach'),
  ])
  await chooser.setFiles(filePath)
}

/** 等 toast 文本出现（toast 3.2s 自动消失，调用方要尽快断言）。 */
async function waitToast(page, needle, timeoutMs = 8_000) {
  return until(
    () =>
      page.evaluate((n) => {
        return [...document.querySelectorAll('.toast__text')].some((el) =>
          (el.textContent || '').includes(n),
        )
      }, needle),
    timeoutMs,
    150,
  )
}

/**
 * 用 CDP 给这个 page 的上传带宽限速，让「上传中」态真实持续 ~1s，进度条必然产生中间值。
 * 为什么不用 page.route + route.fetch：实测对裸二进制 POST，postDataBuffer() 返回 null，
 * route.fetch() 重放会丢 body → 后端 400「上传内容不能为空」。CDP 是网络层限速，
 * 不碰请求体、不改产品行为，唯一副作用是这一小段时间内该 page 的上传变慢。
 */
const cdpSessions = new Map() // page -> CDPSession
async function armUploadThrottle(page, bytesPerSec = 2 * 1024 * 1024) {
  const cdp = await page.context().newCDPSession(page)
  cdpSessions.set(page, cdp)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: -1, // 下载不限速，避免影响附件取流/渲染
    uploadThroughput: bytesPerSec,
  })
}
async function resetUploadThrottle(page) {
  const cdp = cdpSessions.get(page)
  if (!cdp) return
  await cdp
    .send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    .catch(() => {})
  await cdp.detach().catch(() => {})
  cdpSessions.delete(page)
}

async function imgState(page, selector, scopeText = null) {
  return page.evaluate(
    ([sel, scope]) => {
      let root = document
      if (scope) {
        // 会话历史里会累积历次运行发出的附件消息，必须按当前文件名定位那一条气泡，
        // 否则 querySelector 命中的是上一轮遗留的消息（实测会把断言测到旧数据上）。
        root = [...document.querySelectorAll('.bubble--attach')].find(
          (el) => (el.textContent || '').includes(scope),
        )
        if (!root) return { found: false, ok: false, w: 0, h: 0, src: '' }
      }
      const img = root.querySelector(sel)
      if (!img) return { found: false, ok: false, w: 0, h: 0, src: '' }
      return {
        found: true,
        ok: img.complete && img.naturalWidth > 0,
        w: img.naturalWidth,
        h: img.naturalHeight,
        src: (img.getAttribute('src') || '').slice(0, 16),
      }
    },
    [selector, scopeText],
  )
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n=== 附件端到端验证  BASE=${BASE}  BACKEND=${BACKEND}  RUN=${RUN} ===\n`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'aitr-att-'))
  const photoName = `photo-${RUN}.png`
  const thumbName = `thumb-${RUN}.png`
  const noteName = `note-${RUN}.txt`
  const bigName = `too-big-${RUN}.txt`

  const photoBuf = makePng(1600, 1200, 17) // ≈1.5–2 MiB：慢到能看见进度，又在 10 MiB 内
  const thumbBuf = makePng(64, 48, 7) // 小图：第二次发送用，省时
  const noteText = `ATTACH-TXT-${RUN}\n`.repeat(1) + 'x'.repeat(1536 - `ATTACH-TXT-${RUN}\n`.length)
  const noteBuf = Buffer.from(noteText, 'utf8')
  const bigBuf = Buffer.alloc(10.5 * 1024 * 1024, 0x61) // 10.5 MiB 纯 ASCII

  const paths = {
    photo: join(tmpDir, photoName),
    thumb: join(tmpDir, thumbName),
    note: join(tmpDir, noteName),
    big: join(tmpDir, bigName),
  }
  writeFileSync(paths.photo, photoBuf)
  writeFileSync(paths.thumb, thumbBuf)
  writeFileSync(paths.note, noteBuf)
  writeFileSync(paths.big, bigBuf)
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  console.log(
    `临时文件：photo=${photoBuf.length}B  thumb=${thumbBuf.length}B  note=${noteBuf.length}B  big=${bigBuf.length}B（${tmpDir}）\n`,
  )

  await ensureUser('gate_a', '闸门 A')
  await ensureUser('gate_b', '闸门 B')
  const convAB = await ensureFriendsAndConv('gate_a', 'gate_b')
  if (!convAB) throw new Error('无法建立 gate_a ↔ gate_b 会话，附件链路无从验证')
  console.log(`会话：AB=${convAB}\n`)

  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  // 全局错误采集：pageerror（未捕获异常）+ 非预期 HTTP 错误响应
  const pageErrors = []
  const aBadResponses = []
  const bBadResponses = []
  const uploadPosts = [] // 所有 POST /api/v1/uploads 的 URL（用于「预检不发请求」断言）

  const watchPage = (page, bucket) => {
    page.on('pageerror', (e) => pageErrors.push({ url: page.url(), msg: String(e && e.message ? e.message : e) }))
    page.on('response', (r) => {
      const u = new URL(r.url())
      if (!u.pathname.startsWith('/api/')) return
      if (r.status() >= 400 && r.status() !== 401) bucket.push({ path: u.pathname, status: r.status() })
    })
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (r.method() === 'POST' && u.pathname === '/api/v1/uploads') uploadPosts.push(r.url())
    })
  }

  let ctxA = null
  let ctxB = null
  try {
    /* ═══ ATT-01 图片：入口 → 进度 → 完成 → 渲染 ═══════════════════ */
    group('ATT-01 图片上传（composer 附件入口 → 进度 → 上传完成 → 消息气泡内真渲染）')
    let pageA
    {
      const a = await contextAs(browser, 'gate_a')
      ctxA = a.ctx
      pageA = a.page
      watchPage(pageA, aBadResponses)
      const shellOk = await ensureShell(pageA, 'gate_a')
      check('A 侧进入 /chat 外壳', shellOk, shellOk ? '' : '外壳 15s 未出现')
      await openConv(pageA, '闸门 B', 'gate_a')

      // 用 CDP 上传限速（2 MiB/s）让 uploading 态真实持续约 1s，进度条必然渲染。
      // 不能用 page.route + route.fetch 延迟：实测会丢 POST body → 后端 400。
      await armUploadThrottle(pageA, 2 * 1024 * 1024)

      await armComposerObserver(pageA)
      const postsBefore = uploadPosts.length
      const tPick = Date.now()
      await pickViaComposer(pageA, paths.photo)

      const uploadingSeen = await until(
        () =>
          pageA.evaluate(() => {
            const btn = document.querySelector('.cbar__btn--attach')
            return !!document.querySelector('.composer__att') && !!btn && btn.getAttribute('aria-label') === '正在上传'
          }),
        10_000,
        100,
      )
      check('选择文件后进入「上传中」态（.composer__att 出现且附件按钮 aria-label=正在上传）', uploadingSeen)

      const pendingOk = await until(
        () =>
          pageA.evaluate(
            ([n, s]) => {
              const name = document.querySelector('.composer__att-name')
              const size = document.querySelector('.composer__att-size')
              return (
                !!name && name.textContent.trim() === n && !!size && size.textContent.trim() === s
              )
            },
            [photoName, formatBytes(photoBuf.length)],
          ),
        30_000,
        200,
      )
      const uploadMs = Date.now() - tPick
      // 采样器必须等「上传完成」之后再读：上传中态出现只用了 ~40ms，
      // 那一刻进度条刚挂上、aria-valuenow 还是 0，读早了就只能看到 [0]。
      const obs = await readComposerObserver(pageA)
      const ratioMax = obs.ratios.length ? Math.max(...obs.ratios) : -1
      check(
        '上传进度条真实渲染且产生中间值（.composer__att-track[role=progressbar]，aria-valuenow 单调推进）',
        obs.progressSeen && obs.ratios.length >= 2 && ratioMax > 0 && ratioMax <= 100,
        `progressSeen=${obs.progressSeen} valuenow 序列=${JSON.stringify(obs.ratios)} 上传耗时=${uploadMs}ms labels=${JSON.stringify(obs.labels)}`,
      )

      check(
        '上传完成：待发送区显示文件名与人类可读大小',
        pendingOk,
        `${photoName} · ${formatBytes(photoBuf.length)}`,
      )
      const toastOk = await waitToast(pageA, '图片已就绪，可发送', 5_000)
      check('上传完成提示「图片已就绪，可发送」', toastOk)
      await shot(pageA, '01-image-ready')

      const postCount = uploadPosts.filter((u) => u.includes(encodeURIComponent(photoName))).length
      check(
        '上传请求只发一次且带 filename 查询参数（凭据未进 URL）',
        postCount === 1 && !uploadPosts.some((u) => /[?&]token=/.test(u)),
        `匹配 ${postCount} 次；uploadPosts=${uploadPosts.length}（基线 ${postsBefore}）`,
      )

      // v2 契约 §2：带附件必须附文字，composer 的 canSend 要求 trimmed>0。
      await pageA.locator('.composer__input').fill('配图：' + photoName)
      await pageA.click('.composer__send')
      const bubbleOk = await until(
        () =>
          pageA.evaluate((n) => {
            const bubbles = [...document.querySelectorAll('.bubble--attach')]
            return bubbles.some((b) => (b.textContent || '').includes(n))
          }, photoName),
        20_000,
        200,
      )
      check('点击发送后图片消息气泡出现在正文区（.bubble--attach）', bubbleOk, photoName)

      const thumbReady = await until(async () => {
        const st = await imgState(pageA, 'img.att__thumb', photoName)
        return st.ok && st.w > 0
      }, 20_000, 200)
      const thumbState = await imgState(pageA, 'img.att__thumb', photoName)
      check(
        'A 侧图片真渲染：<img naturalWidth>0 且 src 是 blob: URL（证明带 Bearer 取流 + objectURL）',
        thumbReady && thumbState.src.startsWith('blob:'),
        `natural=${thumbState.w}x${thumbState.h} src=${thumbState.src}…`,
      )
      check(
        '图片消息气泡内显示「文件名 · 大小」',
        await pageA.evaluate(
          ([n, s]) => {
            const bubble = [...document.querySelectorAll('.bubble--attach')].find((b) =>
              (b.textContent || '').includes(n),
            )
            if (!bubble) return false
            const a2 = bubble.querySelector('.att__name--under')
            return !!a2 && a2.textContent.includes(n) && a2.textContent.includes(s)
          },
          [photoName, formatBytes(photoBuf.length)],
        ),
        `${photoName} · ${formatBytes(photoBuf.length)}`,
      )
      await shot(pageA, '02-image-bubble')
      await stopComposerObserver(pageA)
      await resetUploadThrottle(pageA)
    }

    /* ═══ ATT-02 灯箱 ═══════════════════════════════════════════════ */
    group('ATT-02 灯箱（点击缩略图放大 → .mask .panel → Esc 关闭 + 焦点归还）')
    {
      // 必须点「本轮那张图」的缩略图：会话历史里还有历次运行遗留的图片消息，
      // `.first()` 会点到最旧的一条，灯箱标题自然对不上当前文件名。
      const thumbBtn = pageA
        .locator('.bubble--attach')
        .filter({ hasText: photoName })
        .locator('.att__thumb-btn')
        .first()
      await thumbBtn.click()
      const modalOk = await until(
        () => pageA.evaluate(() => !!document.querySelector('.mask .panel')),
        8_000,
        150,
      )
      check('点击缩略图打开灯箱（.mask .panel 出现）', modalOk)

      const titleOk = await pageA.evaluate((n) => {
        const t = document.querySelector('.mask .panel .panel__title')
        return !!t && t.textContent.trim() === n
      }, photoName)
      check('灯箱标题 = 附件文件名', titleOk, photoName)

      const bigOk = await until(async () => {
        const st = await imgState(pageA, '.mask .lightbox__img')
        return st.ok && st.w > 0
      }, 10_000, 150)
      const bigState = await imgState(pageA, '.mask .lightbox__img')
      check(
        '灯箱内大图真加载（naturalWidth>0）',
        bigOk,
        `natural=${bigState.w}x${bigState.h}`,
      )
      await shot(pageA, '03-lightbox')

      await pageA.keyboard.press('Escape')
      const closed = await until(
        () => pageA.evaluate(() => !document.querySelector('.mask .panel')),
        8_000,
        150,
      )
      check('Esc 关闭灯箱（.mask .panel 移除）', closed)

      const focusBack = await pageA.evaluate(() => {
        const el = document.activeElement
        if (!el) return ''
        return (el.getAttribute('aria-label') || '') + '|' + (el.className || '')
      })
      check(
        '关闭后焦点归还到缩略图按钮（无障碍：弹层不得吞焦点）',
        focusBack.includes('预览图片'),
        `activeElement=${focusBack}`,
      )
    }

    /* ═══ ATT-03 B 侧实时收到 + 已知限制（非属主 403）═══════════════ */
    group('ATT-03 B 侧 WS 实时收到 A 的图片消息 + 跨用户附件可见性（P0）')
    {
      const b = await contextAs(browser, 'gate_b')
      ctxB = b.ctx
      const pageB = b.page
      watchPage(pageB, bBadResponses)
      const shellB = await ensureShell(pageB, 'gate_b')
      check('B 侧进入 /chat 外壳', shellB, shellB ? '' : '外壳 15s 未出现')
      await openConv(pageB, '闸门 A', 'gate_b')

      // 先发一条文本，确认 B 的 WS 实时通道是通的（否则后面「实时收到图片」的断言不成立）
      const probeText = `WS-PROBE-${RUN}`
      await sendTextAs('gate_a', convAB, probeText)
      const wsLive = await until(
        () =>
          pageB.evaluate((t) => {
            return [...document.querySelectorAll('.bubble__text')].some((el) =>
              (el.textContent || '').includes(t),
            )
          }, probeText),
        15_000,
        300,
      )
      check('B 侧 WS 实时收到 A 的文本消息（实时通道前置）', wsLive, probeText)

      // A 侧再发一张小图（这里不断言进度，不需要限速；直接就着正常网速上传）
      await pickViaComposer(pageA, paths.thumb)
      const pendingThumb = await until(
        () =>
          pageA.evaluate((n) => {
            const name = document.querySelector('.composer__att-name')
            return !!name && name.textContent.trim() === n
          }, thumbName),
        30_000,
        200,
      )
      check('A 侧第二张图上传完成', pendingThumb, thumbName)
      await pageA.locator('.composer__input').fill('配图：' + thumbName)
      await pageA.click('.composer__send')

      const bGot = await until(
        () =>
          pageB.evaluate((n) => {
            return [...document.querySelectorAll('.pane__row')].some((row) => {
              const att = row.querySelector('.bubble--attach')
              return !!att && (att.textContent || '').includes(n)
            })
          }, thumbName),
        20_000,
        300,
      )
      check('B 侧实时收到 A 的图片消息（.bubble--attach 出现且含文件名）', bGot, thumbName)
      await shot(pageB, '04-b-received')

      // task-9 已把 readUpload 改成「同会话成员可读」（backend/src/service.ts:511-530 的
      // messages JOIN conversation_members），因此 B 侧不再 403，而是真图渲染。
      // 旧断言（403 + 降级 file-card）是 task-8 时代的已知限制记录，已被产品修复打破；
      // 这里改成更强的正面断言（不是放宽）：要求零 403、零降级、缩略图真加载。
      const upload403 = bBadResponses.filter(
        (r) => r.status === 403 && r.path.startsWith('/api/v1/uploads/'),
      )
      const bView = await pageB.evaluate((n) => {
        const rows = [...document.querySelectorAll('.pane__row')]
        const row = rows.find((r) => (r.textContent || '').includes(n))
        if (!row) return { found: false }
        const img = row.querySelector('.att--image img.att__thumb')
        return {
          found: true,
          asFile: !!row.querySelector('.att.att--file'),
          asImage: !!row.querySelector('.att.att--image'),
          name: row.querySelector('.att__name')?.textContent?.trim() ?? '',
          naturalW: img ? img.naturalWidth : 0,
          skeleton: !!row.querySelector('.att__thumb-skeleton'),
        }
      }, thumbName)
      checkProduct(
        'B 侧能看到 A 图片的附件条目（文件名 + 大小可读）',
        bView.found && !!bView.name,
        `found=${bView.found} name=${bView.name}`,
      )
      check(
        'P0 跨用户可见：同会话成员取 A 的图片不返回 403（readUpload 共享放行）',
        bView.found && upload403.length === 0,
        `403 次数=${upload403.length} 形态=${bView.asFile ? 'file-card' : bView.asImage ? 'image' : 'unknown'}`,
      )
      check(
        'P0 跨用户可见：B 侧图片渲染为 .att--image 且 naturalWidth>0（未降级为文件卡片）',
        bView.asImage && !bView.asFile && bView.naturalW > 0 && !bView.skeleton,
        `asImage=${bView.asImage} asFile=${bView.asFile} naturalW=${bView.naturalW} skeleton=${bView.skeleton}`,
      )
    }

    /* ═══ ATT-04 txt 文件卡片 + 下载字节校验 ═══════════════════════ */
    group('ATT-04 txt 文件：卡片展示（名称 + 可读大小）+ 下载字节一致')
    {
      await pickViaComposer(pageA, paths.note)
      const pendingNote = await until(
        () =>
          pageA.evaluate(
            ([n, s]) => {
              const name = document.querySelector('.composer__att-name')
              const size = document.querySelector('.composer__att-size')
              return !!name && name.textContent.trim() === n && !!size && size.textContent.trim() === s
            },
            [noteName, formatBytes(noteBuf.length)],
          ),
        30_000,
        200,
      )
      check('txt 上传完成：待发送区显示文件名与大小', pendingNote, `${noteName} · ${formatBytes(noteBuf.length)}`)
      await pageA.locator('.composer__input').fill('文件：' + noteName)
      await pageA.click('.composer__send')

      const cardOk = await until(
        () =>
          pageA.evaluate((n) => {
            return [...document.querySelectorAll('.bubble--attach .att--file')].some((el) =>
              (el.textContent || '').includes(n),
            )
          }, noteName),
        20_000,
        200,
      )
      check('发送后渲染为文件卡片（.att--file，非图片形态）', cardOk, noteName)

      const cardInfo = await pageA.evaluate((n) => {
        const els = [...document.querySelectorAll('.bubble--attach .att--file')]
        const el = els.find((e) => (e.textContent || '').includes(n))
        if (!el) return null
        return {
          name: el.querySelector('.att__name')?.textContent?.trim() ?? '',
          meta: el.querySelector('.att__meta')?.textContent?.trim() ?? '',
          title: el.getAttribute('title') ?? '',
          icon: [...(el.querySelector('.att__icon')?.classList ?? [])].join(','),
        }
      }, noteName)
      const expectSize = formatBytes(noteBuf.length)
      check(
        '文件卡片显示文件名与「人类可读大小 · 点击下载」',
        !!cardInfo && cardInfo.name === noteName && cardInfo.meta === `${expectSize} · 点击下载`,
        cardInfo ? `name=${cardInfo.name} meta=${cardInfo.meta}` : '卡片不存在',
      )
      check(
        '文件卡片 title 含「文件名（大小）」且图标分类为 text',
        !!cardInfo && cardInfo.title === `${noteName}（${expectSize}）` && cardInfo.icon.includes('att__icon--text'),
        cardInfo ? `title=${cardInfo.title} icon=${cardInfo.icon}` : '卡片不存在',
      )
      await shot(pageA, '05-file-card')

      // 下载：App 用 <a download href=blob:> 触发，Playwright 能拿到 download 事件
      let downloadBytesOk = false
      let downloadDetail = ''
      try {
        const [download] = await Promise.all([
          pageA.waitForEvent('download', { timeout: 20_000 }),
          pageA
            .locator('.bubble--attach .att--file', { hasText: noteName })
            .first()
            .click(),
        ])
        const suggested = download.suggestedFilename()
        const filePath = await download.path()
        const got = readFileSync(filePath)
        downloadBytesOk = got.length === noteBuf.length && sha(got) === sha(noteBuf)
        downloadDetail = `suggested=${suggested} bytes=${got.length}/${noteBuf.length} sha=${downloadBytesOk ? '一致' : '不一致'}`
        if (downloadBytesOk) await download.delete().catch(() => {})
      } catch (e) {
        downloadDetail = `捕获下载失败：${String(e && e.message ? e.message : e).slice(0, 160)}`
      }
      check('点击文件卡片触发下载，且下载字节与上传内容完全一致（sha256 比对）', downloadBytesOk, downloadDetail)
    }

    /* ═══ ATT-05 >10MiB 前端预检：不发网络请求 ═════════════════════ */
    group('ATT-05 >10MiB 前端预检拦截（必须不产生上传网络请求）')
    {
      const postsBefore = uploadPosts.length
      await pickViaComposer(pageA, paths.big)

      const expectMsg = `文件超过 10.0 MB（当前 ${formatBytes(bigBuf.length)}）`
      const toastShown = await waitToast(pageA, '文件超过 10.0 MB', 8_000)
      const toastText = await pageA.evaluate(() => {
        const el = [...document.querySelectorAll('.toast__text')].find((e) =>
          (e.textContent || '').includes('文件超过'),
        )
        return el ? el.textContent.trim() : ''
      })
      check('超限文件被前端拦下并给出明确 toast（含当前体积）', toastShown && toastText === expectMsg, toastText || expectMsg)

      const errTone = await pageA.evaluate(() => {
        const el = [...document.querySelectorAll('.toast')].find((e) =>
          (e.textContent || '').includes('文件超过'),
        )
        return el ? el.className : ''
      })
      check('超限提示是 error 语气（toast--error）', errTone.includes('toast--error'), errTone)

      const noAttState = await pageA.evaluate(
        () => !document.querySelector('.composer__att'),
      )
      check('超限文件不进入上传态（.composer__att 不出现）', noAttState)

      check(
        '超限文件**不产生任何上传网络请求**（POST /api/v1/uploads 计数不变）',
        uploadPosts.length === postsBefore,
        `before=${postsBefore} after=${uploadPosts.length}`,
      )
      await shot(pageA, '06-too-large')
    }

    /* ═══ ATT-06 上传中取消 ════════════════════════════════════════ */
    group('ATT-06 上传中取消（.composer__att-x title=取消上传）')
    {
      // 拦截 POST 上传并挂住，制造稳定的「上传中」窗口
      let heldRoute = null
      await pageA.route('**/api/v1/uploads*', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        heldRoute = route // 不 fulfill：请求停在浏览器网络栈里，uploading 态保持
      })
      const postsBefore = uploadPosts.length
      await pickViaComposer(pageA, paths.photo)

      const uploadingSeen = await until(
        () =>
          pageA.evaluate(() => {
            const btn = document.querySelector('.composer__att-x')
            return !!document.querySelector('.composer__att-track') && !!btn && btn.getAttribute('title') === '取消上传'
          }),
        15_000,
        100,
      )
      check('上传中：进度条 + 关闭按钮 title=取消上传', uploadingSeen)

      const requestIssued = await until(() => uploadPosts.length > postsBefore, 5_000, 100)
      check('上传请求已发出（取消前确实在飞）', requestIssued, `posts=${uploadPosts.length - postsBefore}`)
      await shot(pageA, '07-uploading-cancelable')

      await pageA.click('.composer__att-x')

      // task-10 把附件入口拆成了两个按钮（ux2-contract §十二）：
      //   .cbar__btn--image  aria-label="发送图片"
      //   .cbar__btn--attach aria-label="发送文件"
      // 旧断言里的「添加附件」已不存在（本轮 UX2 改名）。断言语义不变：
      // 取消后附件态必须清空，且两个入口都回到可点击的空闲态。
      const cleared = await until(
        () =>
          pageA.evaluate(() => {
            const img = document.querySelector('.cbar__btn--image')
            const file = document.querySelector('.cbar__btn--attach')
            if (document.querySelector('.composer__att')) return false
            if (!img || !file) return false
            return (
              img.getAttribute('aria-label') === '发送图片' &&
              file.getAttribute('aria-label') === '发送文件' &&
              !img.disabled &&
              !file.disabled
            )
          }),
        10_000,
        150,
      )
      check('取消后上传态清空、两个附件入口都恢复可点（发送图片 / 发送文件）', cleared)

      const noFailToast = await pageA.evaluate(() =>
        [...document.querySelectorAll('.toast__text')].every((el) => !(el.textContent || '').includes('上传失败')),
      )
      check('取消是用户主动行为，不弹「上传失败」错误提示', noFailToast)

      // 释放挂住的请求（它已随 XHR abort 取消），再解除拦截
      if (heldRoute) await heldRoute.abort().catch(() => {})
      await pageA.unroute('**/api/v1/uploads*')

      // 取消后仍能正常上传（控制器没有卡死）
      const postsAfterCancel = uploadPosts.length
      await pickViaComposer(pageA, paths.thumb)
      const recovered = await until(
        () =>
          pageA.evaluate((n) => {
            const name = document.querySelector('.composer__att-name')
            return !!name && name.textContent.trim() === n
          }, thumbName),
        30_000,
        200,
      )
      check(
        '取消后可立即重新上传成功（AbortController 状态已复位）',
        recovered && uploadPosts.length > postsAfterCancel,
        `uploads=${uploadPosts.length - postsAfterCancel}`,
      )
      // 清掉这条待发送附件，避免污染后续
      await pageA
        .locator('.composer__att-x')
        .click()
        .catch(() => {})
      await shot(pageA, '08-after-cancel')
    }

    /* ═══ ATT-07 全程错误面 ════════════════════════════════════════ */
    group('ATT-07 全程无脚本异常 / 无非预期 HTTP 错误')
    {
      check('全程无未捕获脚本异常（pageerror）', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 400))
      check(
        'A 侧无 >=400 响应（401 除外）',
        aBadResponses.length === 0,
        JSON.stringify(aBadResponses).slice(0, 400),
      )
      const bUnexpected = bBadResponses.filter(
        (r) => !(r.status === 403 && r.path.startsWith('/api/v1/uploads/')),
      )
      check(
        'B 侧无其它 >=400 响应（跨用户取附件已共享放行，uploads 403 也不应出现）',
        bUnexpected.length === 0,
        JSON.stringify(bUnexpected).slice(0, 400),
      )
      // 注：跨用户取附件现在是共享放行（backend/src/service.ts readUpload），
      // 上面的白名单保留只为防止偶发时序噪声误报，ATT-03 已单独硬断言 403 次数=0。
    }
  } finally {
    await ctxA?.close().catch(() => {})
    await ctxB?.close().catch(() => {})
    await browser.close().catch(() => {})
    clearTimeout(hardTimer)
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return finish()
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
    console.log('\nDEFECT（产品行为不符合验收，另见 evidence）：')
    for (const d of defects) console.log(`  - ${d.name}  —— ${d.detail}`)
  }
  if (skipped.length) {
    console.log('\nSKIP：')
    for (const s of skipped) console.log(`  - ${s.name}  —— ${s.detail}`)
  }
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  // 必须显式退出：残留的 Chrome 子进程 / 定时器会让 node 进程挂住不返回。
  clearTimeout(hardTimer)
  console.error('脚本异常：', e)
  process.exit(1)
})
