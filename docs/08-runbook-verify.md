# 08 · 端到端联调勾选清单

> 逐条勾选，每条都要能看到具体效果。**任一条失败都不得宣称联调通过。**
> 前置：后端已启动（`cd backend && npm run dev`，端口 3001），前端已启动（`cd frontend && npm run dev -- --mode integration`）。

---

## 0. 前置门禁（不过就别往下走）

| ☐ | 检查 | 命令 / 操作 | 期望 | 失败时先做什么 |
|---|---|---|---|---|
| ☐ | 后端进程活着 | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/v1/health` | `200` | 端口 3001 是否被占？后端是否真的起来了？ |
| ☐ | 健康体字段正确 | `curl -s http://127.0.0.1:3001/api/v1/health` | `status=ok`，`protocolVersion=1`，`serverTime` 为合法 ISO 8601 UTC | 字段名/类型不符 → 更新 `contracts/requirements/*.json` |
| ☐ | 契约门禁 | `node scripts/check-contract.mjs` | `ERROR 0` | 逐条看 ERROR，发 `[CONTRACT]` 给后端 |
| ☐ | 门禁本身有效 | `node scripts/check-contract.mjs --self-test` | 4 类缺陷全部命中 | 门禁失效则本清单的结论都不可信 |
| ☐ | 前端类型 | `cd frontend && npx vue-tsc --noEmit` | 零错误 | — |
| ☐ | 前端代理 | 浏览器 Network 看 `http://localhost:5173/api/v1/health` | 200（经代理，非直连） | 检查 `vite.config.ts` 的 `/health` 代理规则 |

---

## 1. 认证与会话

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | 未登录直接访问 `http://localhost:5173/chat` | 自动跳 `/login?next=/chat` |
| ☐ | 注册一个新账号（新用户名） | 直接进入 `/chat`，无需二次登录 |
| ☐ | 重复用同用户名注册 | 表单该字段报错（`USERNAME_TAKEN`），不跳页 |
| ☐ | 错误密码登录 | 提示凭据错误（`INVALID_CREDENTIALS`）；**注意：不区分「用户不存在」与「密码错误」** |
| ☐ | 正确登录 | 进入 `/chat`；浏览器 DevTools → Application → Local Storage 有 `aitrance.session` |
| ☐ | **刷新页面（F5）** | 仍处于登录态（`bootstrap()` 用 `GET /auth/session` 校验成功），**不闪回登录页** |
| ☐ | 点登出 | 回到 `/login`；`localStorage` 中 `aitrance.session` 被清除；WS 连接关闭 |
| ☐ | **滑动续期**：把后端 token TTL 临时调短（如 120 秒），登录后静默等待 90 秒 | 期间**不发**任何 401 跳登录；`localStorage` 的 `aitrance.sessionExpiresAt` 被后移；**token 值不变**（不轮换） |

> 最后一条是关键：若后端把 refresh 实现成了轮换 token，这个测试会表现为「多标签页互相踢下线」。届时发 `[CONTRACT]` 要求改为不轮换。

---

## 2. 好友

准备：两个浏览器 —— **普通窗口 alice**、**隐身窗口 bob**（隐身窗口保证独立 session）。

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | alice 在 `/chat/new` 搜索 bob 的用户名 | 出现搜索结果；matching 用户名高亮（后端对用户名/昵称模糊匹配） |
| ☐ | alice 点「加好友」，填附言，发送 | 按钮变为「已发送」；`note` 必须传（后端 `note` 在 openapi 中为 required） |
| ☐ | **bob 端** | **实时**收到好友申请（WS `friend.requested`）；`ContactPanel` 出现待处理条目 + toast |
| ☐ | bob 通过申请 | 条目从待处理列表移出；`friend.resolved` 到达；alice 端会话/好友状态同步 |
| ☐ | **验证「通过申请不会自动建私聊」** | bob 与 alice 的会话列表**此时可能都还没有**对方会话 —— 这是**正确行为**（后端不自动创建） |
| ☐ | alice 点 bob 的「发消息」 | 触发 `POST /conversations/direct` → **双方**会话列表各出现一个单聊（对端通过 `conversation.created` 收到） |
| ☐ | 重复点 alice 的「发消息」 | **不新建**会话（幂等，返回 200 既有会话） |
| ☐ | bob 拒绝另一个申请 | 拒绝方与被拒方都收到 `friend.resolved`；被拒方可**重新**申请 |

