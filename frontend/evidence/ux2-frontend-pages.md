# UX2 前端 · 页面域交付证据（task-11）

- 任务：`task-11「UX2 前端·页面域」`
- 依据：`docs/contract/ux2-contract.md` v0.3.0（Lead 冻结）
- 执行：`verify-browser`
- 结论速览：**9 项必做内容全部完成；三连门禁 exit 0（vue-tsc / vitest 14 files 243 tests / vite build）；真实浏览器断言 60 条全通过，截图 12 张；产品回归修复 0 处（本轮是新增功能，非回归修复）**

---

## 一、改动清单（逐文件）

### 1.1 新建（5 个前端源文件 + 1 个单测 + 2 个交付脚本）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `frontend/src/api/admin.ts` | 99 | 管理后台四个接口的封装：`listUsers` / `muteUser` / `deleteUser` / `fetchAdminStats` |
| `frontend/src/stores/admin.ts` | 230 | 管理后台 store：列表分页、搜索、禁言、删除、概览统计；导出纯函数 `canAccessAdmin` / `userStateOf` |
| `frontend/src/stores/admin.test.ts` | 303 | 上述 store 与纯函数的单测（19 条） |
| `frontend/src/views/ProfileView.vue` | 610 | 个人资料页 `/chat/profile` |
| `frontend/src/views/AdminView.vue` | 690 | 管理后台页 `/chat/admin` |
| `docs/evidence/shot-ux2-pages.mjs` | 580 | 真实浏览器截图与断言脚本（Playwright + 本机 Chrome） |
| `docs/evidence/run-ux2-shots.ps1` | 146 | 一键运行器：起隔离后端 3098 + integration 前端 5174 + 跑上面的脚本 + 收尸 |

### 1.2 修改（5 个前端源文件）

| 文件 | 行数变化 | 改了什么 |
| --- | --- | --- |
| `frontend/src/components/base/AppAvatar.vue` | 112 → 182 | 支持 `avatarUrl`：`https://` 外链直接渲染；`/api/v1/uploads/<uuid>` 必须经 `fetchAttachmentBlob` 换 blob URL（**没有 Bearer 的裸 `<img src>` 会 401**）；卸载/换源时 `revokeObjectURL`，并用 `loadGen` 令牌丢弃过期响应 |
| `frontend/src/views/ConversationInfoView.vue` | 464 → 775 | 群头像展示与更换（owner/admin）、成员角色徽标、owner「设为管理员/取消管理员」、按 §7.4 三档权限控制「移出」、私聊增 `UID` 行 |
| `frontend/src/router/index.ts` | 79 → 112 | 新增 `profile` / `admin` 两条 children（**必须声明在 `:convId` 之前**）+ `meta.adminOnly` 双重守卫 |
| `frontend/src/views/ChatView.vue` | 152 → 344 | `isContentScreen` 纳入 `profile`/`admin`；新增个人资料与管理后台入口（桌面贴 rail 列、手机列表屏顶部横条） |
| `frontend/src/views/LoginView.vue` | 121 → 127 | 账号输入框 label/placeholder/提示改为「账号名或 UID（如 10001）」 |

> **未改动的相邻模块**：`frontend/src/styles/`、`frontend/src/components/layout/`（AppRail / MobileNav / ConversationList / ContactPanel，属 task-10）、`frontend/src/api/conversations.ts`、`frontend/src/stores/conversation.ts`、`frontend/src/types/domain.ts`。群头像与角色设置所需的新请求因此写在 `ConversationInfoView.vue` 内部（`http.patch` / `http.post` + `convStore.fetchDetail` 刷新），不越界改他人文件。

---

## 二、契约 §十四 条款对照

