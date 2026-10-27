import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.ts';
import { digest } from '../src/security.ts';

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account { token: string; user: { id: string; username: string }; expiresAt: string }

async function fixture(context: TestContext) {
  const backend = await buildApp({ databasePath: ':memory:', logger: false });
  context.after(() => backend.app.close());
  return backend;
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

async function makeFriends(backend: Context, sender: Account, recipient: Account): Promise<void> {
  const created = await call(backend, 'POST', '/api/v1/friend-requests', sender.token, { userId: recipient.user.id });
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

test('authentication, validation, profile, session renewal and revocation', async context => {
  const backend = await fixture(context);
  const health = await call(backend, 'GET', '/api/v1/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().protocolVersion, 2);
  const anonymous = await call(backend, 'GET', '/api/v1/users/me');
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'UNAUTHORIZED');
  assert.ok(anonymous.json().error.traceId);
  const invalid = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username: 'alice', displayName: ' ', password: 'short' });
  assert.equal(invalid.statusCode, 400);
  const alice = await register(backend, 'alice');
  const duplicate = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username: 'ALICE', displayName: 'Alice', password: 'correct-password-123' });
  assert.equal(duplicate.statusCode, 409);
  const privateRow = backend.store.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', alice.user.id)!;
  assert.notEqual(privateRow.password_hash, 'correct-password-123');
  assert.ok(!JSON.stringify(alice).includes('password'));
  const storedSession = backend.store.get<{ token_hash: string }>('SELECT token_hash FROM sessions')!;
  assert.equal(storedSession.token_hash, digest(alice.token));
  assert.notEqual(storedSession.token_hash, alice.token);
  const invalidLogin = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'alice', password: 'wrong-password' });
  const missingLogin = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'missing', password: 'wrong-password' });
  assert.equal(invalidLogin.statusCode, 401);
  assert.equal(missingLogin.json().error.code, invalidLogin.json().error.code);
  const loggedIn = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'ALICE', password: 'correct-password-123' });
  assert.equal(loggedIn.statusCode, 200);
  const renewed = await call(backend, 'POST', '/api/v1/auth/session/refresh', alice.token);
  assert.equal(renewed.json().token, alice.token);
  assert.ok(renewed.json().expiresAt >= alice.expiresAt);
  const updated = await call(backend, 'PATCH', '/api/v1/users/me', alice.token, { displayName: ' 新昵称 ', bio: '你好' });
  assert.equal(updated.json().displayName, '新昵称');
  assert.equal((await call(backend, 'PATCH', '/api/v1/users/me', alice.token, { avatarUrl: 'javascript:alert(1)' })).statusCode, 400);
  assert.equal((await call(backend, 'PATCH', '/api/v1/users/me', alice.token, { username: 'other' })).statusCode, 400);
  await call(backend, 'POST', '/api/v1/auth/logout', alice.token);
  assert.equal((await call(backend, 'GET', '/api/v1/users/me', alice.token)).statusCode, 401);
  assert.equal((await call(backend, 'GET', '/api/v1/users/me', loggedIn.json().token)).statusCode, 200);
  backend.store.run('UPDATE sessions SET expires_at = ?', '2000-01-01T00:00:00.000Z');
  assert.equal((await call(backend, 'POST', '/api/v1/auth/session/refresh', loggedIn.json().token)).statusCode, 401);
});

test('both health routes expose the same numeric protocol version and UTC clock', async context => {
  const backend = await fixture(context);
  const results = await Promise.all(['/health', '/api/v1/health'].map(path => call(backend, 'GET', path)));
  for (const response of results) {
    assert.equal(response.statusCode, 200);
    const { serverTime, ...metadata } = response.json();
    assert.deepEqual(metadata, { status: 'ok', version: '0.3.0', protocolVersion: 2 });
    assert.equal(new Date(serverTime).toISOString(), serverTime);
    assert.ok(Math.abs(Date.now() - Date.parse(serverTime)) < 5000);
  }
  const openapi = backend.app.swagger();
  assert.equal(openapi.info.version, '0.3.0');
  assert.deepEqual(openapi.paths?.['/health']?.get?.responses, openapi.paths?.['/api/v1/health']?.get?.responses);
});

