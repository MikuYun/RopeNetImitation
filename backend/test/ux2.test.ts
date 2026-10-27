import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { hashPassword } from '../src/security.ts';

/**
 * 第二轮体验改造（契约 docs/contract/ux2-contract.md v0.3.0）的后端行为测试。
 *
 * 这里刻意沿用 chat/uploads 两个测试文件的 helper 风格（app.inject + 真实 WebSocket），
 * 不引入任何测试框架依赖：`npm test` 就是 `node --test dist/test/*.test.js`。
 */

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account {
  token: string;
  expiresAt: string;
  user: { id: string; uid: number; username: string; role: string; status: string; mutedUntil: string | null };
}

/** 测试里固定管理员初始密码，不依赖环境变量，保证 CI 与本地行为一致。 */
const ADMIN_PASSWORD = 'test-admin-password-1';

/** 最小合法 1x1 透明 PNG（真实字节，魔数嗅探必须靠它命中 image/png）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 每个用例一套独立的上传目录 + 内存库。
 * uploadsDir 必须显式给：默认值会落到进程 cwd 下的 .data/uploads，测试之间会互相污染。
 */
async function fixture(context: TestContext) {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'aitrance-ux2-'));
  const backend = await buildApp({
    databasePath: ':memory:', uploadsDir, logger: false,
    adminUid: 1001, adminInitialPassword: ADMIN_PASSWORD,
  });
  // after 钩子按注册顺序执行：先关 app 再删目录，否则关停过程会写到已删除的目录（Windows 上表现为 EBUSY）。
  context.after(() => backend.app.close());
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  return { backend, uploadsDir };
}

async function call(backend: Context, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

async function register(backend: Context, username: string): Promise<Account> {
  const response = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username, displayName: `${username} 中文`, password: 'correct-password-123' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Account>();
}

async function login(backend: Context, identifier: string, password: string): Promise<Account> {
  const response = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: identifier, password });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Account>();
}

async function adminLogin(backend: Context): Promise<Account> {
  return login(backend, '1001', ADMIN_PASSWORD);
}

async function makeFriends(backend: Context, sender: Account, recipient: Account): Promise<void> {
  const created = await call(backend, 'POST', '/api/v1/friend-requests', sender.token, { userId: recipient.user.id });
  // 已经是好友就直接复用：同一个用例里可能多次要求「确保是好友」。
  if (created.statusCode === 409 && created.json().error.code === 'ALREADY_FRIENDS') return;
  assert.equal(created.statusCode, 201, created.body);
  const accepted = await call(backend, 'POST', `/api/v1/friend-requests/${created.json().id}/respond`, recipient.token, { action: 'accept' });
  assert.equal(accepted.statusCode, 200, accepted.body);
}

async function direct(backend: Context, sender: Account, recipient: Account): Promise<string> {
  await makeFriends(backend, sender, recipient);
  const response = await call(backend, 'POST', '/api/v1/conversations/direct', sender.token, { userId: recipient.user.id });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().id;
}

