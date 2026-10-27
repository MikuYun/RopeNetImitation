import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Store } from './db.ts';
import type { Realtime } from './realtime.ts';
import { fail } from './errors.ts';
import { hashPassword } from './security.ts';
import {
  MAX_UPLOAD_BYTES, detectMimeType, kindFor, removeUploadFile, sanitizeFilename, uploadPath, writeUpload,
} from './upload.ts';

interface UserRow {
  id: string;
  uid: number | null;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_url: string;
  bio: string;
  role: 'user' | 'admin';
  status: 'active' | 'banned';
  muted_until: string | null;
  created_at: string;
}

/** 群内角色。owner 由 conversations.owner_id 决定，其余从 conversation_members.role 读。 */
export type GroupRole = 'owner' | 'admin' | 'member';

interface MemberRow {
  conversation_id: string;
  user_id: string;
  joined_at: string;
  last_read_seq: number;
  role: GroupRole;
}

interface PinRow {
  id: string;
  conversation_id: string;
  msg_id: string;
  pinned_by: string;
  pinned_at: string;
}

interface ConversationRow {
  id: string;
  type: 'direct' | 'group';
  name: string;
  avatar_url: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  msg_id: string;
  seq: number;
  conversation_id: string;
  sender_id: string;
  client_message_id: string;
  type: 'text' | 'system' | 'image' | 'file';
  content: string;
  attachment_id: string | null;
  created_at: string;
}

interface UploadRow {
  id: string;
  owner_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  kind: 'image' | 'file';
  created_at: string;
}

interface RequestRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  note: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  updated_at: string;
}

export class ChatService {
  store: Store;
  realtime: Realtime;
  /** 附件字节落盘目录（绝对路径），来自 Config.uploadsDir。 */
  uploadsDir: string;

  constructor(store: Store, realtime: Realtime, uploadsDir: string) {
    this.store = store;
    this.realtime = realtime;
    this.uploadsDir = uploadsDir;
  }