test('friendship consent, search escaping and group authorization', async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  assert.equal((await call(backend, 'POST', '/api/v1/conversations/direct', alice.token, { userId: bob.user.id })).statusCode, 403);
  assert.equal((await call(backend, 'POST', '/api/v1/friend-requests', alice.token, { userId: alice.user.id })).statusCode, 400);
  const request = await call(backend, 'POST', '/api/v1/friend-requests', alice.token, { userId: bob.user.id, note: '你好' });
  assert.equal(request.statusCode, 201);
  const requestId = request.json().id;
  assert.equal((await call(backend, 'POST', '/api/v1/friend-requests', bob.token, { userId: alice.user.id })).statusCode, 409);
  assert.equal((await call(backend, 'POST', `/api/v1/friend-requests/${requestId}/respond`, carol.token, { action: 'accept' })).statusCode, 404);
  assert.equal((await call(backend, 'POST', `/api/v1/friend-requests/${requestId}/respond`, bob.token, { action: 'accept' })).statusCode, 200);
  assert.equal((await call(backend, 'POST', `/api/v1/friend-requests/${requestId}/respond`, bob.token, { action: 'accept' })).statusCode, 409);
  assert.equal((await call(backend, 'GET', '/api/v1/friends', alice.token)).json().items[0].id, bob.user.id);
  assert.equal((await call(backend, 'GET', '/api/v1/users?q=bob', alice.token)).json().items.length, 1);
  assert.equal((await call(backend, 'GET', '/api/v1/users?q=%25', alice.token)).json().items.length, 0);
  const group = await call(backend, 'POST', '/api/v1/conversations/group', alice.token, { name: '测试群', memberIds: [bob.user.id] });
  assert.equal(group.statusCode, 201, group.body);
  const groupId = group.json().id;
  assert.equal(group.json().lastMessage.type, 'system');
  assert.equal(group.json().members.length, 2);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${groupId}`, carol.token)).statusCode, 404);
  assert.equal((await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, bob.token, { name: '越权' })).statusCode, 403);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${groupId}/members`, alice.token, { memberIds: [carol.user.id] })).statusCode, 403);
  await makeFriends(backend, alice, carol);
  const joined = await call(backend, 'POST', `/api/v1/conversations/${groupId}/members`, alice.token, { memberIds: [carol.user.id] });
  assert.equal(joined.json().members.length, 3);
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${alice.user.id}`, alice.token)).statusCode, 409);
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${bob.user.id}`, carol.token)).statusCode, 403);
  assert.equal((await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${carol.user.id}`, carol.token)).statusCode, 200);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${groupId}/messages`, carol.token)).statusCode, 404);
});

