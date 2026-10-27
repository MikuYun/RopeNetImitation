import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';

type Context = Awaited<ReturnType<typeof buildApp>>;
interface Account { token: string; user: { id: string; username: string }; expiresAt: string }

/** 最小合法 1x1 透明 PNG（真实字节，魔数嗅探必须靠它命中 image/png）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 最小合法 MP4 头：偏移 4..8 必须是 'ftyp'（upload.ts 的 video/mp4 嗅探规则）。
 * 内容本身不可播放，测试只关心「服务端按字节判定为 video」。
 */
const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);

/**
 * 每个用例一个独立临时上传目录（附件真的要落盘）。
 * after 钩子按注册顺序执行：先关 app，再删目录。
 */
async function fixture(context: TestContext) {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'aitrance-v2-'));
  const backend = await buildApp({ databasePath: ':memory:', uploadsDir, logger: false });
  context.after(() => backend.app.close());
  context.after(() => rm(uploadsDir, { recursive: true, force: true }));
  return { backend, uploadsDir };
}

async function call(backend: Context, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
  return backend.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
}

async function upload(backend: Context, token: string, bytes: Buffer, filename = 'a.bin') {
  const response = await backend.app.inject({
    method: 'POST',
    url: `/api/v1/uploads?filename=${encodeURIComponent(filename)}`,
    headers: { authorization: `Bearer ${token}` },
    payload: bytes,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ id: string; kind: string; mimeType: string }>();
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

test('v2 消息：多附件（2 图 + 文字）按数组顺序返回，type 推导为 image、content 保留', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);

  const first = await upload(backend, alice.token, PNG, 'one.png');
  const second = await upload(backend, alice.token, PNG, 'two.png');
  assert.equal(first.kind, 'image');
  assert.equal(second.kind, 'image');

  const sent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '两张图一起发',
    attachmentIds: [first.id, second.id],
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json();
  assert.equal(message.attachments.length, 2);
  assert.equal(message.attachments[0].id, first.id);
  assert.equal(message.attachments[1].id, second.id);
  assert.equal(message.attachments[0].kind, 'image');
  assert.equal(message.content, '两张图一起发');
  assert.equal(message.type, 'image');
  assert.equal(message.recalled, false);
  assert.equal(message.recalledAt, null);
  assert.equal(message.replyTo, null);
  // 旧的单数 attachment 字段已彻底删除（不是 null，而是不存在）。
  assert.equal(Object.hasOwn(message, 'attachment'), false);

  // 幂等重试：同 clientMsgId + 同内容 + 同附件集合 → 200 原消息。
  const retried = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: message.clientMsgId,
    content: '两张图一起发',
    attachmentIds: [first.id, second.id],
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().msgId, message.msgId);

  // 附件顺序不同视为同一集合，仍然幂等（集合比较，不是数组比较）。
  const reordered = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: message.clientMsgId,
    content: '两张图一起发',
    attachmentIds: [second.id, first.id],
  });
  assert.equal(reordered.statusCode, 200, reordered.body);

  // 换附件集合 → 409 IDEMPOTENCY_CONFLICT。
  const third = await upload(backend, alice.token, PNG, 'three.png');
  const conflict = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: message.clientMsgId,
    content: '两张图一起发',
    attachmentIds: [first.id, third.id],
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
});

test('v2 消息：有附件但没文字 → 400「发送附件时必须附带文字」；纯空白同样拒绝', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const image = await upload(backend, alice.token, PNG, 'only.png');

  const missing = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    attachmentIds: [image.id],
  });
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().error.code, 'VALIDATION_ERROR');
  assert.equal(missing.json().error.message, '发送附件时必须附带文字');

  const blank = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '   ',
    attachmentIds: [image.id],
  });
  assert.equal(blank.statusCode, 400, blank.body);
  assert.equal(blank.json().error.code, 'VALIDATION_ERROR');

  // 无附件且无内容 → 同样 400（兜底文案不同）。
  const empty = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
  });
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(empty.json().error.code, 'VALIDATION_ERROR');
});

