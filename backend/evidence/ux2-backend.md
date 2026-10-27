# UX2 后端交付证据：DB v3 / uid / 管理员 / 群角色 / 置顶 / 附件权限

> 作者：ux-api（teammate）；任务：Team task-9「UX2 后端：DB v3 / uid / 管理员 / 群角色 / 置顶 / 附件权限」
> 契约基准：`docs/contract/ux2-contract.md` v0.3.0（327 行，Lead 冻结，逐字对齐，未改一字）
> 实测时间：2026-10-22 ~ 2026-10-23（Asia/Shanghai，本机开发工作站）
> 全部实测在**本机隔离环境**：`:memory:` 或 `os.tmpdir()`/`backend/.data/` 下的临时 SQLite + 临时 uploads 目录；真实 HTTP 冒烟只用 `127.0.0.1:3098`（避开他人占用的 3099/3001）。
> **未执行** `git commit`/`git tag`；**未执行** `backend/deploy/` 下任何脚本（含 `reset-chat.mjs`）；未触碰生产、未访问 mikuyun.xyz、未改 `frontend/`、未改 `management/`；未新增任何 npm 依赖。
> 数据均为真实运行输出；**未覆盖/未验证项在 §五 如实标注，不写成 PASS**。

---

## 摘要（≤120 字）

契约 §一~§十、§十三 后端部分全部落地：schema v3 幂等迁移、uid 双通道登录、管理员初始化与后台 4 接口、账号删除级联、群角色矩阵、置顶 3 接口 + WS 第 13 帧、头像三态、**附件读取 P0 修复**。42/42 测试全绿，门禁 ERROR 0 / WARN 0，隔离实例冒烟 49/49。

---

## 0. 环境与指纹

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows 10，Git Bash（`/b/AITrance`） |
| Node | `v24.15.0`（`/e/nodejs/node.exe`）；npm 须以 `node /e/nodejs/node_modules/npm/bin/npm-cli.js` 调用 |
| SQLite | 内置 `node:sqlite` `DatabaseSync`（3.51.3），非 better-sqlite3 |
| `backend/src/` 聚合 sha256 | `e255b6206675b4af3abb25ba90414c0622e0ef9ac3616d181063146ed597a80a`（12 个 .ts，`ls -1 src/*.ts \| sort \| xargs sha256sum \| sha256sum`） |
| `backend/openapi.json` sha256 | `0e8bb35f0d3fcb1c7811245751d5b46448bc69349725e24398200ffac48e7e15`（18508 行，586618 字节，md5 `60dd64589bd8329bc46f472ca00ed713`） |
| 隔离后端端口 | `127.0.0.1:3098`（3099 被另一实例占用，未触碰） |
| 管理员初始口令（测试用） | `smoke-admin-password-1` / `test-admin-password-1`（仅测试环境环境变量，非生产默认值） |

### 0.1 改动文件清单（本轮 task-9）

| 文件 | 行数 | sha256 前 16 位 | 改动 |
| --- | --- | --- | --- |
| `backend/src/bootstrap.ts` | 39 | `b8e57de1b5fa98aa` | **新增**：`ensureAdmin()`，管理员首次创建 / 已存在即不动 |
| `backend/src/db.ts` | 258 | `ef4706f4cf1b307c` | `SCHEMA_VERSION` 2→3；users 加 uid/role/status/muted_until、conversations 加 avatar_url、conversation_members 加 role 并回填、新建 message_pins；`migrate()` 五段幂等升级 |
| `backend/src/schemas.ts` | 161 | `b4ae0a4addd1c736` | `User` 11 字段、`GroupRole` 三值、`Member`/`Conversation.myRole` 扩 admin、`PinnedMessage`/`PinsResult`/`PinBody`/`PinParams`/`MemberRoleBody`/`AdminUserParams`/`AdminUsersQuery`/`AdminUserPage`/`MuteBody`/`AdminStats` |
| `backend/src/config.ts` | 164 | `477b114058f30f99` | `adminUid`（`ADMIN_UID`，1000..9999）、`adminInitialPassword`（`ADMIN_INITIAL_PASSWORD`，8..128，默认 `A454545asd@`） |
| `backend/src/service.ts` | 854 | `79d5f9672ac279ea` | `findUserByIdentifier`、`isMuted`、`memberRole`/`requireManager`、`setMemberRole`、`removeMember` 三档、`resolveAvatarUrl` 三态、置顶 5 方法、`requireAdmin`/`adminUsers`/`muteUser`/`deleteUser`/`adminStats`、**`readUpload` P0 修复**、`deleteUser` 外键清理与 `remaining <= 1` |
| `backend/src/routes.ts` | 444 | `f8285170e5ec7295` | 新增 8 条路由（C9 群角色 / P1~P3 置顶 / D1~D4 管理后台）；登录 `username` 放宽 minLength 3→1；改群头像先三态校验再落库 |
| `backend/src/app.ts` | 251 | `f912ea970ed12218` | `buildApp` 内、`registerRoutes` 前调 `ensureAdmin`；启动日志 `admin bootstrap: <created\|exists>`（不含密码） |
| `backend/src/realtime.ts` | 242 | `7481bea0b935b47b` | `onlineCount()`；`revoke()`（踢 WS 4003）；`SweepReport.uploads` |
| `backend/test/ux2.test.ts` | 662 | `4bc6ea23a0fafaef` | **新增 9 条测试**（uid/管理/删除/群角色/头像/置顶/WS 广播/附件三档/迁移 v2→v3） |
| `backend/test/chat.test.ts` | 517 | `a9a6b232a3e219c6` | 用户计数断言改为 `WHERE role <> 'admin'`（:278） |
| `backend/test/security.test.ts` | 347 | `946194fb798c052d` | 同上（:342） |
| `backend/openapi.json` | 18508 | `0e8bb35f0d3fcb1c` | 重新生成（24 → 31 路径） |
| `contracts/requirements/rest-requirements.json` | 2469 | — | 端点 29 → 37、definitions 13 → 19、version 0.3.0 |
| `contracts/requirements/ws-requirements.json` | 531 | — | S→C 12 → 13 帧（新增 `conversation.pins`）、version 0.3.0 |
| `contracts/requirements/errors.json` | 382 | — | 码 35 → 44（新增 9 个）、version 0.3.0 |
| `docs/03-ws-protocol.md` | 540 | — | §4.2 改 13 帧、新增 §4.6、§4.5 附件限制段重写、小节重排 4.1~4.6 |
| `docs/09-contract-changelog.md` | 360 | — | 版本总览加 v0.3.0 行、新增整节（10 子节） |
| `backend/.data/ux2_smoke.mjs` | 294 | — | **新增**（一次性冒烟脚本，`.data/` 已 gitignore，不入库） |
| `backend/.data/ux2_migration_proof.mjs` | 111 | — | **新增**（一次性迁移幂等证明脚本，同上） |
| `backend/.data/ux2_rest_contract.py` / `ux2_errors.py` / `ux2_ws.py` | — | — | **新增**（一次性契约补录脚本，同上） |

**未改动**：`backend/package.json`、`backend/package-lock.json`、`backend/node_modules/`（Lead 另行处理 fastify 安全升级）、`backend/deploy/`（含两个 nginx 配置，本轮无 CSP 变更）、`frontend/`、`management/`。

---

## 一、结论摘要表（契约 §一~§十三 逐条）

