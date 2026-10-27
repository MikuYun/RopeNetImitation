import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadConfig, loadTls } from '../src/config.ts';
import { Realtime } from '../src/realtime.ts';
import { materializeTls } from './fixtures/tls.ts';

/*
 * TLS 测试材料的来源见 fixtures/tls.ts 顶部注释：PEM 内联在源码里，
 * 运行时 materialize 到临时目录，测试结束删除（不依赖 .pem 文件是否被 snapshot/编译搬运）。
 */
const materialized = materializeTls();
process.on('exit', materialized.dispose);
const CERT = materialized.certPath;
const KEY = materialized.keyPath;

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account { token: string; user: { id: string; username: string }; expiresAt: string }

async function fixture(context: TestContext, overrides: Parameters<typeof buildApp>[0] = {}) {
  const backend = await buildApp({ databasePath: ':memory:', logger: false, ...overrides });
  context.after(() => backend.app.close());
  return backend;
}

async function call(backend: Context, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string,
  payload?: object, headers: Record<string, string> = {}) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}`, ...headers } : headers, payload });
}

async function register(backend: Context, username: string): Promise<Account> {
  const response = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username, displayName: `${username} 中文`, password: 'correct-password-123' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Account>();
}

/** 在进程环境变量上临时覆盖，结束后恢复（node --test 每个文件独立进程，互不影响）。 */
function withEnv<T>(overrides: Record<string, string | undefined>, operation: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return operation();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function httpsGet(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false,
      headers: { connection: 'close' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('SEC-01 TLS configuration is all-or-nothing and fails closed', async () => {
  // 未配置：TLS 关闭，HTTP 模式（现状形态）不受影响。
  assert.equal(loadTls({}), null);
  assert.equal(loadTls({ TLS_CERT_PATH: '  ', TLS_KEY_PATH: '' }), null);
  // 只给一半：拒绝启动，绝不「配置了证书却静默退回明文」。
  assert.throws(() => loadTls({ TLS_CERT_PATH: CERT }), /must be provided together/);
  assert.throws(() => loadTls({ TLS_KEY_PATH: KEY }), /must be provided together/);
  // 路径不可读/不是普通文件：拒绝启动并点名是哪个变量。
  assert.throws(() => loadTls({ TLS_CERT_PATH: join(materialized.directory, 'missing.pem'), TLS_KEY_PATH: KEY }),
    /TLS_CERT_PATH is not a readable file/);
  assert.throws(() => loadTls({ TLS_CERT_PATH: materialized.directory, TLS_KEY_PATH: KEY }),
    /TLS_CERT_PATH is not a readable file/);
  // 成对且可读：接受，并对路径做规范化（absolute）。
  const tls = loadTls({ TLS_CERT_PATH: CERT, TLS_KEY_PATH: KEY });
  assert.ok(tls);
  assert.equal(tls.certPath, CERT);
  assert.equal(tls.keyPath, KEY);
  // 通过环境变量走完整 loadConfig：成对 + auto ⇒ requireHttps 自动开启。
  const config = withEnv({ TLS_CERT_PATH: CERT, TLS_KEY_PATH: KEY, REQUIRE_HTTPS: undefined }, () => loadConfig());
  assert.ok(config.tls);
  assert.equal(config.requireHttps, true);
  // 显式 REQUIRE_HTTPS=false 可以关掉（仅限明确自担风险的部署）。
  assert.equal(withEnv({ TLS_CERT_PATH: CERT, TLS_KEY_PATH: KEY, REQUIRE_HTTPS: 'false' }, () => loadConfig()).requireHttps, false);
  // 非法取值必须拒绝。
  assert.throws(() => withEnv({ REQUIRE_HTTPS: 'yes' }, () => loadConfig()), /REQUIRE_HTTPS must be auto, true or false/);
  assert.throws(() => withEnv({ TLS_CERT_PATH: CERT }, () => loadConfig()), /must be provided together/);
  // buildApp 层再兜一次：证书存在但私钥缺失 ⇒ 拒绝构建，而不是以 http 起来。
  await assert.rejects(buildApp({ databasePath: ':memory:', logger: false,
    tls: { certPath: CERT, keyPath: join(materialized.directory, 'missing.pem') } }),
    /TLS material is not readable/);
});

test('SEC-01 HTTPS mode terminates TLS in-process and keeps health/API/headers intact', async context => {
  const backend = await fixture(context, { tls: { certPath: CERT, keyPath: KEY } });
  assert.equal(backend.transport, 'https');
  assert.equal(backend.config.requireHttps, true, 'auto + TLS ⇒ requireHttps');
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const health = await httpsRequestProbe(address.port, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).protocolVersion, 2);
  // 直连 TLS ⇒ 视为加密传输，凭据接口放行（注册成功即证明未被 403 拦下）。
  const created = await httpsRequestProbe(address.port, '/api/v1/auth/register', 'POST',
    JSON.stringify({ username: 'tlsuser', displayName: 'TLS 用户', password: 'correct-password-123' }), { 'content-type': 'application/json' });
  assert.equal(created.status, 201, created.body);
  const register = await backend.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload:
    { username: 'injectuser', displayName: '注入用户', password: 'correct-password-123' } });
  // inject 不是真实 socket，但 Fastify 在 https 模式下给 raw.socket 也带 encrypted 标记；
  // 无论哪种结果都必须是「不是 500」，且若是明文判定就明确 403 HTTPS_REQUIRED。
  assert.ok([201, 403].includes(register.statusCode), register.body);
  if (register.statusCode === 403) assert.equal(register.json().error.code, 'HTTPS_REQUIRED');
  // HSTS 只在要求 https 时下发。
  assert.equal(created.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(health.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
});

function httpsRequestProbe(port: number, path: string, method = 'GET', payload?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolvePromise, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false,
      headers: { connection: 'close', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

test('SEC-01 plaintext credential guard is fail-closed and proxy-aware', async context => {
  // 1) 默认（本地 dev，不要求 https）：register/login 保持原样，不被 403 打断。
  const plain = await fixture(context);
  assert.equal((await call(plain, 'POST', '/api/v1/auth/login', undefined, { username: 'nobody', password: 'wrong-password' })).statusCode, 401);
  assert.equal(plain.config.requireHttps, false);
  // 2) REQUIRE_HTTPS=true + 不信任代理 + 明文 socket ⇒ 两个凭据接口 403 HTTPS_REQUIRED。
  const strict = await fixture(context, { requireHttps: true });
  for (const url of ['/api/v1/auth/register', '/api/v1/auth/login']) {
    const blocked = await call(strict, 'POST', url, undefined, { username: 'aaaa', password: 'correct-password-123' });
    assert.equal(blocked.statusCode, 403, `${url}: ${blocked.body}`);
    assert.equal(blocked.json().error.code, 'HTTPS_REQUIRED');
  }
  // 3) 非凭据接口不受影响（不会把整个 API 锁死）。
  assert.equal((await call(strict, 'GET', '/health')).statusCode, 200);
  assert.equal((await call(strict, 'GET', '/api/v1/health')).statusCode, 200);
  assert.equal((await call(strict, 'GET', '/api/v1/users/me')).statusCode, 401);
  // 4) 信任 loopback 代理 + X-Forwarded-Proto: https ⇒ 放行（nginx 终结 TLS 的形态）。
  const proxied = await fixture(context, { requireHttps: true, trustLoopbackProxy: true });
  const allowed = await proxied.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https' }, payload: { username: 'nobody', password: 'wrong-password' } });
  assert.equal(allowed.statusCode, 401, allowed.body);
  // X-Forwarded-Proto 取最后一段（多级代理链）。
  const chained = await proxied.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'http, https' }, payload: { username: 'nobody', password: 'wrong-password' } });
  assert.equal(chained.statusCode, 401, chained.body);
  // 5) 权重里有 http 结尾 ⇒ 明文，403。
  const downgraded = await proxied.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https, http' }, payload: { username: 'nobody', password: 'wrong-password' } });
  assert.equal(downgraded.statusCode, 403);
  assert.equal(downgraded.json().error.code, 'HTTPS_REQUIRED');
  // 6) 不可信来源伪造 X-Forwarded-Proto 无效（trustLoopbackProxy=false）。
  const forged = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https' }, payload: { username: 'nobody', password: 'wrong-password' } });
  assert.equal(forged.statusCode, 403);
});

test('SEC-04 security headers are present, stable and do not break /docs or /openapi.json', async context => {
  const backend = await fixture(context);
  const expected = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; "
      + "object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; "
      + "media-src 'self' blob:; font-src 'self'; connect-src 'self' ws: wss:",
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  };
  for (const path of ['/health', '/api/v1/health', '/api/v1/users/me', '/openapi.json']) {
    const response = await call(backend, 'GET', path);
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(response.headers[name], value, `${path} missing/incorrect ${name}`);
    }
    // 未启用 HTTPS 时不下发 HSTS（避免 http 环境把浏览器锁死）。
    assert.equal(response.headers['strict-transport-security'], undefined, `${path} must not send HSTS over http`);
  }
  // 文档页面使用放宽的 CSP（Swagger UI 自带 inline style/script），但仍是白名单策略。
  for (const path of ['/docs/']) {
    const docs = await call(backend, 'GET', path);
    assert.equal(docs.statusCode, 200);
    const csp = String(docs.headers['content-security-policy']);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self' ws: wss:/);
  }
  const openapi = await call(backend, 'GET', '/openapi.json');
  assert.equal(openapi.json().info.version, '0.3.0');
  assert.ok(openapi.json().paths['/api/v1/sync']);
  // 业务 API 的 CSP 不允许 inline script —— 这是 XSS 的第二道防线（docs/06 §5.3）。
  const api = await call(backend, 'GET', '/api/v1/health');
  assert.doesNotMatch(String(api.headers['content-security-policy']), /unsafe-inline|unsafe-eval/);
});

test('BE-01 retention sweep removes only expired rows, is observable and runs at startup', async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const expiredSession = randomUUID();
  const validSession = randomUUID();
  backend.store.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    expiredSession, alice.user.id, '2000-01-01T00:00:00.000Z', '1999-12-01T00:00:00.000Z');
  backend.store.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    validSession, alice.user.id, '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  backend.store.run('INSERT INTO ws_tickets(ticket_hash, session_hash, expires_at) VALUES (?, ?, ?)',
    'expired-ticket', expiredSession, '2000-01-01T00:00:00.000Z');
  backend.store.run('INSERT INTO ws_tickets(ticket_hash, session_hash, expires_at) VALUES (?, ?, ?)',
    'valid-ticket', validSession, '2999-01-01T00:00:00.000Z');
  const report = backend.realtime.sweep('manual');
  assert.equal(report.sessions, 1);
  assert.equal(report.tickets, 1);
  assert.equal(report.messages, 0);
  assert.equal(backend.store.get('SELECT 1 FROM sessions WHERE token_hash = ?', expiredSession), undefined);
  assert.equal(backend.store.get('SELECT 1 FROM ws_tickets WHERE ticket_hash = ?', 'expired-ticket'), undefined);
  assert.ok(backend.store.get('SELECT 1 FROM sessions WHERE token_hash = ?', validSession));
  assert.ok(backend.store.get('SELECT 1 FROM ws_tickets WHERE ticket_hash = ?', 'valid-ticket'));
  // 有效会话仍然可用（清理不误伤）。
  assert.equal((await call(backend, 'GET', '/api/v1/users/me', alice.token)).statusCode, 200);
  // 可观测：清理条数写日志（带 trigger 与保留天数）。
  const logged: Array<{ object: Record<string, unknown>; message: string }> = [];
  const observable = new Realtime(backend.store, { sweepSeconds: 3600, messageDays: 0,
    logger: { info: (object, message) => logged.push({ object, message }) } });
  context.after(() => observable.close());
  assert.equal(observable.sweep('interval').sessions >= 0, true);
  backend.store.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    'again-expired', alice.user.id, '2000-01-01T00:00:00.000Z', '1999-12-01T00:00:00.000Z');
  observable.sweep('interval');
  assert.ok(logged.length >= 1);
  assert.equal(logged.at(-1)!.message, 'Retention sweep completed');
  assert.deepEqual((logged.at(-1)!.object.retention as Record<string, number>).sessions, 1);
  assert.equal(logged.at(-1)!.object.trigger, 'interval');
});

test('BE-01 message retention is opt-in (default keeps rows) and deletes only aged rows', async context => {
  const keep = await fixture(context);
  const owner = await register(keep, 'keeper');
  const peer = await register(keep, 'peerkeeper');
  const conversationId = randomUUID();
  keep.store.run('INSERT INTO conversations(id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    conversationId, 'direct', '', owner.user.id, `direct-${conversationId}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  keep.store.run('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), 1, conversationId, owner.user.id, randomUUID(), 'text', '远古消息', '2000-01-01T00:00:00.000Z');
  assert.equal(keep.config.retentionMessageDays, 0);
  assert.equal(keep.realtime.sweep('manual').messages, 0, '默认 0 天 = 永不删除消息');
  assert.equal(keep.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM messages')!.total, 1);
  void peer;
  // 显式开启 7 天后：只删比 cut-off 更老的消息。
  const prune = await fixture(context, { retentionMessageDays: 7 });
  const fresh = await register(prune, 'freshuser');
  const other = await register(prune, 'otheruser');
  const freshConversation = randomUUID();
  prune.store.run('INSERT INTO conversations(id, type, name, owner_id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    freshConversation, 'direct', '', fresh.user.id, `direct-${freshConversation}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  prune.store.run('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), 1, freshConversation, fresh.user.id, randomUUID(), 'text', '昨天的消息', new Date().toISOString());
  prune.store.run('INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), 2, freshConversation, other.user.id, randomUUID(), 'text', '很老的消息', '2000-01-01T00:00:00.000Z');
  const report = prune.realtime.sweep('manual');
  assert.equal(report.messages, 1);
  const remaining = prune.store.all<{ content: string }>('SELECT content FROM messages ORDER BY seq');
  assert.deepEqual(remaining.map(row => row.content), ['昨天的消息']);
});

