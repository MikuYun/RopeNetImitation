# 00 · 项目总览与术语表

> 本文是全项目**命名与语义的唯一裁定处**。任何文档、代码、会话消息与本文件冲突时，以本文件为准。
> 事实源：`backend/openapi.json`（v0.2.0）+ `backend/API.md` + `contracts/requirements/*.json`（v0.2.0）。

---

## 1. 项目定位

一个**网页聊天平台**，功能范围对齐微信式**布局与交互**（左侧会话列表 + 右侧消息气泡区、自己消息靠右、输入框在底部），但**视觉完全原创**。

| 项 | 值 |
|---|---|
| 产品名 / 包名 | `aitrance-chat` |
| 前端 | Vue 3 + Vite + TypeScript + Pinia + Tailwind v4 |
| 后端 | Node.js 24 + TypeScript + Fastify + SQLite + WebSocket |
| 后端端口 | `3001`（REST 与 WS 同端口） |
| 前端 dev 端口 | `5173`（`strictPort: true`） |
| REST 前缀 | `/api/v1`（+ 无前缀的 `/health`） |
| WS 路径 | `/ws` |
| 认证 | Bearer **opaque** session token（非 JWT） |
| WS 建连 | 一次性短效 ticket：`/ws?ticket=<ticket>&v=1` |

### 1.1 原创视觉合规清单（硬要求）

产品名、包名、UI 文案、代码标识符、图标素材、配色**均不得**出现任何第三方聊天产品的名称、logo、商标或专有视觉资产。

| 允许 | 不允许 |
|---|---|
| 微信式的**布局与交互模式**（会话列表分栏、气泡左右对齐、底部输入框） | 使用「微信 / WeChat」等字样于代码或 UI |
| 自定义中性青蓝色板（`src/styles/theme.css` 的 `--color-brand-*`） | 使用第三方 logo、图标字体、图标素材包 |
| 自绘约 20 个内联 SVG 图标（`AppIcon.vue`） | 复制第三方配色资产 |
| 生成式头像（首字母 + userId 派生色，`AppAvatar.vue`） | 直接引用第三方头像占位图 |

全站换色**只有一处入口**：`frontend/src/styles/theme.css` 的 `@theme` 块。改 `--color-brand-500` 即可整体换皮 —— 这是可替换主题变量层的验收方式。

---

## 2. 术语表（重点）

### 2.1 三个必须分清的概念

#### `Client.online`（快照）

`User.online` 是**布尔快照**，由后端在每次读取列表/详情时计算：表示该用户当前有至少一条有效 WS 连接。**它不是最后活跃时间**，也没有「最后在线 X 分钟前」的信息（后端 `presence.changed` 也只带 `online`，无 `lastSeenAt`）。

前端因此**只渲染在线/离线两态**（`PresenceDot.vue`）。首屏在线状态来自列表内嵌的 `User.online`；`presence.changed` 到达后增量更新。后端明示 presence 是单进程瞬时状态，刷新列表可校准。

#### `Message.seq`（会话级序号）

**每会话**从 1 开始的安全整数，**单调递增且连续**（含 `system` 消息，同样占号）。它是：

- 消息排序的**唯一**依据（**绝不用 `createdAt` 排序** —— 时钟偏移会导致消息跳跃）
- 分页游标（`beforeSeq` / `afterSeq`）
- 未读数计算基准（`count(seq > lastReadSeq AND senderId != me)`）
- 群聊「N 人已读」的判据（`members[].lastReadSeq >= message.seq`）
- **缺口检测**的唯一依据：收到 `message.created` 时若 `seq > 本地 lastSeq + 1` → 中间丢帧 → 立即 REST `afterSeq` 补齐

#### `lastReadSeq`（已读游标）

从 **0** 开始，**单调不回退**，0 合法。正数必须是当前会话**已有**消息的 seq（提交未来游标返回 400 `INVALID_READ_CURSOR`）。

**关键语义：读到历史位置并不一定把未读清零** —— 未读数按实际剩余消息计算。所以 `POST /conversations/:id/read` 返回 **204 无正文**，而服务端通过 WS `conversation.read` 事件推回**每个接收者自己的**权威 `unreadCount`。前端的本地清零只是乐观显示。

### 2.2 ⚠️ 已废弃：连接级 `seq`

v0.1 需求书曾提案在 WS 信封中放一个**连接级**单调递增 `seq`（前端变量名 `lastConnSeq`），用于「连接内丢帧检测」。

**后端未实现该字段，已从契约中删除。** 现状与后果：

| 项 | v0.1 提案 | 当前事实 |
|---|---|---|
| WS 信封 | `{v,type,reqId?,seq?,ts,payload}` | `{v,id,type,timestamp,data}`（**无 seq**） |
| 丢帧检测 | 连接级 `seq` 连续性 | **只能依赖 `Message.seq` 的连续性 + 连接状态机** |
| 前端变量 | `lastConnSeq` | **已删除**，代码中不得再出现 |

