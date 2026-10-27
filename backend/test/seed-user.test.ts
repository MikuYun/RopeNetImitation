import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { ensureSeedUser, type SeedUserOptions } from '../src/bootstrap.ts';
import { loadSeedUser } from '../src/config.ts';
import { Store } from '../src/db.ts';

/*
 * 需求 8：新库首启就存在两个账号 —— 管理员 root / 12345678 与初始普通用户 qjq / 柒玖柒 / A454545asd@，
 * 之后注册的新用户自动与该普通用户成为好友（后者复用既有的 DEFAULT_FRIEND_USERNAME 机制）。
 *
 * 这里分两层验证：
 * 1. loadSeedUser 的解析与校验（纯函数，直接传 env 对象，不改 process.env）；
 * 2. ensureSeedUser 的落库语义（幂等、不覆盖已有密码、不把已存在的管理员降级）与 buildApp 的接线。
 */

type Context = Awaited<ReturnType<typeof buildApp>>;

const SEED: SeedUserOptions = {
  uid: 10001,
  username: 'qjq',
  displayName: '柒玖柒',
  initialPassword: 'A454545asd@',
};

async function call(backend: Context, method: 'GET' | 'POST', url: string, token?: string, payload?: object) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

async function login(backend: Context, username: string, password: string) {
  return call(backend, 'POST', '/api/v1/auth/login', undefined, { username, password });
}

test('loadSeedUser：缺省值就是需求里的 qjq / 柒玖柒 / A454545asd@，uid 10001', () => {
  const config = loadSeedUser({});
  assert.deepEqual(config, {
    uid: 10001,
    username: 'qjq',
    displayName: '柒玖柒',
    initialPassword: 'A454545asd@',
  });
  // 显式写了账号名也仍然转小写，登录侧按 COLLATE NOCASE 匹配，大小写不敏感。
  assert.equal(loadSeedUser({ SEED_USER_USERNAME: 'QJQ' })?.username, 'qjq');
});

test('loadSeedUser：SEED_USER_USERNAME 置空即整体关闭（测试与嵌入用法靠它保持旧假设）', () => {
  assert.equal(loadSeedUser({ SEED_USER_USERNAME: '' }), null);
  assert.equal(loadSeedUser({ SEED_USER_USERNAME: '   ' }), null);
  // 关闭时其它项即使非法也不该再被校验：先判关闭、后解析，避免「关掉了还报密码太短」。
  assert.equal(loadSeedUser({ SEED_USER_USERNAME: '', SEED_USER_UID: 'abc' }), null);
});

test('loadSeedUser：四项任一非法都必须报错，且错误信息点明是哪个变量', () => {
  assert.throws(() => loadSeedUser({ SEED_USER_USERNAME: 'q' }), /SEED_USER_USERNAME/);
  assert.throws(() => loadSeedUser({ SEED_USER_USERNAME: '柒玖柒' }), /SEED_USER_USERNAME/);
  // 普通用户 uid 段位是 10001 起：10000 及以下留给管理员与历史兼容数据。
  assert.throws(() => loadSeedUser({ SEED_USER_UID: '10000' }), /SEED_USER_UID/);
  assert.throws(() => loadSeedUser({ SEED_USER_UID: '1001.5' }), /SEED_USER_UID/);
  assert.throws(() => loadSeedUser({ SEED_USER_UID: 'x' }), /SEED_USER_UID/);
  assert.throws(() => loadSeedUser({ SEED_USER_DISPLAY_NAME: '' }), /SEED_USER_DISPLAY_NAME/);
  assert.throws(() => loadSeedUser({ SEED_USER_DISPLAY_NAME: 'x'.repeat(41) }), /SEED_USER_DISPLAY_NAME/);
  assert.throws(() => loadSeedUser({ SEED_USER_INITIAL_PASSWORD: 'short' }), /SEED_USER_INITIAL_PASSWORD/);
  assert.throws(() => loadSeedUser({ SEED_USER_INITIAL_PASSWORD: 'x'.repeat(129) }), /SEED_USER_INITIAL_PASSWORD/);
});

