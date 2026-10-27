import { Type } from '@sinclair/typebox';

export const Id = Type.String({ format: 'uuid' });
export const Timestamp = Type.String({ format: 'date-time' });
export const Text = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum, pattern: '\\S' });
export const Sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// 群内角色。owner 由 conversations.owner_id 决定，admin 由群主授予，member 是默认值。
// 单独提成常量是因为 Member.role 与 Conversation.myRole 必须完全一致，
// 两处各写一份 Union 迟早会漏改一处，导致 openapi 里两个同名枚举字段取值不同。
export const GroupRole = Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('member')]);
// 用户在管理后台的开关：banned 后无法登录；mutedUntil 只影响发消息。
export const UserRole = Type.Union([Type.Literal('user'), Type.Literal('admin')]);
export const UserStatus = Type.Union([Type.Literal('active'), Type.Literal('banned')]);
export const User = Type.Object({
  id: Id,
  // uid 是对外展示、也可用于登录的稳定数字 id：UUID 太难念，用户之间互加好友需要个好念的编号。
  uid: Type.Integer({ minimum: 1 }),
  username: Type.String(),
  displayName: Type.String(),
  avatarUrl: Type.String(),
  bio: Type.String(),
  role: UserRole,
  status: UserStatus,
  // 恒存在的可空字段，语义见契约 §四：非 null 且晚于当前时间才算「当前被禁言」。
  mutedUntil: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
  online: Type.Boolean(),
});
// v2：附件三类。image/file 上限 10 MiB，video 上限 100 MiB；
// 单独提成常量是因为 Upload / Attachment / 请求体三处校验必须完全一致。
export const AttachmentKind = Type.Union([
  Type.Literal('image'), Type.Literal('video'), Type.Literal('file'),
]);
export const Attachment = Type.Object({
  id: Id,
  name: Type.String(),
  mimeType: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  kind: AttachmentKind,
  url: Type.String(),
  createdAt: Timestamp,
});
// 引用回复的摘要：只回传渲染气泡所需的四个字段，不嵌完整 Message
// （否则一条回复会把整棵引用链都带出来，深度嵌套没有上界）。
export const ReplyRef = Type.Object({
  msgId: Id,
  senderId: Id,
  senderName: Type.String(),
  preview: Type.String(),
});
export const Message = Type.Object({
  msgId: Id,
  conversationId: Id,
  senderId: Id,
  clientMsgId: Id,
  seq: Type.Integer({ minimum: 1 }),
  type: Type.Union([
    Type.Literal('text'), Type.Literal('system'), Type.Literal('image'),
    Type.Literal('video'), Type.Literal('file'), Type.Literal('mixed'),
  ]),
  // 可为空串：v2 允许「有附件」的消息带空 content（但发送时要求非空，见 API-V2 §2）。
  content: Type.String(),
  // 恒存在的数组：无附件为 []。v2 用数组替换了 v1 的单数 attachment，
  // 前端读取点不必再判 null，少一个会漏判的分支。
  attachments: Type.Array(Attachment),
  recalled: Type.Boolean(),
  recalledAt: Type.Union([Timestamp, Type.Null()]),
  // 恒存在的可空字段：非回复消息为 null。
  replyTo: Type.Union([ReplyRef, Type.Null()]),
  createdAt: Timestamp,
});
const AttachmentIds = Type.Array(Id, { minItems: 1, maxItems: 9, uniqueItems: true });
export const SendMessageBody = Type.Object({
  clientMsgId: Id,
  // 上限 4000 按码点算（与广场 5000 一致）：emoji 不能因为代理对而少算一半额度。
  content: Type.Optional(Type.String({ maxLength: 4000 })),
  attachmentIds: Type.Optional(AttachmentIds),
  // 允许显式传 null 表示「不引用」，与省略同义；前端从 state 直接透传时不必做清理。
  replyToMsgId: Type.Optional(Type.Union([Id, Type.Null()])),
}, { additionalProperties: false });
export const RecallParams = Type.Object({ conversationId: Id, msgId: Id });

// ---------- 访客资料（API-V2 §3） ----------
export const Relationship = Type.Union([
  Type.Literal('none'), Type.Literal('friend'),
  Type.Literal('request_sent'), Type.Literal('request_received'), Type.Literal('self'),
]);
export const UserProfileView = Type.Object({
  user: User,
  relationship: Relationship,
  conversationId: Type.Union([Id, Type.Null()]),
  postCount: Type.Integer({ minimum: 0 }),
  friendCount: Type.Integer({ minimum: 0 }),
});
export const UserIdParams = Type.Object({ userId: Id });

