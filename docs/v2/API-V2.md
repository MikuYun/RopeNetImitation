# AITrance v2 接口契约（agent 间约定，唯一事实来源）

本文件是 v2 改造期间前后端并行开发的**书面契约**。后端实现以 `backend/src/**` 为准，
但端点路径、字段名、语义在本轮开发中不得偏离本文件；如需变更，先改本文件。

版本：API `0.3.0`，`protocolVersion = 2`，`SCHEMA_VERSION = 5`。

## 0. 通用约定（沿用 v1）

- 前缀 `/api/v1`。
- 认证：`Authorization: Bearer <token>`。错误体恒为 `{error:{code,message,traceId}}`。
- 列表统一 `{items:[...], nextCursor: string|null}`；分页游标为不透明字符串。
- 请求体一律 `additionalProperties:false`（多传字段 → 400 `VALIDATION_ERROR`）。
- 时间 ISO8601 UTC。
- 错误码沿用：`VALIDATION_ERROR`/`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/
  `IDEMPOTENCY_CONFLICT`/`UPLOAD_IN_USE`/`UPLOAD_TOO_LARGE`/`UNSUPPORTED_MEDIA_TYPE`/
  `RATE_LIMITED`/`ACCOUNT_BANNED`/`MUTED`；v2 新增 `ATTACHMENT_LIMIT`
  （附件数量/组合超限）、`RECALL_WINDOW_EXPIRED`（超过撤回时限）。

## 1. 附件（Attachment）——v2 关键变更

```ts
type AttachmentKind = 'image' | 'video' | 'file'
interface Attachment {
  id: string        // uuid
  name: string
  mimeType: string
  size: number
  kind: AttachmentKind
  url: string       // '/api/v1/uploads/<id>'
  createdAt: string
}
```

- 新增 `video` 类型：`video/mp4`、`video/webm`（服务端按魔数认容器，MOV/MKV 等同类容器也归入这两档）。
- **v2.3 起取消类型白名单**：图片 / 音频 / 视频 / 文档 / 压缩包 / 字体 / 纯文本都收，认不出的二进制落成 `application/octet-stream` 通用文件照常收发；只有可执行文件（PE/ELF/Mach-O/class）返回 415 并提示压缩成 zip。
- 单文件上限：图片/普通文件 **50 MiB**（v2.3 从 10 MiB 上调），视频 100 MiB。
- `GET /api/v1/uploads/:id` 的读取权限（v2 放宽）：
  1) 上传者本人；2) 该附件被引用在「我参与的会话」的消息里；
  3) 该附件被引用在任意广场帖子里（登录用户皆可看）；
  4) 该附件被任意 `users.avatar_url` / `conversations.avatar_url` 引用（头像公开可读）。
- `POST /api/v1/uploads?filename=xxx`：裸二进制 body，响应 201 `Upload`
  （`Upload = Attachment & {sha256}`）。

## 2. 消息（Message）——单附件改多附件

```ts
interface Message {
  msgId: string
  conversationId: string
  senderId: string
  clientMsgId: string
  seq: number                  // >=1
  type: 'text' | 'system' | 'image' | 'video' | 'file' | 'mixed'
  content: string              // 可为空串（有附件时）
  attachments: Attachment[]    // 恒存在；无附件为 []
  recalled: boolean            // v2 新增
  recalledAt: string | null
  replyTo: ReplyRef | null     // v2 新增
  createdAt: string
}
interface ReplyRef { msgId: string; senderId: string; senderName: string; preview: string }
```

- **删除** `attachment`（单数）字段，改为 `attachments` 数组；前端所有读取点同步改。
- `type` 规则（服务端推导，客户端传值被忽略）：
  - 无附件 → `text`（`system` 仅服务端产生）
  - 只有图片 → `image`；只有视频 → `video`；只有普通文件 → `file`；混合 → `mixed`
- 发送：`POST /api/v1/conversations/:id/messages`
  ```json
  { "clientMsgId": "uuid", "content": "可选文本", "attachmentIds": ["uuid", "..."], "replyToMsgId": "uuid|null" }
  ```
  - `attachmentIds`：1..9，unique；其中 `video` 最多 1 个，`image` 最多 9 个，合计 ≤9。
  - `content` 与附件**互不依赖**：可以只发图片/文件（`content` 省略或为空），
    也可以图文同条，但不能两者都没有（否则 400 `VALIDATION_ERROR`「消息内容不能为空」）。
  - 有 `content` 时 trim 后 ≤4000 字；纯空白视同没写正文。
  - 已被别的消息引用的附件 → 409 `UPLOAD_IN_USE`。
- 撤回：`POST /api/v1/conversations/:id/messages/:msgId/recall` → 200 `Message`
  - 仅作者本人，且 `createdAt` 距现在 ≤ 120 秒，否则 403 `RECALL_WINDOW_EXPIRED`。
  - 撤回后：`recalled=true`、`content=''`、`attachments=[]`；WS 广播 `message.updated`。
  - 置顶记录中被撤回的消息在返回时同样按上述规则脱敏。

## 3. 用户与访客资料

- `GET /api/v1/users/:userId`（v2 新增；`:userId` 为 UUID）→
  ```json
  { "user": User, "relationship": "none|friend|request_sent|request_received|self",
    "conversationId": "uuid|null", "postCount": 0, "friendCount": 0 }
  ```
  任意登录用户可查；`User` 中 `avatarUrl` 对以上四类读取路径公开可读。
- `PATCH /api/v1/users/me`：沿用 `{displayName?, avatarUrl?, bio?}`。
- `GET /api/v1/users/:userId/posts?cursor=&limit=` → `{items: Post[], nextCursor}`
  （访客资料页展示 TA 的广场动态）。

## 4. 广场（Square）

```ts
interface Post {
  id: string
  author: User          // 完整 User（含 uid/avatarUrl/role）
  content: string       // 0..5000 字
  attachments: Attachment[]   // ≤9 且 video ≤1
  likeCount: number
  commentCount: number
  likedByMe: boolean
  mine: boolean
  createdAt: string
  updatedAt: string
}
interface PostComment {
  id: string
  postId: string
  author: User
  content: string       // 1..1000
  replyToId: string | null
  replyToAuthorName: string | null
  createdAt: string
}
```

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/posts?cursor=&limit=20` | – | `{items: Post[], nextCursor}` 按 `created_at DESC` |
| POST | `/posts` | `{content?, attachmentIds?}` | 201 `Post` |
| GET | `/posts/:postId` | – | `Post` |
| DELETE | `/posts/:postId` | – | 204（作者或管理员） |
| POST | `/posts/:postId/like` | – | 200 `{liked:true, likeCount}` |
| DELETE | `/posts/:postId/like` | – | 200 `{liked:false, likeCount}` |
| GET | `/posts/:postId/comments?cursor=&limit=20` | – | `{items: PostComment[], nextCursor}` 按 `created_at ASC` |
| POST | `/posts/:postId/comments` | `{content, replyToId?}` | 201 `PostComment` |
| DELETE | `/posts/:postId/comments/:commentId` | – | 204（作者或管理员） |