test('ensureSeedUser：首次建号是普通用户，重复调用幂等且不覆盖密码', async () => {
  const store = new Store(':memory:');
  try {
    const first = await ensureSeedUser(store, SEED);
    assert.deepEqual(first, { seedUser: 'created', username: 'qjq' });

    const row = store.get<{ uid: number; username: string; display_name: string; role: string; status: string }>(
      'SELECT uid, username, display_name, role, status FROM users WHERE username = ?', 'qjq');
    assert.ok(row);
    assert.equal(row.uid, 10001);
    assert.equal(row.display_name, '柒玖柒');
    assert.equal(row.role, 'user', '初始普通用户不能被建成管理员');
    assert.equal(row.status, 'active');

    const originalHash = store.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = ?', 'qjq')!.password_hash;

    // 第二次带一个不同的初始密码：已经存在就必须完全不动（这正是「以后改了配置不该重置现场密码」）。
    const second = await ensureSeedUser(store, { ...SEED, initialPassword: 'AnotherPass!9' });
    assert.deepEqual(second, { seedUser: 'exists', username: 'qjq' });
    assert.equal(store.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = ?', 'qjq')!.password_hash, originalHash);
    assert.equal(store.get<{ total: number }>('SELECT COUNT(*) AS total FROM users')!.total, 1);
  } finally {
    store.close();
  }
});

test('ensureSeedUser：已存在的同账号不会被降级，只在 uid 缺失时补号', async () => {
  const store = new Store(':memory:');
  try {
    // 模拟「历史库里有 qjq 且已被提升为管理员、uid 还没分配」的中途状态。
    store.run(`INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at)
      VALUES ('legacy-qjq', NULL, 'QJQ', '柒玖柒', 'x:y', 'admin', 'active', ?)`, new Date().toISOString());

    const report = await ensureSeedUser(store, SEED);
    assert.deepEqual(report, { seedUser: 'exists', username: 'QJQ' });
    const row = store.get<{ uid: number | null; role: string }>(
      'SELECT uid, role FROM users WHERE id = ?', 'legacy-qjq')!;
    assert.equal(row.uid, 10001, 'uid 为空时补上 seedUid，否则该账号无法用数字登录');
    assert.equal(row.role, 'admin', '预置用户引导不能把已有的管理员降级为普通用户');
  } finally {
    store.close();
  }
});

test('ensureSeedUser：uid 被他人占用时顺延分配，不覆盖那行也不抢号', async () => {
  const store = new Store(':memory:');
  try {
    store.run(`INSERT INTO users(id, uid, username, display_name, password_hash, role, status, created_at)
      VALUES ('other', 10001, 'alice', 'Alice', 'x:y', 'user', 'active', ?)`, new Date().toISOString());
    const report = await ensureSeedUser(store, SEED);
    // 账号锚点是 username：qjq 必须建出来（否则 DEFAULT_FRIEND_USERNAME 会 fail-closed 让注册全废），
    // 只是不能占用已经被 alice 拿走的 10001 —— 否则「按 uid 登录」会进错账号。
    assert.equal(report.seedUser, 'created');
    assert.equal(store.get<{ total: number }>('SELECT COUNT(*) AS total FROM users')!.total, 2);
    assert.equal(store.get<{ uid: number }>('SELECT uid FROM users WHERE id = ?', 'other')!.uid, 10001);
    assert.equal(store.get<{ uid: number }>('SELECT uid FROM users WHERE username = ?', 'qjq')!.uid, 10002);
  } finally {
    store.close();
  }
});

test('buildApp：默认配置首启即建出 qjq，可用 QJQ / A454545asd@ 登录', async context => {
  // 不传 seedUser 覆盖 ⇒ 用 loadSeedUser() 的缺省值，即真实默认部署行为。
  const backend = await buildApp({ databasePath: ':memory:', logger: false, defaultFriendUsername: 'qjq' });
  context.after(() => backend.app.close());

  const users = backend.store.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM users WHERE username <> 'root'")!;
  assert.equal(users.total, 1, '新库里除管理员外应当正好有这一个预置普通用户');

  const seed = backend.store.get<{ uid: number; username: string; display_name: string; role: string }>(
    "SELECT uid, username, display_name, role FROM users WHERE username = 'qjq'")!;
  assert.equal(seed.uid, 10001);
  assert.equal(seed.display_name, '柒玖柒');
  assert.equal(seed.role, 'user');

  // 登录名大小写不敏感：需求里写的是大写 QJQ，落库是 qjq。
  const response = await login(backend, 'QJQ', 'A454545asd@');
  assert.equal(response.statusCode, 200, response.body);
  const session = response.json<{ user: { id: string; username: string; role: string; uid: number } }>();
  assert.equal(session.user.username, 'qjq');
  assert.equal(session.user.role, 'user');
  assert.equal(session.user.uid, 10001);

  // 数字 uid 也能登录（与既有 ux2 契约一致）。
  const byUid = await login(backend, '10001', 'A454545asd@');
  assert.equal(byUid.statusCode, 200, byUid.body);
});

test('buildApp：新注册用户自动与预置的 qjq 成为好友（互相关注、无待处理申请）', async context => {
  const backend = await buildApp({ databasePath: ':memory:', logger: false, defaultFriendUsername: 'qjq' });
  context.after(() => backend.app.close());

  const created = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username: 'newcomer', displayName: '新来的', password: 'correct-password-123' });
  assert.equal(created.statusCode, 201, created.body);
  const token = created.json<{ token: string }>().token;

  const friends = await call(backend, 'GET', '/api/v1/friends', token);
  assert.equal(friends.statusCode, 200, friends.body);
  const list = friends.json<{ items: { username: string }[] }>().items;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.username, 'qjq');

  // 朋友关系是双向的，因此 qjq 侧也应当看到这个新用户（管理员不会自动成为谁的好友）。
  type FriendList = { items: { username: string }[] };
  const seedSession = await login(backend, 'qjq', 'A454545asd@');
  const seedToken = seedSession.json<{ token: string }>().token;
  const reverse = await call(backend, 'GET', '/api/v1/friends', seedToken);
  const reverseList = reverse.json<FriendList>().items;
  assert.equal(reverseList.length, 1);
  assert.equal(reverseList[0]!.username, 'newcomer');

  // 自动加好友走的是「已接受」的申请，不该在上报留一条待处理。
  const pending = await call(backend, 'GET', '/api/v1/friend-requests?status=pending', token);
  assert.equal(pending.json<{ items: unknown[] }>().items.length, 0);
});

test('buildApp：seedUser: null 时回到「库里只有管理员」的旧语义', async context => {
  const backend = await buildApp({ databasePath: ':memory:', logger: false, seedUser: null });
  context.after(() => backend.app.close());
  assert.equal(backend.store.get<{ total: number }>(
    "SELECT COUNT(*) AS total FROM users WHERE role <> 'admin'")!.total, 0);
  const response = await login(backend, 'qjq', 'A454545asd@');
  assert.equal(response.statusCode, 401);
});
