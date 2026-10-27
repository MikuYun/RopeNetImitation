# PC / 移动端响应式适配设计与验收

任务编号：**UI-RESP-20261008**。执行方：frontend。任务书见 `backend/coordination/responsive-ui-plan.md`（只读，不在本仓库内改动）。

本文档是 R1 交付物，同时作为 R6 的验收记录载体。

---

## 一、非目标

明确不做，避免被误读为遗漏：

- 不新增任何后端接口（朋友圈、发现、支付、音视频、附件、个人设置一律不做）
- 不引入新框架、UI 库或测试工具（继续用 Vue / Pinia / Router / Tailwind v4 / Vitest / Playwright）
- 不改 REST / WS 契约，不改 `contracts/`
- 不改 `backend/deploy/build-web.mjs` 的四处 overlay 匹配点（见 §七）
- 不把桌面三栏用 `overflow: hidden` 缩窄塞进手机

---

## 二、断点定义（单一事实源）

按 **CSS 视口宽度**判定，**不用 User-Agent**（UA 判断在 iPad 等设备上不可靠，且与浏览器缩放行为冲突）。

| 名称 | 范围 | 常量 |
|---|---|---|
| mobile | `< 768px` | `BP.mobileMax = 767` |
| tablet | `768–1023px` | `BP.tabletMin = 768` |
| desktop | `>= 1024px` | `BP.desktopMin = 1024` |

**CSS 与 JS 必须用同一定义**：

- JS 侧：`src/composables/useBreakpoint.ts` 是唯一来源，导出 `BP` 常量与 `useBreakpoint()`。
- CSS 侧：媒体查询**无法读取 CSS 变量**，故数值在样式里重复书写。为防漂移，所有媒体查询必须写成 `@media (max-width: 767px)` / `@media (min-width: 768px) and (max-width: 1023px)` / `@media (min-width: 1024px)`，并在文件头注释指向本表。**不使用 `max-width: 768px` 这类与 JS 边界错开一像素的写法** —— 767/768、1023/1024 两处边界必须严格互补、无重叠无空隙。

---

## 三、三种宽度模式的线框

### 3.1 mobile（< 768px）单栏全屏

```
┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐
│  聊天        [+]        │   │  ‹  会话标题            │   │  ‹  会话信息            │
│ ┌─────────────────────┐ │   │                         │   │                         │
│ │ 搜索会话            │ │   │      [消息气泡区]       │   │    [头像]  群名称       │
│ ├─────────────────────┤ │   │      独立滚动           │   │    N 名成员             │
│ │ 会话1          12:30│ │   │                         │   │                         │
│ │ 会话2          11:02│ │   │                         │   │   成员列表…             │
│ │ …                   │ │   ├─────────────────────────┤   │                         │
│ │                     │ │   │ [输入框]          [发送]│   │   [退出群聊]            │
│ └─────────────────────┘ │   └─────────────────────────┘   └─────────────────────────┘
│  💬聊天   👤联系人  ⋯   │      底部导航隐藏，全屏正文         底部导航隐藏，全屏正文
└─────────────────────────┘
      列表屏：底部导航可见
```

- 列表屏与正文屏**互斥**，由**路由**决定（§四），不是靠 CSS 覆盖
- 底部导航只有「聊天」「联系人」两项 + 一个「更多」入口（主题 / 退出登录）
- 正文屏顶部有返回，落到**站内列表**（不是 `router.back()`）

### 3.2 tablet（768–1023px）紧凑多栏

```
┌────┬──────────────┬─────────────────────────────┐
│ 48 │  240px 列表  │   消息 / 详情（剩余宽度）    │
│ px │              │                             │
│ 竖 │              │                             │
│ 侧 │              │                             │
│ 栏 │              │                             │
└────┴──────────────┴─────────────────────────────┘
```

侧栏可缩到 48px，列表 240px，消息区占剩余。不出现横向滚动。

### 3.3 desktop（>= 1024px）PC 多栏

```
┌────┬──────────────┬─────────────────────────────┐
│ 60 │  280px 列表  │   消息 / 详情（剩余宽度）    │
│ px │              │                             │
└────┴──────────────┴─────────────────────────────┘
```

