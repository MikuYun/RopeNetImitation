# 契约差异报告（我方需求书 ↔ backend/openapi.json）

- 更新时间：2026-09-28
- 后端产物：`backend/openapi.json` **v0.2.0**（openapi 3.0.3）+ `backend/API.md`
- 结论：**后端已实现我方 v0.1 提出的全部阻塞项**，契约可冻结。前端已按 v0.2.0 对齐。

---

## 一、v0.1 阻塞项的闭环情况（全部已解决）

| # | v0.1 阻塞项 | v0.2.0 实际 | 状态 |
|---|---|---|---|
| B1 | 会话类型枚举 `single\|group` | `enum: ["single","group"]` | ✅ 已实现 |
| B2 | 视角化字段 `title/avatarUrl/peer/memberCount/lastReadSeq` | 全部存在，`peer` 仅单聊返回 | ✅ 已实现 |
| B3 | `myRole` | 存在，`enum: ["owner","member"]` | ✅ 已实现 |
| B4 | `Message.type: text\|system` | `enum: ["text","system"]` | ✅ 已实现 |
| B5 | `/api/v1/health` 别名 | 与 `/health` 并存 | ✅ 已实现 |
| — | WS 信封加 `v:1` | `{"v":1,"id",...,"timestamp","data"}` | ✅ 已实现 |
| — | 4001 / 4002 关闭码区分 | 已定义，且语义与我方一致 | ✅ 已实现 |
| — | `session/refresh` 不轮换 token | 「同 token 延后 expiresAt」，不轮换 | ✅ 已实现 |

## 二、公开 API 的最终形状（冻结基准）

### 2.1 全局约定

| 项 | 值 |
|---|---|
| REST base | `http://127.0.0.1:3001/api/v1` |
| 健康检查 | `GET /api/v1/health`（另有 `/health` 别名） |
| WS | `ws://127.0.0.1:3001/ws?ticket=<ticket>&v=1` |
| 认证 | `Authorization: Bearer <opaque token>`；有效期 7 天 |
| ID | 一律 UUID 字符串 |
| 时间 | ISO 8601 UTC |
| 列表 | `{items, nextOffset}`；`nextOffset:null` 为末页；`limit` 默认 30、最大 100 |
| 成功响应 | 直接返回资源，**不包 `data`** |
| 错误体 | `{error:{code, message, traceId}}` |
| 排序 | 会话列表按 `updatedAt DESC, id DESC`；消息按 `(conversationId, seq)` |
| 未知字段 | 请求体/查询**拒绝**未知字段 |

### 2.2 端点清单（21 个受控端点）

| 方法与路径 | 请求 | 成功 |
|---|---|---|
| `GET /api/v1/health` | — | 200 `{status,version,protocolVersion,serverTime}` |
| `POST /api/v1/auth/register` | `{username,password,displayName}` | 201 AuthResult |
| `POST /api/v1/auth/login` | `{username,password}` | 200 AuthResult |
| `GET /api/v1/auth/session` | — | 200 AuthResult |
| `POST /api/v1/auth/session/refresh` | — | 200 AuthResult（同 token） |
| `POST /api/v1/auth/logout` | — | 200 `{ok:true}` |
| `POST /api/v1/auth/ws-ticket` | — | 200 `{ticket,expiresIn:30}` |
| `GET /api/v1/users/me` | — | 200 User |
| `PATCH /api/v1/users/me` | `{displayName?,avatarUrl?,bio?}` | 200 User |
| `GET /api/v1/users?q=&limit=&offset=` | q 必填 1–40 | 200 `{items:User[],nextOffset}` |
| `GET /api/v1/friends` | `limit?,offset?` | 200 `{items:User[],nextOffset}` |
| `GET /api/v1/friend-requests` | `status?,limit?,offset?` | 200 `{items:FriendRequest[],nextOffset}` |
| `POST /api/v1/friend-requests` | `{userId,note?}` | 201 FriendRequest |
| `POST /api/v1/friend-requests/{id}/respond` | `{action:'accept'\|'reject'}` | 200 FriendRequest |
| `GET /api/v1/conversations` | `limit?,offset?` | 200 `{items:Conversation[],nextOffset}` |
| `POST /api/v1/conversations/direct` | `{userId}` | 200 Conversation（幂等） |
| `POST /api/v1/conversations/group` | `{name,memberIds}` | 201 Conversation |
| `GET /api/v1/conversations/{id}` | — | 200 Conversation |
| `PATCH /api/v1/conversations/{id}` | `{name}`（1–60，仅群主） | 200 Conversation |
| `POST /api/v1/conversations/{id}/members` | `{memberIds}`（仅群主） | 200 Conversation |
| `DELETE /api/v1/conversations/{id}/members/{userId}` | — | 200 `{ok:true}` |
| `GET /api/v1/conversations/{id}/messages` | `limit?,beforeSeq?,afterSeq?` | 200 `{items,hasMore,nextBeforeSeq,nextAfterSeq}` |
| `POST /api/v1/conversations/{id}/messages` | `{clientMsgId,type:'text',content}` | 201 或 200 Message |
| `POST /api/v1/conversations/{id}/read` | `{lastReadSeq}` | **204 无正文** |
| `POST /api/v1/sync` | `{cursors:[{conversationId,lastSeq}]}` | 200 `{items:[{conversationId,messages,lastSeq,unreadCount,hasMore,nextSeq}]}` |

