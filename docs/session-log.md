# session.txt 消息归档

> `session.txt` 是易失的协作通道（有被覆盖的风险），重要决策不得只存在于其中。
> 本文件按轮次归档双方往来。格式：时间 | 发送方 | 类型 | 摘要。
> 协议见 `docs/05-collaboration.md` 第 5 节。

---

## 归档规则

1. **只追加**。不重写、不删除已有行。
2. 每轮有效往来（一次请求 + 对应答复）记一行，摘要控制在 100 字内。
3. 契约相关决策除了本文件，**同时**落到 `contracts/requirements/*.json` 与 `docs/09-contract-changelog.md`。
4. 双方均**不得**写 `.session-monitor/`（那是 `monitor.ps1` 的独占领地）。

---

## 第 1 轮：边界确立

| 时间 | 发送方 | 类型 | 摘要 |
|---|---|---|---|
| 2026-09-28 | backend | （首条） | 声明协作需求与边界：负责后端与接口文档，只写 `backend/`；技术栈 Node 24 + TS + Fastify + SQLite + WS；端口 3001；REST 前缀 `/api/v1`；WS `/ws`；Bearer opaque token；WS 一次性短效 ticket；产出 `backend/API.md` + `backend/openapi.json`。MVP 范围列出 12 项；不做音视频/附件上传/支付/多实例部署 |
| 2026-09-28 | frontend | `[ACK]` | 确认分工：本方只写 `frontend/` `docs/` `contracts/`；接受全部技术边界；补充约定 `.session-monitor/` 双方均不写、`session.txt` 只追加、消息格式 `## <sender>: [TYPE] 内容`、单条 600 字内 |
| 2026-09-28 | frontend | `[BOUNDARY]` | 目录所有权声明：`contracts/` 与 `docs/` 归本方，`backend/` 归后端，互不跨写。仓库 `git init` 单仓多目录 |

## 第 2 轮：契约执笔方式与 5 个关键问题

| 时间 | 发送方 | 类型 | 摘要 |
|---|---|---|---|
| 2026-09-28 | frontend | `[CONTRACT]` | 提案 v0.1 的执笔方式：WS 契约以 zod 为源生成 JSON 交后端；REST 由本方出字段级需求书，后端用 Fastify schema 产出 `openapi.json`，本方用 `openapi-typescript` 生成类型后逐字段比对，差异清零即冻结 |
| 2026-09-28 | frontend | `[Q]` | 5 个关键问题：① 消息 ID 由服务端生成 `msgId` + 客户端 `clientMsgId` ② 每会话单调 `seq` ③ 断线补偿 `POST /api/v1/sync` ④ 服务端权威 `unreadCount` ⑤ WS ticket 机制与「token 过期不踢既有连接」 |
| 2026-09-28 | backend | `[ACK]` + `[A]` | ①-④ 全部同意（`sync` 上限 100 会话/每会话 100 条，`nextSeq` 为页内最后序号）；⑤ **部分不同意**：token 过期/注销需以 `1008` 关闭，心跳最迟 30 秒校验，客户端需重新登录并取新票据重连 |
| 2026-09-28 | backend | `[CONTRACT]` | 建议冻结基础命名：`User`/`Message`（`msgId`/`content`），WS 信封 `{id,type,timestamp,data}`，客户端仅 `ping` 或 `typing`，**发送消息走 REST** |
| 2026-09-28 | frontend | `[A]` | ①-④ 接受。⑤ 部分接受：接受 `1008` 作为关闭码，但**调和方案** —— 请提供 `POST /auth/session/refresh`（滑动续期，**返回同一 token、只后移 `expiresAt`、不轮换**），前端到期前 60 秒静默续期，则 session 永不过期。并请保留 `4001`（票据失效，前端立即重取重连）与 `4002`（版本不匹配，不重连）—— 二者语义与 `1008` 不同，不可合并 |
| 2026-09-28 | frontend | `[CONTRACT]` | 命名对齐结论：接受后端命名与分工，本方契约同步改为 `msgId`/`content`/`bio`/信封 `{id,type,timestamp,data}`/`typing{active}`/发消息与已读走 REST。**发消息走 REST 表示认可**（原生幂等、状态码明确、重试简单）。列 3 个阻塞项：(1) 信封必须加 `v:1` 协议版本号 (2) `Message.type` 必须为 `text|system` 二值 (3) 会话模型按视角化字段实现 |
| 2026-09-28 | frontend | `[CONTRACT]` | 续 6 项：(a) `clientMsgId` 幂等 (b) `GET /messages` 必须支持 `afterSeq`（最高优先级） (c) 已读单调不回退 + 事件带权威 `unreadCount` (d) 群聊「N 人已读」依赖 `members[].lastReadSeq` (e) `/health` 返回 `version`/`protocolVersion`/`serverTime` (f) 统一 `ErrorBody`，不要 Fastify 默认错误体 |

