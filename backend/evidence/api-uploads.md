# UX-B 交付证据：后台上传接口 + 消息附件契约

> 作者：ux-api（teammate）；任务：Team task-6「UX-B 后端上传接口 + 附件消息契约」
> 实测时间：2026-10-22 13:10–15:50（Asia/Shanghai，本机开发工作站）
> 全部实测在**本机隔离环境**：`:memory:` 或 `os.tmpdir()` 下的临时 SQLite + 临时 uploads 目录；HTTP 端到端只用 `127.0.0.1:3097`（避开他人占用的 3099/3001）。
> **未执行** `git commit`/`git tag`；**未执行** `backend/deploy/` 下任何脚本（含 `reset-chat.mjs`）；未触碰生产、未改 `frontend/`、未改 `management/`；未新增任何 npm 依赖。
> 数据均为真实运行输出；未覆盖/未验证项在 §9 如实标注。

---

## 摘要（≤120 字）

上传三端点（POST/GET/DELETE）+ 消息附件契约已落地：裸二进制 + 魔数嗅探、10 MiB 上限、原子落盘、sha256、幂等发消息按附件推导 type。32/32 测试全绿，契约门禁 ERROR 0 / WARN 0，真实 HTTP 端到端 43/43 断言通过。

---

## 0. 环境与指纹

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows 10，Git Bash（`/b/AITrance`） |
| Node / npm | `v24.15.0`（`/e/nodejs/node.exe`）/ npm 须以 `node /e/nodejs/node_modules/npm/bin/npm-cli.js` 调用 |
| SQLite | 内置 `node:sqlite` `DatabaseSync`（非 better-sqlite3） |
| `backend/src/` 聚合 sha256 | `0d5b7301f3f4eef97fa6a90c44bf9f7066817d3efd67f92fd06272a616e4fa22`（11 个 .ts，`ls -1 src/*.ts \| sort \| xargs sha256sum \| sha256sum`） |
| `backend/openapi.json` sha256 | `e839dc101885313c68a9f02486d485509d2ad311a453c6b36614423bc45ca3f5`（13127 行，`npm run docs` 幂等：重跑后 diff 为空） |
| 隔离后端端口 | `127.0.0.1:3097`（3099 被另一实例占用，未触碰） |

### 0.1 改动文件清单

| 文件 | 行数 | sha256 前 16 位 | 改动 |
| --- | --- | --- | --- |
| `backend/src/upload.ts` | 181 | `2e9305a3b6472dcb` | **新增**：魔数嗅探、扩展名推导、原子写、sha256、目录校验、文件名清洗 |
| `backend/src/db.ts` | 168 | `0457a7bf686e407d` | uploads 表、messages.attachment_id、type CHECK 扩 image/file、`SCHEMA_VERSION=2` + 幂等迁移 |
| `backend/src/schemas.ts` | 108 | `dc42d81911536b17` | 新增 `Attachment`/`Upload`/`UploadParams`/`UploadQuery`；`Message` 加 `attachment` 且 type 四值；`ErrorResponses` 加 415 |
| `backend/src/config.ts` | 142 | `c7d4f66e78ad1183` | 新增 `uploadsDir`（`UPLOADS_DIR` 覆盖，默认与 DB 同目录） |
| `backend/src/service.ts` | 464 | `1730b44645a8295d` | `attachmentView`/`attachment`；`sendMessage` 五参 + type 推导 + 四类校验；`createUpload`/`readUpload`/`deleteUpload` |
| `backend/src/routes.ts` | 356 | `e5fd3b43aa6c73da` | 3 个 uploads 路由（独立 content-type parser 作用域）；发消息 body 改可选 content/attachmentId |
| `backend/src/app.ts` | 246 | `f2d89efbdebd0b33` | `ensureUploadsDir` 启动校验、uploadsDir 注入、413/415 错误码映射、两个 CSP 常量加 `blob:` |
| `backend/src/realtime.ts` | 234 | `5e8bf5919017abf0` | `SweepReport.uploads`、孤儿上传清理 |
| `backend/test/uploads.test.ts` | 371 | `9070e0f9df7c4659` | **新增 6 条测试** |
| `backend/test/security.test.ts` | 346 | `e5a7c3304063abcc` | CSP 期望字面量加 `blob:`（1 行） |
| `backend/deploy/nginx-chat.conf` | 59 | `61a6fb0f026c83d0` | `img-src` 加 `blob:`（1 行，:53） |
| `backend/deploy/nginx-chat-https.conf` | 158 | `6f8859a636a37256` | `img-src` 加 `blob:`（1 行，:150） |
| `backend/openapi.json` | 13127 | `e839dc101885313c` | 重新生成（+3 路径、Message.attachment、type 枚举扩） |
| `contracts/requirements/rest-requirements.json` | — | — | 3 端点 U4/U5/U6、`Attachment`/`Upload` definitions、Message.attachment、M2 body 放宽 |
| `contracts/requirements/errors.json` | — | — | +6 码（35 条），`notes` 补 413/415 可达性说明 |
| `contracts/requirements/ws-requirements.json` | — | — | `message.created` 的 note/diff/前端反应文本（**结构未变**） |
| `docs/03-ws-protocol.md` | 515 | — | 新增 §4.5「附件消息」+ §4.2 表格备注 |
| `docs/09-contract-changelog.md` | — | — | 新增 `v0.2.0+uploads` 节 + 版本总览表一行 |

