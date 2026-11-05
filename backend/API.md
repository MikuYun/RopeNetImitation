# AITrance Chat 接口文档

接口版本 **0.3.0**；WebSocket 信封版本 **v:1**；WebSocket 业务协议版本 **protocolVersion 2**。本文与 `backend/openapi.json` 描述当前后端实现，已由双方 ACK 按 **contract-v1.0** 冻结；该名称不是 API 版本或 git tag。契约冻结不代表双浏览器端到端验收通过。

> **信封版本与业务协议版本是两个不同的数字，客户端不可混用。**
> 信封字段 `v` 恒为 `1`，本次升级**没有**改动信封结构；业务协议版本只出现在 `ready` 帧的 `data.protocolVersion`，当前为 `2`。客户端必须分别校验（前端对应常量为 `WS_ENVELOPE_VERSION=1`、`WS_PROTOCOL_VERSION=2`），不能因为 `protocolVersion` 升到 2 就把信封 `v` 也改成 2，也不能用 `protocolVersion` 去判断信封兼容性。

相对 0.2.0 的主要变化：消息附件从单个改为数组（`attachments`）、新增消息撤回与引用回复、新增访客资料与广场（帖子/评论/点赞）、上传支持视频；`protocolVersion` 由 1 升到 2，`/health` 的 `version` 升到 `0.3.0`。

## 1. 公共约定

- REST base：`http://127.0.0.1:3001/api/v1`（健康检查另有根路径 `/health`）；实时连接：`ws://127.0.0.1:3001/ws`。
- 有 JSON 请求体时使用 `Content-Type: application/json`；无请求体接口不要设置 `Content-Type`，详见第 3 节。上传接口相反：请求体是**裸二进制**，不是 multipart。除注册、登录、健康检查外，REST 均需 `Authorization: Bearer <token>`。
- ID（用户、会话、申请、消息、帖子、评论及 `clientMsgId`）均为 UUID 字符串。`seq` 是每会话从 1 开始的安全整数；未读游标从 0 开始。时间为 ISO 8601 UTC。
- 成功直接返回资源，不额外包 `data`；文档中标注 204 的接口返回**空正文**（注意 `DELETE /posts/:postId/like` 是例外，返回 200 + 最新点赞状态）。禁止请求体/查询中的未知字段（多传字段直接 400，例如旧客户端的 `{"type":"text"}` 会被拒绝）。
- 两套分页并存，不要混用：
  - **offset 分页**：会话、好友、好友申请、用户搜索、管理后台。返回 `{items,nextOffset}`，`nextOffset:null` 表示末页；`limit` 默认 30、最大 100，`offset` 默认 0。
  - **cursor 分页**：广场时间线、访客主页帖子、帖子评论。返回 `{items,nextCursor}`，`nextCursor:null` 表示末页；`limit` 默认 20、最大 50；`cursor` 是服务端生成的不透明字符串（长度 ≤128），客户端只能原样回传，**不要解析、拼接或改写**。
- 错误结构统一为 `{error:{code,message,traceId}}`，前端只按 `code` 分支，`message` 为展示文案（不可当作稳定契约）。
- 限流（超出返回 429，带 `Retry-After`）：普通请求每用户每分钟 200 次；注册/登录各 IP 每分钟 10 次；发消息每用户每分钟 60 次；发帖、发评论各每分钟 30 次；点赞/取消点赞每分钟 60 次；上传每分钟 30 次。
- 长度上限：消息正文 4000 字符；**带附件发消息时正文必须非空**；帖子正文 5000 字符（无附件时不可为空）；评论 1–1000 字符。字符按 Unicode 码点计。
- HTTP JSON body 上限 **64 KiB**；上传接口是二进制，传输层上限约 101 MiB，业务上限为图片/普通文件 **10 MiB**、视频 **100 MiB**（超限 413）。超限的 JSON 请求返回 413。
- 消息正文、昵称、帖子与评论正文原样作为文本数据返回，**前端必须文本渲染，不得作为 HTML 注入**。

## 2. 数据模型

### User

```json
{
  "id": "01875f7c-1150-4fef-a44f-08a9112d4a01",
  "uid": 10001,
  "username": "alice",
  "displayName": "小明",
  "avatarUrl": "",
  "bio": "你好",
  "role": "user",
  "status": "active",
  "mutedUntil": null,
  "createdAt": "2026-09-28T01:00:00.000Z",
  "online": false
}
```

`uid` 是展示用数字 ID（管理员固定 1001，普通用户从 10001 起）。`role` 为 `user|admin`，`status` 为 `active|banned`，`mutedUntil` 为 null 或 ISO UTC 时间。`avatarUrl` 为空串、`https://` 外链或站内图片地址 `/api/v1/uploads/<uploadId>`（仅限本人上传的图片）。`online` 表示当前有至少一条有效 WebSocket 连接，不是最后活跃时间。资料不含密码或 token 摘要。用户名为 3–32 位 ASCII 字母、数字、下划线，统一小写存储且不区分大小写登录；昵称 1–40 字符；简介最多 200 字符。

### AuthResult

`{token,tokenType:'Bearer',expiresAt,user:User}`。`token` 为不透明随机字符串，不是 JWT。有效期默认 7 天。只返回当前会话 token，注销不影响其他独立登录会话。

### Attachment

