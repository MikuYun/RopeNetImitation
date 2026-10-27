// 手机端「发送图片 / 发送文件」可见性回归（真 Chrome + 真后端）。
// 背景：ComposerToolbar.vue 的 @media(max-width:767px) 里 `.cbar__group{display:none}`
// 把右侧附件组（同样带 .cbar__group 类）一起隐藏了，手机上根本点不到图片/文件按钮。
// 本脚本逐档断言按钮可见、可点、能唤起文件选择器，并截图留证。
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:5174';
const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:3098';
const PASS = 'Passw0rd!123';
const RUN = Date.now().toString(36).slice(-6);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

const post = async (path, body, token) => {
  const res = await fetch(BACKEND + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// ---- 准备数据：两个好友 + 一条消息，保证有会话可打开 ----
const regA = await post('/api/v1/auth/register', { username: `cb_a_${RUN}`, password: PASS, displayName: '闸A' });
const regB = await post('/api/v1/auth/register', { username: `cb_b_${RUN}`, password: PASS, displayName: '闸B' });
if (regA.status !== 201 || regB.status !== 201) {
  console.log('准备数据失败', regA.status, regB.status, JSON.stringify(regA.data), JSON.stringify(regB.data));
  process.exit(1);
}
const aTok = regA.data.token;
const aId = regA.data.user.id;
const bId = regB.data.user.id;

const bTok = regB.data.token;
await post('/api/v1/friend-requests', { userId: bId, note: `hi-${RUN}` }, aTok);
const reqsRes = await fetch(`${BACKEND}/api/v1/friend-requests`, { headers: { Authorization: `Bearer ${bTok}` } });
const reqs = await reqsRes.json();
const rid = reqs.items?.[0]?.id;
await fetch(`${BACKEND}/api/v1/friend-requests/${rid}/respond`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bTok}` },
  body: JSON.stringify({ action: 'accept' }),
});
const conv = await post('/api/v1/conversations/direct', { userId: bId }, aTok);
const convId = conv.data?.id;
await post(`/api/v1/conversations/${convId}/messages`, { clientMsgId: randomUUID(), content: `手机端工具条检查 ${RUN}` }, aTok);

// ---- 真浏览器，逐视口断言 ----
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '320x568', width: 320, height: 568 },
];

for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('.field__input').first().fill(`cb_a_${RUN}`);
  await page.locator('input[type="password"], .field__input').nth(1).fill(PASS);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/chat/, { timeout: 20000 });

  // 直接深链进会话（手机端列表点击路径另有 e2e 覆盖）
  await page.goto(`${BASE}/chat/${convId}`, { waitUntil: 'networkidle' });
  await page.locator('.cbar').first().waitFor({ timeout: 15000 });

  const tag = `[${vp.name}]`;

  // 1. 三个右侧按钮都在且可见
  for (const [cls, label] of [
    ['.cbar__btn--image', '发送图片'],
    ['.cbar__btn--attach', '发送文件'],
    ['.cbar__btn--preview', '预览'],
  ]) {
    const loc = page.locator(cls).first();
    const visible = await loc.isVisible().catch(() => false);
    const box = await loc.boundingBox().catch(() => null);
    check(`${tag} ${label}按钮可见`, visible && !!box,
      `visible=${visible} box=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
    if (box) {
      check(`${tag} ${label}按钮热区 ≥44px`, box.width >= 43 && box.height >= 43,
        `${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }

  // 2. 命中点不被别的元素遮挡（elementFromPoint 必须落在这颗按钮里）
  for (const cls of ['.cbar__btn--image', '.cbar__btn--attach']) {
    const hit = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return { found: false };
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        found: true,
        covered: !(top === btn || btn.contains(top)),
        topEl: top ? `${top.tagName}.${top.className}`.slice(0, 60) : 'null',
      };
    }, cls);
    check(`${tag} ${cls} 命中点未被遮挡`, hit.found && !hit.covered, hit.topEl);
  }

  // 3. 点图片按钮能唤起 filechooser（accept 只图片）
  const imgPicker = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  await page.locator('.cbar__btn--image').first().click();
  const fc1 = await imgPicker;
  let imgAccept = '';
  if (fc1) {
    imgAccept = await fc1.element().getAttribute('accept').catch(() => '') ?? '';
  }
  check(`${tag} 点「发送图片」唤起文件选择器`, !!fc1, fc1 ? 'ok' : 'no filechooser');
  check(`${tag} 图片选择器 accept 只含图片`, /image\//.test(imgAccept) && !/pdf|zip|text/.test(imgAccept), `accept=${imgAccept}`);

  // 4. 点文件按钮同样能唤起，且 accept 不限（后端白名单负责）
  const filePicker = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  await page.locator('.cbar__btn--attach').first().click();
  const fc2 = await filePicker;
  const fileAccept = fc2 ? (await fc2.element().getAttribute('accept').catch(() => '')) ?? '' : '';
  check(`${tag} 点「发送文件」唤起文件选择器`, !!fc2, fc2 ? 'ok' : 'no filechooser');
  check(`${tag} 文件选择器 accept 不限图片`, fc2 ? !/^image\//.test(fileAccept) : false, `accept=${fileAccept || '(空=不限)'}`);

  // 5. 真正选一张图 → 出现待发送缩略图（证明整条链路可用，不只是按钮可点）
  if (fc1) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    await fc1.setFiles({ name: `cbar-${RUN}.png`, mimeType: 'image/png', buffer: png });
    const attOk = await page.locator('.composer__att').first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    check(`${tag} 选图后出现待发送附件`, attOk);
    // 缩略图是异步 fetch（带 Bearer 取 blob）后才挂上的，必须等它出现而不是立刻查
    const thumbOk = await page
      .locator('.composer__att-thumb')
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const thumbNatural = thumbOk
      ? await page.locator('.composer__att-thumb').first().evaluate((el) => ({
          w: el.naturalWidth,
          h: el.naturalHeight,
          blob: el.getAttribute('src')?.startsWith('blob:') ?? false,
        }))
      : null;
    check(`${tag} 待发送区显示缩略图`, thumbOk && !!thumbNatural?.blob, JSON.stringify(thumbNatural));
  }

  // 6. Aa 展开后格式按钮出现（确认修复没有把展开逻辑一起弄坏）
  await page.locator('.cbar__btn--toggle').first().click();
  await page.waitForTimeout(300);
  const boldVisible = await page.locator('.cbar__btn--bold').first().isVisible().catch(() => false);
  check(`${tag} 点 Aa 后格式按钮展开`, boldVisible);
  // 展开态下附件按钮**依然可见**（这是修复的关键回归点）
  const imgStillVisible = await page.locator('.cbar__btn--image').first().isVisible().catch(() => false);
  check(`${tag} 展开格式条后图片按钮仍可见`, imgStillVisible);
  // 工具条特写：收起态 / 展开态各一张，供人工目视复核
  await page.locator('.cbar').first().screenshot({ path: `B:/AITrance/docs/evidence/cbar-${vp.width}-expanded.png` });
  await page.locator('.cbar__btn--toggle').first().click();
  await page.waitForTimeout(300);
  await page.locator('.cbar').first().screenshot({ path: `B:/AITrance/docs/evidence/cbar-${vp.width}-collapsed.png` });

  await page.screenshot({ path: `B:/AITrance/docs/evidence/cbar-mobile-${vp.width}.png` });
  check(`${tag} 无 pageerror`, errs.length === 0, errs.slice(0, 2).join(' | '));

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length} 项 —— 通过 ${results.length - failed.length}，失败 ${failed.length} ===`);
if (failed.length) for (const f of failed) console.log(`FAILED: ${f.name} (${f.detail})`);
process.exitCode = failed.length ? 1 : 0;