**未改**：`backend/package.json`（dependencies/devDependencies 均未动）、`backend/test/deploy-headers.test.ts`（漂移检测保持原严格度）、`frontend/`、`management/`。

---

## 1. 接口表（最终形态，与 `backend/openapi.json` 逐字一致）

| # | 方法 | 路径 | 鉴权 | 成功 | 请求 | 响应体 |
| --- | --- | --- | --- | --- | --- | --- |
| U4 | POST | `/api/v1/uploads?filename=` | Bearer | **201** | 裸二进制 body（**无 multipart**），`Content-Type` 任意且被忽略；`filename` 可选、仅展示用 | `Upload` JSON |
| U5 | GET | `/api/v1/uploads/{id}` | Bearer（**仅属主**） | **200** | 无 | 原始字节（**openapi 无 200 JSON schema**，见 §7 偏差 2） |
| U6 | DELETE | `/api/v1/uploads/{id}` | Bearer（**仅属主**） | **204** | 无 | 空 |

### 1.1 `Upload`（201 响应，openapi required 顺序）

```
{ id: uuid, name: string, mimeType: string, size: integer(min 1),
  sha256: string(hex), kind: 'image'|'file', url: '/api/v1/uploads/<id>', createdAt: date-time }
```

`sha256` **只在这一个响应里出现一次**（后续 GET 字节由调用方自行校验）。

### 1.2 `Attachment`（消息内嵌视图，刻意裁剪）

```
{ id, name, mimeType, size, kind, url, createdAt }
```

**不含** `sha256`（避免前端拿上传响应外的摘要做误判）、**不含** `ownerId`（隐私，前端无用）。

### 1.3 发消息 body（M2，`POST /api/v1/conversations/{conversationId}/messages`）

```
{ clientMsgId: uuid(必填),
  type?: 'text'(仅向后兼容),
  content?: string(1..4000, pattern \S),
  attachmentId?: uuid }
```

- **无 `attachmentId`** → `content` 必填非空，`type` 为 `text`（传 `type:'text'` 仍接受；不传也走 DEFAULT）。
- **有 `attachmentId`** → `content` 可省略或空串；`type` 由服务端按 `upload.kind` 推导（`image`→`image`，其他→`file`），客户端传的 `type` 被忽略而不报错；附件必须存在（否则 400 `INVALID_ATTACHMENT`）、属主是发送者（否则 400 `INVALID_ATTACHMENT`）、且未被别的消息占用（否则 409 `UPLOAD_IN_USE`）。
- **两者都不给** → 400 `VALIDATION_ERROR`（复用既有码，不新造）。
- 幂等：同一 `clientMsgId` 重试返回 200 与同一 `msgId`；若附件/code 与首次不同则 409 `IDEMPOTENCY_CONFLICT`。

### 1.4 `Message` 变更（所有返回消息的地方同步生效）

- `type` 枚举由 `['text','system']` → `['text','system','image','file']`
- 新增 `attachment: Attachment | null` —— **恒存在的可空字段**（不是 optional）。纯文本与 `system` 消息为 `null`。
- 覆盖：会话列表 `lastMessage`、会话详情、历史分页 `items[]`、`sync` 的 `items[].messages[]`、发消息 200/201、WS `message.created.data.message`。

### 1.5 实测样例（端到端真实响应）

```json
// POST /api/v1/uploads?filename=%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026.png → 201
{"id":"861ca958-4932-4887-a100-bad57de06e0e","name":"屏幕截图 2026.png","mimeType":"image/png",
 "size":70,"sha256":"c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
 "kind":"image","url":"/api/v1/uploads/861ca958-4932-4887-a100-bad57de06e0e",
 "createdAt":"2026-10-22T07:46:07.305Z"}

// POST .../messages {clientMsgId, attachmentId} → 201
{"msgId":"e2072529-...","seq":1,"type":"image","content":"",
 "attachment":{"id":"861ca958-...","name":"屏幕截图 2026.png","mimeType":"image/png","size":70,
               "kind":"image","url":"/api/v1/uploads/861ca958-...","createdAt":"..."}}
```

---

## 2. 魔数白名单（`backend/src/upload.ts:42-71`）

`Content-Type` 头**完全不参与判定**，只嗅探前若干字节。判定顺序即下表顺序，先命中先返回；全部未命中后再试纯文本。

