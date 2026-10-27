import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { MAX_UPLOAD_BYTES } from '../src/upload.ts';

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account { token: string; user: { id: string; username: string }; expiresAt: string }

/** 最小合法 1x1 透明 PNG（真实字节，魔数嗅探必须靠它命中 image/png）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 每个用例一个独立的临时上传目录。
 * 上传是唯一会落盘的接口，用 ':memory:' 数据库 + 真实目录才能覆盖「文件真的写出来了」这件事。
 */
async function fixture(context: TestContext, prefix = 'aitrance-uploads-') {
  const uploadsDir = await mkdtemp(join(tmpdir(), prefix));
  const backend = await buildApp({ databasePath: ':memory:', uploadsDir, logger: false, seedUser: null });
  // after 钩子按注册顺序执行：先关 app 再删目录，避免关停过程中的清理写到已删除的目录。
  context.after(() => backend.app.close());
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  return { backend, uploadsDir };
}

async function call(backend: Context, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

/** 上传裸二进制。contentType 默认不设，用来验证「类型由服务端嗅探、与请求头无关」。 */
async function upload(backend: Context, token: string | undefined, bytes: Buffer, options: { filename?: string; contentType?: string } = {}) {
  const query = options.filename === undefined ? '' : `?filename=${encodeURIComponent(options.filename)}`;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.contentType) headers['content-type'] = options.contentType;
  return backend.app.inject({ method: 'POST', url: `/api/v1/uploads${query}`, headers, payload: bytes });
}

