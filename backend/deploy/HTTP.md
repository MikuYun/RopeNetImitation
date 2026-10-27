# HTTP 子路径部署

目标入口：`http://mikuyun.xyz/chat/`。保留域名现有主站、原 `/api` 及 3000 服务，不配置 HTTPS。

**安全边界**：HTTP 会明文传输密码、Bearer token、票据及聊天消息，只适合临时试用。路径隔离不是浏览器安全边界：同域名原站和聊天站共享 origin，任一页面的 XSS 都可能影响另一页面的 localStorage。正式使用建议独立子域名与 HTTPS/WSS。

## 路径与进程

| 公网路径 | 处理 |
|---|---|
| `/`、原 `/api/*`、原 `/assets/*` | 原网站，保持不变 |
| `/chat` | 308 到 `/chat/` |
| `/chat/`、`/chat/login`、`/chat/register` | 聊天 SPA |
| `/chat/api/v1/*` | Nginx 去掉 `/chat` 前缀后代理到 `127.0.0.1:3001/api/v1/*` |
| `/chat/ws` | WebSocket 升级并代理到 `127.0.0.1:3001/ws` |
| `/chat/assets/*` | 聊天静态资源，未找到返回404，不回退HTML |

登录后的原有内部聊天路由仍为 `/chat`，因此公网聊天主视图为 `/chat/chat`；这是挂载前缀与内部路由组合，不影响入口 `/chat/`。REST/WS 内部契约仍是 API 0.2.0 / WS v1，没有改名。

后端使用独立 `aitrance` 非 root 用户，由 systemd 管理。公网只用已有的 Nginx 80 端口，3001 只绑定回环。独立 Node.js 24 位于 `/opt/aitrance/runtime`，不覆盖原站全局 Node.js 22。

## 构建

在仓库根执行：

```powershell
cd backend
npm ci
npm test
node deploy/build-web.mjs
```

脚本只读 `frontend/`，在 `backend/.data/deploy/web-*` 临时副本内安装依赖及构建，避免跨 agent 修改前端源码。副本中调整 Vite base、Vue Router history base、Axios baseURL、WS URL 四处；每处原文必须唯一匹配，否则拒绝构建，禁止静默生成不正确部署包。关闭 mock，仅部署副本的 `dist/`，不要上传临时源码、node_modules、`.env`、本地SQLite或测试凭据。

## 服务器布局

```text
/opt/aitrance/
  runtime/                  Node.js 24 独立运行时
  releases/<release>/
    backend/dist/src/        编译后的后端
    backend/package*.json
    backend/node_modules/   服务器 npm ci --omit=dev 安装
    web/chat/               子路径前端构建产物
  current -> releases/<release>
/etc/aitrance/chat.env      受限环境配置
/var/lib/aitrance/          SQLite 及 WAL，非root服务用户拥有
/etc/nginx/snippets/aitrance-chat.conf
/etc/systemd/system/aitrance-chat.service
```

将 `nginx-chat.conf` 作为 **server 块内部** include 加入目标域名配置，不可直接作为完整 server 配置放入 `conf.d`，不可替换原有 location。修改前先备份目标站点配置，并记录原站首页文件校验值。Nginx 校验通过后只 reload，不 restart，不触碰原站 Node 进程。

`chat.env.example` 的 `CORS_ORIGINS` 使用完整 origin、**不包含 `/chat`**。Nginx 覆盖 X-Forwarded-For 为真实连接IP，后端仅在 `TRUST_LOOPBACK_PROXY=true` 时信任本机代理；保持3001不对外公开。不要把该配置误用于未受信任的远程代理链。

```bash
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now aitrance-chat
sudo systemctl reload nginx
curl -fsS http://mikuyun.xyz/chat/api/v1/health
```

## 更新与回滚

`reset-chat.mjs` 是破坏性运维工具，不在服务启动时调用。必须先停止聊天服务、备份完整数据库目录，再指定现有 `DATABASE_PATH` 和 `--confirm-reset-users`；通过标准输入传入 `{username,displayName,password}` JSON，不把密码放到命令参数或文件。它在同一事务内删除全部聊天用户、会话票据、好友、群及消息，按现有密码哈希算法创建唯一账号；不得用于原网站数据库。保留的受限备份仍包含旧数据，恢复时需谨慎。生产更新通常不应运行该工具。

- 更新上传到全新的 release 目录，先安装依赖和验证，不覆盖原站文件或旧 release。
- 停止 `aitrance-chat` 后再备份整个 `/var/lib/aitrance`，防止只复制主库遗漏 WAL；备份文件设置 root 私有权限。
- 切换 `current` 符号链接后重启仅 `aitrance-chat`。应用重启会断开 WS，客户端应重新获取 ticket 并补偿消息。
- 回滚切回之前 `current` 并重启该服务；若涉及后续schema迁移，必须先确认数据库兼容，不能盲目回退代码。
- 首次部署撤销可删除该站点新增的 include 并通过 `nginx -t` 后 reload，再停止 `aitrance-chat`；原站配置/进程不受影响。保留数据库，未经确认不要清空。

## 安全传输（TLS）与保留策略

HTTP 子路径形态**默认行为完全不变**：不设置 TLS_CERT_PATH / TLS_KEY_PATH 时，进程就是明文 HTTP 监听，路由、限流、错误码与改造前一致，只是多了 CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy 四条安全响应头（详见下节）。

### 两种启用 TLS 的方式