| mimeType | 判定 | 扩展名 | kind |
| --- | --- | --- | --- |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` | `.png` | image |
| `image/jpeg` | `FF D8 FF` | `.jpg` | image |
| `image/webp` | `RIFF....WEBP` | `.webp` | image |
| `image/gif` | `GIF8` | `.gif` | image |
| `application/pdf` | `%PDF-` | `.pdf` | file |
| `application/zip` | `50 4B 03 04` | `.zip` | file |
| `text/plain` | 无 NUL 字节 **且** 能以 `TextDecoder('utf-8',{fatal:true})` 严格解码 | `.txt` | file |

**刻意不收录**：可执行文件（MZ/ELF）、脚本、HTML、SVG。理由：这些类型一旦进入白名单，上传接口就变成 XSS/挂马分发通道；SVG 尤其危险（内嵌脚本 + 可被 `inline` 渲染）。

`kind` 由 `kindFor(mimeType)` 判定：`mimeType.startsWith('image/')` → `image`，否则 `file`。它同时决定消息 `type` 与下载时的 `Content-Disposition`（`image` → `inline`，其他 → `attachment`）。

---

## 3. 限制与错误码

### 3.1 硬限制

| 项 | 值 | 实现位置 |
| --- | --- | --- |
| 业务上限 | **10 MiB = 10485760 字节** | `MAX_UPLOAD_BYTES`（`upload.ts:18`） |
| 传输层上限 | **11 MiB = 11534336 字节** | `UPLOAD_BODY_LIMIT`（`upload.ts:27`），同时用于 `addContentTypeParser('*', {bodyLimit})` 与路由 `bodyLimit` |
| 全局 JSON bodyLimit | **32 KiB 保持不变** | `app.ts:121` —— 上传不能放大其它端点的 JSON 契约 |
| 上传速率限制 | **30 次/分钟**（按 userId 或 IP） | `routes.ts` POST uploads 的 `config.rateLimit` |
| 文件名长度 | `filename` maxLength 255；落库名截断 120 字符 | `schemas.ts` / `sanitizeFilename` |
| 磁盘文件名 | `<uuid><按 mime 推导的扩展名>` | 客户端文件名不参与路径拼接 |

10 MiB 与 11 MiB 之间留 1 MiB 余量的理由：传输层要在业务层看到字节前就拒绝超大 body（`FST_ERR_CTP_BODY_TOO_LARGE` 在解析阶段抛出，早于 handler），两者都映射到同一个对外的 `UPLOAD_TOO_LARGE`。

### 3.2 上传相关错误码（`contracts/requirements/errors.json`，全部实测命中）

| HTTP | code | 触发条件 | 实测 |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | body 为空 / content 与 attachmentId 都不给 / 参数格式不合法 | ✅ |
| 400 | `INVALID_ATTACHMENT` | `attachmentId` 不存在，或不属于发送者 | ✅ |
| 401 | `UNAUTHORIZED` | 缺 Bearer 或 token 失效 | ✅ |
| 403 | `FORBIDDEN` | 已认证但读/删他人上传物 | ✅ |
| 404 | `UPLOAD_NOT_FOUND` | 上传物不存在 / 已删除 / 磁盘文件缺失 | ✅ |
| 409 | `UPLOAD_IN_USE` | 已被消息引用：删除被拒，或复用为第二发送被拒 | ✅ |
| 413 | `UPLOAD_TOO_LARGE` | >10 MiB（业务层）或 >11 MiB（解析层） | ✅ 两档都测 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 魔数不在白名单（实测用 `MZ\x90\x00...`） | ✅ |

**413/415 的映射位置**（`app.ts:146-147`）：这两种错误由 fastify 解析层直接抛出，**不会**走到 `ApiError`，所以必须在 `setErrorHandler` 里按 `statusCode` 补映射，否则会退化成 `BAD_REQUEST`。除上传端点外的 413 仅表示「JSON body 超 32 KiB」，含义在 `errors.json` 的 `notes` 里明确。

所有错误体统一为 `{error:{code,message,traceId}}`，415 也带 `traceId`（实测断言）。

---

## 4. 存储、原子写与 schema 迁移

### 4.1 落盘

- 目录：`UPLOADS_DIR`（未配 → `<DATABASE_PATH 所在目录>/uploads`；`:memory:` → `.data/uploads`）。`config.ts:118-123`
- 启动即校验：`ensureUploadsDir()` 建目录并写一个 `.write-probe-<pid>-<ts>` 再删，**失败直接让进程启动失败**（`uploads directory is not writable: <dir> (<detail>)`）。理由：宁可启动时炸，也不要第一个用户上传时才 500。
- 原子写顺序（`upload.ts:134-160`）：`open(<id>.ext.tmp, 0o600)` → 64 KiB 分块 `writeSync`（边写边 `hash.update`）→ `fsync` → `close` → `rename` 到最终名。任何异常在 `catch` 里 `unlink` 临时文件后重新抛出。
- 删除：先删库行再删磁盘文件（`deleteUpload`）。理由：库行是可见性来源，先删库能保证「用户看到已删除」；磁盘残留由 sweep 兜底，反过来则会出现「库里有行但取字节 404」。

### 4.2 schema 迁移

`PRAGMA user_version` 由 **1 → 2**（`db.ts:9` `SCHEMA_VERSION = 2`）。

- 新建库：`CREATE TABLE` 里已含 `attachment_id` 与四值 CHECK，`migrate()` 读到 `user_version=0 < 2` 直接推进版本号（不重建）。
- 老库（v1）：SQLite **无法原地修改 CHECK 约束**，因此 `upgradeMessagesTable()` 走表重建：
  1. 读 `sqlite_master` 里 messages 的真实 DDL；若已含 `'image'` 则跳过（幂等）。
  2. `CREATE TABLE messages_upgrade(...)` → `INSERT INTO messages_upgrade(...) SELECT ..., NULL FROM messages`（旧行 attachment_id 一律 NULL）→ `DROP TABLE messages` → `RENAME` → 重建 `messages_conversation` 索引。
  3. 整个过程包在 `BEGIN IMMEDIATE` 事务里，失败回滚。
- 判定依据是**真实 DDL 而非 user_version 数值**，所以「版本号被外部改回 1 但表已是新版」也不会重复重建。

迁移测试 `backend/test/uploads.test.ts:256`：手工把库降级成 v1 形态（去掉 attachment_id、CHECK 只 text/system、`user_version=1`），重启后断言 `user_version=2`、DDL 含 `'image'` 与 `attachment_id`、旧消息仍在、可写附件消息；**第三次重启验证幂等**。

### 4.3 保留策略（BE-01 扩展）

`RETENTION_MESSAGE_DAYS > 0` 时，`realtime.sweep()` 在删除过期消息之后追加一段：删「`created_at <= cutoff` **且** 没有任何 messages 引用」的 uploads 行，并同步删磁盘文件；计数进入 `SweepReport.uploads`，日志条件与启动 sweep 一并生效。

顺序有语义：**必须先删 messages 再判 uploads**，否则刚被删消息释放出来的附件在同一轮里判不出是孤儿，要等下一轮。

---

## 5. CSP 改动（四处一致）

`img-src 'self' data:` → **`img-src 'self' data: blob:`**，四处逐字同步：

| # | 位置 | 说明 |
| --- | --- | --- |
| 1 | `backend/src/app.ts:41` | `CONTENT_SECURITY_POLICY`（业务响应头） |
| 2 | `backend/src/app.ts:57` | `DOCS_CONTENT_SECURITY_POLICY`（`/docs` 放宽 inline 的那个） |
| 3 | `backend/deploy/nginx-chat.conf:53` | 生产 HTTP 由 nginx 提供 HTML，**不是冗余** |
| 4 | `backend/deploy/nginx-chat-https.conf:150` | 同上（HTTPS） |

**理由**：`GET /api/v1/uploads/{id}` 需要 Bearer，`<img src>` 不会带 `Authorization` 头，所以正确渲染路径只能是 `fetch(带 Authorization) → blob → URL.createObjectURL → <img src=blob:...>`，而 `blob:` 不在原 CSP 白名单里会被浏览器拦掉。

配套改动：`backend/test/security.test.ts:187` 的硬编码期望字面量同步；`backend/test/deploy-headers.test.ts` 的**逐字漂移检测未改动**（不放宽），自动验证这 4 处仍然一致 —— 3 条用例全绿。

`Permissions-Policy`、HSTS、其余 CSP 指令均未变（`camera=()` 等仍禁用，上传走 `<input type=file>`，不需要 camera 权限）。

---

## 6. 测试清单与实跑输出

### 6.1 新增测试（`backend/test/uploads.test.ts`，6 条 / 371 行）

| # | 测试 | 覆盖点 |
| --- | --- | --- |
| 1 | 上传：魔数嗅探、sha256、下载字节与安全响应头 | 真 PNG 201、7 字段、落盘 `<id>.png`、磁盘字节、GET 字节 sha256 一致 + 7 个响应头、越权 403、匿名 401、不存在 404、PDF→kind file + `attachment` disposition |
| 2 | 上传：Content-Type 被忽略、纯文本与超限/不支持类型的错误码 | 带 `application/json` 头传 PNG 仍 201；纯文本→`text/plain`；空 body→400；MZ 魔数→415+traceId；`10 MiB+1`→413；`11 MiB+1`→413；缺 token→401；`../../etc/passwd.png`→`passwd.png`；省略 filename→`未命名文件` |
| 3 | 附件消息：type 由服务端推导、历史与 sync 可见、不可复用、缺内容报错 | 只给 attachmentId→201/type image/content ''；`Object.keys(attachment)` 恰为 7 字段（无 ownerId/sha256）；幂等 200；复用 409；历史与 sync 均带 attachment；老客户端带 `type:'text'`→201 attachment null；省略 type→text；两者都不给→400；空白 content→400；他人/不存在附件→400 INVALID_ATTACHMENT；被引用 DELETE→409；未引用 DELETE→204 且 GET 转 404、再 DELETE 404；他人 DELETE→403 |
| 4 | 迁移：user_version 1 → 2 重建 messages 表且不丢数据 | §4.2，含三次重启的幂等验证 |
| 5 | 保留策略：sweep 只清理「无消息引用且已过期」的孤儿上传 | 两个上传一个附着、都做旧 3 天 → `report.uploads===1`；孤儿文件与库行消失、被引用文件仍在且仍可 GET |
| 6 | 回归：全局 JSON bodyLimit 仍是 32KiB，未因上传被放大 | 向 `/api/v1/sync` 发 40 KiB JSON → 413 |

### 6.2 实跑输出（原文）

```
$ cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run check
> webchat-backend@0.2.0 check
> tsc --noEmit
exit=0            # 无任何输出
```

```
$ cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js test
✔ authentication, validation, profile, session renewal and revocation
✔ both health routes expose the same numeric protocol version and UTC clock
✔ friendship consent, search escaping and group authorization
✔ message idempotency, per-conversation sequence, cursors and unread count
✔ sync chunks and authorization are explicit and lossless
✔ CORS, uniform errors, rate limiting and OpenAPI
✔ registration creates reciprocal default friendship and notifies the online default account
✔ disabled default friendship preserves the normal friend request flow
✔ missing default account fails closed and registration failure rolls back automatic friendship
✔ proxy-aware login limiting trusts loopback only and is disabled by default
✔ real sockets deliver messages, presence, typing, read receipts and enforce ticket/session rules
✔ SQLite survives process-equivalent restart with sessions and messages
✔ WebSocket limits remain 1008, binary is 1003 and outbound session expiry is 4003
✔ group system events and read state reach all devices without leaking after removal
✔ removed groups cannot enter a sync batch, distinct chats maintain independent sequence
✔ SEC-04 文档级 CSP 与后端常量逐字一致（两个 nginx 配置）
✔ SEC-04 HSTS 只在 HTTPS 配置下发，且与后端常量一致
✔ SEC-04 Permissions-Policy 与后端常量逐字一致（两个 nginx 配置）
✔ SEC-01 TLS configuration is all-or-nothing and fails closed
✔ SEC-01 HTTPS mode terminates TLS in-process and keeps health/API/headers intact
✔ SEC-01 plaintext credential guard is fail-closed and proxy-aware
✔ SEC-04 security headers are present, stable and do not break /docs or /openapi.json
✔ BE-01 retention sweep removes only expired rows, is observable and runs at startup
✔ BE-01 message retention is opt-in (default keeps rows) and deletes only aged rows
✔ startup sweep happens inside buildApp so restarts converge expired state
✔ rate limits stay at 10/min/IP with Retry-After and default friend failure keeps 503
✔ 上传：魔数嗅探、sha256、下载字节与安全响应头
✔ 上传：Content-Type 被忽略、纯文本与超限/不支持类型的错误码
✔ 附件消息：type 由服务端推导、历史与 sync 可见、不可复用、缺内容报错
✔ 迁移：user_version 1 → 2 重建 messages 表且不丢数据
✔ 保留策略：sweep 只清理「无消息引用且已过期」的孤儿上传
✔ 回归：全局 JSON bodyLimit 仍是 32KiB，未因上传被放大
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4127.7274
```

原 26 条**全部保留且未改语义**（15 chat + 8 security + 3 deploy-headers），新增 6 条 = 32 条。

```
$ cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run docs
> webchat-backend@0.2.0 docs
> npm run build && node dist/scripts/openapi.js
Generated openapi.json
```

`openapi.json` 重跑幂等（`diff` 为空）。生成结果确认：`/api/v1/uploads`（post，`filename` required:false maxLength 255、**无 requestBody**）、`/api/v1/uploads/{id}`（get/delete，get **无 200 条目**）；Message 的 `type` 为四值 anyOf、properties 含 `attachment`。

```
$ cd /b/AITrance && node scripts/check-contract.mjs
=== 契约比对结果 ===
openapi 版本：0.2.0
openapi 路径数：24；需求书声明：29
字段检查 546 项；枚举检查 51 项；请求体检查 12 端点
ERROR 0 / WARN 0

