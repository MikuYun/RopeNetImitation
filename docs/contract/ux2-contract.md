# 第二轮体验改造 · 契约基准（Lead 定稿，前后端唯一依据）

版本：v0.3.0（在 v0.2.0 + uploads 之上增量扩展）
本文件由 Lead 撰写并冻结。任何 agent 实现时必须逐字对齐本文件；
发现本文件不可实现或自相矛盾，**立即停下报告 Lead，不得自行改契约**。

---

## 一、数据库 schema v3（`PRAGMA user_version` 2 → 3）

必须写**幂等迁移**（重复启动不重复执行），沿用现有 `Store.migrate()` 的模式。
新增列一律用 `ALTER TABLE ... ADD COLUMN`，**不要重建表**（除 messages 已有的一次性重建逻辑保持不变）。

### users 扩列
```
uid          INTEGER UNIQUE          -- 见「二、uid 分配」
role         TEXT NOT NULL DEFAULT 'user'    CHECK(role IN ('user','admin'))
status       TEXT NOT NULL DEFAULT 'active'  CHECK(status IN ('active','banned'))
muted_until  TEXT                    -- ISO8601；NULL 或过去时间 = 未禁言
```
注意：SQLite 的 `ADD COLUMN` **不支持**加带 CHECK 的列时引用其它列，且新增列不能是 UNIQUE 约束的一部分由 ADD COLUMN 直接建索引 ——
因此 `uid` 用 `ALTER TABLE users ADD COLUMN uid INTEGER` 加列，再 `CREATE UNIQUE INDEX IF NOT EXISTS users_uid ON users(uid) WHERE uid IS NOT NULL`。
`role`/`status` 的 CHECK 无法通过 ADD COLUMN 附加到既有表（SQLite 允许 ADD COLUMN 带 CHECK，但该 CHECK 只对新写入生效；
为保持简单且可读，本版**用 ADD COLUMN 带 CHECK**，并在应用层同样校验一次）。

### conversations 扩列
```
avatar_url   TEXT NOT NULL DEFAULT ''
```

### conversation_members 扩列
```
role         TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'))
```
迁移时必须回填：`UPDATE conversation_members SET role='owner' WHERE user_id = (SELECT owner_id FROM conversations WHERE id = conversation_members.conversation_id)`。
（现有数据里群主本来就在 members 表里，回填保证 role 与 owner_id 一致。）

### 新表 message_pins
```
CREATE TABLE IF NOT EXISTS message_pins (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL,                 -- 指向 messages.msg_id
  pinned_by TEXT NOT NULL REFERENCES users(id),
  pinned_at TEXT NOT NULL,
  UNIQUE(conversation_id, msg_id)
);
CREATE INDEX IF NOT EXISTS message_pins_conversation ON message_pins(conversation_id, pinned_at DESC);
```

`SCHEMA_VERSION` 常量改为 3。

---

## 二、uid 分配

- 系统管理员固定 `uid = 1001`。
- 普通用户从 `10001` 开始，逐次 `+1`（10001、10002、…）。
- 分配算法（必须在**同一个事务**内，防并发重号）：
  `SELECT COALESCE(MAX(uid), 10000) + 1 AS next FROM users WHERE uid >= 10001`
- 注册时写入 uid。
- **迁移既有用户**：按 `users.created_at, users.id` 升序，从 10001 起依次回填 uid（老用户在 1001 之后的序号）。
  管理员 1001 若已存在用户则不重复创建。
- `username` 保持原语义（登录账号名）；**uid 是新增的可登录标识**，两者都能登录。

---

## 三、系统管理员初始化

- 配置项（`backend/src/config.ts`，都要有环境变量 + 默认值 + 校验）：
  - `adminUid`：环境变量 `ADMIN_UID`，默认 `1001`，必须为 1000..9999 的整数。
  - `adminInitialPassword`：环境变量 `ADMIN_INITIAL_PASSWORD`，默认 `A454545asd@`，长度 8..128。
