# backend-core 交付证据（SEC-01 / SEC-04 / BE-01）

> 作者：backend-core（teammate）；任务：Team task-1
> 实测时间：2026-10-22 10:00–12:20（Asia/Shanghai，本机开发工作站）
> 全部验证在**本机隔离环境**：`:memory:` 或 `os.tmpdir()` 下的临时 SQLite；端口仅 127.0.0.1 的高位临时端口。
> **未执行** `git commit`/`git tag`、`reset-chat.mjs`、任何 SSH/公网访问/部署，未触碰 `/opt` 或任何生产库。
> 数据均为真实运行输出；未达标项一律如实标注 PASS / 未验 / BLOCK，无虚构。

---

## 摘要（≤120 字）

SEC-01 就绪但缺证书/域名/运维审批 → BLOCK。SEC-04 五类头已下发，真 Chrome 违规 0，nginx 头有漂移检测。BE-01 保留可配、启动即清。26/26 测试全绿，原 15 条未破。

---

## 0. 环境指纹

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows 10，Git Bash（`/b/AITrance`） |
| Node / npm | `v24.15.0`（`/e/nodejs/node`）/ `11.12.1`（须 `node /e/nodejs/node_modules/npm/bin/npm-cli.js` 调用） |
| SQLite | 内置 `node:sqlite` `DatabaseSync`（非 better-sqlite3），`user_version=1` 未变 |
| `backend/src/` 聚合 sha256 | `6c12a98e3d1cdb471183fa3c498e7ccac7349e19e607a0e7fa9197a8d23e5de5`（10 个 .ts，`ls -1 src/*.ts \| sort \| xargs sha256sum \| sha256sum`） |
| 证书工具 | OpenSSL 3.5.9（`/ucrt64/bin/openssl`，仅用于生成**测试**自签材料） |
| nginx 可执行文件 | **无**（本机未安装）→ nginx 配置只做静态检查，**语法未 verify** |

### 0.1 改动文件清单

| 文件 | 行数 | sha256 | 改动 |
| --- | --- | --- | --- |
| `backend/src/config.ts` | 128 | `d49967ba…c2ff9e` | 新增 `TlsPaths`/`loadTls()`/`RequireHttpsMode`/`resolveRequireHttps()`、`retentionSweepSeconds`、`retentionMessageDays` |
| `backend/src/app.ts` | 234 | `becfefea…d221743c` | 安全头常量（四个常量改为 `export`，供漂移检测与浏览器探针复用）、TLS 构造、`isEncryptedTransport()`、明文凭据 403、启动 sweep、返回 `transport` |
| `backend/src/realtime.ts` | 214 | `76ea2fd5…7a9b4d` | 抽出 `sweep(trigger)`，心跳改调 `sweep('interval')` |
| `backend/src/server.ts` | 30 | `4a84a95f…f6974bc` | 启动日志输出 transport/requireHttps/retention |
| `backend/test/fixtures/tls.ts` | 79 | `9de43fb5…471b80` | 内联自签证书/私钥 PEM，运行时落盘（**不用 .pem 文件**，见 §1.3） |
| `backend/test/security.test.ts` | 346 | `f619a55f…2bf1bb7b` | 新增 8 条测试、81 处 assert |
| `backend/test/deploy-headers.test.ts` | 97 | `84639819…249bf6c1` | 新增（3 条）：后端常量 ↔ 两个 nginx conf 的 CSP / HSTS / Permissions-Policy 逐字漂移检测 |
| `backend/deploy/nginx-chat-https.conf` | 158 | `385b5e7f…31c2d10d` | 新增（完整 HTTPS server 块）；补文档级 CSP + `Permissions-Policy` |
| `backend/deploy/nginx-chat.conf` | 59 | `66c75e8c…5a2dbf66` | `/chat/` location 补 CSP + `Permissions-Policy` 头，注释与实测日志对齐 |
| `backend/deploy/chat.env.example` | 28 | `5a0497d2…651c63a` | 补 TLS/REQUIRE_HTTPS/RETENTION_* 注释 |
| `backend/deploy/HTTP.md` | 123 | `c22e7d20…39c653e3` | 新增「安全传输（TLS）与保留策略」「安全响应头」两节 + 漂移检测/浏览器实测说明 |
| `backend/evidence/smoke-transport.sh` | 117 | `2c448b74…63a334d0` | 新增（真实子进程 + curl 冒烟） |
| `backend/evidence/csp-browser-check.mjs` | 269 | `d0710807…8be2e438` | 新增（真 Chrome CSP 实测；严格策略直接引用 `app.ts` 导出的常量，避免探针与实现漂移） |
| `backend/evidence/csp-browser-check.log` | 63 | `e7f4e57a…02c3788e` | 新增（最后一次实测输出，`assertions=14 failures=0`，`style=0 script=0 other=0`） |

