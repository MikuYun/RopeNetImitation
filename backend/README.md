# AITrance Chat 后端

可独立运行的网页聊天 MVP。负责账号、好友申请、私聊/群聊、消息持久化、未读/已读、实时在线与输入状态；不包含前端页面。

## 环境与启动

- Node.js **24+**、npm；使用内置 `node:sqlite`，无需另装数据库或原生编译链。
- 在 **backend 目录**运行命令；数据库与 `.env` 路径以工作目录为准。

```powershell
cd B:\AITrance\backend
npm ci
Copy-Item .env.example .env
npm run dev
```

默认监听 `http://127.0.0.1:3001`，默认仅允许 `http://localhost:5173` 和 `http://127.0.0.1:5173` 的浏览器请求。其他前端地址必须加入 `CORS_ORIGINS`（逗号分隔、精确 origin，不允许 `*`）。

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/v1/health
```

- 中文对接说明：[API.md](API.md)
- 跨网络 HTTP 试用部署：[deploy/HTTP.md](deploy/HTTP.md)（需要公网服务器，不加密传输）
- 交互接口调试：`http://127.0.0.1:3001/docs`
- OpenAPI JSON：`http://127.0.0.1:3001/openapi.json` 或本目录 `openapi.json`

```powershell
npm test
npm run docs
npm run build
npm start
```

`npm run docs` 根据实际路由 schema 生成 OpenAPI，不使用手写复制版。修改接口后需要重新生成。接口版本 `0.2.0`，WebSocket 信封版本 `v:1`，两者不是同一编号体系。

`/health` 与 `/api/v1/health` 均返回 `{status,version:'0.2.0',protocolVersion:1,serverTime}`。WebSocket `ready.data` 包含 `userId`、ISO UTC `serverTime` 与数字 `protocolVersion:1`。会话过期/注销使用关闭码 `4003`，超连接/超帧频使用 `1008`，不支持的二进制帧使用 `1003`。

## 实现范围

- 注册、登录、当前会话校验、同 token 滑动续期、注销；密码使用随机盐 `scrypt`，数据库仅存 token 的 SHA-256 摘要。
- 用户资料、用户搜索、双向好友申请（同意/拒绝）、好友列表。
- 唯一好友私聊、最多 100 人群聊、群名修改、群主邀请/移除、普通成员退出。
- 文本与服务端生成的系统消息；`msgId` 为 UUID，`seq` 按会话递增，`clientMsgId` 实现幂等。
- 历史游标分页、批量断线补偿、权威未读数、单调已读游标、多连接同步。
- 一次性 30 秒 WebSocket ticket、在线状态、输入状态、应用 ping/pong、传输层心跳。
- JSON 参数校验、成员/群主管理权限、精确 CORS、限流、结构化错误、日志敏感信息过滤。

不包含附件上传、音视频、朋友圈、支付、撤回/删除消息、好友删除/拉黑、群主转让、忘记密码、端到端加密或多实例部署。群成员加入后能查看群全部历史；入群前历史不计入新增未读。群主不能退群。

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `HOST` | `127.0.0.1` | 开发默认仅本机可访问 |
| `PORT` | `3001` | HTTP/WS 共用端口 |
| `DATABASE_PATH` | `.data/chat.sqlite` | SQLite 文件位置 |
| `CORS_ORIGINS` | 见 `.env.example` | 允许的完整浏览器 origin |
| `SESSION_TTL_DAYS` | `7` | 会话有效天数，范围 1–30 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |
| `TRUST_LOOPBACK_PROXY` | `false` | 仅部署在本机可信反向代理后方时设为 true；只信任 loopback 代理传来的客户端 IP |
| `DEFAULT_FRIEND_USERNAME` | 空（关闭） | 新注册用户自动与该账号成为双向好友；账号必须提前由运维创建，公网部署为 QJQ |

## 架构与数据

`src/app.ts` 组装服务，`routes.ts` 定义校验与 OpenAPI，`service.ts` 管理事务和业务权限，`realtime.ts` 管理连接与事件，`security.ts` 管理密码/会话，`db.ts` 初始化 SQLite schema v1。

数据表：`users`、`sessions`、`friend_requests`、`friendships`、`conversations`、`conversation_members`、`messages`、`ws_tickets`。启用外键、WAL 与 5 秒 busy timeout，写操作使用显式事务。初次启动自动建表，不植入测试账号。后续结构变更需新增版本化迁移，不能直接对已有部署修改建表语句。

SQLite 数据包含聊天正文，不是端到端加密存储；日志不记录请求正文、Authorization 或 ticket 查询参数。备份时应停服后复制整个 `.data`，或使用 SQLite 一致性备份工具，运行中不要只复制主库而漏掉 WAL。测试使用独立内存/临时数据库。

## 验证与上线边界

`npm test` 执行 TypeScript 构建和 Node test runner 集成测试，覆盖认证与续期、参数校验、好友授权、群权限、幂等/序号、未读、游标与补偿、真实 WebSocket、票据/会话失效、CORS/限流以及 SQLite 重启恢复。

这是**单进程 MVP**：在线状态、连接分发、限流存在本进程，不支持多实例共享实时事件。SQLite 同步 API、offset 列表和逐成员事件适合开发及小规模使用，不构成高并发承诺。

生产部署前至少需要 HTTPS/WSS、反向代理与超时配置、正确的代理/IP 信任策略、账号防滥用、密码找回、监控告警、数据库备份与迁移、容量压测及隐私合规。`/docs` 默认公开，生产可在反向代理限制访问。不要把开发服务直接暴露到公网。浏览器只把用户内容当纯文本渲染，切勿使用 `innerHTML`；头像 URL 不由后端抓取。