- 启动时（`buildApp` 内、routes 注册前）执行 `ensureAdmin(store, config)`：
  - 若 `SELECT 1 FROM users WHERE uid = adminUid` 已存在 → **什么都不做**（不改密码、不改昵称，避免重启覆盖用户改过的密码）。
  - 否则创建：`username` = String(adminUid)（即 `'1001'`），`display_name` = `'系统管理员'`，`role` = `'admin'`，`uid` = adminUid，
    `password_hash` = `hashPassword(adminInitialPassword)`。
  - 启动日志打一行：`admin bootstrap: created` 或 `admin bootstrap: exists`。**不得打印密码**。

---

## 四、用户对象（wire `User`）扩展

```ts
User = {
  id: string            // UUID，内部主键，保持
  uid: number           // 新增：对外可展示、可登录的稳定数字 id
  username: string      // 账号名称
  displayName: string   // 昵称（聊天时显示的名字）
  avatarUrl: string     // https 外链 或 /api/v1/uploads/<uuid>
  bio: string
  role: 'user' | 'admin'          // 新增
  status: 'active' | 'banned'     // 新增
  mutedUntil: string | null       // 新增；ISO8601 或 null
  createdAt: string
  online: boolean
}
```
`mutedUntil` 语义：非 null 且 `Date.parse(mutedUntil) > Date.now()` 才算「当前被禁言」。

---

## 五、认证相关

### 5.1 `POST /api/v1/auth/login`
沿用 body `{ username, password }`，**不新增字段**。
- `username` 纯数字（`/^\d+$/`）时按 **uid** 查；否则按 username 查（原逻辑，`COLLATE NOCASE` 已在小写化后匹配）。
- 查不到 / 密码错 → 同样 401 `INVALID_CREDENTIALS`（不区分，防枚举）。
- 命中 `status='banned'` → 403 `ACCOUNT_BANNED`，message「账号已被禁用，请联系管理员」。

### 5.2 `POST /api/v1/auth/register`
body 仍为 `{ username, password, displayName }`；成功返回的 `user` 带上新分配的 `uid`。
若新注册账号的 `status='banned'`（正常不会）→ 403 `ACCOUNT_BANNED`。

### 5.3 禁言对发消息的影响
`POST /api/v1/conversations/:conversationId/messages` 在 `requireMember` 之后检查：
若 `mutedUntil` 有效（未来时间）→ 403 `MUTED`，message「你已被禁言，解除时间 <ISO>」。
其它接口不受影响（可读、可登录、可加好友）。

### 5.4 被删除账号的既有会话
`DELETE /api/v1/admin/users/:uid` 直接删 users 行；依赖既有外键
（sessions/uploads/friendships/friend_requests/conversation_members 级联或直接删除；
messages.sender_id 是 `REFERENCES users(id)` 无 ON DELETE，**必须显式先删该用户的 messages**，
否则外键约束会拒绝删除）。删除后：
- 该用户的 sessions 全部失效（WS 连接必须 `realtime.revoke` 逐个踢掉 → 用 `POST /admin/...` 内部循环踢）。
- 群聊里他的成员行删除；若他是群主，群主转移给最早加入的其他成员（并同步 `conversations.owner_id` 与 members.role）。
- 私聊会话若只剩 1 人 → 连会话一起删（`conversations` + `messages` + `conversation_members` 级联已配 ON DELETE CASCADE，直接 DELETE conversations 即可）。
- 不允许删除 `role='admin'` 的账号 → 409 `CANNOT_DELETE_ADMIN`。
- 不存在 → 404 `USER_NOT_FOUND`。
- 成功 → 204。

---

## 六、管理后台接口（全部要求 `role='admin'`，否则 403 `ADMIN_REQUIRED`）

统一前缀 `/api/v1/admin`。`:uid` 路径参数是**数字 uid**（不是 UUID）。

### 6.1 `GET /api/v1/admin/users`
- querystring：`{ query?: string, limit?: 1..100 默认 30, offset?: >=0 默认 0 }`
  `query` 非空时按 `username LIKE` / `display_name LIKE` / `CAST(uid AS TEXT) LIKE` 模糊匹配。
