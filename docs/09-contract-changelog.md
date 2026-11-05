# 09 · 契约变更流水

> 契约的唯一事实源：`contracts/requirements/*.json`（我方依赖声明）+ `backend/openapi.json`（后端实现事实）。
> 变更流程见 `docs/05-collaboration.md` 第 3 节。机械校验由 `scripts/check-contract.mjs` 执行。

---

## 版本总览

| 版本 | 日期 | openapi 版本 | ERROR | WARN | 状态 |
|---|---|---|---|---|---|
| v0.1.0 | 2026-09-28 | —（后端尚未产出） | — | — | **已作废**（我方单方提案，后端未采用其路径与包装） |
| v0.2.0 | 2026-09-28 | `0.2.0` | **0** | **0** | **双方对齐**（机械门禁通过；`[ACK]` 留痕见 `session-log.md`） |
| v0.2.0+uploads | 2026-10-22 | `0.2.0` | **0** | **0** | **增量扩展**（新增 3 个 uploads 端点、Message 增 `attachment`、`type` 增 `image`/`file`；openapi 版本号未 bump，按下方「新增端点/新增可选字段/新增枚举值」三条规则执行） |
| v0.3.0 | 2026-10-23 | `0.2.0` | **0** | **0** | **增量扩展**（第二轮体验改造：数字 uid、管理员后台、群角色、消息置顶、删除账号与附件可读范围修复；新增 8 个端点、User/Conversation 字段扩充；openapi 版本号仍不 bump） |
| v0.4.0（v2） | 2026-10-27 | `0.3.0` | **0** | **0** | **破坏性变更**（v2 平台升级：`attachment`→`attachments[]`、消息体不再接 `type`、撤回/引用回复、广场 9 端点、访客资料；`protocolVersion` 1→2；`SCHEMA_VERSION` 3→4。openapi 版本号本轮同步 bump 到 `0.3.0`） |
| v0.4.1（v2.3） | 2026-11-05 | `0.3.0` | **0** | **0** | **放宽型增量**（取消上传类型白名单：任意二进制照收，仅拦可执行文件；图片/文件上限 10→50 MiB；`content` 与附件互不依赖。openapi 版本号不 bump —— 无端点/字段/枚举变化，只放宽取值约束） |

> **v0.4.0（v2）破坏性变更逐条**（详见 `docs/v2/RELEASE-NOTES.md` §2）：
>
> | # | 变更 | v1 行为 | v2 行为 | 影响 |
> |---|---|---|---|---|
> | 1 | 消息附件字段 | `attachment: Attachment \| null` | `attachments: Attachment[]`（空数组 = 无附件） | 前端必须改渲染与发送 |
> | 2 | 发送体 | `{clientMsgId, content?, type?, attachmentId?}` | `{clientMsgId, content?, attachmentIds?(1..9 唯一), replyToMsgId?}` | 旧脚本全部 400 |
> | 3 | `type` 来源 | 客户端传入 `text\|system\|image\|file` | **服务端按附件推导**，增 `video`/`mixed` | 客户端传 `type` 直接 400（`additionalProperties:false`） |
> | 4 | 有附件约束 | 允许无文字裸发 | `attachmentIds` 非空时 `content` 必须非空（**2026-11-05 已放宽**：可只发附件，仅「既无附件也无文字」被拒） | 前端 `canSend` 已改为「有文字或有附件」 |
> | 5 | 业务协议版本 | `protocolVersion: 1` | `protocolVersion: 2`（仅 ready 帧；信封 `v` 仍为 1） | 前后端必须同版上线 |
> | 6 | `GET /uploads/:id` | 本人 + 同会话成员 | 追加「广场帖引用」「头像引用」两类 | 放宽，非破坏 |
> | 7 | 新增字段 | — | Message 增 `recalled`/`recalledAt`/`replyTo`；Conversation.myRole 增 `admin` | 前端需 `default` 分支 |
> | 8 | 数据库 | `SCHEMA_VERSION = 3` | `SCHEMA_VERSION = 4`（messages 重建 + 5 张新表） | 启动自动迁移，不可回退 |
>
> 按上表「破坏性变更必须 bump major + 双方 `[ACK]`」规则，本轮本应 bump major；因用户直接授权
> 单会话内完成 v2 改造（无独立后端 agent 的 `[ACK]` 流程），以 `ERROR 0 / WARN 0` 的机械门禁 +
> `docs/v2/API-V2.md` 书面契约为留痕凭证，版本号取 `0.3.0`。