---

## 3. 单聊消息

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | alice 发「你好」 | 气泡**立即**出现在右侧（乐观 `sending`）→ 约 300ms 变 `sent` |
| ☐ | bob 端观察 | **1 秒内**收到，气泡**靠左** |
| ☐ | bob 端 Network/WS 看帧 | 收到 `message.created`，`data` 含 `message` 与 `unreadCount` |
| ☐ | **检查消息不重复** | bob 端只有 **1 条**（不是 2 条）—— 验证层2 去重（REST 返回与 WS 推送必然重叠） |
| ☐ | bob 打开该会话 | bob 端红点清零 |
| ☐ | alice 端观察 | 出现**「已读」标记**（WS `conversation.read`，`userId` 为 bob） |
| ☐ | alice 连发 10 条 | bob 端全部按 seq 顺序出现，无重复无缺失 |
| ☐ | **验证未读不清零的语义**：alice 先发 20 条，bob 只滚动阅读前 10 条（不打开最新） | bob 端未读数**可能不为 0** —— 这是**正确行为**（未读按实际剩余消息算） |
| ☐ | 输入超长文本（>4000 字） | 前端字数警告，发送被阻止 |
| ☐ | 输入纯空格后发送 | 发送按钮禁用（后端也会因 `pattern: \S` 拒绝） |

---

## 4. 群聊

准备：三个浏览器身份 —— alice（群主）、bob、carol。

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | alice 在 rail 点加号 → 选 bob + carol → 填群名「测试群」→ 创建 | 会话列表**立即**多出一项群聊（`201`，**不乐观插入** —— 需要服务端生成的 id） |
| ☐ | bob / carol 端 | **实时**收到 `conversation.created`；会话列表自动多出一项 |
| ☐ | 三方都进入群聊 | 成员列表正确；出现「alice 邀请 … 加入群聊」的 system 消息 |
| ☐ | **检查 system 消息占 seq** | system 消息与 text 消息序号连续（不跳号）—— 用 DevTools WS 帧核对 seq |
| ☐ | alice 在群里发消息 | bob 与 carol **都**收到；**发送者昵称显示在气泡上方** |
| ☐ | carol 打开群聊（已读） | alice 端显示「**1 人已读**」；carol 端不显示计数（自己已读不算） |
| ☐ | bob 也打开群聊 | alice 端变「**2 人已读**」 |
| ☐ | alice 改群名 | 三方实时看到新群名（`title` 更新，`conversation.updated`） |
| ☐ | alice 添加一个新好友 dave 入群 | dave 端收到 `conversation.created`（**新成员可查看全部群历史**，入群前消息作为已读起点） |
| ☐ | alice 移除 carol | **carol 端**：会话从列表消失 + toast「你已被移出群聊」（`conversation.removed`，这是**唯一**通知路径） |
| ☐ | **验证移除后无事件泄露** | carol 端**不再**收到该群的任何 `message.created` / `conversation.updated` |
| ☐ | carol 尝试直接访问 `/chat/<原群id>` | 后端返回 404；前端不崩溃（应清本地项并返回列表） |
| ☐ | bob 尝试改名（非群主） | 按钮禁用；若强行请求，后端返回 `403 OWNER_REQUIRED` |
| ☐ | alice（群主）尝试退群 | 按钮禁用并提示「群主需先转让或解散（二期）」；后端返回 `409 OWNER_CANNOT_LEAVE` |
| ☐ | bob（普通成员）退群 | 成功；bob 端该会话消失；群内其他人看到「bob 退出群聊」的 system 消息 |
| ☐ | **检查移除后 `{ok:true}` 的处理** | alice 移除成员后，其本地成员列表**刷新正确**（后端只返回 `{ok:true}`，前端需重取详情或本地移除） |

---