```json
{
  "id": "6d0f2c5e-8a4b-4a71-9a2f-33a2b0d7c001",
  "name": "photo.png",
  "mimeType": "image/png",
  "size": 10240,
  "kind": "image",
  "url": "/api/v1/uploads/6d0f2c5e-8a4b-4a71-9a2f-33a2b0d7c001",
  "createdAt": "2026-09-28T01:00:00.000Z"
}
```

`kind` 为 `image|video|file`，由服务端按文件魔数嗅探出的 MIME 决定，客户端不可指定。`url` 是站内相对路径，**读取时必须带 `Authorization` 头**（Cookie 不参与鉴权），因此浏览器 `<img src>` 无法直接渲染，需要用 `fetch` 带凭据取回 Blob 再转 object URL；可读权限见 5.2。

### Message

```json
{
  "msgId": "10c99dc1-a3de-4da2-82bc-acfbdc1d1102",
  "conversationId": "8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203",
  "senderId": "01875f7c-1150-4fef-a44f-08a9112d4a01",
  "clientMsgId": "aa3d02b1-0237-48e9-ad38-d7dd5fe57804",
  "seq": 1,
  "type": "mixed",
  "content": "周末拍的照片",
  "attachments": [],
  "recalled": false,
  "recalledAt": null,
  "replyTo": null,
  "createdAt": "2026-09-28T01:00:00.000Z"
}
```

- `attachments` **恒存在**，无附件为 `[]`（v0.3.0 起取代旧的单数字段 `attachment`，该字段已删除）。
- `type` 为 `text|system|image|video|file|mixed`，**由服务端推导**：无附件为 `text`；只有一个附件时取该附件 kind（`image`/`video`/`file`）；多种 kind 混排为 `mixed`。客户端传 `type` 会被 400 拒绝（请求体不接受该字段）。
- `recalled`/`recalledAt`：撤回后 `recalled=true`、`recalledAt` 为撤回时间，且 `content` 恒为 `''`、`attachments` 恒为 `[]`（`type` 保留原值，客户端应以 `recalled` 优先）。撤回前 `recalled=false`、`recalledAt=null`。
- `replyTo`：引用回复时为 `{msgId,senderId,senderName,preview}`，否则为 `null`。`preview` 规则：文本取前 60 码点；`[图片]`/`[视频]`/`[文件] <名称>`；混合按第一个附件；目标消息已撤回为 `[消息已撤回]`；发送者账号已注销时 `senderName` 为 `已注销用户`；目标消息不存在（如账号被删除而级联删除）时 `replyTo` 为 `null`。
- 建群、改名、成员加入/离开、角色变更由后端产生纯文本 `system` 消息，占用正常 seq；系统消息的 `senderId` 为操作者，`clientMsgId` 由服务端生成。
- 消息按 `(conversationId,seq)` 排序，按 `msgId` 去重，自己的乐观消息按 `clientMsgId` 对齐。置顶与历史接口返回的 Message 走同一形状，因此撤回后的脱敏自动生效。

### Conversation

列表与详情都返回完整对象：

| 字段 | 类型/说明 |
|---|---|
| `id` | 会话 UUID |
| `type` | `single` 或 `group` |
| `name` | 原始群名；私聊为 `''` |
| `title` | 当前请求者视角：私聊为对方昵称，群聊为群名 |
| `avatarUrl` | 群聊为群头像（可为 `''`）；私聊恒为 `''`，由前端生成默认头像 |
| `peer` | 私聊的对方 User，群聊不返回此字段 |
| `ownerId` | 群主 UUID；私聊为 null |
| `memberCount` | 当前成员数 |
| `myRole` | `owner`、`admin` 或 `member` |
| `members` | `[{user:User,role:'owner'|'admin'|'member',joinedAt,lastReadSeq}]`，按加入时间排序 |
| `lastMessage` | 最新 Message 或 null |
| `lastSeq` | 最新消息序号，无消息时 0 |
| `lastReadSeq` | 当前请求者的已读序号 |
| `unreadCount` | 当前请求者尚未读到且非自己发送的消息数（含其他操作者产生的 system） |
| `createdAt`,`updatedAt` | 创建及最近活动时间 |

`members[].lastReadSeq >= message.seq` 可用于计算该消息已读成员数（排除发送者）。列表服务端按 `updatedAt DESC,id DESC` 排序。列表 offset 分页时若并发有新活动，客户端应按 id 去重并刷新首屏；消息历史使用稳定 seq 游标，不受此限制。

### FriendRequest

`{id,sender:User,recipient:User,note,status,createdAt,updatedAt}`，`status` 为 `pending|accepted|rejected`。一次申请同时出现在双方列表，只有接收方能处理。跨方向重复 pending 申请返回 409；拒绝后可重新申请。

### Upload

`{id,name,mimeType,size,sha256,kind,url,createdAt}`：Attachment 再加 `sha256`（仅在上传成功那一刻返回，用于客户端自校验与排障，不进入消息/帖子的附件）。

### PinnedMessage

`{id,message:Message,pinnedBy:User,pinnedAt}`。置顶列表接口返回 `{items:PinnedMessage[]}`，按置顶时间倒序。

### Post

```json
{
  "id": "2f8c1e40-6b1d-4c2a-8f1e-0d9a7b3c5e11",
  "author": { "id": "01875f7c-1150-4fef-a44f-08a9112d4a01", "displayName": "小明" },
  "content": "周末去爬山了",
  "attachments": [],
  "likeCount": 0,
  "commentCount": 0,
  "likedByMe": false,
  "mine": true,
  "createdAt": "2026-09-28T01:00:00.000Z",
  "updatedAt": "2026-09-28T01:00:00.000Z"
}
```