> **冻结凭证**：v1 时代因用户未授权 git commit / tag，故不以 git tag 为凭证；替代凭证为三者同时成立：
> ① `contracts/requirements/*.json` 的 `version` 字段 ② 双方在 `session.txt` 的 `[ACK]` ③
> `node scripts/check-contract.mjs` 输出 `ERROR 0`。v2 起用户已授权 git 提交，改用 git commit 作为凭证。

---

## v0.1.0 → v0.2.0：20 项差异的处置

v0.1.0 是我方单方拟定的需求书。后端随后产出可运行的 `backend/openapi.json`，路径与包装多处不同。
经逐字段人工比对（完整报告见 `docs/contract/diff-report.md`），处置如下。

### A 组：接受后端方案，我方改契约与代码（20 项）

| # | 项 | 后端实际 | 我方 v0.1 原拟 | 处置 |
|---|---|---|---|---|
| A1 | 路径前缀 | path key 内含 `/api/v1`；`/health` 无前缀 | `baseURL=/api/v1` + 短路径 | `http.ts` 的 `baseURL` 置空、路径写全；`/health` 单独代理 |
| A2 | 认证返回 | `{token,tokenType,expiresAt,user}` 扁平 | `{user,session:{token,expiresAt}}` | `normalize` 层适配 |
| A3 | 会话类型枚举 | `single` | `group`（后端已按我方要求从 `direct` 改过来） | `single` | `group` | 一致；前端仍容错 `direct`（`normalizeConvType`） |
| A4 | 会话字段 | `{id,type,name,title,avatarUrl,peer,memberCount,myRole,ownerId,createdAt,updatedAt,members[],unreadCount,lastSeq,lastReadSeq,lastMessage}` | 同（我方提案的视角化字段后端已实现） | 一致 |
| A5 | 成员结构 | `members:[{user:{…全字段},role,joinedAt,lastReadSeq}]` | `{user:UserBrief,…}` | 接受（后端给完整 User，前端裁剪） |
| A6 | 角色枚举 | `owner` | `member`（**无 `admin`**） | `owner`|`admin`|`member` | 接受；前端 `normalizeRole` 对白名单外一律降级 `member` |
| A7 | 列表分页 | `{items,nextOffset}`，offset 型；`limit/offset` **必填** | `{items}` + 游标 | 接受（非消息列表，MVP 可接受）；前端显式传参 |
| A8 | 消息分页 | `{items,hasMore,nextBeforeSeq,nextAfterSeq}` | `{items,hasMore,oldestSeq,latestSeq}` | 接受（游标仍是 seq，语义等价） |
| A9 | 好友列表 | `{items:User[]}`（纯 User 数组） | `{items:[{user,since}]}` | 接受；`since` 用 `createdAt` 兜底 |
| A10 | 好友申请 | `{id,sender,recipient,note,status,createdAt,updatedAt}` | `{id,fromUser,toUser,direction,message}` | 接受；`direction` 由前端按 `sender.id === selfId` 推导 |
| A11 | 处理申请 | `POST /friend-requests/{id}/respond {action}` | 两个独立端点 `accept`/`reject` | 接受 |
| A12 | 用户搜索 | `GET /users?q=&limit=&offset=`（模糊匹配，**不返回 relationship**） | `GET /users/search?q=`（精确匹配 + 返回 relationship） | 接受；relationship 由前端本地推导（`deriveRelationship`） |
| A13 | 改资料 | `PATCH /users/me {displayName,avatarUrl,bio}` | `{displayName,signature}` | 接受：统一用 `bio` |
| A14 | 已读上报 | **204 无正文** | 200 含 `unreadCount` | 接受；权威 `unreadCount` 改由 WS `conversation.read` 推送 |
| A15 | 登出 | `200 {ok:true}` | 204 | 接受 |
| A16 | ws-ticket | `POST /auth/ws-ticket` → `200 {ticket,expiresIn}` | `POST /ws/ticket` → `201 {ticket,expiresAt,ttlSeconds}` | 接受 |
| A17 | 错误体 | `{error:{code,message,traceId}}` | `{error:{code,message,details,traceId}}` | 接受（后端用 `traceId` 而非 `requestId`） |
| A18 | sync | `{items:[{conversationId,messages,lastSeq,unreadCount,hasMore,nextSeq}]}` | 同 | 接受（后端采纳了我方提议的形状） |
| A19 | 建会话 | `POST /conversations/direct` + `/conversations/group` 两端点 | 单一 `POST /conversations {type}` | 接受 |
| A20 | 群成员增删 | `POST .../members` + `DELETE .../members/{userId}`（删除返回 `{ok:true}`） | 同（删除返回 Detail） | 接受；删除后前端本地刷新详情 |