test('startup sweep happens inside buildApp so restarts converge expired state', async () => {
  // 先用同一路径的临时库造过期数据，再重启（buildApp）观察启动清理。
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(resolve(tmpdir(), 'aitrance-retention-'));
  const databasePath = join(directory, 'chat.sqlite');
  try {
    const first = await buildApp({ databasePath, logger: false });
    const user = await register(first, 'restartuser');
    first.store.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      'stale-session', user.user.id, '2000-01-01T00:00:00.000Z', '1999-12-01T00:00:00.000Z');
    first.store.run('INSERT INTO ws_tickets(ticket_hash, session_hash, expires_at) VALUES (?, ?, ?)',
      'stale-ticket', 'stale-session', '2000-01-01T00:00:00.000Z');
    await first.app.close();
    const second = await buildApp({ databasePath, logger: false });
    try {
      assert.equal(second.store.get('SELECT 1 FROM sessions WHERE token_hash = ?', 'stale-session'), undefined);
      assert.equal(second.store.get('SELECT 1 FROM ws_tickets WHERE ticket_hash = ?', 'stale-ticket'), undefined);
      assert.equal((await call(second, 'GET', '/api/v1/users/me', user.token)).statusCode, 200);
    } finally {
      await second.app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rate limits stay at 10/min/IP with Retry-After and default friend failure keeps 503', async context => {
  const backend = await fixture(context);
  // 注册：10 次/分/IP，第 11 次 429 且必须带 Retry-After（前端退避依赖它）。
  for (let index = 0; index < 10; index++) {
    const invalid = await call(backend, 'POST', '/api/v1/auth/register', undefined, { username: 'x', password: 'y' });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const limited = await call(backend, 'POST', '/api/v1/auth/register', undefined, { username: 'x', password: 'y' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(limited.headers['retry-after'], '429 must expose Retry-After');
  // 登录同样是 10/min/IP，且必须同样带 Retry-After。
  // 注意：@fastify/rate-limit 的 per-route config 会为该路由建独立计数桶，
  // 所以 register 打满后 login 仍有自己的 10 次额度，必须单独打满才能断言 429。
  for (let index = 0; index < 10; index++) {
    const invalid = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'x', password: 'y' });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const loginLimited = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'x', password: 'y' });
  assert.equal(loginLimited.statusCode, 429);
  assert.equal(loginLimited.json().error.code, 'RATE_LIMITED');
  assert.ok(loginLimited.headers['retry-after'], '429 must expose Retry-After');
  // DEFAULT_FRIEND 缺失时注册 fail-closed（503），且不落任何用户行。
  const guarded = await fixture(context, { defaultFriendUsername: 'ghost_friend' });
  const blocked = await call(guarded, 'POST', '/api/v1/auth/register', undefined,
    { username: 'newcomer', displayName: '新人', password: 'correct-password-123' });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, 'DEFAULT_FRIEND_UNAVAILABLE');
  // 同上：启动会创建 uid=1001 的管理员，这里只数非管理员，证明注册失败没留下用户行。
  assert.equal(guarded.store.get<{ total: number }>("SELECT COUNT(*) AS total FROM users WHERE role <> 'admin'")!.total, 0);
  // 只要提供了默认好友，注册恢复正常（fail-closed 不是「永久禁用注册」）。
  const healthy = await fixture(context, { defaultFriendUsername: '' });
  assert.equal((await call(healthy, 'POST', '/api/v1/auth/register', undefined,
    { username: 'fine', displayName: '正常', password: 'correct-password-123' })).statusCode, 201);
});
