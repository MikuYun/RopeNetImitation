import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { MAX_STICKER_BYTES } from '../src/upload.ts';

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account { token: string; user: { id: string; username: string }; expiresAt: string }

/** 最小合法 1x1 透明 PNG。表情包只收图片，这个字节串会被魔数嗅探命中 image/png。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 真 PDF 头。用来验证「kind=file 的上传不能当表情包」。 */
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

/**
 * 每个用例一个独立的上传目录。
 * deleteSticker 会连带删磁盘文件，所以必须用真实目录才能验证「文件真的没了」。
 */
async function fixture(context: TestContext, options: { retentionMessageDays?: number } = {}) {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'aitrance-stickers-'));
  const backend = await buildApp({
    databasePath: ':memory:',
    uploadsDir,
    logger: false,
    seedUser: null,
    ...(options.retentionMessageDays === undefined ? {} : { retentionMessageDays: options.retentionMessageDays }),
  });
  // after 钩子按注册顺序执行：先关 app 再删目录。
  context.after(() => backend.app.close());
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  return { backend, uploadsDir };
}

async function call(backend: Context, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

async function upload(backend: Context, token: string | undefined, bytes: Buffer, filename?: string) {
  const query = filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
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

/** 上传一张 PNG 并返回 uploadId。 */
async function uploadPng(backend: Context, token: string, filename = '表情.png'): Promise<string> {
  const created = await upload(backend, token, PNG, filename);
  assert.equal(created.statusCode, 201, created.body);
  return created.json().id as string;
}

test('表情包：收藏图片上传 → 列表可见 → 删除', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const uploadId = await uploadPng(backend, alice.token);

  const created = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(created.statusCode, 201, created.body);
  const sticker = created.json();
  assert.equal(sticker.uploadId, uploadId);
  assert.equal(sticker.kind, 'image');
  assert.equal(sticker.mimeType, 'image/png');
  assert.equal(sticker.size, PNG.length);
  assert.equal(sticker.name, '表情.png', '表情包继承 upload 的展示名');
  assert.equal(sticker.url, `/api/v1/uploads/${uploadId}`);
  // 契约固定的字段集合：不多不少（owner_id/upload_id 之类的内部列不外泄）。
  assert.deepEqual(Object.keys(sticker).sort(),
    ['createdAt', 'id', 'kind', 'mimeType', 'name', 'size', 'uploadId', 'url']);

  const listed = await call(backend, 'GET', '/api/v1/stickers', alice.token);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].id, sticker.id);
  assert.equal(listed.json().nextOffset, null);

  const removed = await call(backend, 'DELETE', `/api/v1/stickers/${sticker.id}`, alice.token);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { ok: true });
  const after = await call(backend, 'GET', '/api/v1/stickers', alice.token);
  assert.equal(after.json().items.length, 0);
});

test('表情包：同一 upload 重复收藏是幂等（200 且返回同一个对象）', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const uploadId = await uploadPng(backend, alice.token);

  const first = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(first.statusCode, 201, first.body);
  const second = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().id, first.json().id, '幂等必须返回同一个表情包 id');
  // 库里只有一行，不能因为点了两次就出现两个表情包。
  const listed = await call(backend, 'GET', '/api/v1/stickers', alice.token);
  assert.equal(listed.json().items.length, 1);
});

test('表情包：非图片上传与不存在/他人的 upload 一律 400 INVALID_STICKER', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');

  const pdf = await upload(backend, alice.token, PDF, '文档.pdf');
  assert.equal(pdf.statusCode, 201, pdf.body);
  assert.equal(pdf.json().kind, 'file');

  const notImage = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: pdf.json().id });
  assert.equal(notImage.statusCode, 400, notImage.body);
  assert.equal(notImage.json().error.code, 'INVALID_STICKER');
  assert.equal(notImage.json().error.message, '表情包只支持 PNG/JPEG/WebP/GIF 图片');

  // 他人的 upload：不能靠 uuid 猜测把别人的图收藏成自己的表情包。
  const alicePng = await uploadPng(backend, alice.token, '别人的图.png');
  const foreign = await call(backend, 'POST', '/api/v1/stickers', bob.token, { uploadId: alicePng });
  assert.equal(foreign.statusCode, 400, foreign.body);
  assert.equal(foreign.json().error.code, 'INVALID_STICKER');

  // 不存在的 upload 与上面归一到同一个错误，避免成为「uuid 是否存在」的探测面。
  const missing = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: randomUUID() });
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().error.code, 'INVALID_STICKER');
});