### B 组：我方曾列为阻塞项，后端已全部实现（6 项）

| # | 项 | 我方要求 | 后端实现 | 状态 |
|---|---|---|---|---|
| B1 | 会话类型枚举 | 改为 `["single","group"]` | 已改为 `single|group`（`openapi` 实测） | **已解决** |
| B2 | 会话视角化字段 | `title` / `avatarUrl` / `peer` / `memberCount` / `lastReadSeq` | 全部实现（`title` 按请求者视角，`peer` 仅私聊） | **已解决** |
| B3 | 会话详情的 `myRole` | 加 `myRole` | 已实现 | **已解决** |
| B4 | `Message.type` 枚举 | 改为 `["text","system"]` | 已实现（system 的 `content` 为服务端渲染好的纯文本） | **已解决** |
| B5 | health 路径 | 加 `/api/v1/health` 别名 | 已实现（同时保留无前缀 `/health`） | **已解决** |
| B6 | 重新导出 openapi | 以上落定后重新导出 | **已重新导出**（`info.version` 0.2.0） | **已解决** |

### C 组：我方新提，后端列为「后续追加」（4 项，不阻塞）

| # | 端点 | 用途 | 前端降级策略 |
|---|---|---|---|
| C1 | `GET /users/{userId}` | 用户资料卡 | 暂用 `GET /users?q=<username>` 匹配；群成员资料卡只展示成员列表已有字段 |
| C2 | `DELETE /friends/{userId}` | 删好友 | 隐藏该按钮 |
| C3 | `GET /presence?userIds=` | 批量在线预取 | 降级为列表内嵌 `User.online` 快照 + `presence.changed` 增量。代价：首屏在线状态可能滞后 |
| C4 | 群主转让 / 解散群 | 群主退群的前置 | MVP 不做；`OWNER_CANNOT_LEAVE` 后前端禁用按钮并提示二期 |

### D 组：我方坚持并已被后端采纳（1 项）

| # | 项 | 我方立场 | 后端实现 |
|---|---|---|---|
| D1 | WS 信封的 `v:1` 协议版本号 | **唯一的阻塞项**。没有它，任何不兼容变更都无法协商，前端只能盲目重连 | 已实现：信封为 `{v,id,type,timestamp,data}`，不支持的 `v` 以 `4002` 关闭 |

### E 组：我方 v0.1 提案被放弃（后端未采用，已从契约删除）

| 项 | v0.1 提案 | 现状 | 影响 |
|---|---|---|---|
| 连接级 `seq` | 信封含 `Envelope.seq`，前端变量 `lastConnSeq`，用于连接内丢帧检测 | **后端未实现，已删除** | 缺口检测改为只依赖 `Message.seq` 的连续性 + 连接状态机。代码中禁止出现裸 `seq` 变量名 |
| WS 发消息 | `message.send` + `message.ack` | **改走 REST**；不存在这两个帧 | 前端 `MessageComposer` 直接调 REST。我方**认可**这个选择（原生幂等、状态码明确、可脱离 WS 验证） |
| WS 已读 | `message.read` + `message.read.updated` | 改走 REST + `conversation.read` 事件 | 事件名与字段集对齐后端 |
| WS 补偿 | `conversation.sync` + `sync.result` | **不存在**，只有 REST `POST /api/v1/sync` | 补偿以 REST 为主路径 |
| `message.read.updated` | 事件名 | 后端为 `conversation.read` | 已改 |
| `message.new` | 事件名 | 后端为 `message.created`（且带个性化 `unreadCount`） | 已改 |
| `friend.accepted` / `friend.removed` | 两个事件 | 后端合并为单个 `friend.resolved`（payload 只有 `request`，**不含 conversation**） | **重要后果**：通过好友申请**不会**自动建私聊。前端在用户点「发消息」时调 `POST /conversations/direct` |
| `conversation.member.changed` | 群成员变更事件 | **不存在** | 他人视角变更走 `conversation.updated`（整体替换 members）；自己被移除走 `conversation.removed` |
| `ready` 的附加字段 | `connectionId`/`serverTime`/`protocolVersion`/`heartbeatIntervalMs`/`sessionExpiresAt`/`features` | 只有 `userId` | 心跳用本地常量 25s；续期用本地 `expiresAt`；不做特性门控 |
| `pong` 回显 `clientTs` | 用于测 RTT | 空 `data` | 不测 RTT，改用「任意帧即活性」的看门狗 |
| `typing` 的 `state` | `state: 'start'|'stop'` | `active: boolean` | 已改 |
| 关闭码 `4003`/`4004`/`4029`/`1011` | 我方自拟 | 后端未采用 | 已从契约删除。后端实际用 `4001`/`4002`/`1008`/`1009`/`1013`/`1006` |
| 错误码命名 | `VALIDATION_FAILED`/`AUTH_INVALID_CREDENTIALS`/`NOT_GROUP`/`FORBIDDEN_NOT_MEMBER`… | 后端为 `VALIDATION_ERROR`/`INVALID_CREDENTIALS`/`GROUP_REQUIRED`/`FRIEND_REQUIRED`/`OWNER_REQUIRED`… | `errors.json` 已按后端 29 个码重写 |