业务规则：
- 发帖条件：`content.trim()` 非空 **或** 至少一个附件；两者都空 → 400。
- 文字上限 5000 字（`Array.from(content).length`）；评论 1000 字。
- 附件：图片 ≤9、视频 ≤1、合计 ≤9；`file` 不允许进广场 → 400 `ATTACHMENT_LIMIT`。
- 附件必须属于发帖人且未被别处引用（广场帖子内引用视为已使用，一附件只能出现在一处）。
- 删帖/删评论为软删除（`status='deleted'`），列表不再返回，计数同步递减。
- WS 新事件（广播给所有在线用户，可延后实现但协议先留位）：
  `post.created` / `post.deleted` / `post.liked` / `post.commented`，载荷 `{postId, actorId}`。

## 5. 实时事件（WS）沿用与新增

- 客户端→服务端：`ping`、`typing`（不变）。
- 服务端→客户端：`ready`、`pong`、`presence.changed`、`typing.changed`、
  `message.created`、`message.updated`（撤回/编辑）、`conversation.updated`、
  `conversation.removed`、`post.*`（v2 新增，可先只发给自己）。
- `ready` 帧的 `protocolVersion` 升为 `2`。

## 5.5 个人表情包（v2.4）

```ts
interface Sticker {
  id: string          // 表情记录 id（删除时用）
  uploadId: string    // 真正取图/发送时用
  name: string
  mimeType: string    // image/png | image/jpeg | image/webp | image/gif
  size: number
  kind: 'image'
  url: string         // '/api/v1/uploads/<uploadId>'
  createdAt: string
}
```