- 200：`{ items: User[], nextOffset: number | null }`（`User` 见 §四）。
- 排序：`uid ASC`（管理员 1001 在最前，普通用户按注册顺序）。

### 6.2 `POST /api/v1/admin/users/:uid/mute`
- body：`{ minutes: number | 0 }`，`0` = 解除禁言；`1..525600`（最长 365 天）。
- 200：返回更新后的 `User`。
- 目标不存在 → 404 `USER_NOT_FOUND`；目标是管理员 → 409 `CANNOT_MUTE_ADMIN`。
- 实现：`UPDATE users SET muted_until = ? WHERE uid = ?`，`minutes>0` 时 `new Date(Date.now()+minutes*60000).toISOString()`，否则 NULL。

### 6.3 `DELETE /api/v1/admin/users/:uid`
见 §5.4。

### 6.4 统计（管理后台首页用）
`GET /api/v1/admin/stats` → 200 `{ users: number, conversations: number, messages: number, uploads: number, online: number }`
（`online` 用 `realtime` 当前连接用户数；实现方式自定，必须有）。

---

## 七、群聊角色（owner / admin / member）

`Member` 与 `Conversation.myRole` 的 role 联合类型扩为 `'owner' | 'admin' | 'member'`。

### 7.1 权限矩阵（本版必须实现）
| 操作 | owner | admin | member |
| --- | --- | --- | --- |
| 改群名 / 群头像 | ✅ | ✅ | ❌ |
| 邀请成员 | ✅ | ✅ | ❌ |
| 移除他人 | ✅（可移除 admin 与 member） | ✅（仅可移除 member） | ❌ |
| 设置/取消管理员 | ✅ | ❌ | ❌ |
| 置顶/取消置顶 | ✅ | ✅ | ✅ |
| 退群 | ❌（本版不支持群主退群，沿用 409 `OWNER_CANNOT_LEAVE`） | ✅ | ✅ |

### 7.2 `PATCH /api/v1/conversations/:conversationId`
body 扩为 `{ name?: Text(60), avatarUrl?: string }`，至少一个（`minProperties: 1`）。
- `name` 要求 owner 或 admin → 否则 403 `OWNER_REQUIRED`（沿用既有错误码，message 改为「只有群主或管理员可以执行此操作」）。
- `avatarUrl` 接受空串、`https://` 外链、或站内 `/api/v1/uploads/<uuid>` 形式；其它 → 400 `INVALID_AVATAR_URL`。
- 私聊会话不允许改（400 `GROUP_REQUIRED`）。

### 7.3 `POST /api/v1/conversations/:conversationId/members/:userId/role`
- body：`{ role: 'admin' | 'member' }`
- 仅 owner 可调用（否则 403 `OWNER_REQUIRED`）。
- 不能改自己的 role（400 `CANNOT_CHANGE_OWNER_ROLE`）；不能把 owner 降级。
- `:userId` 这里是 **UUID**（沿用既有成员接口用 user.id 的一致性）。
- 200：返回更新后的 `Conversation`。
- 目标不是本群成员 → 404 `MEMBER_NOT_FOUND`。
- 行为变化时插一条 system 消息：`X 成为管理员` / `X 被取消管理员`。
- 同步 `conversation_members.role`；`conversations.owner_id` 不变。

### 7.4 移除成员的权限调整
`DELETE /api/v1/conversations/:conversationId/members/:userId`：
- 操作者 owner → 可移除 admin/member；操作者 admin → 只能移除 member（移除 admin 返回 403 `OWNER_REQUIRED`）；member 仍只能移自己（退群）。

---

## 八、附件权限修复（P0，用户实测 bug）

现状：`backend/src/service.ts` 的 `readUpload` 对非属主直接 `403 FORBIDDEN`，导致「对方发来的图片/文件点开就失败」。