**唯一存在的 seq 是 `Message.seq`（会话级）。** 代码中**禁止**出现裸 `seq` 变量名 —— 必须写成 `message.seq`、`lastSeqByConv`、`localSeq` 等带限定词的名称，避免日后误读。

### 2.3 `sessionToken` vs `ticket`

| | `sessionToken` | `ticket` |
|---|---|---|
| 是什么 | **身份凭证** | **WS 一次握手凭证** |
| 类型 | opaque 随机串（**不是 JWT**，前端不得尝试解码） | opaque 随机串 |
| 寿命 | 默认 7 天，`POST /auth/session/refresh` 滑动续期 | **30 秒** |
| 可复用 | 是（可换任意数量 ticket） | **否，一次性，握手成功即作废** |
| 传递方式 | `Authorization: Bearer <token>` 请求头 | URL query：`/ws?ticket=<ticket>&v=1` |
| 存放 | `localStorage["aitrance.session"]` | **绝不落盘、绝不缓存**，用完即丢 |
| 谁校验 | 每个 REST 请求 + WS 建连时 + WS 心跳周期（≤30 秒） | 仅 WS 握手一次 |
| 过期行为 | REST 401；WS 以 `1008` 关闭 | **不影响已建立的连接**（票据 TTL 不控制连接寿命） |

**ticket 三条语义**（最容易实现错的地方）：

1. **一次性** —— 握手成功即作废，重放必须拒绝（`4001`）
2. **TTL 30 秒**
3. **不决定连接寿命** —— 握手成功后票据过期**不得**断开连接。若后端把 ticket 当会话凭证持续校验，用户会每 30 秒被踢一次

前端另有两条强制纪律：**禁止缓存**（每个 WebSocket 对象配一个新 ticket）、**单飞**（同一时刻只允许一个 in-flight 取票请求，否则并发重连打出的多个一次性票据全部作废）。

### 2.4 `version` vs `protocolVersion`

后端 `/api/v1/health` 返回**两个不同的版本字段**，极易混淆：

| 字段 | 类型 | 含义 | 变更时机 | 前端行为 |
|---|---|---|---|---|
| `version` | string（`"0.2.0"`） | **后端实现版本** | 每次实现迭代 | 仅打印到 console |
| `protocolVersion` | number（`1`） | **协议版本** | **只在协议不兼容时** bump | 与本地 `WS_PROTOCOL_VERSION` 比对；不等则提示刷新并停止重连 |

### 2.5 其他术语

| 术语 | 含义 |
|---|---|
| `msgId` | 服务端生成的全局唯一消息 ID（UUID）。前端**层2 去重**的键 |
| `clientMsgId` | **客户端**生成的 UUID。前端**层1 去重**的键、**服务端幂等**的键（`(senderId, clientMsgId)` 唯一索引）。`system` 消息的 `clientMsgId` 由服务端生成 |
| `content` | 消息正文（≤4000 字符）。`system` 消息的 `content` 是**服务端渲染好的纯文本**（如「张三 加入了群聊」）。前端必须**文本渲染**，严禁 HTML 注入 |
| `title` | 会话的**请求者视角**展示标题：私聊 = 对方昵称，群聊 = 群名。服务端算好，前端不自行推导 |
| `unreadCount` | 服务端权威未读数。前端只信它，本地清零仅乐观显示 |
| `myRole` | `owner` | `member`。**后端不提供 `admin`** —— 前端白名单外一律降级为 `member` |
| 乐观消息 | 点发送后立刻渲染、`seq: null`、`status: sending` 的本地消息。确认后由服务端版本替换 |
| outbox | 待发/待重发的乐观消息队列。重连后**按会话保序**重发，必须**复用原 `clientMsgId`** |
| 缺口 | 本地 `lastSeq` 与收到的 `message.seq` 之间不连续 |
| 补偿 | 重连后拉齐缺口的过程：`GET /conversations` 刷新 + `POST /sync`（或 `GET /messages?afterSeq=` 兜底）+ 重发 outbox |

---

## 3. 全局约定

