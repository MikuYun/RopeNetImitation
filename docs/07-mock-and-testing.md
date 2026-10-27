# 07 · Mock 与测试

---

## 1. 为什么 Mock 层是必需品而不是可选项

后端由**另一个 agent 并行开发**，前端不能等它。Mock 层要同时满足三件事：

1. **零后端可完整演示**：所有页面、交互、状态流转都能跑通
2. **切真实后端只改一个开关**，业务代码零感知（无 `if (mock)` 分支）
3. **契约漂移能被立刻发现**，而不是等到联调

第 3 条最容易被忽略，也是本项目的核心风险 —— 两个 agent 各自发明字段名是必然趋势。

---

## 2. REST Mock：MSW v2

`frontend/mocks/rest/handlers.ts`（592 行）+ `frontend/mocks/fixtures/db.ts`（457 行）。

### 2.1 为什么是 MSW

Service Worker 层拦截，业务代码**零感知** —— 不需要 mock adapter 抽象，不需要 `if (import.meta.env.VITE_USE_MOCK)` 分支散落在业务里。切后端只改环境变量。

### 2.2 条件加载（关键）

`main.ts` 中按 `VITE_USE_MOCK` **动态** `import()`：

```ts
if (import.meta.env.VITE_USE_MOCK === "true") {
  const { startMockWorker } = await import("@/mocks/browser")
  await startMockWorker()
}
```

必须是**动态** import。静态 import 会把 msw 打进生产产物 —— `strip-mock-worker.mjs` 会因此让构建失败（这是设计上的门禁，不是提醒）。

### 2.3 handlers 刻意对齐真实 openapi

handler 的响应形状**刻意写成后端真实形状**（`{items,nextOffset}`、`{token,tokenType,expiresAt,user}`、`msgId`/`content`…），而不是我方 v0.1 提案的形状。

理由：这样前端的 `normalize.ts` 在 Mock 模式与真实后端下走的是**同一条路径**。若 handler 用提案形状，则 normalize 的降级分支会被 Mock 一直遮住，联调时才暴露。

每个 handler 头部的注释都指向 `docs/contract/diff-report.md` 的具体条目，便于回溯为什么是这个形状。

### 2.4 与 WS mock 共享数据源

`mocks/fixtures/db.ts` 是 REST handler 的**唯一**内存数据源，包含：用户表、好友关系表、好友申请表、会话表、成员表、消息表、已读游标表、在线状态表，以及 `nid()`（ID 生成）、`nowIso()`、`minutesAgo()`、`deliverMessage()`、`deliverSystemMessage()`、`issueSession()`、`issueTicket()` 等工具。

> WS mock 服务是**独立进程**（见 §3），无法直接共享这份内存。它在自己的进程内造一份最小视图，仅用于验证 WS 生命周期。这是已知取舍：Mock 模式下 REST 与 WS 的数据不完全一致，但**帧形状**严格一致 —— 而验证生命周期正是 WS mock 的唯一目的。

---

## 3. WS Mock：独立 Node 服务

`frontend/mocks/ws-server.mjs`（210 行），`npm run mock:ws`，端口 `3002`（避免与后端 3001 冲突），前端通过 `VITE_WS_MOCK_URL` 指向它。

### 3.1 为什么不用 MSW 的 WebSocket 支持

两个理由：

1. MSW 的 WS 实现随版本变化较大，把「验证重点」押在它的 API 稳定性上不划算
2. 更重要的：**MSW 无法真实验证这些路径** —— 一次性票据、指数退避、看门狗超时、`4001` 后立即重取票据、帧结构校验。而这些恰好是 `ws/client.ts` 里**最容易出 bug** 的部分

一个真实的 WS 服务（原生 `ws` 库，约 200 行）能让整条链路在 M1/M2 阶段就练熟。

### 3.2 它模拟了什么

