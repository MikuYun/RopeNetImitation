import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import type { ChatService } from './service.ts';
import { digest, hashPassword, identity, opaqueToken, verifyPassword } from './security.ts';
import { fail } from './errors.ts';
import { UPLOAD_BODY_LIMIT } from './upload.ts';
import * as Schema from './schemas.ts';

const secured = (tag: string, summary: string) => ({ tags: [tag], summary, security: [{ bearerAuth: [] }] });
const pageQuery = {
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 30 }),
  offset: Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 }),
};
const Username = Type.String({ minLength: 3, maxLength: 32, pattern: '^[A-Za-z0-9_]+$' });
const Password = Type.String({ minLength: 8, maxLength: 128 });
const MemberIds = Type.Array(Schema.Id, { minItems: 1, maxItems: 99, uniqueItems: true });

export function registerRoutes(instance: FastifyInstance, store: Store, service: ChatService, config: Config): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const createSession = (userId: string) => {
    const token = opaqueToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 86_400_000).toISOString();
    store.run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      digest(token), userId, expiresAt, now.toISOString());
    return { token, tokenType: 'Bearer' as const, expiresAt, user: service.user(userId) };
  };

  /**
   * 分配下一个普通用户 uid，**调用方必须已经在事务里**（契约 §二 要求分配与写入同事务）。
   * 用 MAX(uid) 而不是「用户数 + 10000」：用户被删除后 uid 不复用，
   * 但 MAX 仍然能保证新号单调前进，不会因为删了人就把号发重。
   */
  const nextUserUid = () => store.get<{ next: number }>(
    'SELECT COALESCE(MAX(uid), 10000) + 1 AS next FROM users WHERE uid >= 10001')!.next;

  app.post('/api/v1/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Auth'], summary: '注册并登录',
      body: Type.Object({ username: Username, password: Password, displayName: Schema.Text(40) }, { additionalProperties: false }),
      response: { 201: Schema.AuthResult, 503: Schema.ErrorResponse, ...Schema.ErrorResponses },
    },
  }, async (request, reply) => {
    const username = request.body.username.toLowerCase();
    if (store.get('SELECT 1 FROM users WHERE username = ?', username)) return fail(409, 'USERNAME_TAKEN', '用户名已被使用');
    const passwordHash = await hashPassword(request.body.password);
    const userId = randomUUID();
    let automaticRequestId: string | undefined;
    const result = store.transaction(() => {
      if (store.get('SELECT 1 FROM users WHERE username = ?', username)) return fail(409, 'USERNAME_TAKEN', '用户名已被使用');
      const defaultFriend = config.defaultFriendUsername
        ? store.get<{ id: string }>('SELECT id FROM users WHERE username = ?', config.defaultFriendUsername)
        : undefined;
      if (config.defaultFriendUsername && !defaultFriend) {
        return fail(503, 'DEFAULT_FRIEND_UNAVAILABLE', '默认好友暂不可用，请稍后注册');
      }
      const now = new Date().toISOString();
      // uid 与用户行必须在同一事务里分配并写入，否则并发注册会拿到同一个号
      // （先 SELECT MAX 再 INSERT 的两步之间没有锁，两个请求会算出同一个 next）。
      store.run('INSERT INTO users(id, uid, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, nextUserUid(), username, request.body.displayName.trim(), passwordHash, now);
      if (defaultFriend && defaultFriend.id !== userId) {
        automaticRequestId = randomUUID();
        store.run('INSERT INTO friendships(user_id, friend_id, created_at) VALUES (?, ?, ?)', userId, defaultFriend.id, now);
        store.run('INSERT INTO friendships(user_id, friend_id, created_at) VALUES (?, ?, ?)', defaultFriend.id, userId, now);
        store.run(`INSERT INTO friend_requests(id, sender_id, recipient_id, note, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'accepted', ?, ?)`, automaticRequestId, userId, defaultFriend.id, '注册自动添加好友', now, now);
      }
      return createSession(userId);
    });
    if (automaticRequestId) {
      const request = service.friendRequest(automaticRequestId);
      service.realtime.publish([request.sender.id, request.recipient.id], 'friend.resolved', { request });
    }
    return reply.code(201).send(result);
  });

  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Auth'], summary: '账号密码登录（用户名或数字 UID）',
      // 不新增字段（契约 §5.1）：同一个 username 字段既能填账号名也能填 #10001 这种 uid，
      // 判别交给服务层正则，避免前端为「用哪种标识登录」多做一个分支。
      body: Type.Object({ username: Type.String({ minLength: 1, maxLength: 32 }), password: Password }, { additionalProperties: false }),
      response: { 200: Schema.AuthResult, ...Schema.ErrorResponses },
    },
  }, async request => {
    const row = service.findUserByIdentifier(request.body.username);
    // 查不到时也走一遍 verifyPassword（用固定假 hash），让「用户不存在」与「密码错」
    // 的响应时间接近，避免通过耗时差异枚举账号。
    const dummyHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(request.body.password, row?.password_hash ?? dummyHash);
    if (!row || !valid) return fail(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    // banned 必须在密码校验通过之后才提示：否则「密码错」与「被禁用」的差异会泄漏账号存在性。
    if (row.status === 'banned') return fail(403, 'ACCOUNT_BANNED', '账号已被禁用，请联系管理员');
    return createSession(row.id);
  });

  app.post('/api/v1/auth/logout', {
    schema: { ...secured('Auth', '注销当前 token 及对应实时连接'), response: { 200: Schema.Success, ...Schema.ErrorResponses } },
  }, async request => {
    const session = identity(request);
    store.run('DELETE FROM sessions WHERE token_hash = ?', session.sessionHash);
    service.realtime.revoke(session.sessionHash);
    return { ok: true as const };
  });

  app.get('/api/v1/auth/session', {
    schema: { ...secured('Auth', '校验当前会话'), response: { 200: Schema.AuthResult, ...Schema.ErrorResponses } },
  }, async request => ({ token: request.headers.authorization!.slice(7), tokenType: 'Bearer' as const,
    expiresAt: identity(request).expiresAt, user: service.user(identity(request).userId) }));

  app.post('/api/v1/auth/session/refresh', {
    schema: { ...secured('Auth', '未过期会话滑动续期，不轮换 token'), response: { 200: Schema.AuthResult, ...Schema.ErrorResponses } },
  }, async request => {
    const session = identity(request);
    const expiresAt = new Date(Math.max(Date.parse(session.expiresAt), Date.now() + config.sessionTtlDays * 86_400_000)).toISOString();
    store.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, session.sessionHash);
    return { token: request.headers.authorization!.slice(7), tokenType: 'Bearer' as const, expiresAt, user: service.user(session.userId) };
  });

  app.get('/api/v1/users/me', {
    schema: { ...secured('Users', '获取本人资料'), response: { 200: Schema.User, ...Schema.ErrorResponses } },
  }, async request => service.user(identity(request).userId));

  app.patch('/api/v1/users/me', {
    schema: {
      ...secured('Users', '编辑本人资料'),
      body: Type.Object({
        displayName: Type.Optional(Schema.Text(40)),
        // 契约 §10.1：头像放宽为空串 / https 外链 / 站内上传图片三种形态。
        // schema 只做长度兜底，真正的三态校验在 service.resolveAvatarUrl（需要查 uploads 表）。
        avatarUrl: Type.Optional(Type.String({ maxLength: 2048 })),
        bio: Type.Optional(Type.String({ maxLength: 200 })),
      }, { minProperties: 1, additionalProperties: false }),
      response: { 200: Schema.User, ...Schema.ErrorResponses },
    },
  }, async request => {
    const userId = identity(request).userId;
    const current = service.user(userId);
    const avatarUrl = request.body.avatarUrl === undefined
      ? current.avatarUrl
      : service.resolveAvatarUrl(userId, request.body.avatarUrl);
    store.run('UPDATE users SET display_name = ?, avatar_url = ?, bio = ? WHERE id = ?',
      request.body.displayName?.trim() ?? current.displayName, avatarUrl,
      request.body.bio ?? current.bio, userId);
    return service.user(userId);
  });

  app.get('/api/v1/users', {
    schema: {
      ...secured('Users', '按用户名或昵称搜索其他用户'),
      querystring: Type.Object({ q: Schema.Text(40), ...pageQuery }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.User), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }), ...Schema.ErrorResponses },
    },
  }, async request => {
    const { q: query, limit, offset } = request.query;
    const term = `%${query.trim().replace(/[\\%_]/g, match => `\\${match}`)}%`;
    const rows = store.all<{ id: string }>(`SELECT id FROM users WHERE id <> ?
      AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY username LIMIT ? OFFSET ?`,
    identity(request).userId, term, term, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => service.user(row.id)), nextOffset: rows.length > limit ? offset + limit : null };
  });

  app.get('/api/v1/friends', {
    schema: {
      ...secured('Friends', '获取好友列表'),
      querystring: Type.Object(pageQuery, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.User), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }), ...Schema.ErrorResponses },
    },
  }, async request => {
    const { limit, offset } = request.query;
    const rows = store.all<{ friend_id: string }>('SELECT friend_id FROM friendships WHERE user_id = ? ORDER BY created_at, friend_id LIMIT ? OFFSET ?',
      identity(request).userId, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => service.user(row.friend_id)), nextOffset: rows.length > limit ? offset + limit : null };
  });

  app.get('/api/v1/friend-requests', {
    schema: {
      ...secured('Friends', '获取发出及收到的好友申请'),
      querystring: Type.Object({ ...pageQuery, status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('rejected')])) }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.FriendRequest), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }), ...Schema.ErrorResponses },
    },
  }, async request => {
    const userId = identity(request).userId;
    const { status, limit, offset } = request.query;
    const rows = store.all<{ id: string }>(`SELECT id FROM friend_requests WHERE (sender_id = ? OR recipient_id = ?)
      AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    userId, userId, status ?? null, status ?? null, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => service.friendRequest(row.id)), nextOffset: rows.length > limit ? offset + limit : null };
  });

  app.post('/api/v1/friend-requests', {
    schema: {
      ...secured('Friends', '发起好友申请'),
      body: Type.Object({ userId: Schema.Id, note: Type.String({ maxLength: 200, default: '' }) }, { additionalProperties: false }),
      response: { 201: Schema.FriendRequest, ...Schema.ErrorResponses },
    },
  }, async (request, reply) => reply.code(201).send(service.createFriendRequest(identity(request).userId, request.body.userId, request.body.note)));

  app.post('/api/v1/friend-requests/:requestId/respond', {
    schema: {
      ...secured('Friends', '接收方同意或拒绝好友申请'),
      params: Type.Object({ requestId: Schema.Id }),
      body: Type.Object({ action: Type.Union([Type.Literal('accept'), Type.Literal('reject')]) }, { additionalProperties: false }),
      response: { 200: Schema.FriendRequest, ...Schema.ErrorResponses },
    },
  }, async request => service.resolveFriendRequest(identity(request).userId, request.params.requestId, request.body.action));

  app.get('/api/v1/conversations', {
    schema: {
      ...secured('Conversations', '按最近活动分页获取会话'),
      querystring: Type.Object(pageQuery, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.Conversation), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }), ...Schema.ErrorResponses },
    },
  }, async request => service.listConversations(identity(request).userId, request.query.limit, request.query.offset));

  app.post('/api/v1/conversations/direct', {
    schema: {
      ...secured('Conversations', '获取或创建唯一好友私聊'),
      body: Type.Object({ userId: Schema.Id }, { additionalProperties: false }),
      response: { 200: Schema.Conversation, ...Schema.ErrorResponses },
    },
  }, async request => service.direct(identity(request).userId, request.body.userId));

  app.post('/api/v1/conversations/group', {
    schema: {
      ...secured('Conversations', '创建群聊，创建者自动成为群主'),
      body: Type.Object({ name: Schema.Text(60), memberIds: MemberIds }, { additionalProperties: false }),
      response: { 201: Schema.Conversation, ...Schema.ErrorResponses },
    },
  }, async (request, reply) => reply.code(201).send(service.group(identity(request).userId, request.body.name, request.body.memberIds)));

  app.get('/api/v1/conversations/:conversationId', {
    schema: { ...secured('Conversations', '获取成员、最新消息及未读数'), params: Schema.ConversationParams,
      response: { 200: Schema.Conversation, ...Schema.ErrorResponses } },
  }, async request => service.conversation(request.params.conversationId, identity(request).userId));

  app.patch('/api/v1/conversations/:conversationId', {
    schema: { ...secured('Conversations', '群主或管理员修改群名/群头像'), params: Schema.ConversationParams,
      // 契约 §7.2：至少给一个字段；name 与 avatarUrl 各自可选。
      body: Type.Object({ name: Type.Optional(Schema.Text(60)), avatarUrl: Type.Optional(Type.String({ maxLength: 2048 })) },
        { minProperties: 1, additionalProperties: false }),
      response: { 200: Schema.Conversation, ...Schema.ErrorResponses } },
  }, async request => {
    const userId = identity(request).userId;
    // 头像要先做三态校验（需要查 uploads 表），再与改群名一起进同一个事务：
    // 分开写会出现「名字改了、头像因校验失败没改」的部分成功状态。
    const avatarUrl = request.body.avatarUrl === undefined
      ? undefined : service.resolveAvatarUrl(userId, request.body.avatarUrl);
    return service.updateConversation(request.params.conversationId, userId, { name: request.body.name, avatarUrl });
  });

  app.post('/api/v1/conversations/:conversationId/members/:userId/role', {
    schema: { ...secured('Conversations', '群主设置或取消成员的管理员身份'),
      params: Type.Object({ conversationId: Schema.Id, userId: Schema.Id }),
      body: Schema.MemberRoleBody,
      response: { 200: Schema.Conversation, ...Schema.ErrorResponses } },
  }, async request => service.setMemberRole(request.params.conversationId, identity(request).userId,
    request.params.userId, request.body.role));

  app.post('/api/v1/conversations/:conversationId/members', {
    schema: { ...secured('Conversations', '群主邀请自己的好友入群'), params: Schema.ConversationParams,
      body: Type.Object({ memberIds: MemberIds }, { additionalProperties: false }),
      response: { 200: Schema.Conversation, ...Schema.ErrorResponses } },
  }, async request => service.addMembers(request.params.conversationId, identity(request).userId, request.body.memberIds));

  app.delete('/api/v1/conversations/:conversationId/members/:userId', {
    schema: { ...secured('Conversations', '群主移除成员，或普通成员退群'), params: Type.Object({ conversationId: Schema.Id, userId: Schema.Id }),
      response: { 200: Schema.Success, ...Schema.ErrorResponses } },
  }, async request => service.removeMember(request.params.conversationId, identity(request).userId, request.params.userId));

  app.get('/api/v1/conversations/:conversationId/messages', {
    schema: { ...secured('Messages', '历史分页或断线增量同步，返回按 seq 升序'), params: Schema.ConversationParams,
      querystring: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 100, default: 30 }),
        beforeSeq: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })), afterSeq: Type.Optional(Schema.Sequence) }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.Message), hasMore: Type.Boolean(),
        nextBeforeSeq: Type.Union([Schema.Sequence, Type.Null()]), nextAfterSeq: Type.Union([Schema.Sequence, Type.Null()]) }), ...Schema.ErrorResponses } },
  }, async request => service.history(request.params.conversationId, identity(request).userId, request.query.limit, request.query.beforeSeq, request.query.afterSeq));

  app.post('/api/v1/conversations/:conversationId/messages', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { ...secured('Messages', '发送文本或附件消息，以 clientMsgId 幂等重试'), params: Schema.ConversationParams,
      // type 保持可选且只接受 'text'：老客户端与老测试都带 type:'text'，必须继续可用；
      // 附件消息的 type 一律由服务端按上传记录的 kind 推导，客户端传什么都不作数（防伪造）。
      body: Type.Object({ clientMsgId: Schema.Id, type: Type.Optional(Type.Literal('text')),
        content: Type.Optional(Schema.Text(4000)), attachmentId: Type.Optional(Schema.Id) }, { additionalProperties: false }),
      response: { 200: Schema.Message, 201: Schema.Message, ...Schema.ErrorResponses } },
  }, async (request, reply) => {
    const result = service.sendMessage(request.params.conversationId, identity(request).userId,
      request.body.clientMsgId, request.body.content, request.body.attachmentId);
    return reply.code(result.created ? 201 : 200).send(result.message);
  });

  app.post('/api/v1/conversations/:conversationId/read', {
    schema: { ...secured('Messages', '提交单调递增的已读位置'), params: Schema.ConversationParams,
      body: Type.Object({ lastReadSeq: Schema.Sequence }, { additionalProperties: false }),
      response: { 204: Type.Null({ description: '已读位置已更新或较小值已忽略，无响应体' }), ...Schema.ErrorResponses } },
  }, async (request, reply) => {
    service.markRead(request.params.conversationId, identity(request).userId, request.body.lastReadSeq);
    return reply.code(204).send(null);
  });

  app.post('/api/v1/sync', {
    schema: { ...secured('Messages', '批量增量同步，每会话最多 100 条'),
      body: Type.Object({ cursors: Type.Array(Type.Object({ conversationId: Schema.Id, lastSeq: Schema.Sequence }, { additionalProperties: false }), { maxItems: 100 }) }, { additionalProperties: false }),
      response: { 200: Type.Object({ items: Type.Array(Schema.SyncItem) }), ...Schema.ErrorResponses } },
  }, async request => service.sync(identity(request).userId, request.body.cursors));

  app.post('/api/v1/auth/ws-ticket', {
    schema: { ...secured('Realtime', '生成 30 秒有效的一次性 WebSocket 票据'),
      response: { 200: Type.Object({ ticket: Type.String(), expiresIn: Type.Literal(30) }), ...Schema.ErrorResponses } },
  }, async request => {
    const ticket = opaqueToken();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    store.run('INSERT INTO ws_tickets(ticket_hash, session_hash, expires_at) VALUES (?, ?, ?)',
      digest(ticket), identity(request).sessionHash, expiresAt);
    return { ticket, expiresIn: 30 as const };
  });

  app.get('/api/v1/conversations/:conversationId/pins', {
    schema: { ...secured('Pins', '获取会话置顶消息列表，按置顶时间倒序'), params: Schema.ConversationParams,
      response: { 200: Schema.PinsResult, ...Schema.ErrorResponses } },
  }, async request => service.listPins(request.params.conversationId, identity(request).userId));

  app.post('/api/v1/conversations/:conversationId/pins', {
    schema: { ...secured('Pins', '置顶一条消息（成员即可，重复置顶幂等）'), params: Schema.ConversationParams,
      body: Schema.PinBody,
      // 200 与 201 都要声明：幂等重放返回 200，首次置顶返回 201。
      response: { 200: Schema.PinnedMessage, 201: Schema.PinnedMessage, ...Schema.ErrorResponses } },
  }, async (request, reply) => {
    const result = service.pin(request.params.conversationId, identity(request).userId, request.body.msgId);
    return reply.code(result.created ? 201 : 200).send(result.pin);
  });

  app.delete('/api/v1/conversations/:conversationId/pins/:msgId', {
    schema: { ...secured('Pins', '取消置顶（:msgId 是消息 UUID）'), params: Schema.PinParams,
      response: { 204: Type.Null({ description: '已取消置顶，无响应体' }), ...Schema.ErrorResponses } },
  }, async (request, reply) => {
    service.unpin(request.params.conversationId, identity(request).userId, request.params.msgId);
    return reply.code(204).send(null);
  });

  /*
   * 管理后台：四个接口，全部要求 role='admin'。
   * :uid 路径参数是数字 uid（不是 UUID），与普通接口的 id 风格刻意不同 ——
   * 管理员在后台看到并操作的就是 1001/10001 这种号码，不该要求他先换成 UUID。
   */
  app.get('/api/v1/admin/users', {
    schema: { ...secured('Admin', '分页搜索用户（按 uid/账号名/昵称模糊匹配）'),
      querystring: Schema.AdminUsersQuery,
      response: { 200: Schema.AdminUserPage, ...Schema.ErrorResponses } },
  }, async request => {
    service.requireAdmin(identity(request).userId);
    return service.adminUsers(request.query.query ?? '', request.query.limit, request.query.offset);
  });

  app.post('/api/v1/admin/users/:uid/mute', {
    schema: { ...secured('Admin', '禁言或解除禁言（minutes=0 解除）'), params: Schema.AdminUserParams,
      body: Schema.MuteBody,
      response: { 200: Schema.User, ...Schema.ErrorResponses } },
  }, async request => service.muteUser(identity(request).userId, request.params.uid, request.body.minutes));

  app.delete('/api/v1/admin/users/:uid', {
    schema: { ...secured('Admin', '删除账号（连同其消息、会话关系与 WS 连接）'), params: Schema.AdminUserParams,
      response: { 204: Type.Null({ description: '账号已删除，无响应体' }), ...Schema.ErrorResponses } },
  }, async (request, reply) => {
    service.deleteUser(identity(request).userId, request.params.uid);
    return reply.code(204).send(null);
  });

  app.get('/api/v1/admin/stats', {
    schema: { ...secured('Admin', '管理后台概览统计'),
      response: { 200: Schema.AdminStats, ...Schema.ErrorResponses } },
  }, async request => service.adminStats(identity(request).userId));

  /*
   * 上传接口：单独开一个封装插件作用域。
   * fastify 的每个插件实例持有独立的 content type parser 副本（plugin-override.js），
   * 因此这里的通配 parser 只影响本作用域内的路由，全局 32KiB 的 JSON 契约完全不动 ——
   * 把 bodyLimit 调大放在全局是错的，那会让所有接口都能收 11MiB。
   */
  instance.register(async scope => {
    const uploads = scope.withTypeProvider<TypeBoxTypeProvider>();
    // 先清空继承来的 application/json 与 text/plain parser，再注册唯一的通配 buffer parser：
    // 上传接口对 Content-Type 完全不敏感（真实类型由服务端嗅探魔数决定），
    // 若保留 json parser，客户端带 application/json 上传会被按 JSON 解析并直接 400。
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT },
      (_request, body, done) => done(null, body));

    uploads.post('/api/v1/uploads', {
      bodyLimit: UPLOAD_BODY_LIMIT,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { ...secured('Uploads', '上传文件（请求体为裸二进制，服务端按魔数嗅探真实类型）'),
        querystring: Schema.UploadQuery,
        response: { 201: Schema.Upload, ...Schema.ErrorResponses } },
    }, async (request, reply) => {
      // 完全没带 body 时 fastify 不走 parser，request.body 是 undefined；
      // 与「body 是 0 字节」统一成同一个 400，避免同一个语义两种状态码。
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes)) return fail(400, 'VALIDATION_ERROR', '上传内容不能为空');
      return reply.code(201).send(service.createUpload(identity(request).userId, request.query.filename, bytes));
    });

    uploads.get('/api/v1/uploads/:id', {
      schema: { ...secured('Uploads', '下载上传的文件（仅属主可读，响应为原始字节）'),
        params: Schema.UploadParams,
        // 刻意不声明 200 的 JSON schema：响应体是原始字节，
        // 一旦声明了序列化器就会介入，把 Buffer 序列化成 JSON。
        response: { ...Schema.ErrorResponses } },
    }, async (request, reply) => {
      const { upload, bytes } = service.readUpload(request.params.id, identity(request).userId);
      reply.header('Content-Type', upload.mimeType);
      reply.header('Content-Length', String(bytes.length));
      // nosniff 阻止浏览器把内容嗅探成别的类型；沙箱 CSP 保证即使识别成 html/svg 也不在本域执行脚本。
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header('Referrer-Policy', 'no-referrer');
      // 内容按 id 不可变（id 就是内容的主键），可以放心长缓存；private 避免中间代理缓存他人文件。
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      // 图片 inline 便于 <img> 直接渲染；其他类型强制 attachment 下载，避免 pdf/zip 被当页面打开。
      const disposition = upload.kind === 'image' ? 'inline' : 'attachment';
      reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(upload.name)}`);
      // 本路由刻意不声明 200 的 JSON schema（响应体是原始字节），于是 fastify 的 Reply 泛型只认得错误体形状。
      // 这里做一次纯类型层面的断言：运行时 reply.send 会命中 Buffer 分支，原样发出字节且不序列化。
      return reply.send(bytes as never);
    });

    uploads.delete('/api/v1/uploads/:id', {
      schema: { ...secured('Uploads', '删除未被任何消息引用的上传文件'),
        params: Schema.UploadParams,
        response: { 204: Type.Null({ description: '文件已删除，无响应体' }), ...Schema.ErrorResponses } },
    }, async (request, reply) => {
      service.deleteUpload(request.params.id, identity(request).userId);
      return reply.code(204).send(null);
    });
  });
}