test('表情包：超过 2 MiB 的上传收藏时 413 STICKER_TOO_LARGE（服务端兜底客户端压缩）', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');

  // 魔数仍是 PNG，但体积超过 MAX_STICKER_BYTES（2 MiB）：用尾部补零撑大，
  // 这样 createUpload 的 50 MiB 上限不会先拦，能精确命中表情包自己的那道限制。
  const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_STICKER_BYTES)]);
  const created = await upload(backend, alice.token, oversized, '超大有图.png');
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().size, oversized.length);

  const rejected = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: created.json().id });
  assert.equal(rejected.statusCode, 413, rejected.body);
  assert.equal(rejected.json().error.code, 'STICKER_TOO_LARGE');
  // 文案要能直接给用户看：说明是「单张表情」而非「单个文件」，并给出可执行动作。
  assert.match(rejected.json().error.message, /表情包单张不能超过/);
  assert.match(rejected.json().error.message, /裁剪|压缩/);

  // 恰好等于上限的图必须放行 —— 边界不能写错成 >=。
  const boundary = Buffer.concat([PNG, Buffer.alloc(MAX_STICKER_BYTES - PNG.length)]);
  assert.equal(boundary.length, MAX_STICKER_BYTES);
  const boundaryUpload = await upload(backend, alice.token, boundary, '刚好.png');
  assert.equal(boundaryUpload.statusCode, 201, boundaryUpload.body);
  const accepted = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: boundaryUpload.json().id });
  assert.equal(accepted.statusCode, 201, accepted.body);

  // 超限的上传没有变成表情包，列表里只有边界那张。
  const listed = await call(backend, 'GET', '/api/v1/stickers', alice.token);
  assert.equal(listed.json().items.length, 1);
});

test('表情包：删除不存在 404、非本人 403，列表只返回本人', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const uploadId = await uploadPng(backend, alice.token);
  const created = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(created.statusCode, 201, created.body);

  const missing = await call(backend, 'DELETE', `/api/v1/stickers/${randomUUID()}`, alice.token);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().error.code, 'STICKER_NOT_FOUND');

  const forbidden = await call(backend, 'DELETE', `/api/v1/stickers/${created.json().id}`, bob.token);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().error.code, 'FORBIDDEN');

  // 列表按 owner 隔离：bob 看不到 alice 的表情包。
  const bobList = await call(backend, 'GET', '/api/v1/stickers', bob.token);
  assert.equal(bobList.statusCode, 200, bobList.body);
  assert.deepEqual(bobList.json().items, []);
});

