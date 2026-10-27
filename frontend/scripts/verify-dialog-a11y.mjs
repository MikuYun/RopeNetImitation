/**
 * 对话框焦点管理的真浏览器复验（对应本轮修的 3 条产品缺陷）。
 *
 * ── 为什么单独成文件、放在 scripts/ 而不是 e2e-*.mjs ─────────────────
 *   `frontend/e2e-*.mjs` 是 frontend-e2e 的交付物，本轮明确不许碰。这里只做
 *   「我这一处改动是否真的在浏览器里生效」的定点复验，跑得快（~20s），
 *   可以反复跑；完整矩阵仍由 `e2e-matrix.mjs` 负责。
 *
 * ── 断言（每一项都对应一条验收判据）─────────────────────────────────
 *   1. 桌面弹层打开后焦点自动进入弹层        ← 缺陷 1（修前焦点停在触发按钮）
 *   2. 桌面弹层 Tab 在末尾回首个             ← 既有行为，防回归
 *   3. 桌面弹层 Shift+Tab 在首个回末尾       ← 既有行为，防回归
 *   4. 桌面弹层 Esc 关闭                     ← 既有行为，防回归
 *   5. 桌面弹层关闭后焦点归还触发按钮        ← 补缺陷 1 后必须同时成立
 *       （修前之所以 PASS 是因为焦点压根没离开过触发按钮）
 *   6. 手机「更多」面板 Esc 关闭             ← 缺陷 2
 *   7. 手机面板 Tab 不逃逸到 body            ← 缺陷 3
 *   8. 手机面板 Shift+Tab 不逃逸             ← 缺陷 3 反向
 *   9. 手机面板遮罩点击仍可关闭              ← 防回归（原有 PASS）
 *  10. 手机面板「取消」仍可关闭              ← 防回归（原有 PASS）
 *
 * ── 输入 / 副作用 ───────────────────────────────────────────────────
 *   BASE    默认 http://localhost:5173（必须是连隔离后端 3099 的 dev server）
 *   BACKEND 默认 http://127.0.0.1:3099（只做 login 取 token）
 *   只读代码、只在浏览器里操作；唯一副作用是向仓库写截图到 evidence/。
 *   退出码 0 = 全 PASS，1 = 有 FAIL。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:3099'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(HERE, '../evidence')
const USER = process.env.GATE_USER ?? 'gate_a'
const PW = process.env.GATE_PASS ?? 'GatePass!2345'

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`)
}

async function login(username) {
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  })
  if (!r.ok) throw new Error(`login ${username} 失败：${r.status}`)
  return r.json()
}

/** 与 e2e-matrix.mjs 同构：手动写 localStorage，避免 addInitScript 每次导航重跑。 */
async function setAuth(page, cred) {
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

async function activeInfo(page) {
  return page.evaluate(() => {
    const a = document.activeElement
    return {
      tag: a?.tagName ?? '',
      label: (a?.textContent ?? '').trim().slice(0, 16),
      title: a?.getAttribute?.('title') ?? '',
      cls: a?.className ?? '',
    }
  })
}

async function insideOf(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    const a = document.activeElement
    return {
      inside: !!root && !!a && root.contains(a),
      tag: a?.tagName ?? '',
      label: (a?.textContent ?? '').trim().slice(0, 16),
    }
  }, selector)
}

/** 与组件 dialogA11y 同选择器；focusNth 用真实 focus() 而不是 click，避免触发副作用。 */
function focusNth(page, selector, idx) {
  return page.evaluate(
    ([sel, i]) => {
      const root = document.querySelector(sel)
      if (!root) return ''
      const list = [
        ...root.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.disabled && el.offsetParent !== null)
      const el = i < 0 ? list[list.length + i] : list[i]
      if (!el) return ''
      el.focus()
      return (document.activeElement?.textContent ?? '').trim().slice(0, 16)
    },
    [selector, idx],
  )
}

async function until(fn, timeoutMs = 6_000, stepMs = 120) {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: resolve(SHOT_DIR, `focusfix-${name}.png`) })
}