async function group(backend: Context, owner: Account, members: Account[], name = '测试群'): Promise<string> {
  // 建群要求被邀请的人都是群主的好友，否则服务端直接 403 FRIEND_REQUIRED。
  for (const member of members) await makeFriends(backend, owner, member);
  const response = await call(backend, 'POST', '/api/v1/conversations/group', owner.token,
    { name, memberIds: members.map(member => member.user.id) });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

/** 上传裸二进制，返回 201 的响应体（含 id / url）。 */
async function upload(backend: Context, token: string, bytes: Buffer, filename = 'a.png') {
  const response = await backend.app.inject({
    method: 'POST', url: `/api/v1/uploads?filename=${encodeURIComponent(filename)}`,
    headers: { authorization: `Bearer ${token}` }, payload: bytes,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ id: string; kind: string; url: string; sha256: string }>();
}

/** 会话里序号最大的那条消息（用来断言「系统提示确实写进去了」）。 */
function lastMessageContent(backend: Context, conversationId: string): string {
  return backend.store.get<{ content: string }>(
    'SELECT content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1', conversationId)!.content;
}

interface EventFrame { v: number; type: string; timestamp: string; data: Record<string, any> }

function connect(url: string) {
  const socket = new WebSocket(url, { origin: 'http://localhost:5173' });
  const events: EventFrame[] = [];
  const errors: Error[] = [];
  socket.on('message', data => events.push(JSON.parse(data.toString()) as EventFrame));
  socket.on('error', error => errors.push(error));
  const closed = new Promise<number>(resolveClose => socket.on('close', code => resolveClose(code)));
  async function waitFor(type: string): Promise<EventFrame> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (errors.length) throw errors[0];
      const event = events.find(item => item.type === type);
      if (event) return event;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    throw new Error(`Missing event ${type}: ${JSON.stringify(events)}`);
  }
  return { socket, events, waitFor, closed };
}

test('账号：uid 分配与数字登录、禁言拦截、封禁拦截', async context => {
  const { backend } = await fixture(context);
  // 管理员在 buildApp 里就绪：uid=1001、role=admin、status=active（契约 §三）。
  const admin = await adminLogin(backend);
  assert.equal(admin.user.uid, 1001);
  assert.equal(admin.user.role, 'admin');

  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  // 普通用户从 10001 起顺次分配，与管理员段（1000..9999）不重叠。
  assert.equal(alice.user.uid, 10001);
  assert.equal(bob.user.uid, 10002);
  assert.equal(alice.user.role, 'user');
  assert.equal(alice.user.status, 'active');
  assert.equal(alice.user.mutedUntil, null);

  // 同一个 username 字段既接受账号名也接受纯数字 uid（契约 §5.1）。
  const byUid = await login(backend, String(alice.user.uid), 'correct-password-123');
  assert.equal(byUid.user.id, alice.user.id);

  const conversationId = await direct(backend, alice, bob);

  // 禁言：管理员设置 60 分钟，bob 发消息被拦。
  const muted = await call(backend, 'POST', `/api/v1/admin/users/${bob.user.uid}/mute`, admin.token, { minutes: 60 });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.ok(muted.json().mutedUntil);
  assert.ok(Date.parse(muted.json().mutedUntil) > Date.now());
  const blocked = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, bob.token,
    { clientMsgId: randomUUID(), content: '禁言期间' });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, 'MUTED');
  // 被禁言只影响发消息：读历史仍然正常（契约 §5.3）。
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages`, bob.token)).statusCode, 200);

  // minutes=0 表示解除禁言，而不是「禁言 0 分钟」。
  const unmuted = await call(backend, 'POST', `/api/v1/admin/users/${bob.user.uid}/mute`, admin.token, { minutes: 0 });
  assert.equal(unmuted.statusCode, 200);
  assert.equal(unmuted.json().mutedUntil, null);
  const allowed = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, bob.token,
    { clientMsgId: randomUUID(), content: '解除后' });
  assert.equal(allowed.statusCode, 201, allowed.body);

  // 封禁：登录被拒，且已签发的 token 也不能继续发消息。
  backend.store.run("UPDATE users SET status = 'banned' WHERE id = ?", alice.user.id);
  const bannedLogin = await call(backend, 'POST', '/api/v1/auth/login', undefined,
    { username: 'alice', password: 'correct-password-123' });
  assert.equal(bannedLogin.statusCode, 403);
  assert.equal(bannedLogin.json().error.code, 'ACCOUNT_BANNED');
  const bannedSend = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '封禁期间' });
  assert.equal(bannedSend.statusCode, 403);
  assert.equal(bannedSend.json().error.code, 'ACCOUNT_BANNED');
});

test('管理后台：非管理员拒绝、搜索、禁言、保护管理员、统计', async context => {
  const { backend } = await fixture(context);
  const admin = await adminLogin(backend);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');

  // 非管理员一律 403 ADMIN_REQUIRED（不是 401：身份是有效的，只是权限不够）。
  for (const path of ['/api/v1/admin/users', '/api/v1/admin/stats']) {
    const denied = await call(backend, 'GET', path, alice.token);
    assert.equal(denied.statusCode, 403, path);
    assert.equal(denied.json().error.code, 'ADMIN_REQUIRED');
  }
  assert.equal((await call(backend, 'POST', `/api/v1/admin/users/${bob.user.uid}/mute`, alice.token, { minutes: 10 })).statusCode, 403);
  assert.equal((await call(backend, 'DELETE', `/api/v1/admin/users/${bob.user.uid}`, alice.token)).statusCode, 403);

  // 列表按 uid 升序，管理员排在最前。
  const page = await call(backend, 'GET', '/api/v1/admin/users', admin.token);
  assert.equal(page.statusCode, 200, page.body);
  const uids = page.json().items.map((item: { uid: number }) => item.uid);
  assert.deepEqual(uids, [1001, 10001, 10002]);
  assert.equal(page.json().nextOffset, null);

  // 三个字段一起模糊匹配：账号名、昵称、uid 都能命中。
  assert.deepEqual((await call(backend, 'GET', '/api/v1/admin/users?query=alice', admin.token)).json().items.map((item: { uid: number }) => item.uid), [10001]);
  assert.deepEqual((await call(backend, 'GET', '/api/v1/admin/users?query=10002', admin.token)).json().items.map((item: { uid: number }) => item.uid), [10002]);
  assert.deepEqual((await call(backend, 'GET', '/api/v1/admin/users?query=bob%20%E4%B8%AD%E6%96%87', admin.token)).json().items.map((item: { uid: number }) => item.uid), [10002]);

  // 分页：nextOffset 表示「还有下一页」。
  const first = await call(backend, 'GET', '/api/v1/admin/users?limit=2&offset=0', admin.token);
  assert.equal(first.json().items.length, 2);
  assert.equal(first.json().nextOffset, 2);
  const last = await call(backend, 'GET', '/api/v1/admin/users?limit=2&offset=2', admin.token);
  assert.equal(last.json().items.length, 1);
  assert.equal(last.json().nextOffset, null);

  // 管理员账号受保护：不能被禁言、不能被删除（否则后台会把自己锁死）。
  const muteAdmin = await call(backend, 'POST', `/api/v1/admin/users/${admin.user.uid}/mute`, admin.token, { minutes: 10 });
  assert.equal(muteAdmin.statusCode, 409);
  assert.equal(muteAdmin.json().error.code, 'CANNOT_MUTE_ADMIN');
  const deleteAdmin = await call(backend, 'DELETE', `/api/v1/admin/users/${admin.user.uid}`, admin.token);
  assert.equal(deleteAdmin.statusCode, 409);
  assert.equal(deleteAdmin.json().error.code, 'CANNOT_DELETE_ADMIN');
  const deleteMissing = await call(backend, 'DELETE', '/api/v1/admin/users/88888', admin.token);
  assert.equal(deleteMissing.statusCode, 404);
  assert.equal(deleteMissing.json().error.code, 'USER_NOT_FOUND');

  // 统计口径来自真实表计数，且 online 只数「当前有活跃 WS 连接」的人。
  const conversationId = await direct(backend, alice, bob);
  backend.service.sendMessage(conversationId, alice.user.id, randomUUID(), '统计用消息');
  await upload(backend, alice.token, PNG);
  const stats = await call(backend, 'GET', '/api/v1/admin/stats', admin.token);
  assert.equal(stats.statusCode, 200, stats.body);
  assert.deepEqual(stats.json(), {
    users: backend.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count,
    conversations: backend.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')!.count,
    messages: backend.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM messages')!.count,
    uploads: 1,
    online: 0,
  });
});

test('删除账号：消息清理、群主转移、空私聊回收与 token 失效', async context => {
  const { backend } = await fixture(context);
  const admin = await adminLogin(backend);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');

  // alice 建群先拉 bob，之后再把 carol 加进来：
  // 两次入群时间不同，群主继任者才能确定是 bob（joined_at 升序的第一人）。
  const groupId = await group(backend, alice, [bob]);
  await makeFriends(backend, alice, carol);
  const added = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members`, alice.token, { memberIds: [carol.user.id] });
  assert.equal(added.statusCode, 200, added.body);
  const directId = await direct(backend, alice, bob);
  const sent = await call(backend, 'POST', `/api/v1/conversations/${groupId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: 'alice 的群消息' });
  assert.equal(sent.statusCode, 201, sent.body);

  // 删除前先建一条 alice 置顶的记录，验证置顶记录也被清掉。
  const pin = await call(backend, 'POST', `/api/v1/conversations/${groupId}/pins`, alice.token, { msgId: sent.json().msgId });
  assert.equal(pin.statusCode, 201, pin.body);

  const removed = await call(backend, 'DELETE', `/api/v1/admin/users/${alice.user.uid}`, admin.token);
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(removed.rawPayload.length, 0);

  // 1. 该用户的消息被显式删除（sender_id 无 ON DELETE，不先删就会撞外键）。
  assert.equal(backend.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE sender_id = ?', alice.user.id)!.count, 0);
  // 2. 群主身份转移给最早加入的其他成员，成员行 role 同步。
  const conversation = backend.store.get<{ owner_id: string }>('SELECT owner_id FROM conversations WHERE id = ?', groupId)!;
  assert.equal(conversation.owner_id, bob.user.id);
  assert.equal(backend.store.get<{ role: string }>(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', groupId, bob.user.id)!.role, 'owner');
  // 3. 私聊只剩一个人 → 会话整体删除。
  assert.equal(backend.store.get('SELECT 1 FROM conversations WHERE id = ?', directId), undefined);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${directId}`, bob.token)).statusCode, 404);
  // 4. 置顶记录清空（pinned_by 无 ON DELETE，且被置顶的消息已随消息一起删掉）。
  assert.equal(backend.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM message_pins')!.count, 0);
  // 5. 该用户的 session 被删，旧 token 立刻失效。
  assert.equal((await call(backend, 'GET', '/api/v1/users/me', alice.token)).statusCode, 401);
  // 6. 用户行真的没了。
  assert.equal(backend.store.get('SELECT 1 FROM users WHERE id = ?', alice.user.id), undefined);
  // 群聊其余成员仍可正常访问。
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${groupId}`, carol.token)).statusCode, 200);
});

test('群角色：仅群主可任命、读写权限矩阵与退群规则', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  const dave = await register(backend, 'dave');
  const groupId = await group(backend, alice, [bob, carol]);

  // 建群时所有成员的 joined_at 是同一个 now，服务端 `ORDER BY joined_at, user_id` 会退化成按 UUID 排，
  // 顺序本身没有语义。这里只断言「成员 + 角色」的集合，不锁定排序。
  const roles = async () => ((await call(backend, 'GET', `/api/v1/conversations/${groupId}`, alice.token)).json()
    .members.map((member: { user: { username: string }; role: string }) => [member.user.username, member.role]) as string[][])
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
  assert.deepEqual(await roles(), [['alice', 'owner'], ['bob', 'member'], ['carol', 'member']]);

  // 任命管理员是群主专属：管理员不能再任命别人（不搞权力下放）。
  const byMember = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${bob.user.id}/role`, bob.token, { role: 'admin' });
  assert.equal(byMember.statusCode, 403);
  assert.equal(byMember.json().error.code, 'OWNER_REQUIRED');
  const byOutsider = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${carol.user.id}/role`, dave.token, { role: 'admin' });
  assert.equal(byOutsider.statusCode, 404);

  const promoted = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${bob.user.id}/role`, alice.token, { role: 'admin' });
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.deepEqual(await roles(), [['alice', 'owner'], ['bob', 'admin'], ['carol', 'member']]);
  assert.equal(lastMessageContent(backend, groupId), 'bob 中文 成为管理员');
  // 幂等：重复设成同一个角色不返回错误，也不重复写系统消息。
  const repeated = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${bob.user.id}/role`, alice.token, { role: 'admin' });
  assert.equal(repeated.statusCode, 200);
  assert.equal(lastMessageContent(backend, groupId), 'bob 中文 成为管理员');

  // 群主自己的角色不能通过这个接口改（转让群主本版不支持）。
  const self = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${alice.user.id}/role`, alice.token, { role: 'member' });
  assert.equal(self.statusCode, 400);
  assert.equal(self.json().error.code, 'CANNOT_CHANGE_OWNER_ROLE');
  const nonMember = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${dave.user.id}/role`, alice.token, { role: 'admin' });
  assert.equal(nonMember.statusCode, 404);
  assert.equal(nonMember.json().error.code, 'MEMBER_NOT_FOUND');

  // owner 与 admin 都能改群资料，普通成员不能（契约 §7.2）。
  assert.equal((await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, alice.token, { name: '群主改名' })).statusCode, 200);
  assert.equal((await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, bob.token, { name: '管理员改名' })).statusCode, 200);
  const memberRename = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, carol.token, { name: '成员改名' });
  assert.equal(memberRename.statusCode, 403);
  assert.equal(memberRename.json().error.code, 'OWNER_REQUIRED');

  // 管理员能移除普通成员，但不能移除群主、也不能移除另一个管理员。
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${alice.user.id}`, bob.token)).statusCode, 403);
  const removed = await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${carol.user.id}`, bob.token);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${groupId}`, carol.token)).statusCode, 404);

  // 取消管理员回到 member，随后其管理权限立刻消失。
  const demoted = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members/${bob.user.id}/role`, alice.token, { role: 'member' });
  assert.equal(demoted.statusCode, 200);
  assert.equal(lastMessageContent(backend, groupId), 'bob 中文 被取消管理员');
  assert.equal((await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, bob.token, { name: '再试' })).statusCode, 403);

  // 普通成员只能移自己（退群），且群主不能退群。
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${alice.user.id}`, bob.token)).statusCode, 403);
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${bob.user.id}`, bob.token)).statusCode, 200);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${groupId}`, bob.token)).statusCode, 404);
  const leave = await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${alice.user.id}`, alice.token);
  assert.equal(leave.statusCode, 409);
  assert.equal(leave.json().error.code, 'OWNER_CANNOT_LEAVE');
  // 私聊上调这个接口是语义错误，不是权限问题 → 400 GROUP_REQUIRED。
  const directId = await direct(backend, alice, bob);
  const onDirect = await call(backend, 'DELETE', `/api/v1/conversations/${directId}/members/${bob.user.id}`, alice.token);
  assert.equal(onDirect.statusCode, 400);
  assert.equal(onDirect.json().error.code, 'GROUP_REQUIRED');
});

test('头像：空串、HTTPS 外链、本人图片三态与群头像权限', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');

  const patch = (token: string, avatarUrl: string) => call(backend, 'PATCH', '/api/v1/users/me', token, { avatarUrl });

  // 1. 空串 = 清空，恒合法。
  assert.equal((await patch(alice.token, '')).json().avatarUrl, '');
  // 2. HTTPS 外链合法。
  assert.equal((await patch(alice.token, 'https://cdn.example.com/a.png')).json().avatarUrl, 'https://cdn.example.com/a.png');
  // 3. 本人上传的图片合法（站内上传即可当头像）。
  const image = await upload(backend, alice.token, PNG, 'me.png');
  const own = await patch(alice.token, image.url);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().avatarUrl, image.url);

  // 反例：明文 http、非 uuid 的站内路径、非图片附件、他人附件。
  for (const invalid of ['http://insecure.example.com/a.png', '/api/v1/uploads/not-a-uuid', '/api/v1/uploads/../secret']) {
    const response = await patch(alice.token, invalid);
    assert.equal(response.statusCode, 400, invalid);
    assert.equal(response.json().error.code, 'INVALID_AVATAR_URL');
  }
  const pdf = await upload(backend, alice.token, Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'), 'doc.pdf');
  assert.equal((await patch(alice.token, pdf.url)).statusCode, 400);
  assert.equal((await patch(alice.token, pdf.url)).json().error.code, 'INVALID_AVATAR_URL');
  const bobImage = await upload(backend, bob.token, PNG, 'bob.png');
  assert.equal((await patch(alice.token, bobImage.url)).json().error.code, 'INVALID_AVATAR_URL');

  // 群头像：owner/admin 可改，私聊的 avatarUrl 恒为空串（由 peer 决定）。
  const groupId = await group(backend, alice, [bob, carol]);
  const setGroupAvatar = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, alice.token, { avatarUrl: image.url });
  assert.equal(setGroupAvatar.statusCode, 200, setGroupAvatar.body);
  assert.equal(setGroupAvatar.json().avatarUrl, image.url);
  const clearGroupAvatar = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, alice.token, { avatarUrl: '' });
  assert.equal(clearGroupAvatar.json().avatarUrl, '');
  assert.equal(lastMessageContent(backend, groupId), 'alice 中文 移除了群头像');
  // 非 manager 改群头像被拒：这里传「合法」的头像值（https 外链），
  // 才能确认是权限检查拦下的（403）。若传别人的上传 id，会先被 avatarUrl 校验拦成 400，
  // 那测的就是「校验」而不是「权限」了 —— 两个断言分开写才都有意义。
  const byMember = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, carol.token,
    { avatarUrl: 'https://cdn.example.com/group.png' });
  assert.equal(byMember.statusCode, 403);
  assert.equal(byMember.json().error.code, 'OWNER_REQUIRED');
  // 群主传别人的上传 id：走到校验分支 → 400 INVALID_AVATAR_URL（上传必须属主本人）。
  const byOwnerWithForeignUpload = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, alice.token,
    { avatarUrl: bobImage.url });
  assert.equal(byOwnerWithForeignUpload.statusCode, 400);
  assert.equal(byOwnerWithForeignUpload.json().error.code, 'INVALID_AVATAR_URL');
  const directId = await direct(backend, alice, bob);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${directId}`, alice.token)).json().avatarUrl, '');
});