---

## v0.2.0 基准的机械校验结果

```
$ node scripts/check-contract.mjs
openapi 版本：0.2.0
openapi 路径数：22；需求书声明：26
字段检查 465 项；枚举检查 41 项；请求体检查 12 端点
ERROR 0 / WARN 0
✅ 无差异：需求书与 backend/openapi.json 完全一致
```

完整报告：`docs/contract/check-result.md`（脚本自动生成）。

---

## v0.2.0 → v0.2.0+uploads（用户反馈「接口不完善(无文件/图片上传)」）

**性质**：纯增量。openapi 的 `info.version` 保持 `0.2.0` —— 按本文件末尾的变更规则，新增端点、新增可选字段、新增枚举值都属允许的同 minor 变更。协议**形状没有破坏性改动**：没有字段重命名、没有删除、没有语义翻转。

### 新增端点（3 个）

| id | 方法 | 路径 | 成功 | 说明 |
|---|---|---|---|---|
| U4 | POST | `/api/v1/uploads?filename=` | 201 | 裸二进制上传（无 multipart），类型按魔数嗅探 |
| U5 | GET | `/api/v1/uploads/{id}` | 200（二进制，无 JSON schema） | 取原始字节，仅属主可读 |
| U6 | DELETE | `/api/v1/uploads/{id}` | 204 | 回收未附着附件 |

### 新增/变更字段

| 位置 | 变更 | 兼容性 |
|---|---|---|
| `Message` | 新增 `attachment: Attachment \| null`（**恒存在**，纯文本为 `null`） | 新可选字段；老前端忽略即可 |
| `Message.type` | 枚举 `text\|system` → `text\|system\|image\|file` | 新增枚举值，前端**必须有 default 分支**（本文件规则要求） |
| `SendMessage` 请求体 | `required: [clientMsgId,type,content]` → `[clientMsgId]`；`content`/`type` 变可选，新增可选 `attachmentId` | 向后兼容：老客户端照旧传 `{clientMsgId,type:'text',content}` 仍 201 |
| 新增 definition | `Attachment`、`Upload` | 新增 |

### 新增错误码（6 个）

| code | http | 场景 |
|---|---|---|
| `INVALID_ATTACHMENT` | 400 | attachmentId 不存在或不属于发送者 |
| `FORBIDDEN` | 403 | 已认证但无权访问（读取/删除他人上传物） |
| `UPLOAD_NOT_FOUND` | 404 | 上传物不存在或已删 |
| `UPLOAD_IN_USE` | 409 | 附件已被消息引用（删除/复用被拒） |
| `UPLOAD_TOO_LARGE` | 413 | 超过 10 MiB（裸 body 超 11 MiB 同样归此码） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 魔数不在白名单 |

> `413` 与 `415` 在 openapi 的共享错误响应集里原本就有（`ErrorResponses` 本次加入 415），但此前**没有任何端点会业务性返回它们**；上传端点让它们首次成为业务可达码。

### 存储层（schema 变更，不属 HTTP 契约但不迁移会直接报错）

