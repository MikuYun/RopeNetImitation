# 04 · 前端架构说明

> 本文如实描述**已实现**的结构（`vue-tsc --noEmit` 与 `npm run build` 均通过）。
> 不是设想稿。任何改动请同步本文件。

---

## 1. 分层与依赖方向

```
views / components            （只认 store，不直接发请求）
        ↓
stores  (pinia)               （业务编排：乐观更新、去重、补偿、状态机）
        ↓
api/  ·  ws/                  （传输层：HTTP 与 WebSocket）
        ↓
api/http.ts  ·  ws/client.ts  （axios 实例 / 连接生命周期）
```

硬规则：**单向依赖**。`api/` 不认识 store；`ws/client.ts` 不认识 store（由 `ws/handlers.ts` 在 App 启动时由 `main.ts` 接线，避免循环依赖）；`normalize.ts` 是**全前端唯一感知后端字段命名的地方**。

> **本项目没有 `composables/` 目录** —— 复用逻辑都在 store 里（`message` store 的 `loadOlder` / `ensureLoaded` / `catchUp`），组件直接调 store。行数还不足以引入 composable 这一层，过早抽象会让数据流多一跳。

实际目录（`frontend/src/`）：

```
api/          http.ts · wire.ts · normalize.ts · auth.ts · users.ts · friends.ts
              conversations.ts · messages.ts · presence.ts · auth.types.ts
ws/           client.ts · ticket.ts · schema.ts · constants.ts · handlers.ts
stores/       auth.ts · conversation.ts · friend.ts · message.ts · presence.ts · ui.ts
views/        LoginView · RegisterView · ChatView · ChatEmptyView · MessagePane
              NewFriendView · ConversationInfoView · NotFoundView
components/
  base/       AppAvatar · AppButton · AppEmpty · AppIcon · AppInput
              AppModal · AppSkeleton · AppToaster
  layout/     AppRail · ContactPanel · ConversationItem · ConversationList · PresenceDot
  message/    DateDivider · MessageBubble · MessageComposer · MessageStatusIcon · TypingIndicator
  group/      GroupCreateModal
router/       index.ts
styles/       theme.css（主题变量层）· main.css · （Tailwind v4 通过 @tailwindcss/vite）
types/        domain.ts（领域模型）
utils/        datetime.ts · uuid.ts
mocks/        fixtures/db.ts · rest/handlers.ts · ws-server.mjs · browser.ts
```

---

## 2. 依赖清单

### 2.1 运行时（7 个）

| 依赖 | 为什么需要 |
|---|---|
| `vue` | 框架 |
| `vue-router` | 会话必须 URL 可寻址（可分享、可后退） |
| `pinia` | 状态管理：官方、TS 推断好、无 boilerplate |
| `axios` | 传输层：拦截器统一注入 Bearer、统一错误映射为 `ApiError`。**本清单唯一可删项** —— opaque token 无刷新竞态，手写 `fetch` 封装约 40 行即可替代 |
| `zod` | **WS 边界运行时校验**。后端由另一 agent 独立开发，帧结构漂移是必然事件；没有它就是一个 `undefined is not a function` 在深夜出现 |
| `dayjs` | 气泡时间分组（今天 / 昨天 / 星期X / 完整日期）+ 相对时间。~2KB；`Intl` 手写这段要 60 行且边界多 |
| `@vueuse/core` | 只用到 `useEventListener` / `useLocalStorage` / `useIntersectionObserver`（向上翻页）/ `useResizeObserver` |

### 2.2 开发期

| 依赖 | 为什么需要 |
|---|---|
| `vite` + `@vitejs/plugin-vue` | 构建 |
| `typescript` + `vue-tsc` | `vue-tsc --noEmit` 是构建门禁（`npm run build` 的第一步） |
| `tailwindcss` + `@tailwindcss/vite` | v4 的 CSS-first `@theme` 天然就是「可替换主题变量层」，且不需要 `tailwind.config.js` |
| `openapi-typescript` | 预留：从 `backend/openapi.json` 生成 wire 类型。当前 wire 类型手写在 `api/wire.ts`（带字段级注释指向 diff-report），后续可切换到生成 |
| `msw` | REST Mock（Service Worker 层拦截，业务代码零感知） |
| `ws` | 独立 WS mock 服务（`npm run mock:ws`） |
| `vitest` + `@vue/test-utils` | 单测 |

### 2.3 明确拒绝