沿用现有尺寸，PC 行为不变。

---

## 四、路由与屏幕状态表

**路由是屏幕状态的唯一事实源**。不再额外维护一套 `selectedConversation`（旧代码里 `convStore.activeId` 由点击处手动 `setActive`，与路由可失同步）。

`activeId` 改为**由路由派生**：`ChatView` 监听路由，`chat` / `conversation-info` 路由的参数即当前会话；切到列表/联系人时清空。

| route name | mobile（<768） | tablet / desktop |
|---|---|---|
| `chat-empty`（`/chat`） | 列表屏。`railTab` 决定显示会话列表还是联系人 | 侧栏 + 列表 + 右侧空态 |
| `new-friend`（`/chat/new`） | 联系人屏（全屏），顶部返回回列表 | 侧栏 + 联系人面板 + 右侧空态 |
| `chat`（`/chat/:convId`） | 正文屏，全屏；顶部「‹」回列表 | 侧栏 + 列表 + 消息区（当前会话高亮） |
| `conversation-info`（`/chat/:convId/info`） | 正文屏，全屏；顶部「‹」回该会话 | 侧栏 + 列表 + 详情（当前会话仍高亮） |
| `login` / `register` | 居中卡片，宽度受视口约束 | 同左 |
| `not-found` | 居中 | 同左 |

**返回策略**：顶部返回不是 `router.back()`。用户直接打开深链时浏览器历史里没有站内上一页，`back()` 会把人退到站外或原主站。统一用**显式目标**：

- `chat` → `chat-empty`（列表）
- `conversation-info` → `chat`（同一 convId）
- `new-friend` → `chat-empty`（并切回「聊天」tab）

浏览器前进/后退、直接深链、F5 刷新三条路径都走同一套路由，行为一致。

**来源恢复**：从列表进会话再返回，恢复来源 tab、搜索词与列表滚动位置（列表组件用 `v-show` 保持挂载，滚动位置天然保留；tab 由 `railTab` 保持；搜索词由组件内部 `ref` 保持）。

**跨断点**：窗口拖动跨断点时保留账号、当前路由、当前会话、草稿与消息，不重新登录、不重复建 WS。会话草稿存进 store（`ui.drafts`），不随组件卸载丢失，因此**从正文返回列表再进入，草稿仍在**。

---

## 五、软键盘与移动视口策略

| 项 | 做法 |
|---|---|
| 视口高度 | 用 `100dvh`，回退 `100vh`（`height: 100vh; height: 100dvh;`）。不用 `100vh` 单一值 —— iOS 上它包含被地址栏遮住的部分，会导致输入框被顶出屏幕 |
| 安全区 | `index.html` 的 viewport 加 `viewport-fit=cover`；底部导航、输入区、发送键补 `padding-bottom: env(safe-area-inset-bottom)`；顶部标题补 `padding-top: env(safe-area-inset-top)` 仅在有刘海时生效（`env()` 在无刘海设备上求值为 0） |
| 键盘遮挡 | 默认依赖 `dvh` 自动收缩。**不额外叠 VisualViewport 高度补偿** —— 与 `dvh` 叠加会双重扣减，反而把输入框挤没。仅在实测发现 `dvh` 未跟随键盘时才引入，且必须成对清理监听 |
| 页面缩放 | **不禁止**。不加 `user-scalable=no` / `maximum-scale=1`（无障碍要求） |
| iOS 自动放大 | 主输入框 `font-size: 16px`（`< 16px` 时 iOS Safari 聚焦会自动放大页面） |
| 触控热区 | 发送、返回、更多、关闭等按钮**至少 44×44 CSS px**，用 `padding` 扩大，不要求图标本身 44px |
| 双滚动 | 页面根节点 `overflow: hidden`，只有消息区/列表区各自 `overflow-y: auto`。避免「页面上下双重滚动」 |
| 横竖屏切换 | 纯 CSS 响应，无 JS 状态依赖，切换后不重建连接 |

---

## 六、任务文件清单