test('message idempotency, per-conversation sequence, cursors and unread count', async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  const conversationId = await direct(backend, alice, bob);
  const duplicateConversation = await call(backend, 'POST', '/api/v1/conversations/direct', bob.token, { userId: alice.user.id });
  assert.equal(duplicateConversation.json().id, conversationId);
  assert.equal(duplicateConversation.json().title, 'alice 中文');
  assert.equal(duplicateConversation.json().type, 'single');
  const body = { clientMsgId: randomUUID(), content: '你好 <script>alert(1)</script>' };
  const first = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, body);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().seq, 1);
  const retry = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, body);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), first.json());
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, { ...body, content: '不同文本' })).statusCode, 409);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, carol.token, body)).statusCode, 404);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, { ...body, content: ' '.repeat(2) })).statusCode, 400);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, { ...body, content: '字'.repeat(4001) })).statusCode, 400);
  const requests = Array.from({ length: 10 }, (_, index) => call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: `消息 ${index}` }));
  const sent = await Promise.all(requests);
  assert.ok(sent.every(response => response.statusCode === 201));
  assert.equal(new Set(sent.map(response => response.json().seq)).size, 10);
  const details = await call(backend, 'GET', `/api/v1/conversations/${conversationId}`, bob.token);
  assert.equal(details.json().unreadCount, 11);
  assert.equal(details.json().lastSeq, 11);
  const history = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages?limit=3`, bob.token);
  assert.deepEqual(history.json().items.map((message: { seq: number }) => message.seq), [9, 10, 11]);
  assert.equal(history.json().nextBeforeSeq, 9);
  const after = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages?afterSeq=2&limit=2`, bob.token);
  assert.deepEqual(after.json().items.map((message: { seq: number }) => message.seq), [3, 4]);
  assert.equal(after.json().nextAfterSeq, 4);
  assert.equal((await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages?afterSeq=1&beforeSeq=4`, bob.token)).statusCode, 400);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/read`, bob.token, { lastReadSeq: 11 })).statusCode, 204);
  await call(backend, 'POST', `/api/v1/conversations/${conversationId}/read`, bob.token, { lastReadSeq: 1 });
  const read = (await call(backend, 'GET', `/api/v1/conversations/${conversationId}`, bob.token)).json();
  assert.equal(read.lastReadSeq, 11);
  assert.equal(read.unreadCount, 0);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversationId}/read`, bob.token, { lastReadSeq: 999 })).statusCode, 400);
});

test('sync chunks and authorization are explicit and lossless', async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  for (let index = 0; index < 105; index++) backend.service.sendMessage(conversationId, alice.user.id, randomUUID(), `补偿 ${index}`);
  const first = await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId, lastSeq: 0 }] });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items[0].messages.length, 100);
  assert.equal(first.json().items[0].lastSeq, 105);
  assert.equal(first.json().items[0].nextSeq, 100);
  assert.equal(first.json().items[0].unreadCount, 105);
  assert.equal(first.json().items[0].hasMore, true);
  const next = await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId, lastSeq: 100 }] });
  assert.equal(next.json().items[0].messages.length, 5);
  assert.equal(next.json().items[0].hasMore, false);
  assert.equal((await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId, lastSeq: 999 }] })).statusCode, 400);
  assert.equal((await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId, lastSeq: 0 }, { conversationId, lastSeq: 0 }] })).statusCode, 400);
  assert.equal((await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId: randomUUID(), lastSeq: 0 }] })).statusCode, 404);
});

test('CORS, uniform errors, rate limiting and OpenAPI', async context => {
  const backend = await fixture(context);
  const forbidden = await backend.app.inject({ url: '/health', headers: { origin: 'https://evil.example' } });
  assert.equal(forbidden.statusCode, 403);
  const preflight = await backend.app.inject({ method: 'OPTIONS', url: '/api/v1/users/me', headers: {
    origin: 'http://localhost:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'Authorization',
  } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  for (let index = 0; index < 10; index++) {
    const invalid = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'aa', password: 'x' });
    assert.equal(invalid.statusCode, 400);
  }
  const limited = await call(backend, 'POST', '/api/v1/auth/login', undefined, { username: 'aa', password: 'x' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(limited.headers['retry-after']);
  const openapi = backend.app.swagger();
  assert.ok(openapi.paths?.['/api/v1/sync']);
  assert.ok(openapi.paths?.['/api/v1/conversations/{conversationId}/messages']);
  assert.equal((await call(backend, 'GET', '/docs/')).statusCode, 200);
  assert.equal((await call(backend, 'GET', '/docs/static/swagger-ui.css')).statusCode, 200);
  assert.equal((await call(backend, 'GET', '/openapi.json')).json().info.version, '0.3.0');
  assert.equal((await call(backend, 'GET', '/unknown')).json().error.code, 'NOT_FOUND');
});

test('registration creates reciprocal default friendship and notifies the online default account', async context => {
  const backend = await fixture(context);
  backend.config.defaultFriendUsername = '';
  const owner = await register(backend, 'QJQ');
  backend.config.defaultFriendUsername = 'QJQ';
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const ticket = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', owner.token)).json().ticket;
  const connection = connect(`ws://127.0.0.1:${address.port}/ws?ticket=${ticket}&v=1`);
  context.after(() => connection.socket.terminate());
  await connection.waitFor('ready');
  const newcomer = await register(backend, 'newcomer');
  const event = await connection.waitFor('friend.resolved');
  assert.equal(event.data.request.status, 'accepted');
  assert.equal(event.data.request.sender.id, newcomer.user.id);
  assert.equal(event.data.request.recipient.id, owner.user.id);
  assert.deepEqual((await call(backend, 'GET', '/api/v1/friends', newcomer.token)).json().items.map((user: { id: string }) => user.id), [owner.user.id]);
  assert.deepEqual((await call(backend, 'GET', '/api/v1/friends', owner.token)).json().items.map((user: { id: string }) => user.id), [newcomer.user.id]);
  assert.deepEqual((await call(backend, 'GET', '/api/v1/friend-requests?status=pending', newcomer.token)).json().items, []);
  const conversation = await call(backend, 'POST', '/api/v1/conversations/direct', newcomer.token, { userId: owner.user.id });
  assert.equal(conversation.statusCode, 200);
  assert.equal((await call(backend, 'POST', `/api/v1/conversations/${conversation.json().id}/messages`, newcomer.token,
    { clientMsgId: randomUUID(), content: '自动好友可以直接聊天' })).statusCode, 201);
  const duplicate = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username: 'qjq', displayName: 'duplicate', password: 'correct-password-123' });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(backend.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM friendships')!.total, 2);
  assert.equal(backend.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM friendships WHERE user_id = friend_id')!.total, 0);
});

