#!/usr/bin/env node
/**
 * CSP 真浏览器裁决（backend-core / SEC-04）
 *
 * 用真 Chrome（playwright channel:'chrome'）加载 **Vite 生产构建产物**
 * frontend/dist + 真实后端 backend/dist/src/app.js，对同一份 HTML 下发两种策略：
 *   A) 严格：style-src 'self'
 *   B) 放宽：style-src 'self' 'unsafe-inline'
 * 实测：登录 → /chat 渲染 → 打开「发起群聊」弹层（AppModal 的 :style 宽度）→
 * securitypolicyviolation 逐条计数（按 directive 分组）。
 *
 * 只读仓库、只在内存库上跑、不写任何仓库文件。用法：
 *   node backend/evidence/csp-browser-check.mjs
 */
import { createServer, request as proxyRequest } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const backendRoot = resolve(here, '..');
const repoRoot = resolve(backendRoot, '..');
const webRoot = join(repoRoot, 'frontend', 'dist');
const playwrightPath = join(repoRoot, 'frontend', 'node_modules', 'playwright', 'index.mjs');


const t0 = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts);

const { buildApp, CONTENT_SECURITY_POLICY } = await import(pathToFileURL(join(backendRoot, 'dist', 'src', 'app.js')));
const { chromium } = await import(pathToFileURL(playwrightPath));

// A) 严格：直接用后端下发的那一条（避免探针与实现漂移）
const STRICT_CSP = CONTENT_SECURITY_POLICY;
// B) 对照：只在 style-src 上放宽 'unsafe-inline'，用于证明严格策略的可用性不依赖放宽
const RELAXED_CSP = CONTENT_SECURITY_POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
if (RELAXED_CSP === STRICT_CSP) throw new Error('relaxed CSP derivation failed');

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

const results = [];
let failures = 0;
function assert(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(done => setTimeout(() => done(fallback), ms).unref())]);
}

const password = 'csp-browser-check-password';
const username = 'csp_browser';
const backend = await buildApp({ databasePath: ':memory:', logger: false, defaultFriendUsername: '', origins: [] });
const registered = await backend.app.inject({
  method: 'POST', url: '/api/v1/auth/register',
  payload: { username, displayName: 'CSP Browser', password },
});
if (registered.statusCode !== 201) throw new Error(`fixture register failed: ${registered.statusCode} ${registered.body}`);
await backend.app.listen({ host: '127.0.0.1', port: 0 });
const backendPort = backend.app.server.address().port;
const target = `http://127.0.0.1:${backendPort}`;
log(`backend fixture listening on ${target}`);