| 契约条目 | 结论 | 依据 |
| --- | --- | --- |
| §一 数据库 schema v3（users 扩列 / conversations.avatar_url / members.role 回填 / message_pins / SCHEMA_VERSION=3 / 幂等迁移） | **PASS** | §二.1 + §二.2（迁移幂等证明实跑）；`test/ux2.test.ts:566` |
| §二 uid 分配（管理员 1001 / 普通 10001 起 / 事务内 MAX+1 / 既有用户回填） | **PASS** | §二.1 + §二.3；`test/ux2.test.ts:136` |
| §三 系统管理员初始化（`ensureAdmin` 幂等、不覆盖已存在、日志不打印密码） | **PASS** | §二.4（`created`→`exists` 且行完全一致）；`app.ts:140` |
| §四 用户对象 wire `User` 扩展（uid / role / status / mutedUntil） | **PASS** | §二.5；`schemas.ts` `User` 11 字段；openapi 已重生成 |
| §五 认证（uid 登录 / banned 403 ACCOUNT_BANNED / 禁言 403 MUTED / 删除账号级联） | **PASS** | §二.6 + §二.7 + §二.8；`test/ux2.test.ts:136`、`:251` |
| §六 管理后台 4 接口（非 admin 403 ADMIN_REQUIRED） | **PASS** | §二.9；`test/ux2.test.ts:190` |
| §七 群聊角色 owner/admin/member（权限矩阵 / C9 任命 / 移除三档） | **PASS** | §二.10；`test/ux2.test.ts:297` |
| §八 附件权限修复（P0：属主 / 同会话成员 / 无关用户） | **PASS** | §二.11；`test/ux2.test.ts:527` + 冒烟两项 |
| §九 消息置顶 3 接口 + `conversation.pins` 广播 | **PASS** | §二.12；`test/ux2.test.ts:423`、`:488` |
| §十 头像（用户头像三态 / 群头像 / 私聊固定空串） | **PASS** | §二.13；`test/ux2.test.ts:369` |
| §十三 错误码新增 9 个同步 `errors.json` | **PASS** | §四.3 |
| §十五 门禁与证据（后端部分） | **PASS**（`npm audit` 由 Lead 处理，见 §五） | §三 |
| §十一 前端消息操作按钮 | **不在本 agent 范围**（前端 agent 交付） | — |
| §十二 前端「发送图片 / 上传文件」分离 | **不在本 agent 范围**（前端 agent 交付） | — |
| §十四 前端页面要求 | **不在本 agent 范围**（前端 agent 交付） | — |

> §十一 / §十二 / §十四 是纯前端契约条目，按 task 分工由前端 agent 实现，本证据不对其作任何结论。

---

## 二、逐项实现与实测证据

### 二.1 schema v3（契约 §一）

实现位置 `backend/src/db.ts`：

- `SCHEMA_VERSION = 3`（:10）、`FIRST_USER_UID = 10001`（:17）。
- 新建库建表 DDL 已含全部 v3 列（:26-107）：`users.uid INTEGER`、`users.role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'))`、`users.status ... CHECK(status IN ('active','banned'))`、`users.muted_until TEXT`、`conversations.avatar_url TEXT NOT NULL DEFAULT ''`、`conversation_members.role ... CHECK(role IN ('owner','admin','member'))`、`message_pins` 表 + `message_pins_conversation` 索引。
- 老库升级 `migrate()`（:132）：读 `PRAGMA user_version`，`>= SCHEMA_VERSION` 直接 return；否则 `BEGIN IMMEDIATE` → `upgradeMessagesTable()` → `upgradeUserColumns()` → `upgradeConversationColumns()` → `upgradeMemberColumns()` → `PRAGMA user_version = 3` → COMMIT / 失败 ROLLBACK。**每段升级都自带存在性判断**（`PRAGMA table_info` / `sqlite_master`），因此中途崩溃后重跑能收敛。
- `addColumnIfMissing()` 是「先查 `PRAGMA table_info` 再 ALTER」的两步，不依赖 `ALTER TABLE ... IF NOT EXISTS`（SQLite 不支持）。

断言（`test/ux2.test.ts:566`，用例名 `迁移：user_version 2 的库升到 3，补列回填且幂等不丢数据`）：
手工造 v2 库（`new DatabaseSync(databasePath)`，users 无 uid/role/status/muted_until、conversations 无 avatar_url、members 无 role，`PRAGMA user_version = 2`）后启动：
- `PRAGMA user_version` → `3`（== `SCHEMA_VERSION`，:623）
- 老用户 uid → `10001`；管理员 uid → `1001`
- `role = 'user'` / `status = 'active'` / `muted_until = null`
- `conversations.avatar_url` → `''`
- 群主成员行 `role = 'owner'`
- 老消息 `content = '迁移前的消息'` 且 `attachment_id = null`
- 登录后能读到历史 `items[0].content === '迁移前的消息'`
- **第二次启动 no-op**：user_version 仍 3、uid 仍 10001、users 计数 2、messages 计数 1（:648-651）

### 二.2 迁移幂等性证明（独立脚本，非测试）

脚本 `backend/.data/ux2_migration_proof.mjs`（111 行，不入库），直接驱动 `dist/src/db.js` 的 `Store` 与 `dist/src/bootstrap.js` 的 `ensureAdmin`，对同一个库**启动两次**。实跑原文：

```
$ cd backend && node .data/ux2_migration_proof.mjs
SCHEMA_VERSION 常量 = 3
[第一次启动] user_version = 3 （期望 3）
[第一次启动] users 列 = id,username,display_name,password_hash,avatar_url,bio,created_at,uid,role,status,muted_until
[第一次启动] conversations 列 = id,type,name,owner_id,created_at,updated_at,avatar_url
[第一次启动] conversation_members 列 = conversation_id,user_id,joined_at,last_read_seq,role
[第一次启动] message_pins 存在 = true
[第一次启动] uid 回填（按 created_at 升序，起点 10001）= [["olduser",10001,"user","active"],["miduser",10002,"user","active"],["newuser",10003,"user","active"]]
[第一次启动] 成员角色回填 = [["u-new","member"],["u-old","owner"]]
[第一次启动] 历史消息仍在 = [{"msg_id":"11111111-1111-4111-8111-111111111111","content":"迁移前的消息","attachment_id":null}]
[第一次启动] 部分唯一索引 = CREATE UNIQUE INDEX users_uid ON users(uid) WHERE uid IS NOT NULL
[第二次启动] user_version = 3 （期望仍 3）
[第二次启动] users 列 = id,username,display_name,password_hash,avatar_url,bio,created_at,uid,role,status,muted_until
[第二次启动] uid 不变 = [["olduser",10001],["miduser",10002],["newuser",10003]]
[第二次启动] 历史消息仍在 = [{"msg_id":"11111111-1111-4111-8111-111111111111","content":"迁移前的消息"}]
[管理员初始化] 第一次 = created | 第二次 = exists （期望 created → exists）
[管理员初始化] 两次行完全一致 = true | 密码 hash 未被第二次覆盖 = true
[管理员初始化] 行 = {"id":"ac7ca6f2-...","uid":1001,"username":"1001","role":"admin","status":"active","displayName":"系统管理员","hashLen":161}
[uid 分配] 老库已有 10001~10003 → 下一个 = 10004 （期望 10004）
临时库已清理: C:\Users\31626\AppData\Local\Temp\ux2-proof-6nlCDj\chat.sqlite
```

两处刻意的设计：
1. **老库的 `created_at` 与插入顺序故意相反**（插入顺序 old→new→mid，created_at 却是 01-01 / 03-01 / 02-01），回填结果 `10001→olduser、10002→miduser、10003→newuser` 证明排序键确实是契约要求的 `created_at, id`，不是 rowid。
2. **第二次 `ensureAdmin` 传了不同密码**（`proof-admin-password-2`）而 `password_hash` 未变，证明「已存在就完全不动」——这是契约 §三 明确要求的（防止重启覆盖运维改过的密码）。

### 二.3 uid 分配（契约 §二）

- 注册路由里 `nextUserUid()`：`SELECT COALESCE(MAX(uid), 10000) + 1 AS next FROM users WHERE uid >= 10001`，**在注册事务内调用**（注释已写明「调用方必须已在事务里」，防并发重号）。
- 迁移回填用同一算式做起点并取 `Math.max(start, FIRST_USER_UID)`（`db.ts:206-210`），异常库也能收敛。
- 管理员固定 1001，落在 `10001` 起点之前，所以 `WHERE uid >= 10001` 不会把管理员算进普通序号。

断言（`test/ux2.test.ts:136` `账号：uid 分配与数字登录、禁言拦截、封禁拦截`）：
`admin.user.uid === 1001`（:140）、`role === 'admin'`；`alice.user.uid === 10001`（:146）、`bob.user.uid === 10002`、`role 'user'`、`status 'active'`、`mutedUntil === null`。

冒烟交叉验证（§二.14 第 7 项）：`普通用户 uid 从 10001 起顺次分配` → `[10001, 10002, 10003]`。

### 二.4 管理员初始化 `ensureAdmin`（契约 §三）