test('置顶：幂等、跨会话校验、上限、取消与列表排序', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  const conversationId = await direct(backend, alice, bob);
  const send = async (content: string) => (await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`,
    alice.token, { clientMsgId: randomUUID(), content })).json();

  const first = await send('第一条');
  const second = await send('第二条');
  const allowed = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: first.msgId });
  assert.equal(allowed.statusCode, 201, allowed.body);
  // 重复置顶是幂等 200，不新建记录（前端按钮可能被连点）。
  const repeated = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, bob.token, { msgId: first.msgId });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().id, allowed.json().id);
  assert.equal(repeated.json().message.msgId, first.msgId);
  assert.equal(repeated.json().pinnedBy.id, alice.user.id);

  // 跨会话 / 不存在的 msgId 一律 400 INVALID_MESSAGE（不用 404，避免探知别的会话里有没有某条消息）。
  const otherConversation = await direct(backend, alice, carol);
  const foreign = (await call(backend, 'POST', `/api/v1/conversations/${otherConversation}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '别的会话' })).json();
  const cross = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: foreign.msgId });
  assert.equal(cross.statusCode, 400);
  assert.equal(cross.json().error.code, 'INVALID_MESSAGE');
  const missing = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: randomUUID() });
  assert.equal(missing.json().error.code, 'INVALID_MESSAGE');
  // 非成员看不到置顶列表，也不能置顶。
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${conversationId}/pins`, carol.token)).statusCode, 404);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, carol.token, { msgId: first.msgId })).statusCode, 404);

  // 列表按置顶时间倒序：后置顶的排在前面。
  await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: second.msgId });
  const pins = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/pins`, alice.token);
  assert.equal(pins.statusCode, 200);
  assert.deepEqual(pins.json().items.map((item: { message: { content: string } }) => item.message.content), ['第二条', '第一条']);

  // 取消置顶：成功 204 且无响应体；重复取消 404 PIN_NOT_FOUND。
  const removed = await call(backend, 'DELETE', `/api/v1/conversations/${conversationId}/pins/${second.msgId}`, alice.token);
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.rawPayload.length, 0);
  const again = await call(backend, 'DELETE', `/api/v1/conversations/${conversationId}/pins/${second.msgId}`, alice.token);
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().error.code, 'PIN_NOT_FOUND');

  // 上限 50 条：第 51 条 409 PIN_LIMIT。这里直连 service 造消息与置顶，避免撞发消息的 60/min 限流。
  const bulkId = await direct(backend, alice, carol);
  const messageIds: string[] = [];
  for (let index = 0; index < 51; index++) {
    messageIds.push(backend.service.sendMessage(bulkId, alice.user.id, randomUUID(), `批量 ${index}`).message.msgId);
  }
  for (const msgId of messageIds.slice(0, 50)) backend.service.pin(bulkId, alice.user.id, msgId);
  const overLimit = await call(backend, 'POST', `/api/v1/conversations/${bulkId}/pins`, alice.token, { msgId: messageIds[50] });
  assert.equal(overLimit.statusCode, 409);
  assert.equal(overLimit.json().error.code, 'PIN_LIMIT');

  // 消息被保留策略删掉后，悬空的置顶记录在读列表时静默跳过，不让整个请求失败。
  backend.store.run('DELETE FROM messages WHERE msg_id = ?', first.msgId);
  const dangling = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/pins`, alice.token);
  assert.equal(dangling.statusCode, 200);
  assert.deepEqual(dangling.json().items, []);
});

test('置顶变化通过 conversation.pins 广播完整列表', { timeout: 20_000 }, async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const message = (await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '要置顶的' })).json();

  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const ticket = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', bob.token)).json().ticket;
  const client = connect(`ws://127.0.0.1:${address.port}/ws?ticket=${ticket}&v=1`);
  context.after(() => client.socket.terminate());
  await client.waitFor('ready');

  const pinned = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: message.msgId });
  assert.equal(pinned.statusCode, 201, pinned.body);
  const event = await client.waitFor('conversation.pins');
  assert.equal(event.v, 1);
  assert.equal(event.data.conversationId, conversationId);
  // 广播的是「完整列表」而不是增量：前端收到即整体替换（契约 §9.4）。
  assert.equal(event.data.pins.length, 1);
  assert.equal(event.data.pins[0].message.msgId, message.msgId);
  assert.equal(event.data.pins[0].pinnedBy.id, alice.user.id);

  // 清掉已消费的事件，后续 waitFor 才能等到「新」帧而不是又拿到同一条。
  client.events.length = 0;

  // 幂等重放不广播：连点两下不应该产生两条内容相同的事件。
  await call(backend, 'POST', `/api/v1/conversations/${conversationId}/pins`, alice.token, { msgId: message.msgId });
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(client.events.filter(item => item.type === 'conversation.pins').length, 0);

  await call(backend, 'DELETE', `/api/v1/conversations/${conversationId}/pins/${message.msgId}`, alice.token);
  const cleared = await client.waitFor('conversation.pins');
  assert.deepEqual(cleared.data.pins, []);
});

