# 01 · 范围与验收标准

> 事实源：`backend/API.md` + `backend/openapi.json`（v0.2.0）。
> 本文只写**能做与不能做**以及**怎么算做完**，不重复接口细节（那是 `contracts/` 与 `docs/contract/`）。

---

## 1. 本期范围（MVP，全部已实现）

后端 agent 声明的本期范围与本方一致，共 12 项：

| # | 能力 | 前端承载 | 后端承载 |
|---|---|---|---|
| 1 | 注册 / 登录 / 注销 | `LoginView` · `RegisterView` · `stores/auth` | `POST /auth/register` `/login` `/logout` |
| 2 | 会话校验与滑动续期 | `stores/auth.doRefresh()`（到期前 60 秒静默） | `GET /auth/session` · `POST /auth/session/refresh` |
| 3 | 用户资料读取与编辑 | `ConversationInfoView` 的资料区 | `GET/PATCH /users/me` |
| 4 | 用户搜索 | `NewFriendView` 搜索框 | `GET /users?q=&limit=&offset=` |
| 5 | 好友申请（发起 / 列表 / 通过 / 拒绝） | `NewFriendView` · `ContactPanel` | `POST /friend-requests` · `GET /friend-requests` · `POST /friend-requests/:id/respond` |
| 6 | 好友列表 | `ContactPanel` | `GET /friends` |
| 7 | 单聊 | `MessagePane` · `stores/message` | `POST /conversations/direct` · `GET /conversations/:id/messages` · `POST .../messages` |
| 8 | 群聊（建群 / 成员增删 / 群名 / 退群） | `GroupCreateModal` · `ConversationInfoView` | `POST /conversations/group` · `POST/DELETE .../members` · `PATCH /conversations/:id` |
| 9 | 文本消息持久化 | 乐观发送 + 三层去重 | SQLite + `(senderId,clientMsgId)` 唯一索引 |
| 10 | 历史消息分页 / 断线增量同步 | `MessagePane` → `messageStore.loadOlder` / `catchUp()` | `GET .../messages?beforeSeq=&afterSeq=` · `POST /sync` |
| 11 | 未读 / 已读 | 会话列表红点 · 群聊「N 人已读」· 单聊已读标记 | `POST .../read` · WS `conversation.read` |
| 12 | 在线状态 / 输入状态 | `PresenceDot` · `TypingIndicator` | WS `presence.changed` · `typing.changed` |

---

## 2. 明确不做（二期）

| 项 | 为什么二期 | 契约影响 |
|---|---|---|
| 音视频通话 | WebRTC + STUN/TURN，是独立工程，与消息系统几乎无耦合 | 无 |
| 附件（图片 / 文件）上传 | 需要对象存储 + 直传签名 + 进度事件 + `Message` 的类型扩展。独立话题 | `Message.type` 需从 `text|system` 扩展 `image|file`，`content` 需语义化 —— **二期必须走契约变更流程** |
| 支付 | 与本项目无关 | 无 |
| 生产级多实例部署 | 需要会话粘性 / Redis pub-sub 跨实例广播 / 在线状态共享。当前 presence 是**单进程瞬时状态**（后端明示） | 无（但在线状态语义会变） |
| 消息撤回 / 编辑 | 前端需要「已发送消息的变更」这一新概念 | 需新增 WS 事件与 REST 端点 |
| 消息全文搜索 | 需要后端索引 | 需新增端点 |
| 好友删除 | 后端列为「后续追加」 | `DELETE /friends/:userId` |
| 用户资料卡（独立端点） | 后端列为「后续追加」 | `GET /users/:userId` |
| 批量在线状态预取 | 后端列为「后续追加」 | `GET /presence?userIds=` |
| 群主转让 / 解散群 | MVP 明确不做；群主退群返回 `OWNER_CANNOT_LEAVE` | 需新增端点 |
| 自定义头像上传 | `avatarUrl` 目前只接受 HTTPS URL，无上传端点 | 需 multipart 端点 + 对象存储 |

> **`Message.type` 的枚举扩展是二期最需要谨慎的一处**：当前后端为 `["text","system"]`，前端 `normalizeMessageType()` 对白名单外的值一律降级为 `text`。新增 `image` 时必须**双方 ACK + bump minor**，否则前端会把图片消息当纯文本渲染（`content` 是 URL，会显示成一串链接）。

---

## 3. 验收标准（可验证，非功能描述）

### 3.1 前端独立可跑（Mock 模式，零后端）

前置：`cd frontend && npm install && npm run dev` + 另开终端 `npm run mock:ws`。