`backend/src/bootstrap.ts`（39 行）：
- 先 `SELECT id FROM users WHERE uid = ?`，命中直接 `return { admin: 'exists' }`，**一个字节都不写**。
- 未命中时**先算 scrypt 再进事务**（注释：把几百毫秒的密码派生塞进 `BEGIN IMMEDIATE` 会长时间占写锁）；事务内再做一次存在性复查，覆盖「两进程同时首启」的竞态。
- INSERT 的字段：`username = String(adminUid)`（即 `'1001'`）、`display_name = '系统管理员'`、`role = 'admin'`、`status = 'active'`。
- **不返回也不打印密码**；`app.ts:141` 只打 `admin bootstrap: created|exists` 与 `uid`。

注入点 `app.ts:140`：在 `new Store` / `Realtime` / `ChatService` 之后、`registerRoutes` **之前**（契约要求「启动时、routes 注册前」）。

配置（`config.ts`）：`ADMIN_UID` 默认 1001、上限 9999、下限额外校验 1000（:128-129）；`ADMIN_INITIAL_PASSWORD` 默认 `A454545asd@`、长度 8..128 否则抛错（:132-134）。

实测见 §二.2 最后四行（`created` → `exists`、两次行完全一致、hash 未被覆盖）。

### 二.5 wire `User` 扩展（契约 §四）

`service.user()` 返回 11 字段：`id / uid / username / displayName / avatarUrl / bio / role / status / mutedUntil / createdAt / online`。`uid` 兜底 `row.uid ?? 0`（迁移前的极端过渡态不会漏出 `undefined`，导致前端 `#undefined`）。

openapi 已重生成：`backend/openapi.json` 的 `User` 定义含上述 11 个必填字段，`mutedUntil` 为 `anyOf[string, null]`。

### 二.6 认证：uid 登录 / banned（契约 §五 5.1、5.2）

`service.findUserByIdentifier()`（`service.ts:114`）：
```
if (/^\d+$/.test(identifier)) return this.store.get('SELECT * FROM users WHERE uid = ?', Number(identifier));
return this.store.get('SELECT * FROM users WHERE username = ?', identifier.toLowerCase());
```
注释明确说明「这里不能再对 identifier 小写化 —— uid 是数字，而 username 列本身是 COLLATE NOCASE」。

路由 `POST /api/v1/auth/login`：查不到与密码错**一律** 401 `INVALID_CREDENTIALS`（保留 dummyHash 防时序侧信道）；命中后 `status === 'banned'` → 403 `ACCOUNT_BANNED`「账号已被禁用，请联系管理员」。

断言（`test/ux2.test.ts:136`）：
- `login(backend, String(alice.user.uid), 'correct-password-123')` 返回同一个 `user.id`
- `UPDATE users SET status='banned'` 后登录 → `403 ACCOUNT_BANNED`（:183）
- **已登录的旧 token 发消息也 403 `ACCOUNT_BANNED`**（:187）—— 封禁是实时生效的，不等 token 过期

冒烟：`管理员用纯数字 uid 登录`（200）、`用数字 uid 登录普通账号`（200 且 `user.id` 一致）。

### 二.7 禁言拦截（契约 §五 5.3）

`service.isMuted()`（`service.ts:127`）：`row.muted_until !== null && Date.parse(row.muted_until) > Date.now()`（注释说明 ISo8601 可直接字典序比较，但 `Date.parse` 对带时区偏移的历史写法更宽容）。

`sendMessage()` 在 `requireMember` **之后**检查（`service.ts:430`）：`fail(403, 'MUTED', '你已被禁言，解除时间 ' + sender.muted_until)`。其它接口不受影响。

断言（`test/ux2.test.ts:136`）：
- `POST /admin/users/{bob.uid}/mute {minutes:60}` → 200 且 `mutedUntil` 晚于当前
- bob 发消息 → `403 MUTED`（:166）
- **bob 读历史仍 200**（禁言只拦写）
- `minutes: 0` → 200 且 `mutedUntil === null`，随后发消息 201

冒烟：`禁言普通用户 30 分钟`、`禁言期发消息 → 403 MUTED`、`minutes=0 解除禁言` 三项 PASS。

### 二.8 删除账号（契约 §5.4）

`service.deleteUser()`（`service.ts:787`）执行顺序（含注释说明为何不能随便调）：

1. `requireAdmin` → 目标不存在 404 `USER_NOT_FOUND`；目标 `role === 'admin'` → 409 `CANNOT_DELETE_ADMIN`。
2. **事务外**收集 `SELECT token_hash FROM sessions WHERE user_id = ?`（注释：`socket.close` 是异步网络动作，放进事务等于把「等对端反应」压在数据库锁上）。
3. 事务内：
   - `DELETE FROM messages WHERE sender_id = ?`（**必须显式先删**：`messages.sender_id` 是 `REFERENCES users(id)` 且无 ON DELETE，不删就被外键拒绝）
   - 群聊群主转移：`SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? ORDER BY joined_at, user_id LIMIT 1`；有继任者则同时 `UPDATE conversations.owner_id` 与 `UPDATE conversation_members SET role='owner'`；**群里只剩群主一人则直接 `DELETE FROM conversations`**
   - 私聊回收：`remaining = COUNT(*) members WHERE user_id <> target`，`remaining <= 1` 时 `DELETE FROM conversations`（:822）
   - `DELETE FROM conversation_members WHERE user_id = ?`（:827）
   - `DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`（:830）
   - `DELETE FROM friend_requests WHERE sender_id = ? OR recipient_id = ?`（:831）
   - `DELETE FROM message_pins WHERE pinned_by = ?`（:834）、`DELETE FROM message_pins WHERE msg_id NOT IN (SELECT msg_id FROM messages)`（:835，清理悬空 pin）
   - `DELETE FROM users WHERE id = ?`
4. 事务外 `for (const session of sessions) this.realtime.revoke(session.token_hash)`（`realtime.ts:169`，`socket.close(4003, 'Session revoked')`）。

> **过程中定位到的真实产品缺陷（已修）**：初版只删了 messages / message_pins / users，HTTP 层表现为 `500 INTERNAL_ERROR`。用 `node --input-type=module -e` 直调 `service.deleteUser()` 拿到裸错误 `ERR: FOREIGN KEY constraint failed`；`PRAGMA foreign_key_list` 实测外键矩阵后发现 `friend_requests` / `friendships` / `conversations.owner_id` / `conversation_members` 对 users 都是 **NO ACTION**（只有 `sessions` / `uploads` 是 CASCADE），必须显式清理。修法即上面 3 的四个 DELETE。
> 同时修正了私聊回收条件：初版写 `remaining === 0`，而 `remaining` 是「除目标之外的人数」，删掉一方后另一方仍在 → 1，会话残留成空壳。改为 `remaining <= 1`（契约 §5.4 原文「私聊会话若只剩 1 人 → 连会话一起删」）。

断言（`test/ux2.test.ts:251` `删除账号：消息清理、群主转移、空私聊回收与 token 失效`）：
- `204` 且 `rawPayload.length === 0`
- `SELECT COUNT(*) FROM messages WHERE sender_id = alice` → `0`
- `conversations.owner_id` 变为 bob，且其成员行 `role = 'owner'`
- 私聊 `SELECT 1 FROM conversations WHERE id = ?` → `undefined`，bob 读它 404
- `message_pins` 计数 `0`
- **alice 旧 token 打 `/users/me` → 401**（session 已级联删除 + WS 已 revoke）
- `users WHERE id = alice` → `undefined`；carol（旁观者）仍能读群 200

冒烟：`删除账号 → 204 空正文`、`被删账号旧 token 立即失效`（401）、`群主转移给 bob（最早加入的成员）`（`myRole === 'owner'`）、`私聊只剩 1 人 → 会话被回收`（404）四项 PASS。

### 二.9 管理后台 4 接口（契约 §六）

路由在 `routes.ts:354-380`，全部 `secured('Admin', ...)`（`security: [{ bearerAuth: [] }]`），handler 第一行 `service.requireAdmin(...)`：

