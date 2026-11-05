import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CONTENT_SECURITY_POLICY,
  HSTS,
  PERMISSIONS_POLICY,
} from '../src/app.ts';
import { UPLOAD_BODY_LIMIT } from '../src/upload.ts';

/**
 * SEC-04 部署层漂移检测（后端常量 ↔ nginx 文档级响应头）。
 *
 * 为什么需要：生产形态下 HTML 文档由 nginx 提供，后端 onRequest 里下发的 CSP/HSTS
 * 只作用于 /api/*、/health、/openapi.json、/docs 这些由 Node 直接应答的响应，
 * 浏览器真正解析的文档头来自 backend/deploy/nginx-chat.conf 与 nginx-chat-https.conf。
 * 两处必须与 backend/src/app.ts 的常量**逐字一致**，否则 SEC-04 在生产上实际失效。
 *
 * 为什么放在 test/ 里却允许 skip：management/verify.mjs 会把 backend 快照到临时目录跑
 * `node --test dist/test/*.test.js`，而它的 capture 白名单是
 * ['src','test','scripts','package.json','package-lock.json','tsconfig.json','openapi.json']，
 * **不含 deploy/**。在快照里找不到 nginx 配置时本组用例跳过（不制造假红）；
 * 在真实仓库里 `npm test` 会完整执行，改了一边忘改另一边就红。
 */

function findBackendRoot(): string | null {
  // dist/test/deploy-headers.test.js → ../../ = backend；源码直跑 test/*.ts → ../ = backend。
  const candidates = [
    resolve(import.meta.dirname, '..'),
    resolve(import.meta.dirname, '..', '..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'deploy', 'nginx-chat.conf'))) return candidate;
  }
  return null;
}

const backendRoot = findBackendRoot();
const snapshotNote =
  'deploy/ 不在 management/verify.mjs 的 backend 快照白名单内，跳过漂移检测（真实仓库执行 npm test 时会校验）';

function readConf(name: string): string {
  return readFileSync(join(backendRoot as string, 'deploy', name), 'utf8');
}

function headerValues(conf: string, name: string): string[] {
  const pattern = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"\\s+always;`, 'g');
  return [...conf.matchAll(pattern)].map((match) => match[1] ?? '');
}

test('SEC-04 文档级 CSP 与后端常量逐字一致（两个 nginx 配置）', (t) => {
  // 这条不依赖 deploy/：常量本身不得被悄悄放宽。
  assert.equal(CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"), false, '业务 CSP 不得含 unsafe-inline');
  assert.equal(CONTENT_SECURITY_POLICY.includes("'unsafe-eval'"), false, '业务 CSP 不得含 unsafe-eval');
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self' ws: wss:$/);

  if (backendRoot === null) {
    t.skip(snapshotNote);
    return;
  }

  for (const name of ['nginx-chat.conf', 'nginx-chat-https.conf']) {
    const values = headerValues(readConf(name), 'Content-Security-Policy');
    assert.equal(values.length, 1, `${name} 应有且仅有一条文档级 CSP（多写/漏写都视为漂移）`);
    assert.equal(values[0], CONTENT_SECURITY_POLICY, `${name} 的 CSP 与 backend/src/app.ts 不一致`);
  }
});

test('SEC-04 HSTS 只在 HTTPS 配置下发，且与后端常量一致', (t) => {
  if (backendRoot === null) {
    t.skip(snapshotNote);
    return;
  }

  // HTTP 形态必须没有 HSTS：否则浏览器会把明文端口也强制升级，造成不可用。
  assert.deepEqual(headerValues(readConf('nginx-chat.conf'), 'Strict-Transport-Security'), []);

  const httpsValues = headerValues(readConf('nginx-chat-https.conf'), 'Strict-Transport-Security');
  assert.ok(httpsValues.length > 0, 'HTTPS 配置必须下发 HSTS');
  for (const value of httpsValues) {
    assert.equal(value, HSTS, 'HSTS 与 backend/src/app.ts 不一致');
  }
});

test('SEC-04 Permissions-Policy 与后端常量逐字一致（两个 nginx 配置）', (t) => {
  if (backendRoot === null) {
    t.skip(snapshotNote);
    return;
  }

  for (const name of ['nginx-chat.conf', 'nginx-chat-https.conf']) {
    const values = headerValues(readConf(name), 'Permissions-Policy');
    assert.equal(values.length, 1, `${name} 应有且仅有一条 Permissions-Policy`);
    assert.equal(values[0], PERMISSIONS_POLICY, `${name} 的 Permissions-Policy 与 backend/src/app.ts 不一致`);
  }
});

/**
 * 反代 body 上限必须大于应用层上传上限（UPLOAD_BODY_LIMIT = 51 MiB）。
 *
 * 为什么单独立一条：nginx 的 client_max_body_size 是**独立于代码的硬闸**，改了上传上限却忘了改它，
 * 生产上所有超过该值的图片/文件都会在反代层被 413，而响应体是 nginx 自己的 HTML，
 * 不是契约里的 {error:{code:'UPLOAD_TOO_LARGE',...}} —— 前端只能看到「上传失败」而拿不到错误码。
 * 这类漂移在本地 dev（不经 nginx）永远暴露不出来，只能靠静态比对拦住。
 */
test('上传：nginx client_max_body_size 必须大于应用层 UPLOAD_BODY_LIMIT', (t) => {
  if (backendRoot === null) {
    t.skip(snapshotNote);
    return;
  }

  /** '12m' / '11534336' / '12M' 等写法统一折算成字节；无法识别返回 null。 */
  function parseSize(raw: string): number | null {
    const text = raw.trim().toLowerCase();
    const match = /^(\d+)\s*([kmg]?)$/.exec(text);
    if (match === null) return null;
    const value = Number(match[1]);
    const unit = match[2] ?? '';
    const factor = unit === '' ? 1 : unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3;
    return value * factor;
  }

  for (const name of ['nginx-chat.conf', 'nginx-chat-https.conf']) {
    const conf = readConf(name);
    // 只校验 /chat/api/ 这一段：静态资源与 WS 的 location 不需要放宽 body 上限。
    const apiBlock = /location\s+\^~\s+\/chat\/api\/\s*\{([\s\S]*?)\n\s*\}/.exec(conf);
    assert.ok(apiBlock !== null, `${name} 应存在 location ^~ /chat/api/ 段`);
    const sizes = [...apiBlock[1]!.matchAll(/client_max_body_size\s+([^;]+);/g)]
      .map((match) => match[1]!.trim());
    assert.equal(sizes.length, 1, `${name} 的 /chat/api/ 应有且仅有一条 client_max_body_size`);
    const bytes = parseSize(sizes[0]!);
    assert.ok(bytes !== null, `${name} 的 client_max_body_size 取值无法解析：${sizes[0]}`);
    assert.ok(
      bytes > UPLOAD_BODY_LIMIT,
      `${name} 的 client_max_body_size(${sizes[0]}) 必须大于应用层 UPLOAD_BODY_LIMIT(${UPLOAD_BODY_LIMIT})，否则大文件上传会在反代层被 413 且错误体不合契约`,
    );
  }
});