### 2.3 Conversation 数据模型（v0.2.0 完整版）

```
{ id, type:'single'|'group', name, title, avatarUrl, peer?, ownerId,
  memberCount, myRole:'owner'|'member',
  members:[{user:User, role, joinedAt, lastReadSeq}],
  unreadCount, lastSeq, lastReadSeq, lastMessage, createdAt, updatedAt }
```

要点：
- `title` 与服务端按**请求者视角**计算（单聊=对方昵称，群聊=群名）—— 前端不再自行推导
- `peer` 仅单聊返回；群聊返回 `memberCount`
- `ownerId` 私聊为 `null`

### 2.4 Message 数据模型

```
{ msgId, conversationId, senderId, clientMsgId, seq, type:'text'|'system', content, createdAt }
```

要点：
- 客户端只能发 `text`；`system` 由服务端产生（建群/改名/成员变更），**占用正常 seq**，`senderId` 为操作者
- 按 `(conversationId, seq)` 排序，按 `msgId` 去重，乐观消息按 `clientMsgId` 对齐

### 2.5 WebSocket 协议（v0.2.0）

建连：`POST /auth/ws-ticket` → `ws://host/ws?ticket=<t>&v=1`
- ticket 一次性、30 秒过期、**不控制已连接寿命**
- 每用户最多 5 条连接
- 服务端信封 `{v:1, id, type, timestamp, data}`

**服务端 → 客户端（10 类）**

| type | data |
|---|---|
| `ready` | `{userId}` |
| `pong` | `{}` |
| `message.created` | `{message:Message, unreadCount}`（含发送者自己的所有连接） |
| `conversation.created` | `{conversation}`，按接收者个性化 |
| `conversation.updated` | `{conversation}` |
| `conversation.removed` | `{conversationId}` |
| `conversation.read` | `{conversationId,userId,lastReadSeq,unreadCount}` |
| `friend.requested` | `{request}` |
| `friend.resolved` | `{request}` |
| `presence.changed` | `{userId, online}` |
| `typing.changed` | `{conversationId, userId, active}` |
| `error` | `{code, message}` |

**客户端 → 服务端（2 类，无信封 id/timestamp）**

```json
{"v":1,"type":"ping"}
{"v":1,"type":"typing","conversationId":"...","active":true}
```

**重要**：发送消息与已读**走 REST**，不存在 WS 发消息 ack。

**关闭码**

| 码 | 含义 | 客户端策略 |
|---|---|---|
| `4001` | ticket 缺失/失效/已用 | 申请新票据重连；若 REST 401 则重新登录 |
| `4002` | 不支持的 `v` | 提示刷新，不盲目重连 |
| `1008` | session 失效/注销，或超连接数/超帧频/非法二进制 | 先 `GET /auth/session` 检查，401 则登录，否则退避重连 |
| `1009` | 帧过大 | 检查客户端 |
| `1013` | 慢消费者 | 退避重连并 sync |
| `1006` | 非正常断连/心跳超时 | 指数退避 + 获取新票据 |