| 端点 | schema | 行为 |
| --- | --- | --- |
| `GET /api/v1/admin/users` | querystring `AdminUsersQuery`（`query?/limit?/offset?`），响应 `AdminUserPage` | `adminUsers()`：`%term%` 匹配 `username` / `display_name` / `CAST(uid AS TEXT)` 三列，`ESCAPE '\'`（term 内 `[\%_]` 转义，防 `%` 注入成通配），`ORDER BY uid ASC, id ASC LIMIT ?+1`，`nextOffset = rows.length > limit ? offset+limit : null` |
| `POST /api/v1/admin/users/:uid/mute` | params `AdminUserParams`（Integer 1000..99_999_999）、body `MuteBody`（0..525_600） | 目标不存在 404；目标是 admin → **409 `CANNOT_MUTE_ADMIN`**；`minutes > 0 ? new Date(Date.now()+minutes*60000).toISOString() : null` |
| `DELETE /api/v1/admin/users/:uid` | params `AdminUserParams`，204 `Type.Null` | 见 §二.8 |
| `GET /api/v1/admin/stats` | 响应 `AdminStats` | 5 个字段：`users/conversations/messages/uploads` 真实 `COUNT(*)` + `online: realtime.onlineCount()`（只数当前活跃 WS 连接，不是「最近登录过」） |

`requireAdmin`（`service.ts:736`）：用户不存在 → 401 `UNAUTHORIZED`「请先登录」；`role !== 'admin'` → **403 `ADMIN_REQUIRED`**「需要管理员权限」。注释：role 是数据层字段，不看 token 内容。

断言（`test/ux2.test.ts:190` `管理后台：非管理员拒绝、搜索、禁言、保护管理员、统计`）：
- 非 admin 对 `/admin/users`、`/admin/stats`、mute、delete **全部 403 `ADMIN_REQUIRED`**（:196-200，注释：不是 401，身份有效只是权限不够）
- 列表 uid 升序 `[1001, 10001, 10002]`、`nextOffset === null`
- 搜索 `query=alice` → `[10001]`；`query=10002` → `[10002]`（按 uid 数字搜）；`query='bob 中文'`（URL 编码，中文昵称）→ `[10002]`
- 分页 `limit=2&offset=0` → 2 条 + `nextOffset 2`；`offset=2` → 1 条 + `nextOffset null`
- mute admin → **409 `CANNOT_MUTE_ADMIN`**（:228）；delete admin → **409 `CANNOT_DELETE_ADMIN`**（:231）
- delete 不存在的 uid=88888 → **404 `USER_NOT_FOUND`**
- `/admin/stats` 与真实 `COUNT(*)` deepEqual，`uploads: 1`、`online: 0`

冒烟：`非管理员访问后台 → 403 ADMIN_REQUIRED`、`后台用户列表按 uid 升序`、`后台按账号名搜索`、`后台按 uid 搜索`、`统计含五个字段`、`禁言管理员 → 409 CANNOT_MUTE_ADMIN`、`删除管理员 → 409 CANNOT_DELETE_ADMIN` 七项 PASS。

### 二.10 群角色 owner/admin/member（契约 §七）

`service.ts` 相关方法：`requireOwner`（:143）、`memberRole`（:150，`owner_id === userId` → `'owner'`，否则读成员行 `role === 'admin' ? 'admin' : 'member'`）、`requireManager`（:164，私聊 → 400 `GROUP_REQUIRED`，member → 403 `OWNER_REQUIRED`「只有群主或管理员可以执行此操作」）、`addMembers`（:329，owner 与 admin 都可邀请，群上限 100 → 400 `GROUP_FULL`）、`removeMember`（:350）、`setMemberRole`（:380）。

权限矩阵实现对照（契约 §7.1）：

| 操作 | 实现 | 实测 |
| --- | --- | --- |
| 改群名 / 群头像 | `requireManager`（owner ∪ admin） | owner 200 / admin 200 / member 403 `OWNER_REQUIRED` |
| 邀请成员 | `requireManager` | 同左 |
| 移除他人 | owner 可移 admin/member；admin 只能移 member（否则 403 `OWNER_REQUIRED`「管理员只能移除普通成员」）；member 只能移自己 | 见下断言 |
| 设置/取消管理员 | `requireOwner` | admin 调用 → 403 `OWNER_REQUIRED` |
| 置顶 | 任何成员 | 见 §二.12 |
| 退群 | 群主 → 409 `OWNER_CANNOT_LEAVE`；admin/member 可以 | 断言覆盖 |

`setMemberRole` 细节（`service.ts:380`）：
- `requireOwner` 起步，**不能改自己**（`targetId === userId`）或**群主**（`targetId === owner_id`）→ 400 `CANNOT_CHANGE_OWNER_ROLE`（两种 message：「不能修改群主自己的角色」/「不能修改群主的角色」）
- 非成员 → 404 `MEMBER_NOT_FOUND`
- 同值幂等返回 conversation（不写系统消息）
- 事务内 `UPDATE role` + `UPDATE conversations.updated_at` + `systemMessage('X 成为管理员' / 'X 被取消管理员')`，然后 `notifyConversation` + `notifyLastSystemMessage`

`removeMember` 三档（`service.ts:350`）：`actorRole === 'member' && targetId !== userId` → 403「只有群主或管理员可以移除其他成员」；`actorRole === 'admin' && targetRole !== 'member'` → 403「管理员只能移除普通成员」；`targetId === owner_id` → 409 `OWNER_CANNOT_LEAVE`。

断言（`test/ux2.test.ts:297` `群角色：仅群主可任命、读写权限矩阵与退群规则`）：
- 初始 roles `[['alice','owner'],['bob','member'],['carol','member']]`
- bob（member）任命 → 403 `OWNER_REQUIRED`；dave（非成员）→ 404
- alice 任命 bob 为 admin → 200，roles 变 `[['alice','owner'],['bob','admin'],['carol','member']]`，系统消息 `'bob 中文 成为管理员'`
- 重复任命 → 200 且系统消息不重复写
- alice 改自己 → 400 `CANNOT_CHANGE_OWNER_ROLE`（:331）；改 dave → 404 `MEMBER_NOT_FOUND`（:334）
- 改名：owner 200 / admin 200 / member 403 `OWNER_REQUIRED`
- **admin 移除 owner → 403**；admin 移除 carol → 200 且 carol 读群 404
- 降级 bob → 200，系统消息 `'bob 中文 被取消管理员'`，随后 bob 改名 403
- bob 移自己（退群）→ 200 且读群 404
- alice（owner）退群 → **409 `OWNER_CANNOT_LEAVE`**（:361）
- 私聊上调 DELETE member → **400 `GROUP_REQUIRED`**（:366，注释：语义错误不是权限问题）

冒烟：`群主任命管理员`（`members[].role === 'admin'`）、`管理员无权再任命 → 403 OWNER_REQUIRED`、`管理员可改群名`、`普通成员改群名 → 403 OWNER_REQUIRED` 四项 PASS。

### 二.11 附件权限 P0 修复（契约 §八）★

**这是本轮唯一的行为放宽，也是用户实测 bug 的根因。**

修复位置 `service.ts:511` `readUpload()`：
```
const row = this.store.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
if (!row) return fail(404, 'UPLOAD_NOT_FOUND', '文件不存在');
if (row.owner_id !== userId) {
  const shared = this.store.get(`SELECT 1 FROM messages message
    JOIN conversation_members member ON member.conversation_id = message.conversation_id
    WHERE message.attachment_id = ? AND member.user_id = ?`, uploadId, userId);
  if (!shared) return fail(403, 'FORBIDDEN', '无权访问该文件');
}
// 读文件失败 → 404（避免 500 泄漏服务器路径）
```

代码注释记录了两个设计取舍：
- 「为什么第 2 档要『先看消息引用再看会话成员』而不是直接按 owner 放行」：附件本身没有会话归属，同一张图可被转发到多个会话，只有顺 `messages` 反查才知道请求者有无权限。
- 「未被任何消息引用的上传（刚传完还没发出去）不能跨人访问，否则任何拿到 UUID 的人都能读别人正在编辑的草稿附件」。

断言（`test/ux2.test.ts:527` `附件读取权限：属主、同会话成员、无关用户三档`，**契约 §八 要求的三种情况全覆盖**）：
| 情形 | 期望 | 实测 |
| --- | --- | --- |
| 属主 alice 读自己发的附件 | 200，字节数一致 | `statusCode 200`、`rawPayload.length === PNG.length` |
| **同会话成员 bob 读（P0 修复本体）** | 200，字节完全一致 | `statusCode 200`、`Buffer.from(rawPayload)` deepEqual `PNG` |
| 无关用户 carol 读 | 403 `FORBIDDEN` | `403` + `error.code === 'FORBIDDEN'` |
| 草稿（未被任何消息引用）bob 读 | 403 | `403` |
| 草稿属主 alice 读 | 200 | `200` |
| bob 删他人附件 | 403 | `403` |
| 属主删已附带件的附件 | 409 `UPLOAD_IN_USE` | `409` + `UPLOAD_IN_USE` |
| 属主删草稿 | 204 | `204` |