// ---------- 广场（API-V2 §4） ----------
// cursor 是不透明串（服务端 base64url），客户端只做透传，不解析、不拼装。
export const CursorQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 128 })),
  limit: Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
}, { additionalProperties: false });
export const Post = Type.Object({
  id: Id,
  author: User,
  content: Type.String(),
  attachments: Type.Array(Attachment),
  likeCount: Type.Integer({ minimum: 0 }),
  commentCount: Type.Integer({ minimum: 0 }),
  likedByMe: Type.Boolean(),
  mine: Type.Boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const PostComment = Type.Object({
  id: Id,
  postId: Id,
  author: User,
  content: Type.String(),
  replyToId: Type.Union([Id, Type.Null()]),
  // 冗余一份被回复者昵称：评论列表里要显示「回复 @某某」，让前端再拉一次用户是多余往返。
  replyToAuthorName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
});
export const PostPage = Type.Object({
  items: Type.Array(Post),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export const PostCommentPage = Type.Object({
  items: Type.Array(PostComment),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export const PostLikeResult = Type.Object({
  liked: Type.Boolean(),
  likeCount: Type.Integer({ minimum: 0 }),
});
export const PostIdParams = Type.Object({ postId: Id });
export const PostCommentParams = Type.Object({ postId: Id, commentId: Id });
export const CreatePostBody = Type.Object({
  content: Type.Optional(Type.String({ maxLength: 5000 })),
  attachmentIds: Type.Optional(AttachmentIds),
}, { additionalProperties: false });
export const CreateCommentBody = Type.Object({
  // 评论必须非空（码点 1..1000），用 minLength+pattern 拦住纯空白。
  content: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
  replyToId: Type.Optional(Type.Union([Id, Type.Null()])),
}, { additionalProperties: false });
export const Member = Type.Object({
  user: User,
  role: GroupRole,
  joinedAt: Timestamp,
  lastReadSeq: Sequence,
});
export const Conversation = Type.Object({
  id: Id,
  type: Type.Union([Type.Literal('single'), Type.Literal('group')]),
  name: Type.String(),
  title: Type.String(),
  avatarUrl: Type.String(),
  peer: Type.Optional(User),
  memberCount: Type.Integer(),
  myRole: GroupRole,
  ownerId: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  members: Type.Array(Member),
  unreadCount: Type.Integer(),
  lastSeq: Sequence,
  lastReadSeq: Sequence,
  lastMessage: Type.Union([Message, Type.Null()]),
});
export const FriendRequest = Type.Object({
  id: Id,
  sender: User,
  recipient: User,
  note: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('rejected')]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), traceId: Type.String() }),
});
export const ErrorResponses = Object.fromEntries(
  // 415 是本次新增的：上传接口需要区分「413 太大」与「415 类型不在白名单」，
  // 混用 400 会让前端无法给出准确提示。
  [400, 401, 403, 404, 409, 413, 415, 429, 500].map(status => [status, ErrorResponse]),
);
export const Success = Type.Object({ ok: Type.Literal(true) });
export const Upload = Type.Object({
  id: Id,
  name: Type.String(),
  mimeType: Type.String(),
  size: Type.Integer({ minimum: 1 }),
  // sha256 只在「上传成功」这一刻返回，用于客户端自校验与排障；
  // 它不进 Message.attachment —— 历史消息每次都回传哈希没有用处，还会放大载荷。
  sha256: Type.String(),
  kind: AttachmentKind,
  url: Type.String(),
  createdAt: Timestamp,
});
export const UploadParams = Type.Object({ id: Id });
// filename 只用于展示（落库的 name 字段），因此可省略：省略时由服务端填「未命名文件」。
// 真正的磁盘文件名恒为 <id><扩展名>，客户端传入的名字不参与任何路径拼接。
export const UploadQuery = Type.Object({ filename: Type.Optional(Type.String({ maxLength: 255 })) });
export const ConversationParams = Type.Object({ conversationId: Id });
// 置顶记录：id 是 pin 的 UUID，message 复用完整 Message（含 attachment），
// pinnedBy 用完整 User 而不是 userId —— 置顶条要直接显示「谁置顶的」，让前端再拉一次用户是多余往返。
export const PinnedMessage = Type.Object({
  id: Id,
  message: Message,
  pinnedBy: User,
  pinnedAt: Timestamp,
});
export const PinsResult = Type.Object({ items: Type.Array(PinnedMessage) });
export const PinBody = Type.Object({ msgId: Id }, { additionalProperties: false });
export const PinParams = Type.Object({ conversationId: Id, msgId: Id });
// 只有 owner 能改别人的角色，且只能设成 admin 或 member（owner 的转移本版不支持）。
export const MemberRoleBody = Type.Object({
  role: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
}, { additionalProperties: false });
export const MemberParams = Type.Object({ conversationId: Id, userId: Id });
// 管理后台：:uid 是数字 uid，不是 UUID。上限 9999 与 ADMIN_UID 的合法区间一致，
// 普通用户 uid 从 10001 起，所以 5 位数字也能被这个整数约束接受。
export const AdminUserParams = Type.Object({ uid: Type.Integer({ minimum: 1000, maximum: 99_999_999 }) });
export const AdminUsersQuery = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 30 }),
  offset: Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 }),
});
export const AdminUserPage = Type.Object({
  items: Type.Array(User),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
// minutes=0 表示解除禁言；上限 525600 = 365 天，避免管理员误填一个天文数字把账号永久封死。
export const MuteBody = Type.Object({
  minutes: Type.Integer({ minimum: 0, maximum: 525_600 }),
}, { additionalProperties: false });
export const AdminStats = Type.Object({
  users: Type.Integer(),
  conversations: Type.Integer(),
  messages: Type.Integer(),
  uploads: Type.Integer(),
  // online 是 realtime 里当前有活跃 WS 连接的用户数，不是「最近活跃」。
  online: Type.Integer(),
});
export const AuthResult = Type.Object({
  token: Type.String(), tokenType: Type.Literal('Bearer'), expiresAt: Timestamp, user: User,
});
export const SyncItem = Type.Object({
  conversationId: Id,
  messages: Type.Array(Message),
  lastSeq: Sequence,
  unreadCount: Type.Integer(),
  hasMore: Type.Boolean(),
  nextSeq: Sequence,
});