test('附件读取权限：属主、同会话成员、无关用户三档', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  const conversationId = await direct(backend, alice, bob);

  const image = await upload(backend, alice.token, PNG, '分享.png');
  const sent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '分享.png', attachmentIds: [image.id] });
  assert.equal(sent.statusCode, 201, sent.body);

  // 1. 属主自己。
  const ownerRead = await call(backend, 'GET', image.url, alice.token);
  assert.equal(ownerRead.statusCode, 200);
  assert.equal(ownerRead.rawPayload.length, PNG.length);
  // 2. 同会话成员：这修的就是 P0 缺陷「对方发来的图点开 403」。
  const peerRead = await call(backend, 'GET', image.url, bob.token);
  assert.equal(peerRead.statusCode, 200, peerRead.body);
  assert.deepEqual(Buffer.from(peerRead.rawPayload), PNG);
  // 3. 无关用户仍然 403（保持原码：uuid 不可枚举，403 让前端区分「无权限」与「已删除」）。
  const strangerRead = await call(backend, 'GET', image.url, carol.token);
  assert.equal(strangerRead.statusCode, 403);
  assert.equal(strangerRead.json().error.code, 'FORBIDDEN');

  // 未被任何消息引用的上传（刚传完还没发出去）不能跨人访问：
  // 否则任何拿到 uuid 的人都能读别人正在编辑的草稿附件。
  const draft = await upload(backend, alice.token, PNG, '草稿.png');
  assert.equal((await call(backend, 'GET', draft.url, bob.token)).statusCode, 403);
  assert.equal((await call(backend, 'GET', draft.url, alice.token)).statusCode, 200);

  // 删除仍然只允许属主，且被消息引用的附件删不掉。
  assert.equal((await call(backend, 'DELETE', image.url, bob.token)).statusCode, 403);
  const inUse = await call(backend, 'DELETE', image.url, alice.token);
  assert.equal(inUse.statusCode, 409);
  assert.equal(inUse.json().error.code, 'UPLOAD_IN_USE');
  assert.equal((await call(backend, 'DELETE', draft.url, alice.token)).statusCode, 204);
});

