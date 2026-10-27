# AITrance v2 发布说明

版本：接口 `0.3.0`，业务协议 `protocolVersion = 2`，数据库 `SCHEMA_VERSION = 4`。
基线：git `7ab67ef`（`chore: baseline snapshot before v2 platform upgrade`）。
本文件是 v2 的交付总账：做了什么、破坏性变更、怎么迁移、怎么验证、还差什么。

---

## 1. 六项需求对照

| # | 需求 | 实现位置 | 验证 |
|---|---|---|---|
| 1 | 个人信息重构：PC 左上角头像进抽屉；移动端底部第三位 tab；退出登录二次确认；主题入口移入 | `frontend/src/components/layout/AppRail.vue`（补 `:src`）、`components/profile/ProfileDrawer.vue`、`ProfileSheet.vue`、`layouts/MobileNav.vue`（第三位「更多」→「个人信息」）、`views/ProfileView.vue` | `e2e-v2` 抽屉/二次确认/移动端三段态；`docs/evidence/v2-req1-*.png` |
| 2 | 点任意头像进访客资料页 | `views/UserProfileView.vue`、`components/message/MessageBubble.vue`（`emit('open-profile')`）、`views/MessagePane.vue`（`onOpenProfile` → `router.push`） | `e2e-v2` 气泡头像点击；`docs/evidence/v2-req2-visitor-profile.png` |
| 3 | ≥5 预置主题 + 自定义 RGB（含聊天框、字体、背景） | `frontend/src/styles/theme.css`（7 套 × 31 变量）、`stores/ui.ts`、`components/theme/ThemePicker.vue` | `e2e-v2` 七套切换 + 自定义落盘 + 刷新保持；`docs/evidence/v2-req3-*.png` |
| 4 | 多图多文件（≤9 图 + ≤1 视频）、图片必带文字、文字不被吞、有附件时 Enter 不发 | `components/message/MessageComposer.vue`、`AttachmentView.vue`（九宫格 + 视频 + 灯箱）、`MessageBubble.vue`、`utils/attachments.ts` | `e2e-v2` + `e2e-attachment` 38/38；`docs/evidence/v2-req4-*.png` |
| 5 | 清库仅保留管理员 `root` / `12345678` | `backend/scripts/reset-db.mjs`、`backend/src/config.ts`（`ADMIN_USERNAME=root`、`ADMIN_INITIAL_PASSWORD=12345678`）、`backend/src/bootstrap.ts`（`ensureAdmin`） | 真实库副本端到端：清空 16 张业务表 → `users=1` → 重启 → `POST /auth/login` 200 |
| 6 | 广场（帖子 / 图片 ≤9 / 视频 ≤1 / 文字 ≤5000） | 后端 `POST|GET /posts` 等 9 端点 + 4 张新表；前端 `views/SquareView.vue`、`components/square/*`、`stores/square.ts`、`api/posts.ts` | `e2e-v2` 发布/点赞/评论/超限拦截；`docs/evidence/v2-req6-*.png` |

七套主题 id：`light` / `dark` / `ocean` / `forest` / `sakura` / `midnight` / `custom`
（前两套沿用旧名以兼容既有 localStorage 与历史 e2e）。自定义主题存于
`localStorage['aitrance.theme.custom']`，字段见 `docs/v2/UI-V2.md` §2。

---

## 2. 破坏性变更（升级必读）

### 2.1 消息体：`attachment` → `attachments[]`

| 项 | v1（0.2.0） | v2（0.3.0） |
|---|---|---|
| 消息字段 | `attachment: Attachment \| null` | `attachments: Attachment[]`（空数组 = 无附件） |
| 发送体 | `{clientMsgId, content?, type?, attachmentId?}` | `{clientMsgId, content?, attachmentIds?(1..9 唯一), replyToMsgId?}` |
| `type` | 由客户端传入 `text|system|image|file` | **不再接受客户端传入**；服务端按附件推导 `text|image|video|file|mixed|system` |

请求体仍为 `additionalProperties:false`，多传字段直接 400。**这是本轮所有旧 e2e/旧脚本
大面积失败的真因**：v1 脚本习惯往消息体里塞 `type`，v2 一律 400。改造方式见 §4.2。

### 2.2 有附件必须带文字

`POST /conversations/:id/messages` 在 `attachmentIds` 非空时，`content` 必须非空（去空白后），
否则 400 `VALIDATION_ERROR`。产品口径：图片/视频/文件不允许「裸发」，必须配一句话。
前端对应规则：输入框为空时发送按钮 disabled 且提示「发送附件时需要附带文字」。

### 2.3 协议版本：`protocolVersion` 1 → 2

WebSocket 有**两个不同的版本号**，客户端不可混用：

| 常量 | 值 | 用在哪 | 是否变化 |
|---|---|---|---|
| `WS_ENVELOPE_VERSION` | `1` | 握手 `?v=` 与信封 `{v:1,...}` | **不变** |
| `WS_PROTOCOL_VERSION` | `2` | 仅 ready 帧 `data.protocolVersion` | **1 → 2** |

