# RopeNetImitation

> 一个网页聊天平台 —— 布局与交互对齐微信式体验，视觉与素材完全原创。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#许可证)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org/)
[![Vue](https://img.shields.io/badge/vue-3.5-42b883.svg)](https://vuejs.org/)
[![Fastify](https://img.shields.io/badge/fastify-5-000000.svg)](https://fastify.dev/)

产品名 / 包名：`aitrance-chat`

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [数据与协议要点](#数据与协议要点)
- [测试与质量门禁](#测试与质量门禁)
- [文档](#文档)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 项目简介

`RopeNetImitation`（`aitrance-chat`）是一个自建的**网页聊天平台**。它把即时通讯里最常用的那套布局与交互模式搬到了浏览器里：左侧会话列表、右侧消息气泡区、自己的消息靠右、输入框固定在底部；同时在此基础上扩展了群聊、好友体系、个人表情包、广场动态（图文/视频分享）与后台管理等能力。

需要强调的是**视觉层面完全原创**：产品名、文案、代码标识符、图标与配色均不引用任何第三方聊天产品的名称、logo、商标或专有视觉资产。全站约 20 个图标都是自绘内联 SVG，头像由「首字母 + userId 派生色」生成，配色是一套自定义的中性青蓝色板，并且支持 7 套主题整体换皮。

项目从第一天起就是**单仓库、双端、强契约**的组织方式：后端有一份可校验的 WebSocket 协议文档与 OpenAPI 描述，前端有 TypeScript 类型、契约校验脚本与大量单测/e2e，前后端靠 `contracts/requirements/` 与 `scripts/check-contract.mjs` 对齐，避免「口头约定」式的漂移。

## 功能特性

### 账号与社交

- 注册 / 登录 / 登出，Bearer **opaque session token**（非 JWT），支持会话续期与 WS 一次性 ticket
- 好友体系：好友列表、好友申请、申请同意/拒绝；新用户注册后自动与默认好友建立关系
- 用户资料页与访客资料页，UID 体系（管理员 `1001`，普通用户从 `10001` 起）
- 管理后台：用户列表、封禁/禁言、统计

### 会话与消息

- 单聊与群聊；群成员管理（邀请、移除、设置角色）
- 消息发送、撤回、分页拉取（按 `seq` 游标）、会话级置顶（pins）
- 已读回执：未读数、群聊「N 人已读」
- 实时能力（WebSocket）：`message.created`、`message.read`、`conversation.read`、`presence.changed`、`typing.changed`
- 断线重连与缺口补偿：收到 `message.created` 时若 `seq > 本地 lastSeq + 1`，立即 REST 补齐中间消息
- 附件与媒体：多图（≤9）、视频（≤1）、文件；附件通过 blob URL 展示，Bearer token 不进 `<img src>`
- 本地表情包：收藏、分类、发送；大图上传前客户端压缩（512px WebP）

### 广场（社交流）

- 发布图文/视频动态，正文 ≤5000 字，图片 ≤9 张，视频 ≤1 个
- 帖子列表、详情、点赞、评论（含回复）、删除
- 附件类型（图片/视频/文件）统一由服务端判定，客户端不再自带 `type`

### 界面与体验

- **7 套主题**：`light` / `dark` / `ocean` / `forest` / `sakura` / `midnight` / `custom`（自定义色存 `localStorage`）
- 响应式三档：移动端（≤767）、平板（768–1023）、桌面（≥1024），栅格列数按容器宽度实时计算
- 图片灯箱：滚轮 / 按钮 / 双击缩放（1x–6x），拖拽平移，Esc 关闭，焦点归还触发元素
- 消息列表滚动优化：`content-visibility`、图片懒加载（IntersectionObserver）、媒体本地缓存（内存 LRU + IndexedDB）
- 已读上报去抖与退避，页面隐藏时不发请求
- PC 右键菜单（消息 / 图片 / 会话 / 成员各自专属），移动端长按；无障碍焦点陷阱与键盘导航

## 技术栈

### 前端 `frontend/`

| 类别 | 选型 |
| --- | --- |
| 框架 | Vue 3（`^3.5.43`）+ TypeScript |
| 构建 | Vite（`^8.3.1`） |
| 路由 / 状态 | vue-router（`^5.3.1`）、Pinia（`^4.0.3`） |
| 样式 | Tailwind CSS v4（`^4.3.3`）+ `src/styles/theme.css` 语义令牌 |
| 工具库 | `@vueuse/core`（`^15.0.0`）、`axios`、`zod`、`dayjs` |
| 测试 | Vitest（`^5.0.2`）、Playwright（`^1.63.0`）、MSW（`^2.15.0`） |

### 后端 `backend/`

| 类别 | 选型 |
| --- | --- |
| 运行时 | Node.js **≥24**（原生 TS strip-types、内置 `node:sqlite`，无需原生编译） |
| 框架 | Fastify 5 |
| 数据库 | SQLite（`node:sqlite`，`SCHEMA_VERSION = 5`） |
| 实时 | `@fastify/websocket` |
| 其他 | `@fastify/{cors,rate-limit,swagger,swagger-ui,type-provider-typebox}`、`@sinclair/typebox` |

### 服务约定

| 项 | 值 |
| --- | --- |
| 后端端口 | `3001`（REST 与 WS 同端口） |
| 前端 dev 端口 | `5173`（`strictPort: true`） |
| REST 前缀 | `/api/v1`（另有不带前缀的 `/health`） |
| WS 路径 | `/ws?ticket=<ticket>&v=1` |
| WS mock 端口 | `3002`（`npm run mock:ws`） |

## 快速开始

### 环境要求

- Node.js **24 或更高**（依赖内置 `node:sqlite` 与 `--experimental-strip-types`）
- npm 11+
- Linux / macOS / Windows 均可

### 1. 启动后端

```bash
cd backend
npm ci
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```

`npm run dev` 实际执行 `node --watch --env-file-if-exists=.env --experimental-strip-types src/server.ts`：自动热重启、自动加载 `.env`、直接运行 TS，**无需先编译**。

启动后可用 `curl http://127.0.0.1:3001/health` 验证。

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

默认 Mock 模式（`.env.development` 中 `VITE_USE_MOCK=true`），不依赖后端；若要使用 Mock 的 WebSocket，另开一个终端：

```bash
cd frontend
npm run mock:ws
```

### 3. 前后端联调

```bash
cd frontend
npm run dev -- --mode integration
```

`.env.integration` 已把 `VITE_USE_MOCK` 设为 `false`、`VITE_BACKEND_ORIGIN` 指向 `http://127.0.0.1:3001`。打开 <http://127.0.0.1:5173> 即可。

### 4. 初始账号

账号**只在数据库中不存在时创建一次**，已存在则完全不动：

| 角色 | 用户名 | 初始密码 | 说明 |
| --- | --- | --- | --- |
| 管理员 | `root` | `12345678` | UID 固定 `1001` |
| 演示用户 | `qjq` | `A454545asd@` | UID `10001`，同时是 `DEFAULT_FRIEND_USERNAME` |

> ⚠️ 这两个是**演示用默认凭据**，部署到公网前必须通过 `backend/.env` 修改，或直接删除对应条目。

### 5. 生产构建

```bash
# 后端：TypeScript 编译到 dist/
cd backend && npm run build && npm start

# 前端：类型检查 + 构建 + 移除 mock worker
cd frontend && npm run build && npm run preview
```

前端构建链是 `vue-tsc --noEmit && vite build && node scripts/strip-mock-worker.mjs`。其中 `strip-mock-worker.mjs` 是一道**硬门禁**：它会删除产出的 `mockServiceWorker.js`，并断言产物中不再出现 `msw` / `mockServiceWorker` 字样，命中即退出码 1 —— 确保 mock 永远不会被打进生产包。

### 6. 关键环境变量（`backend/.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | 监听地址 |
| `DATABASE_PATH` | `.data/chat.sqlite` | SQLite 文件路径，目录会自动创建 |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许的前端源，逗号分隔 |
| `SESSION_TTL_DAYS` | `7` | 会话有效期 |
| `DEFAULT_FRIEND_USERNAME` | `qjq` | 新用户注册后自动加为好友的账号；留空则关闭该行为 |
| `ADMIN_UID` / `ADMIN_USERNAME` / `ADMIN_INITIAL_PASSWORD` | `1001` / `root` / `12345678` | 管理员初始账号 |
| `SEED_USER_UID` / `SEED_USER_USERNAME` / `SEED_USER_DISPLAY_NAME` / `SEED_USER_INITIAL_PASSWORD` | `10001` / `qjq` / `柒玖柒` / `A454545asd@` | 演示用户初始账号 |
| `MAX_UPLOAD_BYTES` | `52428800` | 单文件上传上限（50 MiB） |
| `LOG_LEVEL` | `info` | 日志级别 |

UID 规划：`1000–9999` 为管理员保留区，普通用户从 `10001` 起递增。

## 项目结构

```text
.
├── backend/                 # 后端服务（Fastify + SQLite + WebSocket）
│   ├── src/                 # app / routes / service / db / security / upload / realtime ...
│   ├── test/                # node:test 用例（10 个文件，78 个用例）
│   ├── scripts/             # openapi.ts（生成 openapi.json）、reset-db.mjs（分模式清库）
│   ├── deploy/              # nginx 配置与 systemd 示例
│   └── openapi.json         # OpenAPI 描述
├── frontend/                # 前端应用（Vue 3 + Vite）
│   ├── src/
│   │   ├── api/             # REST 客户端与类型
│   │   ├── components/      # base / message / conversation / profile / square ...
│   │   ├── composables/     # useBreakpoint 等组合式函数
│   │   ├── router/          # 路由与守卫
│   │   ├── stores/          # Pinia stores
│   │   ├── styles/          # theme.css（语义令牌与主题层）
│   │   ├── utils/           # markdown / clipboard / dialogA11y / mediaCache ...
│   │   ├── views/           # 12 个页面级视图
│   │   └── ws/              # WebSocket 客户端、处理器与协议校验
│   ├── mocks/               # MSW handler 与 mock WS server
│   └── e2e-*.mjs            # 10 个 Playwright e2e 脚本
├── contracts/requirements/  # 需求与契约 JSON
├── docs/                    # 架构、协议、开发、验证、设计规格等文档
├── scripts/                 # check-contract.mjs（契约门禁）等
├── management/              # 项目状态与协作记录
├── monitor.ps1              # Windows 下的本地监控脚本
└── LICENSE                  # Apache-2.0
```

## 数据与协议要点

理解这三个概念，基本就能读懂整个数据层：

### `Message.seq` —— 会话级序号

**每个会话**从 1 开始，单调递增且连续（`system` 消息同样占号）。它是：

- 消息排序的**唯一依据** —— 绝不用 `createdAt` 排序，时钟偏移会导致消息跳跃
- 分页游标（`beforeSeq` / `afterSeq`）
- 未读数计算基准：`count(seq > lastReadSeq AND senderId != me)`
- 群聊「N 人已读」的判据
- 缺口检测依据：`seq > 本地 lastSeq + 1` 即判定中间丢帧

### `lastReadSeq` —— 已读游标

从 **0** 开始、单调不回退。提交未来游标会返回 `400 INVALID_READ_CURSOR`。注意「读到历史位置 ≠ 未读清零」，因此 `POST /conversations/:id/read` 返回 **204 无正文**，真正的权威未读数由 WS `conversation.read` 事件推送给每个接收者自己；前端本地清零只是乐观显示。

### `User.online` —— 在线快照

布尔快照，含义是「当前至少有一条有效 WS 连接」，**不是**最后活跃时间（协议里没有 `lastSeenAt`），所以前端只渲染在线/离线两态。presence 是单进程内的瞬时状态，刷新列表即可校准。

### WebSocket 信封

所有事件统一走同一信封，`WS_ENVELOPE_VERSION = 1`、`WS_PROTOCOL_VERSION = 2`。建连前需先用 `POST /api/v1/auth/ws-ticket` 换一次性短效 ticket，避免把长期 token 放进 URL。

## 测试与质量门禁

```bash
# 后端单测（先编译，再用 node:test 跑 dist 下的用例）：78 个用例
cd backend && npm test

# 后端类型检查
cd backend && npm run check

# 前端单测（Vitest）：18 个文件 / 399 个用例
cd frontend && npm test

# 前端类型检查
cd frontend && npm run typecheck

# 契约门禁：校验 OpenAPI 与前端类型/契约文件是否同步
node scripts/check-contract.mjs

# 端到端（需先起后端 3001 与前端 5173/3099，见 docs/07-mock-and-testing.md）
cd frontend && node e2e-v2.mjs
```

`frontend/e2e-*.mjs` 共 10 个脚本，覆盖：核心流程（`e2e-v2`）、附件（`e2e-attachment`）、表情包菜单（`e2e-sticker-menu`）、移动端会话栏（`e2e-cbar-mobile`）、响应式（`e2e-responsive`）、契约门禁（`e2e-gates`）、权限/并发矩阵（`e2e-matrix`）、UX2 P0（`e2e-ux2-p0`）、公开深链（`e2e-public-deeplink`）、线上探针（`e2e-live-probe`）。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/00-overview.md`](docs/00-overview.md) | 项目总览与术语表（命名与语义的唯一裁定处） |
| [`docs/01-scope-mvp.md`](docs/01-scope-mvp.md) | MVP 范围 |
| [`docs/03-ws-protocol.md`](docs/03-ws-protocol.md) | WebSocket 协议 |
| [`docs/04-frontend-architecture.md`](docs/04-frontend-architecture.md) | 前端架构 |
| [`docs/06-dev-setup.md`](docs/06-dev-setup.md) | 开发环境搭建 |
| [`docs/07-mock-and-testing.md`](docs/07-mock-and-testing.md) | Mock 与测试策略 |
| [`docs/08-runbook-verify.md`](docs/08-runbook-verify.md) | 验证 Runbook |
| [`docs/09-responsive-ui.md`](docs/09-responsive-ui.md) | 响应式 UI 规范 |
| [`docs/10-design-spec.md`](docs/10-design-spec.md) | 广场社交流改造设计规格 |
| [`docs/v2/`](docs/v2) | v2 系列的 API、UI 与发布说明 |

后端接口的机器可读描述见 [`backend/openapi.json`](backend/openapi.json)（也可运行 `npm run docs` 重新生成）。

## 贡献

1. Fork 本仓库并从 `main` 切出特性分支
2. 保持既有分层与命名约定：中文文档、英文标识符；样式只使用 `frontend/src/styles/theme.css` 中的语义令牌
3. 提交前至少跑通 `npm run typecheck` / `npm test` 与 `node scripts/check-contract.mjs`
4. 涉及接口变更时必须同步 `backend/openapi.json`、`contracts/requirements/` 与前端类型
5. 提 PR 时说明动机、影响面与验证方式

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