新规则（`GET /api/v1/uploads/:id`）：
- 属主本人 → 允许。
- 否则：若该附件被**某条消息引用**，且请求者是该消息所属会话的成员 → **允许**。
  查询：`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
         WHERE m.attachment_id = ? AND cm.user_id = ?`
- 其余 → 403 `FORBIDDEN`（保持原码）。
- 附件存在但未被任何消息引用、且请求者不是属主 → 403（尚未发送的附件不能跨人访问）。

**这条修复是所有附件体验的前提，必须最先落地并单测覆盖三种情况（属主/同会话成员/无关用户）。**

---

## 九、消息置顶

### 9.1 `GET /api/v1/conversations/:conversationId/pins`
- 成员限定。200：`{ items: PinnedMessage[] }`，按 `pinned_at DESC` 排序。
```ts
PinnedMessage = {
  id: string            // pin 记录 id
  message: Message      // 复用既有 Message 结构（含 attachment）
  pinnedBy: User
  pinnedAt: string
}
```

### 9.2 `POST /api/v1/conversations/:conversationId/pins`
- body：`{ msgId: string }`（**是 message 的 `msgId` UUID，不是 seq**）
- 成员即可（owner/admin/member 都能置顶，见 §7.1）。同一条消息重复置顶 → 幂等返回 200 原记录。
- 201 返回 `PinnedMessage`。
- 消息不属于该会话 → 400 `INVALID_MESSAGE`。
- 单会话置顶上限 50 条 → 409 `PIN_LIMIT`。

### 9.3 `DELETE /api/v1/conversations/:conversationId/pins/:msgId`
- 成员即可。不存在 → 404 `PIN_NOT_FOUND`。成功 204。
- 注意 `:msgId` 是消息 UUID。

### 9.4 WS 广播
- 置顶/取消置顶后向会话全体成员推 `conversation.pins` 事件：
  `{ type: 'conversation.pins', data: { conversationId, pins: PinnedMessage[] } }`
  （与既有 `conversation.created` / `conversation.updated` 同一套 publish 机制）。
- 前端收到后刷新置顶列表。

---

## 十、头像

### 10.1 用户头像
沿用 `PATCH /api/v1/users/me` 的 `avatarUrl` 字段，但**放宽校验**：
- 空串 → 清空头像。
- `https://...` 外链（沿用现有校验：无 userinfo）。
- `/api/v1/uploads/<uuid>` → 站内上传的图片（要求：该 upload 必须 `kind='image'` 且属主是本人，否则 400 `INVALID_AVATAR_URL`）。
- 其它 → 400 `INVALID_AVATAR_URL`。

前端渲染头像时：`avatarUrl` 以 `/api/v1/` 开头时**必须走 `fetchObjectUrl` 拿 blob**，不得直接塞 `<img src>`（无 Bearer 会 401）。
为此新增**免鉴权不了也做不到**，所以头像显示统一走 `AppAvatar` 组件的内部 blob 解析（见前端任务）。

### 10.2 群头像
`PATCH /api/v1/conversations/:conversationId` 的 `avatarUrl`，校验同上（上传的图必须属主是操作者本人且 `kind='image'`）。
`Conversation` 新增字段 `avatarUrl`（群聊=群头像；私聊=空串或对方头像，由前端决定，后端固定返回 `conversations.avatar_url`）。**已有该字段，无需新增**。

---

## 十一、前端消息操作按钮（不遮挡正文）

要求（用户实测痛点，移动端最严重）：
1. `.bubble__tools` **不得**绝对定位覆盖在气泡正文之上。
2. 桌面：hover 时在气泡**外侧**出现（右侧/左侧贴边，与气泡有间距），不压内容。
3. 移动端：**不悬浮**。改为长按气泡弹出操作菜单（`AppModal`/底部 sheet），菜单项：复制、看源码/看渲染、置顶、下载附件（有附件时）。
4. 保留既有 e2e 契约：`.bubble`、`.bubble--mine`、`.bubble--peer`、`.bubble__text`、`.line`、`.line__avatar`、`.line__time`、`.sys`、`.sys__text` 类名**一个都不能删**；`.bubble__tools` 若保留必须仍存在于 DOM（e2e 有用 `.bubble__tool` 计数的断言，需实测确认后保留或同步告知 Lead）。