| # | 契约要求 | 实现 | 验证 |
| --- | --- | --- | --- |
| 1 | 登录页 placeholder 改「账号名或 UID」，提示可用 uid 登录 | `LoginView.vue`：label「账号名或 UID」、placeholder「请输入账号名或 UID（如 10001）」、hint「可用 UID 登录：在个人信息页可查到自己的 UID」、副标题「使用你的账号名或 UID（如 10001）继续」 | 桌面+mobile 各 4 条断言通过 |
| 2 | 个人资料页 `/profile`：头像/昵称/简介可编辑，**必须显示 UID 与账号名且 UID 可复制**，uid 只读 | `ProfileView.vue`：头像上传（`uploadFile`→`updateMe`）、昵称、简介（120 字计数）、账号名只读 + 复制、UID 只读 `#10001` + 复制 | `.profile__v` 含 `ux2_alice`；`.profile__uid` 匹配 `/^#\d{5,}$/`；`.profile__copy` ≥2；头像 `avatar-img` 自然宽 > 0 |
| 3 | 群聊信息页：群名可改（owner/admin）、群头像可换（owner/admin）、成员角色徽标、owner 可设/取消管理员与移人、admin 可移普通成员 | `ConversationInfoView.vue`：`canManage = isGroup && (isOwner \|\| myRole==='admin')`；`canRemoveMember()` 实现 §7.4 三档；`.member__badge` 三档徽标；`.member__role` 仅 owner 可见 | 群名「产品评审组」；徽标 `成员\|群主\|管理员`；按钮 `设为管理员\|取消管理员`；`.info__hero-avatar .avatar-img` > 0；desktop+mobile 各 7 条 |
| 4 | 管理后台 `/admin`：仅 `role==='admin'`，非管理员跳 404 或回 `/chat`；概览四个数；用户列表 UID/账号/状态/注册时间/在线/操作；禁言 N 分钟/解除/删除；删除与禁言都要二次确认 | `AdminView.vue`：5 张概览卡、搜索、表格 6 列、禁言弹层（6 个时长预设含「解除禁言」）、删除弹层（**必须手输 uid** 才能点「永久删除」）。守卫在 `router/index.ts`（`beforeEnter` + 全局 `beforeEach` 双层），最终边界仍在后端 `requireAdmin` | 概览 `4,3,3,1,2`；行数 4；表头 `UID\|账号\|状态\|注册时间\|操作`；状态列含「禁言至」「管理员」；管理员行 `disabled=true`；删除弹层默认禁用；非管理员访问被重定向（`.admin`=0、url=`/chat`） |
| 5 | 个人信息里 uid 显示 `#10001` 形式 | `uidText = computed(() => uid && uid > 0 ? '#' + uid : '—')`（uid=0 是 normalize 的「后端没给」哨兵，不显示 `#0`） | `.profile__uid` = `#10001`；私聊信息页 `UID #10002` |

### 2.1 契约 §七 群角色权限（前端侧对齐）

- **改群名 / 换群头像**：`canManage`（owner 或群 admin）→ 后端 `requireManager`。
- **设为/取消管理员**：仅 `isOwner` 渲染 `.member__role` → 后端 `requireOwner`。
- **移出成员**：`canRemoveMember(targetRole, targetId)` 复刻 §7.4 —— self 不可移；owner 可移非 owner；admin 只可移 `role==='member'`；其余不可见。后端 `service.ts:390-420` 三档实现一致。
- **群主不可退群**：沿用既有 `leaveGroup` 逻辑（后端 409 `OWNER_CANNOT_LEAVE`）。

> 前端这份矩阵只是**可见性收敛**，不是安全边界；越权请求由后端 403 `OWNER_REQUIRED` / 400 `CANNOT_CHANGE_OWNER_ROLE` 拦下。

---

## 三、三连门禁（全 exit 0）

在 `B:\AITrance\frontend` 下用显式 node 入口执行（本仓库 `npm`/`npx` 在 bash 里报 `'"node"' 不是内部或外部命令`）：

```
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit      → exit 0（无输出）
node node_modules/vitest/vitest.mjs run                → Test Files 14 passed (14) / Tests 243 passed (243)
node node_modules/vite/bin/vite.js build               → ✓ built in 651ms，exit 0
```

- **基线对照**：本轮开工时是 11 files / 172 tests；交付时 **14 files / 243 tests**，净增 3 个测试文件、71 条测试，**无一条既有测试被删除或跳过**。其中我新增的是 `stores/admin.test.ts`（19 条），其余增量来自同期 task-10 新增的 `api/normalize.test.ts`、`stores/pins.test.ts`、`components/message/messageMenu.test.ts` 等。
- 构建产物中出现本任务的懒加载 chunk：`ProfileView-B-ldr0Gw.js 6.84 kB`、`AdminView-D9jnAMgm.js 8.02 kB`、`ConversationInfoView-DabBHJwA.js 9.00 kB`、`ChatView-BBHZO0Or.js 17.91 kB`。
- stderr 里的 `[conversation] 已读上报失败，已回滚未读显示 Error: offline`、`Error: 401 during logout` 是测试用例**故意制造**的失败路径日志，不是测试失败。