test('v2 消息：两个视频 → 400 ATTACHMENT_LIMIT；附件不属于自己 → 400 INVALID_ATTACHMENT', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);

  const videoOne = await upload(backend, alice.token, MP4, 'one.mp4');
  const videoTwo = await upload(backend, alice.token, MP4, 'two.mp4');
  assert.equal(videoOne.kind, 'video');
  assert.equal(videoOne.mimeType, 'video/mp4');

  const tooManyVideos = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '两个视频',
    attachmentIds: [videoOne.id, videoTwo.id],
  });
  assert.equal(tooManyVideos.statusCode, 400, tooManyVideos.body);
  assert.equal(tooManyVideos.json().error.code, 'ATTACHMENT_LIMIT');

  // 单个视频 + 图片 = 混合消息，允许。
  const image = await upload(backend, alice.token, PNG, 'mix.png');
  const mixed = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '视频和图',
    attachmentIds: [videoOne.id, image.id],
  });
  assert.equal(mixed.statusCode, 201, mixed.body);
  assert.equal(mixed.json().type, 'mixed');

  // bob 的附件不能被 alice 拿去发消息。
  const foreign = await upload(backend, bob.token, PNG, 'bob.png');
  const rejected = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '偷用别人的图',
    attachmentIds: [foreign.id],
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal(rejected.json().error.code, 'INVALID_ATTACHMENT');
});

test('v2 消息：120 秒内撤回成功，content 清空、附件释放，重复撤回幂等', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);
  const image = await upload(backend, alice.token, PNG, 'recall.png');

  const sent = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '这条要被撤回',
    attachmentIds: [image.id],
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json();

  // 非发送者不能撤回。
  const forbidden = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages/${message.msgId}/recall`, bob.token);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().error.code, 'FORBIDDEN');

  const recalled = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages/${message.msgId}/recall`, alice.token);
  assert.equal(recalled.statusCode, 200, recalled.body);
  const updated = recalled.json();
  assert.equal(updated.recalled, true);
  assert.equal(updated.content, '');
  assert.deepEqual(updated.attachments, []);
  assert.ok(updated.recalledAt, 'recalledAt 必须有值');
  assert.equal(updated.msgId, message.msgId);

  // 历史里同样脱敏。
  const history = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages?limit=30`, bob.token);
  assert.equal(history.statusCode, 200, history.body);
  const inHistory = history.json().items.find((item: { msgId: string }) => item.msgId === message.msgId);
  assert.ok(inHistory);
  assert.equal(inHistory.recalled, true);
  assert.equal(inHistory.content, '');
  assert.deepEqual(inHistory.attachments, []);

  // 重复撤回幂等：200 且不再变化。
  const again = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages/${message.msgId}/recall`, alice.token);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().recalled, true);

  // 撤回后附件被释放：同一个 upload 可以重新用于新消息。
  const reused = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '撤回后重新用这张图',
    attachmentIds: [image.id],
  });
  assert.equal(reused.statusCode, 201, reused.body);
  assert.equal(reused.json().attachments.length, 1);
});