---

## 十二、「发送图片」与「上传文件」分离

`MessageComposer` 现有单个附件按钮（`ComposerToolbar` 的 `pick-file`）。改为两个入口：
- **图片按钮**：`<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">`（`capture` 不加，让用户选相册或拍照由系统决定）。
- **文件按钮**：`<input type="file">`（不限制，后端白名单决定成败）。

上传成功后：
- 图片 → 立即以**缩略图**进入待发送区，发送后气泡内显示缩略图（点击开灯箱看原图）。
- 文件 → 文件卡片。

**渲染规则统一**：只要 `attachment.kind === 'image'` 就**一律**渲染缩略图（无论从哪个入口上传），
这样「上传文件」里选的 png 也能直接看图，符合用户诉求。

---

## 十三、错误码新增清单（`contracts/requirements/errors.json` 必须同步）

| code | status | 场景 |
| --- | --- | --- |
| `ACCOUNT_BANNED` | 403 | 登录时账号被禁用 |
| `MUTED` | 403 | 禁言期间发消息 |
| `ADMIN_REQUIRED` | 403 | 非管理员访问 /admin/* |
| `CANNOT_DELETE_ADMIN` | 409 | 删除管理员账号 |
| `CANNOT_MUTE_ADMIN` | 409 | 禁言管理员账号 |
| `CANNOT_CHANGE_OWNER_ROLE` | 400 | 修改群主角色 |
| `INVALID_MESSAGE` | 400 | 置顶的消息不属于该会话 |
| `PIN_LIMIT` | 409 | 置顶超过 50 条 |
| `PIN_NOT_FOUND` | 404 | 取消置顶的记录不存在 |

---

## 十四、前端页面要求

1. **登录页**：`账号` 输入框 placeholder 改为「账号名或 UID」，提示可用 uid 登录。
2. **个人资料页**（新页面 `/profile` 或复用会话信息页的入口）：
   展示并可编辑：头像（点击上传）、账号名称（uid 只读展示，不可改）、昵称（可改）、个人简介（可改）。
   必须显示 **UID** 与 **账号名** 两项，且可复制 UID。
3. **群聊信息页**（`ConversationInfoView`）：
   - 群名可改（owner/admin 可见入口）、群头像可换（owner/admin）。
   - 成员列表显示角色徽标（群主/管理员），owner 可以对成员「设为管理员 / 取消管理员」「移出群聊」，admin 可移出普通成员。
4. **管理后台**（新页面 `/admin`，仅 `role==='admin'` 可进，非管理员访问跳 404 或回 `/chat`）：
   - 概览：用户数/会话数/消息数/在线数。
   - 用户列表：UID、账号名、昵称、状态、注册时间、在线、操作（禁言 N 分钟 / 解除禁言 / 删除）。
   - 删除与禁言都要二次确认（`AppModal`）。
5. **消息置顶**：会话顶部显示置顶条（点击跳到该消息）；长按/悬浮菜单可「置顶/取消置顶」。
6. **个人信息里的 uid 显示**：`#10001` 形式。

---

## 十五、门禁与证据

- 后端：`npm run check`（tsc --noEmit）必须 0 error；`npm test` 全绿（现有 33 条不得退化，新增测试覆盖 §四~§九）。
- `npm run docs` 重新生成 `backend/openapi.json`；`node scripts/check-contract.mjs` 必须 ERROR 0 / WARN 0。
- 前端：`vue-tsc --noEmit` 0 error；`vitest run` 全绿（现有 172 条不得退化）。
- 两侧都要写证据文件：
  - `backend/evidence/ux2-backend.md`
  - `frontend/evidence/ux2-frontend.md`
- 不得 commit / tag；不得碰 `management/`；不得访问 mikuyun.xyz。