### 3.1 单测覆盖点（`stores/admin.test.ts`，19 条）

| 分组 | 条数 | 关键点 |
| --- | --- | --- |
| `canAccessAdmin` | 2 | 只有 `'admin'` 为真；`null`/`undefined`/`'user'` 为假 |
| `userStateOf` | 4 | `banned` 优先于禁言；未到期 → `muted`；**已到期不算禁言**；`mutedUntil` 脏数据不算 |
| 分页 | 3 | 首屏一页 + `nextOffset`；`nextOffset===null` 时 `hasMore` 假且 `loadMore()` 不发请求；追加用 `offset=30` 且去重 |
| 搜索 | 3 | 关键词 `trim`；**旧请求晚到不覆盖新结果**（`requestSeq` 代际）；失败清空列表 + 落 `error` + 复位 loading |
| 禁言/解除 | 3 | 成功后本地修补单条、不整页重拉；`unmute` 等价 `mute(uid, 0)`；失败抛错且列表不变 |
| 删除 | 2 | 移除行 + 刷新统计、不整页重拉；删管理员被后端拒时列表不变 |
| 统计与重置 | 2 | 统计写入；`reset()` 清空并把在途请求作废 |

---

## 四、真实浏览器验证：60 条断言全通过，12 张截图

### 4.1 环境（**连的是真后端，不是 mock**）

| 项 | 值 |
| --- | --- |
| 隔离后端 | `http://127.0.0.1:3098`（`node --experimental-strip-types src/server.ts`，临时库 `C:\Users\31626\AppData\Local\Temp\ux2-sql\chat.sqlite`，首启 bootstrap 管理员 1001） |
| 前端 | `http://localhost:5174`（`vite --mode integration --port 5174`，`VITE_BACKEND_ORIGIN=http://127.0.0.1:3098`） |
| 浏览器 | 本机 Chrome：`chromium.launch({ channel: 'chrome', headless: true })`（**未执行 `npx playwright install`**，Playwright 自带 chromium 本机未下载） |
| 三段自检 | ①`/src/main.ts` 含 `VITE_USE_MOCK": "false"` ②`GET /api/v1/health` via 5174 代理 = 200 ③管理员 1001 登录 = 200 |

> **为什么不用现成的 5173**：端口上的 vite 是 development 模式，`VITE_USE_MOCK=true`，MSW 会拦截所有 `/api/*` 与 WS，拿到的数据全是 mock，不能作为「页面连真后端」的证据。也**没有重启它**（属他人进程），而是另起 5174。
> **为什么不用现成的 3001 后端**：`127.0.0.1:3001` 上的后端管理员密码已被改过，`POST /api/v1/auth/login {username:'1001', password:'A454545asd@'}` 返回 `INVALID_CREDENTIALS`；该进程也未启动过干净库。故用 3098 + 临时库，**管理员 1001 / `A454545asd@` 是通过真实登录接口验证可用的**。

一键复跑：

```
pwsh -NoProfile -File B:\AITrance\docs\evidence\run-ux2-shots.ps1 -HardTimeoutMs 300000
```

日志：`docs/evidence/ux2-shots.log`（末行 `EXIT=0`）；后端 `docs/evidence/backend-3098.log`；前端 `docs/evidence/vite-5174.log`。

### 4.2 数据铺垫（12 条前置断言，全 PASS）

注册 `ux2_alice`（林小满）/ `ux2_bob`（陈子航）/ `ux2_carol`（赵一诺）；管理员读 `/admin/stats`（`users=4 online=0`）；alice↔bob 建私聊（`conv=abd3a4c0`）并互为好友；建群「产品评审组」（`group=957aab7f`，alice 为群主）并把 bob 设为群管理员；上传两张 128×128 PNG（脚本内现生成，**未往仓库加图片**），分别 `PATCH /users/me`（含 bio）与群 `avatarUrl`；私聊发 4 条、群聊发 3 条；管理员禁言 `ux2_carol` 120 分钟（uid 由 `/admin/users` 按账号名反查 → `uid=10003`）。