| 项 | 变更 | 说明 |
|---|---|---|
| `PRAGMA user_version` | **1 → 2** | `backend/src/db.ts` 的 `SCHEMA_VERSION = 2` |
| `messages` 表 | 新增 `attachment_id TEXT REFERENCES uploads(id)`；`type` 的 `CHECK` 由 `('text','system')` 扩为 `('text','system','image','file')` | SQLite 无法原地改 CHECK，老库走「建 messages_upgrade → INSERT SELECT → DROP → RENAME → 重建索引」，全程包在 `BEGIN IMMEDIATE` 里，失败回滚 |
| `uploads` 表 | **新增**：`id, owner_id, name, mime_type, size, sha256, kind, created_at` + `INDEX uploads_owner(owner_id, created_at)` | 落盘文件名恒为 `<uuid><按 mime 推导的扩展名>`，客户端文件名只存库不参与路径 |

迁移判定读的是 `sqlite_master` 里的**真实 DDL**（是否已含 `'image'`）而不是版本号数值，所以「版本号被外部改回 1 但表已是新版」也不会重复重建；重复启动幂等。老库里的历史消息 `attachment_id` 一律填 `NULL`（即 `attachment: null`），不丢数据。

### CSP 变更（4 处必须同时改）

`img-src 'self' data:` → `img-src 'self' data: blob:`，位置：
1. `backend/src/app.ts` 的 `CONTENT_SECURITY_POLICY`
2. `backend/src/app.ts` 的 `DOCS_CONTENT_SECURITY_POLICY`
3. `backend/deploy/nginx-chat.conf`
4. `backend/deploy/nginx-chat-https.conf`

理由：附件预览必须走带 Bearer 的 fetch → blob URL，`<img>` 不会带 Authorization 头，只能靠 `blob:` 渲染。`backend/test/deploy-headers.test.ts` 的逐字漂移检测保证这 4 处不会走偏；生产页面由 nginx 提供，故 nginx 两处不是冗余。

### 机械门禁

```
$ node scripts/check-contract.mjs
openapi 路径数：24；需求书声明：29
字段检查 546 项；枚举检查 51 项；请求体检查 12 端点
ERROR 0 / WARN 0
✅ 无差异：需求书与 backend/openapi.json 完全一致
```

`--self-test` 仍命中 structure / response / enum / body 四类，门禁有效性未被本次改动削弱。

### 变更类别判定（为何不 bump 版本）

按本文件末尾「后续变更规则」的表：

| 本次变更 | 归入规则 | 结论 |
|---|---|---|
| 新增 3 个 uploads 端点 | 「新增端点」 | 允许，同 minor |
| `Message.attachment`（可空恒存在） | 「新增可选字段」 | 允许，同 minor |
| 发消息体 `attachmentId`（可选）、`content`/`type` 变可选 | 「新增可选字段」 | 允许，同 minor；老客户端 `{clientMsgId,type:'text',content}` 仍 201 |
| `Message.type` 增 `image`/`file` | 「新增枚举值」 | 允许，同 minor，**前提是前端有 `default` 分支**（已满足，见下） |

没有字段重命名、没有删除、没有语义翻转，因此 `info.version` 保持 `0.2.0`。

### 前端适配状态（已落地，不再阻塞）

`ux-message`（teammate）已在同一轮完成适配，本轮核对到以下文件已落地（只读核对，未修改前端任何文件）：

| 文件 | 改动 |
|---|---|
| `frontend/src/api/wire.ts` | `Message` 加 `attachment?: WireAttachment \| null`；新增 `WireUpload`/`WireAttachment`；`type` 联合扩 `image`/`file` |
| `frontend/src/api/normalize.ts` | `toAttachment()` 逐字段校验并归一，损坏值降级 `null`；`type` 兜底：有附件却报 `text` 时按 `attachment.kind` 纠正为 `image`/`file` |
| `frontend/src/api/uploads.ts` | **新增**：上传/下载/删除三个调用（下载带 Bearer 取字节转 blob） |
| `frontend/src/api/messages.ts` | 发送载荷新增可选 `attachmentId` |
| `frontend/src/types/domain.ts` | 领域层 `Message.attachment?: Attachment \| null`、会话列表 `attachmentKind` 短预览 |
| `frontend/src/ws/schema.ts` | WS 侧 `message.created` 的 `data.message` 校验接受新 `type` 与 `attachment` |
| `frontend/src/components/message/AttachmentView.vue` | **新增**：图片气泡（blob 渲染）/文件气泡（名称+大小+下载） |
| `frontend/src/components/message/composer.ts`、`frontend/src/views/MessagePane.vue` | 选文件 → 上传 → 发送时只带 `attachmentId`，不带 `type` |