| # | 验收项 | 期望效果 |
|---|---|---|
| A1 | 未登录访问 `/chat` | 自动跳 `/login?next=/chat` |
| A2 | 使用 mock 账号登录 | 进入 `/chat`，看到会话列表（含未读红点、最后消息预览、时间、在线圆点） |
| A3 | 点开单聊 | URL 变 `/chat/<convId>`，加载最近 30 条历史；自己消息靠右、对方靠左；含时间分隔条 |
| A4 | 点开群聊 | 同布局，且**发送者昵称显示在气泡上方**；system 消息渲染为居中灰色提示条 |
| A5 | 输入文本按 Enter | 消息**立即**出现在右侧（乐观 `sending` 态）→ 约 300ms 后变 `sent` |
| A6 | 向上滚动到顶 | 触发 `useInfiniteMessages` 加载更早 30 条，**滚动位置不跳动** |
| A7 | 建群（rail 加号 → 选好友 → 填群名） | 会话列表**立即**多出一项群聊；进入后成员列表正确，出现「XX 加入了群聊」系统消息 |
| A8 | 群内发消息后 mock 让其他成员已读 | 「N 人已读」计数递增 |
| A9 | mock 推 `typing.changed`（`active:true`） | 消息区顶部出现「XX 正在输入…」；**6 秒无后续自动消失**（验证 TTL 清理） |
| A10 | mock 推 `presence.changed` | 头像旁在线圆点实时变色 |
| A11 | 点主题切换 | **无残留白底 / 黑字** |
| A12 | 修改 `theme.css` 的 `--color-brand-500` 一处 | 全站主色随之改变（验证主题层解耦） |
| A13 | `npx vue-tsc --noEmit` | 零错误 |
| A14 | `npm run build` | 零错误，且 `strip-mock-worker` 校验通过 |
| A15 | `grep -rn "微信|WeChat" frontend/src` | 零命中 |

### 3.2 端到端（真实后端）

前置：`cd backend && npm run dev`（需用户手动启动）；`cd frontend && npm run dev -- --mode integration`。
完整逐条勾选清单见 `docs/08-runbook-verify.md`。摘要：

| # | 验收项 | 期望效果 |
|---|---|---|
| B1 | `curl http://127.0.0.1:3001/api/v1/health` | 200，`serverTime` 合法 ISO 8601 UTC，`protocolVersion === 1` |
| B2 | `node scripts/check-contract.mjs` | `ERROR 0` |
| B3 | 双浏览器（普通 + 隐身）加好友 | 通过后**双方**会话列表都能出现会话（需点「发消息」触发 `direct`） |
| B4 | 发消息 | 对端 **1 秒内**收到，气泡靠左；发送方状态由 `sending` → `sent` |
| B5 | 对端阅读 | 对端红点清零；**发送方看到「已读」标记** |
| B6 | 群聊全流程 | 建群 → 成员实时收到 → 发消息 → 「N 人已读」递增 → 移除成员 → 被移除者会话消失 + toast |
| B7 | 在线状态 | 对端关标签页 → 3 秒内变灰；重开 → 3 秒内变绿 |
| B8 | 输入状态 | 打字 → 对端 1 秒内看到「正在输入…」；停手 6 秒后消失 |
| B9 | F5 刷新 | 会话列表与历史消息完全一致，**无重复、无缺失** |
| B10 | DevTools → Offline → 对端发 5 条 → 恢复 Online | **5 秒内**自动重连并补齐 5 条，顺序正确无重复 |
| B11 | Offline 下发 2 条（进 outbox）→ 恢复 | 最终只产生 **2 条**（不是 4 条）—— 验证 `clientMsgId` 幂等 |
| B12 | DevTools Network 看重连 | 重连时**重新调用** `/auth/ws-ticket`，且 ticket 值不同（**不复用**） |
| B13 | 造 200 条历史后向上滚动 | 无重复 seq、无缺失 seq |
| B14 | 同账号开两个标签页，A 发消息 | B 实时出现且**不重复** |
| B15 | 手工改坏 `localStorage` 的 token 后刷新 | 干净跳登录页，**无控制台异常堆栈** |
| B16 | 群主尝试退群 | 按钮禁用并提示「群主需先转让或解散（二期）」（或收到 `OWNER_CANNOT_LEAVE` 后提示） |

### 3.3 交付物检查

| # | 检查 | 期望 |
|---|---|---|
| C1 | `cd frontend && npx vue-tsc --noEmit` | 零错误 |
| C2 | `cd frontend && npm run build` | 零错误 |
| C3 | `grep -rl "msw|mockServiceWorker" frontend/dist` | 零命中 |
| C4 | `cd frontend && npm run test` | 通过 |
| C5 | `node scripts/check-contract.mjs` | `ERROR 0` |
| C6 | `node scripts/check-contract.mjs --self-test` | 4 类注入缺陷全部命中（证明门禁非永远绿灯） |
| C7 | `docs/08-runbook-verify.md` | 全部条目通过并留档 |

---

## 4. 两条不可协商的红线

1. **消息文本永不 HTML 注入**。`content` 与昵称一律 `{{ }}` 插值。二期富文本必须走「白名单 markdown → 结构化节点渲染」而不是 HTML 字符串。这条没有例外 —— 因为认证用的是 localStorage 里的 opaque token，XSS 的影响被直接放大。
2. **排序只用 `seq`**。任何 `createdAt` 排序都会在时钟偏移下产生消息跳跃，且会破坏缺口检测与分页游标的语义。