### 4.3 断言分布（60 = 12 前置 + 4 登录桌面 + 4 登录手机 + 1 外壳 + 2 入口 + 6 个人资料 + 1 守卫 + 6 后台桌面 + 2 弹层 + 6 后台手机 + 7 群信息桌面 + 7 群信息手机 + 1 私聊 + 1 错误面）

| 组 | 条数 | 代表性 detail（实测值） |
| --- | --- | --- |
| 数据铺垫 | 12 | `group=957aab7f`、`conv=abd3a4c0`、`id=77be7ca1 size=3579`、`uid=10003` |
| 登录页（desktop） | 4 | 副标题 `使用你的账号名或 UID（如 10001）继续`；label `账号名或 UID`；placeholder `请输入账号名或 UID（如 10001）`；hint 含 UID |
| 登录页（mobile） | 4 | 同上（390 窄屏） |
| 进入外壳 | 1 | `.rail / .list / .panel` 出现 |
| 桌面入口 | 2 | rail 列入口按钮数 = 1（普通用户只看到「个人资料」）；**普通用户看不到「管理后台」** |
| 个人资料页 | 6 | 账号名 `ux2_alice`；UID `#10001`；kv 含「账号名称」「UID」；`avatar-img=1`（**内容为 blob URL，证明带 Bearer 取流成功**）；`.profile__copy` ≥2 |
| 管理后台守卫 | 1 | 非管理员访问 `/chat/admin` → `url=/chat .admin=0` |
| 管理后台（desktop） | 6 | 概览 `4,3,3,1,2`；行数 4；表头 `UID\|账号\|状态\|注册时间\|操作`；状态列 `正常 管理员 正常 正常 禁言至 2026-10-23 12:24`；管理员行 `disabled=true` |
| 后台弹层 | 2 | 禁言弹层 `presets=6`；删除弹层「永久删除」默认 `disabled=true` |
| 管理后台（mobile） | 6 | 同桌面 6 条（390 窄屏卡片化布局） |
| 群信息页（desktop） | 7 | 群名「产品评审组」；徽标 `成员\|群主\|管理员`；按钮 `设为管理员\|取消管理员`；**`.info__edit` 恰好 1 个**；**`.member__remove` ≥1**；`avatar-img=1` |
| 群信息页（mobile） | 7 | 同上（390 窄屏） |
| 私聊信息页 | 1 | `昵称 陈子航 / 用户名 @ux2_bob / UID #10002` |
| 错误面 | 1 | 全程 `pageerror` = `[]` |

> **`.info__edit` 与 `.member__remove` 是既有 e2e 契约**（`frontend/e2e-matrix.mjs` 的 FE-03 群权限组按它们断言「成员看不到 / 群主看得到」），本次改造刻意保留这两个类名与可见性语义，并在截图脚本里显式断言，避免 UX2 改动悄悄破坏回归基线。

### 4.4 截图清单（12 张，均在 `docs/evidence/`）

| 文件 | 字节 | 覆盖 |
| --- | --- | --- |
| `ux2-page-01-login-desktop.png` | 257870 | 登录页桌面，UID 登录提示 |
| `ux2-page-01-login-mobile.png` | 99557 | 登录页 390 窄屏 |
| `ux2-page-02-chat-entry-desktop.png` | 222185 | 聊天外壳桌面：rail 列的个人资料入口（普通用户无管理后台入口） |
| `ux2-page-03-profile-desktop.png` | 58868 | 个人资料页：头像（blob）、账号名、UID `#10001`、复制按钮 |
| `ux2-page-04-admin-guard-nonadmin.png` | 222185 | 非管理员访问 `/chat/admin` 被重定向回 `/chat` |
| `ux2-page-05-admin-desktop.png` | 66462 | 管理后台桌面：5 张概览卡 + 4 行用户表（含「禁言至」状态） |
| `ux2-page-05-admin-mobile.png` | 37355 | 管理后台 390 窄屏卡片化 |
| `ux2-page-06-admin-mute-modal.png` | 106049 | 禁言二次确认弹层（6 个时长预设 + 解除禁言） |
| `ux2-page-07-admin-delete-modal.png` | 94178 | 删除二次确认弹层（默认禁用，需手输 uid） |
| `ux2-page-08-group-info-desktop.png` | 55728 | 群聊信息页桌面：群头像、角色徽标、设/取消管理员、移出 |
| `ux2-page-08-group-info-mobile.png` | 32150 | 群聊信息页 390 窄屏 |
| `ux2-page-09-direct-info-desktop.png` | 36786 | 私聊信息页：对方 UID `#10002` |