| 拒绝 | 理由 |
|---|---|
| `element-plus` / `naive-ui` / `ant-design-vue` | 即使用 `:theme-overrides` 能换主色，其间距节奏、圆角、阴影、动效曲线、组件密度仍带强品牌识别度，与「原创视觉」冲突；体积对 15 个组件是净负担 |
| `vuex` | 被 pinia 取代 |
| `socket.io` | 原生 WebSocket 足够；引入等于把传输层契约交给第三方，后端还得多装一个包 |
| `lodash` | `Object.groupBy` / `structuredClone` 已内置 |
| `moment` | dayjs 替代 |
| `uuid` | `crypto.randomUUID` 可用，只需自写兜底（`utils/uuid.ts`） |
| 任何图标素材包 | 合规风险 |
| `vee-validate` | 三个表单，手写校验约 20 行 |

---

## 3. 六个 store（如实描述）

| Store | 关键状态 | 关键 action | 设计要点 |
|---|---|---|---|
| `auth` | `user` · `token` · `expiresAt` · `status` · `revokedReason` | `bootstrap()`（冷启动校验一次）· `login` · `register` · `logout` · `doRefresh()` · `onSessionRevoked` | token 与 expiresAt 落 `localStorage`（键 `aitrance.session` / `aitrance.sessionExpiresAt`）；`localStorage` 抛错时降级为「内存态可用、刷新后需重登」。**到期前 60 秒**定时静默续期 |
| `conversation` | `summariesById` · `orderedIds` · `detailsById` · `activeId` · `totalUnread` | `fetchAll` · `fetchDetail` · `ensureDetail` · `createDirect` · `createGroup` · `addMembers` · `removeMember` · `rename` · `markRead` · `applyReadReceipt` · `upsertSummary` · `removeSummary` · `setActive` · `clearUnreadLocally` | `orderedIds` 显式维护服务端给的顺序，**前端不二次排**；`upsertSummary` 支持 `keepPosition`（收到 `conversation.updated` 时默认不重排，避免正在阅读时列表跳动） |
| `friend` | `friends` · `incoming` · `outgoing` · `searchResults` · `searching` | `fetchAll` · `search` · `sendRequest` · `accept` · `reject` · `applyIncomingRequest` · `applyAccepted` · `resolveRejected` · `applyRemoved` · `relationshipOf` | 后端 `GET /users` **不返回 relationship**，故 `relationshipOf()` 用已加载的好友与申请列表**本地推导**（在 `normalize.ts` 的 `deriveRelationship` 中实现） |
| `message` | `buckets: Map<convId, ConversationBucket>` | `insertOrIgnore`（**唯一写入入口**）· `insertMany` · `appendOptimistic` · `markFailed` · `markRetrying` · `loadOlder` · `ensureLoaded` · `catchUp` · `applySyncResult` · `detectGap` · `seedMemberReadSeqs` · `applyMemberReadSeq` · `readCountFor` | 见 §4 |
| `presence` | `onlineByUserId` · `lastSeenByUserId` · `typingByConv` · `prefetchSupported` | `applyPresenceUpdated` · `applyTyping` · `prefetch`（端点缺失时静默降级）· 1 秒 TTL 定时清理 | 只存**他人**状态；自己的在线状态由服务端裁定，前端不上报。`GET /presence` 未实现时 `prefetchSupported=false`，完全走 `User.online` 快照 + `presence.changed` |
| `ui` | `theme`（`light`/`dark`）· `toasts` · 模态状态 | `toast` · `dismissToast` · `toggleTheme` · `setTheme` · `applyTheme` | 主题通过 `document.documentElement.dataset.theme` 切换；CSS 侧用 `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))` 让 Tailwind 的 `dark:` 跟随 `data-theme` 而非 `prefers-color-scheme` |

### 3.1 为什么 `message` 要按会话分桶

`buckets` 是 `Map<conversationId, ConversationBucket>`，**不是**一个全局消息数组。理由：无法用一个数组表达「A 会话正在补历史、B 会话同时在收实时消息」的并发状态。

```ts
interface ConversationBucket {
  conversationId: string
  confirmed: LocalMessage[]        // 已确认，按 seq 升序
  pending: LocalMessage[]          // 乐观待确认，按发送顺序，渲染在 confirmed 之后
  confirmedById: Set<string>       // 层2 去重：已确认的 msgId
  pendingByClientMsgId: Map<string, LocalMessage>  // 层1 去重：clientMsgId -> 乐观消息
  lastSeq: number                  // 本会话已收到的最大 seq，用于缺口检测
  oldestSeq: number | null         // 已加载的最小 seq，用于向上翻页
  hasMoreOlder: boolean
  loaded: boolean
  loading: boolean
  stale: boolean                   // 缺口过大，需走 REST 完整分页补齐
  memberReadSeqs: Map<string, number>  // 各成员已读游标，群聊「N 人已读」
}
```

---

## 4. 三层去重与补偿（`stores/message.ts` 的核心）

