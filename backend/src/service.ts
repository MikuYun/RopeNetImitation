import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Store } from './db.ts';
import type { Realtime } from './realtime.ts';
import { fail } from './errors.ts';
import { hashPassword } from './security.ts';
import {
  MAX_STICKER_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, blockedExecutableLabel, detectMimeType, isVideo, kindFor,
  removeUploadFile, sanitizeFilename, uploadPath, writeUpload,
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
  type: 'text' | 'system' | 'image' | 'video' | 'file' | 'mixed';
  content: string;
  /** v2：撤回时间。非 NULL 即「已撤回」，此时 content 恒为空串、附件不再返回（见 message()）。 */
  recalled_at: string | null;
  /** v2：引用回复的原消息 id。原消息可能已被撤回或删除，故渲染时按存在性降级。 */
  reply_to_msg_id: string | null;
  created_at: string;
}

interface UploadRow {
  id: string;
  owner_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  kind: 'image' | 'video' | 'file';
  created_at: string;
}

/** v5：表情包行。upload_id 唯一约束是 (owner_id, upload_id)，见 db.ts。 */
interface StickerRow {
  id: string;
  owner_id: string;
  upload_id: string;
  name: string;
  created_at: string;
}

/** 列表查询里 JOIN 出来的 upload 列，全部加 upload_ 前缀以避免与 stickers 的同名列混淆。 */
interface StickerJoinRow extends StickerRow {
  upload_name: string;
  upload_mime_type: string;
  upload_size: number;
  upload_sha256: string;
  upload_owner_id: string;
  upload_kind: string;
  upload_created_at: string;
}

interface PostRow {
  id: string;
  author_id: string;
  content: string;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
  like_count: number;
  comment_count: number;
}

interface PostCommentRow {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  status: 'active' | 'deleted';
  created_at: string;
  /** LEFT JOIN 出来的原评论作者昵称；只有 reply_to_id 非空且原评论还在时才有值。 */
  reply_to_author_name?: string | null;
}

/** 附件对外视图（Attachment schema）。owner_id 与 sha256 不外泄。 */
interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'file';
  url: string;
  createdAt: string;
}

/** 附件/上传的上限常量。上传大小上限按 kind 分档（契约 §1）。 */
const ATTACHMENT_LIMIT = 9;
const VIDEO_LIMIT = 1;
/** 单条消息附件预览摘要的最大字符数（replyTo.preview 文本分支）。 */
const PREVIEW_LENGTH = 60;
/** 撤回时限：120 秒。 */
const RECALL_WINDOW_MS = 120_000;
/** 广场正文/评论字数上限（按 Unicode 码点计，见 Array.from）。 */
const POST_CONTENT_LIMIT = 5000;
const COMMENT_CONTENT_LIMIT = 1000;

/**
 * 判断上传记录属于视频（用于 be-api 层的附件分类统计）。
 *
 * 注意：真正的「是不是视频」判定必须用 upload.ts 的 `isVideo(mimeType)`，
 * 依据是**服务端嗅探出的 mime**，不是客户端声明的 Content-Type 或扩展名。
 * 这里只对已经落库的 kind 字段做分类，供 resolveAttachments 统计 video/image 数量。
 */