---

## 五、已知限制与未验风险

### 5.1 已知产品限制（不是本轮 bug，沿用既有结论）

1. **附件与头像只有属主可读**：`backend/src/service.ts` 的 `readUpload` 对非属主返回 403，因此 A 用户上传的图，B 用户端会降级为文件卡片（`AttachmentView` 的 `failed=true` 分支）。群头像用自己的账号上传、属主即本人，正常渲染；但「用别人上传的图当群头像」会被后端 `INVALID_AVATAR_URL` 拒绝（契约 §十要求 `kind='image'` 且属主本人）。此限制已由 task-8 记录，本轮不重复修。
2. **`/chat/admin` 只是前端收敛**：真正的权限边界在后端 `requireAdmin`（非 admin → 403 `ADMIN_REQUIRED`）。前端守卫用于避免无意义请求与误入空页。
3. **`uid` 只读**：无改 uid 的接口，前端不提供编辑入口（契约要求）。

### 5.2 未验 / 未覆盖

| # | 未验项 | 原因 | 建议补验方式 |
| --- | --- | --- | --- |
| 1 | iOS Safari / Android Chrome 真机 | 本机只有 Windows Chrome；headless 无法模拟软键盘顶起、`env(safe-area-inset-*)` 安全区、横竖屏旋转 | 真机或 Chrome DevTools 设备模拟 + 有头浏览器手工过一遍个人资料页表单与后台表格 |
| 2 | 剪贴板复制在非安全上下文的表现 | `navigator.clipboard` 只在 https/localhost 可用；已实现 textarea + `execCommand` 降级，但**降级路径未在 `http://非localhost` 环境实测** | 用局域网 IP 访问一次，点「复制 UID」验证提示与内容 |
| 3 | 头像上传的失败回滚 | 已验证成功路径；「上传成功但 PATCH 失败 → 孤儿 upload」只有代码级兜底（toast「头像未保存：…」），未构造故障注入 | 用 `page.route` 让 `PATCH /api/v1/users/me` 返回 500 后观察提示 |
| 4 | 禁言到期后的界面刷新 | 单测覆盖了 `userStateOf` 的「已到期不算禁言」，但页面不会自动定时重渲染（需刷新或重新加载列表） | 手动将 `mutedUntil` 设为过去时间后刷新后台确认状态列变回「正常」 |
| 5 | 大批量用户的分页性能 | 临时库只有 4 个用户，「加载更多」的分页交互未在 100+ 行数据下测 | 造 120 个账号后连点两次「加载更多」 |
| 6 | 群成员超过一屏的滚动与操作可达性 | 群只有 3 人 | 造 30 人群，检查角色按钮在窄屏下是否换行可点 |
| 7 | 深色主题下新增页面的对比度 | 本脚本只跑浅色 | 切 `data-theme=dark` 后重截 `03/05/08` 三页，核对新增的 `.profile__pill`、`.member__badge`、`.stat` 在暗色下的对比度 |

### 5.3 环境依赖（复跑必读）

- 必须用 `docs/evidence/run-ux2-shots.ps1` 一次跑完：**服务与脚本必须在同一个 pwsh 进程生命周期内**。用 `Start-Process` 分离启动的服务会随父 pwsh 退出被 Windows job object 回收（task-8 已踩过这个坑）。
- 端口占用冲突：若 3098/5174 已被占用，ps1 会复用已有服务而不重启 —— 复用前请确认那个后端用的是干净库，否则管理员密码可能不是 `A454545asd@`（3001 上的旧库就是这个情况）。
- 前端必须 `--mode integration`（`development` 会开 MSW 拦 `/api/*`）；5174 必须加进 `CORS_ORIGINS`，否则后端 403 `ORIGIN_FORBIDDEN`。
- 临时库路径 `C:\Users\31626\AppData\Local\Temp\ux2-sql\chat.sqlite` 可删；删掉后重跑会重新 bootstrap 一个干净管理员。