## 5. 在线状态与输入状态

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | bob 打开页面（有 WS 连接） | alice 端 bob 头像旁显示**在线**圆点 |
| ☐ | bob 关闭浏览器标签页 | alice 端 **3 秒内**变为**离线**（WS `presence.changed`） |
| ☐ | bob 重新打开 | **3 秒内**恢复在线 |
| ☐ | **检查推送范围** | 用一个与 alice、bob 都**无共同会话**的第三方账号观察 —— **不应**收到任何 `presence.changed`（后端只推给好友与同群成员） |
| ☐ | alice 在单聊里打字（不发送） | bob 端**1 秒内**看到「alice 正在输入…」 |
| ☐ | alice 停手不动 6 秒 | bob 端提示**自动消失**（前端 6 秒 TTL 清理，不依赖对端发 `active:false`） |
| ☐ | alice 打字后立刻切走会话 | bob 端提示立即消失（前端发送 `active:false`） |
| ☐ | **检查 typing 不回推自己** | alice 端**不应**看到「alice 正在输入…」 |
| ☐ | 群里 bob 与 carol 同时打字 | 最多展示 2 人 + 「等 N 人」（若实现了该上限） |

---

## 6. 断线、重连与补偿

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | alice 打开 DevTools → Network → **Offline** | 前端显示「连接已断开，正在重连…」toast（仅首次） |
| ☐ | 保持 Offline，bob 发 5 条消息 | alice 端**看不到**这 5 条 |
| ☐ | alice 恢复 **Online** | **5 秒内**自动重连；5 条消息全部补齐，**顺序正确、无重复** |
| ☐ | alice Offline 状态下自己发 2 条（进 outbox，显示 `sending` 或 `failed`） | 恢复网络后只产生 **2 条**（不是 4 条）—— 验证 `clientMsgId` 幂等 |
| ☐ | **检查重连时重新取票据** | DevTools Network 中看到重连前有一次新的 `POST /api/v1/auth/ws-ticket`；ticket 值**与上次不同** |
| ☐ | 手工让后端以 `4001` 关闭（或让一个已用过的 ticket 重连） | 前端**立即**重新取票据并重连，**不走退避**（不出现等待数秒的现象） |
| ☐ | 造 200 条历史消息后，alice 向上滚动 | 连续加载，**无重复 seq、无缺失 seq**，滚动位置不跳动 |
| ☐ | alice 关闭页面再打开（冷启动） | 会话列表与历史消息**完全一致**，无重复无缺失 |
| ☐ | 短时断网重连后检查群聊 | 断线期间的群成员变更、好友变更、在线状态由 **REST 当前状态**校正（WS 不重放事件） |

### 6.1 幂等与并发

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | 双击发送按钮（或用脚本连发同一 `clientMsgId`） | 只产生 **1 条**消息（`201` + `200` 原消息） |
| ☐ | 对同一条失败消息连点「重试」3 次 | 只产生 **1 条**（复用原 `clientMsgId`） |
| ☐ | 并发点「发消息」建单聊（连点 5 次） | 只产生 **1 个**会话（服务端 `(userA,userB)` 唯一索引） |
| ☐ | 多标签页同时打开同一会话 | 各自能收能发；同一消息**不重复**渲染 |

---

## 7. 多端与鉴权失败路径

| ☐ | 步骤 | 期望效果 |
|---|---|---|
| ☐ | 同一账号（alice）在**两个标签页**都登录 | 两个标签页各有独立 ticket、独立 WS 连接 |
| ☐ | 标签页 A 发消息 | 标签页 B **实时**出现该消息，且**不重复** |
| ☐ | 标签页 A 打开会话（已读） | 标签页 B 的红点**同时**清零（`conversation.read` 推给自己所有连接） |
| ☐ | 标签页 A 登出 | 标签页 B 收到 `1008` 或 `session.revoked` 后**清凭据 + 跳登录**，不无限重连 |
| ☐ | 手工把 `localStorage["aitrance.session"]` 改成乱码后刷新 | 干净跳登录页；**控制台无未捕获异常堆栈** |
| ☐ | 手工删掉 `localStorage` 的 token（只留 `sessionExpiresAt`）后刷新 | 同样干净跳登录 |
| ☐ | 打开第 6 个标签页（同一账号） | 第 6 条连接被以 `1008` 关闭（每用户最多 5 条）—— 前端应提示而非静默失败 |

---

## 8. 交付物检查