test('表情包：可以反复发送同一个附件，不再 409', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const uploadId = await uploadPng(backend, alice.token);
  const sticker = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(sticker.statusCode, 201, sticker.body);

  // 第一发：正常成功。
  const first = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().type, 'image');

  // 第二、第三次：表情包的意义就是反复发送，这里必须仍然 201 而不是 409 UPLOAD_IN_USE。
  for (let index = 0; index < 2; index += 1) {
    const again = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
      { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json().attachments[0].id, uploadId);
  }

  const history = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages`, bob.token);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items.length, 3, '三条表情包消息都要保留在历史里');
});

test('表情包：普通附件（未收藏）仍不可复用，语义没被放宽', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const uploadId = await uploadPng(backend, alice.token);

  const first = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
  assert.equal(first.statusCode, 201, first.body);
  const reused = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().error.code, 'UPLOAD_IN_USE');
});

test('表情包：被表情包引用的上传不能删（409 UPLOAD_IN_USE）', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const uploadId = await uploadPng(backend, alice.token);
  const sticker = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(sticker.statusCode, 201, sticker.body);

  const removed = await call(backend, 'DELETE', `/api/v1/uploads/${uploadId}`, alice.token);
  assert.equal(removed.statusCode, 409, removed.body);
  assert.equal(removed.json().error.code, 'UPLOAD_IN_USE');
  assert.equal(removed.json().error.message, '该附件已被表情包引用');

  // 删掉表情包之后，这个上传就不再被引用，可以正常删除。
  assert.equal((await call(backend, 'DELETE', `/api/v1/stickers/${sticker.json().id}`, alice.token)).statusCode, 200);
  // 注意：deleteSticker 在无任何引用时会连带删掉 upload 本身，所以这里再删 upload 会 404。
  const uploadGone = await call(backend, 'DELETE', `/api/v1/uploads/${uploadId}`, alice.token);
  assert.equal(uploadGone.statusCode, 404, uploadGone.body);
  assert.equal(uploadGone.json().error.code, 'UPLOAD_NOT_FOUND');
});

test('表情包：删除表情包时，无引用的 upload 连同磁盘文件一起清掉', async context => {
  const { backend, uploadsDir } = await fixture(context);
  const alice = await register(backend, 'alice');
  const uploadId = await uploadPng(backend, alice.token);
  const sticker = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(sticker.statusCode, 201, sticker.body);
  assert.ok(existsSync(join(uploadsDir, `${uploadId}.png`)), '上传后磁盘上应有文件');

  assert.equal((await call(backend, 'DELETE', `/api/v1/stickers/${sticker.json().id}`, alice.token)).statusCode, 200);
  assert.equal(backend.store.get('SELECT 1 FROM stickers WHERE id = ?', sticker.json().id), undefined);
  assert.equal(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', uploadId), undefined, '无引用的 upload 应被清理');
  assert.equal(existsSync(join(uploadsDir, `${uploadId}.png`)), false, '磁盘文件也应删除');
});

test('表情包：删除表情包时，已被消息引用的 upload 必须保留', async context => {
  const { backend, uploadsDir } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const uploadId = await uploadPng(backend, alice.token);
  const sticker = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
  assert.equal(sticker.statusCode, 201, sticker.body);
  const sent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token,
    { clientMsgId: randomUUID(), attachmentIds: [uploadId] });
  assert.equal(sent.statusCode, 201, sent.body);

  assert.equal((await call(backend, 'DELETE', `/api/v1/stickers/${sticker.json().id}`, alice.token)).statusCode, 200);
  // 还有消息在引用：不能连带删 upload，否则历史消息里的这张图会变成永久 404 的破图。
  assert.ok(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', uploadId), '被消息引用的 upload 必须保留');
  assert.ok(existsSync(join(uploadsDir, `${uploadId}.png`)), '文件也必须保留');
  assert.equal((await call(backend, 'GET', `/api/v1/uploads/${uploadId}`, bob.token)).statusCode, 200);
});

test('表情包：列表分页与本人隔离（nextOffset 语义）', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  for (let index = 0; index < 3; index += 1) {
    const uploadId = await uploadPng(backend, alice.token, `图${index}.png`);
    const created = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId });
    assert.equal(created.statusCode, 201, created.body);
  }
  // bob 也收藏一张自己的，列表不能被串台。
  const bobUpload = await uploadPng(backend, bob.token, 'bob.png');
  assert.equal((await call(backend, 'POST', '/api/v1/stickers', bob.token, { uploadId: bobUpload })).statusCode, 201);

  const firstPage = await call(backend, 'GET', '/api/v1/stickers?limit=2&offset=0', alice.token);
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.equal(firstPage.json().items.length, 2);
  assert.equal(firstPage.json().nextOffset, 2);

  const secondPage = await call(backend, 'GET', '/api/v1/stickers?limit=2&offset=2', alice.token);
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.equal(secondPage.json().items.length, 1);
  assert.equal(secondPage.json().nextOffset, null);

  // 两页合起来正好是 alice 的 3 张，没有 bob 的那张。
  const ids = [...firstPage.json().items, ...secondPage.json().items].map((item: { id: string }) => item.id);
  assert.equal(new Set(ids).size, 3);

  const bobList = await call(backend, 'GET', '/api/v1/stickers', bob.token);
  assert.equal(bobList.json().items.length, 1);
  assert.equal(bobList.json().items[0].uploadId, bobUpload);
});

test('表情包：保留策略 sweep 不会清掉被表情包引用的上传', async context => {
  const { backend } = await fixture(context, { retentionMessageDays: 1 });
  const alice = await register(backend, 'alice');
  const stickerUpload = await uploadPng(backend, alice.token, '收藏的.png');
  const orphanUpload = await uploadPng(backend, alice.token, '没人用的.png');
  const sticker = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: stickerUpload });
  assert.equal(sticker.statusCode, 201, sticker.body);

  // 把两个上传都做旧：sweep 只该清掉没有表情包引用的那一个。
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  backend.store.run('UPDATE uploads SET created_at = ?', old);

  const report = backend.realtime.sweep('manual');
  assert.equal(report.uploads, 1, '只应清掉 1 个真正无引用的上传');
  assert.ok(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', stickerUpload), '表情包引用的上传不能删');
  assert.equal(backend.store.get('SELECT 1 FROM uploads WHERE id = ?', orphanUpload), undefined);
  // 表情包本身还在，列表仍能读到。
  const listed = await call(backend, 'GET', '/api/v1/stickers', alice.token);
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].uploadId, stickerUpload);
});

test('表情包：未登录 401、body 缺 uploadId 400', async context => {
  const { backend } = await fixture(context);
  const anonymous = await call(backend, 'GET', '/api/v1/stickers');
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const alice = await register(backend, 'alice');
  const invalid = await call(backend, 'POST', '/api/v1/stickers', alice.token, {});
  assert.equal(invalid.statusCode, 400, invalid.body);
  const notUuid = await call(backend, 'POST', '/api/v1/stickers', alice.token, { uploadId: 'not-a-uuid' });
  assert.equal(notUuid.statusCode, 400, notUuid.body);
});
