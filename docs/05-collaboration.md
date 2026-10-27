# 05 · 协作规范（双 Agent）

> 本文档是**两个 agent 之间的边界与流程约定**，优先级高于口头/会话内约定。
> 任何与本文件冲突的做法，以本文件为准。

---

## 1. 角色与文件所有权

| 路径 | 所有者 | 另一方权限 |
|---|---|---|
| `frontend/` | **frontend agent（本方）** | backend agent 只读 |
| `docs/` | **frontend agent（本方）** | backend agent 只读 |
| `contracts/` | **frontend agent（本方）** | backend agent 只读（消费生成物） |
| `backend/` | **backend agent** | frontend agent 只读 |
| `session.txt` | **双方只追加** | 任何一方都不得重写、截断、删除已有行 |
| `.session-monitor/` | **`monitor.ps1` 独占** | **两个 agent 都不得写入** |
| `monitor.ps1` | 用户 | 两 agent 均不得修改 |

**硬规则**：不得跨目录写入。需要对方改动时，走 `session.txt` 提出请求，由对方自己动手。

---

## 2. session.txt 消息格式

每行一条消息，前缀标明类型：

```
## <sender>: [<TYPE>] <内容>
```

- `<sender>`：`frontend` 或 `backend`
- `<TYPE>`：见下表

| TYPE | 用途 | 是否需要对方回应 |
|---|---|---|
| `[ACK]` | 确认收到、确认边界 | 不需要 |
| `[BOUNDARY]` | 声明/调整职责边界 | 需要确认 |
| `[CONTRACT]` | 契约提案或冻结通告 | 需要确认（除非标注 FINAL） |
| `[Q]` | 提问 | 需要回答 |
| `[A]` | 回答问题 | 不需要 |
| `[SYNC]` | 状态同步（进度、阻塞） | 不需要 |
| `[BLOCK]` | 阻塞求助 | 需要尽快回应 |

**约束**：单条消息控制在 **600 字以内**。正文过长时，在 `session.txt` 只放摘要 + 指向 `docs/` 内文件的路径。

---

## 3. 契约变更流程

契约的唯一事实源是 `contracts/` 与 `docs/03`、`docs/04`。

```
提出方 → session.txt 发 [CONTRACT] 提案
      → 对方在 docs/ 或后端实现中核对
      → session.txt 回 [A] 确认或提出异议
      → 双方一致后，提出方更新契约文件
      → session.txt 发 [CONTRACT] FINAL
      → git tag: contract-v<major>.<minor>
```

- 契约冻结后，**任何字段增删都必须走上述流程**，不得单方面改动
- 破坏性变更（删字段、改字段语义）必须升 major 版本号
- 新增可选字段、新增枚举值可升 minor

---

## 4. 已锁定的技术边界

| 项 | 值 |
|---|---|
| 产品名 / 包名 | `aitrance-chat` |
| 后端端口 | `3001` |
| REST 前缀 | `/api/v1` |
| WebSocket 路径 | `/ws` |
| 认证 | Bearer opaque session token（非 JWT） |
| WS 建连 | 一次性短效 ticket，`/ws?ticket=<ticket>` |
| 时间戳格式 | ISO 8601 UTC（`2026-09-28T01:23:45.678Z`） |
| 认证头 | `Authorization: Bearer <token>` |

---

## 5. 消息归档

`session.txt` 是易失的协作通道。**重要决策不得只存在于其中**。

- 每轮有效往来追加归档到 `docs/session-log.md`
- 格式：`| 时间 | 发送方 | 类型 | 摘要 |`
- 契约相关决策同时落到 `docs/03-api-contract.md` 或 `docs/04-ws-protocol.md`

---

## 6. 冲突处理

1. 发现对方写了自己目录的文件 → 立即在 `session.txt` 发 `[BLOCK]`，不要自行回滚
2. 契约双方理解不一致 → 以 `contracts/` 内文件 + git tag 为准，不以会话记忆为准
3. 无法达成一致 → 在 `session.txt` 发 `[BLOCK]` 并请用户裁决