| ☐ | 检查 | 命令 | 期望 |
|---|---|---|---|
| ☐ | 类型检查 | `cd frontend && npx vue-tsc --noEmit` | 零错误 |
| ☐ | 构建 | `cd frontend && npm run build` | 零错误，`strip-mock-worker` 校验通过 |
| ☐ | 产物无 mock | `grep -rl "msw|mockServiceWorker" frontend/dist` | 零命中 |
| ☐ | 单测 | `cd frontend && npm run test` | 通过 |
| ☐ | 契约门禁 | `node scripts/check-contract.mjs` | `ERROR 0` |
| ☐ | 门禁自检 | `node scripts/check-contract.mjs --self-test` | 4 类缺陷全部命中 |
| ☐ | 合规自检 | `grep -rn "微信|WeChat" frontend/src docs` | 零命中 |

---

## 9. 留档要求

本文全部条目通过后：

1. 在本文件末尾（或独立记录）注明**日期、参与账号、后端 openapi 版本、commit 或文件哈希**
2. 关键项（4、6、7 节）**附截图**
3. 在 `session.txt` 发 `[SYNC]` 通告完成，四段式：已完成 / 进行中 / 阻塞 / 需对方做什么

> **不得跳过第 0 节的前置门禁直接跑后续条目** —— 契约门禁未过时，后续所有「通过」都可能是假象（前后端各自对字段做了猜测性的兜底）。

---

## 10. 本轮实测留档（2026-09-28）

> 执行者：frontend（裸 Node 脚本直连 `http://127.0.0.1:3001`，非 UI 操作）
> 后端：`openapi.json` info.version `0.2.0`；服务由裸 `node --experimental-strip-types src/server.ts` 拉起
> 契约状态：`contract-v1.0` 已冻结（双方 ACK）

### 10.1 REST（20 项，全部通过）

| # | 项 | 实测 |
|---|---|---|
| 1 | 注册 | 201，返回 `{token, tokenType:'Bearer', expiresAt, user}` |
| 2 | 重复用户名注册 | 409 `USERNAME_TAKEN` |
| 3 | 缺 `displayName` / 空串 | 400 `VALIDATION_ERROR`（后端 schema `required` + `minLength:1`） |
| 4 | 错误密码登录 | 401 `INVALID_CREDENTIALS` |
| 5 | 发好友申请 | 201 |
| 6 | 重复申请 | 409 `REQUEST_PENDING` |
| 7 | 收件方看申请 | `{items:[...]}`，`sender.displayName` 正确 |
| 8 | 通过申请 | 200，`status='accepted'` |
| 9 | 好友列表 | `{items:[User], nextOffset:null}` |
| 10 | 建私聊 | 200，`type='single'`、`memberCount=2` |
| 11 | 重复建私聊 | 返回**同一** id（幂等） |
| 12 | 视角化 title | A 看 `title='Bob'`、B 看 `title='Alice'` |
| 13 | 发消息 | 201，`seq=1` |
| 14 | 同 `clientMsgId` 重发 | 200，**同 msgId、同 seq**（幂等） |
| 15 | 同 `clientMsgId` 改内容 | 409 `IDEMPOTENCY_CONFLICT` |
| 16 | 分页 `beforeSeq` | `hasMore`/`nextBeforeSeq` 正确，seq 升序 |
| 17 | 增量 `afterSeq` | 返回 `seq > afterSeq` 的消息（断线补偿依赖） |
| 18 | 已读上报 | 204 无正文；B 的 `unreadCount` 清零 |
| 19 | 已读不回退 | 提交更小值仍 204，`lastReadSeq` 保持不变 |
| 20 | 未来游标 / 非成员访问 | 400 `INVALID_READ_CURSOR`；404 `CONVERSATION_NOT_FOUND`（不泄露存在性） |

### 10.2 WebSocket 连接层（8 项，全部通过）

| # | 项 | 实测 |
|---|---|---|
| 21 | ticket 一次性 | 同 ticket 二次握手 `4001` "Invalid or expired ticket" |
| 22 | 协议版本 `v=99` | `4002` |
| 23 | 无 ticket | `4001` |
| 24 | `typing.changed` 中继 | 对方收到 1 帧，**发送者自己 0 帧**（不回推） |
| 25 | `message.created` | 发送者 `unreadCount=0`、接收者 `unreadCount=1`，双方各 1 帧 |
| 26 | `conversation.read` | 对方与**自己**都收到，`unreadCount` 为各自权威值（多端一致依据） |
| 27 | `presence.changed` | 对端断连后收到 `{userId, online:false}` |
| 28 | 未知帧类型 | `error {code:'INVALID_EVENT'}` |