test('disabled default friendship preserves the normal friend request flow', async context => {
  const backend = await fixture(context);
  backend.config.defaultFriendUsername = '';
  const owner = await register(backend, 'QJQ');
  const newcomer = await register(backend, 'newcomer');
  assert.deepEqual((await call(backend, 'GET', '/api/v1/friends', newcomer.token)).json().items, []);
  await makeFriends(backend, newcomer, owner);
});

test('missing default account fails closed and registration failure rolls back automatic friendship', async context => {
  const backend = await fixture(context);
  backend.config.defaultFriendUsername = 'QJQ';
  for (const username of ['newcomer', 'QJQ']) {
    const response = await call(backend, 'POST', '/api/v1/auth/register', undefined,
      { username, displayName: username, password: 'correct-password-123' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'DEFAULT_FRIEND_UNAVAILABLE');
  }
  // 排除启动时自动创建的管理员（uid=1001，契约 §三）：本断言要证明的是
  // 「注册失败不留用户行」，不是「库里一个用户都没有」。
  assert.equal(backend.store.get<{ total: number }>("SELECT COUNT(*) AS total FROM users WHERE role <> 'admin'")!.total, 0);
  backend.config.defaultFriendUsername = '';
  await register(backend, 'QJQ');
  backend.config.defaultFriendUsername = 'qjq';
  backend.store.db.exec(`CREATE TRIGGER reject_new_session BEFORE INSERT ON sessions
    BEGIN SELECT RAISE(ABORT, 'forced session failure'); END;`);
  const failed = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username: 'rollback_user', displayName: 'rollback', password: 'correct-password-123' });
  assert.equal(failed.statusCode, 500);
  assert.equal(backend.store.get('SELECT id FROM users WHERE username = ?', 'rollback_user'), undefined);
  assert.equal(backend.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM friendships')!.total, 0);
  assert.equal(backend.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM friend_requests')!.total, 0);
  assert.equal(backend.store.get<{ total: number }>('SELECT COUNT(*) AS total FROM sessions')!.total, 1);
});

interface EventFrame { v: number; type: string; timestamp: string; data: Record<string, any> }

test('proxy-aware login limiting trusts loopback only and is disabled by default', async context => {
  for (const scenario of [
    { trustLoopbackProxy: false, remoteAddress: '127.0.0.1', independent: false },
    { trustLoopbackProxy: true, remoteAddress: '127.0.0.1', independent: true },
    { trustLoopbackProxy: true, remoteAddress: '198.51.100.50', independent: false },
  ]) {
    const backend = await buildApp({ databasePath: ':memory:', logger: false, trustLoopbackProxy: scenario.trustLoopbackProxy });
    context.after(() => backend.app.close());
    const attempt = (forwardedFor: string) => backend.app.inject({ method: 'POST', url: '/api/v1/auth/login',
      remoteAddress: scenario.remoteAddress, headers: { 'x-forwarded-for': forwardedFor },
      payload: { username: 'a', password: 'short' } });
    for (let index = 0; index < 10; index++) assert.equal((await attempt('203.0.113.10')).statusCode, 400);
    assert.equal((await attempt('203.0.113.10')).statusCode, 429);
    assert.equal((await attempt('203.0.113.11')).statusCode, scenario.independent ? 400 : 429);
  }
});

function connect(url: string) {
  const socket = new WebSocket(url, { origin: 'http://localhost:5173' });
  const events: EventFrame[] = [];
  const errors: Error[] = [];
  socket.on('message', data => events.push(JSON.parse(data.toString()) as EventFrame));
  socket.on('error', error => errors.push(error));
  const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)));
  async function waitFor(type: string): Promise<EventFrame> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (errors.length) throw errors[0];
      const event = events.find(item => item.type === type);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Missing event ${type}: ${JSON.stringify(events)}`);
  }
  return { socket, events, waitFor, closed };
}

test('real sockets deliver messages, presence, typing, read receipts and enforce ticket/session rules', { timeout: 20_000 }, async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `ws://127.0.0.1:${address.port}/ws`;
  const ticketAlice = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', alice.token)).json().ticket;
  const ticketBob = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', bob.token)).json().ticket;
  const socketAlice = connect(`${base}?ticket=${ticketAlice}&v=1`);
  const socketBob = connect(`${base}?ticket=${ticketBob}&v=1`);
  context.after(() => { socketAlice.socket.terminate(); socketBob.socket.terminate(); });
  const ready = await socketAlice.waitFor('ready');
  assert.equal(ready.v, 1);
  assert.equal(ready.data.userId, alice.user.id);
  assert.equal(ready.data.protocolVersion, 2);
  assert.equal(new Date(ready.data.serverTime).toISOString(), ready.data.serverTime);
  assert.equal(ready.timestamp, ready.data.serverTime);
  await socketBob.waitFor('ready');
  const replay = connect(`${base}?ticket=${ticketAlice}`);
  assert.equal(await replay.closed, 4001);
  const invalidVersion = connect(`${base}?ticket=${ticketAlice}&v=2`);
  assert.equal(await invalidVersion.closed, 4002);
  const expiredTicket = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', alice.token)).json().ticket;
  backend.store.run('UPDATE ws_tickets SET expires_at = ? WHERE ticket_hash = ?', '2000-01-01T00:00:00.000Z', digest(expiredTicket));
  assert.equal(await connect(`${base}?ticket=${expiredTicket}`).closed, 4001);
  socketAlice.socket.send(JSON.stringify({ v: 1, type: 'ping' }));
  await socketAlice.waitFor('pong');
  socketAlice.socket.send(JSON.stringify({ v: 1, type: 'typing', conversationId, active: true }));
  assert.equal((await socketBob.waitFor('typing.changed')).data.userId, alice.user.id);
  await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '实时消息' });
  assert.equal((await socketAlice.waitFor('message.created')).data.unreadCount, 0);
  assert.equal((await socketBob.waitFor('message.created')).data.unreadCount, 1);
  await call(backend, 'POST', `/api/v1/conversations/${conversationId}/read`, bob.token, { lastReadSeq: 1 });
  assert.equal((await socketAlice.waitFor('conversation.read')).data.lastReadSeq, 1);
  assert.equal((await socketBob.waitFor('conversation.read')).data.unreadCount, 0);
  socketBob.socket.send(JSON.stringify({ v: 1, type: 'typing', conversationId: randomUUID(), active: true }));
  assert.equal((await socketBob.waitFor('error')).data.code, 'INVALID_EVENT');
  await call(backend, 'POST', '/api/v1/auth/logout', bob.token);
  assert.equal(await socketBob.closed, 4003);
  backend.store.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', '2000-01-01T00:00:00.000Z', digest(alice.token));
  socketAlice.socket.send(JSON.stringify({ v: 1, type: 'ping' }));
  assert.equal(await socketAlice.closed, 4003);
});