后端 ready 帧发 2，前端 `frontend/src/ws/constants.ts:22` 比对 `2`。版本不匹配时前端停止
重连并提示刷新页面 —— 所以旧前端连新后端会「一收 ready 就断」，反之亦然。**前后端必须同版上线。**

### 2.4 `GET /uploads/:id` 读取权限放宽为四类

v1：仅上传者本人 / 同会话成员。v2 追加「广场帖子引用」与「头像引用」，否则非好友看不到
对方头像、广场图片也加载不出来。四条放行规则（`backend/src/service.ts` 的 `canReadAttachment`）：

1. 上传者本人；
2. 附件被引用在「我参与的会话」的消息里；
3. 附件被引用在任意未删除的广场帖子里（登录用户皆可看）；
4. 附件被任意 `users.avatar_url` / `conversations.avatar_url` 引用（头像公开可读）。

### 2.5 `DELETE /posts/:postId/like` 是唯一返回 200 的 DELETE

其余 DELETE 返回 204。点赞撤销返回 `200 + {liked:false, likeCount}`，前端需要新的计数。

### 2.6 数据库 `SCHEMA_VERSION` 3 → 4

服务启动时自动迁移（`backend/src/db.ts`）。迁移内 **必须在 `BEGIN IMMEDIATE` 之前** 执行
`PRAGMA foreign_keys=OFF`（事务内的 pragma 是 no-op），旧 `messages.attachment_id` 在 DROP
之前搬进 `message_attachments` 的 `position=0`。

新增/变更：

- `messages`：删 `attachment_id`，加 `recalled_at`、`reply_to_msg_id`，`type` CHECK 增 `video`/`mixed`，表重建；
- 新表：`message_attachments`、`posts`、`post_attachments`、`post_likes`、`post_comments`；
- `uploads.kind` 增 `video`（表重建）。

**`backend/deploy/DEPLOYED.md` 里「不修改数据库，无数据库迁移或重置」这句承诺在 v2 起不再成立。**
升级前必须按 §3 备份。

---

## 3. 升级与首次上线步骤

```bash
# 0) 停服务
systemctl stop aitarance-chat.service

# 1) 备份（库 + 上传目录必须一起备份，否则会出现「库里有记录、磁盘没文件」）
cp /var/lib/aitrance/chat.sqlite /root/aitrance-backups/chat-v1-$(date +%F-%H%M%S).sqlite
tar czf /root/aitrance-backups/uploads-v1-$(date +%F).tar.gz -C /var/lib/aitrance uploads

# 2) 放入新 release，切换 current

# 3) 【需求 5 场景才做，会清空全部业务数据】清库并重建唯一管理员
cd /opt/aitrance/current/backend
node scripts/reset-db.mjs --dry-run    # 先看会删什么、各表计数
node scripts/reset-db.mjs --confirm    # 真正执行

# 4) 启动（首次启动会跑 SCHEMA 3→4 迁移）
systemctl start aitarance-chat.service
# 等 health 200 再宣布恢复；systemd active 不代表端口就绪
curl -s http://127.0.0.1:3001/api/v1/health
```

**`reset-db.mjs` 的约束（不要放宽）：**

- 不带 `--confirm` 直接 `exit 1`，只打印用法 —— 这个脚本一条命令删光所有用户数据；
- 纯 `node:` 内置模块，不依赖 `pnpm install`；
- 库路径默认由脚本自身位置推导（`backend/.data/chat.sqlite`），不依赖 cwd；
- 密码哈希与 `backend/src/security.ts` 的 `hashPassword` 逐字节一致，否则清完库登不进去；
- `--no-uploads-cleanup` 可保留磁盘上的上传文件（默认一起清）。

**管理员账号**：`ADMIN_UID=1001`（1000..9999）、`ADMIN_USERNAME` 默认 `root`、
`ADMIN_INITIAL_PASSWORD` 默认 `12345678`。`ensureAdmin` 先按 uid、再按 username
`COLLATE NOCASE` 查找，任一命中就把该行纠正成 `admin + adminUid`，**已存在则完全不动** ——
即改环境变量不会重置已有管理员密码，且当前版本**没有改密码接口**。

---

## 4. 验证证据

### 4.1 结果总表