冒烟：`同会话成员读附件 → 200 且字节一致`、`无关用户读附件 → 403 FORBIDDEN`、`匿名读附件 → 401`、`附件响应的安全头齐全` 四项 PASS。

> 旧的 `uploads.test.ts:97-100` 仍保留「非属主 403」断言（bob 与 alice 在该用例里不是同会话成员），与新规则**不冲突**，因此该断言原样保留（未放松、未删除）。

### 二.12 消息置顶（契约 §九）

`service.ts` 五个方法：`pinnedMessage`（:662，消息查不到返回 `null`，**悬空 pin 静默跳过**而不是报错）、`listPins`（:670，`ORDER BY pinned_at DESC, id DESC` 后 filter 掉 null）、`pinMessage`（:685）、`unpinMessage`（:703）、`broadcastPins`（:712，对每成员 `publish('conversation.pins', { conversationId, pins })`）。

- `PIN_LIMIT = 50`（:679，契约 §9.2 硬指标）
- 消息不存在或**跨会话** → 400 `INVALID_MESSAGE`「该消息不属于本会话」（注释：不用 404，避免探知别的会话里有没有某条消息）
- 已置顶 → 幂等 `{ created: false }` → 路由回 200
- `count >= PIN_LIMIT` → 409 `PIN_LIMIT`
- `unpinMessage` 无记录 → 404 `PIN_NOT_FOUND`
- **广播纪律**：`pin()` 只在 `created` 时广播（:721）；`unpin()` 恒广播（:727）

路由 `routes.ts:326/331/341`：GET 响应 `PinsResult`；POST 同时声明 200 与 201 `PinnedMessage`，`reply.code(result.created ? 201 : 200)`；DELETE 参数 `PinParams`、204 `Type.Null`。

断言一（`test/ux2.test.ts:423` `置顶：幂等、跨会话校验、上限、取消与列表排序`）：
- 首次 pin → `201`；重复（换 bob 调用）→ `200` 且 `id` 相同、`message.msgId` 相同、`pinnedBy.id` 仍是 alice
- 跨会话 msgId → 400 `INVALID_MESSAGE`（:449）；不存在 msgId → 400 `INVALID_MESSAGE`（:451）
- 非成员 GET/POST pins → 404
- 列表按 `pinnedAt` 倒序 → `['第二条','第一条']`
- 取消 → 204 且 `rawPayload.length === 0`；重复取消 → 404 `PIN_NOT_FOUND`（:468）
- 上限：直连 `backend.service.sendMessage` / `pin` 造 51 条（避开发消息 60/min 限流），第 51 条 → **409 `PIN_LIMIT`**（:479）
- 删消息后悬空 pin 读列表 → 200 且 `items === []`

断言二（`test/ux2.test.ts:488` `置顶变化通过 conversation.pins 广播完整列表`，`{ timeout: 20_000 }`）：
真实 WS 连接（`app.listen({host:'127.0.0.1', port:0})` → `POST /auth/ws-ticket` → `connect('ws://127.0.0.1:<port>/ws?ticket=...&v=1')`）：
- pin 后收到 `conversation.pins`：`v === 1`、`data.conversationId` 匹配、`data.pins.length === 1`、`pins[0].message.msgId` 匹配、`pins[0].pinnedBy.id === alice.user.id`
- 清空事件缓冲后**幂等重放不产生** `conversation.pins`（等 100ms 后 `filter(...).length === 0`）
- 取消后收到 `conversation.pins` 且 `data.pins` deepEqual `[]`

冒烟：`管理员置顶消息 → 201`、`WS 收到 conversation.pins 完整列表`、`重复置顶幂等 200`、`幂等重放不重复广播`、`取消置顶 → 204 空正文`、`取消置顶广播空列表` 六项 PASS。

### 二.13 头像（契约 §十）

`service.resolveAvatarUrl()`（`service.ts:633`）三态：
1. `''` → 返回 `''`（清空）
2. 以 `/api/v1/uploads/` 开头 → 取裸 uuid，正则 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` 校验（**先挡住 `../secret` 这类路径穿越**），再查 `uploads` 必须 `owner_id === userId && kind === 'image'`，否则 400 `INVALID_AVATAR_URL`
3. 其它 → `new URL(value)` 要求 `protocol === 'https:'` 且无 `username`/`password`，否则 400 `INVALID_AVATAR_URL`

路由 `PATCH /api/v1/conversations/:conversationId`（`routes.ts:252`）**先校验头像再三态落库**，注释说明「分开写会出现部分成功」（先改名成功、再头像 400，用户看到一半生效）。

`PATCH /api/v1/users/me` 走同一函数；`avatarUrl` 的 schema 只做长度兜底（`maxLength: 2048`），真正三态在 service（需要查 uploads 表）。

断言（`test/ux2.test.ts:369` `头像：空串、HTTPS 外链、本人图片三态与群头像权限`）：
- `''` → `avatarUrl === ''`；`https://cdn.example.com/a.png` → 原样返回；本人 upload 的 url → 200 且 `avatarUrl` 等于该 url
- 非法值 `http://insecure.example.com/a.png`、`/api/v1/uploads/not-a-uuid`、`/api/v1/uploads/../secret` **全部 400 `INVALID_AVATAR_URL`**（:391）
- **pdf 的 url → 400**（:395，`kind !== 'image'`）
- **他人（bob）的 png url → 400**（:397，非本人）
- 群头像：set 200 且 `avatarUrl === image.url`；清空 `''` → 200 且系统消息 `'alice 中文 移除了群头像'`
- carol（member）用**合法 https 值**改群头像 → **403 `OWNER_REQUIRED`**（注释：传合法值才能确认是权限拦下、不是校验拦下）
- 群主（alice）传 bob 的上传 → **400 `INVALID_AVATAR_URL`**（:418）

冒烟：`群头像用本人上传图片`（200 且等于 upload.url）、`群头像可清空`（200 且 `''`）两项 PASS。

> 契约 §10.2 说「`Conversation` 新增字段 `avatarUrl`……**已有该字段，无需新增**」——本轮确认该字段在 v0.2.0 已存在，本轮只是放宽其**取值语义**（从任意字符串收紧为三态校验），未改字段形状。

### 二.14 隔离实例冒烟（真进程 + 真 HTTP + 真 WS）

脚本 `backend/.data/ux2_smoke.mjs`（294 行，一次性，不入库）。启动方式等价于：
```
spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
  env: { ...process.env,
    PORT: '3098',
    DATABASE_PATH: '<repo>/.data/smoke-ux2/chat.sqlite',
    UPLOADS_DIR:  '<repo>/.data/smoke-ux2/uploads',
    ADMIN_UID: '1001',
    ADMIN_INITIAL_PASSWORD: 'smoke-admin-password-1',
    DEFAULT_FRIEND_USERNAME: '' }
})
```
它不替代单元测试，而是证明 `buildApp` 之外那层装配（端口、`DATABASE_PATH`、`ADMIN_UID`、`ADMIN_INITIAL_PASSWORD`、启动日志）也确实工作。