async function register(backend: Context, username: string): Promise<Account> {
  const response = await call(backend, 'POST', '/api/v1/auth/register', undefined,
    { username, displayName: `${username} 中文`, password: 'correct-password-123' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<Account>();
}

async function direct(backend: Context, sender: Account, recipient: Account): Promise<string> {
  const created = await call(backend, 'POST', '/api/v1/friend-requests', sender.token, { userId: recipient.user.id });
  assert.equal(created.statusCode, 201, created.body);
  const accepted = await call(backend, 'POST', `/api/v1/friend-requests/${created.json().id}/respond`, recipient.token, { action: 'accept' });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const conversation = await call(backend, 'POST', '/api/v1/conversations/direct', sender.token, { userId: recipient.user.id });
  assert.equal(conversation.statusCode, 200, conversation.body);
  return conversation.json().id;
}

test('上传：魔数嗅探、sha256、下载字节与安全响应头', async context => {
  const { backend, uploadsDir } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');

  // 刻意带一个「错误」的 Content-Type：服务端必须忽略它，按字节判定为 image/png。
  const created = await upload(backend, alice.token, PNG, { filename: '屏幕截图.png', contentType: 'application/octet-stream' });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.name, '屏幕截图.png');
  assert.equal(body.mimeType, 'image/png');
  assert.equal(body.kind, 'image');
  assert.equal(body.size, PNG.length);
  assert.equal(body.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(body.url, `/api/v1/uploads/${body.id}`);
  assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
  // 落盘文件名由 id + 扩展名决定，客户端文件名不参与路径。
  assert.ok(existsSync(join(uploadsDir, `${body.id}.png`)));

  const downloaded = await call(backend, 'GET', `/api/v1/uploads/${body.id}`, alice.token);
  assert.equal(downloaded.statusCode, 200);
  // 原始字节必须一字不差，且 sha256 与上传响应一致。
  assert.equal(createHash('sha256').update(downloaded.rawPayload).digest('hex'), body.sha256);
  assert.equal(downloaded.headers['content-type'], 'image/png');
  assert.equal(downloaded.headers['content-length'], String(PNG.length));
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  assert.equal(downloaded.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(downloaded.headers['referrer-policy'], 'no-referrer');
  assert.equal(downloaded.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.match(String(downloaded.headers['content-disposition']), /^inline; filename\*=UTF-8''/);

  // 只有属主能读：uuid 不可枚举，用 403 让前端能区分「无权限」与「已删除」。
  const foreign = await call(backend, 'GET', `/api/v1/uploads/${body.id}`, bob.token);
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, 'FORBIDDEN');
  const anonymous = await call(backend, 'GET', `/api/v1/uploads/${body.id}`);
  assert.equal(anonymous.statusCode, 401);
  const missing = await call(backend, 'GET', `/api/v1/uploads/${randomUUID()}`, alice.token);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'UPLOAD_NOT_FOUND');

  // 非图片类型走 attachment 下载，避免 pdf/zip 在浏览器里被当页面打开。
  const pdf = await upload(backend, alice.token, Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'), { filename: '资料.pdf' });
  assert.equal(pdf.statusCode, 201, pdf.body);
  assert.equal(pdf.json().mimeType, 'application/pdf');
  assert.equal(pdf.json().kind, 'file');
  const pdfDownload = await call(backend, 'GET', `/api/v1/uploads/${pdf.json().id}`, alice.token);
  assert.match(String(pdfDownload.headers['content-disposition']), /^attachment; filename\*=UTF-8''/);
});

test('上传：Content-Type 被忽略、纯文本与超限/不支持类型的错误码', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');

  // 带 application/json 上传 PNG 仍必须成功：上传作用域清空了继承的 json parser。
  const jsonHeader = await upload(backend, alice.token, PNG, { filename: 'a.png', contentType: 'application/json' });
  assert.equal(jsonHeader.statusCode, 201, jsonHeader.body);
  assert.equal(jsonHeader.json().mimeType, 'image/png');

  // 纯文本可上传，kind 为 file。
  const text = await upload(backend, alice.token, Buffer.from('你好，世界\n', 'utf8'), { filename: 'note.txt' });
  assert.equal(text.statusCode, 201, text.body);
  assert.equal(text.json().mimeType, 'text/plain');
  assert.equal(text.json().kind, 'file');

  // 空 body：统一 400，与「body 是 0 字节」同一语义。
  const empty = await upload(backend, alice.token, Buffer.alloc(0));
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(empty.json().error.code, 'VALIDATION_ERROR');

  // 可执行文件魔数（MZ）不在白名单 → 415。
  const exe = await upload(backend, alice.token, Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), { filename: 'x.exe' });
  assert.equal(exe.statusCode, 415, exe.body);
  assert.equal(exe.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.ok(exe.json().error.traceId);

  // 超过 10 MiB 业务上限但仍在 11 MiB 传输上限内 → 业务 413（带错误码）。
  const tooLarge = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
  const oversized = await upload(backend, alice.token, tooLarge, { filename: 'big.txt' });
  assert.equal(oversized.statusCode, 413, oversized.body.slice(0, 200));
  assert.equal(oversized.json().error.code, 'UPLOAD_TOO_LARGE');

  // 超过 11 MiB 传输上限 → fastify 解析阶段就拒绝，错误处理器同样映射成 UPLOAD_TOO_LARGE。
  const beyondTransport = await upload(backend, alice.token, Buffer.alloc(11 * 1024 * 1024 + 1, 0x41), { filename: 'bigger.txt' });
  assert.equal(beyondTransport.statusCode, 413, beyondTransport.body.slice(0, 200));
  assert.equal(beyondTransport.json().error.code, 'UPLOAD_TOO_LARGE');

  // 缺 token 一律 401，且不会先解析 body（避免匿名大文件白耗内存）。
  const anonymous = await upload(backend, undefined, PNG, { filename: 'a.png' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'UNAUTHORIZED');

  // 文件名只做展示：路径分隔符与控制字符必须被清掉，且省略时有兜底名。
  const traversal = await upload(backend, alice.token, PNG, { filename: '../../etc/passwd.png' });
  assert.equal(traversal.statusCode, 201);
  assert.equal(traversal.json().name, 'passwd.png');
  const unnamed = await upload(backend, alice.token, PNG);
  assert.equal(unnamed.statusCode, 201);
  assert.equal(unnamed.json().name, '未命名文件');
});

test('附件消息：type 由服务端推导、历史与 sync 可见、不可复用、缺内容报错', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);

  const created = await upload(backend, alice.token, PNG, { filename: '图.png' });
  assert.equal(created.statusCode, 201, created.body);
  const uploadId = created.json().id;

  // v2：发送附件用 attachmentIds 数组，且**必须带非空文字**（产品要求）。
  const sent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '看这张图', attachmentIds: [uploadId] });
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json();
  assert.equal(message.type, 'image');
  assert.equal(message.content, '看这张图');
  assert.equal(message.attachments.length, 1);
  const attachment = message.attachments[0];
  assert.equal(attachment.id, uploadId);
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.url, `/api/v1/uploads/${uploadId}`);
  // Attachment 不暴露 ownerId/sha256：历史消息反复回传哈希没有价值，还会放大载荷。
  assert.deepEqual(Object.keys(attachment).sort(), ['createdAt', 'id', 'kind', 'mimeType', 'name', 'size', 'url']);
  // 单数 attachment 字段已从契约删除，恒为 undefined（前端不再能误读）。
  assert.equal(message.attachment, undefined);
  assert.equal(message.recalled, false);
  assert.equal(message.recalledAt, null);
  assert.equal(message.replyTo, null);

  // 有附件但没有文字 → 400，且文案固定（前端直接展示）。
  const noText = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
  assert.equal(noText.statusCode, 400, noText.body);
  assert.equal(noText.json().error.code, 'VALIDATION_ERROR');
  assert.equal(noText.json().error.message, '发送附件时必须附带文字');

  // 同一 clientMsgId 重试：幂等返回同一条，且仍带 attachments。
  const retried = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: message.clientMsgId, content: '看这张图', attachmentIds: [uploadId] });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().msgId, message.msgId);
  assert.equal(retried.json().attachments[0].id, uploadId);

  // 附件不可被第二条消息复用。
  const reused = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '复用', attachmentIds: [uploadId] });
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().error.code, 'UPLOAD_IN_USE');

  // 历史与增量同步都必须带上 attachments 数组。
  const history = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages`, bob.token);
  assert.equal(history.statusCode, 200, history.body);
  const historyMessage = history.json().items.find((item: { msgId: string }) => item.msgId === message.msgId);
  assert.ok(historyMessage, '历史里应能找到附件消息');
  assert.equal(historyMessage.attachments[0].id, uploadId);
  const sync = await call(backend, 'POST', '/api/v1/sync', bob.token, { cursors: [{ conversationId, lastSeq: 0 }] });
  assert.equal(sync.statusCode, 200, sync.body);
  const synced = sync.json().items[0].messages.find((item: { msgId: string }) => item.msgId === message.msgId);
  assert.equal(synced.attachments[0].id, uploadId);

  // 纯文本消息：attachments 恒为空数组、type 恒为 text（不再接受客户端传 type）。
  const text = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '纯文本' });
  assert.equal(text.statusCode, 201, text.body);
  assert.equal(text.json().type, 'text');
  assert.deepEqual(text.json().attachments, []);
  // 旧客户端的 type 字段现在是多余字段 → 400（契约 §0：请求体 additionalProperties:false）。
  const legacyType = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), type: 'text', content: '老客户端' });
  assert.equal(legacyType.statusCode, 400, legacyType.body);

  // 既无 content 又无附件 → 400；空白 content 同样 400。
  const neither = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID() });
  assert.equal(neither.statusCode, 400, neither.body);
  assert.equal(neither.json().error.code, 'VALIDATION_ERROR');
  const blank = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '   ' });
  assert.equal(blank.statusCode, 400, blank.body);

  // 引用别人的/不存在的附件 → 400 INVALID_ATTACHMENT（不区分「不存在」与「不是你的」，防探测）。
  const bobUpload = await upload(backend, bob.token, PNG, { filename: 'bob.png' });
  assert.equal(bobUpload.statusCode, 201);
  const foreign = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '别人的图', attachmentIds: [bobUpload.json().id] });
  assert.equal(foreign.statusCode, 400, foreign.body);
  assert.equal(foreign.json().error.code, 'INVALID_ATTACHMENT');
  const nonexistent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '不存在的图', attachmentIds: [randomUUID()] });
  assert.equal(nonexistent.statusCode, 400, nonexistent.body);
  assert.equal(nonexistent.json().error.code, 'INVALID_ATTACHMENT');

  // 被消息引用的附件不能删（409）；未引用的可以删（204 且文件真的没了）。
  const inUse = await call(backend, 'DELETE', `/api/v1/uploads/${uploadId}`, alice.token);
  assert.equal(inUse.statusCode, 409, inUse.body);
  assert.equal(inUse.json().error.code, 'UPLOAD_IN_USE');
  const removable = await call(backend, 'DELETE', `/api/v1/uploads/${bobUpload.json().id}`, bob.token);
  assert.equal(removable.statusCode, 204, removable.body);
  assert.equal((await call(backend, 'GET', `/api/v1/uploads/${bobUpload.json().id}`, bob.token)).statusCode, 404);
  assert.equal((await call(backend, 'DELETE', `/api/v1/uploads/${bobUpload.json().id}`, bob.token)).statusCode, 404);
  const foreignDelete = await call(backend, 'DELETE', `/api/v1/uploads/${uploadId}`, bob.token);
  assert.equal(foreignDelete.statusCode, 403, foreignDelete.body);
});

test('迁移：user_version 1 → 最新重建 messages 表且不丢数据', async context => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'aitrance-uploads-'));
  const directory = await mkdtemp(join(tmpdir(), 'aitrance-migrate-'));
  const databasePath = join(directory, 'chat.sqlite');
  // 断言写成 SCHEMA_VERSION 而不是硬编码数字：本文件测的是「v1 到最新的整条迁移链」，
  // 每轮加版本时不该再回来改这个数字（改数字会让「忘了跑新迁移」也看起来通过）。
  const LATEST = SCHEMA_VERSION;
  // 注意：清理钩子必须在「所有 app 都关闭之后」才执行，否则 Windows 上 sqlite 文件仍被持有，
  // rm 会抛 EBUSY。node:test 的 after 按注册顺序执行，所以清理放在本用例末尾注册。

  // 先用当前代码建库并写入一条真实消息，然后把 messages 表「降级」成 v1 形态（无 attachment_id、CHECK 不含 image/file）。
  const first = await buildApp({ databasePath, uploadsDir, logger: false, seedUser: null });
  const alice = await register(first, 'alice');
  const bob = await register(first, 'bob');
  const conversationId = await direct(first, alice, bob);
  const sent = await call(first, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '迁移前的消息' });
  assert.equal(sent.statusCode, 201, sent.body);
  const originalMsgId = sent.json().msgId;
  await first.app.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE messages_v1 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT NOT NULL UNIQUE,
      seq INTEGER NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      client_message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(sender_id, client_message_id),
      UNIQUE(conversation_id, seq)
    );
    INSERT INTO messages_v1(id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at)
      SELECT id, msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_v1 RENAME TO messages;
    CREATE INDEX messages_conversation ON messages(conversation_id, seq);
    PRAGMA user_version = 1;
    COMMIT;
  `);
  assert.equal(Number((legacy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 1);
  const legacyColumns = legacy.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  assert.equal(legacyColumns.some(column => column.name === 'attachment_id'), false, 'v1 应当没有 attachment_id 列');
  legacy.close();

  // 重启：构造函数里的 migrate() 必须把表升级到最新版本，且原有消息完好。
  const second = await buildApp({ databasePath, uploadsDir, logger: false, seedUser: null });
  context.after(() => second.app.close());
  assert.equal(Number((second.store.get<{ user_version: number }>('PRAGMA user_version')!).user_version), LATEST);
  const tableSql = second.store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")!.sql;
  assert.ok(tableSql.includes("'image'"), '升级后的 CHECK 必须包含 image/file');
  // v4 把单附件列换成了 message_attachments 关联表：messages 不应再有 attachment_id。
  assert.ok(!tableSql.includes('attachment_id'), 'v4 之后 messages 不应再有 attachment_id 列');
  assert.ok(tableSql.includes('recalled_at'), 'v4 之后 messages 必须有 recalled_at 列');
  assert.ok(tableSql.includes('reply_to_msg_id'), 'v4 之后 messages 必须有 reply_to_msg_id 列');
  assert.ok(second.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_attachments'"));
  const preserved = await call(second, 'GET', `/api/v1/conversations/${conversationId}/messages`, alice.token);
  assert.equal(preserved.statusCode, 200, preserved.body);
  assert.ok(preserved.json().items.some((item: { msgId: string }) => item.msgId === originalMsgId), '迁移不能丢消息');
  // 升级后附件消息必须能正常写入。
  const upgradeUpload = await upload(second, alice.token, PNG, { filename: '迁移后.png' });
  assert.equal(upgradeUpload.statusCode, 201, upgradeUpload.body);
  const attached = await call(second, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '迁移后的图', attachmentIds: [upgradeUpload.json().id] });
  assert.equal(attached.statusCode, 201, attached.body);
  assert.equal(attached.json().type, 'image');
  // 再启动一次不会重复迁移（幂等）。
  await second.app.close();
  const third = await buildApp({ databasePath, uploadsDir, logger: false, seedUser: null });
  context.after(() => third.app.close());
  assert.equal(Number((third.store.get<{ user_version: number }>('PRAGMA user_version')!).user_version), LATEST);
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  context.after(() => rm(directory, { recursive: true, force: true }));
});