`author` 为完整 User。`likedByMe`/`mine` 按当前请求者计算。`attachments` 恒存在，规则同消息（1–9 个，视频至多 1 个，**不允许通用文件**）。正文可为 `''`，但正文与附件不能同时为空。已软删的帖子不出现在任何读接口中。

### PostComment

`{id,postId,author:User,content,replyToId,replyToAuthorName,createdAt}`。`replyToId` 为被回复评论的 UUID 或 null；`replyToAuthorName` 为该评论作者昵称，非回复或目标已不存在时为 null。

### UserProfileView

`{user:User,relationship,conversationId,postCount,friendCount}`：

- `relationship`：`none`（无关系）、`friend`（好友）、`request_sent`（我发起的 pending 申请）、`request_received`（对方发起的 pending 申请）、`self`（查看自己）。
- `conversationId`：与之的私聊会话 UUID；不存在或查看自己时为 null（`self` 情况为 null）。
- `postCount`：其 `active` 帖子数；`friendCount`：其好友数。

### 分页对象

`PostPage = {items:Post[],nextCursor:string|null}`；`PostCommentPage = {items:PostComment[],nextCursor:string|null}`。

## 3. 账号与资料

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /health`、`GET /api/v1/health` | 无需认证；两条路径返回完全相同的模型 | 200 `{status:'ok',version:'0.3.0',protocolVersion:2,serverTime}` |
| `POST /auth/register` | `{username,password,displayName}` | 201 AuthResult |
| `POST /auth/login` | `{username,password}`，`username` 可填账号名或数字 uid | 200 AuthResult |
| `GET /auth/session` | 无请求体 | 200 AuthResult，校验会话 |
| `POST /auth/session/refresh` | 无请求体 | 200 AuthResult，同 token 延后 expiresAt |
| `POST /auth/logout` | 无请求体 | 200 `{ok:true}` |
| `GET /users/me` | 无 | 200 User |
| `PATCH /users/me` | 至少一个 `{displayName?,avatarUrl?,bio?}` | 200 User |
| `GET /users?q=关键词&limit=30&offset=0` | q 必填，1–40 字符 | 200 `{items:User[],nextOffset}` |
| `GET /users/:userId` | `:userId` 为 UUID，非 UUID 直接 400 | 200 UserProfileView |
| `GET /users/:userId/posts?cursor=&limit=20` | cursor 分页 | 200 PostPage |
| `POST /auth/ws-ticket` | 无请求体 | 200 `{ticket,expiresIn:30}` |

`/health` 是唯一无需认证的业务响应，返回的 `version`（`0.3.0`）与 `protocolVersion`（`2`）用于客户端判断后端协议代次。

密码 8–128 字符。登录失败不区分用户不存在与密码错误。refresh 只接受**仍有效**的 token，不轮换；建议客户端在过期前 60 秒续期。已过期/已注销返回 401，需要重新登录，不能通过 refresh 复活。注销同步关闭关联 WS，并废弃未使用票据。用户搜索对用户名/昵称模糊匹配，自动转义 `%`、`_`，不返回自己。

`PATCH /users/me` 的 `avatarUrl` 接受：空串（清除）、`https://` 外链、站内图片 `/api/v1/uploads/<uploadId>`（必须是本人上传的图片附件，否则 400 `INVALID_AVATAR_URL`）。可以引用已被消息或帖子使用过的图片——头像引用是独立的一层，不影响附件归属。

### 访客资料

`GET /users/:userId` 返回 `UserProfileView`，任何登录用户都可查看。`:userId` 必须是 UUID（`/users/me` 与 `/users` 是独立路由，不会被它吞掉）。`relationship` 用于前端决定按钮形态（加好友 / 待验证 / 通过验证 / 发消息）；`conversationId` 非空时可直接跳转该会话，为空时需先 `POST /conversations/direct`。目标用户不存在返回 404 `USER_NOT_FOUND`。

`GET /users/:userId/posts` 返回其 `active` 帖子时间线（倒序，cursor 分页），与广场共用同一分页语义。

### 管理后台