| 项 | 约定 |
|---|---|
| 时间格式 | ISO 8601 UTC 毫秒：`2026-09-28T09:15:22.481Z`。服务端存储与传输一律 UTC，前端渲染本地时区 |
| ID | 一律 UUID 字符串。前端**禁止**对 ID 做算术或大小比较 |
| 集合包装 | 列表端点统一 `{ items, nextOffset }`，**不裸数组**。`nextOffset: null` = 末页 |
| 分页 | 非消息列表：`limit`（默认 30，最大 100）+ `offset`（默认 0），**二者在 openapi 中均为 required，前端必须显式传** |
| 消息分页 | `seq` 游标：`{ items, hasMore, nextBeforeSeq, nextAfterSeq }`，`items` **恒为 seq 升序**。`beforeSeq` 与 `afterSeq` 互斥 |
| 请求体 | 后端为 `additionalProperties: false`（**拒绝未知字段**），前端发请求必须**精确匹配**，不得多传 |
| 响应容忍 | 服务端**多返回**字段时前端必须容错（后端明示支持字段追加），前端一律用可选字段访问 |
| 错误体 | 所有 4xx/5xx 返回 `{ error: { code, message, traceId } }`。前端**只按 `code` 分支**，不解析 `message` |
| 排序 | 会话列表由服务端按 `updatedAt DESC, id DESC` 排序，前端**不二次排序**（仅本地乐观变更时保持位置） |
| 未读权威 | `unreadCount` 一律以服务端为准 |
| 文本安全 | 消息正文与昵称由后端原样返回，前端必须**文本渲染**，**严禁** `v-html` 或任何 HTML 注入路径 |

### 3.1 长度与数量上限（前后端必须一致）

| 项 | 上限 |
|---|---|
| 消息正文 `content` | 4000 字符，不接受纯空白 |
| 昵称 `displayName` | 40 字符 |
| 用户名 `username` | 3–32，`^[A-Za-z0-9_]+$`，统一小写存储、登录不区分大小写 |
| 密码 | 8–128 |
| 简介 `bio` | 200 字符 |
| 群名 `name` | 60 字符 |
| 群成员总数 | 100（创建/邀请时 `memberIds` 数组 1–99 项，`uniqueItems`，不含自己） |
| 好友申请附言 `note` | 200 字符 |
| HTTP body | 32 KiB |

### 3.2 速率限制

| 范围 | 限制 |
|---|---|
| 普通请求 | 200 次/分/用户 |
| 注册 / 登录 | 10 次/分/IP |
| 发消息 | 60 次/分/用户 |
| WS 帧频 | 每连接 30 帧/10 秒 |
| WS 帧大小 | 单帧 ≤4 KiB |
| WS 连接数 | 每用户 ≤5 条 |

超限返回 `429 RATE_LIMITED` + `Retry-After` 头。

---

## 4. 目录所有权（协作前提）

| 路径 | 唯一写入者 | 另一方权限 |
|---|---|---|
| `frontend/` | frontend agent（本方） | 只读 |
| `docs/` | frontend agent（本方） | 只读 |
| `contracts/` | frontend agent（本方） | 只读（消费生成物） |
| `backend/` | backend agent | 只读 |
| `scripts/` | frontend agent（本方） | 只读 |
| `session.txt` | **双方只追加** | 任何一方都不得重写、截断、删除已有行 |
| `.session-monitor/` | **`monitor.ps1` 独占** | **两个 agent 都不得写入** |
| `monitor.ps1` | 用户 | 两 agent 均不得修改 |

详见 `docs/05-collaboration.md`（已定稿）。

其他关键入口：`frontend/`（前端实现）、`scripts/check-contract.mjs`（契约机械门禁）、`backend/openapi.json`（后端实现事实，只读）。

---

## 5. 文档索引

| 文档 | 内容 |
|---|---|
| `00-overview.md` | 本文：定位、术语表、全局约定 |
| `01-scope-mvp.md` | 功能矩阵与验收标准 |
| `03-ws-protocol.md` | WS 信封、事件表、4 张时序图、关闭码 |
| `04-frontend-architecture.md` | 分层、6 个 store、路由、主题层 |
| `05-collaboration.md` | 双 agent 协作规范（已定稿） |
| `06-dev-setup.md` | 环境、端口、启动、对后端的运行约束 |
| `07-mock-and-testing.md` | Mock 策略、切真实后端、契约测试 |
| `08-runbook-verify.md` | 端到端联调逐条勾选清单 |
| `09-contract-changelog.md` | 契约版本流水与差异处置 |
| `session-log.md` | session.txt 消息归档 |
| `contract/diff-report.md` | 人工逐字段比对报告（v0.1 → v0.2）。**REST 端点导读在此** |
| `contract/check-result.md` | 机械门禁输出（`check-contract.mjs` 自动生成，勿手工编辑） |

**文件名映射说明**：`docs/05-collaboration.md`（v0.1 时期定稿）第 5 节提到「契约决策落到 `docs/03-api-contract.md` 或 `docs/04-ws-protocol.md`」。这两个是当时的**计划名**，实际落地为：

| 05 中的旧名 | 实际文件 |
|---|---|
| `docs/03-api-contract.md` | `contracts/requirements/rest-requirements.json`（机读）+ `docs/contract/diff-report.md`（人读） |
| `docs/04-ws-protocol.md` | `docs/03-ws-protocol.md` + `contracts/requirements/ws-requirements.json` |

（05 已定稿，不改其正文；以此表消歧。）

