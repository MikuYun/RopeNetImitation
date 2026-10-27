import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request as proxyRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const snapshot = resolve(process.argv[2] ?? '')
const evidenceRoot = resolve(root, 'management/evidence')
if (!snapshot.startsWith(evidenceRoot + sep) || !snapshot.endsWith(sep + 'snapshot')) {
  throw new Error('Provide a verification snapshot under management/evidence; remote targets are not supported')
}
const browserEvidence = join(dirname(snapshot), 'browser')
mkdirSync(browserEvidence, { recursive: true })
const output = mkdtempSync(join(browserEvidence, 'run-'))
const { buildApp } = await import(pathToFileURL(join(snapshot, 'backend/dist/src/app.js')))
const { chromium } = await import(pathToFileURL(join(root, 'frontend/node_modules/playwright/index.mjs')))
const backend = await buildApp({ databasePath: ':memory:', logger: false, defaultFriendUsername: '', origins: [] })
const checks = []
const errors = []
let browser
let server
const web = join(snapshot, 'frontend/dist')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

function check(name, passed, details = {}) {
  checks.push({ name, status: passed ? 'passed' : 'failed', ...details })
  console.log(`${passed ? 'PASSED' : 'FAILED'} ${name}`)
}

async function api(method, url, token, payload, status = 200) {
  const response = await backend.app.inject({ method, url,
    headers: token ? { authorization: `Bearer ${token}` } : {}, payload })
  assert.equal(response.statusCode, status, `Local fixture API ${method} ${url}: ${response.statusCode}`)
  return response.body ? response.json() : null
}

