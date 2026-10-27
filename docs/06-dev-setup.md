# 06 · 本地启动与联调

> 端口、路径、启动命令、**对后端的运行约束**。
> 联调逐条勾选清单见 `docs/08-runbook-verify.md`。

---

## 1. 环境要求

| 项 | 值 |
|---|---|
| Node.js | 24（本机实测 v24.15.0） |
| npm | 11（本机实测 11.12.1；**无 pnpm / yarn**） |
| npm registry | `https://registry.npmmirror.com`（本机已配置） |
| 操作系统 | Windows 11（本机实测 10.0.26100） |

> **registry 注意**：本机已指向 npmmirror。偶发某包的镜像缺失（历史上多见于 `msw` 的 service worker 资源），此时临时切官方 registry 装该包即可：`npm i -D msw --registry=https://registry.npmjs.org`。

---

## 2. 端口与路径

| 项 | 值 | 归属 |
|---|---|---|
| 前端 dev | `http://localhost:5173`（`strictPort: true`） | 本方 |
| 后端 REST + WS | `http://127.0.0.1:3001` | 后端 |
| WS mock 服务 | `3002`（`npm run mock:ws`） | 本方（仅 Mock 模式） |
| REST base path | `/api/v1` | 后端 |
| 无前缀健康检查 | `/health` | 后端 |
| 带前缀健康检查 | `/api/v1/health` | 后端（**联调用这个**） |
| WebSocket | `/ws`（与 REST 同端口） | 后端 |

**端口冲突怎么办**：后端换端口时，前端只需改**一处** —— `frontend/vite.config.ts` 的 `BACKEND_ORIGIN`（或用环境变量 `VITE_BACKEND_ORIGIN` 覆盖）。前端业务代码零改动，因为走的是相对路径 + 代理。

---

## 3. 启动

### 3.1 前端（Mock 模式，零后端）

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

`.env.development` 中 `VITE_USE_MOCK=true`，`mocks/browser.ts` 在 `main.ts` 中按此开关动态 `import()`（静态 import 会被打包进生产产物，故必须动态）。同时另开一个终端跑 WS mock：

```bash
cd frontend
npm run mock:ws      # ws://localhost:3002
```

### 3.2 前端（联调模式，真实后端）

```bash
cd backend && npm run dev      # 需用户手动启动（后端 agent 无法常驻后台）
cd frontend && npm run dev -- --mode integration
```

`.env.integration` 中 `VITE_USE_MOCK=false`、`VITE_BACKEND_ORIGIN=http://127.0.0.1:3001`。

### 3.3 生产构建

```bash
cd frontend
npm run build        # vue-tsc --noEmit && vite build && node scripts/strip-mock-worker.mjs
npm run preview
```

`strip-mock-worker.mjs` 是构建的**收尾门禁**（不是提醒）：

1. 删除 `dist/mockServiceWorker.js`（`msw init public` 的产物会被 Vite 原样拷进 `dist/`）
2. 遍历 `dist/` 中所有 `.js/.mjs/.css/.html`，断言**不含** `msw` 标识或 `mockServiceWorker` 引用；命中则**构建失败并退出码 1**

### 3.4 契约门禁

```bash
cd B:/AITrance
node scripts/check-contract.mjs              # 写 docs/contract/check-result.md；有 ERROR 退出码 1
node scripts/check-contract.mjs --self-test  # 验证门禁本身有效（注入 4 处缺陷）
node scripts/check-contract.mjs --json       # CI 用
node scripts/check-contract.mjs --quiet      # 只输出摘要
```

---

## 4. 开发环境为什么不需要 CORS

`vite.config.ts` 把三条路径全部代理到后端，浏览器看到的是**同源**，因此 dev 与 prod 的代码路径**零差异**（都用相对路径）：

```ts
const BACKEND_ORIGIN = process.env.VITE_BACKEND_ORIGIN ?? "http://127.0.0.1:3001"

server: {
  port: 5173,
  strictPort: true,
  proxy: {
    "/api": { target: BACKEND_ORIGIN, changeOrigin: true },
    "/ws":  { target: BACKEND_ORIGIN.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    "/health": { target: BACKEND_ORIGIN, changeOrigin: true },
  },
}
```

前端 `api/http.ts` 的 `baseURL` 为**空串**，调用处写全路径（后端 openapi 的 path key 本身已含 `/api/v1`）。

> 注意：`/health` 必须单独代理 —— 它**不带** `/api/v1` 前缀，不会被 `/api` 规则匹配到。

---

## 5. 对后端的运行约束

> 这一节是**给后端的硬要求**，不是建议。前端的若干行为依赖它们成立。

### 5.1 CORS（直连备用场景）

开发期靠 Vite 代理消掉跨域，CORS 只在「后端被另一台机器 / 另一端口直连」时需要。配置要求：

| 头 | 值 |
|---|---|
| `Access-Control-Allow-Origin` | **白名单精确匹配** `http://localhost:5173`（**不可用 `*`**） |
| `Access-Control-Allow-Methods` | `GET, POST, PATCH, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type` |
| `Access-Control-Allow-Credentials` | `false`（不用 Cookie，不需要） |
| `Access-Control-Max-Age` | `600` |
| `Access-Control-Expose-Headers` | `Retry-After`（前端 429 退避要用） |

非白名单来源返回 `403 ORIGIN_FORBIDDEN`（后端已实现）。

### 5.2 WebSocket Origin 校验（必做）

**WebSocket 不受 CORS 约束** —— 这是 WS 的 CSRF 面。服务端**必须**校验握手请求的 `Origin` 头，非白名单来源直接拒绝握手。这不是可选项。