async function main() {
  const cred = await login(USER)
  // 本机只装了完整 Chrome（ms-playwright/chromium-1243），没有 headless_shell；
  // 与 backend/evidence/csp-browser-check.mjs 同策略：先走 channel:'chrome'，失败再退回默认。
  const browser = await chromium
    .launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }))

  /* ── 桌面：AppModal ─────────────────────────────────────────── */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await setAuth(page, cred)
    await page.waitForSelector('.list__add[title="发起群聊"]', { timeout: 20_000 })

    const addBtn = page.locator('.list__add[title="发起群聊"]')
    await addBtn.click()
    await page.waitForSelector('.mask .panel', { timeout: 10_000 })
    // Transition 0.18s + watch(nextTick) 里的 focus 都是微任务级，给 400ms 冗余。
    await page.waitForTimeout(400)

    const openFocus = await insideOf(page, '.mask .panel')
    check('弹层打开时焦点自动进入弹层', openFocus.inside, `焦点=${openFocus.tag}/${openFocus.label}`)
    const openActive = await activeInfo(page)
    // 明确断言「不在触发按钮上」，否则 inside=true 也可能因为焦点从未移动而假绿。
    check('打开瞬间焦点已离开触发按钮', openActive.title !== '发起群聊', `title=${openActive.title}`)
    await shot(page, 'modal-open')

    // 勾一个成员，让 footer 的「创建」从 disabled 变为可聚焦（trap 的 last 需要可聚焦）
    await page.locator('.create__item').first().click()
    await page.waitForTimeout(200)

    await focusNth(page, '.mask .panel', -1)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(150)
    const afterTab = await insideOf(page, '.mask .panel')
    check('弹层 Tab 在最后一个元素处循环回首个（未回归）', afterTab.inside,
      `焦点=${afterTab.tag}/${afterTab.label}`)

    await focusNth(page, '.mask .panel', 0)
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(150)
    const afterShift = await insideOf(page, '.mask .panel')
    check('弹层 Shift+Tab 在首个元素处循环到末尾（未回归）', afterShift.inside,
      `焦点=${afterShift.tag}/${afterShift.label}`)

    await page.keyboard.press('Escape')
    const closed = await until(async () => (await page.locator('.mask .panel').count()) === 0)
    check('弹层 Esc 可关闭（未回归）', closed)

    await addBtn.click()
    await page.waitForSelector('.mask .panel', { timeout: 10_000 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const returned = await activeInfo(page)
    check('弹层关闭后焦点归还触发按钮', returned.title === '发起群聊',
      `焦点=${returned.tag} title=${returned.title}`)

    await ctx.close()
  }

  /* ── 手机：MobileNav .sheet ────────────────────────────────── */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    await setAuth(page, cred)
    await page.waitForSelector('.mnav__tab', { timeout: 20_000 })

    const moreBtn = page.locator('.mnav__tab').nth(2)
    await moreBtn.click()
    await page.waitForSelector('.sheet', { timeout: 10_000 })
    await page.waitForTimeout(350)
    check('手机「更多」面板可打开', await page.locator('.sheet').isVisible())

    // 打开瞬间应把焦点移入面板（与 AppModal 同一策略）
    const sheetOpen = await insideOf(page, '.sheet')
    check('手机面板打开时焦点进入面板', sheetOpen.inside, `焦点=${sheetOpen.tag}/${sheetOpen.label}`)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const escClosed = await until(async () => (await page.locator('.sheet').count()) === 0)
    check('手机「更多」面板 Esc 可关闭', escClosed,
      escClosed ? '' : '按 Esc 后面板仍在（MobileNav 未处理 keydown）')

    // 焦点是否归还到「更多」按钮（点开它的那个 tab）
    const backTo = await activeInfo(page)
    check('手机面板 Esc 关闭后焦点归还「更多」按钮', backTo.label === '更多' || backTo.cls.includes('mnav__tab'),
      `焦点=${backTo.tag}/${backTo.label} cls=${backTo.cls}`)

    for (const [label, keyName, idx] of [
      ['Tab', 'Tab', -1],
      ['Shift+Tab', 'Shift+Tab', 0],
    ]) {
      await moreBtn.click()
      await page.waitForSelector('.sheet', { timeout: 10_000 })
      await page.waitForTimeout(300)
      await focusNth(page, '.sheet', idx)
      await page.keyboard.press(keyName)
      await page.waitForTimeout(150)
      const trapped = await insideOf(page, '.sheet')
      check(`手机面板 ${label} 焦点不逃逸到 body`, trapped.inside,
        `焦点=${trapped.tag}/${trapped.label}`)
      if (label === 'Tab') await shot(page, 'sheet-trap')
      // 用「取消」关掉，同时验证既有 PASS 的关闭路径未回归
      await page.locator('.sheet__cancel').click()
      const c = await until(async () => (await page.locator('.sheet').count()) === 0)
      check('手机「更多」面板可关闭（取消，未回归）', c)
    }

    // 遮罩点击关闭（原有路径，防回归）
    await moreBtn.click()
    await page.waitForSelector('.sheet', { timeout: 10_000 })
    await page.waitForTimeout(300)
    await page.mouse.click(195, 60) // 面板在底部，顶部是遮罩
    const maskClosed = await until(async () => (await page.locator('.sheet').count()) === 0)
    check('手机面板遮罩点击仍可关闭（未回归）', maskClosed)

    await ctx.close()
  }

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n汇总：${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL  ${f.name}  —— ${f.detail}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exitCode = 1
})