test('v2 消息：引用回复带 replyTo 快照；引用已撤回消息返回「[消息已撤回]」', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const conversationId = await direct(backend, alice, bob);

  const original = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, alice.token, {
    clientMsgId: randomUUID(),
    content: '被引用的原始消息',
  });
  assert.equal(original.statusCode, 201, original.body);
  const target = original.json();

  const reply = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, bob.token, {
    clientMsgId: randomUUID(),
    content: '我回复你',
    replyToMsgId: target.msgId,
  });
  assert.equal(reply.statusCode, 201, reply.body);
  const replied = reply.json();
  assert.equal(replied.replyTo.msgId, target.msgId);
  assert.equal(replied.replyTo.senderId, alice.user.id);
  assert.equal(replied.replyTo.senderName, 'alice 中文');
  assert.equal(replied.replyTo.preview, '被引用的原始消息');

  // 引用不存在的消息 → 400。
  const ghost = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages`, bob.token, {
    clientMsgId: randomUUID(),
    content: '引用幽灵',
    replyToMsgId: randomUUID(),
  });
  assert.equal(ghost.statusCode, 400, ghost.body);
  assert.equal(ghost.json().error.code, 'VALIDATION_ERROR');
  assert.equal(ghost.json().error.message, '引用的消息不存在');

  // 原消息撤回后，引用预览统一为「[消息已撤回]」。
  const recall = await call(backend, 'POST', `/api/v1/conversations/${conversationId}/messages/${target.msgId}/recall`, alice.token);
  assert.equal(recall.statusCode, 200, recall.body);
  const after = await call(backend, 'GET', `/api/v1/conversations/${conversationId}/messages?limit=30`, bob.token);
  const afterReply = after.json().items.find((item: { msgId: string }) => item.msgId === replied.msgId);
  assert.equal(afterReply.replyTo.preview, '[消息已撤回]');
});

test('v2 访客资料：陌生人 relationship=none 且带 postCount/friendCount；非 UUID 自动 400', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const carol = await register(backend, 'carol');

  const stranger = await call(backend, 'GET', `/api/v1/users/${bob.user.id}`, alice.token);
  assert.equal(stranger.statusCode, 200, stranger.body);
  const profile = stranger.json();
  assert.equal(profile.relationship, 'none');
  assert.equal(profile.conversationId, null);
  assert.equal(profile.postCount, 0);
  assert.equal(profile.friendCount, 0);
  assert.equal(profile.user.id, bob.user.id);
  assert.equal(Object.hasOwn(profile.user, 'passwordHash'), false);
  assert.equal(Object.hasOwn(profile.user, 'password_hash'), false);

  // /users/me 仍然命中自身，不会被 :userId 抢走。
  const me = await call(backend, 'GET', '/api/v1/users/me', alice.token);
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().username, 'alice');

  // 非 UUID 的 :userId 直接 400，不会拿去做 SQL。
  const invalid = await call(backend, 'GET', '/api/v1/users/not-a-uuid', alice.token);
  assert.equal(invalid.statusCode, 400, invalid.body);

  const missing = await call(backend, 'GET', `/api/v1/users/${randomUUID()}`, alice.token);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().error.code, 'NOT_FOUND');

  // 加好友后 relationship=friend，会话建立后 conversationId 有值，好友数双向计数。
  const conversationId = await direct(backend, alice, bob);
  const friend = (await call(backend, 'GET', `/api/v1/users/${bob.user.id}`, alice.token)).json();
  assert.equal(friend.relationship, 'friend');
  assert.equal(friend.conversationId, conversationId);
  assert.equal(friend.friendCount, 1);

  // 待处理申请的两个方向。
  const request = await call(backend, 'POST', '/api/v1/friend-requests', alice.token, { userId: carol.user.id });
  assert.equal(request.statusCode, 201, request.body);
  const sent = (await call(backend, 'GET', `/api/v1/users/${carol.user.id}`, alice.token)).json();
  assert.equal(sent.relationship, 'request_sent');
  const received = (await call(backend, 'GET', `/api/v1/users/${alice.user.id}`, carol.token)).json();
  assert.equal(received.relationship, 'request_received');

  // self
  const self = (await call(backend, 'GET', `/api/v1/users/${alice.user.id}`, alice.token)).json();
  assert.equal(self.relationship, 'self');
});

test('v2 广场：发帖→列表→点赞/取消→评论/删评论→删帖后列表不可见', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');

  const created = await call(backend, 'POST', '/api/v1/posts', alice.token, { content: '你好，广场' });
  assert.equal(created.statusCode, 201, created.body);
  const post = created.json();
  assert.equal(post.content, '你好，广场');
  assert.equal(post.likeCount, 0);
  assert.equal(post.commentCount, 0);
  assert.equal(post.likedByMe, false);
  assert.equal(post.mine, true);
  assert.equal(post.author.id, alice.user.id);
  assert.deepEqual(post.attachments, []);

  // 列表可见 + mine/likedByMe 按 viewer 计算。
  const listed = await call(backend, 'GET', '/api/v1/posts?limit=20', bob.token);
  assert.equal(listed.statusCode, 200, listed.body);
  const page = listed.json();
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(page.items[0].id, post.id);
  assert.equal(page.items[0].mine, false);
  assert.equal(page.items[0].likedByMe, false);

  // 详情
  const detail = await call(backend, 'GET', `/api/v1/posts/${post.id}`, bob.token);
  assert.equal(detail.statusCode, 200, detail.body);

  // 点赞 / 取消（幂等）
  const liked = await call(backend, 'POST', `/api/v1/posts/${post.id}/like`, bob.token);
  assert.equal(liked.statusCode, 200, liked.body);
  assert.deepEqual(liked.json(), { liked: true, likeCount: 1 });
  const likedAgain = await call(backend, 'POST', `/api/v1/posts/${post.id}/like`, bob.token);
  assert.deepEqual(likedAgain.json(), { liked: true, likeCount: 1 });
  const likedView = (await call(backend, 'GET', `/api/v1/posts/${post.id}`, bob.token)).json();
  assert.equal(likedView.likedByMe, true);
  assert.equal(likedView.likeCount, 1);

  const unliked = await call(backend, 'DELETE', `/api/v1/posts/${post.id}/like`, bob.token);
  assert.equal(unliked.statusCode, 200, unliked.body);
  assert.deepEqual(unliked.json(), { liked: false, likeCount: 0 });

  // 评论：顶层 + 回复
  const comment = await call(backend, 'POST', `/api/v1/posts/${post.id}/comments`, bob.token, { content: '第一条评论' });
  assert.equal(comment.statusCode, 201, comment.body);
  const top = comment.json();
  assert.equal(top.content, '第一条评论');
  assert.equal(top.replyToId, null);
  assert.equal(top.replyToAuthorName, null);
  assert.equal(top.author.id, bob.user.id);

  const nested = await call(backend, 'POST', `/api/v1/posts/${post.id}/comments`, alice.token, {
    content: '回复你', replyToId: top.id,
  });
  assert.equal(nested.statusCode, 201, nested.body);
  assert.equal(nested.json().replyToAuthorName, 'bob 中文');

  const comments = await call(backend, 'GET', `/api/v1/posts/${post.id}/comments?limit=20`, alice.token);
  assert.equal(comments.statusCode, 200, comments.body);
  const commentPage = comments.json();
  assert.equal(commentPage.items.length, 2);
  assert.equal(commentPage.items[0].id, top.id);
  assert.equal(commentPage.items[1].replyToAuthorName, 'bob 中文');
  assert.equal((await call(backend, 'GET', `/api/v1/posts/${post.id}`, alice.token)).json().commentCount, 2);

  // 删评论：非作者非管理员 403；作者自己删 204 且 commentCount 重算。
  const foreignDelete = await call(backend, 'DELETE', `/api/v1/posts/${post.id}/comments/${top.id}`, alice.token);
  assert.equal(foreignDelete.statusCode, 403, foreignDelete.body);
  const deleteComment = await call(backend, 'DELETE', `/api/v1/posts/${post.id}/comments/${top.id}`, bob.token);
  assert.equal(deleteComment.statusCode, 204, deleteComment.body);
  assert.equal((await call(backend, 'GET', `/api/v1/posts/${post.id}`, alice.token)).json().commentCount, 1);

  // 作者主页帖子
  const authorPosts = await call(backend, 'GET', `/api/v1/users/${alice.user.id}/posts`, bob.token);
  assert.equal(authorPosts.statusCode, 200, authorPosts.body);
  assert.equal(authorPosts.json().items.length, 1);

  // 删帖：非作者非管理员 403，作者 204，之后列表与详情都不可见。
  const foreignPostDelete = await call(backend, 'DELETE', `/api/v1/posts/${post.id}`, bob.token);
  assert.equal(foreignPostDelete.statusCode, 403, foreignPostDelete.body);
  const deleted = await call(backend, 'DELETE', `/api/v1/posts/${post.id}`, alice.token);
  assert.equal(deleted.statusCode, 204, deleted.body);
  const afterDelete = await call(backend, 'GET', '/api/v1/posts?limit=20', bob.token);
  assert.equal(afterDelete.json().items.length, 0);
  const gone = await call(backend, 'GET', `/api/v1/posts/${post.id}`, bob.token);
  assert.equal(gone.statusCode, 404, gone.body);
});

test('v2 广场：不允许通用文件附件（400 ATTACHMENT_LIMIT）；图片帖 attachments 带 kind', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');

  const note = await upload(backend, alice.token, Buffer.from('纯文本附件\n', 'utf8'), 'note.txt');
  assert.equal(note.kind, 'file');
  const rejected = await call(backend, 'POST', '/api/v1/posts', alice.token, {
    content: '带文件的帖子', attachmentIds: [note.id],
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal(rejected.json().error.code, 'ATTACHMENT_LIMIT');

  // 纯附件帖（无正文）允许，但必须有附件。
  const image = await upload(backend, alice.token, PNG, 'pic.png');
  const imageOnly = await call(backend, 'POST', '/api/v1/posts', alice.token, { attachmentIds: [image.id] });
  assert.equal(imageOnly.statusCode, 201, imageOnly.body);
  assert.equal(imageOnly.json().content, '');
  assert.equal(imageOnly.json().attachments.length, 1);
  assert.equal(imageOnly.json().attachments[0].kind, 'image');

  // 正文与附件同时为空 → 400。
  const empty = await call(backend, 'POST', '/api/v1/posts', alice.token, { content: '   ' });
  assert.equal(empty.statusCode, 400, empty.body);
  assert.equal(empty.json().error.code, 'VALIDATION_ERROR');

  // 广场点赞/评论不存在帖子 → 404。
  const nowhere = randomUUID();
  assert.equal((await call(backend, 'POST', `/api/v1/posts/${nowhere}/like`, alice.token)).statusCode, 404);
  assert.equal((await call(backend, 'POST', `/api/v1/posts/${nowhere}/comments`, alice.token, { content: 'x' })).statusCode, 404);
});

test('v2 上传：头像设为 upload 后对非好友非同会话的登录用户公开可读', async context => {
  const { backend } = await fixture(context);
  const alice = await register(backend, 'alice');
  const bob = await register(backend, 'bob');
  const image = await upload(backend, alice.token, PNG, 'avatar.png');

  const patched = await call(backend, 'PATCH', '/api/v1/users/me', alice.token, { avatarUrl: `/api/v1/uploads/${image.id}` });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().avatarUrl, `/api/v1/uploads/${image.id}`);

  // 陌生人（无好友关系、无共同会话）也能读到用作头像的图片。
  const fetched = await call(backend, 'GET', `/api/v1/uploads/${image.id}`, bob.token);
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.headers['content-type'], 'image/png');

  // 未登录仍然 401。
  const anonymous = await call(backend, 'GET', `/api/v1/uploads/${image.id}`);
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  // 既非头像、也未被消息/帖子引用 → 403。
  const orphan = await upload(backend, alice.token, Buffer.from('孤儿文件\n', 'utf8'), 'orphan.txt');
  const denied = await call(backend, 'GET', `/api/v1/uploads/${orphan.id}`, bob.token);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, 'FORBIDDEN');

  // 帖子引用的附件对任意登录用户可读；帖子软删后不可读。
  const picture = await upload(backend, alice.token, PNG, 'post.png');
  const post = await call(backend, 'POST', '/api/v1/posts', alice.token, { content: '图', attachmentIds: [picture.id] });
  assert.equal(post.statusCode, 201, post.body);
  assert.equal((await call(backend, 'GET', `/api/v1/uploads/${picture.id}`, bob.token)).statusCode, 200);
  assert.equal((await call(backend, 'DELETE', `/api/v1/posts/${post.json().id}`, alice.token)).statusCode, 204);
  assert.equal((await call(backend, 'GET', `/api/v1/uploads/${picture.id}`, bob.token)).statusCode, 403);
});