`cd backend && node .data/ux2_smoke.mjs` 实跑全文（**49/49 PASS，退出码 0**）：
```
PASS  health 版本与协议版本
PASS  管理员用纯数字 uid 登录
PASS  管理员 uid=1001 且 role=admin
PASS  注册 smokealice
PASS  注册 smokebob
PASS  注册 smokecarol
PASS  普通用户 uid 从 10001 起顺次分配
PASS  用数字 uid 登录普通账号
PASS  发起好友申请
PASS  接受好友申请
PASS  建立私聊
PASS  非管理员访问后台 → 403 ADMIN_REQUIRED
PASS  后台用户列表按 uid 升序
PASS  后台按账号名搜索
PASS  后台按 uid 搜索
PASS  统计含五个字段
PASS  禁言管理员 → 409 CANNOT_MUTE_ADMIN
PASS  删除管理员 → 409 CANNOT_DELETE_ADMIN
PASS  禁言普通用户 30 分钟
PASS  禁言期发消息 → 403 MUTED
PASS  minutes=0 解除禁言
PASS  上传 PNG → 201
PASS  上传返回 sha256 与磁盘字节一致
PASS  附件消息 type 由服务端推导为 image
PASS  同会话成员读附件 → 200 且字节一致
PASS  附件响应的安全头齐全
PASS  无关用户读附件 → 403 FORBIDDEN
PASS  匿名读附件 → 401
PASS  建群
PASS  群主任命管理员
PASS  管理员无权再任命 → 403 OWNER_REQUIRED
PASS  管理员可改群名
PASS  普通成员改群名 → 403 OWNER_REQUIRED
PASS  群头像用本人上传图片
PASS  群头像可清空
PASS  取 WS ticket
PASS  WS 握手 ready
PASS  群内发消息
PASS  管理员置顶消息 → 201
PASS  WS 收到 conversation.pins 完整列表
PASS  重复置顶幂等 200
PASS  幂等重放不重复广播
PASS  取消置顶 → 204 空正文
PASS  取消置顶广播空列表
PASS  删除账号 → 204 空正文
PASS  被删账号旧 token 立即失效
PASS  群主转移给 bob（最早加入的成员）
PASS  私聊只剩 1 人 → 会话被回收
PASS  /sync 40KiB JSON 仍被 413 拦下

=== 冒烟汇总：49/49 PASS ===
```

关键断言的期望值（脚本里写死的，不是「跑通了就算」）：
- `health` → `[version, protocolVersion] === ['0.2.0', 1]`
- 管理员 → `[uid, role] === [1001, 'admin']`
- 普通用户 → `[10001, 10002, 10003]`
- 后台列表 → `[1001, 10001, 10002, 10003]`
- 上传 sha256 === 磁盘字节 sha256
- 附件消息 `[status, type] === [201, 'image']`
- 同会话成员读 → `[200, sha256 一致]`
- 群主转移 → `myRole === 'owner'`
- 私聊回收 → `status === 404`
- `/sync` 40KiB JSON → `413`（回归：全局 JSON bodyLimit 仍是 32KiB，未被上传作用域放大）

---

## 三、门禁实测（契约 §十五）

全部命令在 `B:\AITrance\backend` 下执行；`/b/AITrance` 是 Git Bash 的路径映射。

### 3.1 `npm run check`（tsc --noEmit）

```
$ cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run check
> webchat-backend@0.2.0 check
> tsc --noEmit
（无输出，exit 0）
```

### 3.2 `npm test`（build + node --test）

```
$ node /e/nodejs/node_modules/npm/bin/npm-cli.js test
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5600.7258
```

**42 = 原有 33 条（chat 15 + security 8 + deploy-headers 4 + uploads 6，一条未退化）+ 本轮新增 9 条**。42 条逐条结果（全 ✔）：

chat（15）：`authentication, validation, profile, session renewal and revocation` / `both health routes expose the same numeric protocol version and UTC clock` / `friendship consent, search escaping and group authorization` / `message idempotency, per-conversation sequence, cursors and unread count` / `sync chunks and authorization are explicit and lossless` / `CORS, uniform errors, rate limiting and OpenAPI` / `registration creates reciprocal default friendship and notifies the online default account` / `disabled default friendship preserves the normal friend request flow` / `missing default account fails closed and registration failure rolls back automatic friendship` / `proxy-aware login limiting trusts loopback only and is disabled by default` / `real sockets deliver messages, presence, typing, read receipts and enforce ticket/session rules` / `SQLite survives process-equivalent restart with sessions and messages` / `WebSocket limits remain 1008, binary is 1003 and outbound session expiry is 4003` / `group system events and read state reach all devices without leaking after removal` / `removed groups cannot enter a sync batch, distinct chats maintain independent sequence`

deploy-headers（4）：`SEC-04 文档级 CSP 与后端常量逐字一致（两个 nginx 配置）` / `SEC-04 HSTS 只在 HTTPS 配置下发，且与后端常量一致` / `SEC-04 Permissions-Policy 与后端常量逐字一致（两个 nginx 配置）` / `上传：nginx client_max_body_size 必须大于应用层 UPLOAD_BODY_LIMIT`

security（8）：`SEC-01 TLS configuration is all-or-nothing and fails closed` / `SEC-01 HTTPS mode terminates TLS in-process and keeps health/API/headers intact` / `SEC-01 plaintext credential guard is fail-closed and proxy-aware` / `SEC-04 security headers are present, stable and do not break /docs or /openapi.json` / `BE-01 retention sweep removes only expired rows, is observable and runs at startup` / `BE-01 message retention is opt-in (default keeps rows) and deletes only aged rows` / `startup sweep happens inside buildApp so restarts converge expired state` / `rate limits stay at 10/min/IP with Retry-After and default friend failure keeps 503`

uploads（6）：`上传：魔数嗅探、sha256、下载字节与安全响应头` / `上传：Content-Type 被忽略、纯文本与超限/不支持类型的错误码` / `附件消息：type 由服务端推导、历史与 sync 可见、不可复用、缺内容报错` / `迁移：user_version 1 → 最新重建 messages 表且不丢数据` / `保留策略：sweep 只清理「无消息引用且已过期」的孤儿上传` / `回归：全局 JSON bodyLimit 仍是 32KiB，未因上传被放大`

ux2（9，本轮新增）：`账号：uid 分配与数字登录、禁言拦截、封禁拦截` / `管理后台：非管理员拒绝、搜索、禁言、保护管理员、统计` / `删除账号：消息清理、群主转移、空私聊回收与 token 失效` / `群角色：仅群主可任命、读写权限矩阵与退群规则` / `头像：空串、HTTPS 外链、本人图片三态与群头像权限` / `置顶：幂等、跨会话校验、上限、取消与列表排序` / `置顶变化通过 conversation.pins 广播完整列表` / `附件读取权限：属主、同会话成员、无关用户三档` / `迁移：user_version 2 的库升到 3，补列回填且幂等不丢数据`

### 3.3 `npm run docs` 幂等

```
$ sha256sum openapi.json   # 跑前
0e8bb35f0d3fcb1c7811245751d5b46448bc69349725e24398200ffac48e7e15
$ md5sum openapi.json
60dd64589bd8329bc46f472ca00ed713    (586618 字节, 18508 行)
$ node /e/nodejs/node_modules/npm/bin/npm-cli.js run docs
> webchat-backend@0.2.0 build
> tsc -p tsconfig.json
Generated openapi.json
$ sha256sum openapi.json   # 跑后
0e8bb35f0d3fcb1c7811245751d5b46448bc69349725e24398200ffac48e7e15
$ md5sum openapi.json
60dd64589bd8329bc46f472ca00ed713
```
**sha256 与 md5 跑前跑后完全一致**（连跑两次 `docs` 也一致），openapi 生成是幂等的。

### 3.4 `node scripts/check-contract.mjs`

```
$ cd /b/AITrance && node scripts/check-contract.mjs
=== 契约比对结果 ===
openapi 版本：0.2.0
openapi 路径数：31；需求书声明：37
字段检查 804 项；枚举检查 124 项；请求体检查 15 端点
ERROR 0 / WARN 0

✅ 无差异：需求书与 backend/openapi.json 完全一致
报告已写入 .\docs\contract\check-result.md
（EXIT=0）
```

门禁有效性未被本次改动削弱（`--self-test` 注入 4 处缺陷仍被抓到）：
```
$ node scripts/check-contract.mjs --self-test
ERROR=4 WARN=2
[structure] 端点缺失 GET /api/v1/friends
[response] GET /api/v1/conversations 响应缺少字段 items[].unreadCount
[body] POST /api/v1/conversations/{conversationId}/messages 请求体多出必填字段 extraRequired
[enum] GET /api/v1/conversations 字段 items[].type openapi 有枚举值 "directx"
✅ 门禁有效（命中 structure / response / body / enum）
```

### 3.5 `npm audit`

**未由我执行** —— Lead 正在把 fastify 从 5.12.5 升到 >=5.12.6 修 `GHSA-389g-gv7q-r4x8`（low），届时 `npm audit` 结果见 Lead 最终 PM 门禁报告。本 agent 按要求**未改** `backend/package.json`、`backend/package-lock.json`、`backend/node_modules`。

---