四个接口全部要求 `role='admin'`（非管理员 403 `ADMIN_REQUIRED`，未登录 401 `UNAUTHORIZED`）。`:uid` 是**数字 uid**（1000–99999999），不是 UUID。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /admin/users?query=&limit=30&offset=0` | `query` 可选，按 uid/账号名/昵称模糊匹配 | 200 `{items:User[],nextOffset}` |
| `POST /admin/users/:uid/mute` | `{minutes}`，0–525600，`0` 表示解除 | 200 User |
| `DELETE /admin/users/:uid` | 无 | 204 无正文 |
| `GET /admin/stats` | 无 | 200 `{users,conversations,messages,uploads,online}` |

`online` 是当前有活跃 WS 连接的**用户**数，不是连接数。不能禁言或删除管理员账号（409 `CANNOT_MUTE_ADMIN` / `CANNOT_DELETE_ADMIN`）。删除账号会级联清理其消息、会话关系、好友关系、置顶、其帖子与评论/点赞，并撤销全部会话与 WS 连接；群主被删时群主身份转移给最早加入的成员，无人则解散该群。

### 注册默认好友

部署可设置 `DEFAULT_FRIEND_USERNAME`（公网为 `QJQ`）。账号必须预先创建；新用户注册时，在同一事务内建立双向好友及 `accepted` 申请记录，无需人工通过，不自动发送消息。提交后向双方推送现有 `friend.resolved` 事件，好友列表与私聊接口沿用原协议。用户名仍统一小写存储，`QJQ` 与 `qjq` 均可登录。指定好友不存在时返回 503 / `DEFAULT_FRIEND_UNAVAILABLE`，不留下用户、会话或半条好友关系；已有指定账号重复注册仍返回 409，不会添加自己。留空配置关闭此规则。现有用户不自动回填。

### 初始账号引导

服务启动时在 `registerRoutes` 之前引导出两个固定账号，两者都是**只在账号不存在时创建一次，已存在则密码与昵称完全不动**（改环境变量不会重置线上密码）：

| 角色 | 登录名 | 昵称 | 初始密码 | uid | 配置项 |
|---|---|---|---|---|---|
| 系统管理员 | `root` | 系统管理员 | `12345678` | 1001 | `ADMIN_*` |
| 初始普通用户 | `qjq` | 柒玖柒 | `A454545asd@` | 10001 | `SEED_USER_*` |

`ensureAdmin` 按 uid 与 username 双查；`ensureSeedUser` **只按 username（`COLLATE NOCASE`）认人**，uid 被占时顺延到下一个空号 —— 因为「注册默认好友」是按 username 找人的，认 uid 会让账号建不出来再导致注册 503。`SEED_USER_USERNAME` 显式置空可整体关闭预置普通用户。两者都必须在路由注册前完成，否则新库首启会出现「一个用户都注册不了」的死锁（`DEFAULT_FRIEND_USERNAME` 找不到账号 → 503）。

当前版本**没有改密码接口**，这两个初始密码只能在**首次启动前**通过 `ADMIN_INITIAL_PASSWORD` / `SEED_USER_INITIAL_PASSWORD` 决定。`node scripts/reset-db.mjs --confirm` 会把库清空并重建这两个账号。

### 无请求体 POST 的调用注意事项

`POST /auth/ws-ticket`、`POST /auth/session/refresh`、`POST /auth/logout` 不需要请求体。推荐只发送 `Authorization`，**不要设置 `Content-Type`，也不要传 `body: ''`**。

当前保留 Fastify 默认解析规则：声明 `Content-Type: application/json`，但省略 body 或传零字节空字符串，都会返回 **400 BAD_REQUEST**（`Body cannot be empty when content-type is set to 'application/json'`）。这是 JSON 解析阶段失败，不是 token 失效；空字符串不是有效 JSON 文档。OpenAPI 不声明 requestBody，不表示解析器会忽略客户端主动声明的 JSON 内容类型。

```javascript
const response = await fetch('http://127.0.0.1:3001/api/v1/auth/ws-ticket', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
```

```powershell
curl.exe -X POST http://127.0.0.1:3001/api/v1/auth/ws-ticket -H "Authorization: Bearer <token>"
```

同样写法适用于 refresh 与 logout；不要为这三个调用添加 `-H "Content-Type: application/json"` 或 `-d ''`。判断以客户端**实际发出的请求头/请求体**为准：现有前端 Axios 无 data 时会移除 JSON 默认头，已验证可用，无需修改其全局默认头或拦截器。不要据此删除注册、登录、发消息等有 JSON 请求体接口的 `Content-Type`。

## 4. 好友与会话

以下路径都相对 `/api/v1`，不存在旧提案里的 `/friends/requests` 或统一 `POST /conversations`。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /friends` | `limit?,offset?` | 200 `{items:User[],nextOffset}` |
| `GET /friend-requests` | `status?,limit?,offset?`；不传 status 返回全部 | 200 `{items:FriendRequest[],nextOffset}` |
| `POST /friend-requests` | `{userId,note?}`，note 默认空/最多200字 | 201 FriendRequest |
| `POST /friend-requests/:requestId/respond` | `{action:'accept'|'reject'}` | 200 FriendRequest |
| `GET /conversations` | `limit?,offset?` | 200 `{items:Conversation[],nextOffset}` |
| `POST /conversations/direct` | `{userId}`，必须已是好友 | 200 Conversation，双方唯一、可重复调用 |
| `POST /conversations/group` | `{name,memberIds}` | 201 Conversation |
| `GET /conversations/:conversationId` | 无 | 200 Conversation |
| `PATCH /conversations/:conversationId` | `{name?,avatarUrl?}`，仅群主或管理员 | 200 Conversation |
| `POST /conversations/:conversationId/members` | `{memberIds}`，群主或管理员邀请自己的好友 | 200 Conversation |
| `DELETE /conversations/:conversationId/members/:userId` | 群主/管理员移除他人，或成员自己退出 | 200 `{ok:true}` |
| `POST /conversations/:conversationId/members/:userId/role` | `{role:'admin'|'member'}`，仅群主 | 200 Conversation |
| `GET /conversations/:conversationId/pins` | 无 | 200 `{items:PinnedMessage[]}` |
| `POST /conversations/:conversationId/pins` | `{msgId}` | 201 首次置顶 / 200 幂等重复 |
| `DELETE /conversations/:conversationId/pins/:msgId` | 无 | 204 无正文 |

通过好友申请不会自动创建私聊；点击聊天时调用 `POST /conversations/direct` 即可。双方好友关系事务内同时建立。群名 1–60 字符，建群需至少一位其他好友，`memberIds` 数组 1–99 项、不能重复，总成员最多 100 人；创建者自动入群并成为群主。重复邀请已有成员忽略。非成员无法访问详情/历史/发送/已读/typing/置顶，统一返回 404 以避免会话存在性泄露。群主不能退群或转让（409 `OWNER_CANNOT_LEAVE`），也不能修改自己的角色（400 `CANNOT_CHANGE_OWNER_ROLE`）。

新成员能查看全部群历史，入群前的消息作为已读起点，入群系统提示计入正常新消息；移除成员立即失去该群数据访问和后续事件订阅，但用户其他会话的 WS 连接继续工作。

排他性：`PATCH` 群信息、邀请成员仅群主或管理员可做（普通成员 403 `OWNER_REQUIRED`）；管理员只能移除普通成员。置顶任何成员都可操作，单会话上限 50 条（409 `PIN_LIMIT`），取消未置顶的消息返回 404 `PIN_NOT_FOUND`，引用不属于该会话的消息返回 400 `INVALID_MESSAGE`（刻意不用 404，避免借此探测消息存在性）。置顶条目的 `message` 与普通消息同形状，已被撤回的消息在置顶列表中同样脱敏。

## 5. 消息、附件、广场、已读与重连补偿

### 5.1 发消息

`POST /conversations/:conversationId/messages`

```json
{
  "clientMsgId": "aa3d02b1-0237-48e9-ad38-d7dd5fe57804",
  "content": "周末拍的照片",
  "attachmentIds": ["6d0f2c5e-8a4b-4a71-9a2f-33a2b0d7c001"],
  "replyToMsgId": null
}
```

| 字段 | 说明 |
|---|---|
| `clientMsgId` | 必填，UUID，幂等键 |
| `content` | 可选，最多 4000 字符；带附件时可为空（纯图片/纯文件消息），但不能是纯空白；无附件时必须非空白 |
| `attachmentIds` | 可选，1–9 个且不重复的 UUID；必须是自己上传且尚未被任何消息或帖子使用 |
| `replyToMsgId` | 可选，UUID 或 null；目标消息必须存在且属于同一会话 |

请求体不接受 `type` 与旧的 `attachmentId`（未知字段直接 400 `VALIDATION_ERROR`）。`type` 由服务端推导，规则见第 2 节 Message。

附件约束：合计 ≤9 个；`video` 至多 1 个；`image` 至多 9 个；`file` 不限（受合计约束）。超限 400 `ATTACHMENT_LIMIT`；附件不存在、不属于自己或数量对不上 400 `INVALID_ATTACHMENT`；附件已被其他消息或帖子引用 409 `UPLOAD_IN_USE`。

首次持久化返回 **201 Message**；同用户、同 `clientMsgId`、同会话、同正文、同附件集合（**顺序无关**）、同引用目标重试返回 **200 原 Message**，不再广播。任一不同（会话/正文/附件集合/引用目标）返回 **409 IDEMPOTENCY_CONFLICT**。必须重试原 id，不能每次网络重试都生成新 id。REST 返回与 WS `message.created` 可能先后交错，客户端两条路径均需去重。

被禁言或封禁时返回 403 `MUTED`（`message` 含解除时间）/ 403 `ACCOUNT_BANNED`。

### 5.2 附件上传与读取

上传与读取都相对 `/api/v1`：

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `POST /uploads?filename=photo.png` | 裸二进制请求体；`filename` 可选、≤255 字符 | 201 Upload |
| `GET /uploads/:id` | 无 | 200 原始字节（`Content-Type` 为嗅探结果） |
| `DELETE /uploads/:id` | 无 | 204 无正文 |

上传**不是** multipart/form-data：把文件字节直接作为请求体发送，`filename` 放在查询串（缺省名为 `未命名文件`，路径成分会被剥离）。服务端按魔数嗅探类型，白名单：`image/png`、`image/jpeg`、`image/webp`、`image/gif`、`application/pdf`、`application/zip`、`video/mp4`、`video/webm`，以及无 NUL 字节的严格 UTF-8 文本（`text/plain`）。其余返回 415 `UNSUPPORTED_MEDIA_TYPE`；空请求体 400 `VALIDATION_ERROR`。**大小上限按嗅探结果判定**：视频 100 MiB，其他 10 MiB，超限 413 `UPLOAD_TOO_LARGE`。

`GET /uploads/:id` 的可读权限是以下任一（否则 403 `FORBIDDEN`）：

1. 我是该附件属主；
2. 该附件被引用在我参与的某个会话的消息里；
3. 该附件被引用在**未删除**（`status='active'`）的广场帖子里（任何登录用户可读）；
4. 该附件被某个用户头像（`users.avatar_url`）或群头像（`conversations.avatar_url`）引用。

因此头像图片对全站登录用户可见，而私聊里未分享的图片只有会话成员能读。删除只允许属主，且未被任何消息或帖子引用（否则 409 `UPLOAD_IN_USE`）；撤回或删除消息后附件即释放，可再次使用。

### 5.3 撤回消息

`POST /conversations/:conversationId/messages/:msgId/recall`，无请求体，返回 **200 Message**。

规则：只能撤回**自己发送**的消息（否则 403 `FORBIDDEN`）；消息必须属于该会话（否则 404 `NOT_FOUND`）；发送时间超过 **120 秒**返回 403 `RECALL_WINDOW_EXPIRED`。撤回后 `recalled=true`、`recalledAt` 为撤回时间、`content` 恒为 `''`、`attachments` 恒为 `[]`，附件被释放（可在新消息里继续使用）。全员（含撤回者自己的其他连接）收到 `message.updated` 事件。对已撤回消息重复调用是幂等的，返回当前 Message 而不报错。置顶、历史、同步里返回的撤回消息同样已脱敏。

### 5.4 历史与增量

`GET /conversations/:conversationId/messages?limit=30&beforeSeq=100`

- 不传游标：最新一页；`beforeSeq`：严格小于此序号的较早消息。
- `afterSeq`：严格大于此序号的消息，用于补偿，允许 0。与 `beforeSeq` 互斥（同传 400 `INVALID_CURSOR`）。
- 无论方向，`items` 始终 seq 升序。
- 返回 `{items:Message[],hasMore,nextBeforeSeq,nextAfterSeq}`；有下一页时相应游标为当前页边界，否则 null。limit 最大 100。

### 5.5 已读

`POST /conversations/:conversationId/read`，请求 `{lastReadSeq:123}`，返回 **204，无正文**。

只前进不回退；0 合法。正数必须对应当前会话已有消息，不能提交未来游标（400 `INVALID_READ_CURSOR`）。小于已读值静默忽略。未读数按实际剩余消息计算，**读到历史位置并不一定清零**。所有成员以及操作者自己的所有连接收到 `conversation.read`，其中 `unreadCount` 是每个接收用户自己的未读数。

### 5.6 批量同步

`POST /sync`

```json
{"cursors":[{"conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","lastSeq":0}]}
```

```json
{"items":[{"conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","messages":[],"lastSeq":0,"unreadCount":0,"hasMore":false,"nextSeq":0}]}
```

单次最多 100 会话，每会话最多 100 条消息；重复会话游标（400 `DUPLICATE_CURSOR`）、任一无权会话返回 404（整批失败）。`lastSeq` 是服务端当前最高序号，`nextSeq` 是**本页实际最后返回序号**，无消息时等于输入游标。`hasMore:true` 时只推进到 `nextSeq`，禁止直接跳到 `lastSeq` 否则漏消息。

重连建议：先拿 ticket 建 WS 并缓存事件 → REST 刷新所有会话列表/成员 → 对当前仍有权限的会话按本地连续 seq 逐页 sync → 合并缓存事件并去重 → 正常展示。收到 404 先刷新会话列表移除已退群项后重试。发现 seq 缺口立即补偿；此系统不是持久化事件队列，断线期间好友、成员、presence 事件需通过 REST 当前状态校正。

### 5.7 广场（帖子、评论、点赞）

所有登录用户可读；路径相对 `/api/v1`，分页一律用 cursor（`{items,nextCursor}`）。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /posts?cursor=&limit=20` | cursor 分页，按 `createdAt DESC` | 200 PostPage |
| `POST /posts` | `{content?,attachmentIds?}` | 201 Post |
| `GET /posts/:postId` | 无 | 200 Post |
| `DELETE /posts/:postId` | 无 | 204 无正文（作者或管理员） |
| `POST /posts/:postId/like` | 无 | 200 `{liked:true,likeCount}` |
| `DELETE /posts/:postId/like` | 无 | 200 `{liked:false,likeCount}` |
| `GET /posts/:postId/comments?cursor=&limit=20` | cursor 分页，按 `createdAt ASC` | 200 PostCommentPage |
| `POST /posts/:postId/comments` | `{content,replyToId?}` | 201 PostComment |
| `DELETE /posts/:postId/comments/:commentId` | 无 | 204 无正文（作者或管理员） |

发帖规则：正文最多 5000 字符；**正文与附件不能同时为空**（`content` 全空白且无附件 → 400 `VALIDATION_ERROR`）。附件 1–9 个、视频至多 1 个，必须是自己上传且未被引用；**广场不支持通用文件附件**（含 `file` kind 时 400 `ATTACHMENT_LIMIT`）。点赞/取消点赞是幂等的，`likeCount` 由服务端按实际点赞行数重算后返回；已删除的帖子点赞返回 404。评论 1–1000 字符，`replyToId` 必须是同一帖子下未删除的评论（否则 400 `VALIDATION_ERROR`），`replyToAuthorName` 由服务端填充；`commentCount` 同样由服务端重算。帖子和评论都是**软删除**（`status='deleted'`）：删除后不再出现在任何列表/详情中，其附件仍登记在 `post_attachments` 里，因此**不可被复用**；同时因为帖子已不是 `active`，它不再满足 5.2 的第 3 类读取条件，只有属主本人仍能读。要彻底释放这些附件只能等作者账号被删除（届时帖子被物理删除）。作者可删自己的内容，管理员可删任何内容（非作者非管理员 403 `FORBIDDEN`）。

广场事件通过 WS 广播给**所有在线用户**（不只是好友），见第 6 节。

## 6. WebSocket 协议

### 建连

先以 Bearer token 调 `POST /auth/ws-ticket`，再连接 `/ws?ticket=<ticket>&v=1`。ticket 只可消费一次，30 秒过期；`v` 查询参数默认 1，**当前只接受 1**（其他值关闭码 4002）。**不得把长期 token 放到 URL 中**。票据 TTL 不控制已连接寿命，会话 token 仍会持续校验。每用户最多 5 条连接。

服务端所有事件信封（**信封版本恒为 `v:1`**）：

```json
{"v":1,"id":"事件UUID","type":"message.created","timestamp":"2026-09-28T01:00:00.000Z","data":{"message":{},"unreadCount":1}}
```

上述 `message:{}` 仅为位置示意，实际是完整 Message。

`ready` 帧携带业务协议版本，客户端必须校验：

```json
{"v":1,"id":"事件UUID","type":"ready","timestamp":"2026-09-28T01:00:00.000Z",
 "data":{"userId":"01875f7c-1150-4fef-a44f-08a9112d4a01","serverTime":"2026-09-28T01:00:00.000Z","protocolVersion":2}}
```

**再次强调**：信封 `v` 是 `1`，`data.protocolVersion` 是 `2`，两个数字含义不同。客户端应以 `protocolVersion !== 2` 判定后端协议不匹配（提示刷新前端），而不是去比对信封 `v`。

| 服务端 type | data |
|---|---|
| `ready` | `{userId,serverTime,protocolVersion:2}`；serverTime 为 ISO UTC，与信封 timestamp 相同 |
| `pong` | `{}` |
| `message.created` | `{message:Message,unreadCount}`，含发送者自己的所有连接；`unreadCount` 按接收者计算 |
| `message.updated` | `{message:Message}`，撤回等就地更新；消息已脱敏（`recalled:true`、`content:''`、`attachments:[]`） |
| `conversation.created` | `{conversation:Conversation}`，按接收者个性化 |
| `conversation.updated` | `{conversation:Conversation}`，按接收者个性化 |
| `conversation.removed` | `{conversationId}`，通知被移除/退出者 |
| `conversation.read` | `{conversationId,userId,lastReadSeq,unreadCount}`，userId 是读者；unreadCount 是接收者自己的值 |
| `conversation.pins` | `{conversationId,pins:PinnedMessage[]}`，置顶变更时发给会话全员 |
| `friend.requested` | `{request:FriendRequest}`，申请双方 |
| `friend.resolved` | `{request:FriendRequest}`，申请双方，按 status 区分接受/拒绝 |
| `presence.changed` | `{userId,online}`，发给好友和同群成员 |
| `typing.changed` | `{conversationId,userId,active}`，同会话其他用户 |
| `post.created` | `{postId,actorId}`，广播给所有在线用户 |
| `post.deleted` | `{postId,actorId}`，广播给所有在线用户 |
| `post.liked` | `{postId,actorId}`，广播给所有在线用户；只通知"有变化"，不区分点赞还是取消，也不带计数 |
| `post.commented` | `{postId,actorId}`，广播给所有在线用户 |
| `error` | `{code:'INVALID_EVENT',message}` |

广场事件刻意只带 `{postId,actorId}`：广场对所有人可见，服务端不按好友/成员裁剪；客户端收到后按需重新拉详情，避免超出 WS 单帧 4 KiB 上限与放大广播成本。

客户端只发送以下帧（无服务端信封 id/timestamp，但**必须带 `v:1`**）：

```json
{"v":1,"type":"ping"}
```

```json
{"v":1,"type":"typing","conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","active":true}
```

typing 客户端应节流（建议最多每 2 秒一次），前端 5 秒无更新自动移除输入提示。消息发送和已读使用 REST，不存在 WS 发消息 ack。客户端帧的 `v` 不是 1 会直接以关闭码 4002 断开。传输层每 30 秒 ping，连续下一轮无 pong 则终止；浏览器自动处理控制帧。客户端可另每 25 秒应用 ping。每连接最多 30 帧/10 秒，单帧最多 4 KiB，拒绝二进制帧；积压超过 1 MiB 主动断开慢消费者。

| 关闭码 | 含义与客户端策略 |
|---|---|
| `4001` | ticket 缺失/格式错误/失效/已用；申请新票据后重连，若 REST 401 则重新登录 |
| `4002` | 不支持的 `v`（信封协议版本）或客户端帧版本不符；提示更新/刷新前端，不盲目重连 |
| `4003` | session 过期/注销；停止自动重连，清理当前登录状态并重新登录，不对失效 token 调 refresh |
| `1008` | 超连接数或超帧频；退避重连，不能据此直接登出 |
| `1003` | 不支持二进制帧；修正客户端，使用 JSON 文本帧 |
| `1009` | 帧过大，检查客户端 |
| `1013` | 慢消费者，退避重连并 sync |
| `1006` | 非正常断连或心跳超时，指数退避并获取新票据 |

登录过期在发送/接收业务事件前及最多 30 秒一次心跳中检查。服务重启或断线**不重放 WS 事件**，消息可靠性通过 SQLite + REST sync 保证。presence 为单进程瞬时状态；首次从 User.online 初始化，刷新列表校准。

## 7. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | schema 校验失败：空白正文、非法 UUID、超长字段、未知字段、引用目标不存在等 |
| 400 | `BAD_REQUEST` | JSON 解析等请求格式错误 |
| 400 | `ATTACHMENT_LIMIT` | 附件数量/类型超限（>9 个、视频 >1 个、广场带 file） |
| 400 | `INVALID_ATTACHMENT` | 附件不存在、不属于自己或数量对不上 |
| 400 | `INVALID_AVATAR_URL` | 非有效头像地址（既非空、非 HTTPS、也非本人上传的图片） |
| 400 | `SELF_FRIEND_REQUEST`,`SELF_CONVERSATION` | 不允许自己加自己/私聊自己 |
| 400 | `INVALID_MEMBERS`,`GROUP_FULL`,`GROUP_REQUIRED` | 群成员不合法、超限、对私聊做群操作 |
| 400 | `INVALID_CURSOR`,`DUPLICATE_CURSOR`,`INVALID_READ_CURSOR` | 分页/同步/已读游标错误 |
| 400 | `INVALID_MESSAGE` | 置顶的消息不属于该会话 |
| 400 | `CANNOT_CHANGE_OWNER_ROLE` | 不能修改群主自己的角色 |
| 401 | `UNAUTHORIZED` | token 缺失、失效、注销或过期 |
| 401 | `INVALID_CREDENTIALS` | 用户名或密码错误 |
| 403 | `FRIEND_REQUIRED`,`OWNER_REQUIRED` | 要求好友/群主（或管理员）权限 |
| 403 | `FORBIDDEN` | 通用无权限：撤回他人消息、删除他人内容、读取无权附件等 |
| 403 | `RECALL_WINDOW_EXPIRED` | 超过 120 秒撤回时限 |
| 403 | `MUTED`,`ACCOUNT_BANNED` | 被禁言（message 含解除时间）/ 账号被封禁 |
| 403 | `ADMIN_REQUIRED` | 需要管理员权限 |
| 403 | `ORIGIN_FORBIDDEN` | 不在 CORS 白名单 |
| 403 | `HTTPS_REQUIRED` | 该接口必须通过 HTTPS 调用 |
| 404 | `USER_NOT_FOUND`,`CONVERSATION_NOT_FOUND`,`REQUEST_NOT_FOUND`,`MEMBER_NOT_FOUND`,`UPLOAD_NOT_FOUND` | 资源不可见或不存在；申请处理无权限也返回 404 |
| 404 | `NOT_FOUND` | 通用不存在：消息不存在、帖子/评论不存在、接口不存在 |
| 404 | `PIN_NOT_FOUND` | 该消息未被置顶 |
| 409 | `USERNAME_TAKEN`,`ALREADY_FRIENDS`,`REQUEST_PENDING`,`REQUEST_RESOLVED` | 重复账号/好友/申请状态冲突 |
| 409 | `OWNER_CANNOT_LEAVE`,`IDEMPOTENCY_CONFLICT` | 群主不能退出/重复消息 id 与内容冲突 |
| 409 | `UPLOAD_IN_USE` | 附件已被其他消息或帖子引用 |
| 409 | `PIN_LIMIT` | 单会话置顶超过 50 条 |
| 409 | `CANNOT_MUTE_ADMIN`,`CANNOT_DELETE_ADMIN` | 不能对管理员账号执行该操作 |
| 413 | `UPLOAD_TOO_LARGE` | 请求体或文件超过上限（JSON 64 KiB；图片/文件 10 MiB；视频 100 MiB） |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 上传文件类型不在白名单 |
| 429 | `RATE_LIMITED` | 超频，等待 `Retry-After` |
| 500 | `INTERNAL_ERROR` | 服务内部错误，不返回堆栈或数据库细节 |
| 503 | `DEFAULT_FRIEND_UNAVAILABLE` | 配置的默认好友账号不存在，注册暂时不可用 |

## 8. 最小浏览器对接

```javascript
const base = 'http://127.0.0.1:3001/api/v1';
const WS_ENVELOPE_VERSION = 1;   // 信封版本，恒为 1
const WS_PROTOCOL_VERSION = 2;   // 业务协议版本，来自 ready.data.protocolVersion

const loginResponse = await fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: 'your-password' }),
});
if (!loginResponse.ok) throw new Error('登录失败');
const auth = await loginResponse.json();