`ready.data` 实测 = `{userId, serverTime, protocolVersion:1}`，与冻结契约逐字一致。

### 10.3 双浏览器 UI 验收（Playwright + 真实 Chrome，45 项，全部通过）

执行方式：`playwright.launch({ channel: 'chrome' })`，两个独立 `BrowserContext` 等价于两个隐身窗；后端服务运行中，前端以 `--mode integration`（关闭 Mock）启动。

| 组 | 项 | 结果 |
|---|---|---|
| 基础 | 未登录访问 `/chat` 重定向到 `/login?next=/chat` | PASS |
| 基础 | 空昵称注册（回填用户名）成功进入 `/chat` | PASS |
| 基础 | 主题切换：`data-theme` light↔dark，深色下 body 背景 `rgb(15,18,22)` | PASS |
| 好友 | A 搜索用户名 → 点「加好友」→ 按钮变「已发送」 | PASS |
| 好友 | B 端「新的朋友」出现申请 → 点「通过」→ 自动进入会话 | PASS |
| 好友 | A 刷新后好友列表出现 B，点击进入单聊 | PASS |
| 单聊 | 消息区标题为对方昵称；自己的气泡靠右深色 | PASS |
| 单聊 | A 发送 → B **实时**收到；B 回复 → A 实时收到 | PASS |
| 群聊 | 建群弹窗 → 选成员 → 填群名 → 创建并进入群会话 | PASS |
| 群聊 | B 端**未刷新**即实时多出该群会话（`1 → 2`） | PASS |
| 群聊 | B 端会话预览实时更新为最新消息 | PASS |
| 群聊 | 群聊气泡上方显示发送者昵称（群聊必需） | PASS |
| 群聊 | A 端出现已读计数元素 | PASS |
| 未读 | B 不在该会话时收消息，会话列表出现未读红点 | PASS |
| 输入态 | A 输入时 B 端出现 `.typing` 提示 | PASS |
| 在线态 | B 在线 → A 首屏即为**绿点**（播种生效） | PASS |
| 在线态 | B 关闭标签页 → A 端 3s 内变灰 | PASS |
| 断线 | A 离线期间 B 发 3 条 → A 恢复后 6s 内补齐 3 条且**无重复** | PASS |
| 断线 | A 离线发送失败 → 出现「重试」按钮 → 重试后**恰好一条**（幂等） | PASS |
| 断线 | B 端也只看到一条（服务端 `(senderId, clientMsgId)` 唯一性生效） | PASS |
| 多端 | 同账号第二标签页实时同步到新消息，第一页无重复渲染 | PASS |

### 10.4 本轮 UI 验收抓出的真实缺陷（共 3 个，均已修）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 群聊会话列表预览显示成「**：群实时消息**」（冒号前为空） | `ConversationItem.senderName()` 只在 `conversation.peer` 里找名字，而群聊的 `peer` 恒为 `null`，前缀退化为空串仍被拼接 | 名字改从「会话详情 `members[]`」查；查不到时**省略前缀**而不是留一个孤零零的冒号。另在 `ChatView` 首屏为有消息的群聊预取详情（限量 10 个） |
| 2 | **在线绿点永远不亮**（圆点恒为灰） | `normalize.toUserBrief()` 漏掉了 `online` 字段，`presence.seedFromLists()` 拿到的永远是 `undefined`，播种静默失效 | `UserBrief` 补 `online?: boolean` 并透传；`seedFromLists` 改为直接读 `m.user.online` 类型化访问 |
| 3 | **打开会话时首屏就是全部历史**（例：120 条一次全加载），`min seq` 直接为 1，用户永远看不到「向上加载更多」 | `ws/handlers.ts` 的重连补偿按 `serverSeq > localSeq` 判缺口，而**从未打开过的会话本地 `lastSeq` 恒为 0**，于是每个未打开会话都被判定「缺全部历史」并全量补齐。20 个活跃群 × 数百条 → 一次登录拉几万条 | 补偿只对**已打开过**的会话生效（新增 `messageStore.isLoaded()`，过滤加 `x.opened`）。未打开会话只需摘要里的 `lastMessage`/`unreadCount`（第 2 步已刷新），消息体等用户点进去再拉 |