| 文件 | 动作 | 阶段 |
|---|---|---|
| `docs/09-responsive-ui.md` | 新建 | R1 |
| `src/composables/useBreakpoint.ts` | 新建 —— 断点单一事实源 | R1 |
| `index.html` | 改 —— viewport-fit=cover | R2 |
| `src/styles/theme.css` | 改 —— 移动尺寸变量、安全区 | R2 |
| `src/styles/main.css` | 改 —— dvh、根节点滚动纪律 | R2 |
| `src/components/layout/MobileNav.vue` | 新建 —— 底部两 tab + 更多 | R2 |
| `src/components/layout/AppRail.vue` | 改 —— 移动端不渲染，改由 MobileNav | R2 |
| `src/views/ChatView.vue` | 改 —— 路由派生 activeId、移动端互斥布局 | R2 |
| `src/components/layout/ConversationList.vue` | 改 —— 宽度响应式 | R2 |
| `src/components/layout/ContactPanel.vue` | 改 —— 宽度响应式 | R2 |
| `src/views/NewFriendView.vue` | 改 —— 去掉重复渲染的 ContactPanel | R2 |
| `src/views/MessagePane.vue` | 改 —— 移动端标题栏 + 返回、安全区 | R3 |
| `src/components/message/MessageComposer.vue` | 改 —— 16px 字号、44px 热区、Enter 行为分端 | R3 |
| `src/components/message/MessageBubble.vue` | 改 —— 气泡最大宽度响应式 | R3 |
| `src/stores/ui.ts` | 改 —— 草稿存储、当前屏 | R3/R5 |
| `src/stores/conversation.ts` | 改 —— `readingId` 阅读态 | R5 |
| `src/ws/handlers.ts` | 改 —— 已读门禁 | R5 |
| `src/views/LoginView.vue` / `RegisterView.vue` | 改 —— 卡片宽度受视口约束 | R4 |
| `src/views/ConversationInfoView.vue` | 改 —— 移动端返回 | R4 |
| `src/components/base/AppModal.vue` | 改 —— 最大宽高受视口与安全区约束 | R4 |
| `frontend/e2e-responsive.mjs` | 新建 —— 响应式验收脚本 | R6 |

---

## 七、必须保留的既有行为（回归红线）

1. **深链修复不得回退**：`MessagePane` 的 `awaitingSummary` 标记与 `enterGen` 重入令牌必须保留。**禁止改回裸 `return`** —— 那会让刷新后历史永不加载（见 `docs/08-runbook-verify.md` §11.3 缺陷 4）。
2. **分页视口保持**：向上翻页时锚点不漂移（`loadOlder` 记录 `scrollHeight` 再补偿）。
3. **读历史时新消息不强行吸底**：仅 `atBottom` 时才吸底。
4. **幂等乐观去重**：三层去重（`pendingByClientMsgId` / `confirmedById` / 服务端唯一索引）不得改动。
5. **`build-web.mjs` 四处 overlay 匹配点**（改动需提前同步 backend）：

   | # | 匹配点 | 现写法 |
   |---|---|---|
   | 1 | Vite 入口 | `defineConfig({` |
   | 2 | 路由 base | `createWebHistory()` → 构建时替换为 `createWebHistory('/chat/')` |
   | 3 | Axios baseURL | `baseURL: ''` |
   | 4 | WS URL | `` `${proto}//${location.host}/ws?...` `` |

   本次改动**不触碰**这四处。新增的 `useBreakpoint` 用 `window.matchMedia`，与子路径无关；新增的底部导航用相对路由名，与 base 无关。

---

## 八、验收矩阵

自动化脚本：`frontend/e2e-responsive.mjs`（Playwright + 项目自带浏览器驱动，不新增框架）。

| 视口 | 必验重点 |
|---|---|
| 320×568、360×800 | 最窄支持、认证、导航、弹层、长消息、无横向溢出 |
| 390×844、430×932 | 手机完整用户路径、列表/聊天互斥、触控目标、安全区、浅/深主题 |
| 844×390 | 横屏短高度、输入区与弹层可达 |
| 768×1024 | 平板列表和内容都有可用宽度，触摸导航 |
| 1024×768、1440×900 | PC 多栏回归、键盘、历史翻页、群聊/详情 |
| 767/768、1023/1024 | 断点边界、当前会话/草稿/列表状态保持、WS 无重复建连 |