## 四、契约同步

### 4.1 `backend/openapi.json`（重新生成，18508 行 / 586618 字节 / 31 路径）

新增 8 条路径（`paths` 从 24 → 31，另有 uploads 3 条不在此轮但同属累计）：
```
$ node --input-type=module -e "…Object.keys(openapi.paths)…"
paths total 31
  /api/v1/conversations/{conversationId}/members/{userId}/role   post
  /api/v1/conversations/{conversationId}/pins                    get,post
  /api/v1/conversations/{conversationId}/pins/{msgId}            delete
  /api/v1/admin/users                                            get
  /api/v1/admin/users/{uid}/mute                                 post
  /api/v1/admin/users/{uid}                                      delete
  /api/v1/admin/stats                                            get
```
`info.version` 仍是 `0.2.0`（按既有「新增端点/新增可选字段/新增枚举值」三条规则判定为无破坏性增量，不 bump；详见 `docs/09-contract-changelog.md` 的「变更类别判定」子节）。

### 4.2 `contracts/requirements/rest-requirements.json`（2469 行）

- `version` 0.2.0 → **0.3.0**，`supersedes` 0.1.0 → **0.2.0**，`openapiVersion` 保持 `0.2.0`
- 端点 29 → **37**（新增 C9、P1、P2、P3、D1、D2、D3、D4）
- `definitions` 13 → **19**（新增 `PinnedMessage`、`PinnedMessagePage`、`AdminUserPage`、`AdminStats`，另 `User`/`ConversationMember`/`Conversation` 扩容）
- `User` required 扩为 11 字段（含 `uid` / `role` / `status` / `mutedUntil`）
- `GroupRole` / `Member.role` / `Conversation.myRole` 枚举扩为 `['owner','admin','member']`
- `A2`（登录）`username` 从 `pattern ^[A-Za-z0-9_]+$ / minLength 3` 放宽为 `minLength 1 / maxLength 32`，`errorCodes` 加 `ACCOUNT_BANNED`
- `M2`（发消息）`errorCodes` 加 `MUTED`、`ACCOUNT_BANNED`
- `U5`（读上传）的说明从「仅属主」改为「属主或该附件所属会话的成员」

校验：`node --input-type=module` 读取实跑
```
rest version 0.3.0 supersedes 0.2.0 openapiVersion 0.2.0 endpoints 37 defs 19
C9,P1,P2,P3,D1,D2,D3,D4 defs 19
```

### 4.3 `contracts/requirements/errors.json`（382 行）

- `version` **0.3.0**、`supersedes` **0.2.0**
- 码 35 → **44**，新增 9 个（契约 §十三 清单，逐一核对）：
```
$ node -e "…errors.codes 过滤…"
400 CANNOT_CHANGE_OWNER_ROLE
400 INVALID_MESSAGE
403 ACCOUNT_BANNED
403 MUTED
403 ADMIN_REQUIRED
404 PIN_NOT_FOUND
409 CANNOT_DELETE_ADMIN
409 CANNOT_MUTE_ADMIN
409 PIN_LIMIT
```
- 新增第 4 条 `notes`，说明 9 个新码的分组理由与「刻意不新造 422/423/451 之类状态码」的取舍（禁言用 403 而非 429：前者权限恒被拒、后者频率可退避；删/禁言管理员用 409 而非 403：请求合法只是身份冲突）

### 4.4 `contracts/requirements/ws-requirements.json`（531 行）

- `version` **0.3.0**、`supersedes` **0.2.0**
- `serverToClientEvents` 12 → **13**，帧序：
```
ready, pong, message.created, conversation.created, conversation.updated,
conversation.removed, conversation.read, conversation.pins,
friend.requested, friend.resolved, presence.changed, typing.changed, error
```
- `conversation.pins` 的 `data` required `['conversationId','pins']`，`pins` 为 `$ref rest-requirements.json#/definitions/PinnedMessage` 数组
- 帧名 / envelope / 心跳 / close code **一律未变**（客户端不需要改握手逻辑）

### 4.5 `docs/03-ws-protocol.md`（540 行）

```
$ grep -n '^### 4\.' docs/03-ws-protocol.md
290:### 4.1 客户端 → 服务端（2 个）
297:### 4.2 服务端 → 客户端（13 个）      ← 原「12 个」
315:### 4.3 `conversation.read` 的两条前端规则
358:### 4.4 已读上报流程
375:### 4.5 附件消息（`type: image` / `type: file`）
407:### 4.6 消息置顶（`conversation.pins`）  ← 本轮新增
440:## 5. 心跳、看门狗与重连
$ grep -c conversation.pins docs/03-ws-protocol.md
3
```
变更点：
1. §4.2 标题 `（12 个）` → `（13 个）`，表格在 `conversation.read` 行后插入 `conversation.pins` 行，并注明「**完整列表**，不是增量」
2. 新增 §4.6：REST 三接口代码块 + 广播帧形状 + `PinnedMessage` 字段表（`id` 是 pin 记录自身 id **不是 msgId**、`message` 是完整 Message 含 attachment、`pinnedBy` 是完整 User、`pinnedAt`）+ 5 条前端纪律（完整列表不 merge、不重排、幂等重放不广播、取消恒广播含 `pins: []`、悬空 pin 静默跳过）+ 权限说明（三档角色都可置顶，上限 50 超限 409 `PIN_LIMIT`）
3. §4.5 末尾「已知限制」整段重写：从「仅属主可读，无法渲染他人附件」改为「属主 **或** 该附件被某消息引用且请求者是该会话成员，其余 403 `FORBIDDEN`；对方发来的附件现在可正常渲染（本轮 P0 修复）；但刚上传未发出的草稿附件除属主外谁都读不到 —— 这是有意的」
4. 小节重排为连续编号 4.1~4.6（原来 4.5 排在 4.4 之前的错序已修）

### 4.6 `docs/09-contract-changelog.md`（360 行）

```
$ grep -n v0.3.0 docs/09-contract-changelog.md
15:| v0.3.0 | 2026-10-23 | `0.2.0` | **0** | **0** | **增量扩展**（…）|
218:## v0.3.0（第二轮体验改造）：数字 uid / 管理员 / 群角色 / 置顶 / 附件可读范围
```
变更点：
1. 版本总览表新增一行（版本 / 日期 / openapi 版本 / ERROR 数 / WARN 数 / 变更类别）
2. 新增整节（:218），含 10 个子节：性质说明（纯增量 + 一处行为**放宽**；`U5` 从「仅属主」放宽到「属主或同会话成员」是放宽不是收紧，原先 403 现 200，正常路径不受影响）/ 新增端点 8 个表 / 新增变更字段表 / 新增错误码 9 个表 + 状态码选型说明 / WS 第 13 帧 / 存储层 v2→v3 表 / 机械门禁实跑块 / 变更类别判定表（结论不 bump `info.version`，但 requirements `version` 升 0.3.0 是「我方依赖声明」的另一维度）/ 前端必须做的事 7 条 / 后端交付证据指向本文

---

## 五、未验 / BLOCK / 风险

**以下各项我未亲手验证，一律不写 PASS。**

### 5.1 未验证（明确未做）