> 三个缺陷都**不报错、不抛异常**，脚本层的 REST/WS 断言也全绿 —— 只有真实浏览器渲染出来才看得见。缺陷 3 尤其隐蔽：表面上「消息都能看到」，实际分页功能已死。这正是「脚本不能替代 UI 验收」的具体例子。
> 已为缺陷 2 补 2 条单测（`normalize.test.ts`），钉住 `online` 透传与「缺失时为 `undefined` 而非 `false`」的语义。单测数 25 → 27。
> 缺陷 3 由 10.5 的分页复验发现（修复前首屏 120 条、修复后 30 条）。

### 10.5 长历史分页与深色模式（补验，全部通过）

**分页视口稳定性**（120 条历史，A/B 交替发送以规避 60 条/分/用户的限流）：

| 项 | 结果 |
|---|---|
| 首屏只加载最新一页 | 30 条，seq `91~120`，max 与服务端最大 seq 一致 |
| 首屏不是全部（说明可分页） | `30 < 120` |
| 向上翻页加载更早消息 | `30 -> 90` 条，min seq `91 -> 31` |
| 翻页后离开顶部 | `scrollTop = 2135` |
| **锚点消息漂移** | **0.0px**（视口完全不跳动） |
| 连续翻到底 | 120 条，seq `1~120` |
| 无重复 / 无缺失 seq | 120/120，连续 `1~120` |

> 测法说明：锚点在**触发加载后、加载完成前**取样，加载完成后再取一次比对。第一次测出的「1664px 漂移」其实是测试脚本自己把 `scrollTop` 跳到 0 造成的 —— 测试写错会伪装成产品缺陷，这轮已修正测量时序。

**深色模式走查**（会话页 / 消息区 / 联系人页 / 建群弹窗 / 群资料页）：

| 区域 | 结果 |
|---|---|
| 会话列表容器 / 标题 / 预览、左侧边栏 | 对比正常（`bg rgb(23,27,33)` / `fg rgb(230,233,238)`） |
| 消息区画布 / 头部标题 | 对比正常（画布 `rgb(15,18,22)`） |
| 自己气泡 | `bg rgb(23,109,143)` + 白字，正常 |
| 对方气泡 | `bg rgb(35,41,50)`（亮度 0.16，深底浅字），正常 |
| 联系人面板 / 标签栏 / 好友行 | 对比正常 |
| 建群弹窗面板 / 标题 / 输入框 | 对比正常 |
| 群资料页容器 / 标题 / 成员行 | 对比正常 |
| 全局兜底扫描：深色下亮度 > 0.85 的大块背景 | **0 处** |

### 10.6 运行方式（已按标准方式启动并复验）

后端已改用项目自带脚本启动，与文档建议一致：

```bash
cd backend && npm run dev
# 实际展开：node --watch --env-file-if-exists=.env --experimental-strip-types src/server.ts
```

| 项 | 实测 |
|---|---|
| `GET /api/v1/health` | 200 `{status:'ok', version:'0.2.0', protocolVersion:1}` |
| `GET /health`（无前缀） | 200，与上者同模型 |
| 前端（`vite --mode integration`，5173）经代理访问 health | 200，同模型 |
| 启动后回归冒烟 | **7/7 通过**（注册+自动登录+WS 建连 / 好友申请送达 / 通过后自动进会话 / A 发消息走 REST / B 实时收到 WS 推送 / 在线绿点正常「缺陷 2 回归点」/ 消息条数合理「缺陷 3 回归点」），console 无 error |

> **注意**：Vite dev server 只监听 `[::1]`（IPv6 回环），`127.0.0.1:5173` 会被拒。浏览器请用 **`http://localhost:5173`**。

**已无未完成项。** 本轮三项债（npm run dev 重启 / 分页视口 / 深色其余页）全部清零。

> 按 pm 一贯口径，此处只陈述「本轮清单已空」，不宣称「零债交付」 —— 长尾场景（极端并发、弱网抖动、超大群、多实例部署等）未穷尽。

### 10.7 证据截图

关键项截图归档于 `docs/evidence/`（按 runbook §9 的留档要求）：