前端门禁（由 ux-message / Lead 执行）：`vue-tsc --noEmit` exit 0；`vitest run` 11 files / 172 tests 全绿；`management/browser-check.mjs` 已修复（`.md-sr` 全文副本移除导致的 strict mode violation）。

### 前端必须做的事（历史条目，已在上面「前端适配状态」闭环）

1. `Message.attachment` 参与归一化：`null` 与缺失都归一为 `null`，不要用 `undefined`。
2. `renderByType` 增 `image`/`file` 分支；未知 `type` 落 default 分支显示占位（老版本前端遇到新 type 不能白屏）。
3. 图片气泡按 §4.5 的 blob 流程渲染，禁止直连 `attachment.url`。
4. 上传入口：选文件 → `POST /api/v1/uploads` → 拿 `id` 发消息；失败可 `DELETE` 回收。

---

## v0.3.0（第二轮体验改造）：数字 uid / 管理员 / 群角色 / 置顶 / 附件可读范围

**性质**：纯增量 + 一处**行为放宽**。openapi 的 `info.version` 保持 `0.2.0`。

依据是本文件末尾「后续变更规则」的三条允许项（新增端点 / 新增可选字段 / 新增枚举值），因此不 bump minor。
唯一不属于「纯新增」的是 U5（`GET /api/v1/uploads/{id}`）的可见范围放宽：从「仅属主」改为「属主 **或** 该附件被某条消息引用且请求者是该会话成员」。
这是**放宽**而不是收紧 —— 原先返回 403 的请求现在返回 200，任何既有客户端的正常路径都不受影响（读不到的人本来就拿不到内容，只是从报错变成能读），故同样不属破坏性变更。

### 新增端点（8 个）

| id | 方法 | 路径 | 成功 | 说明 |
|---|---|---|---|---|
| C9 | POST | `/api/v1/conversations/{id}/members/{userId}/role` | 200 | 群主任命/取消管理员，body `{ role: 'admin' \| 'member' }` |
| P1 | GET | `/api/v1/conversations/{id}/pins` | 200 | 置顶列表，`{ items: PinnedMessage[] }` |
| P2 | POST | `/api/v1/conversations/{id}/pins` | 201 / 200（幂等） | body `{ msgId }` |
| P3 | DELETE | `/api/v1/conversations/{id}/pins/{msgId}` | 204 | 取消置顶 |
| D1 | GET | `/api/v1/admin/users` | 200 | 用户列表，支持 `query`/`limit`/`offset`，按 uid 升序 |
| D2 | POST | `/api/v1/admin/users/{uid}/mute` | 200 | body `{ minutes }`，0 = 解除禁言 |
| D3 | DELETE | `/api/v1/admin/users/{uid}` | 204 | 删除账号（连带清理消息、转移群主、回收空私聊） |
| D4 | GET | `/api/v1/admin/stats` | 200 | 用户数/会话数/消息数/上传数/在线数 |

`/api/v1/admin/*` 全部要求 `role === 'admin'`，否则 403 `ADMIN_REQUIRED`。

### 新增/变更字段

| 位置 | 变更 | 兼容性 |
|---|---|---|
| `User` | 新增 `uid`(integer)、`role`(user/admin)、`status`(active/banned)、`mutedUntil`(可空恒存在) | 新增字段；**`User.required` 因此扩到这 4 个**，前端若做 strict 校验需同步（`frontend/src/api/wire.ts` 已加） |
| `ConversationMember.role` | 枚举 `owner`/`member` → `owner`/`admin`/`member` | 新增枚举值，前端需 default 分支（已有 `normalizeRole` 降级 `member`） |
| `Conversation.myRole` | 同上三值 | 同上 |
| 登录 A2 请求体 | `username` 由 `^[A-Za-z0-9_]+$` 放宽为「用户名或纯数字 uid」，minLength 3 → 1 | 放宽，老客户端不受影响 |
| A2 错误码 | 新增 403 `ACCOUNT_BANNED` | 登录失败从「401 一律」细化为「401 凭证错 / 403 被禁用」 |
| M2 错误码 | 新增 403 `MUTED`、403 `ACCOUNT_BANNED` | 发消息被禁言/封号时的可达分支 |
| U2 / C5 的 `avatarUrl` | 语义放宽：`''`（清空）/ `https://` 外链 / `/api/v1/uploads/<uuid>`（须本人上传且 `kind=image`） | 纯放宽；非法值仍 400 `INVALID_AVATAR_URL` |
| 新增 definition | `PinnedMessage`、`PinnedMessagePage`、`AdminUserPage`、`AdminStats` | 新增 |