| 能力 | 实现 |
|---|---|
| ticket 签发端点 | `POST /api/v1/auth/ws-ticket` → `{ticket, expiresIn:30}`（每个 ticket 记为 `{userId, expiresAt, used}`） |
| ticket 一次性 | 握手时校验 `used` 标志；重复使用拒绝 |
| ticket TTL | 30 秒过期 |
| 版本校验 | `v !== 1` 时以 `4002` 关闭 |
| 心跳 | 收 `ping` 回 `pong`；服务端定时检查活性 |
| 事件推送 | `ready` / `message.created` / `conversation.created` / `conversation.updated` / `conversation.read` / `presence.changed` / `typing.changed` / `friend.requested` / `friend.resolved` / `conversation.removed` |
| 多连接 | `Map<userId, Set<ws>>`，向该用户所有连接广播 |

---

## 4. 契约漂移的四层防护

| 层 | 机制 | 拦住什么 |
|---|---|---|
| 1 | `ws/schema.ts` 的 zod —— 入站帧分发前 `safeParse`，出站帧发送前 `parse` | 帧结构漂移（**必然发生**）。在边界失败并 warn，不让脏数据流进 store |
| 2 | `api/wire.ts` 的 wire 类型带字段级注释指向 diff-report | 字段改名在类型层可见 |
| 3 | `api/normalize.ts` —— **全前端唯一感知后端字段命名的地方** | 后端补字段时只改一处，业务层与组件零改动 |
| 4 | `scripts/check-contract.mjs` —— 拿 `backend/openapi.json` 反向比对 `contracts/requirements/*.json` | 机械门禁：**可重复运行**，不依赖人记得 |

### 4.1 第 4 层的三类检查

```
(a) 结构完整性：需求书声明的 method+path 是否都在 openapi；成功响应码是否一致
(b) 字段级    ：两侧 schema 摊平成「字段路径 → 类型/枚举/required」集合后逐条比对
                · 请求体：我方多声明字段 = ERROR（后端 additionalProperties:false 会拒绝）
                · 响应体：需求书要的字段缺失 = ERROR（前端会崩）
(c) 枚举一致性：enum 值集合双向比对
                · openapi 有而我方没有 = ERROR（前端没写这个分支）
                · 我方有而 openapi 没有 = WARN（前端需 default 分支）
```

设计立场：后端 `openapi.json` 是**实现事实**，`requirements/*.json` 是**前端依赖声明**。门禁只回答一个问题 —— **前端依赖的东西后端还在不在**。后端多返回字段不阻塞前端（有 default 分支），记为 WARN。

### 4.2 `--self-test` 的意义

一个永远输出「通过」的门禁等于没有门禁。`--self-test` 注入 4 处缺陷并断言全部被拦：

| 注入 | 期望命中 |
|---|---|
| 删掉 `GET /api/v1/friends` | `structure`：端点缺失 |
| 从会话列表项删掉 `unreadCount` | `response`：响应字段缺失 |
| 把 `type` 枚举改成 `["directx"]` | `enum`：openapi 有枚举值而我方未收录 |
| 给发消息请求体加一个必填字段 | `body`：后端会因 `additionalProperties:false` 拒绝我方请求 |

**当前实际输出**（见 §6）。

---

## 5. 测试策略

| 层 | 工具 | 覆盖什么 | 不覆盖什么 |
|---|---|---|---|
| 单元 | `vitest` | `utils/uuid`、`utils/datetime`（时间分组边界）、`api/normalize`（wire → 领域模型，含 `direct`/`single` 归一化、relationship 推导） | 组件渲染细节 |
| 组件 | `@vue/test-utils` | 关键交互：空输入禁用发送、超长警告、乐观消息渲染位置 | 视觉像素 |
| 契约 | `scripts/check-contract.mjs` | 需求书 ↔ `backend/openapi.json` 的三类机械比对 | 运行时行为 |
| 端到端 | 手工 + `docs/08-runbook-verify.md` 勾选 | 真实双浏览器、真实后端、真实 WS、断线重连 | 自动化 |