### 4.1 三层去重

| 层 | 键 | 解决什么 |
|---|---|---|
| 1 | `pendingByClientMsgId` | 把「本地乐观消息」与「服务端确认」关联起来。收到带 `clientMsgId` 的服务端消息时，先删 pending 再插 confirmed |
| 2 | `confirmedById`（`Set<msgId>`） | 应对 **WS 推送**与 **REST 分页/同步补齐**的重叠 —— 这两条路径**必然重叠**（自己发的消息会从 REST 返回，同时 `message.created` 也推给自己所有连接） |
| 3 | 服务端 `(senderId, clientMsgId)` 唯一索引 | 网络重试不产生重复。同内容重试返回 200 原消息，不再广播 |

**所有插入都必须走 `insertOrIgnore(msg)` 单一入口**，不允许出现第二套合并逻辑。`loadOlder` / `ensureLoaded` / `catchUp` / `applySyncResult` / WS 分发的 `message.created` 全部调它。

### 4.2 排序纪律

`confirmed` 恒按 `seq` 升序（插入后 `sort((a,b) => (a.seq??0) - (b.seq??0))`）。**绝不用 `createdAt` 排序** —— 客户端与服务端时钟偏移会导致消息跳跃。`pending` 在 `confirmed` 之后渲染（`messagesOf()` 返回 `[...confirmed, ...pending]`）。

### 4.3 缺口检测与补偿

```ts
detectGap(conversationId, incomingSeq): boolean {
  const b = buckets.get(conversationId)
  if (!b) return false
  if (b.lastSeq === 0) return false          // 首次加载不算缺口
  return incomingSeq > b.lastSeq + 1         // 中间丢帧
}
```

`catchUp(conversationId, maxRounds = 10)` 是**补偿的第一实现路径**：反复 `GET /messages?afterSeq=<lastSeq>&limit=100` 直到 `hasMore=false` 或达到轮次上限（上限触发时 `stale=true`）。它**不依赖**任何 WS 帧。

`applySyncResult()` 消费 `POST /api/v1/sync` 的结果：插入消息；若 `hasMore` 为真则标记 `stale` 并回落到 `catchUp()`。

> **解耦设计（防返工的关键）**：REST 兜底路径**先实现**，`sync` 只作优化。即便 `sync` 端点不可用，补偿能力依然完整。

### 4.4 outbox 与幂等重发

`allPending()` 取出所有待发消息。重连后 `handlers.ts` 的补偿编排按 per-conversation 保序重发，**复用原 `clientMsgId`** —— 服务端幂等保证不产生重复。重试按钮（`markRetrying`）同理。

---

## 5. 路由与守卫

### 5.1 路由表（`router/index.ts`）

| 路径 | 组件 | meta / 说明 |
|---|---|---|
| `/login` | `LoginView` | `{ public: true, layout: "blank" }` |
| `/register` | `RegisterView` | `{ public: true, layout: "blank" }` |
| `/` | → redirect `/chat` | — |
| `/chat` | `ChatView` | 需认证。三栏骨架 + 内嵌 `<RouterView>` |
| `/chat` → `""` | `ChatEmptyView` | 未选会话的空态 |
| `/chat/new` | `NewFriendView` | 搜索用户 + 好友申请列表 |
| `/chat/:convId` | `MessagePane` | `props: true` |
| `/chat/:convId/info` | `ConversationInfoView` | 单聊展示对方资料，群聊展示成员管理 |
| `/:pathMatch(.*)*` | `NotFoundView` | `{ public: true, layout: "blank" }` |

**路由顺序陷阱**：`new` 必须声明在 `:convId` 之前，否则 `/chat/new` 会被当作 `convId`。源码里有注释标注。

**建群走 Modal 而非路由**（`components/group/GroupCreateModal.vue`）：不需要可分享 URL，且需要保留底层会话上下文。

### 5.2 守卫策略

```ts
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.bootstrap()            // 冷启动只校验一次（有 bootstrapped 标志）
  const isPublic = to.meta["public"] === true
  if (!isPublic && !auth.isAuthenticated) {
    return { name: "login", query: { next: to.fullPath } }   // 未登录重定向
  }
  if (isPublic && auth.isAuthenticated && (to.name === "login" || to.name === "register")) {
    return { name: "chat-empty" }    // 已登录访问登录页 → 回聊天
  }
  return true
})
```

**`bootstrap()` 做什么**：仅一次（`bootstrapped` 标志）；从 `localStorage` 取 token；调 `GET /api/v1/auth/session` 校验是否仍有效；成功则填充 `user` 并调度续期定时器，失败则清空凭据。这样冷启动**不必**先发一个注定失败的请求来试错。