try {
  const password = randomBytes(24).toString('base64url')
  const alice = await api('POST', '/api/v1/auth/register', null, { username: 'pm_alice', displayName: 'PM Alice', password }, 201)
  const bob = await api('POST', '/api/v1/auth/register', null, { username: 'pm_bob', displayName: 'PM Bob', password }, 201)
  const pending = await api('POST', '/api/v1/friend-requests', alice.token, { userId: bob.user.id }, 201)
  await api('POST', `/api/v1/friend-requests/${pending.id}/respond`, bob.token, { action: 'accept' })
  const conversation = await api('POST', '/api/v1/conversations/direct', alice.token, { userId: bob.user.id })
  const fixtureText = `PM isolated message ${randomUUID()}`
  await api('POST', `/api/v1/conversations/${conversation.id}/messages`, alice.token, { clientMsgId: randomUUID(), type: 'text', content: fixtureText }, 201)
  await backend.app.listen({ host: '127.0.0.1', port: 0 })
  const backendPort = backend.app.server.address().port
  const target = `http://127.0.0.1:${backendPort}`
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname.startsWith('/chat/api/')) {
      const upstream = proxyRequest(target + request.url.replace(/^\/chat/, ''), {
        method: request.method, headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
      }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers)
        incoming.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.pipe(upstream)
      return
    }
    if (pathname === '/chat') { response.writeHead(308, { location: '/chat/' }); response.end(); return }
    if (!pathname.startsWith('/chat/')) { response.writeHead(404); response.end(); return }
    const asset = resolve(web, '.' + pathname.slice('/chat'.length))
    if (!asset.startsWith(web + sep)) { response.writeHead(403); response.end(); return }
    const isAsset = pathname.startsWith('/chat/assets/')
    const file = isAsset ? asset : join(web, 'index.html')
    if (!existsSync(file)) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(readFileSync(file))
  })
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/chat/ws?')) { socket.destroy(); return }
    const upstream = proxyRequest(target + request.url.replace(/^\/chat/, ''), {
      headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
    })
    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) peer.write(head)
      if (peerHead.length) socket.write(peerHead)
      peer.pipe(socket).pipe(peer)
      socket.on('error', () => peer.destroy())
      peer.on('error', () => socket.destroy())
    })
    upstream.on('response', () => socket.destroy())
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  backend.config.origins.push(origin)
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }) }
  catch { browser = await chromium.launch({ headless: true }) }

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const pageA = await desktop.newPage()
  const pageB = await mobile.newPage()
  for (const page of [pageA, pageB]) {
    page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }))
    page.on('response', response => {
      if (response.status() >= 400 && response.status() !== 401) errors.push({ type: 'http', status: response.status(), path: new URL(response.url()).pathname })
    })
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/') || path === '/ws') errors.push({ type: 'wrong-base-path', path })
    })
  }
  let aliceBrowserToken
  for (const [page, username] of [[pageA, 'pm_alice'], [pageB, 'pm_bob']]) {
    await page.goto(`${origin}/chat/login`)
    await page.getByPlaceholder('请输入用户名').fill(username)
    await page.getByPlaceholder('请输入密码').fill(password)
    const loginResult = page.waitForResponse(response => response.url().endsWith('/chat/api/v1/auth/login') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const login = await (await loginResult).json()
    if (username === 'pm_alice') aliceBrowserToken = login.token
    await page.waitForURL(`${origin}/chat/chat`)
    await page.goto(`${origin}/chat/chat/${conversation.id}`)
    await page.getByText(fixtureText, { exact: true }).waitFor()
  }
  check('local dual-context production-base deep link', true)
  const desktopText = `PM desktop ${randomUUID()}`
  await pageA.locator('textarea').fill(desktopText)
  await pageA.locator('textarea').press('Enter')
  await pageB.locator('.bubble__text').filter({ hasText: desktopText }).waitFor()
  check('desktop Enter and peer real-time delivery', true)
  const mobileText = `PM mobile ${randomUUID()}`
  await pageB.locator('textarea').fill(mobileText)
  await pageB.locator('textarea').press('Enter')
  check('mobile Enter inserts newline without sending', (await pageB.locator('textarea').inputValue()).includes('\n') && await pageA.getByText(mobileText, { exact: true }).count() === 0)
  await pageB.getByRole('button', { name: '发送', exact: true }).click()
  await pageA.locator('.bubble__text').filter({ hasText: mobileText }).waitFor()
  check('mobile send button and reverse delivery', true)
  for (const [page, label] of [[pageA, 'desktop'], [pageB, 'mobile']]) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    check(`${label} root horizontal overflow`, !overflow)
    await page.screenshot({ path: join(output, `${label}-chat.png`), fullPage: true })
  }
  await pageA.reload()
  await pageA.getByText(fixtureText, { exact: true }).waitFor()
  check('desktop refresh retains persisted history', true)

  await api('POST', '/api/v1/auth/logout', aliceBrowserToken)
  await pageA.waitForFunction(() => localStorage.getItem('aitrance.session') === null)
  await pageA.waitForTimeout(500)
  const onLogin = new URL(pageA.url()).pathname === '/chat/login'
  const privateMessagesVisible = await pageA.locator('.bubble__text').count()
  check('SEC-02/FE-04 revocation immediately exits protected body', onLogin && privateMessagesVisible === 0, {
    path: new URL(pageA.url()).pathname, privateMessagesVisible,
  })
  await pageA.screenshot({ path: join(output, 'after-revocation.png'), fullPage: true })
  check('no unexpected HTTP or page errors', errors.length === 0, { errors })
} catch (error) {
  check('browser-runtime', false, { message: error.message })
} finally {
  if (browser) await browser.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await backend.app.close()
  const report = {
    generatedAt: new Date().toISOString(), target: 'loopback only, disposable in-memory database',
    snapshot: relative(root, snapshot).replaceAll('\\', '/'),
    limitation: 'Chrome mobile viewport is not a physical iOS or Android device; no production access',
    checks,
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Browser report: ${relative(root, join(output, 'report.json'))}`)
  process.exitCode = checks.length && checks.every(item => item.status === 'passed') ? 0 : 1
}
