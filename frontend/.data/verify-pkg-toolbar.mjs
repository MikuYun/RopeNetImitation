// 发布包「手机端输入区工具栏」实测。
//
// 为什么这么写：本包声称「web/chat 已修好手机端没有发送图片/文件按钮」，
// 所以验证对象必须是**包内那份 web/chat 产物 + 包内后端 dist**，不是源码仓库。
// 用包内后端起 3302，再用一个照抄 backend/deploy/nginx-chat.conf 行为的小服务器
// （/chat/ 静态 + /chat/api/ 反代 + /chat 308 + 与 conf 逐字相同的 CSP）在 3301 提供站点，
// 最后用真 Chrome（channel:'chrome'）在 390x844 与 320x568 两个移动视口逐项断言。
import http from 'node:http';
import path from 'node:path';
import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const PKG = process.argv[2];
if (!PKG) {
  console.error('usage: node verify-pkg-toolbar.mjs <package-root>');
  process.exit(2);
}
const PKG_ROOT = path.resolve(PKG);
const WEB = path.join(PKG_ROOT, 'web', 'chat');
const BACKEND_DIR = path.join(PKG_ROOT, 'backend');
const WORK = path.join(PKG_ROOT, '..', 'verify-tmp');
const DB = path.join(WORK, 'chat.sqlite');
const SHOTS = 'B:/AITrance/docs/evidence';
const PORT = 3301;
const API_PORT = 3302;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

// 与 backend/deploy/nginx-chat.conf 的 /chat/ location 逐字一致
const CSP =
  "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self' ws: wss:";