自动化断言：

- `document.documentElement.scrollWidth <= viewport width`（无横向溢出；同时断言 `<body>` 合法纵向滚动，不能只靠 `scrollWidth` 证明可用）
- 应隐藏的屏幕内**没有可交互的正文**
- 发送 / 返回热区 `>= 44×44`
- 浏览器前进后退与深链正确
- **列表收到消息时未读保留**（A 停在列表，B 发消息，A 未自动已读）
- 重新进入只出现一份历史（无重复气泡）
- 无 JS 异常；真实接口不出现错误路径或重复请求
- 跨断点不重复 WS 建连

**真机补验**：iOS Safari 与 Android Chrome 的软键盘、横竖屏、安全区、地址栏伸缩。当前**无真机设备**，标记为「待真机验证」，不以 Playwright 设备模拟冒充实机证据。

---

## 九、验收记录

### 9.1 自动化（隔离后端，不碰生产）

运行方式：`frontend/scripts/run-responsive-e2e.sh`（或用已起的 dev + 隔离后端直接跑脚本）。

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `frontend/e2e-responsive.mjs` | 8 组视口 × 溢出/互斥/热区/导航 + 断点边界 767↔768、1023↔1024 | **117 项断言，0 失败** |
| `frontend/e2e-gates.mjs` | SEC-02 注销清理、FE-01 已读门禁、FE-02 已读失败回滚 | 14 项 = 通过 13 / 失败 0 / 待验 1 |

响应式脚本的分组覆盖（断言 117 项）：

| 视口 | 覆盖要点 |
|---|---|
| 320×568 / 360×800 / 390×844 / 430×932 | 无横向溢出、底部导航 3 项、不渲染 PC 竖侧栏、列表屏无正文（互斥）、热区 ≥44、切换联系人、进入正文、正文屏隐藏底栏、返回回列表、进入详情、详情返回聊天、更多面板可达、主题切换 |
| 844×390（横屏短高） | 短高度下输入区与发送键仍在视口内（发送键 `bottom=380` / 视口高 390）、详情页可读 |
| 768×1024 / 1024×768 / 1440×900 | 竖侧栏在、列表在、底部导航不在、侧栏切联系人 |
| 767↔768 / 1023↔1024 | 边界两侧模式正确切换（767 手机态、768 平板态、1024 桌面态侧栏回到 60px）、跨断点**未重建 WS**（切换前后连接数均为 2） |

命令门禁（本地复跑）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（vue-tsc） | 通过 |
| `npm test`（Vitest） | 27/27 通过 |
| `npm run build` + `strip-mock-worker` | 通过，产物无 mock |
| `node management/verify.mjs`（pm 隔离门禁） | 除 `frontend-audit` 外全绿；`pm-regressions` 13/13 通过 |

### 9.2 本轮修复的具体缺陷

| # | 现象 | 根因 | 修复位置 |
|---|---|---|---|
| 6 | 手机端完全不可用：1200px 宽的桌面三栏被塞进 375px 屏 | 无任何响应式分支，固定 `--spacing-rail: 60px` + `--spacing-sidebar: 280px` + 横向 flex | `useBreakpoint.ts`（新增）、`ChatView.vue`、`MobileNav.vue`（新增）、`ConversationList/ContactPanel` |
| 7 | 注销后页面停在原路由、私密气泡仍在（pm SEC-02） | 只清 token，业务 store 未清；且没有「身份失效 → 离开受保护页」的机制（路由守卫只在导航时跑） | `auth.clearLocal()` 清五个 store + `App.vue` watch `isAuthenticated` 强制 replace 到登录页 |
| 8 | 换账号后可能看到上一个账号的数据 | 在途 REST/WS/定时器回调在清理**之后**返回，把旧数据写回刚清空的 store | `stores/session.ts`（新增代际）+ `http`/`ws`/各 store 的写入口 |
| 9 | 停在会话列表时收到消息被自动已读（pm FE-01） | 已读判定用 `activeId`，而它由上次打开的会话残留 | 拆出 `readingId`，只有「正文可见 + 页面可见 + 路由在 chat」才置位 |
| 10 | 已读上报失败仍显示已读（pm FE-02） | `markRead` 先清零未读再发请求，`catch` 只 `console.warn` | 失败回滚（带代际，旧失败不覆盖新成功） |
| 11 | refresh 401 死锁（pm FE-04） | 单飞 promise 在续期自身的 401 里等待自己 | `http.ts` 识别续期请求并终局化，`refreshFailedTerminally` 短路 |
| 12 | WS 三条生命周期竞态（pm ws-lifecycle） | `openOnce` 的 `await getTicket()` 期间 stop/重连，回调仍生效 | `ws/client.ts` 连接代际 `gen` |
| 13 | 「新的朋友」桌面端渲染两块联系人面板 | 路由组件与 ChatView 各渲染了一个 `ContactPanel` | `NewFriendView.vue` 改为只渲染空态 |