`backend/deploy/build-web.mjs` **未改动**（mtime 仍为 Sep 28 14:00，四处 overlay 匹配串完好）。
`backend/openapi.json` **未变化**（`npm run docs` 重新生成后与仓库版本逐字节 diff 无差异）。

---

## 1. SEC-01 传输安全 —— **BLOCK**

### 最终状态：**BLOCK（代码与配置已就绪；缺证书 / 域名 / 运维审批）**

阻断项三项，缺一不可，均**不是代码问题**：

1. **没有 TLS 证书**：生产证书须由运维通过 ACME/CA 申请（`/etc/letsencrypt/live/<DOMAIN>/fullchain.pem` + `privkey.pem`）。仓库内**不含任何证书或私钥**（测试自签材料是运行时生成的临时文件，见 §1.3）。
2. **没有确定域名与 DNS**：`nginx-chat-https.conf` 中 `DOMAIN` / `www.DOMAIN` 均为占位符，需真实域名 + DNS 解析 + 备案状态确认。
3. **没有运维审批与上线窗口**：修改线上 nginx 属运维动作，本任务禁止 SSH/部署，未获批准不得执行 `nginx -t` / reload。

> 结论表述（不得改写为通过）：**SEC-01 = BLOCK。代码与配置已就绪，缺证书/域名/运维审批。**

### 1.1 已实现的能力（均有测试覆盖）

| 能力 | 实现位置 | 验证 |
| --- | --- | --- |
| TLS 材料成对校验，只给一半 → 启动失败 | `config.ts` `loadTls()` | 测试①（PASS） |
| 证书/私钥不可读或非普通文件 → 启动失败并点名变量 | `config.ts` `loadTls()` | 测试①（PASS） |
| 启用 TLS 时进程内 https 监听 | `app.ts` Fastify `{ https: tls }` | 测试②（PASS，真实 https 请求 200） |
| 启用 TLS 时自动要求 https（`REQUIRE_HTTPS=auto`） | `config.ts` `resolveRequireHttps()` | 测试①（PASS） |
| `REQUIRE_HTTPS` 三态校验，非法值 → 启动失败 | `config.ts` | 测试①（PASS，`yes` 被拒） |
| 明文链路上的 register/login → 403 `HTTPS_REQUIRED` | `app.ts` `isEncryptedTransport()` + `CREDENTIAL_PATHS` | 测试③（PASS，4 种链路） |
| 反向代理感知（`TRUST_LOOPBACK_PROXY` + `X-Forwarded-Proto`） | `app.ts` `isEncryptedTransport()` | 测试③（PASS，含伪造前缀 `http,https` 末尾取段） |
| 启用 TLS/requireHttps 时下发 HSTS | `app.ts` | 测试②（PASS）；冒烟「https HSTS」（PASS） |
| HTTP 模式行为完全不变 | 不设 TLS 变量即走原路径 | 原 15 条测试全绿（PASS） |

**明文凭据判定的精确规则**（已写进 `app.ts` 注释，作为契约）：