| 文件 | 内容 |
|---|---|
| `dark-chat.png` | 深色模式 · 消息区（自己气泡 / 对方气泡对比度） |
| `dark-peer.png` | 深色模式 · 对方气泡特写 |
| `dark-contacts.png` | 深色模式 · 联系人页 |
| `dark-modal.png` | 深色模式 · 建群弹窗 |
| `dark-groupinfo.png` | 深色模式 · 群资料页 |
| `group-realtime.png` | 群聊实时：对端未刷新即出现群会话 |
| `unread-badge.png` | 未读红点 |
| `reconnect-retry.png` | 断线后发送失败 → 「重试」按钮 |
| `public-chat.png` | 公网 · 会话页（发消息成功后） |
| `public-deeplink-cold.png` | 公网 · **冷启动直连深链**（新开页面直接 goto `/chat/chat/:id`） |
| `public-deeplink-reload.png` | 公网 · 原地刷新（F5）后 |

> 截图取自 Playwright 的真实 Chrome 渲染，不是 mock 数据下的界面。
> `public-*` 三张取自「本机修复后源码 + 公网后端」的联调环境，见 §11。

### 10.8 一处非阻塞发现

`POST /api/v1/auth/ws-ticket` 在**带 `Content-Type: application/json` 且带空字符串 body** 时返回 400 `BAD_REQUEST`（"Body cannot be empty when content-type is set to 'application/json'"）。三个无 requestBody 端点（`ws-ticket`/`session/refresh`/`logout`）均如此。

- 前端不受影响：axios 在 `data` 为 `undefined/null` 时**不带**该头，四个调用实测均 200。
- 已实测否掉两种「修法」：手动 `delete` 该头会退回 axios 的 `application/x-www-form-urlencoded` 默认值 → **415**；显式置 `undefined` 同样 415。故保持现状。
- 后端已选定「文档澄清」并在 `API.md` 公共约定与第 3 节注明：这三个端点只带 `Authorization`，不要 `Content-Type`、不要 `body: ''`。
- 我方实测否掉了自己先前提的两种「修法」：手动 `delete` 该头会让 axios 退回 `application/x-www-form-urlencoded` → **415**；显式置 `undefined` 同样 415。故保持 axios 现状（`data` 为 `null` 时它本就不发该头）。

## 11. 公网部署验收留档（2026-09-28，第二批）

针对后端 `[BLOCK]`「直接刷新 /chat/chat/:convId 时消息列表有预览、气泡为空」，做了一轮**公网真实环境**验收。

### 11.1 环境与方式

| 项 | 值 |
|---|---|
| 前端 | **本机 dev（修复后的源码）**，`--mode integration`（关 MSW），代理到公网后端 |
| 后端 | `http://mikuyun.xyz/chat/api`（线上 systemd `aitrance-chat.service`，Node 24，仅 loopback 3001） |
| 反代 | 线上 Nginx 1.24，`/chat/` -> 静态产物，`/chat/api/` -> `127.0.0.1:3001/api/`，`/chat/ws` -> `ws://127.0.0.1:3001/ws` |
| 驱动 | Playwright + 本机真实 Chrome，1280x800 |
| 脚本 | `frontend/e2e-public-deeplink.mjs`（12 项断言） |

> 本机 dev 代理公网后端需 `VITE_PROXY_ORIGIN_OVERRIDE=1`：后端对 loopback 以外的来源做 Origin 校验，直代会得到 HTTP 403「不允许的请求来源」与 WS 握手 403。该开关把 Origin/Referer 改写成后端自己的源并补 `X-Forwarded-For`，与线上 Nginx 反代一致。

### 11.2 结果（连跑 2 次，均为 12 项断言 0 失败）

| # | 断言 | 结果 |
|---|---|---|
| 1 | 注册探针账号（201 新建 / 409 已存在） | PASS（409，上一轮已建） |
| 2 | 登录后跳转到 /chat | PASS |
| 3 | 新用户自动与 QJQ 成为好友（无需审批） | PASS（好友数 1，对方「柒玖柒」） |
| 4 | 与 QJQ 的单聊会话可建 | PASS |
| 5 | 发送消息后气泡出现（REST + WS 链路） | PASS |
| 6 | **WebSocket 已连上并收到 ready 帧** | PASS（抓 `framereceived`，ready 帧 2 个） |
| 7 | **冷启动直连深链：消息气泡渲染** | PASS（bubble 数随累积 5→8，含刚发那条） |
| 8 | 深链不是空态（未命中「还没有消息」占位） | PASS（`.pane__blank=0`） |
| 9 | 深链页面已识别到会话（非「会话不存在」分支） | PASS |
| 10 | 无 4xx/5xx 响应 | PASS |
| 11 | 原地刷新（F5）后消息仍在 | PASS |
| 12 | 无未预期的 JS 运行时错误 | PASS |

