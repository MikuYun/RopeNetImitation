# AITrance Chat 后端

可独立运行的网页聊天平台后端。负责账号、好友申请、私聊/群聊、消息持久化（多附件/撤回/引用回复）、
未读/已读、置顶、实时在线与输入状态、广场动态、访客资料与管理后台；不包含前端页面。

## 环境与启动

- Node.js **24+**、npm；使用内置 `node:sqlite`，无需另装数据库或原生编译链。
- 在 **backend 目录**运行命令；数据库与 `.env` 路径以工作目录为准。

```powershell
cd B:\AITrance\backend
npm ci
Copy-Item .env.example .env
npm run dev
```

默认监听 `http://127.0.0.1:3001`，默认仅允许 `http://localhost:5173` 和 `http://127.0.0.1:5173` 的浏览器请求。
其他前端地址必须加入 `CORS_ORIGINS`（逗号分隔、精确 origin，不允许 `*`）。

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/v1/health
```

- 中文对接说明：[API.md](API.md)（525 行，v0.3.0 完整手册）
- 跨网络 HTTP 试用部署：[deploy/HTTP.md](deploy/HTTP.md)（需要公网服务器，不加密传输）
- v2 发布说明（破坏性变更、迁移、清库）：[`../docs/v2/RELEASE-NOTES.md`](../docs/v2/RELEASE-NOTES.md)
- 交互接口调试：`http://127.0.0.1:3001/docs`
- OpenAPI JSON：`http://127.0.0.1:3001/openapi.json` 或本目录 `openapi.json`

```powershell
npm test        # tsc 构建 + node --test（55 个用例 / 7 个文件）
npm run docs    # 重新生成 openapi.json（改接口后必须跑）
npm run build
npm start
```

`npm run docs` 根据实际路由 schema 生成 OpenAPI，不使用手写复制版。

### 三个不同的版本号（不可混用）

| 编号 | 值 | 含义 |
|---|---|---|
| `version` | `0.3.0` | 后端实现版本（字符串），随实现迭代 |
| `protocolVersion` | `2` | 业务协议版本（数字），只在协议不兼容时 bump；出现在 `/health` 与 WS `ready.data` |
| WS 信封 `v` | `1` | 传输信封版本，握手 `?v=1` 与帧 `{v:1,...}`，**未变** |

前端对应常量：`WS_ENVELOPE_VERSION = 1`、`WS_PROTOCOL_VERSION = 2`（`frontend/src/ws/constants.ts`）。
版本不匹配时前端停止重连并提示刷新 —— 所以**前后端必须同版上线**。

`/health` 与 `/api/v1/health` 均返回 `{status,version:'0.3.0',protocolVersion:2,serverTime}`。
会话过期/注销使用关闭码 `4003`，超连接/超帧频使用 `1008`，不支持的二进制帧使用 `1003`。

## 实现范围

- 注册、登录（用户名或纯数字 `uid`）、当前会话校验、同 token 滑动续期、注销；密码随机盐 `scrypt`，库内只存 token 的 SHA-256 摘要。
- 用户资料、用户搜索、双向好友申请（同意/拒绝）、好友列表；**访客资料页**（`GET /users/:userId`，返回 `relationship` 五态）。
- 唯一好友私聊、最多 100 人群聊、群名/群头像修改、**群主与管理员**邀请/移除、成员退群、消息置顶。
- 文本、图片、视频、普通文件与 `mixed` 消息；**单条消息 0~9 个附件（视频至多 1 个）**，`msgId` 为 UUID，`seq` 按会话递增，`clientMsgId` 实现幂等。
- **撤回**（仅作者、120 秒内，附件一并释放）、**引用回复**（`replyTo` 快照，被引消息撤回后降级为「[消息已撤回]」）。
- 历史游标分页、批量断线补偿、权威未读数、单调已读游标、多连接同步。
- 一次性 30 秒 WebSocket ticket、在线状态、输入状态、应用 ping/pong、传输层心跳。
- **广场**：发帖（图片 ≤9 / 视频 ≤1 / 文字 ≤5000）、点赞、评论、软删除。
- **管理后台**：用户搜索、禁言、封禁、删除账号（连同消息/广场内容/会话关系）、统计。
- JSON 参数校验（`additionalProperties:false`）、角色权限矩阵、精确 CORS、限流、结构化错误、日志敏感信息过滤。

