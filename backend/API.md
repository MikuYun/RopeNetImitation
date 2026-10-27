# AITrance Chat 接口文档

接口版本 **0.2.0**；WebSocket 信封版本 **v:1**。本文与 `openapi.json` 描述当前后端实现，已由双方 ACK 按 **contract-v1.0** 冻结；该名称不是 API 版本或 git tag。契约冻结不代表双浏览器端到端验收通过。

## 1. 公共约定

- REST base：`http://127.0.0.1:3001/api/v1`；实时连接：`ws://127.0.0.1:3001/ws`。
- 有 JSON 请求体时使用 `Content-Type: application/json`；无请求体接口不要设置 `Content-Type`，详见第 3 节。除注册、登录、健康检查外，REST 均需 `Authorization: Bearer <token>`。
- ID（用户、会话、申请、消息及 `clientMsgId`）均为 UUID 字符串。`seq` 是每会话从 1 开始的安全整数；未读游标从 0 开始。时间为 ISO 8601 UTC。
- 成功直接返回资源，不额外包 `data`；列表返回 `{items,nextOffset}`。`nextOffset:null` 表示末页。`limit` 默认 30、最大 100，`offset` 默认 0。
- 禁止请求体/查询中的未知字段。错误结构统一为 `{error:{code,message,traceId}}`，前端只按 `code` 分支，`message` 为展示文案。
- 普通请求每用户每分钟 200 次；注册/登录各 IP 每分钟 10 次；发消息每用户每分钟 60 次。HTTP 429 提供 `Retry-After`。消息正文最多 4000 字符，不接受纯空白；HTTP body 上限 32 KiB。
- 消息正文及昵称原样作为文本数据返回，**前端必须文本渲染，不得作为 HTML 注入**。

## 2. 数据模型

### User

```json
{
  "id": "01875f7c-1150-4fef-a44f-08a9112d4a01",
  "username": "alice",
  "displayName": "小明",
  "avatarUrl": "",
  "bio": "你好",
  "createdAt": "2026-09-28T01:00:00.000Z",
  "online": false
}
```

`avatarUrl` 为空或 HTTPS URL。`online` 表示当前有至少一条有效 WebSocket 连接，不是最后活跃时间。资料不含密码或 token 摘要。用户名为 3–32 位 ASCII 字母、数字、下划线，统一小写存储且不区分大小写登录；昵称 1–40 字符；简介最多 200 字符。

### AuthResult

`{token,tokenType:'Bearer',expiresAt,user:User}`。`token` 为不透明随机字符串，不是 JWT。有效期默认 7 天。只返回当前会话 token，注销不影响其他独立登录会话。

### Message

```json
{
  "msgId": "10c99dc1-a3de-4da2-82bc-acfbdc1d1102",
  "conversationId": "8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203",
  "senderId": "01875f7c-1150-4fef-a44f-08a9112d4a01",
  "clientMsgId": "aa3d02b1-0237-48e9-ad38-d7dd5fe57804",
  "seq": 1,
  "type": "text",
  "content": "你好！",
  "createdAt": "2026-09-28T01:00:00.000Z"
}
```

`type` 为 `text|system`。客户端只能发送 `text`；建群、改名、成员加入/离开由后端产生纯文本 `system` 消息，占用正常 seq。系统消息的 `senderId` 为操作者，`clientMsgId` 由服务端生成。消息按 `(conversationId,seq)` 排序，按 `msgId` 去重，自己的乐观消息按 `clientMsgId` 对齐。

### Conversation

列表与详情都返回完整对象：

| 字段 | 类型/说明 |
|---|---|
| `id` | 会话 UUID |
| `type` | `single` 或 `group` |
| `name` | 原始群名，私聊为空 |
| `title` | 当前请求者视角：私聊为对方昵称，群聊为群名 |
| `avatarUrl` | 私聊为对方头像，群聊为空，由前端生成默认头像 |
| `peer` | 私聊的对方 User，群聊不返回此字段 |
| `ownerId` | 群主 UUID；私聊为 null |
| `memberCount` | 当前成员数 |
| `myRole` | `owner` 或 `member`，暂不提供 admin |
| `members` | `[{user:User,role:'owner'|'member',joinedAt,lastReadSeq}]` |
| `lastMessage` | 最新 Message 或 null |
| `lastSeq` | 最新消息序号，无消息时 0 |
| `lastReadSeq` | 当前请求者的已读序号 |
| `unreadCount` | 当前请求者尚未读到且非自己发送的消息数（含其他操作者产生的 system） |
| `createdAt`,`updatedAt` | 创建及最近活动时间 |