test('迁移：user_version 2 的库升到最新，补列回填且幂等不丢数据', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'aitrance-ux2-migrate-'));
  const databasePath = join(directory, 'chat.sqlite');
  const uploadsDir = join(directory, 'uploads');
  const legacyPasswordHash = await hashPassword('legacy-password-123');
  // 老库里的 id 必须是合法 UUID：路由 params 用 TypeBox 的 format:'uuid' 校验，
  // 用 'legacy-group' 这种可读字符串的话，迁移后连历史都读不出来（400 VALIDATION_ERROR），
  // 那这条用例就变成在测参数校验而不是在测迁移了。
  const legacyUserId = randomUUID();
  const legacyGroupId = randomUUID();
  const legacyMsgId = randomUUID();
  const legacyClientId = randomUUID();

  // 手工造一个 v2 形态的老库：users 没有 uid/role/status/muted_until，
  // conversations 没有 avatar_url，conversation_members 没有 role。
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
      name TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
      direct_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), joined_at TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE,
      seq INTEGER NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      client_message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'image', 'file')),
      content TEXT NOT NULL, attachment_id TEXT, created_at TEXT NOT NULL,
      UNIQUE(sender_id, client_message_id), UNIQUE(conversation_id, seq)
    );
    PRAGMA user_version = 2;
  `);
  const created = '2024-01-01T00:00:00.000Z';
  legacy.prepare('INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(legacyUserId, 'legacyalice', '老用户', legacyPasswordHash, created);
  legacy.prepare(`INSERT INTO conversations(id, type, name, owner_id, created_at, updated_at)
    VALUES (?, 'group', ?, ?, ?, ?)`).run(legacyGroupId, '老群', legacyUserId, created, created);
  legacy.prepare(`INSERT INTO conversation_members(conversation_id, user_id, joined_at, last_read_seq)
    VALUES (?, ?, ?, 1)`).run(legacyGroupId, legacyUserId, created);
  legacy.prepare(`INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at)
    VALUES (?, 1, ?, ?, ?, 'text', ?, ?)`).run(legacyMsgId, legacyGroupId, legacyUserId, legacyClientId, '迁移前的消息', created);
  legacy.close();

  const upgraded = await buildApp({ databasePath, uploadsDir, logger: false, adminUid: 1001, adminInitialPassword: ADMIN_PASSWORD });
  try {
    assert.equal(Number(upgraded.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version), SCHEMA_VERSION);
    // uid 按注册时间从 10001 起回填；管理员（1001）由 bootstrap 单独创建，不占用普通号段。
    assert.equal(upgraded.store.get<{ uid: number }>('SELECT uid FROM users WHERE id = ?', legacyUserId)!.uid, 10001);
    assert.equal(upgraded.store.get<{ uid: number }>('SELECT uid FROM users WHERE role = ?', 'admin')!.uid, 1001);
    const user = upgraded.store.get<{ role: string; status: string; muted_until: string | null }>(
      'SELECT role, status, muted_until FROM users WHERE id = ?', legacyUserId)!;
    assert.equal(user.role, 'user');
    assert.equal(user.status, 'active');
    assert.equal(user.muted_until, null);
    // 群头像列补上并取默认值；群主在成员行上的 role 被回填成 owner。
    assert.equal(upgraded.store.get<{ avatar_url: string }>('SELECT avatar_url FROM conversations WHERE id = ?', legacyGroupId)!.avatar_url, '');
    assert.equal(upgraded.store.get<{ role: string }>(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', legacyGroupId, legacyUserId)!.role, 'owner');
    // 老消息一字不动；v4 起 attachments 走关联表，messages 不再有 attachment_id 列。
    const message = upgraded.store.get<{ content: string }>(
      'SELECT content FROM messages WHERE msg_id = ?', legacyMsgId)!;
    assert.equal(message.content, '迁移前的消息');
    const messageSql = upgraded.store.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")!.sql;
    assert.ok(!messageSql.includes('attachment_id'), 'v4 之后 messages 不应再有 attachment_id 列');
    // 老消息没有附件 → 关联表里也没有它的行。
    assert.equal(upgraded.store.get('SELECT 1 FROM message_attachments WHERE msg_id = ?', legacyMsgId), undefined);
    // 迁移后的库能正常读历史（证明结构真的可用，而不只是版本号变了）。
    const token = (await login(upgraded, 'legacyalice', 'legacy-password-123')).token;
    assert.equal((await call(upgraded, 'GET', `/api/v1/conversations/${legacyGroupId}/messages`, token)).json().items[0].content, '迁移前的消息');
  } finally {
    await upgraded.app.close();
  }

  // 再启动一次：迁移是纯 no-op，uid 不会被重新编号（幂等性证明）。
  const again = await buildApp({ databasePath, uploadsDir, logger: false, adminUid: 1001, adminInitialPassword: ADMIN_PASSWORD });
  try {
    assert.equal(Number(again.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version), SCHEMA_VERSION);
    assert.equal(again.store.get<{ uid: number }>('SELECT uid FROM users WHERE id = ?', legacyUserId)!.uid, 10001);
    assert.equal(again.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count, 2);
    assert.equal(again.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM messages')!.count, 1);
  } finally {
    await again.app.close();
    // app 全部关掉之后再删目录，否则 Windows 上 sqlite 句柄未释放会 EBUSY。
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