| 项 | 状态 | 说明 / 建议的验证方式 |
| --- | --- | --- |
| `npm audit` | **未验** | 由 Lead 执行（fastify 5.12.5 → >=5.12.6 修 `GHSA-389g-gv7q-r4x8`，low）。本 agent 未改任何 `package*.json` / `node_modules` |
| 生产 nginx 配置 | **未验** | 本轮**无 CSP 变更**，两个 `nginx-chat.conf` 一字节未改，`deploy-headers.test.ts` 4 条仍全绿证明与后端常量一致。但 nginx 版本差异、`add_header` 继承规则、`client_max_body_size` 在生产的实际生效未验（沿用 task-6 的 `client_max_body_size` 结论） |
| 真实浏览器 | **未验** | 未验证个人资料页/admin 页/置顶条在 Chrome/Safari 的实际渲染；未验证 `<img>` 走 `fetchObjectUrl` + blob 的路径（前端任务） |
| 真机 / 移动端 | **未验** | 长按菜单、底部 sheet、移动端置顶条布局均属前端范畴，本 agent 未验 |
| 管理后台前端联调 | **未验** | 我已按契约 §六 交付 4 个接口并冒烟，但前端 `/admin` 页面是否按契约字段渲染（`nextOffset` 分页、`mutedUntil` 显示、二次确认）未联调 |
| 前端整体联调（登录页 UID 提示、`#10001` 展示、群角色徽标、置顶跳转） | **未验** | 由前端 agent 交付 `frontend/evidence/ux2-frontend.md`，两侧未做过端到端联跑 |
| 生产 `ADMIN_INITIAL_PASSWORD` | **未验** | 默认值 `A454545asd@` 是**开发默认值**，生产必须通过环境变量覆盖；生产是否已覆盖我无从得知 |
| 多实例部署 | **未验** | 当前单机架构。多实例共用一个 SQLite 文件时 `BEGIN IMMEDIATE` + `busy_timeout 5000` 的争用行为未压测；`ensureAdmin` 的「两进程同时首启」竞态只做了代码级防护（事务内二次复查），未做真并发压测 |
| 置顶 50 条上限的交互体验 | **未验** | 后端 409 `PIN_LIMIT` 已实测，但前端在满 50 条时如何提示未验 |
| 大数据量迁移 | **未验** | 迁移只在「3 用户 / 1 会话 / 1 消息」的小库上验过幂等；10 万行 messages 的 `DELETE FROM messages WHERE sender_id` 与 `message_pins WHERE msg_id NOT IN (...)` 的耗时未测（当前 `messages` 有 `(conversation_id, seq)` 与 `msg_id` 唯一索引，但**没有 `sender_id` 索引**） |
| WS 广播的 fan-out 性能 | **未验** | `broadcastPins` 对每成员单独 `publish` 并各自 `listPins`（N 次查询），大群（100 人）下单次置顶约 100 次 `listPins`；功能正确性已测，性能未测 |
| TLS / `wss://` 下的新接口 | **未验** | 已测的都是 `http://127.0.0.1:3098`；`ws://` 广播在 `wss://` 下的行为未单独验（沿用既有 security.test.ts 的 TLS 覆盖） |

### 5.2 BLOCK（有明确阻碍，需他人或后续处理）

| 项 | 阻碍 | 影响 |
| --- | --- | --- |
| `npm audit` 门禁 | fastify `GHSA-389g-gv7q-r4x8`（low），需升级到 >=5.12.6 | PM 门禁 `backend-audit` 在 Lead 升级完成前会是红的。**已由 Lead 承接**，不阻塞功能验收 |
| 前端两侧联调 | 前端 agent 交付中 | 后端契约已冻结并全绿；真实用户体验（图片缩略图、admin 页、置顶跳转）需两侧合并后才可验收 |

### 5.3 残余风险 / 已知限制

1. **`message_pins` 刻意不加 `msg_id` 外键**（`db.ts:96-98` 注释）。好处是删消息不必先删置顶；代价是可能出现「悬空 pin」。当前由两处兜底：读列表时 `pinnedMessage()` 返回 `null` 被 filter 掉（前端看不到坏数据），以及 `deleteUser` 里的 `DELETE ... WHERE msg_id NOT IN (SELECT msg_id FROM messages)`。**但如果消息因保留策略被 sweep 删除，悬空 pin 行会一直留在表里**（只是读不到），长期看需要 sweep 也清理 `message_pins`。本轮未加（契约未要求，且加了会与 BE-01 的既有计数语义耦合）。
2. **`conversation_members.role` 与 `conversations.owner_id` 是双源真相**。`memberRole()` 以 `owner_id` 优先（`owner_id === userId` → `'owner'`），只在非群主时读成员行。迁移与群主转移都保证两者一致，但**任何未来直接改 `owner_id` 而不改成员行的代码都会造成「群主能做但成员列表显示 member」**。已在 `db.ts:218-223` 注释里写明。
3. **`deleteUser` 的 `remaining <= 1` 是刻意偏离契约字面**。契约写「私聊会话若只剩 1 人 → 连会话一起删」，而代码变量 `remaining` 是「除目标之外的人数」，所以 `<= 1` 才等于契约语义（`=== 0` 会留下只有对方的空壳私聊）。已在 `service.ts:813-815` 注释说明，避免下次有人「按字面改成 === 0」。
4. **`readUpload` 的放宽涉及「转发」语义边界**。当前实现是「附件被任意消息引用 + 请求者是**那条消息的会话**成员」，所以 A 把它发到群 1 后，群 1 成员都能读；若同一 uuid 再被转发到群 2，群 2 成员也能读。这是符合直觉的，但意味着**权限随消息扩散而扩散**，不可收回（除非删掉所有引用该附件的消息）。契约 §八 的查询语句即如此，且附件本身没有独立 ACL 设计。
5. **禁言与封禁的鉴权时机**。`ACCOUNT_BANNED` 在发消息时实时检查（旧 token 也拦），但**只拦发消息**；被 ban 用户仍能用旧 token 读历史、看会话，直到 token 过期（7 天）或管理员删号。契约 §5.3 只要求拦发消息 + 5.1 要求拦登录，未要求全接口拦截。若产品需要「封禁即踢下线」，需在 `authenticate` 阶段加 status 检查，本轮未做。
6. **`uid` 不复用**。删除账号后其 uid 不会被回收（`MAX(uid)+1` 单调），所以 uid 会稀疏。这是契约 §二 的隐含语义（`10001` 起逐次 +1），对管理员排查有利（不会撞号），但**用户数上限约 9900 万**（INTEGER 够用，实际是前端展示与产品约定层面）。
7. **`ensureAdmin` 用 `username = String(adminUid)`**，即管理员账号名是 `'1001'`。`username` 列是 `UNIQUE COLLATE NOCASE`，若已有普通用户恰好叫 `'1001'`（注册接口的 `Username` pattern `^[A-Za-z0-9_]+$` 允许纯数字），`ensureAdmin` 的 INSERT 会撞唯一约束抛错 → **启动失败**。当前注册接口未禁止纯数字用户名，这是一个理论上的配置冲突（需运维避免或后续在注册时排除 `1000..9999` 纯数字名）。本轮未加防护（契约未要求，加了会改变注册语义）。
8. **`muted_until` 用 `Date.parse` 比较**，对非法字符串 `Date.parse → NaN`，`NaN > Date.now()` 为 `false`，即**脏数据会被当成未禁言**（fail-open）。这是有意的（禁言是限制而非安全边界，fail-open 比 fail-closed 更不易误伤），但如果将来禁言用于合规场景需改为 fail-closed。
9. **`GET /api/v1/uploads/:id` 的响应 `Cache-Control: private, max-age=31536000, immutable`**（task-6 遗留）。同一 URL 的权限可能因「消息被删」而变化，但浏览器会长期缓存该响应 → **用户被移出群后仍可能从本地缓存看到图**。属可接受的服务端无状态取舍，但需要知道。
10. **测试的非确定性风险**。`ux2.test.ts:297` 的成员顺序断言用了 `sort()` 规避「`joined_at` 相同 → 退化为 UUID 排序」的不确定性（改的是测试，不是产品 ORDER BY）。若未来产品把 `ORDER BY joined_at, user_id` 改成别的，该断言仍会正确（因为它先排序）。

---

## 六、复现命令（一键核对）

```bash
# 1. 类型检查
cd /b/AITrance/backend && node /e/nodejs/node_modules/npm/bin/npm-cli.js run check

# 2. 全量测试（应 42/42）
node /e/nodejs/node_modules/npm/bin/npm-cli.js test

# 3. openapi 重生成 + 幂等核对
node /e/nodejs/node_modules/npm/bin/npm-cli.js run docs
sha256sum openapi.json   # 应为 0e8bb35f0d3fcb1c7811245751d5b46448bc69349725e24398200ffac48e7e15

# 4. 契约门禁（应 ERROR 0 / WARN 0）
cd /b/AITrance && node scripts/check-contract.mjs

# 5. 迁移幂等性独立证明
cd /b/AITrance/backend && node .data/ux2_migration_proof.mjs

# 6. 隔离实例冒烟（应 49/49 PASS，占用 127.0.0.1:3098）
node .data/ux2_smoke.mjs

# 7. 只跑本轮新增的 9 条（实跑：tests 9 / pass 9 / fail 0）
node --test --test-name-pattern="账号|管理后台|删除账号|群角色|头像|置顶|附件读取权限|迁移：user_version 2" dist/test/ux2.test.js
```