### 新增错误码（9 个）

| code | http | 场景 |
|---|---|---|
| `CANNOT_CHANGE_OWNER_ROLE` | 400 | 试图把群主本人设成 admin/member（群主身份只由 `owner_id` 决定，不可接口变更） |
| `INVALID_MESSAGE` | 400 | 置顶的 msgId 不存在或不属于该会话（两种原因刻意合并，避免 msgId 变成可探测凭据） |
| `ACCOUNT_BANNED` | 403 | 登录时 `status=banned` |
| `MUTED` | 403 | 禁言期（`muted_until` 晚于当前）发消息 |
| `ADMIN_REQUIRED` | 403 | 非 admin 调 `/api/v1/admin/*` |
| `PIN_NOT_FOUND` | 404 | 取消置顶时该消息不在列表里（并发取消属正常竞争，前端按成功处理） |
| `CANNOT_DELETE_ADMIN` | 409 | 删除管理员账号（避免把唯一管理员删掉后失去后台入口） |
| `CANNOT_MUTE_ADMIN` | 409 | 禁言管理员账号 |
| `PIN_LIMIT` | 409 | 单会话置顶已达上限 50 条 |

> 状态码选型说明：禁言用 **403** 而非 429 —— 前者是「权限恒被拒、重试无意义」，后者是「频率超限、可退避重试」。
> 删除/禁言管理员用 **409** 而非 403 —— 请求本身合法，只是与被保护对象的身份冲突（类似 `IDEMPOTENCY_CONFLICT`）。

### WS 帧（第 13 个 S→C 帧）

新增 `conversation.pins`：`data: { conversationId, pins: PinnedMessage[] }`。

- 载荷是**完整列表**而非增量（上限 50 条，整体替换比对账更不易出错）。
- 置顶/取消置顶后广播给会话**全体成员（含操作者本人）**：操作者不要把 POST/DELETE 的响应再和本地状态合并，一律以本帧为准。
- **幂等重放不广播**：同一条消息重复置顶返回 200 但服务端不 publish。
- 取消置顶恒广播，最后一条取消时推 `pins: []`。

C→S 帧未变（仍只有 `ping` 与 `typing`）；`message.created` 的 `data.message` 因 `Message` 通过 `$ref` 引用 rest 定义而自动携带新字段，帧形状未变。

### 存储层（schema v2 → v3）

| 项 | 变更 |
|---|---|
| `PRAGMA user_version` | **2 → 3**（`SCHEMA_VERSION = 3`） |
| `users` | 新增 `uid INTEGER`、`role TEXT`（user/admin）、`status TEXT`（active/banned）、`muted_until TEXT` + `CREATE UNIQUE INDEX users_uid ON users(uid) WHERE uid IS NOT NULL` |
| `conversations` | 新增 `avatar_url TEXT` |
| `conversation_members` | 新增 `role TEXT`（owner/admin/member），回填群主 |
| `message_pins` | **新增表**：`id, conversation_id, msg_id, pinned_by, pinned_at` + `UNIQUE(conversation_id, msg_id)` + `INDEX message_pins_conversation(conversation_id, pinned_at DESC)` |

- 列存在性判定用 `PRAGMA table_info(...)` 而不是 `ALTER TABLE ... ADD COLUMN` 撞错重试，整段包在 `BEGIN IMMEDIATE` 里。
- `uid` 分配：管理员固定 `1001`（`ADMIN_UID`），普通用户从 `10001` 起单调递增（删除后不复用）；老库按 `created_at, id` 顺序回填。
- 唯一索引用**部分索引**（`WHERE uid IS NOT NULL`）而不是普通 UNIQUE：迁移期间新旧行可能短暂共存 NULL，部分索引语义更明确，也便于后续加约束。