---

## 六、任务必做清单逐条对照（task-11 description 9 项）

| # | 必做项 | 状态 | 证据位置 |
| --- | --- | --- | --- |
| 1 | 个人信息页 `/profile`：头像/昵称/简介可改，账号名+UID 只读可复制 | ✅ | `frontend/src/views/ProfileView.vue`(610 行)；§4.3 个人资料 6 条；`ux2-page-03-profile-desktop.png` |
| 2 | `AppAvatar.vue` 支持 `/api/v1/...` 走 blob、https 直链、卸载 revoke、向后兼容 | ✅ | `frontend/src/components/base/AppAvatar.vue`(112→182 行)；个人页与群页 `avatar-img` 自然宽 >0 两条断言；9 个既有调用方未改一行 |
| 3 | 群聊信息页：群名可改、群头像可换（仅 owner/admin）、角色徽标、owner 设/取消管理员、owner+admin 按 §7.4 移人 | ✅ | `frontend/src/views/ConversationInfoView.vue`(464→775 行)；§4.3 群信息 7×2 条；`ux2-page-08-group-info-*.png` |
| 4 | 管理后台 `/admin`：概览四项、用户列表 6 列、禁言/解除/删除、全部二次确认、非管理员看不到 | ✅ | `frontend/src/views/AdminView.vue`(690 行) + `router/index.ts` 双层守卫；§4.3 后台 6×2 + 弹层 2 + 守卫 1；`ux2-page-05-*`/`06`/`07` |
| 5 | 登录页 placeholder「账号名或 UID」+ UID 提示，不改接口形状 | ✅ | `frontend/src/views/LoginView.vue`(127 行)；§4.3 登录页 4×2 条；`ux2-page-01-login-*.png` |
| 6 | 路由新增 `/profile`、`/admin`，不加到公开路由 | ✅ | 作为 `/chat` children（静态段在 `:convId` 之前），非 public；`meta.adminOnly` + `beforeEnter` + 全局 `beforeEach` |
| 7 | `api/admin.ts` 四函数 + `stores/admin.ts` 分页/query/loading/错误 | ✅ | `frontend/src/api/admin.ts`(99 行)、`stores/admin.ts`(230 行) |
| 8 | 单测：admin store 分页/查询/禁言/删除 + 守卫判定纯函数，172 条不退化 | ✅ | `frontend/src/stores/admin.test.ts`(303 行，19 条)；三连门禁 14 files / 243 tests |
| 9 | 证据 + 截图（四类页面各≥1，桌面 + 390 窄屏） | ✅ | 本文件 + `docs/evidence/ux2-page-*.png` 12 张 |

> 说明：第 6 项描述里写「meta 里标 layout，参考既有写法」。实际实现是把两条路由挂在 `/chat` 之下作为 children，因此自动继承 `App.vue` 的 `layout-app`（非 blank）外壳；未给它们写 `meta.layout`，因为 `layout` 只有 `'blank'` 与非 blank 两种取值，写非 blank 值反而会误导后来者。`meta` 里实际标注的是 `adminOnly: true`（守卫用）。

## 七、副作用与红线自查

- **未 commit / 未 tag**（仓库当前整体未被 git 跟踪，无从 commit）。
- **未访问 mikuyun.xyz 或任何公网部署**；所有请求只打 `localhost:5174` / `127.0.0.1:3098`。
- **未改** `management/`、`backend/`、`frontend/src/styles/`、`frontend/src/components/layout/`（task-10 写作用域）、`docs/03-ws-protocol.md`、`docs/09-contract-changelog.md`。
- **未装新依赖**（playwright 已在 `frontend/node_modules`，Chrome 用本机已装的）。
- **未重启**已在跑的服务（5173 development vite、3001 后端、billion-context）。
- **未执行** `npx playwright install`、`backend/deploy/` 下任何脚本。