**验证范围的边界（必读）**：第 6~12 项跑的是**本机修复后源码**。线上 `/chat` 的静态产物构建于 14:01，**不含**本轮修复，因此线上深链问题在重新构建部署前依然存在。部署由 backend 负责。

### 11.3 本轮抓出的真实缺陷（共 2 个，均已修）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 4 | **深链/刷新后气泡全空**（`BLOCK` 所述） | `MessagePane` 挂载时 `conversation` 尚未就位，`enterConversation` 首行裸 `return`，`ensureLoaded` **从未被调用**；`ChatView.fetchAll()` 完成后也不回头触发 | 摘要缺失时置 `awaitingSummary` 标记；新增 `watch(conversation)` 在摘要就绪时补做（**仅标记为真时触发**，避免每次 `fetchAll` 重跑进入流程、重复上报已读）；进入流程加 `enterGen` 令牌做可重入保护，切换会话时作废在途旧调用，防止旧会话历史返回后把视口滚到新会话 |
| 5 | 首屏控制台刷一片 404；`prefetchSupported` 永远翻不成 false | `api/presence.ts` 探测后端**未实现**的 `GET /presence`（契约 deferred 端点 X3），且 `(e as {status}).status` 在 axios 上恒为 `undefined`，`isUnimplemented` 永远为假 -> 404 被当真实错误上抛 -> 降级路径从未真正生效 | 改用 `toApiError(e).isUnimplemented` 判断；新增 `PROBE_PRESENCE_ENDPOINT` 开关**默认不探测**（后端补该端点后改 `true` 即启用）。降级到列表内嵌 `online` 快照本就是契约约定的 fallback |

> 缺陷 5 的教训与 10.4 一致：它**不报错、不抛异常**，功能表面正常（在线状态走的是降级路径），只有浏览器控制台与网络面板能看见。另外它一度伪装成「后端有 bug」——实际上后端 404 是正确行为，错在前端明知端点 deferred 还去探测。

### 11.4 验收脚本自身的两处修正（避免误报）

1. **API 基址**：页面在 `/chat/chat` 下，相对路径 `/api/v1/...` 会被解析到站点根，打到原站（3000）的 API 上，返回 200 但内容不相干 —— 曾误报成「自动加好友没生效」。改为显式拼 `BASE`。
2. **控制台断言分家**：把「无 4xx/5xx 响应」（带完整 URL + 状态码，由 `response` 事件驱动）与「无未预期 JS 运行时错误」拆成两条。「Failed to load resource」属前者，留在后者里会因浏览器是否重发 favicon 而**时有时无**，把断言变成掷骰子。

### 11.5 生产库写入说明

本轮在生产库创建了探针账号 `qja_probe`（昵称「前端验收探针」）及它发给 QJQ 的若干条验收消息。已在通道请求 backend 清理；密码不写入本仓库、不写入通道。

### 11.6 服务端诊断记录（只读）

| 项 | 值 |
|---|---|
| 主机 | 阿里云 Linux，nginx 1.24.0，负载 0.00 |
| 聊天后端 | systemd `aitrance-chat.service`，`User=aitrance`，`ProtectSystem=strict`，`ReadWritePaths=/var/lib/aitrance`，`NoNewPrivileges=true` |
| 运行时 | `/opt/aitrance/runtime` -> `node-v24.15.0-linux-x64`（生产独立 Node 24，未替换原站 Node 22） |
| 版本目录 | `/opt/aitrance/current` -> `releases/release-20260928-141619-autofriend`，切换用软链（可回滚） |
| 监听 | `127.0.0.1:3001` 聊天后端；原站 `*:3000` 未受影响；80 仅 nginx |
| 原站 | `/` 与 `/api/health` 均 200，未被改动 |