不包含音视频通话、支付、好友删除/拉黑、群主转让、忘记密码、端到端加密或多实例部署。
群成员加入后能查看群全部历史；入群前历史不计入新增未读。群主不能退群。

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `HOST` | `127.0.0.1` | 开发默认仅本机可访问 |
| `PORT` | `3001` | HTTP/WS 共用端口 |
| `DATABASE_PATH` | `.data/chat.sqlite` | SQLite 文件位置 |
| `UPLOADS_DIR` | 跟随库目录的 `uploads/` | 附件落盘目录（与库同卷便于整包备份） |
| `CORS_ORIGINS` | 见 `.env.example` | 允许的完整浏览器 origin |
| `SESSION_TTL_DAYS` | `7` | 会话有效天数，范围 1–30 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |
| `TRUST_LOOPBACK_PROXY` | `false` | 仅部署在本机可信反向代理后方时设为 true；只信任 loopback 代理传来的客户端 IP |
| `DEFAULT_FRIEND_USERNAME` | 空（关闭） | 新注册用户自动与该账号成为双向好友；推荐填 `qjq`（下面的预置普通用户），公网部署为 `QJQ` |
| `REQUIRE_HTTPS` | `auto` | `true` 时拒绝明文凭据请求（反代终结 TLS 的部署必须显式设 true） |
| `ADMIN_UID` | `1001` | 系统管理员固定 uid（1000..9999，普通用户从 10001 起） |
| `ADMIN_USERNAME` | `root` | 管理员登录名（小写 3..32 位 `[a-z0-9_]`） |
| `ADMIN_INITIAL_PASSWORD` | `12345678` | **仅首次创建**管理员时使用；已存在则完全不动，改环境变量不会重置线上密码 |
| `SEED_USER_UID` | `10001` | 预置普通用户 uid（10001..999999；被占用时自动顺延到下一个空号） |
| `SEED_USER_USERNAME` | `qjq` | 预置普通用户登录名（小写 3..32 位 `[a-z0-9_]`）；**显式置空即整体关闭该预置账号** |
| `SEED_USER_DISPLAY_NAME` | `柒玖柒` | 预置普通用户昵称（1..40 字符） |
| `SEED_USER_INITIAL_PASSWORD` | `A454545asd@` | **仅首次创建**预置普通用户时使用；已存在则完全不动 |
| `RETENTION_SWEEP_SECONDS` | `30` | 过期数据清理间隔（秒），随心跳运行 |
| `RETENTION_MESSAGE_DAYS` | `0` | 消息保留天数，`0` = 永不删除 |

## 架构与数据

`src/app.ts` 组装服务与 CSP，`routes.ts` 定义校验与 OpenAPI，`service.ts` 管理事务和业务权限，
`realtime.ts` 管理连接与事件，`security.ts` 管理密码/会话，`upload.ts` 管理附件类型与大小，
`bootstrap.ts` 负责管理员初始化，`db.ts` 负责建表与版本化迁移。当前 `SCHEMA_VERSION = 4`。

数据表：`users`、`sessions`、`friend_requests`、`friendships`、`conversations`、
`conversation_members`、`messages`、`message_attachments`、`message_pins`、`uploads`、`ws_tickets`、
`posts`、`post_attachments`、`post_likes`、`post_comments`。启用外键、WAL 与 5 秒 busy timeout，
写操作使用显式事务。初次启动自动建表并引导出两个固定账号（见下），不止一个管理员。

## 初始账号（两个）

全新库首次启动会引导出两个账号，之后**只在账号不存在时创建一次**，已存在则密码与昵称一律不动：