端到端**刻意不做自动化**：本项目只有两个开发者（两个 agent），且价值最高的一致性风险（时序、幂等、补偿）在有真实后端时用双浏览器 + DevTools 手工验证最快最直观。自动化 E2E 的搭建成本会超过它在本项目生命周期内的收益。

---

## 6. 门禁的实际输出（留档）

### 6.1 `--self-test`（证明门禁有效）

```
$ node scripts/check-contract.mjs --self-test
[check-contract] --self-test：已注入故意缺陷（删端点 / 缺字段 / 改枚举 / 加请求体必填字段）

[check-contract] self-test：ERROR=4 WARN=2
[check-contract] 命中的检查类别：structure, response, body, enum
[check-contract] 各类别明细：
    [structure] 端点缺失：GET /api/v1/friends
    [response] GET /api/v1/conversations 响应缺少字段 `items[].unreadCount`
    [body] POST /api/v1/conversations/{conversationId}/messages 请求体多出必填字段 `extraRequired`（后端会因 additionalProperties:false 拒绝我方请求）
    [enum] GET /api/v1/conversations 字段 `items[].type` openapi 有枚举值 "directx"，需求书未收录（前端会崩）

[check-contract] ✅ 门禁有效（命中 structure / response / enum / body）
```

### 6.2 常规模式（当前真实状态）

```
$ node scripts/check-contract.mjs
=== 契约比对结果 ===
openapi 版本：0.2.0
openapi 路径数：22；需求书声明：26
字段检查 465 项；枚举检查 41 项；请求体检查 12 端点
ERROR 0 / WARN 0

✅ 无差异：需求书与 backend/openapi.json 完全一致
```

完整报告写入 `docs/contract/check-result.md`（由脚本自动生成，勿手工编辑）。

---

## 7. 契约变更时如何避免返工（本项目的核心机制）

```
① 后端改实现 → 重新导出 backend/openapi.json
② 我方跑 node scripts/check-contract.mjs
③ ERROR > 0 → 在 session.txt 发 [CONTRACT] 列差异 + 我方结论（接受 / 阻塞 / 待议）
④ 双方 ACK → 我方改 contracts/requirements/*.json 的版本号与条目 → 重跑到 ERROR 0
⑤ 前端改 api/normalize.ts（通常只有这一处需要改）
```

关键点：

- **业务层与组件永不手写 wire 类型**。`types/domain.ts` 只放纯前端模型；`api/wire.ts` 是唯一的后端形状声明处；`api/normalize.ts` 是唯一的形状翻译处。后端改字段名时，改动集中在 `wire.ts` + `normalize.ts`，页面与组件零改动
- **WS 侧反向**：`ws/schema.ts`（zod）是前端侧契约源，出站入站双向校验。后端新增帧类型时，未识别的帧被 `default` 分支静默忽略（向后兼容），不会崩
- **追加式演进**：同一 minor 内只允许追加（加可选字段、加端点、加枚举值且前端有 default 分支）。字段重命名 / 类型变更 / 删除 / 语义变更必须 bump minor + 双方 ACK

---

## 8. Mock 模式的已知限制

| 限制 | 影响 | 缓解 |
|---|---|---|
| WS mock 是独立进程，与 MSW 内存数据不共享 | Mock 模式下 REST 与 WS 的数据不完全一致 | 帧**形状**严格一致；WS mock 只用于验证生命周期（票据、退避、看门狗），不用于验证数据一致性 |
| `GET /presence` 后端未实现 | 无法通过 MSW 验证预取路径 | `presenceStore.prefetchSupported` 的降级分支有单测；联调时该端点返回 404 走降级 |
| 无法模拟真实的网络抖动 | 半开连接、慢消费者等场景只能靠看门狗超时近似 | `client.ts` 的看门狗有明确超时，可在 DevTools 中用 Offline 模拟 |