  user(userId: string) {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) return fail(404, 'USER_NOT_FOUND', '用户不存在');
    return {
      id: row.id,
      // uid 理论上在迁移后恒非空，兜底成 0 是为了让「库被手工改坏」暴露出明显异常值而不是抛 500。
      uid: row.uid ?? 0,
      username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url,
      bio: row.bio, role: row.role, status: row.status, mutedUntil: row.muted_until,
      createdAt: row.created_at, online: this.realtime.isOnline(row.id),
    };
  }

  /** 按 uid 或 username 找用户的内部 id。登录与好友查找共用，保证两种标识语义完全一致。 */
  findUserByIdentifier(identifier: string): UserRow | undefined {
    // 纯数字按 uid 查：契约 §五 允许用户用 #10001 这种 uid 登录。
    // 这里不能再对 identifier 做小写化 —— uid 是数字，而 username 列本身是 COLLATE NOCASE。
    if (/^\d+$/.test(identifier)) {
      return this.store.get<UserRow>('SELECT * FROM users WHERE uid = ?', Number(identifier));
    }
    return this.store.get<UserRow>('SELECT * FROM users WHERE username = ?', identifier.toLowerCase());
  }

  /**
   * 当前是否处于禁言期。muted_until 是 ISO8601，可直接字典序比较；
   * 但用 Date.parse 更宽容（历史数据里可能存在带时区偏移的写法），比较结果也更直观。
   */
  isMuted(row: { muted_until: string | null }): boolean {
    return row.muted_until !== null && Date.parse(row.muted_until) > Date.now();
  }

  members(conversationId: string): string[] {
    return this.store.all<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conversationId)
      .map(row => row.user_id);
  }

  requireMember(conversationId: string, userId: string): ConversationRow {
    const row = this.store.get<ConversationRow>(`SELECT conversation.* FROM conversations conversation
      JOIN conversation_members member ON member.conversation_id = conversation.id
      WHERE conversation.id = ? AND member.user_id = ?`, conversationId, userId);
    return row ?? fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在或你不是成员');
  }

  requireOwner(conversationId: string, userId: string): ConversationRow {
    const row = this.requireMember(conversationId, userId);
    if (row.type !== 'group' || row.owner_id !== userId) return fail(403, 'OWNER_REQUIRED', '只有群主可以执行此操作');
    return row;
  }

  /** 当前用户在该会话里的群角色。owner 以 conversations.owner_id 为唯一权威，不看成员行上的冗余字段。 */
  memberRole(conversationId: string, userId: string): GroupRole {
    const conversation = this.requireMember(conversationId, userId);
    if (conversation.owner_id === userId) return 'owner';
    const row = this.store.get<{ role: GroupRole }>(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
    // 成员行上的 role 理论上有 CHECK 约束兜底，这里再收敛一次，避免脏数据把「member」之外的值透传给权限判断。
    return row?.role === 'admin' ? 'admin' : 'member';
  }

  /**
   * 「管理群」的最小权限：owner 或 admin。
   * 单独抽出来是因为改群名/群头像/邀请成员三处用同一判定，而它们的错误码统一是 OWNER_REQUIRED
   * （沿用既有码，契约 §7.2 明确要求 message 改为「只有群主或管理员可以执行此操作」）。
   */
  requireManager(conversationId: string, userId: string): ConversationRow {
    const row = this.requireMember(conversationId, userId);
    if (row.type !== 'group') return fail(400, 'GROUP_REQUIRED', '私聊不可执行该操作');
    if (this.memberRole(conversationId, userId) === 'member') {
      return fail(403, 'OWNER_REQUIRED', '只有群主或管理员可以执行此操作');
    }
    return row;
  }

  private requireFriends(userId: string, peers: string[]): void {
    for (const peer of peers) {
      if (!this.store.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', userId, peer)) {
        fail(403, 'FRIEND_REQUIRED', '只能与好友建立会话或邀请好友入群');
      }
    }
  }

  /** 附件对外视图：只暴露客户端渲染需要的字段，owner_id 与 sha256 不外泄。 */
  private attachmentView(row: UploadRow) {
    return {
      id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, kind: row.kind,
      url: `/api/v1/uploads/${row.id}`, createdAt: row.created_at,
    };
  }

  /**
   * 按 attachment_id 取附件视图。
   * 用 LEFT 语义（查不到降级为 null）而不是抛错：历史消息的附件可能已被 DELETE /uploads/:id 之外的路径清掉
   * （例如运维手工清库），此时宁可让这条消息的 attachment 为 null，也不该让整个历史/同步请求 500。
   */
  private attachment(uploadId: string | null) {
    if (!uploadId) return null;
    const row = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    return row ? this.attachmentView(row) : null;
  }

  private message(row: MessageRow) {
    return {
      msgId: row.msg_id, seq: row.seq, conversationId: row.conversation_id, senderId: row.sender_id,
      clientMsgId: row.client_message_id, type: row.type, content: row.content,
      attachment: this.attachment(row.attachment_id), createdAt: row.created_at,
    };
  }

  conversation(conversationId: string, userId: string) {
    const row = this.requireMember(conversationId, userId);
    const members = this.store.all<MemberRow>(
      'SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, user_id', conversationId);
    const lastMessage = this.store.get<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1', conversationId);
    const peerId = members.find(member => member.user_id !== userId)?.user_id;
    const peer = row.type === 'direct' && peerId ? this.user(peerId) : undefined;
    // 群主在成员行上的 role 也可能因历史数据不一致而落后于 owner_id，
    // 这里统一以 owner_id 覆盖一次，保证 members[].role、myRole 与 ownerId 三者永远自洽。
    const roleOf = (member: MemberRow): GroupRole =>
      member.user_id === row.owner_id ? 'owner' : member.role === 'admin' ? 'admin' : 'member';
    return {
      id: row.id, type: row.type === 'direct' ? 'single' as const : 'group' as const, name: row.name, ownerId: row.owner_id,
      // 群聊返回群头像；私聊的 avatarUrl 恒为空串（契约 §10.2：私聊头像由前端按 peer 决定）。
      title: peer?.displayName ?? row.name, avatarUrl: row.type === 'group' ? row.avatar_url : '', peer, memberCount: members.length,
      myRole: roleOf(members.find(member => member.user_id === userId)!),
      lastReadSeq: members.find(member => member.user_id === userId)!.last_read_seq,
      createdAt: row.created_at, updatedAt: row.updated_at,
      members: members.map(member => ({
        user: this.user(member.user_id), role: roleOf(member),
        joinedAt: member.joined_at, lastReadSeq: member.last_read_seq,
      })),
      unreadCount: this.unreadCount(conversationId, userId), lastSeq: lastMessage?.seq ?? 0, lastMessage: lastMessage ? this.message(lastMessage) : null,
    };
  }

  private unreadCount(conversationId: string, userId: string): number {
    return this.store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND sender_id <> ? AND seq >
      (SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?)`,
    conversationId, userId, conversationId, userId)!.count;
  }

  private notifyConversation(conversationId: string, type: string): void {
    for (const userId of this.members(conversationId)) {
      this.realtime.publish([userId], type, { conversation: this.conversation(conversationId, userId) });
    }
  }

  private notifyLastSystemMessage(conversationId: string): void {
    const row = this.store.get<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1', conversationId)!;
    for (const recipientId of this.members(conversationId)) {
      this.realtime.publish([recipientId], 'message.created', { message: this.message(row), unreadCount: this.unreadCount(conversationId, recipientId) });
    }
  }

  listConversations(userId: string, limit: number, offset: number) {
    const rows = this.store.all<{ id: string }>(`SELECT conversation.id FROM conversations conversation
      JOIN conversation_members member ON member.conversation_id = conversation.id
      WHERE member.user_id = ? ORDER BY conversation.updated_at DESC, conversation.id DESC LIMIT ? OFFSET ?`,
    userId, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => this.conversation(row.id, userId)),
      nextOffset: rows.length > limit ? offset + limit : null };
  }

  direct(userId: string, friendId: string) {
    if (userId === friendId) return fail(400, 'SELF_CONVERSATION', '不能与自己创建私聊');
    this.requireFriends(userId, [friendId]);
    const key = [userId, friendId].sort().join(':');
    const existing = this.store.get<{ id: string }>('SELECT id FROM conversations WHERE direct_key = ?', key);
    if (existing) return this.conversation(existing.id, userId);
    const conversationId = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(`INSERT INTO conversations(id, type, name, owner_id, direct_key, created_at, updated_at)
        VALUES (?, 'direct', '', NULL, ?, ?, ?)`, conversationId, key, now, now);
      for (const memberId of [userId, friendId]) {
        this.store.run('INSERT INTO conversation_members(conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
          conversationId, memberId, now);
      }
    });
    this.notifyConversation(conversationId, 'conversation.created');
    return this.conversation(conversationId, userId);
  }

  group(userId: string, name: string, memberIds: string[]) {
    const peers = [...new Set(memberIds)].filter(memberId => memberId !== userId);
    if (peers.length < 1 || peers.length > 99) return fail(400, 'INVALID_MEMBERS', '群聊需要 1 至 99 位其他成员');
    this.requireFriends(userId, peers);
    const conversationId = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(`INSERT INTO conversations(id, type, name, owner_id, created_at, updated_at)
        VALUES (?, 'group', ?, ?, ?, ?)`, conversationId, name.trim(), userId, now, now);
      for (const memberId of [userId, ...peers]) {
        // 创建者的成员行直接写 owner：权限判定虽然以 conversations.owner_id 为准，
        // 但 members[].role 要立刻正确，否则前端建群后第一次渲染会把群主显示成普通成员。
        this.store.run('INSERT INTO conversation_members(conversation_id, user_id, joined_at, role) VALUES (?, ?, ?, ?)',
          conversationId, memberId, now, memberId === userId ? 'owner' : 'member');
      }
      this.systemMessage(conversationId, userId, `${this.user(userId).displayName} 创建了群聊`);
    });
    this.notifyConversation(conversationId, 'conversation.created');
    this.notifyLastSystemMessage(conversationId);
    return this.conversation(conversationId, userId);
  }

  /**
   * 改群资料（群名 / 群头像）。契约 §7.2：owner 与 admin 都可以改。
   * 两者都在同一事务里做，避免「名字改成功、头像校验失败」留下部分生效的状态。
   */
  updateConversation(conversationId: string, userId: string, patch: { name?: string; avatarUrl?: string }) {
    const conversation = this.requireManager(conversationId, userId);
    const now = new Date().toISOString();
    this.store.transaction(() => {
      if (patch.name !== undefined) {
        this.store.run('UPDATE conversations SET name = ?, updated_at = ? WHERE id = ?', patch.name.trim(), now, conversationId);
        this.systemMessage(conversationId, userId, `${this.user(userId).displayName} 将群名修改为 ${patch.name.trim()}`);
      }
      if (patch.avatarUrl !== undefined) {
        this.store.run('UPDATE conversations SET avatar_url = ?, updated_at = ? WHERE id = ?', patch.avatarUrl, now, conversationId);
        this.systemMessage(conversationId, userId, patch.avatarUrl === ''
          ? `${this.user(userId).displayName} 移除了群头像`
          : `${this.user(userId).displayName} 更新了群头像`);
      }
    });
    this.notifyConversation(conversationId, 'conversation.updated');
    if (patch.name !== undefined || patch.avatarUrl !== undefined) this.notifyLastSystemMessage(conversationId);
    return this.conversation(conversationId, userId);
  }

  addMembers(conversationId: string, userId: string, memberIds: string[]) {
    // 契约 §7.1：邀请成员 owner 与 admin 都可以（原先只有 owner）。
    this.requireManager(conversationId, userId);
    const current = this.members(conversationId);
    const peers = [...new Set(memberIds)].filter(memberId => !current.includes(memberId));
    if (current.length + peers.length > 100) return fail(400, 'GROUP_FULL', '群成员不能超过 100 人');
    this.requireFriends(userId, peers);
    const last = this.store.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?', conversationId)!;
    this.store.transaction(() => {
      for (const memberId of peers) {
        this.store.run(`INSERT INTO conversation_members(conversation_id, user_id, joined_at, last_read_seq)
          VALUES (?, ?, ?, ?)`, conversationId, memberId, new Date().toISOString(), last.seq);
      }
      this.store.run('UPDATE conversations SET updated_at = ? WHERE id = ?', new Date().toISOString(), conversationId);
      if (peers.length > 0) this.systemMessage(conversationId, userId, `${peers.map(peerId => this.user(peerId).displayName).join('、')} 加入了群聊`);
    });
    this.notifyConversation(conversationId, 'conversation.updated');
    if (peers.length > 0) this.notifyLastSystemMessage(conversationId);
    return this.conversation(conversationId, userId);
  }

  removeMember(conversationId: string, userId: string, targetId: string) {
    const conversation = this.requireMember(conversationId, userId);
    if (conversation.type !== 'group') return fail(400, 'GROUP_REQUIRED', '私聊不可移除成员');
    const actorRole = this.memberRole(conversationId, userId);
    if (targetId !== userId) {
      // 契约 §7.4 的三档权限：owner 可移除 admin/member；admin 只能移除 member；member 只能移自己（退群）。
      if (actorRole === 'member') return fail(403, 'OWNER_REQUIRED', '只有群主或管理员可以移除其他成员');
      const targetRole = this.memberRole(conversationId, targetId);
      // admin 想移除另一位 admin 时用同一个 403：本版的「管理员任免」是群主专属，管理员之间没有互相踢的权限。
      if (actorRole === 'admin' && targetRole !== 'member') {
        return fail(403, 'OWNER_REQUIRED', '管理员只能移除普通成员');
      }
    }
    if (targetId === conversation.owner_id) return fail(409, 'OWNER_CANNOT_LEAVE', '本版本暂不支持群主退群或转让');
    if (!this.members(conversationId).includes(targetId)) return fail(404, 'MEMBER_NOT_FOUND', '成员不存在');
    this.store.transaction(() => {
      this.store.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, targetId);
      this.store.run('UPDATE conversations SET updated_at = ? WHERE id = ?', new Date().toISOString(), conversationId);
      this.systemMessage(conversationId, userId, `${this.user(targetId).displayName} 离开了群聊`);
    });
    this.realtime.publish([targetId], 'conversation.removed', { conversationId });
    this.notifyConversation(conversationId, 'conversation.updated');
    this.notifyLastSystemMessage(conversationId);
    return { ok: true as const };
  }

  /**
   * 群主设置/取消管理员（契约 §7.3）。只有 owner 能调用。
   * 用 user.id（UUID）而不是 uid 定位目标，与既有成员接口保持一致。
   */
  setMemberRole(conversationId: string, userId: string, targetId: string, role: 'admin' | 'member') {
    const conversation = this.requireOwner(conversationId, userId);
    // 改自己的角色等价于「群主自降」或「群主自升」，两者都不该发生：
    // 前者的正确操作是转让群主（本版不支持），后者是恒真。
    if (targetId === userId) return fail(400, 'CANNOT_CHANGE_OWNER_ROLE', '不能修改群主自己的角色');
    if (targetId === conversation.owner_id) return fail(400, 'CANNOT_CHANGE_OWNER_ROLE', '不能修改群主的角色');
    if (!this.members(conversationId).includes(targetId)) return fail(404, 'MEMBER_NOT_FOUND', '成员不存在');
    const current = this.memberRole(conversationId, targetId);
    if (current === role) return this.conversation(conversationId, userId);
    this.store.transaction(() => {
      this.store.run('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?',
        role, conversationId, targetId);
      this.store.run('UPDATE conversations SET updated_at = ? WHERE id = ?', new Date().toISOString(), conversationId);
      const displayName = this.user(targetId).displayName;
      this.systemMessage(conversationId, userId, role === 'admin' ? `${displayName} 成为管理员` : `${displayName} 被取消管理员`);
    });
    this.notifyConversation(conversationId, 'conversation.updated');
    this.notifyLastSystemMessage(conversationId);
    return this.conversation(conversationId, userId);
  }

  history(conversationId: string, userId: string, limit: number, before?: number, after?: number) {
    this.requireMember(conversationId, userId);
    if (before !== undefined && after !== undefined) return fail(400, 'INVALID_CURSOR', 'beforeSeq 与 afterSeq 不能同时使用');
    const rows = after !== undefined
      ? this.store.all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', conversationId, after, limit + 1)
      : this.store.all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const selected = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const cursor = hasMore ? selected.at(-1)!.seq : null;
    if (after === undefined) selected.reverse();
    return { items: selected.map(row => this.message(row)), hasMore,
      nextBeforeSeq: after === undefined ? cursor : null, nextAfterSeq: after !== undefined ? cursor : null };
  }

  private systemMessage(conversationId: string, actorId: string, content: string): void {
    const next = this.store.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?', conversationId)!;
    this.store.run(`INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, created_at)
      VALUES (?, ?, ?, ?, ?, 'system', ?, ?)`, randomUUID(), next.seq, conversationId, actorId, randomUUID(), content, new Date().toISOString());
  }

  /**
   * 发送消息。attachmentId 为可选：给了附件时 type 由上传记录的 kind 推导（不信任客户端自报 type），
   * 没给附件时走原文本路径，content 必须非空（由路由层 schema 保证）。
   */
  sendMessage(conversationId: string, userId: string, clientMessageId: string, content: string | undefined, attachmentId?: string) {
    this.requireMember(conversationId, userId);
    // 禁言只拦「发消息」，读历史、已读、加好友都不受影响（契约 §5.3）。
    // 判定放在 requireMember 之后：非成员应先看到 404，不该从 403 MUTED 反推会话存在与否。
    const sender = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!;
    if (this.isMuted(sender)) {
      return fail(403, 'MUTED', `你已被禁言，解除时间 ${sender.muted_until}`);
    }
    // 账号被禁用后 token 可能仍未过期（管理员封禁与踢线之间有时间差），发消息也要挡住，
    // 否则被禁用的账号还能在已登录的会话里继续发言。
    if (sender.status === 'banned') return fail(403, 'ACCOUNT_BANNED', '账号已被禁用，请联系管理员');
    const upload = attachmentId === undefined ? undefined : this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', attachmentId);
    // 不存在与不属于自己合并成同一个 400：避免用错误码差异探测「某个 uuid 的上传是否存在」。
    if (attachmentId !== undefined && (!upload || upload.owner_id !== userId)) {
      return fail(400, 'INVALID_ATTACHMENT', '附件不存在或不属于你');
    }
    // 带附件时 content 允许省略（落库为空串，客户端靠 attachment 渲染）；纯文本必须非空，由路由 schema 兜住。
    const normalizedContent = content ?? '';
    if (!upload && normalizedContent.trim() === '') return fail(400, 'VALIDATION_ERROR', '消息内容不能为空');
    const type = upload ? kindFor(upload.mime_type) : 'text' as const;
    const existing = this.store.get<MessageRow>('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?', userId, clientMessageId);
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.content !== normalizedContent
        || (existing.attachment_id ?? undefined) !== (upload?.id)) {
        return fail(409, 'IDEMPOTENCY_CONFLICT', '同一 clientMsgId 不可用于不同消息');
      }
      return { message: this.message(existing), created: false };
    }
    // 附件一旦被消息引用就不能再被第二条消息复用：否则删消息语义、去重语义都会含糊。
    // 放在事务内查，失败时整个事务回滚，不会留下半条消息。
    const row = this.store.transaction(() => {
      if (upload) {
        const used = this.store.get('SELECT 1 FROM messages WHERE attachment_id = ?', upload.id);
        if (used) fail(409, 'UPLOAD_IN_USE', '该附件已被其他消息使用');
      }
      const now = new Date().toISOString();
      const next = this.store.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?', conversationId)!;
      const inserted = this.store.run(`INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id, type, content, attachment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), next.seq, conversationId, userId, clientMessageId, type,
      normalizedContent, upload?.id ?? null, now);
      this.store.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
      return this.store.get<MessageRow>('SELECT * FROM messages WHERE id = ?', inserted.lastInsertRowid)!;
    });
    const message = this.message(row);
    for (const recipientId of this.members(conversationId)) {
      this.realtime.publish([recipientId], 'message.created', {
        message, unreadCount: this.unreadCount(conversationId, recipientId),
      });
    }
    return { message, created: true };
  }

  /** 落盘 + 入库。先写文件再插库：写文件失败时不会留下指向空文件的记录。 */
  createUpload(ownerId: string, filename: string | undefined, bytes: Buffer) {
    if (bytes.length === 0) return fail(400, 'VALIDATION_ERROR', '上传内容不能为空');
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, 'UPLOAD_TOO_LARGE', `单个文件不能超过 ${MAX_UPLOAD_BYTES} 字节`);
    const mimeType = detectMimeType(bytes);
    if (!mimeType) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持的文件类型');
    const id = randomUUID();
    const { sha256, size } = writeUpload(this.uploadsDir, id, mimeType, bytes);
    const name = sanitizeFilename(filename);
    const createdAt = new Date().toISOString();
    try {
      this.store.run(`INSERT INTO uploads(id, owner_id, name, mime_type, size, sha256, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, ownerId, name, mimeType, size, sha256, kindFor(mimeType), createdAt);
    } catch (error) {
      // 插库失败（磁盘满/约束冲突）时把刚落盘的字节清掉，避免产生永远查不到的孤儿文件。
      removeUploadFile(this.uploadsDir, id, mimeType);
      throw error;
    }
    return { id, name, mimeType, size, sha256, kind: kindFor(mimeType), url: `/api/v1/uploads/${id}`, createdAt };
  }

  /**
   * 读上传（契约 §八，P0 修复）。
   *
   * 旧实现只允许属主读取，导致「对方发来的图片/文件点开就 403」。新规则三档：
   * 1. 属主本人 → 允许；
   * 2. 该附件被某条消息引用，且请求者是那条消息所在会话的成员 → 允许（这是聊天场景的常态）；
   * 3. 其余 → 403。
   *
   * 为什么第 2 档要「先看消息引用再看会话成员」而不是直接按 owner 放行：
   * 附件本身没有会话归属，同一张图可以被转发到多个会话，只有顺着 messages 反查才能知道
   * 「这个请求者是否有权看到这张图」。未被任何消息引用的上传（刚传完还没发出去）不能跨人访问，
   * 否则任何拿到 UUID 的人都能读别人正在编辑的草稿附件。
   */
  readUpload(uploadId: string, userId: string) {
    const row = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    if (!row) return fail(404, 'UPLOAD_NOT_FOUND', '文件不存在');
    if (row.owner_id !== userId) {
      // 一次 JOIN 同时回答两个问题：附件有没有被引用、请求者是不是那个会话的成员。
      const shared = this.store.get(`SELECT 1 FROM messages message
        JOIN conversation_members member ON member.conversation_id = message.conversation_id
        WHERE message.attachment_id = ? AND member.user_id = ?`, uploadId, userId);
      // 保持 403 FORBIDDEN（契约 §八 明确要求沿用原码）：uuid 不可枚举，403 让前端区分「无权限」与「已删除」。
      if (!shared) return fail(403, 'FORBIDDEN', '无权访问该文件');
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(uploadPath(this.uploadsDir, row.id, row.mime_type));
    } catch {
      // 记录在但文件没了：对外按不存在处理，避免 500 泄漏服务器路径。
      return fail(404, 'UPLOAD_NOT_FOUND', '文件不存在');
    }
    return { upload: this.attachmentView(row), bytes };
  }

  deleteUpload(uploadId: string, userId: string) {
    const row = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    if (!row) return fail(404, 'UPLOAD_NOT_FOUND', '文件不存在');
    if (row.owner_id !== userId) return fail(403, 'FORBIDDEN', '无权访问该文件');
    if (this.store.get('SELECT 1 FROM messages WHERE attachment_id = ?', uploadId)) {
      return fail(409, 'UPLOAD_IN_USE', '该附件已被消息引用，不能删除');
    }
    // 先删库再删文件：反过来的话，删文件成功而删库失败会留下指向空文件的记录（不可读、不可删）。
    // 这里反之只会留下一个孤儿文件，由 retention sweep 兜底清理。
    this.store.run('DELETE FROM uploads WHERE id = ?', uploadId);
    removeUploadFile(this.uploadsDir, row.id, row.mime_type);
    return { ok: true as const };
  }

  markRead(conversationId: string, userId: string, lastReadSeq: number) {
    this.requireMember(conversationId, userId);
    if (lastReadSeq !== 0 && !this.store.get('SELECT 1 FROM messages WHERE conversation_id = ? AND seq = ?', conversationId, lastReadSeq)) {
      return fail(400, 'INVALID_READ_CURSOR', '已读位置必须指向本会话的消息');
    }
    this.store.run(`UPDATE conversation_members SET last_read_seq = MAX(last_read_seq, ?)
      WHERE conversation_id = ? AND user_id = ?`, lastReadSeq, conversationId, userId);
    const row = this.store.get<{ last_read_seq: number }>(
      'SELECT last_read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, userId)!;
    const result = { conversationId, userId, lastReadSeq: row.last_read_seq, unreadCount: this.unreadCount(conversationId, userId) };
    for (const recipientId of this.members(conversationId)) {
      this.realtime.publish([recipientId], 'conversation.read', { ...result,
        unreadCount: this.unreadCount(conversationId, recipientId) });
    }
    return result;
  }

  sync(userId: string, cursors: { conversationId: string; lastSeq: number }[]) {
    if (new Set(cursors.map(cursor => cursor.conversationId)).size !== cursors.length) {
      return fail(400, 'DUPLICATE_CURSOR', '每个会话只能提供一个同步游标');
    }
    return { items: cursors.map(cursor => {
      const conversation = this.conversation(cursor.conversationId, userId);
      if (cursor.lastSeq > conversation.lastSeq) return fail(400, 'INVALID_CURSOR', '同步游标超出当前会话最新序号');
      const history = this.history(cursor.conversationId, userId, 100, undefined, cursor.lastSeq);
      return { conversationId: cursor.conversationId, messages: history.items, lastSeq: conversation.lastSeq,
        unreadCount: conversation.unreadCount, hasMore: history.hasMore, nextSeq: history.items.at(-1)?.seq ?? cursor.lastSeq };
    }) };
  }

  friendRequest(requestId: string) {
    const row = this.store.get<RequestRow>('SELECT * FROM friend_requests WHERE id = ?', requestId);
    if (!row) return fail(404, 'REQUEST_NOT_FOUND', '好友申请不存在');
    return { id: row.id, sender: this.user(row.sender_id), recipient: this.user(row.recipient_id),
      note: row.note, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  createFriendRequest(userId: string, targetId: string, note: string) {
    if (userId === targetId) return fail(400, 'SELF_FRIEND_REQUEST', '不能添加自己为好友');
    this.user(targetId);
    if (this.store.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', userId, targetId)) {
      return fail(409, 'ALREADY_FRIENDS', '已经是好友');
    }
    const pending = this.store.get(`SELECT 1 FROM friend_requests WHERE status = 'pending'
      AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`, userId, targetId, targetId, userId);
    if (pending) return fail(409, 'REQUEST_PENDING', '双方已有待处理好友申请');
    const requestId = randomUUID();
    const now = new Date().toISOString();
    this.store.run(`INSERT INTO friend_requests(id, sender_id, recipient_id, note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`, requestId, userId, targetId, note.trim(), now, now);
    const request = this.friendRequest(requestId);
    this.realtime.publish([userId, targetId], 'friend.requested', { request });
    return request;
  }

  resolveFriendRequest(userId: string, requestId: string, action: 'accept' | 'reject') {
    const row = this.store.get<RequestRow>('SELECT * FROM friend_requests WHERE id = ? AND recipient_id = ?', requestId, userId);
    if (!row) return fail(404, 'REQUEST_NOT_FOUND', '好友申请不存在或无处理权限');
    if (row.status !== 'pending') return fail(409, 'REQUEST_RESOLVED', '申请已处理');
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', action === 'accept' ? 'accepted' : 'rejected', now, requestId);
      if (action === 'accept') {
        this.store.run('INSERT INTO friendships(user_id, friend_id, created_at) VALUES (?, ?, ?)', row.sender_id, row.recipient_id, now);
        this.store.run('INSERT INTO friendships(user_id, friend_id, created_at) VALUES (?, ?, ?)', row.recipient_id, row.sender_id, now);
      }
    });
    const request = this.friendRequest(requestId);
    this.realtime.publish([row.sender_id, row.recipient_id], 'friend.resolved', { request });
    return request;
  }

  // ---------------------------------------------------------------------------
  // 头像校验（契约 §十）
  // ---------------------------------------------------------------------------

  /**
   * 校验并归一头像地址。三种合法形态：
   * 1. 空串 → 清空头像；
   * 2. `https://` 外链（沿用既有校验：不得带 userinfo，避免 `https://evil@host/` 这类把戏）；
   * 3. `/api/v1/uploads/<uuid>` → 站内上传的图片，且必须是本人、kind='image'。
   *
   * 第 3 条的两个附加条件都是安全要求：
   * - 「本人」防止把别人的上传设成自己的头像（那会让头像读取绕过 §八 的授权）；
   * - 「kind='image'」防止把 pdf/zip 塞进 <img>，虽然渲染层有 nosniff 兜底，
   *   但一个非图片的 avatarUrl 本身就是数据错误，应当在写入时就拒绝。
   */
  resolveAvatarUrl(userId: string, value: string): string {
    if (value === '') return '';
    if (value.startsWith('/api/v1/uploads/')) {
      const uploadId = value.slice('/api/v1/uploads/'.length);
      // 只接受裸 uuid，不接受查询串/子路径：avatarUrl 会被原样存库并回传给前端，
      // 放宽格式等于给「存进任意字符串」开口子。
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
        return fail(400, 'INVALID_AVATAR_URL', '头像必须是空、HTTPS 外链或站内图片');
      }
      const upload = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
      if (!upload || upload.owner_id !== userId || upload.kind !== 'image') {
        return fail(400, 'INVALID_AVATAR_URL', '头像必须是空、HTTPS 外链或本人上传的图片');
      }
      return value;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid URL');
    } catch {
      return fail(400, 'INVALID_AVATAR_URL', '头像必须是空、HTTPS 外链或站内图片');
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // 消息置顶（契约 §九）
  // ---------------------------------------------------------------------------

  /** pin 记录 → 对外视图。message 与 pinnedBy 都复用既有完整结构，前端不必再拉一次。 */
  private pinnedMessage(row: PinRow) {
    const message = this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', row.msg_id);
    // 消息被保留策略删掉后 pin 记录会悬空。读列表时静默跳过而不是报错：
    // 一次清理动作不该让「打开置顶列表」直接失败。
    if (!message) return null;
    return { id: row.id, message: this.message(message), pinnedBy: this.user(row.pinned_by), pinnedAt: row.pinned_at };
  }

  listPins(conversationId: string, userId: string) {
    this.requireMember(conversationId, userId);
    const rows = this.store.all<PinRow>(
      'SELECT * FROM message_pins WHERE conversation_id = ? ORDER BY pinned_at DESC, id DESC', conversationId);
    const items = rows.map(row => this.pinnedMessage(row)).filter((item): item is NonNullable<typeof item> => item !== null);
    return { items };
  }

  /** 置顶上限。取 50 是契约 §9.2 的硬指标：超过后返回 409 PIN_LIMIT。 */
  private static readonly PIN_LIMIT = 50;

  /**
   * 置顶一条消息。成员即可（owner/admin/member 都能置顶，见契约 §7.1）。
   * 重复置顶同一条消息是幂等返回 200 原记录 —— 前端「置顶」按钮可能被连点。
   */
  pinMessage(conversationId: string, userId: string, msgId: string): { pin: ReturnType<ChatService['listPins']>['items'][number]; created: boolean } {
    this.requireMember(conversationId, userId);
    const message = this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', msgId);
    // 「不存在」与「存在但不属于本会话」合并成 400 INVALID_MESSAGE：
    // 用 404 会让 msgId 变成可探测的凭据（能判断某条消息是否存在于别的会话）。
    if (!message || message.conversation_id !== conversationId) {
      return fail(400, 'INVALID_MESSAGE', '该消息不属于本会话');
    }
    const existing = this.store.get<PinRow>('SELECT * FROM message_pins WHERE conversation_id = ? AND msg_id = ?', conversationId, msgId);
    if (existing) return { pin: this.pinnedMessage(existing)!, created: false };
    const count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM message_pins WHERE conversation_id = ?', conversationId)!.count;
    if (count >= ChatService.PIN_LIMIT) return fail(409, 'PIN_LIMIT', `单个会话最多置顶 ${ChatService.PIN_LIMIT} 条消息`);
    const pin: PinRow = { id: randomUUID(), conversation_id: conversationId, msg_id: msgId, pinned_by: userId, pinned_at: new Date().toISOString() };
    this.store.run('INSERT INTO message_pins(id, conversation_id, msg_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)',
      pin.id, pin.conversation_id, pin.msg_id, pin.pinned_by, pin.pinned_at);
    return { pin: this.pinnedMessage(pin)!, created: true };
  }

  unpinMessage(conversationId: string, userId: string, msgId: string) {
    this.requireMember(conversationId, userId);
    const existing = this.store.get<PinRow>('SELECT * FROM message_pins WHERE conversation_id = ? AND msg_id = ?', conversationId, msgId);
    if (!existing) return fail(404, 'PIN_NOT_FOUND', '该消息未被置顶');
    this.store.run('DELETE FROM message_pins WHERE id = ?', existing.id);
    return { ok: true as const };
  }

  /** 置顶变化后向全体成员广播完整列表（契约 §9.4），前端收到即整体替换，不做增量合并。 */
  private broadcastPins(conversationId: string): void {
    for (const memberId of this.members(conversationId)) {
      this.realtime.publish([memberId], 'conversation.pins', { conversationId, pins: this.listPins(conversationId, memberId).items });
    }
  }

  pin(conversationId: string, userId: string, msgId: string) {
    const result = this.pinMessage(conversationId, userId, msgId);
    // 幂等重放不广播：否则前端连点两下会收到两条内容完全相同的事件。
    if (result.created) this.broadcastPins(conversationId);
    return result;
  }

  unpin(conversationId: string, userId: string, msgId: string) {
    const result = this.unpinMessage(conversationId, userId, msgId);
    this.broadcastPins(conversationId);
    return result;
  }

  // ---------------------------------------------------------------------------
  // 管理后台（契约 §六）
  // ---------------------------------------------------------------------------

  /** 管理员身份校验。role 是数据层字段，不看 token 内容，避免「token 里写什么就是什么」。 */
  requireAdmin(userId: string): UserRow {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row) return fail(401, 'UNAUTHORIZED', '请先登录');
    if (row.role !== 'admin') return fail(403, 'ADMIN_REQUIRED', '需要管理员权限');
    return row;
  }

  adminUsers(query: string, limit: number, offset: number) {
    const trimmed = query.trim();
    // 三个字段一起模糊匹配：管理员可能手里只有「10001」这个号码，也可能只记得昵称。
    // CAST(uid AS TEXT) 而不是 uid LIKE：SQLite 的 LIKE 对整数会先转文本，
    // 但显式 CAST 让意图清楚，也避免将来换列类型时行为悄悄变化。
    const term = `%${trimmed.replace(/[\\%_]/g, match => `\\${match}`)}%`;
    const rows = trimmed === ''
      ? this.store.all<{ id: string }>('SELECT id FROM users ORDER BY uid ASC, id ASC LIMIT ? OFFSET ?', limit + 1, offset)
      : this.store.all<{ id: string }>(`SELECT id FROM users
          WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR CAST(uid AS TEXT) LIKE ? ESCAPE '\\'
          ORDER BY uid ASC, id ASC LIMIT ? OFFSET ?`, term, term, term, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => this.user(row.id)), nextOffset: rows.length > limit ? offset + limit : null };
  }

  /** 按数字 uid 找用户。管理接口的 :uid 是数字，不存在一律 404 USER_NOT_FOUND。 */
  private userByUid(uid: number): UserRow {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE uid = ?', uid);
    return row ?? fail(404, 'USER_NOT_FOUND', '用户不存在');
  }

  /** 禁言 / 解除禁言。minutes=0 表示解除（muted_until 置 NULL），而不是「禁言 0 分钟」。 */
  muteUser(actorId: string, uid: number, minutes: number) {
    this.requireAdmin(actorId);
    const target = this.userByUid(uid);
    // 管理员不受禁言约束：否则一个被禁言的管理员无法通过「解除禁言」自救，只能改库。
    if (target.role === 'admin') return fail(409, 'CANNOT_MUTE_ADMIN', '不能禁言管理员账号');
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    this.store.run('UPDATE users SET muted_until = ? WHERE id = ?', until, target.id);
    return this.user(target.id);
  }

  /**
   * 删除账号（契约 §5.4）。
   *
   * 顺序是有讲究的，不能随便调：
   * 1. 先查目标（404 / 409 都要在写之前给出）；
   * 2. 踢掉该用户所有 WS 连接 —— 先踢再删，避免删完之后还有连接在内存里拿着已失效的 session；
   * 3. 显式删 messages：sender_id 是 `REFERENCES users(id)` 且没有 ON DELETE，
   *    不先删消息，下面的 DELETE users 会被外键直接拒绝；
   * 4. 处理群主转移与空私聊；
   * 5. 最后删 users，其余关联表靠级联/直接外键清理。
   *
   * 全过程在同一个事务里：中途失败整体回滚，不会留下「消息删了人还在」或「人被删了消息还在」。
   */
  deleteUser(actorId: string, uid: number) {
    this.requireAdmin(actorId);
    const target = this.userByUid(uid);
    if (target.role === 'admin') return fail(409, 'CANNOT_DELETE_ADMIN', '不能删除管理员账号');
    // 先收集该用户的 session hash 与所在会话，事务外做 realtime 操作：
    // socket.close 是异步网络动作，放进事务里等于把「等待对端反应」压在数据库锁上。
    const sessions = this.store.all<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = ?', target.id);
    this.store.transaction(() => {
      this.store.run('DELETE FROM messages WHERE sender_id = ?', target.id);
      // 群聊：该用户的成员行即将被外键删除，先把群主身份转出去。
      const owned = this.store.all<{ id: string }>(
        "SELECT id FROM conversations WHERE type = 'group' AND owner_id = ?", target.id);
      for (const conversation of owned) {
        // 「最早加入的其他成员」= joined_at 升序的第一人（跳过即将被删的自己）。
        const successor = this.store.get<{ user_id: string }>(`SELECT user_id FROM conversation_members
          WHERE conversation_id = ? AND user_id <> ? ORDER BY joined_at, user_id LIMIT 1`, conversation.id, target.id);
        // 群里只剩群主一人：这个群已经没有存在意义，直接删群（messages/members 都级联）。
        if (!successor) {
          this.store.run('DELETE FROM conversations WHERE id = ?', conversation.id);
          continue;
        }
        const now = new Date().toISOString();
        this.store.run('UPDATE conversations SET owner_id = ?, updated_at = ? WHERE id = ?', successor.user_id, now, conversation.id);
        this.store.run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?",
          conversation.id, successor.user_id);
      }
      // 私聊：删掉他之后只剩 ≤1 人时连会话一起删（契约 §5.4「私聊会话若只剩 1 人 → 连会话一起删」）。
      // 注意 remaining 是「除目标之外的人数」，所以 remaining <= 1 正是「只剩 1 人（或 0 人）」。
      // 这里不能只看 === 0：那样会留下一个只有对方的空壳私聊，前端列表里点进去无人可聊。
      const directs = this.store.all<{ conversation_id: string }>(`SELECT conversation_id FROM conversation_members
        WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE type = 'direct')`, target.id);
      for (const direct of directs) {
        const remaining = this.store.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ? AND user_id <> ?',
          direct.conversation_id, target.id)!.count;
        if (remaining <= 1) this.store.run('DELETE FROM conversations WHERE id = ?', direct.conversation_id);
      }
      // 剩下的成员行必须显式删：conversation_members.user_id 是 `REFERENCES users(id)`
      // 但**没有** ON DELETE，直接删 users 会被外键拒绝（实测 FOREIGN KEY constraint failed）。
      // 放在群主转移之后：转移时要靠这张表找继任者。
      this.store.run('DELETE FROM conversation_members WHERE user_id = ?', target.id);
      // 好友关系与好友申请同理（两张表对 users 的两列都是 NO ACTION）：
      // 不清理的话，只要该用户有任何一个好友，整笔删除就会失败。
      this.store.run('DELETE FROM friendships WHERE user_id = ? OR friend_id = ?', target.id, target.id);
      this.store.run('DELETE FROM friend_requests WHERE sender_id = ? OR recipient_id = ?', target.id, target.id);
      // 置顶记录里 pinned_by 也是 `REFERENCES users(id)`（无 ON DELETE），必须显式清理。
      // 同理，该用户置顶过的消息行已在上面的 DELETE messages 里没了，pin 也应当一起消失。
      this.store.run('DELETE FROM message_pins WHERE pinned_by = ?', target.id);
      this.store.run(`DELETE FROM message_pins WHERE msg_id NOT IN (SELECT msg_id FROM messages)`);
      this.store.run('DELETE FROM users WHERE id = ?', target.id);
    });
    for (const session of sessions) this.realtime.revoke(session.token_hash);
    return { ok: true as const };
  }

  adminStats(actorId: string) {
    this.requireAdmin(actorId);
    const count = (table: string) => this.store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!.count;
    return {
      users: count('users'),
      conversations: count('conversations'),
      messages: count('messages'),
      uploads: count('uploads'),
      // online 只数「当前有活跃 WS 连接」的用户，不是「最近登录过」。
      online: this.realtime.onlineCount(),
    };
  }
}