### 5.3 CSP（XSS 的第二道防线）

因为认证用 opaque token 且存在 `localStorage`（JS 可读），XSS 的影响被放大。后端下发：

```
Content-Security-Policy: default-src 'self'; connect-src 'self' ws: wss:
```

前端侧的对应硬规则：**消息正文与昵称一律 `{{ }}` 插值，永不 `v-html`**。二期若加富文本，走「白名单 markdown → 结构化节点渲染」，不走 HTML 字符串。

### 5.4 速率限制

| 范围 | 要求 |
|---|---|
| `POST /api/v1/auth/register` | 10 次/分/IP |
| `POST /api/v1/auth/login` | 10 次/分/IP |
| 普通请求 | 200 次/分/用户 |
| `POST /api/v1/conversations/:id/messages` | 60 次/分/用户 |
| WS 帧频 | 每连接 30 帧/10 秒 |
| WS 帧大小 | 单帧 ≤4 KiB |
| WS 连接数 | 每用户 ≤5 条 |
| WS 慢消费者 | 积压 >1 MiB 主动断开 |

超限必须返回 `429 RATE_LIMITED` + **`Retry-After` 头**（前端据此计算退避等待，缺这个头就只能盲目退避）。

### 5.5 幂等与唯一索引（数据层硬要求）

| 要求 | 理由 |
|---|---|
| 消息表 `(senderId, clientMsgId)` **唯一索引** | 前端网络重试、断线重发 outbox 都复用原 `clientMsgId`，这是「不产生重复消息」的唯一保证 |
| 同 `clientMsgId` + 同会话 + 同内容 → 返回 **200** 原消息（`msgId`/`seq` 不变）且**不再广播** | 重试路径必须无副作用 |
| 同 `clientMsgId` 换会话或换内容 → **409 `IDEMPOTENCY_CONFLICT`** | 避免错误地把两条不同消息绑成一条 |
| 单聊会话 `(userA, userB)` **唯一索引** | `POST /conversations/direct` 幂等：重复调用返回既有会话（200），不新建、不报错 |
| `POST /auth/session/refresh` **返回同一 token**、只后移 `expiresAt` | **若轮换 token，多标签页必然互相踢下线** —— 这是前端明确要求的（后端已 ACK） |

### 5.6 消息序号（`seq`）要求

| 要求 | 理由 |
|---|---|
| 每会话从 **1** 开始，**单调递增且连续** | 缺口检测依赖连续性：`seq > lastSeq + 1` 即判定丢帧 |
| `system` 消息**同样占用 seq**，且与 text 共享同一序列 | 否则前端会因 system 消息产生误报缺口 |
| `items` 一律 **seq 升序**返回 | 前端不再二次排序 |
| `GET /messages` 必须支持 **`afterSeq`** | 断线补偿的 REST 兜底路径**完全依赖**它（全清单最高优先级的单个字段） |
| 消息 `seq` **只分配一次** | 幂等重试返回原消息，不得重新分配 |

### 5.7 已读与未读

| 要求 | 理由 |
|---|---|
| `lastReadSeq` **单调不回退**；更小的值静默忽略（仍返 204） | 并发多端上报会乱序 |
| 已读事件 `conversation.read` 必须带**接收者自己的** `unreadCount` | 前端本地清零只是乐观显示，必须有权威值校准 |
| 未读数**必须服务端算**：`count(seq > lastReadSeq AND senderId != me)` | 客户端自己算必然与后端不一致，且分页场景算不准 |
| 「读到历史位置不一定清零」是**正确行为** | 未读数按实际剩余消息算，前端已按此实现（不假设归零） |

### 5.8 错误响应

| 要求 | 理由 |
|---|---|
| 所有 4xx/5xx 返回 `{ error: { code, message, traceId } }` | 前端**只按 `code` 分支**；`traceId` 用于用户报障时复制 |
| 不得外泄 Fastify 默认错误体 `{statusCode, error, message}` | 结构不同会让前端错误分支失效 |
| 非成员访问会话统一返回 **404**（而非 403） | 后端刻意如此以避免会话存在性泄露 —— 前端因此**不可**把 404 解读为「会话被删除」 |

### 5.9 时间与 ID

| 要求 | 理由 |
|---|---|
| 时间一律 ISO 8601 UTC 毫秒（`2026-09-28T09:15:22.481Z`） | 前端按本地时区渲染；排序不用时间（用 `seq`） |
| ID 一律 UUID 字符串 | 前端禁止对 ID 做算术或大小比较 |
| `clientMsgId` 由客户端生成，服务端**原样回传** | 前端层1 去重的键 |

---

## 6. 交付检查项

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 类型检查 | `cd frontend && npx vue-tsc --noEmit` | 零错误 |
| 2 | 构建 | `cd frontend && npm run build` | 零错误，且 `strip-mock-worker` 校验通过 |
| 3 | 产物无 mock | `grep -rl "msw|mockServiceWorker" frontend/dist` | 零命中 |
| 4 | 单测 | `cd frontend && npm run test` | 通过 |
| 5 | 契约门禁 | `node scripts/check-contract.mjs` | `ERROR 0` |
| 6 | 门禁自检 | `node scripts/check-contract.mjs --self-test` | 4 类注入缺陷全部命中 |
| 7 | 合规自检 | `grep -rn "微信|WeChat" frontend/src docs` | 零命中 |
| 8 | 健康检查 | `curl http://127.0.0.1:3001/api/v1/health` | 200，`serverTime` 为合法 ISO，`protocolVersion` 为 1 |