test('SQLite survives process-equivalent restart with sessions and messages', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'aitrance-chat-'));
  context.after(async () => {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    assert.ok(resolved.split(sep).at(-1)!.startsWith('aitrance-chat-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const databasePath = join(directory, 'chat.sqlite');
  const original = await buildApp({ databasePath, logger: false });
  let token: string;
  let conversationId: string;
  try {
    const alice = await register(original, 'alice');
    const bob = await register(original, 'bob');
    token = alice.token;
    conversationId = await direct(original, alice, bob);
    original.service.sendMessage(conversationId, alice.user.id, randomUUID(), '重启仍存在');
  } finally { await original.app.close(); }
  const reopened = await buildApp({ databasePath, logger: false });
  try {
    const messages = await call(reopened, 'GET', `/api/v1/conversations/${conversationId}/messages`, token);
    assert.equal(messages.statusCode, 200);
    assert.equal(messages.json().items[0].content, '重启仍存在');
  } finally { await reopened.app.close(); }
});

test('WebSocket limits remain 1008, binary is 1003 and outbound session expiry is 4003', { timeout: 20_000 }, async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `ws://127.0.0.1:${address.port}/ws`;
  const sockets: ReturnType<typeof connect>[] = [];
  context.after(() => sockets.forEach(client => client.socket.terminate()));
  async function open() {
    const response = await call(backend, 'POST', '/api/v1/auth/ws-ticket', alice.token);
    assert.equal(response.statusCode, 200);
    const connection = connect(`${base}?ticket=${response.json().ticket}`);
    sockets.push(connection);
    return connection;
  }
  for (let index = 0; index < 5; index++) await (await open()).waitFor('ready');
  assert.equal(await (await open()).closed, 1008);
  assert.equal((await call(backend, 'GET', '/api/v1/auth/session', alice.token)).statusCode, 200);
  const flooded = sockets[0]!;
  for (let index = 0; index < 31; index++) flooded.socket.send(JSON.stringify({ v: 1, type: 'ping' }));
  assert.equal(await flooded.closed, 1008);
  assert.equal((await call(backend, 'GET', '/api/v1/auth/session', alice.token)).statusCode, 200);
  const binary = sockets[1]!;
  binary.socket.send(Buffer.from('binary payload'));
  assert.equal(await binary.closed, 1003);
  backend.store.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', '2000-01-01T00:00:00.000Z', digest(alice.token));
  backend.realtime.publish([alice.user.id], 'message.created', { content: 'must not be delivered' });
  for (const connection of sockets.slice(2, 5)) {
    assert.equal(await connection.closed, 4003);
    assert.ok(!connection.events.some(event => event.type === 'message.created'));
  }
});

test('group system events and read state reach all devices without leaking after removal', { timeout: 20_000 }, async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  await makeFriends(backend, alice, bob);
  const created = await call(backend, 'POST', '/api/v1/conversations/group', alice.token, { name: '原始群名', memberIds: [bob.user.id] });
  const groupId = created.json().id;
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const address = backend.app.server.address();
  assert.ok(address && typeof address === 'object');
  const ticketFirst = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', bob.token)).json().ticket;
  const ticketSecond = (await call(backend, 'POST', '/api/v1/auth/ws-ticket', bob.token)).json().ticket;
  const first = connect(`ws://127.0.0.1:${address.port}/ws?ticket=${ticketFirst}`);
  const second = connect(`ws://127.0.0.1:${address.port}/ws?ticket=${ticketSecond}`);
  context.after(() => { first.socket.terminate(); second.socket.terminate(); });
  await first.waitFor('ready');
  await second.waitFor('ready');
  assert.equal((await call(backend, 'GET', '/api/v1/friends', alice.token)).json().items[0].online, true);
  const renamed = await call(backend, 'PATCH', `/api/v1/conversations/${groupId}`, alice.token, { name: '新群名' });
  assert.equal(renamed.json().lastSeq, 2);
  const update = await first.waitFor('conversation.updated');
  assert.equal(update.data.conversation.title, '新群名');
  assert.equal(update.data.conversation.unreadCount, 2);
  const systemEvent = await first.waitFor('message.created');
  assert.equal(systemEvent.data.message.type, 'system');
  assert.equal(systemEvent.data.message.seq, 2);
  assert.match(systemEvent.data.message.content, /新群名/);
  await second.waitFor('message.created');
  await call(backend, 'POST', `/api/v1/conversations/${groupId}/read`, bob.token, { lastReadSeq: 2 });
  assert.equal((await first.waitFor('conversation.read')).data.unreadCount, 0);
  assert.equal((await second.waitFor('conversation.read')).data.unreadCount, 0);
  first.events.length = 0;
  second.events.length = 0;
  const removed = await call(backend, 'DELETE', `/api/v1/conversations/${groupId}/members/${bob.user.id}`, alice.token);
  assert.equal(removed.statusCode, 200);
  await first.waitFor('conversation.removed');
  await second.waitFor('conversation.removed');
  const secret = await call(backend, 'POST', `/api/v1/conversations/${groupId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '移除后保密消息' });
  assert.equal(secret.statusCode, 201);
  first.socket.send(JSON.stringify({ v: 1, type: 'typing', conversationId: groupId, active: true }));
  await first.waitFor('error');
  first.socket.send(JSON.stringify({ v: 1, type: 'ping' }));
  second.socket.send(JSON.stringify({ v: 1, type: 'ping' }));
  await first.waitFor('pong');
  await second.waitFor('pong');
  assert.ok(!first.events.some(event => event.type === 'message.created' || event.type === 'conversation.updated'));
  assert.ok(!second.events.some(event => event.type === 'message.created' || event.type === 'conversation.updated'));
  await call(backend, 'POST', '/api/v1/auth/logout', bob.token);
  assert.equal(await first.closed, 4003);
  assert.equal(await second.closed, 4003);
});

test('removed groups cannot enter a sync batch, distinct chats maintain independent sequence', async context => {
  const backend = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');
  const firstId = await direct(backend, alice, bob);
  const secondId = await direct(backend, alice, carol);
  const clientMsgId = randomUUID();
  const first = backend.service.sendMessage(firstId, alice.user.id, clientMsgId, '第一会话');
  const second = backend.service.sendMessage(secondId, alice.user.id, randomUUID(), '第二会话');
  assert.equal(first.message.seq, 1);
  assert.equal(second.message.seq, 1);
  assert.notEqual(first.message.msgId, second.message.msgId);
  const collision = await call(backend, 'POST', `/api/v1/conversations/${secondId}/messages`, alice.token,
    { clientMsgId, content: '第一会话' });
  assert.equal(collision.statusCode, 409);
  const denied = await call(backend, 'POST', '/api/v1/sync', bob.token,
    { cursors: [{ conversationId: firstId, lastSeq: 0 }, { conversationId: secondId, lastSeq: 0 }] });
  assert.equal(denied.statusCode, 404);
  assert.ok(!denied.body.includes('第二会话'));
  const historical = await call(backend, 'GET', `/api/v1/conversations/${firstId}/messages?beforeSeq=1`, bob.token);
  assert.deepEqual(historical.json().items, []);
  assert.equal(historical.json().hasMore, false);
});