/** 静态 web + /api、/health 反向代理 + /ws upgrade 代理；CSP 只加在 HTML 与 assets 响应上 */
function makeServer(csp) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/') || pathname === '/health') {
      const upstream = proxyRequest(target + request.url, {
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
      }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
      return;
    }
    const isAsset = pathname.startsWith('/assets/');
    const file = isAsset ? resolve(webRoot, '.' + pathname) : join(webRoot, 'index.html');
    if (!file.startsWith(webRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy': csp,
    });
    response.end(readFileSync(file));
  });
  server.on('upgrade', (request, socket) => {
    const upstream = proxyRequest(target + request.url, {
      headers: { ...request.headers, host: `127.0.0.1:${backendPort}` },
    });
    upstream.on('upgrade', (response, peer, head) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head);
      peer.pipe(socket).pipe(peer);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  return server;
}

const styleExportKeys = ['style', 'cssText'];

async function probe(csp, label) {
  log(`=== probe ${label} ===`);
  const server = makeServer(csp);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  backend.config.origins.push(origin);

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }));
  log(`chrome ${browser.version()} launched`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleMessages = [];
  const failedRequests = [];
  await page.addInitScript(() => {
    globalThis.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      globalThis.__cspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        sample: String(event.sample ?? '').slice(0, 120),
        source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
        disposition: event.disposition,
      });
    });
  });
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => consoleMessages.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => failedRequests.push(`${request.failure()?.errorText} ${request.url()}`));
  page.on('response', response => {
    if (response.status() >= 400 && response.status() !== 401) failedRequests.push(`HTTP ${response.status()} ${response.url()}`);
  });

  let snapshot;
  try {
    await page.goto(`${origin}/login`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 20000 });
    log('app mounted on /login');
    await page.getByPlaceholder('请输入用户名').fill(username);
    await page.getByPlaceholder('请输入密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => location.pathname.startsWith('/chat'), null, { timeout: 20000 });
    log(`login ok -> ${await page.evaluate(() => location.pathname)}`);
    await page.waitForTimeout(800);

    // 打开「发起群聊」弹层，覆盖 AppModal 的 :style 宽度 + 遮罩
    const addButton = page.locator('button.list__add');
    if (await addButton.count()) {
      await addButton.first().click();
      await page.waitForTimeout(600);
    }
    log(`add-button count=${await addButton.count()}`);

    snapshot = await page.evaluate(() => {
      const styleAttrs = [...document.querySelectorAll('[style]')];
      const avatar = document.querySelector('.avatar');
      const panel = document.querySelector('.panel');
      const dialog = document.querySelector('[role="dialog"]');
      const read = node => (node ? {
        backgroundColor: getComputedStyle(node).backgroundColor,
        width: getComputedStyle(node).width,
        height: getComputedStyle(node).height,
        borderRadius: getComputedStyle(node).borderRadius,
        display: getComputedStyle(node).display,
        inlineAttr: node.getAttribute('style'),
      } : null);
      return {
        path: location.pathname,
        text: (document.querySelector('#app')?.innerText ?? '').slice(0, 200),
        styleAttrCount: styleAttrs.length,
        styleAttrSamples: styleAttrs.slice(0, 6).map(node => ({
          tag: node.tagName, class: String(node.className).slice(0, 40), attr: node.getAttribute('style'),
        })),
        avatar: read(avatar),
        panel: read(panel),
        dialog: read(dialog),
        styleSheets: document.styleSheets.length,
        violations: globalThis.__cspViolations ?? [],
      };
    });
    const styleViolations = snapshot.violations.filter(item => item.directive.startsWith('style'));
    const scriptViolations = snapshot.violations.filter(item => item.directive.startsWith('script'));
    const otherViolations = snapshot.violations.filter(item => !item.directive.startsWith('style') && !item.directive.startsWith('script'));

    assert(`${label}: 登录后进入 /chat 且主体有内容`, snapshot.path.startsWith('/chat') && snapshot.text.trim().length > 0, {
      path: snapshot.path, text: snapshot.text.slice(0, 60),
    });
    assert(`${label}: 外部样式表已加载`, snapshot.styleSheets > 0, `styleSheets=${snapshot.styleSheets}`);
    assert(`${label}: 内联 style 属性已写入 DOM`, snapshot.styleAttrCount > 0, {
      count: snapshot.styleAttrCount, samples: snapshot.styleAttrSamples,
    });
    assert(`${label}: AppAvatar 的 :style 生效（非透明底色 + 34px + 圆角）`,
      Boolean(snapshot.avatar) && snapshot.avatar.backgroundColor !== 'rgba(0, 0, 0, 0)'
        && snapshot.avatar.backgroundColor !== 'transparent' && snapshot.avatar.width === '34px'
        && snapshot.avatar.borderRadius === '8px',
      snapshot.avatar);
    assert(`${label}: AppModal 的 :style 宽度生效（弹层可见且非 auto 宽度）`,
      Boolean(snapshot.dialog && snapshot.dialog.display !== 'none' && snapshot.dialog.width !== 'auto'),
      snapshot.dialog ?? snapshot.panel);
    assert(`${label}: style-src 违规数 = 0`, styleViolations.length === 0, {
      count: styleViolations.length, items: styleViolations.slice(0, 5),
    });
    assert(`${label}: 无失败请求（CSP 未拦资源）`, failedRequests.length === 0, failedRequests.slice(0, 5));

    const cspConsole = consoleMessages.filter(item => /Content Security Policy|Refused to/i.test(item.text));
    const pageErrors = consoleMessages.filter(item => item.type === 'pageerror');
    log(`violations: style=${styleViolations.length} script=${scriptViolations.length} other=${otherViolations.length}`);
    if (scriptViolations.length) log(`script violations: ${JSON.stringify(scriptViolations.slice(0, 3))}`);
    log(`console CSP logs=${cspConsole.length} pageErrors=${pageErrors.length}`);
    log(`styleAttrs=${snapshot.styleAttrCount} avatar=${JSON.stringify(snapshot.avatar && { bg: snapshot.avatar.backgroundColor, w: snapshot.avatar.width, r: snapshot.avatar.borderRadius })}`);
    log(`dialog=${JSON.stringify(snapshot.dialog && { display: snapshot.dialog.display, w: snapshot.dialog.width })}`);

    return {
      label, csp,
      styleViolations: styleViolations.length,
      scriptViolations: scriptViolations.length,
      otherViolations: otherViolations.length,
      violationDetails: snapshot.violations,
      cspConsole, pageErrors, failedRequests,
      styleAttrCount: snapshot.styleAttrCount,
      avatar: snapshot.avatar, dialog: snapshot.dialog,
    };
  } finally {
    // 先离开页面（拆掉 WS），再关上下文；避免 WS 让 close 挂起
    await withTimeout(page.goto('about:blank', { timeout: 5000 }).catch(() => {}), 8000);
    await withTimeout(context.close().catch(() => {}), 10000);
    await withTimeout(browser.close().catch(() => {}), 10000, 'timeout');
    server.closeAllConnections();
    await withTimeout(new Promise(done => server.close(done)), 5000);
    log(`probe ${label} closed`);
  }
}

const reports = [];
try {
  reports.push(await probe(STRICT_CSP, 'A-strict-style-src-self'));
  reports.push(await probe(RELAXED_CSP, 'B-relaxed-unsafe-inline'));
} finally {
  await backend.app.close();
}

console.log('\n--- summary ---');
for (const report of reports) {
  console.log(`${report.label}\n  styleViolations=${report.styleViolations} scriptViolations=${report.scriptViolations} otherViolations=${report.otherViolations}\n` +
    `  styleAttrCount=${report.styleAttrCount} avatarBg=${report.avatar?.backgroundColor} avatarW=${report.avatar?.width} avatarRadius=${report.avatar?.borderRadius}\n` +
    `  dialogDisplay=${report.dialog?.display} dialogWidth=${report.dialog?.width}\n  failedRequests=${report.failedRequests.length}`);
}
for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}\t${item.name}`);
console.log(`\nassertions=${results.length} failures=${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