✅ 无差异：需求书与 backend/openapi.json 完全一致
报告已写入 .\docs\contract\check-result.md
```

门禁有效性未被本次改动削弱（`--self-test` 仍命中 structure / response / enum / body 四类注入缺陷）。

---

## 7. 端到端实跑记录（真实 HTTP，127.0.0.1:3097）

启动方式（隔离实例，DATABASE_PATH 与 UPLOADS_DIR 都指向系统 temp）：

```bash
cd /b/AITrance/backend && PORT=3097 \
  DATABASE_PATH='C:\Users\31626\AppData\Local\Temp\uxb-e2e\chat.sqlite' \
  UPLOADS_DIR='C:\Users\31626\AppData\Local\Temp\uxb-e2e\uploads' \
  node --experimental-strip-types src/server.ts
```

驱动脚本是一次性 `node:http` 客户端（不入库），用真实 1×1 PNG 字节：

```
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
```

**完整输出 43/43 PASS**：

```
=== 启动隔离后端 ===
server health: {"status":"ok","version":"0.2.0","protocolVersion":1,"serverTime":"2026-10-22T07:46:07.189Z"}
PASS  隔离后端启动并 /api/v1/health 200
PASS  两个账号建好友并开私聊 :: status=200 conversationId=a437f896-a10c-4ef2-acfc-7fc6f7074de0
PASS  POST /api/v1/uploads 返回 201 :: status=201 body={"id":"861ca958-4932-4887-a100-bad57de06e0e",...}
PASS  mimeType 由魔数嗅探为 image/png :: mimeType=image/png
PASS  kind=image :: kind=image
PASS  size 等于字节数 :: size=70 expect=70
PASS  sha256 等于本地摘要 :: server=c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77 local=c414cd0e...
PASS  中文文件名经 URL 编码后保留 :: name=屏幕截图 2026.png
PASS  url 为相对路径 /api/v1/uploads/<id> :: url=/api/v1/uploads/861ca958-4932-4887-a100-bad57de06e0e
PASS  文件落盘为 <id>.png :: C:\Users\31626\AppData\Local\Temp\uxb-e2e\uploads\861ca958-....png
PASS  磁盘字节与上传字节一致
PASS  带 attachmentId 发消息返回 201 :: status=201 {"msgId":"e2072529-...","seq":1,"type":"image","content":"",...}
PASS  消息 type 由服务端推导为 image :: type=image
PASS  消息 attachment 非空且字段齐全 :: {"id":"861ca958-...","name":"屏幕截图 2026.png","mimeType":"image/png","size":70,"kind":"image","url":"/api/v1/uploads/861ca958-...","createdAt":"..."}
PASS  attachment 不泄露 ownerId / sha256
PASS  GET 历史（对端视角）能看到该消息且 attachment 非空 :: items=1
PASS  历史里的 attachment 与发送返回一致 :: id=861ca958-...
PASS  GET /api/v1/uploads/:id 返回 200 :: status=200
PASS  下载字节 sha256 与上传一致 :: download=c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77
PASS  Content-Type 为嗅探值 :: image/png
PASS  Content-Length 正确 :: 70
PASS  X-Content-Type-Options: nosniff
PASS  CSP 为 default-src 'none'; sandbox :: default-src 'none'; sandbox
PASS  Referrer-Policy: no-referrer
PASS  Cache-Control immutable :: private, max-age=31536000, immutable
PASS  图片 Content-Disposition 为 inline 且带 UTF-8 文件名 :: inline; filename*=UTF-8''%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026.png
PASS  越权读他人附件 → 403 FORBIDDEN :: status=403 code=FORBIDDEN
PASS  越权删他人附件 → 403 FORBIDDEN :: status=403
PASS  无 Bearer 下载 → 401 UNAUTHORIZED :: status=401 code=UNAUTHORIZED
PASS  无 Bearer 上传 → 401 UNAUTHORIZED :: status=401
PASS  非白名单魔数 → 415 UNSUPPORTED_MEDIA_TYPE :: status=415 code=UNSUPPORTED_MEDIA_TYPE
PASS  415 也带 traceId
PASS  超过 10 MiB → 413 UPLOAD_TOO_LARGE :: status=413 code=UPLOAD_TOO_LARGE
PASS  超过传输层 11 MiB → 同样 413 :: status=413 code=UPLOAD_TOO_LARGE
PASS  同一附件复用 → 409 UPLOAD_IN_USE :: status=409 code=UPLOAD_IN_USE
PASS  删除已附着附件 → 409 UPLOAD_IN_USE :: status=409
PASS  content 与 attachmentId 都不给 → 400 VALIDATION_ERROR :: status=400 code=VALIDATION_ERROR
PASS  用他人附件发消息 → 400 INVALID_ATTACHMENT :: status=400 code=INVALID_ATTACHMENT
PASS  纯文本上传 → 201 text/plain kind=file :: mime=text/plain kind=file
PASS  删除未附着附件 → 204 无正文 :: status=204 len=0
PASS  删除后再取 → 404 UPLOAD_NOT_FOUND :: status=404 code=UPLOAD_NOT_FOUND
PASS  全局 JSON bodyLimit 仍是 32 KiB（/sync 40 KiB → 413） :: status=413
PASS  业务响应 CSP 的 img-src 含 blob: :: img-src 'self' data: blob:

=== 汇总：43/43 PASS ===
```

> 注：以上为脚本 `uxb_e2e.mjs` 的原始输出（保存于 `C:\Users\31626\AppData\Local\Temp\uxb_e2e.log`，47 行）。「同一附件复用」那一行在粘贴时曾漏改，最终脚本实跑的 = `status=409 code=UPLOAD_IN_USE`；单元测试 #3 同样断言 409 `UPLOAD_IN_USE`，双路印证。

要点说明：

- **sha256 三处一致**：本地计算、服务端 201 响应、下载回来的字节，均为 `c414cd0e…ce77`。
- **四个指定反例全部命中**：越权（读+删，403）、超限（业务 10 MiB 与传输 11 MiB 两档，均 413 且码为 `UPLOAD_TOO_LARGE`）、错类型（MZ 魔数，415 且带 traceId）、缺 token（下载+上传，401）。
- **没有放大全局 JSON 上限**：`/api/v1/sync` 发 40 KiB 仍 413，证明 11 MiB 只作用于上传作用域。
- **CSP 生效**：普通业务响应头的 `img-src` 已含 `blob:`。

---

### 7.1 Lead 独立复核（另一条证据链，未复用我的脚本）

Lead 于 2026-10-22 15:2x 用**真实 HTTP** 打 `127.0.0.1:3099` 隔离后端（与我的 3097 独立实例、独立库），逐项结果：

| 项 | 结果 |
| --- | --- |
| 无 token 访问上传/下载 | **401** |
| 70 字节 PNG 上传 | **201**，返回完整体 `{id,name,mimeType,size,sha256,kind,url,createdAt}` |
| GET 下载 | sha 一致、`Content-Type: image/png`、带 `default-src 'none'; sandbox` 与 `immutable` 缓存头 |
| 匿名 GET | **401** |
| MZ 魔数上传 | **415** |
| `10 MiB + 1` | **413** |
| 不存在的 UUID | **404** |
| 非 UUID 参数 | **400** |
| 纯文本上传 | **201**，`kind: "file"` |
| 后端构建 | `exit 0` |
| `node --test dist/test/*.test.js` | **tests 32 / pass 32 / fail 0** |
| `scripts/check-contract.mjs` | 路径 24 / 字段 546 / 枚举 51 / **ERROR 0 / WARN 0** |
| CSP 四处 | `app.ts:41`、`app.ts:57`、两个 nginx conf 均已是 `img-src 'self' data: blob:` |

结论：两条独立证据链（我的 3097 端到端脚本 43/43 + Lead 的 3099 手工复核）结论一致，无冲突。

---

## 8. 关键实现决策与偏差（与 Lead 原规格的对照）

规格由 Lead 固定，未改协议形状；以下是任务书明确留了口子、或需要二选一的地方的实际选择：

| # | 点 | 选择 | 理由 |
| --- | --- | --- | --- |
| 1 | 非属主 GET 返回 403 还是 404（任务书允许二选一） | **403 `FORBIDDEN`** | UUIDv4 不可枚举，掩码收益接近 0；403 让前端能区分「无权限」与「已删除」（后者是 404 `UPLOAD_NOT_FOUND`），排障更快 |
| 2 | `content` 与 `attachmentId` 都不给 | 400 **`VALIDATION_ERROR`**（复用既有码） | 不新造错误码，前端已有一套 400 处理逻辑 |
| 3 | `attachmentId` 非法（不存在/非本人） | 400 **`INVALID_ATTACHMENT`**（新码） | 与「参数格式错」区分开：这是业务语义错，不是 schema 校验错（schema 只校验是 uuid） |
| 4 | 复用已被占用的附件 | 409 **`UPLOAD_IN_USE`** | 与删除时的冲突码统一，前端只需处理一个码 |
| 5 | `Attachment` 是否带 `sha256`/`ownerId` | **都不带** | sha256 只在上传 201 出现一次即可；ownerId 属隐私且前端无用途 |
| 6 | GET 的 200 是否在 openapi 声明 | **不声明** | 响应是原始字节，声明 `application/json` 会让 fastify 的 serializer 介入并污染响应。代价：openapi 里该端点无 200 条目（见 §9） |
| 7 | 发消息 body 的 `type` | **保留可选 `type: 'text'`** | 既有 26 条测试与灰度期老前端都会带 `type:'text'`；`additionalProperties:false` 下删除该字段会让它们直接 400。有 `attachmentId` 时忽略客户端 `type` |
| 8 | 上传 endpoint 的 body 解析 | `removeAllContentTypeParsers()` + `addContentTypeParser('*', {parseAs:'buffer'})` **挂在独立插件作用域** | 插件实例有独立的 content-type parser 副本，通配 parser 与 11 MiB 上限都**不会**污染全局 32 KiB（已用 `/sync` 40 KiB 回归测试证明） |
| 9 | CSV 等「无魔数」类型 | 纯文本白名单只放行无 NUL 且严格 UTF-8 可解码内容（`text/plain`） | CSV/MD/JSON 都能上传但会被标成 `text/plain`（不是 `text/csv`），前端按 `kind=file` + 扩展名展示 |
| 10 | 二进制流式 | 全量 buffer 在内存（≤11 MiB） | 无 multipart 依赖、无临时流管理；11 MiB 上限下内存压力可控。见 §9 |

---

## 9. 残余风险与未覆盖项（如实标注）

| 级别 | 项 | 说明 |
| --- | --- | --- |
| **中** | **他人附件无法渲染** | `GET /api/v1/uploads/:id` 仅属主可读，因此 A 发的图片 B 只能看到文件名与大小，看不到图（403）。这是本轮「不做跨用户授权判定」的取舍，已写进 `docs/03-ws-protocol.md` §4.5「已知限制」并告知前端 agent 降级方案（文件名占位）。若产品要求对端可见，下一轮需引入「会话成员可读引用附件」的判定。 |
| **中** | 上传后未发消息 = 孤儿永久占盘 | 只有在 `RETENTION_MESSAGE_DAYS > 0` 时 sweep 才回收。该配置默认 **0（关闭）**，因此默认部署下未附着上传会永久存在。已有 `DELETE /api/v1/uploads/:id` 供前端主动回收（失败重试路径必须调用它，已写入契约的 frontendContract）。**建议**：生产开启保留策略，或增加定时清理未附着上传的独立策略。 |
| **低** | 全量 buffer 在内存 | 单请求峰值约 11 MiB × 并发数。30 次/分钟/IP/userId 的限流 + 单机部署下可接受；若将来放开上传大小或高并发，需要改流式落盘（`pipeline` 到 `.tmp`）。 |
| **低** | `text/plain` 判定会拒绝合法二进制伪装 | 若某合法类型既无魔数也含 NUL，会被 415。当前白名单覆盖常见图片/文档，风险有限；新增类型需改 `SIGNATURES` 并同步文档与测试。 |
| **低** | openapi 无 `GET /uploads/{id}` 的 200 条目 | 见 §8 决策 6。契约门禁对「需求书声明而 openapi 没有」的响应码只出 WARN，本轮已把该端点的需求书 `success`/`response` 都设为 `None`，故 ERROR 0 / WARN 0。代价是 openapi 的该端点只有错误响应，工具链无法自动发现 200。 |
| **低** | CSV / Markdown 等被标为 `text/plain` | 浏览器按 `Content-Disposition` 下载没问题，只影响「类型精确展示」。若前端想显示 `text/csv`，需要客户端自行按扩展名映射。 |
| **未验** | 真实浏览器里的 `blob:` 渲染 | 本任务只验证了 HTTP 层与 CSP 头内容。前端 `AttachmentView.vue` 的 blob 渲染与 `blob:` 是否被 CSP 放行，由前端门禁覆盖（`vitest` 172 tests 全绿 + `management/browser-check.mjs`）；**本证据不声称已验证**。 |
| **未验** | nginx 生产配置的 CSP 生效 | 本机无 nginx 可执行文件，只做了静态逐字比对（`deploy-headers.test.ts` 3 条全绿），**未**在生产环境实测响应头。 |
| **未验** | 老客户端的兼容性 | 通过保留可选 `type:'text'` + content 可变实现了向后兼容，单元测试覆盖了「老客户端带 type」路径；但**未**用真实旧版前端跑过。 |
| **BLOCK** | 生产磁盘配额与上传目录独立卷 | **未部署、未配置**。上传文件与 SQLite 同卷时，写满会同时打挂数据库与上传。建议生产把 `UPLOADS_DIR` 指到独立卷并配配额（`XFS project quota` / 独立挂载点），必要时加 `nginx client_max_body_size 12m`（当前只有 11 MiB 应用层上限，反代若不配会先在 nginx 层 413 且错误体不是本契约形状）。本轮无部署权限，未做。 |
| **BLOCK** | 对象存储 / 多实例共享 | **未做**。当前实现是**单机本地盘**：多实例部署时 A 传的文件 B 实例读不到（`readUpload` 会 404）。若一旦水平扩容，必须改 S3/OSS 或共享卷，且 `uploads` 表的 `url` 语义要跟着变。本轮明确不在范围。 |
| **已知限制** | 视频与超大文件不支持 | 单文件硬上限 10 MiB（传输层 11 MiB）。视频（即便 10 秒的手机片段）通常远超此值，**本轮不支持**；「文件」类型实际只覆盖小文档/压缩包。放开需要：流式落盘、分片上传、断点续传、病毒扫描，均未做。 |

---

## 10. 复现命令汇总

```bash
# 类型检查
cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run check

# 全量测试（build + node --test）
cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js test

# 重新生成 openapi.json（cwd 必须是 backend/）
cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run docs

# 契约门禁（cwd 必须是仓库根）
cd /b/AITrance && node scripts/check-contract.mjs
cd /b/AITrance && node scripts/check-contract.mjs --self-test   # 验证门禁本身仍有效
```