1. `request.raw.socket.encrypted === true` → 视为加密（进程内 TLS）。
2. 否则若 `TRUST_LOOPBACK_PROXY !== true` → 视为明文（不信任任何 `X-Forwarded-Proto`）。
3. 否则取 `X-Forwarded-Proto` 的**最后一段**（逗号分隔取末尾，防左侧伪造）是否等于 `https`。
4. 其余一律视为明文 → `POST /api/v1/auth/register|login` 返回 403 `HTTPS_REQUIRED`。

> 路径与契约未改：仍是 `/api/v1/*`、`/health`、`/ws?ticket=&v=1`；`openapi.json` 逐字节未变。

### 1.2 nginx 配置（未部署，语法未 verify）

- `backend/deploy/nginx-chat-https.conf`（新增，**完整 server 块**）：80 端口仅保留 `/.well-known/acme-challenge/` 并其余 301→443；443 `ssl http2`，TLSv1.2+1.3，证书路径为 `DOMAIN` 占位；WSS upgrade（`proxy_read_timeout 75s`）；`/chat/api/`、`/chat/assets/`、`/chat/` 各 location 内**重复写全**安全头（nginx `add_header` 不继承）；`/chat/` 额外带文档级 CSP + `Permissions-Policy`；**精确 Origin 白名单**，无 `*`。
- `backend/deploy/nginx-chat.conf`（HTTP 形态）：`location ^~ /chat/` 补 `Content-Security-Policy` 与 `Permissions-Policy`（其余头原有）；**不得**下发 HSTS。
- **Origin 精确性核实**：`grep '"\*"' deploy/nginx-chat-https.conf` → **无匹配**；`set $allowed_origin` 仅匹配 `https://DOMAIN` / `https://www.DOMAIN` 两个精确字面量，空 `$http_origin`（curl/导航）放行、其余 `return 403`。
- **静态检查结果**（无 nginx 二进制，仅括号/指令平衡）：两文件 `finalDepth=0 minDepth=0 unterminated=[]`。
- **未验**：`nginx -t` 语法校验、TLS 握手、ACME 挑战、真实 443 可达 —— 需证书与运维审批后由运维执行。

### 1.3 测试证书材料为什么内联而不是 .pem 文件

`management/verify.mjs` 把 `backend/` 快照到临时目录后在那里跑 `node --test dist/test/*.test.js`，其 `includeFile()` 白名单**不含 `.pem`**。若测试依赖 `.pem` 文件，快照内缺材料会导致 backend-tests 门禁在模块加载阶段直接失败，而 `management/` 不在本任务写权限内。故 `backend/test/fixtures/tls.ts` 内联 PEM 常量（CN=localhost，SAN `DNS:localhost,IP:127.0.0.1`，2026-10-22→2036-10-19，RSA 2048），运行时 `mkdtemp` 落盘并在进程退出时删除。**仓库中不存在任何私钥文件**。

---

## 2. SEC-04 安全响应头 —— PASS（真浏览器 style/script/img/connect 违规均为 0）