const ticketResponse = await fetch(`${base}/auth/ws-ticket`, {
  method: 'POST', headers: { Authorization: `Bearer ${auth.token}` },   // 无请求体，不要设 Content-Type
});
if (!ticketResponse.ok) throw new Error('票据申请失败');
const { ticket } = await ticketResponse.json();

const socket = new WebSocket(`ws://127.0.0.1:3001/ws?ticket=${encodeURIComponent(ticket)}&v=${WS_ENVELOPE_VERSION}`);
socket.onmessage = event => {
  const frame = JSON.parse(event.data);
  if (frame.v !== WS_ENVELOPE_VERSION) return;          // 信封不兼容：直接丢弃
  if (frame.type === 'ready') {
    if (frame.data.protocolVersion !== WS_PROTOCOL_VERSION) {
      console.warn('后端业务协议版本不匹配，请刷新页面'); // 不要用这个值去判断信封
    }
    return;
  }
  if (frame.type === 'message.created') console.log(frame.data.message, frame.data.unreadCount);
  if (frame.type === 'message.updated') console.log('消息被撤回/更新', frame.data.message);
};

// 发送消息：附件先 POST /uploads（裸二进制），再带 attachmentIds 发消息
const upload = await fetch(`${base}/uploads?filename=${encodeURIComponent(file.name)}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': file.type || 'application/octet-stream' },
  body: file,                                   // 直接是文件字节，不是 multipart
}).then(response => response.json());

await fetch(`${base}/conversations/${conversationId}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientMsgId: crypto.randomUUID(),
    content: '周末拍的照片',                     // 可省略：只有附件也是一条合法消息
    attachmentIds: [upload.id],
  }),
});
```

示例仅展示认证、接收与一次带附件的发送，完整前端还需错误处理、会话状态、乐观消息去重、续期、重连/补偿、撤回与广场事件处理及 token 安全存储。不要把 token 写入 URL、日志或共享通信文件；生产务必 HTTPS/WSS。附件读取接口需要 `Authorization` 头，`<img>` 标签无法携带时请改用带凭据的 `fetch` 取回 Blob 再渲染。