| 方法 | 路径 | 请求体 | 成功 |
|---|---|---|---|
| GET | `/stickers?limit&offset` | – | 200 `{items: Sticker[], nextOffset}` |
| POST | `/stickers` | `{uploadId}` | **201** 新建 / **200** 已收藏（幂等，同一对象） |
| DELETE | `/stickers/:stickerId` | – | 200 `{ok:true}` |

业务规则：
- 两个 id 不可混：`id` 删除时用，`uploadId` 发送/取图时用；传错删除只得 404 `STICKER_NOT_FOUND`。
- 登记校验：`uploadId` 必须存在、属于本人、`kind === 'image'`、嗅探类型限 png/jpeg/webp/gif，
  否则 400 `INVALID_STICKER`（不区分「不存在」与「不属于你」，避免成为 UUID 探测面）。
- **表情包可反复发送**：普通附件被消息引用后再复用会 409 `UPLOAD_IN_USE`，而本人收藏的表情包
  不受此限 —— 该 `uploadId` 放进 `attachmentIds` 可任意次发送。
- `DELETE /uploads/:id` 若被表情包引用 → 409 `UPLOAD_IN_USE`。删除表情包时，若该图已无任何
  消息/帖子/其它表情包引用，连带删除上传物与磁盘文件；仍有消息引用则只删表情条目（否则历史消息破图）。
- 孤儿上传清理（`realtime.ts` sweep）把「被表情包引用」也算作在用。
- **体积上限（v2.5）**：单张表情 `upload.size ≤ 2 MiB`（`MAX_STICKER_BYTES`），超出 413
  `STICKER_TOO_LARGE`。这一条单独走 413 而不是并入 400 `INVALID_STICKER`，因为它对用户是可自行
  解决的（裁剪/压缩后重传），前端要据此给出可操作提示。客户端收藏前会把静图压到 512px WebP，
  但客户端可被绕过，所以服务端必须自己再挡一次 —— 表情被收藏后永远躲过 sweep，无上限就是永久磁盘占用。
- **读取授权维持三档（v2.5 复核）**：`GET /uploads/:id` 的放行条件仍是「属主 / 消息引用 + 会话成员 /
  未删除的广场帖 / 头像」这四类，**没有**为表情包单独加一档。原因：`POST /stickers` 强制
  `upload.owner_id === 请求者`，收藏时压缩产生的新图也是本人上传的，所以表情的 `uploadId`
  必然命中「属主」这一档；再加「本人表情引用」是永远命不中的死代码。收藏别人消息里的图时，
  前端会先复制一份字节成自己的上传（见 §5.5 上一条的体积上限说明），同样落在属主档。

## 6. 数据库（SCHEMA_VERSION = 5）

v2.4（`SCHEMA_VERSION` 4 → 5）纯新增，无数据搬迁：
- `stickers(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, UNIQUE(owner_id, upload_id))`
- `idx stickers_owner(owner_id, created_at)`、`idx stickers_upload(upload_id)`。

v2 新增/变更表（`backend/src/db.ts`）：
- `messages`：删 `attachment_id`；加 `recalled_at TEXT`、`reply_to_msg_id TEXT`；
  `type` CHECK 增 `video`/`mixed`。
- `message_attachments(msg_id TEXT, attachment_id TEXT, position INTEGER,
  PRIMARY KEY(msg_id, attachment_id))`。
- `uploads.kind` CHECK 增 `video`（重建表）。
- `posts(id, author_id, content, status active|deleted, created_at, updated_at,
  like_count, comment_count)` + `idx posts_feed(created_at DESC)` + `idx posts_author(author_id, created_at DESC)`。
- `post_attachments(post_id, attachment_id, position, PRIMARY KEY(post_id, attachment_id))`。
- `post_likes(post_id, user_id, created_at, PRIMARY KEY(post_id, user_id))`。
- `post_comments(id, post_id, author_id, content, reply_to_id, status, created_at)` +
  `idx post_comments(post_id, created_at)`。
- 迁移必须保留既有数据（旧 `messages.attachment_id` 搬进 `message_attachments` position=0）。

## 7. 管理员初始化（需求 5）

- 环境变量：`ADMIN_USERNAME`（默认 `root`）、`ADMIN_INITIAL_PASSWORD`（默认 `12345678`）、
  `ADMIN_UID`（默认 `1001`）。
- `ensureAdmin` 创建的用户：`username=root`、`display_name=系统管理员`、`role=admin`。
- 提供 `backend/scripts/reset-db.mjs`（node，`--confirm` 才执行）：清空全部业务数据并
  只重建 root 管理员；同时清空 `uploads/` 目录里的孤儿文件。