| 角色 | 登录名 | 昵称 | 初始密码 | uid |
| --- | --- | --- | --- | --- |
| 系统管理员 | `root` | 系统管理员 | `12345678`（`ADMIN_INITIAL_PASSWORD`） | 1001 |
| 初始普通用户 | `qjq`（登录输入 `QJQ` 同样有效） | 柒玖柒 | `A454545asd@`（`SEED_USER_INITIAL_PASSWORD`） | 10001 |

`bootstrap.ts` 的 `ensureAdmin()` 与 `ensureSeedUser()` 分别负责这两个账号，两者都在
`registerRoutes` 之前执行 —— 顺序有硬性原因：`DEFAULT_FRIEND_USERNAME` 指向的账号若不存在，
注册接口会 fail-closed 返回 503 `DEFAULT_FRIEND_UNAVAILABLE`，新库首启就会「一个用户都注册不了」。
所以部署时 `DEFAULT_FRIEND_USERNAME` 应当与 `SEED_USER_USERNAME` 指向同一个账号（默认都是 `qjq`）。

当前版本**没有改密码接口**，这两个密码只能在首次启动前通过环境变量决定。

**结构变更必须新增版本化迁移**，不能直接改已有建表语句。

迁移注意：v3→v4 的 `messages` 表重建必须在 `BEGIN IMMEDIATE` **之前**执行 `PRAGMA foreign_keys=OFF`
（事务内的 pragma 是 no-op），旧 `attachment_id` 要在 DROP 之前搬进 `message_attachments`。

SQLite 数据包含聊天正文，不是端到端加密存储；日志不记录请求正文、Authorization 或 ticket 查询参数。
备份时应停服后复制整个 `.data`（库 + `uploads/` 必须一起），或使用 SQLite 一致性备份工具；
运行中不要只复制主库而漏掉 WAL。测试使用独立内存/临时数据库。

## 清库（恢复成干净但可登录的状态）

```powershell
node scripts/reset-db.mjs --confirm --dry-run   # 只打印动作与各表计数（--dry-run 也必须带 --confirm）
node scripts/reset-db.mjs --confirm             # 真正执行
```

清空全部业务数据后重建两个初始账号（`root` / `ADMIN_INITIAL_PASSWORD`，以及 `qjq` / `SEED_USER_INITIAL_PASSWORD`）。
必须显式 `--confirm`，否则只打印用法并 `exit 1` —— `--dry-run` 同样必须带 `--confirm`，
避免「看起来在预览、其实漏了 `--confirm`」被误读成「已经清过了」。纯 `node:` 内置模块，不依赖 `npm ci`；
库路径默认由脚本自身位置推导（相对 `backend/`，不是 cwd）。旧库（`user_version < 4`）会拒绝执行并要求
先启动一次服务端完成迁移 —— 这是设计行为。

## 验证与上线边界

`npm test` 执行 TypeScript 构建和 Node test runner 集成测试（64 用例），覆盖认证与续期、参数校验、
好友授权、群权限与管理员角色、幂等/序号、未读、游标与补偿、真实 WebSocket、票据/会话失效、
CORS/限流、SQLite 重启恢复、schema 迁移（v1/v2 → v4）、多附件消息、撤回、引用回复、广场、访客资料。

这是**单进程 MVP**：在线状态、连接分发、限流存在本进程，不支持多实例共享实时事件。
SQLite 同步 API、offset 列表和逐成员事件适合开发及小规模使用，不构成高并发承诺。

生产部署前至少需要 HTTPS/WSS（SEC-01 至今未关闭，当前公网入口仍是 HTTP 明文）、反向代理与超时配置、
正确的代理/IP 信任策略、账号防滥用、密码找回、监控告警、数据库备份与迁移、容量压测及隐私合规。
`/docs` 默认公开，生产可在反向代理限制访问。不要把开发服务直接暴露到公网。
浏览器只把用户内容当纯文本渲染，切勿使用 `innerHTML`；头像 URL 不由后端抓取。