### 机械门禁

```
$ node scripts/check-contract.mjs
openapi 版本：0.2.0
openapi 路径数：31；需求书声明：37
字段检查 804 项；枚举检查 124 项；请求体检查 15 端点
ERROR 0 / WARN 0
✅ 无差异：需求书与 backend/openapi.json 完全一致
```

`--self-test` 仍命中 structure / response / enum / body 四类（`ERROR=4 WARN=2`），门禁有效性未被削弱。

### 变更类别判定（为何仍不 bump openapi 版本）

| 本次变更 | 归入规则 | 结论 |
|---|---|---|
| 新增 8 个端点（C9/P1~P3/D1~D4） | 「新增端点」 | 允许，同 minor |
| `User` 新增 4 个字段、新增 4 个 definition | 「新增可选字段」/新增 | 允许，同 minor |
| `ConversationMember.role`、`Conversation.myRole` 增 `admin` | 「新增枚举值」 | 允许，同 minor，前提前端有 default 分支（已满足） |
| 登录 username 放宽为「用户名或 uid」 | 放宽 | 允许，老客户端行为不变 |
| U5 可读范围「仅属主」→「属主或同会话成员」 | 放宽 | 允许；原先 403 的请求现在 200，正常路径不受影响 |
| 新增 9 个错误码、`conversation.pins` 帧 | 新增 | 允许，同 minor |

没有字段重命名、没有删除、没有语义收紧，因此 `info.version` 保持 `0.2.0`。
契约需求书（`contracts/requirements/*.json`）的 `version` 升到 `0.3.0`、`supersedes: 0.2.0` —— 这是**我方依赖声明**的版本，与后端 `info.version` 是两个维度。

### 前端必须做的事

1. **登录页** placeholder 改「账号名或 UID」；处理 403 `ACCOUNT_BANNED` 与 401 `INVALID_CREDENTIALS` 两种分支。
2. **`User` 归一化**补 `uid`/`role`/`status`/`mutedUntil`；`normalizeRole` 白名单加 `admin`，白名单外降级 `member`。
3. **发消息**收到 403 `MUTED` 时提示「禁言至 XX」并禁用输入框（不要当成无权限）。
4. **附件气泡**：对方发来的附件现在可正常渲染（U5 放宽），不再需要「他人附件降级为文件名」的兜底；草稿附件仍仅属主可读。
5. **群信息页**：角色徽标（群主/管理员）、owner 可任命/取消管理员与移人、admin 只能移普通成员。
6. **管理后台**：`/admin` 仅 `role==='admin'` 可进；非管理员收到 403 `ADMIN_REQUIRED` 应刷新 `me` 并隐藏入口。
7. **置顶条**：订阅 `conversation.pins`，整体替换本地列表；收到 `PIN_NOT_FOUND` 按成功处理（并发取消）。

### 后端交付证据

见 `backend/evidence/ux2-backend.md`：门禁实跑输出、42 条测试清单、迁移幂等性证明、隔离实例 49 项冒烟。

---

## 后续变更规则

冻结（`ERROR 0` + 双方 `[ACK]`）之后：

| 变更类型 | 允许否 | 要求 |
|---|---|---|
| 新增可选字段 | 允许 | 同 minor；前端已有可选访问，无需改代码 |
| 新增端点 | 允许 | 同 minor；前端按需接入，未接入不影响现有功能 |
| 新增枚举值 | 允许 | 同 minor，**但前端必须有 `default` 分支**。检查：`check-contract` 会报 WARN 提醒 |
| 字段重命名 / 类型变更 / 删除 / 语义变更 | **不允许直接做** | 必须 bump minor + 双方 `[ACK]` + 重跑门禁 + 我方改 `requirements/*.json` 与 `api/wire.ts` + `api/normalize.ts` |
| 破坏性变更（删字段、改语义） | 必须 bump major | 同上，且需评估已上线前端 |

变更流程（见 `docs/07-mock-and-testing.md` §7）：

```
① 后端改实现 → 重新导出 backend/openapi.json
② node scripts/check-contract.mjs
③ ERROR > 0 → session.txt 发 [CONTRACT] 列差异 + 我方结论（接受 / 阻塞 / 待议）
④ 双方 ACK → 我方 bump requirements 版本号 → 重跑到 ERROR 0
⑤ 前端通常只需改 api/normalize.ts 一处
```