test('保留策略：sweep 只清理「无消息引用且已过期」的孤儿上传', async context => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'aitrance-uploads-'));
  const backend = await buildApp({ databasePath: ':memory:', uploadsDir, logger: false, retentionMessageDays: 1, seedUser: null });
  context.after(() => backend.app.close());
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);

  const orphan = await upload(backend, alice.token, PNG, { filename: '孤儿.png' });
  const referenced = await upload(backend, alice.token, PNG, { filename: '被引用.png' });
  assert.equal(orphan.statusCode, 201);
  assert.equal(referenced.statusCode, 201);
  const attached = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), content: '被引用的图', attachmentIds: [referenced.json().id] });
  assert.equal(attached.statusCode, 201, attached.body);

  // 只把两个上传记录做旧，消息保持新鲜 —— 这样 sweep 不会删消息，引用关系仍然成立。
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  backend.store.run('UPDATE uploads SET created_at = ?', old);

  const report = backend.realtime.sweep('manual');
  assert.equal(report.uploads, 1, '只应清掉 1 个孤儿上传');
  assert.equal(existsSync(join(uploadsDir, `${orphan.json().id}.png`)), false, '孤儿文件必须从磁盘删除');
  assert.ok(existsSync(join(uploadsDir, `${referenced.json().id}.png`)), '被引用的文件不能删');
  assert.equal(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', orphan.json().id), undefined);
  assert.ok(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', referenced.json().id));
  // 被引用的附件仍可正常下载。
  assert.equal((await call(backend, 'GET', `/api/v1/uploads/${referenced.json().id}`, alice.token)).statusCode, 200);
});

test('回归：全局 JSON bodyLimit 仍是 64KiB，未因上传被放大', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  // 上传作用域把 bodyLimit 提到 101 MiB（视频上限），但其他接口必须保持 64KiB ——
  // 否则任何接口都能被塞大 body，这是一个容易被顺手改坏的边界。
  // 64KiB 是 v2 契约：广场正文 5000 字 + JSON 转义/多字节开销，32KiB 已经不够。
  const huge = await backend.app.inject({
    method: 'POST', url: '/api/v1/sync',
    headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ cursors: [], padding: 'x'.repeat(80 * 1024) }),
  });
  assert.equal(huge.statusCode, 413, huge.body.slice(0, 200));
  assert.equal(huge.json().error.code, 'UPLOAD_TOO_LARGE');
});