| 门禁 | 命令（cwd） | 结果 |
|---|---|---|
| 契约机械校验 | `node scripts/check-contract.mjs`（仓库根） | **ERROR 0 / WARN 0**，`✅ 无差异`；openapi 0.3.0 / 39 path / 49 operation；字段 1089 项、枚举 144 项、请求体 17 端点 |
| 后端类型 | `npm run check`（`backend/`） | EXIT 0 |
| 后端单测 | `npm test`（`backend/`） | **55/55 pass**，7 个测试文件（含新增 `v2.test.ts`、`db-migration.test.ts`） |
| 前端类型 | `npm run typecheck`（`frontend/`） | `vue-tsc --noEmit` **0 error** |
| 前端单测 | `npm test`（`frontend/`） | **14 files / 303 tests** 全绿 |
| 生产构建 | `npm run build`（`frontend/`） | exit 0，`✓ built in 1.04s` + `strip-mock-worker.mjs` 校验通过 |
| e2e 六项需求 | `node e2e-v2.mjs`（`frontend/`） | **61 项：PASS 60 / FAIL 0 / DEFECT 0 / SKIP 1** |
| e2e 附件 | `node e2e-attachment.mjs` | 38/38 |
| e2e UX P0 | `node e2e-ux2-p0.mjs` | 50/50 |
| e2e 矩阵 | `node e2e-matrix.mjs` | 93/93 |
| e2e 门禁 | `node e2e-gates.mjs` | 13 通过 / 0 失败 / 1 待验（headless 无法切后台） |
| e2e 响应式 | `node e2e-responsive.mjs` | 117 断言 0 失败 |
| 对话框无障碍 | `node scripts/verify-dialog-a11y.mjs` | 15/15 |

`e2e-v2` 的 1 项 SKIP 是预期的：`gate_a` 未设头像，首字母兜底属正常行为。

### 4.2 旧 e2e 的必要改造（v2 起）

1. **所有消息体删掉 `type` 字段** —— v2 `additionalProperties:false`，传了就 400；
2. `attachmentId` → `attachmentIds: [id]`，且必须带 `content`；
3. 有附件的发送，点击前先填文字（否则按钮 disabled）；
4. 登出路径：`.rail__avatar` → `.pdrawer__entry--danger` → `.mask .panel__foot .btn{hasText:'退出登录'}`；
5. 手机「更多」sheet → `.psheet` / `.psheet__entry` / `.psheet__close`。

涉及 `e2e-matrix.mjs`、`e2e-responsive.mjs`、`e2e-attachment.mjs`、`e2e-ux2-p0.mjs`、
`scripts/verify-dialog-a11y.mjs`。

### 4.3 需求 5 的端到端验证方式

在**真实库的副本**上跑（生产库未触碰）：

1. 副本 `user_version=1`、缺 `uid/role/status` 列 → 脚本刻意报错「users 表缺少列 uid, role, status，
   请先启动一次服务端」。**这是设计行为**：旧库必须先迁移到 v4 才能安全清库；
2. 启动一次服务端 → 迁移到 v4，`ensureAdmin` 自动创建 root；
3. `--dry-run` 打印 16 条 DELETE 与各表计数；
4. `--confirm` 执行 → 全表归零、`users=1`、`admin` = `uid:1001 / root / 系统管理员`；
5. 重启 → `POST /api/v1/auth/login {"username":"root","password":"12345678"}` → **200**。

---

## 5. 已知限制与未关闭风险

1. **SEC-01（HTTP 明文）仍未关闭**：`DEPLOYED.md` 记录的生产入口是 `http://mikuyun.xyz/chat/`，
   密码、token、消息全程明文。同域路径不是安全隔离。上线前应切 HTTPS/WSS
   （`backend/deploy/HTTPS-LETSENCRYPT.md` 已有方案，需用户自己操作）。
2. **前端 `npm audit` 仍有 1 条 high**：`source-map-js` < 1.2.2，GHSA-68fv-2mgg-jv7q，有修复版本未升。
3. **iOS/Android 真机未验**：手机视口全部是 Chrome 模拟，软键盘 / 安全区 / 后台标签页已读仍需真机。
4. **`e2e-gates` 有 1 项待验**：headless 无法模拟切后台，需真机或带界面的浏览器。
5. **`management/current-status.md` 的旧 NO-GO 结论来自 v1**，其 6 个失败反例属 SEC-02/FE-02/FE-04
   范围的 v1 缺陷；v2 已重构相关路径并全量复跑，但线上 HTTPS、容量、监控告警、回滚演练、
   责任人仍未落地。
6. **生产库里有真实数据**：`DEPLOYED.md` 记录线上已有用户 `QJQ`，且历史探针 `qja_probe` 未清理。
   执行 `reset-db.mjs` 会连真实用户一起删 —— **必须用户明确确认后才做**。

---

## 6. 本轮规模

- 改动文件：`git status` 167 项（139 modified + 28 untracked）；`git diff --stat` = 139 files / 15286 insertions / 2647 deletions；
- 前端源码 30179 行（最大 `MessagePane.vue` 1279、`MessageComposer.vue` 1230、`MessageBubble.vue` 1060、`AttachmentView.vue` 1018、`SquareView.vue` 980）；
- 后端 `src/` 3776 行；
- e2e 脚本 7 个合计 6476 行（新增 `frontend/e2e-v2.mjs` 1145 行）；
- 证据截图 16 张，位于 `docs/evidence/v2-req*.png` 与 `resp-*-profile-sheet.png`。

相关文档：`docs/v2/API-V2.md`（接口契约）、`docs/v2/UI-V2.md`（前端约定）、
`backend/API.md`（525 行完整接口手册）、`backend/deploy/DEPLOYED.md`（生产现状）。