**限流**：每连接最多 30 帧/10 秒，单帧 ≤ 4 KiB，拒二进制，积压 > 1 MiB 主动断开。

### 2.6 错误码表

| HTTP | code |
|---|---|
| 400 | `VALIDATION_ERROR` / `BAD_REQUEST` / `INVALID_AVATAR_URL` |
| 400 | `SELF_FRIEND_REQUEST` / `SELF_CONVERSATION` |
| 400 | `INVALID_MEMBERS` / `GROUP_FULL` / `GROUP_REQUIRED` |
| 400 | `INVALID_CURSOR` / `DUPLICATE_CURSOR` / `INVALID_READ_CURSOR` |
| 401 | `UNAUTHORIZED` / `INVALID_CREDENTIALS` |
| 403 | `FRIEND_REQUIRED` / `OWNER_REQUIRED` / `ORIGIN_FORBIDDEN` |
| 404 | `USER_NOT_FOUND` / `CONVERSATION_NOT_FOUND` / `REQUEST_NOT_FOUND` / `MEMBER_NOT_FOUND` / `NOT_FOUND` |
| 409 | `USERNAME_TAKEN` / `ALREADY_FRIENDS` / `REQUEST_PENDING` / `REQUEST_RESOLVED` |
| 409 | `OWNER_CANNOT_LEAVE` / `IDEMPOTENCY_CONFLICT` |
| 413 | `BAD_REQUEST`（body > 32 KiB） |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

## 三、仍需注意的行为差异（非阻塞，但会影响实现）

| # | 项 | 说明 | 前端处置 |
|---|---|---|---|
| C1 | `read` 返回 **204 无正文** | 拿不到权威 `unreadCount` | 改用 WS `conversation.read` 推送的 `unreadCount`；本地先乐观清零 |
| C2 | `DELETE .../members/{userId}` 返回 `{ok:true}` | 不再返回完整 Conversation | 本地移除成员后重新 `GET /conversations/{id}` 校准 |
| C3 | 通过好友申请**不自动建会话** | `respond` 只返回 FriendRequest | `accept()` 后额外调 `POST /conversations/direct`（幂等） |
| C4 | `GET /users?q=` 为**模糊匹配**用户名+昵称 | 与我方 v0.1 的「精确匹配」不同 | 前端按模糊处理，展示全部结果 |
| C5 | `presence.changed` 只有 `{userId, online}` | **无 `lastSeenAt`** | 离线时不显示「最后在线时间」，只显示灰点 |
| C6 | 群主不能退群/转让 | `OWNER_CANNOT_LEAVE` | 前端按 code 提示，不硬编码策略 |
| C7 | WS 不重放事件 | 服务重启/断线期间的事件丢失 | 补偿完全依赖 REST（列表刷新 + 按 seq 逐页 sync） |
| C8 | 每用户最多 5 条 WS 连接 | 超出以 1008 关闭 | 前端多标签页共享连接不做；按原样允许多标签页，超限时提示 |
| C9 | `GET /auth/session` 已实现且返回完整 AuthResult | 冷启动可直接校验 | 已用它替换原 `/users/me` 兜底 |
| C10 | `PATCH /conversations/{id}` 的 `name` 为 1–60（群名） | 我方原写 1–30 | 前端输入框限制改为 60 |

## 四、冻结建议

后端已 ACK 并实现全部阻塞项，**建议冻结为 `contract-v1.0`**。冻结方式（用户未授权 git tag）：

1. `contracts/requirements/*.json` 升到 **v0.3.0** 并与本报告对齐
2. 双方在 `session.txt` 互发 `[ACK] contract-v1.0`
3. `docs/09-contract-changelog.md` 记录冻结时间与 openapi 版本号
4. 冻结后同一 minor 内只允许追加（加可选字段、加端点、加有 default 的枚举值）；字段重命名/类型变更/删除/语义变更必须 bump minor + 双方 ACK