## 第 3 轮：git 授权核实

| 时间 | 发送方 | 类型 | 摘要 |
|---|---|---|---|
| 2026-09-28 | frontend | `[CONTRACT]` | **git 授权核实**：后端指出用户未授权 git commit/tag，本方核实后**同意并同步遵守**，双方均不做 commit/tag。契约冻结改用「契约文件 `version` 字段 + 双方 `[ACK]` + session.txt 留痕」作为凭证。冻结后同一 minor 内只允许追加；字段重命名/类型变更/删除/语义变更必须 bump minor + 双方 `[ACK]` |
| 2026-09-28 | frontend | `[SYNC]` | 进度：仓库已 `git init`；`docs/05-collaboration.md` 与三份契约需求书已落盘（v0.1.0）；前端脚手架依赖安装中。阻塞项：无。待后端回 `(1)(2)(3)` 阻塞项与 `(a)-(f)` 逐条答复 |

## 第 4 轮：后端回答与「收敛到 openapi.json」

| 时间 | 发送方 | 类型 | 摘要 |
|---|---|---|---|
| 2026-09-28 | backend | `[A]` | 接受 refresh 同 token 仅未过期时续期、WS `v:1`、`4001` 与 `4002`；接受 `Message.type=text|system`（内容服务端生成）；**接受视角化字段** `title`/`avatarUrl`/`peer`/`memberCount`/`lastReadSeq`/`myRole` 与 `single|group`。(a)-(f) 全部同意，`afterSeq` 已实现，已读改 204，`members.lastReadSeq` 已实现，health 加 `/api/v1/health`，`traceId` + `error.code` 统一 |
| 2026-09-28 | backend | `[CONTRACT]` | 请**收敛 v0.2 REST 到已生成的 `backend/openapi.json`**，暂不采用 v0.1 需求书的另一套路径/包装。实际实现：`/friend-requests`（`respond {action}`）、`/conversations/direct|group`、`/users?q=`、数组统一 `{items,nextOffset}`、`AuthResult={token,tokenType,expiresAt,user}`。请先基于它开发并修改需求书，避免无休止并行发明两套 API |
| 2026-09-28 | backend | `[SYNC]` | 后端 v0.2.0 已实现并生成最新 `backend/openapi.json`；完整中文接口/WS/错误码在 `backend/API.md`。7 组集成测试通过（含真实 WS、票据一次性、会话注销、权限、分页/补偿、数据库重启）。重点：WS type 为 `ready`/`pong`/`message.created`/`conversation.created|updated|removed|read`/`friend.requested|resolved`/`presence.changed`/`typing.changed`/`error`；客户端帧 `{v:1,type:'ping'}` 或 `{v:1,type:'typing',conversationId,active}`；read 返回 204；系统消息与文本共享 seq |
| 2026-09-28 | backend | `[SYNC]` | 本轮后端交付完成：共 9 组集成测试通过；`npm audit` 全依赖 0 漏洞。启动方式 `cd backend && npm run dev`。后台启动被环境策略拒绝，**当前无常驻业务服务**，需用户手动启动后联调。**尚未收到本方对 REST 路径/WS type 的最终 `[ACK]`**，故不宣称契约已冻结 |

---

## 本方（frontend）待办

| # | 事项 | 状态 |
|---|---|---|
| 1 | 按 `backend/openapi.json` 0.2.0 改写 `contracts/requirements/*.json` 为 v0.2.0 | **已完成** |
| 2 | 建 `scripts/check-contract.mjs` 机械门禁（三类检查 + `--self-test`） | **已完成**，实测 `ERROR 0 / WARN 0`，`--self-test` 4 类缺陷全命中 |
| 3 | 补齐 `docs/00/01/03/04/06/07/08/09` 与 `session-log.md` | **已完成** |
| 4 | 在 `session.txt` 发 `[ACK]` 确认 REST 路径与 WS type（回应后端第 4 轮明确要求） | **待用户/协调层确认后发出** |

> **说明**：第 4 项是本方唯一未闭合的动作。后端已在第 4 轮的 `[SYNC]` 中明确请求“对本轮 REST 路径/WS type 的最终 `[ACK]`”，而 `session.txt` 的写入属协作动作，需由协调层/用户确认后执行（本方本轮的任务范围是 `contracts/`、`docs/`、`scripts/`）。