### 2.1 实际下发的头（逐字，来自 `backend/src/app.ts`）

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:
X-Frame-Options: DENY
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
Cache-Control: no-store
Strict-Transport-Security: max-age=31536000; includeSubDomains   ← 仅在 requireHttps 时
```

`/docs`（Swagger UI）单独放宽为 `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`（Swagger UI 运行时注入 inline 样式/脚本）；`/openapi.json` 是纯 JSON，保持**严格**策略（曾误放宽，已修正）。

### 2.2 与 docs/06 §5.3 的对照

`docs/06-dev-setup.md:140` 要求 `default-src 'self'; connect-src 'self' ws: wss:`。本次实现**包含**这两项且更严（多出 base-uri/form-action/frame-ancestors/object-src/script-src/style-src/img-src/font-src 显式白名单）。无一处放宽为 `*`。

### 2.3 真浏览器实测（playwright `channel:'chrome'` 155.0.8059.85）

脚本 `backend/evidence/csp-browser-check.mjs`，日志 `backend/evidence/csp-browser-check.log`（`assertions=14 failures=0`）。
方法：本地静态服务托管 **`frontend/dist` 生产构建** + 真实 `backend/dist/src/app.js` 后端，把 CSP 作为 **HTML 文档头**下发（即生产 nginx 的形态），真 Chrome 登录 → 进入 `/chat` → 打开群聊弹层，用 `securitypolicyviolation` 监听 + computed style 断言。

| 断言 | A（严格 `style-src 'self'`） | B（对照 `'unsafe-inline'`） |
| --- | --- | --- |
| 登录后进入 `/chat` 且有内容 | PASS | PASS |
| 外部样式表加载（styleSheets=10） | PASS | PASS |
| 内联 style 属性写入 DOM（3 个） | PASS | PASS |
| `AppAvatar` :style 生效（派生色 / 34px / 8px 圆角） | PASS | PASS |
| `AppModal` :style 宽度生效（440px，visible） | PASS | PASS |
| **style-src 违规数 = 0** | **PASS（0）** | PASS（0） |
| 无失败请求 | PASS | PASS |
| **script 违规数 = 0** | **PASS（0）** | PASS（0） |

**结论：`style-src 'self'` 已足够——Vue 的 `:style` 绑定走 `el.style` CSSOM，不受 style-src 限制。** 这修正了「必须 `'unsafe-inline'`」的假设，无需放宽。`img-src 'self' data:` 亦足够（当前零外链头像；`AppAvatar` 虽支持可选外链 `src`，但实际产物无外链图片，放行 `https:` 会扩大攻击面，故不放行）。

**曾经的 1 条 script 违规已消除**：上一轮实测 `script-src` 拦截了 `eval`，来源 `frontend/dist/assets/auth-*.js`，定位为 **zod v4 的 JIT 能力探测** `Function('')`。frontend-core 随后在 `frontend/src/ws/schema.ts` 加了 `z.config({ jitless: true })` 并重建 `frontend/dist`；本次复测两种策略均为 **script 违规 0**（仍**不放宽 `'unsafe-eval'`**）。探针现在直接引用 `backend/src/app.ts` 导出的 `CONTENT_SECURITY_POLICY`，A/B 差异仅在 `style-src` 是否带 `'unsafe-inline'`，不再存在「探针字符串与实现不一致」的可能。

### 2.4 生产形态的 CSP 覆盖边界（重要）

后端 CSP 只作用于它自己返回的响应（`/api/*`、`/health`、`/openapi.json`、`/docs`），**HTML 由 nginx 从 `web/` 提供**。因此本次同步在两个 nginx 配置的 `location ^~ /chat/` 补了同一条 CSP 与 `Permissions-Policy`（nginx `add_header` 不继承，必须写在各自 location 内，已在注释中说明）。若只改后端而不改 nginx，生产 HTML 将**完全没有 CSP**——这是本轮修掉的真实缺口。

### 2.5 漂移检测（新增，防「改了一边忘改另一边」）

`backend/test/deploy-headers.test.ts`（3 条用例 / 10 处 assert）：

- 用例 1：两个 nginx 配置各**恰好一条** `add_header Content-Security-Policy "…" always;`，且与 `backend/src/app.ts` 的 `CONTENT_SECURITY_POLICY` **逐字相等**；额外断言业务 CSP 不得含 `'unsafe-inline'` / `'unsafe-eval'`。
- 用例 2：HTTP 配置 `nginx-chat.conf` **不得**下发 HSTS（否则明文端口会被浏览器强制升级）；HTTPS 配置每次 HSTS 都与 `app.ts` 的 `HSTS` 常量逐字相等。
- 用例 3：两个配置各恰好一条 `Permissions-Policy`，与 `PERMISSIONS_POLICY` 逐字相等。

**为什么允许在快照里 skip**：`management/verify.mjs` 会把 backend 快照到临时目录后跑 `node --test dist/test/*.test.js`，其捕获白名单是 `['src','test','scripts','package.json','package-lock.json','tsconfig.json','openapi.json']`——**不含 `deploy/`**。故用例在找不到 `deploy/nginx-chat.conf` 时 `t.skip()`，避免在门禁里制造假红；在真实仓库 `npm test` 时完整执行。

**双向实验已做**（不是“写了个测试就算”）：

| 场景 | 结果 |
| --- | --- |
| 真实仓库 `npm test`（deploy/ 就位、两边一致） | 26 tests / **26 pass** / 0 fail |
| 模拟 verify 快照（只有 `dist/`、无 `deploy/`） | 3 条用例 **skip**，exit 0（不假红） |
| 把 https conf 的 `style-src 'self'` 改成一个 `'unsafe-inline'` 版本 | 用例 1 **FAIL**、exit 1（漂移被抓到） |

**逐字比对实际输出**（用 dist 里编译后的常量去比两个 conf 原文）：

```
$ node parity.mjs   # 临时脚本，仅 import dist/src/app.js 与读两个 conf
nginx-chat.conf
  CSP lines=1 identical=true
  PERMISSIONS lines=1 identical=true
  HSTS lines=0 identical=n/a
nginx-chat-https.conf
  CSP lines=1 identical=true
  PERMISSIONS lines=1 identical=true
  HSTS lines=5 identical=true
$ grep -c 'add_header Content-Security-Policy' backend/deploy/*.conf
backend/deploy/nginx-chat-https.conf:1
backend/deploy/nginx-chat.conf:1
$ grep -c 'add_header Strict-Transport-Security' backend/deploy/*.conf
backend/deploy/nginx-chat-https.conf:5
backend/deploy/nginx-chat.conf:0
```

### 2.6 未验 / 交办事项

- **未验**：Vite **dev** 模式（`pnpm dev`，HMR 通过 `document.createElement('style')` 注入样式，属 CSP 内联样式面）。dev 模式不经过 nginx、也不下发后端 CSP，风险低，但未用真浏览器验证。
- **未验**：`management/verify.mjs` 的 `browser-security` 门禁（它会写 `management/evidence/`，不在本任务写权限内）→ **交 Lead 运行**。
- 已确认：`verify.mjs` **无 nginx 配置门禁**（`grep 'nginx|deploy'` 仅命中 `deployment-overlay` base 与 `deployment-typecheck`），故本次 deploy/*.conf 改动不会让 verify 变红；`browser-check.mjs` 亦**无显式安全头断言**（只在响应 ≥400 且 ≠401 时报错），故严格 CSP 不会使它红。
- **未验**：nginx 配置语法（本机无 nginx 可执行文件，只做了括号/引号静态检查）。`Permissions-Policy` 是 nginx 侧新增头，未经 `nginx -t`。

---

## 3. BE-01 过期数据保留策略 —— PASS

### 3.1 实现

`backend/src/realtime.ts` 抽出 `sweep(trigger: 'startup'|'interval'|'manual'): SweepReport`，心跳 30s 调 `sweep('interval')`，`buildApp` 在 `app.ready()` 后调 `sweep('startup')`（**服务启动即清一次**，重启可收敛过期状态）。

| 变量 | 取值 | 默认 | 语义 |
| --- | --- | --- | --- |
| `RETENTION_SWEEP_SECONDS` | 1..3600 | 30 | 清理间隔；随心跳运行 |
| `RETENTION_MESSAGE_DAYS` | 0..3650 | 0 | 消息保留天数；0 = 永不删除（默认不删） |

**删除顺序有语义**：先 `ws_tickets` 后 `sessions`。因为 `ws_tickets.session_hash REFERENCES sessions(token_hash) ON DELETE CASCADE`，若先删 sessions，过期会话的 ticket 会被级联带走，tickets 计数恒为 0、不可观测（这是实测踩到的 bug，已修并在代码注释中写明原因）。

**可观测**：每次清理（有删除行或 `trigger==='startup'`）打结构化日志 `Retention sweep completed`，字段 `retention.{sessions,tickets,messages}`、`trigger`、`messageDays`。

### 3.2 测试覆盖（3 条）

- ⑤ `BE-01 retention sweep removes only expired rows, is observable and runs at startup`（13 assert）：造过期 session/ticket/有效行 → sweep → 断言过期行删除（含准确条数）、有效行保留、日志被调用。
- ⑥ `BE-01 message retention is opt-in (default keeps rows) and deletes only aged rows`（5 assert）：默认 `messageDays=0` 不删任何消息；设 7 天只删超期消息、保留新消息。
- ⑦ `startup sweep happens inside buildApp so restarts converge expired state`（3 assert）：落盘库写入过期行 → 关闭 → 重新 `buildApp` → 过期行已被清、有效会话仍可 `GET /users/me` 200。

---

## 4. 全量验证结果

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `node …/npm-cli.js run check`（`tsc --noEmit`） | **0** | 类型检查通过 |
| 2 | `node …/npm-cli.js test`（= build + `node --test dist/test/*.test.js`） | **0** | **26 tests / 26 pass / 0 fail**（原 15 + 新 8 + 漂移检测 3），3.7s |
| 3 | `node --experimental-strip-types --test test/chat.test.ts test/security.test.ts test/deploy-headers.test.ts` | **0** | **26 pass / 0 fail**，5.0s |
| 4 | `node …/npm-cli.js run docs` + 与仓库 `openapi.json` 逐字节 diff | **0** | **OPENAPI UNCHANGED**（22 paths） |
| 5 | `bash backend/evidence/smoke-transport.sh` | **0** | **22 PASS / 0 FAIL**（真实子进程 + curl） |
| 6 | `node scripts/check-contract.mjs --json` | **0** | `errors: []`、`warnings: []`；22 paths / 465 fieldChecks / 41 enumChecks / 12 bodyChecks |
| 7 | `node backend/evidence/csp-browser-check.mjs`（真 Chrome） | **0** | **assertions=14 failures=0**（`style=0 script=0 other=0`） |
| 8 | 模拟 verify 快照（只有 `dist/`、无 `deploy/`）跑 `deploy-headers.test.js` | **0** | 3 条 **skip**（不假红） |
| 9 | 漂移双向实验（改坏 https conf 的 `style-src`） | **1** | 用例 1 **FAIL**（漂移被抓到） |

### 4.1 原 15 条回归（逐条 PASS，未破 HTTP 行为）

①authentication/validation/profile/session renewal+revocation ②两条 health 同协议版本与 UTC 时钟 ③好友同意/搜索转义/群授权 ④消息幂等/会话内序号/游标/未读数 ⑤sync 分块与授权 ⑥CORS/统一错误/限流/OpenAPI ⑦注册建双向默认好友并通知在线默认账号 ⑧禁用默认好友时保留普通申请流 ⑨默认账号缺失 fail-closed 503 `DEFAULT_FRIEND_UNAVAILABLE` 且注册回滚 ⑩代理感知登录限流仅信任 loopback 且默认关闭 ⑪真实 socket 消息/在线/typing/已读 & ticket/session 规则 ⑫SQLite 跨进程重启存活 ⑬WS 限流 1008 / 二进制 1003 / 出站会话过期 4003 ⑭群系统事件与已读广播、移除后不泄漏 ⑮被移除群不可进 sync 批次、不同会话独立序号。

### 4.2 新增 11 条（逐条 PASS）

安全与保留（8 条，`test/security.test.ts`）：

1. `SEC-01 TLS configuration is all-or-nothing and fails closed`（15 assert / PASS）
2. `SEC-01 HTTPS mode terminates TLS in-process and keeps health/API/headers intact`（10 / PASS）
3. `SEC-01 plaintext credential guard is fail-closed and proxy-aware`（12 / PASS）
4. `SEC-04 security headers are present, stable and do not break /docs or /openapi.json`（10 / PASS）
5. `BE-01 retention sweep removes only expired rows, is observable and runs at startup`（13 / PASS）
6. `BE-01 message retention is opt-in (default keeps rows) and deletes only aged rows`（5 / PASS）
7. `startup sweep happens inside buildApp so restarts converge expired state`（3 / PASS）
8. `rate limits stay at 10/min/IP with Retry-After and default friend failure keeps 503`（12 / PASS）

部署层漂移检测（3 条，`test/deploy-headers.test.ts`）：

9. `SEC-04 文档级 CSP 与后端常量逐字一致（两个 nginx 配置）`（4 assert / PASS）
10. `SEC-04 HSTS 只在 HTTPS 配置下发，且与后端常量一致`（3 / PASS）
11. `SEC-04 Permissions-Policy 与后端常量逐字一致（两个 nginx 配置）`（3 / PASS）

**断言数**：`test/chat.test.ts` 179 处 `assert.`（15 test，未删改）；`test/security.test.ts` 81 处（8 test，新增）；`test/deploy-headers.test.ts` 10 处（3 test，新增）。合计 **270 处**，新增 **91 处**。

### 4.3 冒烟脚本 22 条明细（`smoke-transport.sh`，真实 `dist/src/server.js` + curl）

HTTP 模式（15）：health 状态 / x-frame-options / referrer-policy / nosniff / **无 HSTS** / permissions-policy / CSP 严格串逐字相等 / `/docs` CSP 放宽 / `/docs` 200 / `/docs/static/swagger-ui.css` / `swagger-initializer.js` / `swagger-ui-bundle.js` / `/openapi.json` 200 / `/openapi.json` 保持严格 CSP / register over http 成功。

HTTPS 模式（7）：测试证书落盘 / https health 200 / https HSTS / https CSP 仍严格 / register over TLS 成功 / **明文 curl 打 TLS 端口失败（000）** / 启动日志含 `Chat backend transport: https`。

> 环境坑记录（避免重踩）：`mktemp -d` 返回 MSYS `/tmp` 路径，Node 是原生 Windows 进程 → 须 `cygpath -w`；取头不能用 `awk -F': '`（CSP 值内含 `: ` 会被截断）；自签 HTTPS 需 `curl -k`；`DEFAULT_FRIEND_USERNAME` 在全新库须留空否则 503；检查启动日志那段须 `LOG_LEVEL=info`；无 `pkill`，用 `taskkill //PID … //F`。

---

## 5. `chat.env.example` ↔ `config.ts` 一一对应（已核实）

```bash
# A. env.example 中出现的变量名
$ grep -oE '^#? ?[A-Z_]+=' backend/deploy/chat.env.example | tr -d '#= ' | sort -u
CORS_ORIGINS DATABASE_PATH DEFAULT_FRIEND_USERNAME HOST LOG_LEVEL PORT
REQUIRE_HTTPS RETENTION_MESSAGE_DAYS RETENTION_SWEEP_SECONDS SESSION_TTL_DAYS
TLS_CERT_PATH TLS_KEY_PATH TRUST_LOOPBACK_PROXY

# B. config.ts 读取的变量名
$ grep -oE "process\.env\.[A-Z_]+|env\.[A-Z_]+" backend/src/config.ts | sed 's/.*\.//' | sort -u
CORS_ORIGINS DATABASE_PATH DEFAULT_FRIEND_USERNAME HOST LOG_LEVEL PORT
REQUIRE_HTTPS RETENTION_MESSAGE_DAYS RETENTION_SWEEP_SECONDS SESSION_TTL_DAYS
TLS_CERT_PATH TLS_KEY_PATH TRUST_LOOPBACK_PROXY

# C. 差异（env.example 有但 config.ts 不读）：<空>
# D. 差异（config.ts 读但 env.example 未列）：<空>
```

**13 个变量双向完全一致，无多余、无遗漏**。新增 5 项（`TLS_CERT_PATH`/`TLS_KEY_PATH`/`REQUIRE_HTTPS`/`RETENTION_SWEEP_SECONDS`/`RETENTION_MESSAGE_DAYS`）均带取值/默认值/失败语义注释。文档侧说明落在 `backend/deploy/HTTP.md` 新增的「安全传输（TLS）与保留策略」与「安全响应头（SEC-04）」两节。

---

## 6. 逐条状态汇总（PASS / 未验 / BLOCK）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| SEC-01 TLS 成对校验、不可读拒绝启动 | **PASS** | 测试① |
| SEC-01 进程内 https 监听、HTTP 模式不变 | **PASS** | 测试② + 冒烟 22 条 |
| SEC-01 明文凭据 403 `HTTPS_REQUIRED`（代理感知） | **PASS** | 测试③ |
| SEC-01 nginx https 配置（443/ACME/跳转/WSS/精确 Origin） | **PASS（仅静态检查）** | 括号平衡 + 无 `*` 核实 |
| **SEC-01 实际上线（证书/域名/审批）** | **BLOCK** | 见 §1 三项阻断 |
| SEC-01 nginx `-t` 语法校验 | **未验** | 本机无 nginx 可执行文件 |
| SEC-04 5 类安全头 + CSP（后端响应） | **PASS** | 测试④ + 冒烟 |
| SEC-04 生产 HTML 的 CSP（nginx 侧） | **PASS（静态）** | 两个 conf 的 `/chat/` 已加 CSP + `Permissions-Policy`；未部署 |
| SEC-04 后端常量 ↔ nginx 头逐字一致（漂移检测） | **PASS** | `test/deploy-headers.test.ts` 3/3；双向实验见 §2.5 |
| SEC-04 真 Chrome 生产构建渲染 | **PASS（style/script 违规均 0）** | csp-browser-check 14/14 |
| SEC-04 zod JIT eval 探测违规 | **已消除** | 前端加 `z.config({jitless:true})` 后复测 script 违规 0；未放宽 `'unsafe-eval'` |
| SEC-04 Vite dev 模式浏览器验证 | **未验** | 交前台/Lead 安排 |
| SEC-04 `management/verify.mjs` browser-security 门禁 | **未验（未运行）** | 会写 `management/evidence/`，越权；交 Lead |
| BE-01 可配清理间隔 + 启动即清 + 日志可观测 | **PASS** | 测试⑤⑦ |
| BE-01 消息保留默认不删 / 可选按天删 | **PASS** | 测试⑥ |
| 限流 429 + Retry-After（注册/登录 10/min/IP） | **PASS** | 测试⑧（原测试⑥⑩仍在） |
| 默认好友缺失 503 `DEFAULT_FRIEND_UNAVAILABLE` | **PASS** | 原测试⑨ + 新测试⑧ |
| 原 15 条后端测试不回归 | **PASS** | 26/26 全绿（原 15 条未删改） |
| `openapi.json` 新鲜度（不影响 verify 门禁） | **PASS** | 逐字节 unchanged |
| 契约检查 `check-contract.mjs` | **PASS** | exit 0，errors/warnings 均空 |
| `build-web.mjs` overlay 四处匹配串 | **未动** | mtime Sep 28 |

---

## 7. 需要他人配合的事项

1. **运维**：申请 TLS 证书（`DOMAIN` 真实域名）、确认 DNS/备案、批准上线窗口，然后替换 `nginx-chat-https.conf` 的 `DOMAIN` 占位、`nginx -t`、reload。这是 SEC-01 从 BLOCK 转 PASS 的**唯一路径**。
2. **Lead**：运行 `node management/verify.mjs`（本任务无权写 `management/evidence/`），确认 `browser-security`、`openapi-freshness`、`backend-tests` 全绿。
3. **frontend-e2e**：补验 Vite **dev** 模式（HMR 注入 `<style>`）与移动端真机下的 CSP 表现；若前端日后引入外链头像/字体/富文本，需同步复核 `img-src`、`font-src`、`script-src`。
4. **决策项（留档，已闭环）**：zod v4 的 `Function('')` JIT 探测曾在 `script-src 'self'` 下产生 1 条 console violation。frontend-core 已在 `frontend/src/ws/schema.ts` 加 `z.config({ jitless: true })` 并重建 `frontend/dist`；backend-core 复测两种 CSP 策略均为 **script 违规 0**。若日后前端重新开启 zod JIT 或引入 `eval`/`new Function`，需重跑 `backend/evidence/csp-browser-check.mjs` 复核。