| 形态 | 需要的环境变量 | 说明 |
|---|---|---|
| 本进程终结 TLS | `TLS_CERT_PATH` + `TLS_KEY_PATH` | 两个必须成对；任一只给一个、或文件不可读/不是普通文件 → **启动直接失败**，不会静默退回明文。`REQUIRE_HTTPS` 保持默认 `auto` 即自动要求 https。 |
| 反向代理终结 TLS（推荐，即本文 nginx 形态） | `REQUIRE_HTTPS=true`（**不要**设 TLS_CERT_PATH/KEY） | nginx 443 终结 TLS，proxy→backend 段是回环明文；必须让后端知道「对外是 https」，否则 register/login 的明文凭据防护无法生效。 |

`REQUIRE_HTTPS` 三态：`auto`（默认，仅当本进程启用 TLS 时要求 https）/ `true`（一律要求 https）/ `false`（一律不要求，仅限本地 dev）。其它取值 → 启动失败。

启用 `REQUIRE_HTTPS` 后的实际行为：所有响应加 `Strict-Transport-Security: max-age=31536000; includeSubDomains`；`POST /api/v1/auth/register`、`POST /api/v1/auth/login` 若判定为明文链路则返回 **403 `HTTPS_REQUIRED`**（不落库、不校验密码）。判定规则见 `backend/src/app.ts` 的 `isEncryptedTransport()`：本进程 TLS 连接即视为加密；否则只有在 `TRUST_LOOPBACK_PROXY=true` 时才读 `X-Forwarded-Proto` 的**最后一段**是否为 `https`（防伪造前缀），其余一律视为明文。

### nginx 终结 TLS 的完整配置

见 `nginx-chat-https.conf`：80 端口只保留 ACME 校验目录并把其余请求 301 到 443；443 端口的证书路径为 `/etc/letsencrypt/live/DOMAIN/`（`DOMAIN` 需替换真实域名，**证书由运维申请并提供**，仓库内不含任何证书或私钥）；WSS upgrade、精确 Origin 白名单（不含 `*`）、以及每个 location 内的 CSP/HSTS/nosniff/Referrer-Policy/X-Frame-Options 都已写好。未取得证书与域名前，该配置**不可上线**。

### 过期数据保留策略（BE-01）

| 变量 | 取值 | 默认 | 语义 |
|---|---|---|---|
| `RETENTION_SWEEP_SECONDS` | 1..3600 | 30 | 清理间隔秒数，随 30s 心跳运行；服务启动时先清一次 |
| `RETENTION_MESSAGE_DAYS` | 0..3650 | 0 | 消息保留天数；0 = 永不删除消息。>0 时删除 `created_at` 早于 N 天的消息，**物理删除不可恢复** |

每次清理都打一条结构化日志 `Retention sweep completed`（字段 `retention.sessions/tickets/messages`、`trigger`、`messageDays`），便于观测。清理只删「已过期」行：过期 session、过期 ws ticket，以及（仅在启用消息保留时）超期消息，不影响有效行。

### 安全响应头（SEC-04）

后端对所有响应统一下发：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Permissions-Policy`（8 项全空）、`Content-Security-Policy`（取值见 `backend/src/app.ts` 的 `CONTENT_SECURITY_POLICY`；`/docs` 因 Swagger UI 需要单独放宽 style/script 的 inline，其余路径一律严格）。

注意：**后端只给 `/api/*`、`/health`、`/openapi.json`、`/docs` 的响应加 CSP，而 HTML 由 nginx 从 `web/` 目录提供**，因此生产页面能否拿到 CSP 取决于 nginx。本仓库两个 nginx 配置的 `location ^~ /chat/` 已显式加同一条 CSP 与 `Permissions-Policy`（nginx `add_header` 不继承，必须写在各自 location 内，不要在 server 级重复添加）。

**漂移检测**：`backend/test/deploy-headers.test.ts` 会把 `backend/src/app.ts` 的 `CONTENT_SECURITY_POLICY` / `PERMISSIONS_POLICY` / `HSTS` 常量与两个 nginx 配置里的 `add_header` 逐字比对，改一边忘改另一边 `npm test` 即红；它同时断言 HTTP 配置**不得**下发 HSTS。（`deploy/` 不在 `management/verify.mjs` 的 backend 快照白名单内，故该组用例在快照中自动跳过，不制造假红。）

**浏览器实测**（真 Chrome 155 / playwright，托管 `frontend/dist` 生产构建，把 CSP 作为 HTML 文档头下发）：登录 → `/chat` 渲染 → 打开弹层，`style`/`script`/`img`/`connect` 违规均为 **0**（Vue `:style` 走 CSSOM；zod v4 的 `Function('')` JIT 探测曾产生 1 条 `script-src` 违规，已由前端 `z.config({jitless:true})` 消除），无失败请求，头像/弹层样式正常。日志：`backend/evidence/csp-browser-check.log`。**Vite dev 模式未用真浏览器验证**。

## 验收

公网配置 `DEFAULT_FRIEND_USERNAME=QJQ`：须先在离线维护阶段创建该账号，再开放注册。之后注册自动成为双向好友，不需申请；指定账号缺失会阻止注册，避免静默遗漏或被公开抢注。账号密码不得写入配置、脚本、报告或协作通道。

1. 主站首页、原 `/api` 与原IP站点行为应与部署前相同。
2. `/chat` 跳转 `/chat/`，直接刷新 `/chat/login` 仍显示登录页面。
3. 两个独立浏览器用户注册、搜索/添加好友、通过申请、私聊/群聊收发。
4. 网络请求仅使用 `/chat/api` 和 `/chat/ws`，不得串到原站 `/api`。
5. 消息到达、未读/已读、断线重连，WS握手为101。
6. 不把 token、密码或 ticket 输出到截图/日志/协作文件；Nginx聊天API与WS access log关闭，后端不记录查询参数和Authorization。

公网可达仍依赖服务器安全组允许80、域名解析正确。域名受备案/接入策略拦截时需服务器所有者处理，不能用代码绕过。本文不把通过SSH或本机curl当作公网验收成功。