`members[].lastReadSeq >= message.seq` 可用于计算该消息已读成员数（排除发送者）。列表服务端按 `updatedAt DESC,id DESC` 排序。列表 offset 分页时若并发有新活动，客户端应按 id 去重并刷新首屏；消息历史使用稳定 seq 游标，不受此限制。

### FriendRequest

`{id,sender:User,recipient:User,note,status,createdAt,updatedAt}`，`status` 为 `pending|accepted|rejected`。一次申请同时出现在双方列表，只有接收方能处理。跨方向重复 pending 申请返回 409；拒绝后可重新申请。

## 3. 账号与资料

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /health` | 无需认证，与根路径 `/health` 模型相同 | 200 `{status:'ok',version:'0.2.0',protocolVersion:1,serverTime}` |
| `POST /auth/register` | `{username,password,displayName}` | 201 AuthResult |
| `POST /auth/login` | `{username,password}` | 200 AuthResult |
| `GET /auth/session` | 无请求体 | 200 AuthResult，校验会话 |
| `POST /auth/session/refresh` | 无请求体 | 200 AuthResult，同 token 延后 expiresAt |
| `POST /auth/logout` | 无请求体 | 200 `{ok:true}` |
| `GET /users/me` | 无 | 200 User |
| `PATCH /users/me` | 至少一个 `{displayName?,avatarUrl?,bio?}` | 200 User |
| `GET /users?q=关键词&limit=30&offset=0` | q 必填，1–40 字符 | 200 `{items:User[],nextOffset}` |
| `POST /auth/ws-ticket` | 无请求体 | 200 `{ticket,expiresIn:30}` |

密码 8–128 字符。登录失败不区分用户不存在与密码错误。refresh 只接受**仍有效**的 token，不轮换；建议客户端在过期前 60 秒续期。已过期/已注销返回 401，需要重新登录，不能通过 refresh 复活。注销同步关闭关联 WS，并废弃未使用票据。用户搜索对用户名/昵称模糊匹配，自动转义 `%`、`_`，不返回自己。

### 注册默认好友

部署可设置 `DEFAULT_FRIEND_USERNAME`（公网为 `QJQ`）。账号必须预先创建；新用户注册时，在同一事务内建立双向好友及 `accepted` 申请记录，无需人工通过，不自动发送消息。提交后向双方推送现有 `friend.resolved` 事件，好友列表与私聊接口沿用原协议。用户名仍统一小写存储，`QJQ` 与 `qjq` 均可登录。指定好友不存在时返回 503 / `DEFAULT_FRIEND_UNAVAILABLE`，不留下用户、会话或半条好友关系；已有指定账号重复注册仍返回 409，不会添加自己。留空配置关闭此规则。现有用户不自动回填。

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
| `PATCH /conversations/:conversationId` | `{name}`，仅群主 | 200 Conversation |
| `POST /conversations/:conversationId/members` | `{memberIds}`，仅群主邀请自己的好友 | 200 Conversation |
| `DELETE /conversations/:conversationId/members/:userId` | 群主移除他人或普通成员退出 | 200 `{ok:true}` |

通过好友申请不会自动创建私聊；点击聊天时调用 `POST /conversations/direct` 即可。双方好友关系事务内同时建立。群名 1–60 字符，建群需至少一位其他好友，`memberIds` 数组 1–99 项、不能重复，总成员最多 100 人；创建者自动入群。重复邀请已有成员忽略。非成员无法访问详情/历史/发送/已读/typing，统一返回 404 以避免会话存在性泄露。群主不能退群或转让。

新成员能查看全部群历史，入群前的消息作为已读起点，入群系统提示计入正常新消息；移除成员立即失去该群数据访问和后续事件订阅，但用户其他会话的 WS 连接继续工作。

## 5. 消息、已读与重连补偿

### 发消息

`POST /conversations/:conversationId/messages`

```json
{"clientMsgId":"aa3d02b1-0237-48e9-ad38-d7dd5fe57804","type":"text","content":"你好！"}
```

首次持久化返回 **201 Message**；同用户、同 `clientMsgId`、同会话和内容重试返回 **200 原 Message**，不再广播。重用同 id 改变会话/正文返回 **409 IDEMPOTENCY_CONFLICT**。必须重试原 id，不能每次网络重试都生成新 id。REST 返回与 WS `message.created` 可能先后交错，客户端两条路径均需去重。

### 历史与增量

`GET /conversations/:conversationId/messages?limit=30&beforeSeq=100`

- 不传游标：最新一页；`beforeSeq`：严格小于此序号的较早消息。
- `afterSeq`：严格大于此序号的消息，用于补偿，允许 0。与 `beforeSeq` 互斥。
- 无论方向，`items` 始终 seq 升序。
- 返回 `{items:Message[],hasMore,nextBeforeSeq,nextAfterSeq}`；有下一页时相应游标为当前页边界，否则 null。limit 最大 100。

### 已读

`POST /conversations/:conversationId/read`，请求 `{lastReadSeq:123}`，返回 **204，无正文**。

只前进不回退；0 合法。正数必须对应当前会话已有消息，不能提交未来游标。小于已读值静默忽略。未读数按实际剩余消息计算，**读到历史位置并不一定清零**。所有成员以及操作者自己的所有连接收到 `conversation.read`，其中 `unreadCount` 是每个接收用户自己的未读数。

### 批量同步

`POST /sync`

```json
{"cursors":[{"conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","lastSeq":0}]}
```

```json
{"items":[{"conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","messages":[],"lastSeq":0,"unreadCount":0,"hasMore":false,"nextSeq":0}]}
```

单次最多 100 会话，每会话最多 100 条消息；重复会话游标、未来 seq 返回 400，任一无权会话返回 404（整批失败）。`lastSeq` 是服务端当前最高序号，`nextSeq` 是**本页实际最后返回序号**，无消息时等于输入游标。`hasMore:true` 时只推进到 `nextSeq`，禁止直接跳到 `lastSeq` 否则漏消息。

重连建议：先拿 ticket 建 WS 并缓存事件 → REST 刷新所有会话列表/成员 → 对当前仍有权限的会话按本地连续 seq 逐页 sync → 合并缓存事件并去重 → 正常展示。收到 404 先刷新会话列表移除已退群项后重试。发现 seq 缺口立即补偿；此系统不是持久化事件队列，断线期间好友、成员、presence 事件需通过 REST 当前状态校正。

## 6. WebSocket 协议

### 建连

先以 Bearer token 调 `POST /auth/ws-ticket`，再连接 `/ws?ticket=<ticket>&v=1`。ticket 只可消费一次，30 秒过期；`v` 查询参数默认 1。**不得把长期 token 放到 URL 中**。票据 TTL 不控制已连接寿命，会话 token 仍会持续校验。每用户最多 5 条连接。

服务端所有事件信封：

```json
{"v":1,"id":"事件UUID","type":"message.created","timestamp":"2026-09-28T01:00:00.000Z","data":{"message":{},"unreadCount":1}}
```

上述 `message:{}` 仅为位置示意，实际是完整 Message。

| 服务端 type | data |
|---|---|
| `ready` | `{userId,serverTime,protocolVersion:1}`；serverTime 为 ISO UTC，与信封 timestamp 相同 |
| `pong` | `{}` |
| `message.created` | `{message:Message,unreadCount}`，含发送者自己的所有连接 |
| `conversation.created` | `{conversation:Conversation}`，按接收者个性化 |
| `conversation.updated` | `{conversation:Conversation}`，按接收者个性化 |
| `conversation.removed` | `{conversationId}`，通知被移除/退出者 |
| `conversation.read` | `{conversationId,userId,lastReadSeq,unreadCount}`，userId 是读者；unreadCount 是接收者自己的值 |
| `friend.requested` | `{request:FriendRequest}`，申请双方 |
| `friend.resolved` | `{request:FriendRequest}`，申请双方，按 status 区分接受/拒绝 |
| `presence.changed` | `{userId,online}`，发给好友和同群成员 |
| `typing.changed` | `{conversationId,userId,active}`，同会话其他用户 |
| `error` | `{code:'INVALID_EVENT',message}` |

客户端只发送以下帧（无服务端信封 id/timestamp）：

```json
{"v":1,"type":"ping"}
```

```json
{"v":1,"type":"typing","conversationId":"8b1a9b8c-ec72-4f12-b1b2-c8c31cc50203","active":true}
```

typing 客户端应节流（建议最多每 2 秒一次），前端 5 秒无更新自动移除输入提示。消息发送和已读使用 REST，不存在 WS 发消息 ack。传输层每 30 秒 ping，连续下一轮无 pong 则终止；浏览器自动处理控制帧。客户端可另每 25 秒应用 ping。每连接最多 30 帧/10 秒，单帧最多 4 KiB，拒绝二进制帧；积压超过 1 MiB 主动断开慢消费者。

| 关闭码 | 含义与客户端策略 |
|---|---|
| `4001` | ticket 缺失/格式错误/失效/已用；申请新票据后重连，若 REST 401 则重新登录 |
| `4002` | 不支持的 v；提示更新/刷新前端，不盲目重连 |
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
| 400 | `VALIDATION_ERROR` | schema 校验失败，如空白正文、非法 UUID、超长字段、未知字段 |
| 400 | `BAD_REQUEST` | JSON 解析等请求格式错误 |
| 400 | `INVALID_AVATAR_URL` | 非有效 HTTPS 头像地址 |
| 400 | `SELF_FRIEND_REQUEST`,`SELF_CONVERSATION` | 不允许自己加自己/私聊自己 |
| 400 | `INVALID_MEMBERS`,`GROUP_FULL`,`GROUP_REQUIRED` | 群成员不合法、超限、对私聊做群操作 |
| 400 | `INVALID_CURSOR`,`DUPLICATE_CURSOR`,`INVALID_READ_CURSOR` | 分页/同步/已读游标错误 |
| 401 | `UNAUTHORIZED` | token 缺失、失效、注销或过期 |
| 401 | `INVALID_CREDENTIALS` | 用户名或密码错误 |
| 403 | `FRIEND_REQUIRED`,`OWNER_REQUIRED` | 要求好友/群主权限 |
| 403 | `ORIGIN_FORBIDDEN` | 不在 CORS 白名单 |
| 404 | `USER_NOT_FOUND`,`CONVERSATION_NOT_FOUND`,`REQUEST_NOT_FOUND`,`MEMBER_NOT_FOUND`,`NOT_FOUND` | 资源不可见或不存在；申请处理无权限也返回404 |
| 409 | `USERNAME_TAKEN`,`ALREADY_FRIENDS`,`REQUEST_PENDING`,`REQUEST_RESOLVED` | 重复账号/好友/申请状态冲突 |
| 409 | `OWNER_CANNOT_LEAVE`,`IDEMPOTENCY_CONFLICT` | 群主不能退出/重复消息 id 与内容冲突 |
| 413 | `BAD_REQUEST` | HTTP body 超过 32 KiB |
| 429 | `RATE_LIMITED` | 超频，等待 Retry-After |
| 500 | `INTERNAL_ERROR` | 服务内部错误，不返回堆栈或数据库细节 |

## 8. 最小浏览器对接

```javascript
const base = 'http://127.0.0.1:3001/api/v1';
const loginResponse = await fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: 'your-password' }),
});
if (!loginResponse.ok) throw new Error('登录失败');
const auth = await loginResponse.json();
const ticketResponse = await fetch(`${base}/auth/ws-ticket`, {
  method: 'POST', headers: { Authorization: `Bearer ${auth.token}` },
});
if (!ticketResponse.ok) throw new Error('票据申请失败');
const { ticket } = await ticketResponse.json();
const socket = new WebSocket(`ws://127.0.0.1:3001/ws?ticket=${encodeURIComponent(ticket)}&v=1`);
socket.onmessage = event => {
  const frame = JSON.parse(event.data);
  if (frame.v !== 1) return;
  if (frame.type === 'message.created') console.log(frame.data.message, frame.data.unreadCount);
};
```

示例仅展示认证与接收，完整前端还需错误处理、会话状态、乐观消息去重、续期、重连/补偿及 token 安全存储。不要把 token 写入 URL、日志或共享通信文件；生产务必 HTTPS/WSS。