> 缺陷 6~13 全部**不报错、类型检查通过**，其中 7~12 是 pm 的独立回归抓出来的 ——
> 再次印证 `docs/08` §10.4 的教训：脚本层全绿 ≠ 功能正确。

### 9.3 未验收 / 待验项（不宣称通过）

| 项 | 状态 | 原因 |
|---|---|---|
| iOS Safari / Android Chrome **真机**软键盘、安全区、横竖屏 | **待真机验证** | 当前无设备。Playwright 的设备模拟不等于真机，不以此充当实机证据 |
| 后台标签页收消息不自动已读 | **待验** | headless Chrome 下 `bringToFront` 不会让前页变 `hidden`（实测 `visibilityState=visible`），判据无法成立。同一条门禁的**主场景**（停在列表）已通过 |
| `source-map-js` high advisory（SEC-03） | **已修复，待 PM 复核** | `source-map-js` 已从 1.2.1 升到 1.2.2（锁文件 + `node_modules` 双端一致），产物级可达性取证已完成（`dist/` 无任何可达路径），`npm audit` 中该项已消失。按 PM 要求不自宣豁免，留待复核。详见 §十一 |
| 公网复验 | 不在本轮范围 | 部署归 backend；本轮全部证据来自本地隔离环境 |

### 9.4 证据截图与原始日志

`docs/evidence/resp-*.png`（视口 × 浅深主题）、`docs/evidence/gate-*.png`（门禁）。

原始日志一并归档，便于核对：
`docs/evidence/responsive-run.txt`（117 项断言的完整输出）、
`docs/evidence/gates-run.txt`（14 项门禁的完整输出）。

文件名即视口，例如 `resp-320x568-list.png`、`resp-390x844-chat.png`、`resp-1440x900-desktop.png`。
截图均来自隔离测试后端，内容全部是合成测试数据。

---

## 十、与 pm 门禁的对应

| pm 任务 | 本文档 | 状态 |
|---|---|---|
| FE-01 可见正文才自动已读 | §9.2 缺陷 9 | 本地回归通过（`management/tests/release-regressions.test.ts` 13/13） |
| FE-02 已读失败恢复 | §9.2 缺陷 10 | 同上 |
| FE-03 双用户浏览器 E2E | §9.1、§9.4 | 已交付脚本与截图；真机项待验 |
| FE-04 失效立即离开受保护页 / refresh401 死锁 | §9.2 缺陷 7、11 | 本地回归通过 |
| SEC-02 注销与换号隔离 | §9.2 缺陷 7、8 | 本地回归通过 |
| SEC-03 依赖漏洞 | §9.3、§十一 | 已修复（1.2.2 + 产物不可达证据），待 PM 复核 |
| UI-RESP R1–R6 | 全文 | R1–R6 已实施；真机项待验 |

---

## 十一、SEC-03 依赖漏洞的技术判断

> **2026-10-22 更新（frontend-core）**：`source-map-js` 已从 1.2.1 升到 **1.2.2**，
> 锁文件与 `node_modules` 双端一致；产物级可达性取证已补（见下方「产物级证据」）。
> **仍然不自行宣称豁免** —— 关闭与否由 PM 复核本节的证据后决定，本节只提供事实。