const PERMISSIONS =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/chat\/?/, ''));
  let file = path.join(WEB, rel || 'index.html');
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    if (rel.includes('.') && !rel.endsWith('/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    file = path.join(WEB, 'index.html');
  }
  try {
    const buf = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': PERMISSIONS,
      'Content-Security-Policy': CSP,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}

function proxy(req, res) {
  const up = http.request(
    {
      host: '127.0.0.1',
      port: API_PORT,
      path: (req.url ?? '/').replace(/^\/chat/, ''),
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end('bad gateway');
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/chat/api/')) return proxy(req, res);
  if (url === '/chat') {
    res.writeHead(308, { Location: '/chat/' });
    return res.end();
  }
  return serveStatic(req, res, url.split('?')[0]);
});

async function waitOk(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return false;
}

const BASE = `http://127.0.0.1:${PORT}`;
const api = (p) => `${BASE}/chat/api/v1${p}`;
let backend;

try {
  // 干净库：避免上一轮残留用户/管理员污染断言
  await mkdir(WORK, { recursive: true });
  for (const s of ['', '-wal', '-shm']) await rm(DB + s, { force: true });

  backend = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: DB,
      UPLOADS_DIR: path.join(WORK, 'uploads'),
      DEFAULT_FRIEND_USERNAME: '',
      CORS_ORIGINS: `http://localhost:${PORT},http://127.0.0.1:${PORT}`,
      ADMIN_UID: '1001',
      ADMIN_INITIAL_PASSWORD: 'PkgChk!12345',
      LOG_LEVEL: 'warn',
    },
    stdio: 'inherit',
  });
  if (!(await waitOk(`http://127.0.0.1:${API_PORT}/health`))) throw new Error('包内后端未起来');
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  if (!(await waitOk(api('/health')))) throw new Error('前端反代不通');

  // ---- 1) 静态产物与生产头 ----
  const homeRes = await fetch(`${BASE}/chat/`);
  const homeHtml = await homeRes.text();
  check('包内 /chat/ 首页 200', homeRes.status === 200, `status=${homeRes.status}`);
  const scriptRef = (homeHtml.match(/\/chat\/assets\/index-[^"]+\.js/) ?? [''])[0];
  check('首页引用 /chat/assets/ 前缀资源', !!scriptRef, scriptRef);
  const csp = homeRes.headers.get('content-security-policy') ?? '';
  check('生产 CSP 已下发且 img-src 含 blob:', csp.includes("img-src 'self' data: blob:"), `${csp.length} 字节`);
  check('X-Frame-Options: DENY', homeRes.headers.get('x-frame-options') === 'DENY');
  const jsRes = await fetch(`${BASE}${scriptRef}`);
  check('JS 资源 MIME 不是 text/html', (jsRes.headers.get('content-type') ?? '').includes('javascript'), jsRes.headers.get('content-type') ?? '');

  // ---- 2) 包内后端真实接口造数据 ----
  const run = randomUUID().slice(0, 6);
  const regOne = await fetch(api('/auth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `pkga_${run}`, password: 'Passw0rd!123', displayName: '包验A' }),
  });
  const a = await regOne.json();
  check('包内后端可注册用户 A', regOne.status === 201, `status=${regOne.status} uid=${a?.user?.uid}`);

  const regTwo = await fetch(api('/auth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `pkgb_${run}`, password: 'Passw0rd!123', displayName: '包验B' }),
  });
  const b = await regTwo.json();
  const authA = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' };
  const authB = { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' };

  await fetch(api('/friend-requests'), {
    method: 'POST',
    headers: authA,
    body: JSON.stringify({ userId: b.user.id, note: `pkg-${run}` }),
  });
  const reqs = await (await fetch(api('/friend-requests'), { headers: authB })).json();
  const rid = reqs?.items?.[0]?.id;
  if (rid) {
    await fetch(api(`/friend-requests/${rid}/respond`), {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({ action: 'accept' }),
    });
  }
  const conv = await (
    await fetch(api('/conversations/direct'), {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ userId: b.user.id }),
    })
  ).json();
  check('包内后端可建私聊', !!conv?.id, conv?.id ?? JSON.stringify(conv));

  // ---- 3) 真 Chrome 两档移动视口 ----
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const VIEWPORTS = [
    { w: 390, h: 844 },
    { w: 320, h: 568 },
  ];
  for (const vp of VIEWPORTS) {
    const tag = `${vp.w}x${vp.h}`;
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));

    await page.goto(`${BASE}/chat/login`, { waitUntil: 'networkidle' });
    await page.locator('input').first().fill(`pkga_${run}`);
    await page.locator('input[type="password"]').first().fill('Passw0rd!123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // 注意：不能写 waitForURL(/\/chat/)，因为「/chat/login」本身就包含 /chat，
    // 会在登录还没完成时就当成成功（第一版就踩了这个，导致后面 .cbar 等不到）。
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30000 });
    await page.locator('.rail, .shell, .list').first().waitFor({ timeout: 30000 }).catch(() => {});
    check(`${tag} 包内前端登录成功`, true, page.url().replace(BASE, ''));

    await page.goto(`${BASE}/chat/chat/${conv.id}`, { waitUntil: 'networkidle' });
    await page.locator('.cbar').first().waitFor({ timeout: 30000 });
    check(`${tag} 会话页输入区可见`, await page.locator('.cbar').first().isVisible());

    for (const [sel, label] of [
      ['.cbar__btn--image', '发送图片'],
      ['.cbar__btn--attach', '发送文件'],
      ['.cbar__btn--preview', '预览'],
      ['.cbar__btn--toggle', 'Aa 折叠'],
    ]) {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      const box = await loc.boundingBox().catch(() => null);
      check(
        `${tag} 「${label}」可见且热区 ≥44`,
        visible && !!box && box.width >= 40 && box.height >= 40,
        box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'null',
      );
      if (!visible) continue;
      const hit = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return { ok: false, top: 'missing' };
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { ok: top === el || el.contains(top), top: top ? top.tagName : 'null' };
      }, sel);
      check(`${tag} 「${label}」中心点未被遮挡`, hit.ok, `top=${hit.top}`);
    }

    // 图片按钮 → 文件选择器，accept 只允许图片
    const fcImg = page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null);
    await page.locator('.cbar__btn--image').first().click();
    const chooserImg = await fcImg;
    check(`${tag} 点「发送图片」唤起文件选择器`, !!chooserImg);
    if (chooserImg) {
      const accept = await chooserImg.element().getAttribute('accept');
      check(`${tag} 图片选择器 accept 仅图片`, !!accept && accept.includes('image/'), accept ?? 'null');
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      );
      await chooserImg.setFiles({ name: `pkg-${run}.png`, mimeType: 'image/png', buffer: png });
      const thumbOk = await page
        .locator('.composer__att-thumb')
        .first()
        .waitFor({ timeout: 25000 })
        .then(() => true)
        .catch(() => false);
      const thumb = thumbOk
        ? await page
            .locator('.composer__att-thumb')
            .first()
            .evaluate((el) => ({
              w: el.naturalWidth,
              h: el.naturalHeight,
              blob: (el.getAttribute('src') ?? '').startsWith('blob:'),
            }))
        : null;
      check(
        `${tag} 选图后待发送缩略图（blob 且已解码）`,
        !!thumb && thumb.blob && thumb.w > 0,
        JSON.stringify(thumb),
      );
      // 清掉待发送区，避免影响下一个断言
      const removeBtn = page.locator('.composer__att-x').first();
      if (await removeBtn.isVisible().catch(() => false)) await removeBtn.click();
    }

    // 文件按钮 → 文件选择器，accept 不限
    const fcFile = page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null);
    await page.locator('.cbar__btn--attach').first().click();
    const chooserFile = await fcFile;
    check(`${tag} 点「发送文件」唤起文件选择器`, !!chooserFile);
    if (chooserFile) {
      const accept = await chooserFile.element().getAttribute('accept');
      check(`${tag} 文件选择器 accept 不受限`, !accept || !accept.includes('image/png'), accept ?? '(空=不限)');
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 点 Aa：格式按钮展开，且附件按钮仍可见（这是本次修复的关键回归点）
    await page.locator('.cbar__btn--toggle').first().click();
    await page.waitForTimeout(300);
    check(`${tag} 点 Aa 后格式按钮展开`, await page.locator('.cbar__btn--bold').first().isVisible().catch(() => false));
    check(
      `${tag} 展开格式条后图片按钮仍可见`,
      await page.locator('.cbar__btn--image').first().isVisible().catch(() => false),
    );
    await page.locator('.cbar').first().screenshot({ path: `${SHOTS}/pkg-${vp.w}-toolbar-expanded.png` });
    await page.screenshot({ path: `${SHOTS}/pkg-${vp.w}-chat.png` });

    await page.locator('.cbar__btn--toggle').first().click();
    await page.waitForTimeout(300);
    check(`${tag} 收起后仍只剩 Aa + 附件三键`, await page.locator('.cbar__btn--image').first().isVisible());
    await page.locator('.cbar').first().screenshot({ path: `${SHOTS}/pkg-${vp.w}-toolbar.png` });

    check(`${tag} 全程无 pageerror`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }
  await browser.close();
} catch (e) {
  console.error('FATAL:', e);
  results.push({ name: 'FATAL', ok: false, detail: String(e) });
} finally {
  server.close();
  if (backend) backend.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length} 项 —— 通过 ${results.length - failed.length}，失败 ${failed.length} ===`);
for (const f of failed) console.log(`FAILED: ${f.name}  —— ${f.detail}`);
process.exitCode = failed.length ? 1 : 0;