**不要在守卫里做业务权限校验**（如「能否看这个会话」）—— 那是 API 的职责（后端对非成员统一返回 404 以避免会话存在性泄露）。守卫只做认证。

---

## 6. 主题变量层

### 6.1 唯一改色入口

`frontend/src/styles/theme.css` 的 `@theme` 块（Tailwind v4 CSS-first）。含：

- `--color-brand-50..900`（原创青蓝色板）
- `--color-ink-50..900`（中性灰阶）
- 语义色：`--color-danger-500` / `--color-warn-500` / `--color-success-500`
- 业务状态语义：`--color-presence-online` / `--color-presence-offline` / `--color-system-msg` / `--color-receipt` / `--color-typing`
- 尺寸：`--radius-bubble` / `--radius-avatar` / `--spacing-rail` / `--spacing-sidebar`

`@theme` 外另有 `:root` 与 `[data-theme="dark"]` 两组应用级别名（`--app-bg` / `--app-panel` / `--app-border` / …），深色模式通过覆盖同名变量实现。

### 6.2 换肤验收方式

1. 修改 `theme.css` 里 `--color-brand-500` **一处** → 全站主色随之变化
2. 点 UI 的主题切换 → `document.documentElement.dataset.theme` 在 `light`/`dark` 间切换，**无残留白底或黑字**

第 2 条是对「主题层是否真的解耦」的最强验证 —— 任何硬编码颜色都会在这个测试下暴露。

### 6.3 合规自检

```bash
# 应在 frontend/src 与 docs 中零命中
grep -rn "微信|WeChat|wechat" frontend/src docs
```

---

## 7. 数据流示例：发一条消息

```
MessageComposer.vue
  ├─ uuid() 生成 clientMsgId（utils/uuid.ts，含非安全上下文兜底）
  ├─ messageStore.appendOptimistic({conversationId, senderId, content})
  │     → buckets[convId].pending.push(msg); status="sending"; seq=null
  │     → UI 立即渲染（气泡靠右 + 转圈图标）
  └─ conversationStore.markRead(convId, localSeq)  同步推进已读

api/messages.sendMessage(convId, {clientMsgId, type:"text", content})
  ├─ 201 → normalize.toWireMessage → messageStore.insertOrIgnore(msg)
  │        → 层1 兑现 pending（删除）；层2 按 msgId 插入 confirmed；status="sent"
  ├─ 200 → 幂等重试，同上（服务端不再广播）
  ├─ 409 → IDEMPOTENCY_CONFLICT：属前端缺陷（同 id 换了会话或正文）
  └─ 网络失败 → messageStore.markFailed(convId, clientMsgId) → 显示「重试」

（并行）WS message.created { message, unreadCount }
  ├─ handlers.dispatch → messageStore.detectGap(convId, seq)？
  │     → 若 seq > lastSeq+1 → messageStore.catchUp(convId)
  ├─ messageStore.insertOrIgnore(message)   ← 同一入口，层2 去重
  └─ conversationStore.upsertSummary({ ...conv, lastMessage, lastSeq, unreadCount })
        → unreadCount 用服务端权威值；若该会话为活跃会话则不上涨并触发 markRead
```

---

## 8. 已知的降级点（对应后端未实现项）

| 能力 | 后端状态 | 前端降级方式 |
|---|---|---|
| `GET /api/v1/presence`（批量在线预取） | 未实现 | `presenceStore.prefetchSupported=false`；首屏用列表内嵌 `User.online` 快照；`presence.changed` 增量更新。代价：首屏在线状态可能滞后 |
| `lastSeenAt`（最后在线时间） | 未提供（`presence.changed` 只有 `online`） | 只渲染在线/离线两态，无「最后在线 X 分钟前」 |
| `GET /api/v1/users/{userId}`（资料卡） | 未实现 | 暂用 `GET /users?q=<username>` 匹配；群成员资料卡只展示成员列表已有字段 |
| `DELETE /api/v1/friends/{userId}`（删好友） | 未实现 | 隐藏该按钮 |
| `conversation.member.changed`（WS 帧） | 未实现 | 他人视角的成员变更走 `conversation.updated` 整体替换；自己被移除走 `conversation.removed` |
| `ready` 的 `heartbeatIntervalMs` / `sessionExpiresAt` / `features` | 未提供（只有 `userId`） | 心跳用本地常量 25s；续期调度只用本地 `expiresAt`；不做特性门控，按全功能渲染 |
| `pong` 回显 `clientTs`（测 RTT） | 未实现（空 `data`） | 改用「收到任意帧即活性」的看门狗策略，不测 RTT |

全部条目的完整差异与处置见 `docs/contract/diff-report.md`。