function isVideoKind(kind: string): boolean {
  return kind === 'video';
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
  private attachmentView(row: UploadRow): AttachmentView {
    return {
      id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, kind: row.kind,
      url: `/api/v1/uploads/${row.id}`, createdAt: row.created_at,
    };
  }

  /**
   * v2：一条消息的附件列表（按写入时的 position 升序，即用户选择的顺序）。
   *
   * 为什么不用 `WHERE uploads.id IN (...)` 一次性喂给 message()：
   * 历史/同步接口一次要渲染 N 条消息，逐条查是 N+1；
   * 但当前实现里 message() 的调用点最多 100 条（sync 上限），
   * 而 message_attachments 有 (msg_id) 主键前缀索引，单条查是 O(k)（k ∈ [0,9]）。
   * 权衡结果：先保证正确性与代码简单，量级问题留给后续按需 JOIN 优化。
   */
  private attachmentsForMessage(msgId: string): AttachmentView[] {
    const rows = this.store.all<UploadRow>(`SELECT upload.* FROM message_attachments link
      JOIN uploads upload ON upload.id = link.attachment_id
      WHERE link.msg_id = ? ORDER BY link.position`, msgId);
    return rows.map(row => this.attachmentView(row));
  }

  /** 广场帖子的附件列表，规则同 attachmentsForMessage（position 升序）。 */
  private attachmentsForPost(postId: string): AttachmentView[] {
    const rows = this.store.all<UploadRow>(`SELECT upload.* FROM post_attachments link
      JOIN uploads upload ON upload.id = link.attachment_id
      WHERE link.post_id = ? ORDER BY link.position`, postId);
    return rows.map(row => this.attachmentView(row));
  }

  /**
   * 引用回复的摘要（ReplyRef）。preview 规则见契约 §3：
   * 纯文本取前 60 个字符（按 Unicode 码点切，避免把 emoji 劈成半个代理对）；
   * 有附件时按**第一个**附件给占位符（图片 `[图片]`、视频 `[视频]`、文件 `[文件] 名称`）；
   * 混合消息（图文）按第一个附件 —— 因为气泡里预览位只有一个。
   *
   * 原消息已被撤回/删除时返回 `[消息已撤回]`：引用气泡必须始终能渲染出内容，
   * 否则前端得为「引用目标消失」单独写一条分支。
   */
  private replyPreview(row: MessageRow): string {
    if (row.recalled_at !== null) return '[消息已撤回]';
    const attachments = this.attachmentsForMessage(row.msg_id);
    const first = attachments[0];
    if (first) {
      if (first.kind === 'image') return '[图片]';
      if (first.kind === 'video') return '[视频]';
      return `[文件] ${first.name}`;
    }
    // 兜底：content 为空且无附件（理论上不该出现）时给空串，不要让预览位显示 undefined。
    if (row.content === '') return '';
    // Array.from 而不是 slice：按码点切，中文/emoji 不会被截断。
    const characters = Array.from(row.content);
    return characters.length > PREVIEW_LENGTH ? characters.slice(0, PREVIEW_LENGTH).join('') : row.content;
  }

  /**
   * 引用回复视图。原消息不存在（被 retention sweep 物理删除）→ 返回 null，
   * 此时前端按「无引用」渲染，而不是显示一条指向空气的引用。
   */
  private replyRef(replyToMsgId: string | null) {
    if (!replyToMsgId) return null;
    const target = this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', replyToMsgId);
    if (!target) return null;
    // 发送者可能已被删除账号（DELETE /admin/users 会连带删消息，但极端时序下仍可能有悬空引用）。
    // 这里用 LEFT 语义：查不到就退回 userId 作为名字，保证 ReplyRef 四个字段恒存在。
    const sender = this.store.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', target.sender_id);
    return {
      msgId: target.msg_id,
      senderId: target.sender_id,
      senderName: sender?.display_name ?? '已注销用户',
      preview: this.replyPreview(target),
    };
  }

  /**
   * 消息对外视图（v2 形状）。
   *
   * 撤回后**强制** content='' 且 attachments=[]：库里虽然也清了（recallMessage 会 DELETE 关联行），
   * 但这里是契约的最终防线 —— 无论库里怎么脏，对外都不能把撤回内容泄出去。
   */
  private message(row: MessageRow) {
    const recalled = row.recalled_at !== null;
    return {
      msgId: row.msg_id, seq: row.seq, conversationId: row.conversation_id, senderId: row.sender_id,
      clientMsgId: row.client_message_id, type: row.type,
      content: recalled ? '' : row.content,
      attachments: recalled ? [] : this.attachmentsForMessage(row.msg_id),
      recalled,
      recalledAt: row.recalled_at,
      replyTo: this.replyRef(row.reply_to_msg_id),
      createdAt: row.created_at,
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
   * v2 附件校验（消息与广场帖子共用，规则一致但允许的 kind 集合不同）。
   *
   * 一次 `IN (...)` 查全部，而不是逐个 get：数量本身要参与校验，
   * 分开查既慢又无法区分「重复 id」与「不存在」（uniqueItems 在 schema 层拦了，但 service 也要兜底）。
   *
   * 三条硬规则（契约 §1/§2/§4）：
   * 1. 全部必须存在且属主是操作者本人 —— 不存在与不属于自己合并成同一个 400，避免用错误码差异探测 uuid；
   * 2. 图片 ≤9、视频 ≤1、合计 ≤9；
   * 3. 广场额外禁止 file（chat 允许）。
   *
   * 返回值保持入参顺序（= 用户选择顺序），落库时用它当 position。
   */
  private resolveAttachments(ownerId: string, attachmentIds: string[], allowed: 'chat' | 'post'): UploadRow[] {
    if (attachmentIds.length === 0) return [];
    if (attachmentIds.length > ATTACHMENT_LIMIT) {
      return fail(400, 'ATTACHMENT_LIMIT', `附件数量不能超过 ${ATTACHMENT_LIMIT} 个`);
    }
    // 占位符按数量拼：SQLite 的 IN (?,?,?) 不能传数组，只能手工展开。
    const placeholders = attachmentIds.map(() => '?').join(', ');
    const rows = this.store.all<UploadRow>(`SELECT * FROM uploads WHERE id IN (${placeholders})`, ...attachmentIds);
    // 数量不符 = 至少有一个 id 不存在。归一到同一个错误文案，不告诉客户端「哪个不存在」。
    if (rows.length !== attachmentIds.length) return fail(400, 'INVALID_ATTACHMENT', '附件不存在或不属于你');
    const byId = new Map(rows.map(row => [row.id, row]));
    const ordered = attachmentIds.map(id => byId.get(id)!);
    for (const row of ordered) {
      if (row.owner_id !== ownerId) return fail(400, 'INVALID_ATTACHMENT', '附件不存在或不属于你');
    }
    const videoCount = ordered.filter(row => row.kind === 'video').length;
    const imageCount = ordered.filter(row => row.kind === 'image').length;
    if (videoCount > VIDEO_LIMIT) return fail(400, 'ATTACHMENT_LIMIT', `视频最多 ${VIDEO_LIMIT} 个`);
    if (imageCount > ATTACHMENT_LIMIT) return fail(400, 'ATTACHMENT_LIMIT', `图片最多 ${ATTACHMENT_LIMIT} 张`);
    // allowed='post' 时 file 占用配额但也直接拒绝：广场只支持图片与视频这两种可预览形态。
    if (allowed === 'post' && ordered.some(row => row.kind === 'file')) {
      return fail(400, 'ATTACHMENT_LIMIT', '广场不支持通用文件附件');
    }
    return ordered;
  }

  /**
   * 一附件只能用在一处（消息或广场帖子）。必须在事务内调用：
   * 查完到插入之间若有并发，靠 BEGIN IMMEDIATE 的写锁串行化保证不会双绑。
   *
   * v5 例外：若该 upload 已经是**同一个 owner** 的表情包，则放行 ——
   * 表情包的语义就是「反复发送同一个附件 id」，如果这里一视同仁地拒，
   * 一个附件收藏成表情包后就连一次都发不出去（第一次发送后 message_attachments 里就有了引用）。
   * 只放行调用者自己的表情包：别人的 upload 在 resolveAttachments 已按 owner 拒过，
   * 这里再按 owner 限定，避免把校验放宽成「谁都能复用任意表情包」。
   */
  private assertAttachmentUnused(attachmentId: string, ownerId: string): void {
    const usedByMessage = this.store.get('SELECT 1 FROM message_attachments WHERE attachment_id = ?', attachmentId);
    if (usedByMessage) {
      const sticker = this.store.get('SELECT 1 FROM stickers WHERE upload_id = ? AND owner_id = ?', attachmentId, ownerId);
      if (!sticker) return fail(409, 'UPLOAD_IN_USE', '该附件已被其他消息使用');
    }
    const usedByPost = this.store.get('SELECT 1 FROM post_attachments WHERE attachment_id = ?', attachmentId);
    if (usedByPost) {
      const sticker = this.store.get('SELECT 1 FROM stickers WHERE upload_id = ? AND owner_id = ?', attachmentId, ownerId);
      if (!sticker) return fail(409, 'UPLOAD_IN_USE', '该附件已被其他内容使用');
    }
  }

  /** 由附件组成推导消息 type（契约 §2）。混合 = 至少两种 kind。 */
  private messageTypeOf(attachments: UploadRow[]): 'text' | 'image' | 'video' | 'file' | 'mixed' {
    if (attachments.length === 0) return 'text';
    const kinds = new Set(attachments.map(row => row.kind));
    if (kinds.size > 1) return 'mixed';
    const only = attachments[0]!.kind;
    return only === 'image' ? 'image' : only === 'video' ? 'video' : 'file';
  }

  /**
   * 发送消息（v2）。
   *
   * 与 v1 的差异：
   * - 附件从单个 attachmentId 变成 attachmentIds 数组（≤9，可图文混排）；
   * - content 规则：附件消息允许**空正文**（纯图片/纯文件可单独发送），
   *   只有「无附件且无文字」被拒绝；
   * - 支持 replyToMsgId 引用回复；
   * - 幂等比较覆盖附件集合与引用目标（v1 只比单个 attachment）。
   */
  sendMessage(conversationId: string, userId: string, clientMessageId: string, content: string | undefined,
    attachmentIds: string[] = [], replyToMsgId: string | null = null) {
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
    const attachments = this.resolveAttachments(userId, attachmentIds, 'chat');
    const normalizedContent = (content ?? '').trim();
    // content 规则：**附件消息允许空正文**（纯图片/纯文件消息是合法的一等公民），
    // 但「既没有附件也没有文字」仍然拒绝 —— 那是一条没有任何内容的消息。
    //
    // v2 早期版本要求「带附件必须带文字」，初衷是让会话列表/通知有摘要可显示，
    // 但这条规则把「只想发一张图」这种最常用的操作堵死了。摘要问题改由读取侧兜底：
    // 会话列表的 `lastMessage`、引用条 preview、通知文案都在 content 为空时退回附件文案
    // （见 `attachmentsPreviewText` 与 `service.ts` 的 preview 兜底），不需要在写入侧强加约束。
    if (attachments.length === 0 && normalizedContent === '') {
      return fail(400, 'VALIDATION_ERROR', '消息内容不能为空');
    }
    // 4000 字上限：schema 已按 UTF-16 长度拦过一次，这里按码点再兜一次（与广场保持一致口径）。
    if (Array.from(normalizedContent).length > 4000) {
      return fail(400, 'VALIDATION_ERROR', '消息内容不能超过 4000 字');
    }
    // 引用目标必须存在且属于同一会话。不存在与跨会话合并成同一个错误：
    // 用不同错误码会让 msgId 变成「该消息是否存在于别的会话」的探测器。
    if (replyToMsgId !== null) {
      const target = this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', replyToMsgId);
      if (!target || target.conversation_id !== conversationId) {
        return fail(400, 'VALIDATION_ERROR', '引用的消息不存在');
      }
    }
    const type = this.messageTypeOf(attachments);
    // 幂等：同一 (sender, clientMessageId) 只允许一条消息。命中后必须逐项比对语义是否一致，
    // 否则「客户端重试」和「客户端 bug 复用 id」会被当成同一件事静默混过去。
    const existing = this.store.get<MessageRow>('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?',
      userId, clientMessageId);
    if (existing) {
      const existingAttachments = this.store.all<{ attachment_id: string }>(
        'SELECT attachment_id FROM message_attachments WHERE msg_id = ? ORDER BY position', existing.msg_id)
        .map(row => row.attachment_id);
      // 集合比较而不是数组比较：同一组附件换顺序仍是同一条消息（幂等重试不该报冲突）。
      const sameAttachments = existingAttachments.length === attachmentIds.length
        && new Set(existingAttachments).size === new Set(attachmentIds).size
        && attachmentIds.every(id => existingAttachments.includes(id));
      if (existing.conversation_id !== conversationId || existing.content !== normalizedContent
        || !sameAttachments || (existing.reply_to_msg_id ?? null) !== replyToMsgId) {
        return fail(409, 'IDEMPOTENCY_CONFLICT', '同一 clientMsgId 不可用于不同消息');
      }
      return { message: this.message(existing), created: false };
    }
    // 事务内完成「占用检查 + 插消息 + 插关联」：任一步失败整体回滚，不会留下半条消息或半个关联。
    const row = this.store.transaction(() => {
      for (const attachment of attachments) this.assertAttachmentUnused(attachment.id, userId);
      const now = new Date().toISOString();
      const next = this.store.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?', conversationId)!;
      const msgId = randomUUID();
      const inserted = this.store.run(`INSERT INTO messages(msg_id, seq, conversation_id, sender_id, client_message_id,
        type, content, reply_to_msg_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msgId, next.seq, conversationId, userId, clientMessageId, type, normalizedContent, replyToMsgId, now);
      // position 就是用户选择顺序：前端渲染九宫格时依赖它，不能靠 attachment id 排序。
      attachments.forEach((attachment, position) => {
        this.store.run('INSERT INTO message_attachments(msg_id, attachment_id, position) VALUES (?, ?, ?)',
          msgId, attachment.id, position);
      });
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

  /**
   * 撤回消息（v2）。只有发送者本人、且发出后 120 秒内可以撤回。
   *
   * 为什么撤回要**物理清空** content 与附件关联而不是只打标记：
   * 契约 §3 要求撤回后任何读取路径（历史/同步/置顶）都拿不到原文，
   * 只在 message() 里打码的话，库里的原文仍会随备份/导出泄漏。
   * 附件关联删除后附件本身仍留在 uploads 表（可被重新使用），这是有意的：
   * 撤回一条消息不该连带删掉用户刚上传的视频。
   */
  recallMessage(conversationId: string, userId: string, msgId: string) {
    this.requireMember(conversationId, userId);
    const row = this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ? AND conversation_id = ?',
      msgId, conversationId);
    // 「不存在」与「属于别的会话」合并成 404：msgId 不该成为跨会话的探测凭据。
    if (!row) return fail(404, 'NOT_FOUND', '消息不存在');
    if (row.sender_id !== userId) return fail(403, 'FORBIDDEN', '只能撤回自己的消息');
    // 幂等：已经撤回过就直接返回当前状态，不报错也不重复广播。
    if (row.recalled_at !== null) return this.message(row);
    if (Date.now() - Date.parse(row.created_at) > RECALL_WINDOW_MS) {
      return fail(403, 'RECALL_WINDOW_EXPIRED', '超过撤回时限');
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run('UPDATE messages SET recalled_at = ?, content = ? WHERE msg_id = ?', now, '', msgId);
      // 删除关联而不是保留：撤回后附件必须释放，允许同一附件在别处重新使用（契约 §2）。
      this.store.run('DELETE FROM message_attachments WHERE msg_id = ?', msgId);
    });
    const message = this.message(this.store.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', msgId)!);
    // 广播给全体成员（含发送者自己）：「所有客户端」都要立刻把气泡替换成撤回态，
    // 只发给对方会让发送者本地状态与服务器不一致。
    for (const recipientId of this.members(conversationId)) {
      this.realtime.publish([recipientId], 'message.updated', { message });
    }
    return message;
  }

  /**
   * 落盘 + 入库。先写文件再插库：写文件失败时不会留下指向空文件的记录。
   *
   * v2：上传大小上限按 kind 分档（契约 §1）——图片/文件 50 MiB，视频 100 MiB。
   * kind 由服务端嗅探出的 mimeType 决定，不信任客户端的 Content-Type / 扩展名。
   *
   * v2.3：类型不再走「白名单准入」，认不出的二进制按 application/octet-stream 收下，
   * 唯一被拒的是可执行文件（blockedExecutableLabel）。理由见 upload.ts 的 SIGNATURES 注释。
   */
  createUpload(ownerId: string, filename: string | undefined, bytes: Buffer) {
    if (bytes.length === 0) return fail(400, 'VALIDATION_ERROR', '上传内容不能为空');
    // 可执行文件先拦，给出比「不支持的文件类型」更有指导性的文案（告诉用户可以打包成 zip）。
    const blocked = blockedExecutableLabel(bytes);
    if (blocked !== null) {
      return fail(415, 'UNSUPPORTED_MEDIA_TYPE', `不支持上传${blocked}，请压缩成 zip 后发送`);
    }
    const mimeType = detectMimeType(bytes);
    const kind = kindFor(mimeType);
    // 先按 kind 选上限再判超限：视频 100 MiB，其余 50 MiB。
    // 用 isVideo(mimeType) 而不是 kind === 'video'：前者是 mime 前缀判定，与 upload.ts 内部分档同源。
    const limit = isVideo(mimeType) ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES;
    if (bytes.length > limit) {
      return fail(413, 'UPLOAD_TOO_LARGE', `单个文件不能超过 ${limit} 字节`);
    }
    const id = randomUUID();
    const { sha256, size } = writeUpload(this.uploadsDir, id, mimeType, bytes);
    const name = sanitizeFilename(filename);
    const createdAt = new Date().toISOString();
    try {
      this.store.run(`INSERT INTO uploads(id, owner_id, name, mime_type, size, sha256, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, ownerId, name, mimeType, size, sha256, kind, createdAt);
    } catch (error) {
      // 插库失败（磁盘满/约束冲突）时把刚落盘的字节清掉，避免产生永远查不到的孤儿文件。
      removeUploadFile(this.uploadsDir, id, mimeType);
      throw error;
    }
    return { id, name, mimeType, size, sha256, kind, url: `/api/v1/uploads/${id}`, createdAt };
  }

  /**
   * 读上传（契约 §1 的读取授权，v2 扩到四档）。
   *
   * 1. 属主本人 → 允许；
   * 2. 该附件被某条消息引用，且请求者是那条消息所在会话的成员 → 允许（聊天常态）；
   * 3. 该附件被某个**未删除**的广场帖子引用 → 任意登录用户允许
   *    （广场是公开内容，若还要求「作者本人」那广场图片对所有人都是破图）；
   *    status='deleted' 的帖子不再放行，否则软删后图片仍可被猜到 uuid 的人读取；
   * 4. 该附件被用作某个用户头像或群头像 → 任意登录用户允许
   *    （头像会出现在好友列表、群成员、搜索等所有地方，本来就无法限定为「同会话可见」）。
   *
   * 【为什么不加「本人收藏的表情」一档】表情包的 uploadId 必然属于收藏者本人
   * （`createSticker` 强制 `upload.owner_id === ownerId`），收藏时压缩产生的新图也是
   * 本人上传的，所以走第 1 档就够；再加一档是永远命不中的死代码。
   *
   * 为什么第 2 档要「先看消息引用再看会话成员」而不是直接按 owner 放行：
   * 附件本身没有会话归属，同一张图可以被转发到多个会话，只有顺着 message_attachments 反查才能知道
   * 「这个请求者是否有权看到这张图」。未被任何内容引用的上传（刚传完还没发出去）不能跨人访问，
   * 否则任何拿到 UUID 的人都能读别人正在编辑的草稿附件。
   */
  /**
   * 非属主的读取授权判定（契约 §1 的 ②③④ 三档）。
   * 抽成独立方法是因为 readUpload 与 deleteUpload 的语义不同（后者只看属主），
   * 而这里的三条 SQL 各自独立、任一命中即放行 —— 用 `||` 的短路顺序按「命中率从高到低」排：
   * 消息引用最常见，广场帖子次之，头像最少。
   */
  private canReadAttachment(uploadId: string, userId: string): boolean {
    // ② 被某条消息引用，且请求者是那条消息所在会话的成员。
    const viaMessage = this.store.get(`SELECT 1 FROM message_attachments link
      JOIN messages message ON message.msg_id = link.msg_id
      JOIN conversation_members member ON member.conversation_id = message.conversation_id
      WHERE link.attachment_id = ? AND member.user_id = ?`, uploadId, userId);
    if (viaMessage) return true;
    // ③ 被某个未删除的广场帖子引用 → 任意登录用户可读。
    const viaPost = this.store.get(`SELECT 1 FROM post_attachments link
      JOIN posts post ON post.id = link.post_id
      WHERE link.attachment_id = ? AND post.status = 'active'`, uploadId);
    if (viaPost) return true;
    // ④ 被用作头像（用户或群）。两种头像的存储格式都是 '/api/v1/uploads/<id>'，
    // 所以这里按这个前缀拼出被引用的字符串再精确匹配，不做 LIKE（避免 uuid 前缀被误判）。
    const reference = `/api/v1/uploads/${uploadId}`;
    const asAvatar = this.store.get(`SELECT 1 FROM users WHERE avatar_url = ?
      UNION ALL SELECT 1 FROM conversations WHERE avatar_url = ?`, reference, reference);
    return Boolean(asAvatar);
  }

  readUpload(uploadId: string, userId: string) {
    const row = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    if (!row) return fail(404, 'UPLOAD_NOT_FOUND', '文件不存在');
    if (row.owner_id !== userId && !this.canReadAttachment(uploadId, userId)) {
      // 保持 403 FORBIDDEN（契约 §1 明确要求沿用原码）：uuid 不可枚举，403 让前端区分「无权限」与「已删除」。
      return fail(403, 'FORBIDDEN', '无权访问该文件');
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
    // v2：一处引用即不可删。消息与广场帖子两条关联表都要查（v1 只看 messages）。
    const inUse = this.store.get('SELECT 1 FROM message_attachments WHERE attachment_id = ?', uploadId)
      ?? this.store.get('SELECT 1 FROM post_attachments WHERE attachment_id = ?', uploadId);
    if (inUse) return fail(409, 'UPLOAD_IN_USE', '该附件已被消息引用，不能删除');
    // v5：被收藏成表情包也不能删 —— 删掉 upload 后表情包会变成永远 404 的破图。
    // 用户要先在表情包面板里删掉该表情包，才能删这个上传。
    if (this.store.get('SELECT 1 FROM stickers WHERE upload_id = ?', uploadId)) {
      return fail(409, 'UPLOAD_IN_USE', '该附件已被表情包引用');
    }
    // 先删库再删文件：反过来的话，删文件成功而删库失败会留下指向空文件的记录（不可读、不可删）。
    // 这里反之只会留下一个孤儿文件，由 retention sweep 兜底清理。
    this.store.run('DELETE FROM uploads WHERE id = ?', uploadId);
    removeUploadFile(this.uploadsDir, row.id, row.mime_type);
    return { ok: true as const };
  }

  /** 表情包允许的 mime 白名单。GIF 保留动图能力，SVG 明确排除（可内嵌脚本，XSS 面）。 */
  private static readonly STICKER_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  ]);

  /**
   * 表情包对外视图：把 upload 的展示字段摊平进来。
   *
   * 为什么不直接返回 uploadId 让前端再查：表情包面板一次要画几十个，
   * 每个都发一次 GET /uploads/:id 是几十次往返；这些字段本来就是 upload 的冗余副本。
   */
  private stickerView(row: StickerRow, upload: UploadRow) {
    return {
      id: row.id,
      uploadId: row.upload_id,
      name: row.name === '' ? upload.name : row.name,
      mimeType: upload.mime_type,
      size: upload.size,
      kind: 'image' as const,
      url: `/api/v1/uploads/${row.upload_id}`,
      createdAt: row.created_at,
    };
  }

  /** 表情包列表（只返回本人）。按 created_at 倒序：最新收藏的排最前。 */
  listStickers(ownerId: string, limit: number, offset: number) {
    // 多取一条用于判断 nextOffset 是否有下一页，避免额外 COUNT 查询。
    const rows = this.store.all<StickerJoinRow>(
      `SELECT sticker.id, sticker.owner_id, sticker.upload_id, sticker.name, sticker.created_at,
         upload.name AS upload_name, upload.mime_type AS upload_mime_type, upload.size AS upload_size,
         upload.sha256 AS upload_sha256, upload.owner_id AS upload_owner_id,
         upload.kind AS upload_kind, upload.created_at AS upload_created_at
       FROM stickers sticker JOIN uploads upload ON upload.id = sticker.upload_id
       WHERE sticker.owner_id = ?
       ORDER BY sticker.created_at DESC, sticker.id DESC
       LIMIT ? OFFSET ?`, ownerId, limit + 1, offset,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(row => this.stickerView(row, this.stickerUploadOf(row))),
      nextOffset: rows.length > limit ? offset + page.length : null,
    };
  }

  /** 把列表查询里拼进来的 upload 字段还原成 UploadRow，供 stickerView 复用。 */
  private stickerUploadOf(row: StickerJoinRow): UploadRow {
    return {
      id: row.upload_id,
      owner_id: row.upload_owner_id,
      name: row.upload_name,
      mime_type: row.upload_mime_type,
      size: row.upload_size,
      sha256: row.upload_sha256,
      kind: row.upload_kind as UploadRow['kind'],
      created_at: row.upload_created_at,
    };
  }

  /**
   * 收藏表情包（幂等）。
   *
   * 返回值带 created 标志：路由据此决定 201 还是 200。
   * 为什么幂等而不是 409：前端「点一下添加到表情」是常见双击目标，
   * 重复提交报错会让用户看到一个莫名其妙的红条，而已存在时返回同一个对象语义更自然。
   *
   * 校验全部归一到 400 INVALID_STICKER 一条文案（契约 §stickers）：
   * 对客户端来说「这个 upload 不能当表情包」是一个判断，区分「不存在/不是你的/不是图片」
   * 只会增加前端分支，而且会成为探测他人 upload 是否存在的侧信道。
   *
   * 体积上限走单独的 413 STICKER_TOO_LARGE：这一条是可以被用户自行解决的
   * （压缩/裁剪后重传），与「这个资源你不能用」不是一回事，混进 400 会让前端无法给出可操作提示。
   */
  createSticker(ownerId: string, uploadId: string) {
    const upload = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    const invalid = () => fail(400, 'INVALID_STICKER', '表情包只支持 PNG/JPEG/WebP/GIF 图片');
    if (!upload) return invalid();
    if (upload.owner_id !== ownerId) return invalid();
    if (upload.kind !== 'image') return invalid();
    if (!ChatService.STICKER_MIME_TYPES.has(upload.mime_type)) return invalid();
    // 体积兜底（v2.5）：前端收藏前会压到 512px WebP，但客户端逻辑可以被绕过，
    // 而表情一旦被收藏就永远躲过 sweep（sweep 把 stickers 视为在用引用），
    // 服务端必须自己再挡一次，否则「每人存一点」就是无上限的永久磁盘占用。
    if (upload.size > MAX_STICKER_BYTES) {
      return fail(413, 'STICKER_TOO_LARGE',
        `表情包单张不能超过 ${MAX_STICKER_BYTES} 字节（2 MiB），请先压缩或裁剪后再收藏`);
    }
    // 唯一约束是 (owner, upload)，所以这一条查询与下面的 INSERT 之间不会有「别人的同图」干扰。
    const existing = this.store.get<StickerRow>('SELECT * FROM stickers WHERE owner_id = ? AND upload_id = ?',
      ownerId, uploadId);
    if (existing) return { sticker: this.stickerView(existing, upload), created: false };
    const row: StickerRow = {
      id: randomUUID(), owner_id: ownerId, upload_id: uploadId, name: '', created_at: new Date().toISOString(),
    };
    this.store.run('INSERT INTO stickers(id, owner_id, upload_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id, row.owner_id, row.upload_id, row.name, row.created_at);
    return { sticker: this.stickerView(row, upload), created: true };
  }

  /**
   * 删除表情包。
   *
   * 顺序刻意是「先查属主，再删」：非属主返回 403 而不是 404，
   * 与 DELETE /uploads/:id 的口径一致（uuid 不可枚举，403/404 的差别不构成探测面）。
   *
   * 删除后如果这个 upload 已经没有任何消息/帖子引用，就把它和磁盘文件一起删掉：
   * 否则用户每收藏再删一次表情包，uploads 里就会永久沉淀一份没用的字节。
   * 反过来，若还有消息在用（表情包发出去过），upload 必须留着，否则历史消息会变成破图。
   */
  deleteSticker(stickerId: string, userId: string) {
    const row = this.store.get<StickerRow>('SELECT * FROM stickers WHERE id = ?', stickerId);
    if (!row) return fail(404, 'STICKER_NOT_FOUND', '表情包不存在');
    if (row.owner_id !== userId) return fail(403, 'FORBIDDEN', '无权操作该表情包');
    return this.store.transaction(() => {
      this.store.run('DELETE FROM stickers WHERE id = ?', stickerId);
      const upload = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', row.upload_id);
      if (upload && upload.owner_id === userId) {
        const referenced = this.store.get('SELECT 1 FROM message_attachments WHERE attachment_id = ?', upload.id)
          ?? this.store.get('SELECT 1 FROM post_attachments WHERE attachment_id = ?', upload.id)
          ?? this.store.get('SELECT 1 FROM stickers WHERE upload_id = ?', upload.id);
        if (!referenced) {
          this.store.run('DELETE FROM uploads WHERE id = ?', upload.id);
          removeUploadFile(this.uploadsDir, upload.id, upload.mime_type);
        }
      }
      return { ok: true as const };
    });
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
  // ---------------------------------------------------------------------------
  // 访客资料（v2 契约 §2）
  // ---------------------------------------------------------------------------

  /**
   * 陌生人可访问的用户资料 + 与当前查看者的关系。
   *
   * 为什么 relationship 要由后端判定而不是前端自己拼：
   * 好友关系是双写的（accept 时插两行），但「待处理申请」有方向性 ——
   * 同一条 pending 记录，发送者看到的是「已申请」，接收者看到的是「待处理」。
   * 让前端去查两张表并判断方向，等于把权限/状态机逻辑复制一份到客户端。
   *
   * 返回值里的 user 必须走 this.user()：它只映射白名单字段，
   * 直接把 UserRow 透传会把 password_hash 一起序列化出去。
   */
  getUserProfile(viewerId: string, targetId: string) {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', targetId);
    if (!row) return fail(404, 'NOT_FOUND', '用户不存在');
    let relationship: 'none' | 'friend' | 'request_sent' | 'request_received' | 'self' = 'none';
    if (viewerId === targetId) {
      relationship = 'self';
    } else if (this.store.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', viewerId, targetId)) {
      relationship = 'friend';
    } else {
      // 只查 pending：accepted/rejected 的历史申请不该影响当前关系展示。
      // 一条 SQL 同时问两个方向，靠 sender 是否等于 viewer 区分语义。
      const pending = this.store.get<{ sender_id: string }>(`SELECT sender_id FROM friend_requests
        WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
      viewerId, targetId, targetId, viewerId);
      if (pending) relationship = pending.sender_id === viewerId ? 'request_sent' : 'request_received';
    }
    // 单聊会话用 direct_key 精确定位（排序后 a:b 拼接，见 direct()）。
    // 不复用 direct() 是因为它会「不存在就建」，而这里只是查看资料，不能有写副作用。
    const key = [viewerId, targetId].sort().join(':');
    const conversation = viewerId === targetId
      ? undefined
      : this.store.get<{ id: string }>('SELECT id FROM conversations WHERE direct_key = ?', key);
    const postCount = this.store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM posts WHERE author_id = ? AND status = 'active'", targetId)!.count;
    // friendships 是双写表，单边 COUNT 就是完整好友数（不该 UNION 另一列，会重复计数）。
    const friendCount = this.store.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_id = ?', targetId)!.count;
    return {
      user: this.user(targetId), relationship, conversationId: conversation?.id ?? null, postCount, friendCount,
    };
  }

  // ---------------------------------------------------------------------------
  // 广场（v2 契约 §4）
  // ---------------------------------------------------------------------------

  /**
   * 不透明游标：`base64url(JSON({t, id}))`。
   *
   * 为什么不用裸 offset：广场按 created_at DESC 且新帖不断插入，
   * offset 分页在翻页期间会重复/漏掉条目。键集分页（keyset）用「上一页最后一行的排序键」，
   * 对 (created_at, id) 做严格小于即可稳定续页 —— id 参与比较是为了给同毫秒的帖子一个确定的次序。
   *
   * 编码成 base64url 有两个目的：① 让客户端无法手工构造（实现可自由改内部结构）；
   * ② 避免 `|` 之类的分隔符在 URL 里需要转义。
   */
  private static encodeCursor(createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ t: createdAt, id }), 'utf8').toString('base64url');
  }

  private static decodeCursor(cursor: string | undefined): { t: string; id: string } | null {
    if (cursor === undefined || cursor === '') return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
      // 结构校验：非法游标一律 400，而不是静默当成「第一页」—— 后者会让前端无限翻页回到开头。
      if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
      return { t: parsed.t, id: parsed.id };
    } catch {
      return null;
    }
  }

  /** 帖子对外视图。likedByMe/mine 由 viewerId 决定，author 复用 User 形状。 */
  private post(row: PostRow, viewerId: string) {
    return {
      id: row.id,
      author: this.user(row.author_id),
      content: row.content,
      attachments: this.attachmentsForPost(row.id),
      likeCount: row.like_count,
      commentCount: row.comment_count,
      likedByMe: Boolean(this.store.get('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', row.id, viewerId)),
      mine: row.author_id === viewerId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 广场列表（created_at DESC）。cursor 非法 → 400 INVALID_CURSOR：
   * 静默降级会让客户端以为自己翻到了第一页，表现为「列表突然跳回顶部」。
   */
  listPosts(viewerId: string, cursor: string | undefined, limit: number) {
    const position = ChatService.decodeCursor(cursor);
    if (cursor !== undefined && cursor !== '' && position === null) {
      return fail(400, 'INVALID_CURSOR', '分页游标无效');
    }
    const rows = position === null
      ? this.store.all<PostRow>(`SELECT * FROM posts WHERE status = 'active'
          ORDER BY created_at DESC, id DESC LIMIT ?`, limit + 1)
      // (created_at, id) 复合比较：时间相同的帖子靠 id 决定先后，保证分页不重不漏。
      : this.store.all<PostRow>(`SELECT * FROM posts WHERE status = 'active'
          AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`, position.t, position.t, position.id, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(row => this.post(row, viewerId)),
      nextCursor: rows.length > limit && last ? ChatService.encodeCursor(last.created_at, last.id) : null,
    };
  }

  getPost(viewerId: string, postId: string) {
    const row = this.store.get<PostRow>("SELECT * FROM posts WHERE id = ? AND status = 'active'", postId);
    // 已软删与不存在统一 404：软删的帖子不该还能通过 id 探测到「曾经存在」。
    if (!row) return fail(404, 'NOT_FOUND', '帖子不存在');
    return this.post(row, viewerId);
  }

  /** 某人的广场帖子（访客资料页用），分页与可见性规则同 listPosts。 */
  listUserPosts(viewerId: string, authorId: string, cursor: string | undefined, limit: number) {
    const row = this.store.get<UserRow>('SELECT * FROM users WHERE id = ?', authorId);
    if (!row) return fail(404, 'NOT_FOUND', '用户不存在');
    const position = ChatService.decodeCursor(cursor);
    if (cursor !== undefined && cursor !== '' && position === null) {
      return fail(400, 'INVALID_CURSOR', '分页游标无效');
    }
    const rows = position === null
      ? this.store.all<PostRow>(`SELECT * FROM posts WHERE status = 'active' AND author_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`, authorId, limit + 1)
      : this.store.all<PostRow>(`SELECT * FROM posts WHERE status = 'active' AND author_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`, authorId, position.t, position.t, position.id, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(item => this.post(item, viewerId)),
      nextCursor: rows.length > limit && last ? ChatService.encodeCursor(last.created_at, last.id) : null,
    };
  }

  /**
   * 发帖。契约 §4：`content.trim()` 非空**或**至少一个附件，两者都空 → 400。
   * 附件额外禁止 file（广场只展示图片与视频）。
   */
  createPost(authorId: string, content: string | undefined, attachmentIds: string[] = []) {
    const normalized = (content ?? '').trim();
    const attachments = this.resolveAttachments(authorId, attachmentIds, 'post');
    if (normalized === '' && attachments.length === 0) {
      return fail(400, 'VALIDATION_ERROR', '帖子内容不能为空');
    }
    // 按码点计字数：中文/emoji 都算 1 个字，与前端输入框的计数口径一致。
    if (Array.from(normalized).length > POST_CONTENT_LIMIT) {
      return fail(400, 'VALIDATION_ERROR', `帖子内容不能超过 ${POST_CONTENT_LIMIT} 字`);
    }
    const postId = randomUUID();
    const now = new Date().toISOString();
    const row = this.store.transaction(() => {
      for (const attachment of attachments) this.assertAttachmentUnused(attachment.id, authorId);
      this.store.run(`INSERT INTO posts(id, author_id, content, status, created_at, updated_at, like_count, comment_count)
        VALUES (?, ?, ?, 'active', ?, ?, 0, 0)`, postId, authorId, normalized, now, now);
      attachments.forEach((attachment, position) => {
        this.store.run('INSERT INTO post_attachments(post_id, attachment_id, position) VALUES (?, ?, ?)',
          postId, attachment.id, position);
      });
      return this.store.get<PostRow>('SELECT * FROM posts WHERE id = ?', postId)!;
    });
    // 广场事件发给所有在线用户，载荷只带 {postId, actorId}：完整 Post 含作者与附件数组，
    // 在线用户多时同一条事件会按人数放大带宽（见 realtime.broadcastAll 注释）。
    this.realtime.broadcastAll('post.created', { postId, actorId: authorId });
    return this.post(row, authorId);
  }

  deletePost(viewerId: string, postId: string, isAdmin: boolean) {
    const row = this.store.get<PostRow>("SELECT * FROM posts WHERE id = ? AND status = 'active'", postId);
    if (!row) return fail(404, 'NOT_FOUND', '帖子不存在');
    if (row.author_id !== viewerId && !isAdmin) return fail(403, 'FORBIDDEN', '只能删除自己的帖子');
    const now = new Date().toISOString();
    // 软删：保留行以便审计与「评论数最终一致」，列表/详情靠 status 过滤。
    this.store.run("UPDATE posts SET status = 'deleted', updated_at = ? WHERE id = ?", now, postId);
    this.realtime.broadcastAll('post.deleted', { postId, actorId: viewerId });
    return { ok: true as const };
  }

  /**
   * 点赞 / 取消点赞。
   *
   * like_count 用「重算」而不是 `like_count + 1`：后者在并发下（两个事务各读到旧值）
   * 或异常路径（插入被 IGNORE 但仍自增）会永久漂移，且漂移无法自愈。
   * 重算是一次 COUNT，代价可忽略，换来的是计数永远等于真实行数。
   */
  private setPostLike(viewerId: string, postId: string, liked: boolean) {
    const row = this.store.get<PostRow>("SELECT * FROM posts WHERE id = ? AND status = 'active'", postId);
    if (!row) return fail(404, 'NOT_FOUND', '帖子不存在');
    const likeCount = this.store.transaction(() => {
      if (liked) {
        // INSERT OR IGNORE 让重复点赞幂等（前端连点不应报错）。
        this.store.run('INSERT OR IGNORE INTO post_likes(post_id, user_id, created_at) VALUES (?, ?, ?)',
          postId, viewerId, new Date().toISOString());
      } else {
        this.store.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', postId, viewerId);
      }
      this.store.run('UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) WHERE id = ?',
        postId, postId);
      return this.store.get<{ like_count: number }>('SELECT like_count FROM posts WHERE id = ?', postId)!.like_count;
    });
    this.realtime.broadcastAll('post.liked', { postId, actorId: viewerId });
    return { liked, likeCount };
  }

  likePost(viewerId: string, postId: string) {
    return this.setPostLike(viewerId, postId, true);
  }

  unlikePost(viewerId: string, postId: string) {
    return this.setPostLike(viewerId, postId, false);
  }

  /** 评论视图。replyToAuthorName 由 SQL 的 LEFT JOIN 直接带出，避免 N+1。 */
  private postComment(row: PostCommentRow) {
    return {
      id: row.id, postId: row.post_id, author: this.user(row.author_id), content: row.content,
      replyToId: row.reply_to_id, replyToAuthorName: row.reply_to_author_name ?? null, createdAt: row.created_at,
    };
  }

  /**
   * 评论列表（created_at ASC，即从旧到新）。分页同样用 (created_at, id) 键集，
   * 但方向相反：续页条件是「大于上一页最后一行」。
   * 排序键里 id 用升序，与 created_at ASC 保持一致，否则同毫秒评论会乱序。
   */
  listPostComments(postId: string, cursor: string | undefined, limit: number) {
    const post = this.store.get<PostRow>("SELECT * FROM posts WHERE id = ? AND status = 'active'", postId);
    if (!post) return fail(404, 'NOT_FOUND', '帖子不存在');
    const position = ChatService.decodeCursor(cursor);
    if (cursor !== undefined && cursor !== '' && position === null) {
      return fail(400, 'INVALID_CURSOR', '分页游标无效');
    }
    // 一次 JOIN 取评论 + 原评论作者昵称；parent 可能是已软删的评论，此时仍显示其作者
    // （「回复某某」是历史事实，不该因为对方删了评论就变成「回复 null」）。
    const select = `SELECT comment.*, parent_author.display_name AS reply_to_author_name
      FROM post_comments comment
      LEFT JOIN post_comments parent ON parent.id = comment.reply_to_id
      LEFT JOIN users parent_author ON parent_author.id = parent.author_id
      WHERE comment.post_id = ? AND comment.status = 'active'`;
    const rows = position === null
      ? this.store.all<PostCommentRow>(`${select} ORDER BY comment.created_at ASC, comment.id ASC LIMIT ?`,
        postId, limit + 1)
      : this.store.all<PostCommentRow>(`${select}
          AND (comment.created_at > ? OR (comment.created_at = ? AND comment.id > ?))
          ORDER BY comment.created_at ASC, comment.id ASC LIMIT ?`,
      postId, position.t, position.t, position.id, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(row => this.postComment(row)),
      nextCursor: rows.length > limit && last ? ChatService.encodeCursor(last.created_at, last.id) : null,
    };
  }

  createPostComment(authorId: string, postId: string, content: string, replyToId: string | null) {
    const post = this.store.get<PostRow>("SELECT * FROM posts WHERE id = ? AND status = 'active'", postId);
    if (!post) return fail(404, 'NOT_FOUND', '帖子不存在');
    const normalized = content.trim();
    if (normalized === '') return fail(400, 'VALIDATION_ERROR', '评论内容不能为空');
    if (Array.from(normalized).length > COMMENT_CONTENT_LIMIT) {
      return fail(400, 'VALIDATION_ERROR', `评论内容不能超过 ${COMMENT_CONTENT_LIMIT} 字`);
    }
    if (replyToId !== null) {
      // 必须存在且属于同一帖子：否则会造出「回复了另一个帖子的评论」这种指向错乱的数据。
      const target = this.store.get<PostCommentRow>(
        "SELECT * FROM post_comments WHERE id = ? AND post_id = ? AND status = 'active'", replyToId, postId);
      if (!target) return fail(400, 'VALIDATION_ERROR', '引用的评论不存在');
    }
    const commentId = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(`INSERT INTO post_comments(id, post_id, author_id, content, reply_to_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)`, commentId, postId, authorId, normalized, replyToId, now);
      // 评论数重算，理由同 like_count。
      this.store.run('UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ? AND status = \'active\') WHERE id = ?',
        postId, postId);
    });
    this.realtime.broadcastAll('post.commented', { postId, actorId: authorId });
    const row = this.store.get<PostCommentRow>(`SELECT comment.*, parent_author.display_name AS reply_to_author_name
      FROM post_comments comment
      LEFT JOIN post_comments parent ON parent.id = comment.reply_to_id
      LEFT JOIN users parent_author ON parent_author.id = parent.author_id
      WHERE comment.id = ?`, commentId)!;
    return this.postComment(row);
  }

  deletePostComment(viewerId: string, postId: string, commentId: string, isAdmin: boolean) {
    const row = this.store.get<PostCommentRow>(
      "SELECT * FROM post_comments WHERE id = ? AND post_id = ? AND status = 'active'", commentId, postId);
    if (!row) return fail(404, 'NOT_FOUND', '评论不存在');
    if (row.author_id !== viewerId && !isAdmin) return fail(403, 'FORBIDDEN', '只能删除自己的评论');
    this.store.transaction(() => {
      this.store.run("UPDATE post_comments SET status = 'deleted' WHERE id = ?", commentId);
      this.store.run('UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ? AND status = \'active\') WHERE id = ?',
        postId, postId);
    });
    return { ok: true as const };
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

  /**
   * 是否为管理员 —— 供「作者或管理员可删」这类**可选**授权用。
   *
   * 与 requireAdmin 的区别：这里不抛错，普通用户返回 false 即可，
   * 因为删帖/删评论的主路径是「作者本人」，管理员只是额外一条旁路。
   * 用 requireAdmin 会把「普通用户删自己的帖子」也判成 403。
   */
  isAdmin(userId: string): boolean {
    return this.store.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId)?.role === 'admin';
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
      // v2 广场：三张表对 users 都有外键（作者 / 点赞者 / 评论作者），不清理会直接 FOREIGN KEY failed。
      // 顺序要求：先删评论与点赞，再删帖子（评论行引用 posts.id）。
      this.store.run('DELETE FROM post_comments WHERE author_id = ?', target.id);
      this.store.run('DELETE FROM post_likes WHERE user_id = ?', target.id);
      // 该用户的帖子整帖删除（而不是软删）：作者账号都没了，软删的帖子仍会占着附件绑定，
      // 让附件永远无法被复用。物理删帖后 post_attachments 的行随外键级联消失，附件得以释放。
      const ownedPosts = this.store.all<{ id: string }>('SELECT id FROM posts WHERE author_id = ?', target.id);
      for (const post of ownedPosts) {
        this.store.run('DELETE FROM post_comments WHERE post_id = ?', post.id);
        this.store.run('DELETE FROM post_likes WHERE post_id = ?', post.id);
        this.store.run('DELETE FROM posts WHERE id = ?', post.id);
      }
      // 他人在他帖子下的评论已随上面一起删；但别人帖子下、别人对「他发的评论」的回复
      // 仍指向已被删的评论 —— reply_to_id 若带外键会阻塞，这里统一置空，保留回复内容本身。
      this.store.run('UPDATE post_comments SET reply_to_id = NULL WHERE reply_to_id IS NOT NULL AND reply_to_id NOT IN (SELECT id FROM post_comments)');
      // v5 表情包不需要显式清理：stickers.owner_id 与 stickers.upload_id 都是 ON DELETE CASCADE，
      // 删 users 会级联删 uploads、再级联删 stickers，两跳都由 SQLite 按声明完成。
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