- **advisory**：GHSA-68fv-2mgg-jv7q，`source-map-js < 1.2.2`，CVSS 7.5，类型是 DoS（`CWE-1284` 索引越界导致事件循环阻塞）。
- **当前版本**：**1.2.2**（已升级），四处传递依赖共用（`@tailwindcss/node`、`@vue/compiler-core`、`postcss`、`@vue/compiler-sfc`，约束均为 `^1.2.1`，故 1.2.2 落在原有 semver 范围内，**没有改 `package.json`**）。
  - 锁文件 `frontend/package-lock.json` 中 `node_modules/source-map-js` = `1.2.2` + `integrity sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`。
  - `frontend/node_modules/source-map-js/package.json` 实测也是 `1.2.2`（重装同步过，`node_modules/.package-lock.json` 同样为 1.2.2）。
  - 锁文件其余变化仅为 `@tailwindcss/oxide-wasm32-wasi` 的 6 条 `bundleDependencies` 补登记（`@emnapi/*`、`@napi-rs/wasm-runtime`、`@tybys/wasm-util`、`tslib`，全部 `dev+optional+inBundle`），**不是版本升级**。
- **可达性分析（推理）**：`source-map-js` 的消费方是编译/打包工具，解析的是**本仓库自己的源码**生成的 source map，不解析用户输入。要触发需要攻击者能往构建流程注入恶意 source map，而这个构建是本地/CI 完成的。因此**线上运行时不可达**。
- **产物级证据（实测，本轮新增）**：`frontend/dist/` 构建完成后逐项 grep，全部无命中 ——
  - `grep -rl "source-map-js" dist/` → 无匹配（exit 1）
  - `grep -rl "SourceMapConsumer" dist/assets/*.js` → 无匹配
  - `grep -rl "sourceMappingURL" dist/` → 无匹配（`build.sourcemap: false`）
  - `grep -rl "@tailwindcss\|compiler-sfc\|compiler-core" dist/` → 无匹配
  - 产物共 19 个 js + 若干 css，总计 445K，全部是本项目业务代码
  → **四处消费方确实全部停在构建期，`dist/` 里没有任何一条能走到 `source-map-js` 的路径。**
- **仍不豁免的理由**：上面的 grep 是「反证」而非「清白证明」—— 它证明产物里没有这些模块，不证明未来新增构建插件不会带进来。prm 要求「误报须产物不可达证据和 PM 复核」，证据已附，**复核动作留给 PM**，本节不代替该结论。
- **本轮实际动作为何安全**：只升级一个 `^1.2.1` 范围内的补丁版本，未执行 `npm audit fix --force`，未顺手升任何其它包，未改动 `package.json` 依赖声明。回滚方式：把 `package-lock.json` 的 `node_modules/source-map-js` 块改回 1.2.1 并重装。
- **`npm audit` 前后对比**（`--registry=https://registry.npmjs.org`，本机默认 npmmirror 会 404）：

  | 命令 | 升级前 | 升级后 |
  |---|---|---|
  | `npm audit --omit=dev --json` | high **3**（`follow-redirects`、`source-map-js`、`vite`）/ total 3 | high **2**（`follow-redirects`、`vite`）/ total 2 |
  | `npm audit --json`（含 dev） | high 3 / moderate 2 / total 5 | high 2 / moderate 2 / total 4 |

  `source-map-js` 已从审计结果中消失（`'source-map-js' in vulnerabilities` → `false`）。
  **仍未关闭的两条 high 不在本任务范围**：`vite 8.3.0–8.3.2`（直接依赖，升级属发布相关改动）与 `follow-redirects`（`axios` 的传递依赖，需升 axios）。
- **仍未关闭的写入限制**：本节只改了 §十一。§9.3 与 §十 的 `SEC-03` 行仍写着「未关闭」，因任务书写作用域限定「只追加/更新 §十一」，**该两处状态行需 PM 按本节结论同步**，避免文档自相矛盾。


