# 接管审计与上线判定

## 2026-10-27 · v2 平台升级：交付就绪，上线仍需用户决策

结论：**代码层 GREEN（可交付构建产物），上线层 CONDITIONAL**。
阻塞项不在代码，而在三件事：① HTTP 明文（SEC-01）未改用 HTTPS；② 需求 5 清库会删除线上真实用户
`QJQ`，必须用户明确确认；③ iOS/Android 真机与容量/监控/回滚演练未做。

v2 交付总账见 `docs/v2/RELEASE-NOTES.md`；接口契约见 `docs/v2/API-V2.md` / `backend/API.md`。

### 本轮实际复跑（2026-10-27）

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约机械校验 | `node scripts/check-contract.mjs` | **ERROR 0 / WARN 0**，`✅ 无差异`；openapi `0.3.0`、39 path / 49 operation |
| 后端类型 | `node node_modules/typescript/bin/tsc --noEmit` | EXIT 0 |
| 后端单测 | `node --experimental-strip-types --test test/*.test.ts` | **64/64 pass / 0 fail**（8 文件，含新增 `v2.test.ts`、`db-migration.test.ts`、`seed-user.test.ts`） |
| 前端类型 | `npm run typecheck` | `vue-tsc --noEmit` 0 error |
| 前端单测 | `npm test` | 14 files / **310 tests** 全绿（含 4 条「发送失败误报」门禁） |
| 生产构建 | `npm run build` | exit 0，`✓ built in 1.04s` + `strip-mock-worker.mjs` 校验通过 |
| e2e 六项需求（+ 需求 8） | `node e2e-v2.mjs` | **72 项：PASS 72 / FAIL 0 / DEFECT 0 / SKIP 0**（含「单独发附件」与「发送失败误报」回归） |
| e2e 附件 / UX P0 / 矩阵 / 门禁 / 响应式 | 各自脚本 | 38/38、50/50、93/93、13 通过 0 失败 1 待验、117 断言 0 失败 |
| 对话框无障碍 | `node scripts/verify-dialog-a11y.mjs` | 15/15 |
| 需求 5 + 需求 8 清库 | `backend/scripts/reset-db.mjs` 在隔离库上 | 清 15 张业务表 → 重建两个初始账号 → 重启 → `root/12345678` 与 `QJQ/A454545asd@` 均登录 **200** |

`e2e-v2` 现已 **0 项 SKIP**：原先「`gate_a` 未设头像 → 首字母兜底」的逃逸已去掉——脚本现在会先真实上传一张 PNG 并设成 `gate_a` 头像，无条件断言左上角渲染出 `<img class="avatar-img">`。这正是需求 1 的原始 bug（rail 头像不传 `src` 只显示首字母），不能靠 SKIP 放过。

### v2 六项需求状态

| # | 需求 | 状态 | 证据 |
|---|---|---|---|
| 1 | 个人信息重构（PC 左上角头像进抽屉 / 移动端底部第三位 tab / 退出登录二次确认 / 主题入口移入） | **已完成** | `e2e-v2`；`docs/evidence/v2-req1-*.png` |
| 2 | 点头像进访客资料页 | **已完成** | `e2e-v2`；`docs/evidence/v2-req2-visitor-profile.png` |
| 3 | ≥5 预置主题 + 自定义 RGB | **已完成**（7 套） | `e2e-v2`；`docs/evidence/v2-req3-*.png` |
| 4 | 多图多文件（≤9 图 + ≤1 视频）、图片必带文字、文字不被吞、有附件 Enter 不发 | **已完成** | `e2e-v2` + `e2e-attachment`；`docs/evidence/v2-req4-*.png` |
| 5 | 清库仅保留管理员 `root/12345678` | **脚本已完成并在副本上验证**；**尚未对生产库执行**（会删真实用户，需用户确认） | `backend/scripts/reset-db.mjs` |
| 6 | 广场（帖子 / 图片 ≤9 / 视频 ≤1 / 文字 ≤5000） | **已完成** | `e2e-v2`；`docs/evidence/v2-req6-*.png` |

### v2 带来的破坏性变更（上线必须同版）

- 消息 `attachment` → `attachments[]`；发送体 `attachmentId` → `attachmentIds(1..9)`；正文与附件**互不依赖**（可只发附件，2026-11-05 放宽）；
- `type` 不再接受客户端传入（服务端按附件推导，增 `video`/`mixed`）；
- `protocolVersion` 1 → 2（信封 `v` 仍为 1，两者不可混用）→ **前后端必须同时上线**；
- `GET /uploads/:id` 权限放宽为四类（含广场帖引用、头像引用）；
- `SCHEMA_VERSION` 3 → 4，启动自动迁移，不可回退 → **升级前必须备份库 + uploads 目录**。

注意：`backend/deploy/DEPLOYED.md` 历史记录里「不修改数据库，无数据库迁移或重置」这句承诺在 v2 起**不再成立**。

### 2026-11-05 · v2.3 上传格式与体积上限放开

- **取消类型白名单**：以前只收 png/jpeg/webp/gif/pdf/zip/mp4/webm/纯文本，其余 415
  「不支持的文件类型」（用户看到的就是这句 toast）。现在按魔数**认出**图片 / 音频 / 视频 /
  文档 / 压缩包 / 字体等大类，**认不出的二进制也不再拒绝**，落成 `application/octet-stream`
  通用文件照常收发。
- **唯一仍被拒的是可执行文件**（PE / ELF / Mach-O / Java class）→ 415 + 提示压缩成 zip。
  判定看字节不看扩展名：`x.exe` 里装普通文本照收，`.txt` 里装真 PE 照样拒。
- 安全边界不在「收不收」，而在下载侧：`nosniff` + `Content-Security-Policy: default-src 'none'; sandbox`
  + 非图片强制 `Content-Disposition: attachment` —— 任何字节都不会在本域执行。
- **上限**：图片/普通文件 **10 MiB → 50 MiB**（`UPLOAD_BODY_LIMIT` 11 → 51 MiB），视频仍 100 MiB；
  广场图片上限同步 50 MiB。
- **前端**：输入框 `accept` 放宽为 `image/*,video/*,audio/*` + 常见文档扩展名；视频入口改
  `openPicker('video/*')`；附件图标新增 `audio / doc / sheet / slide` 四类；前端不再做类型白名单
  拦截，只拦空文件、超体积与可执行扩展名。
- **不需要数据库迁移**（`uploads.kind` 仍只取 image/video/file 三者之一）。
- 无端点 / 字段 / 枚举变化 → openapi 版本号不 bump，契约校验仍 **ERROR 0 / WARN 0**。

### 2026-11-05 · v2.4 个人表情包 / PC 右键菜单 / 移动端复制修复

- **个人表情包**（用户需求）：聊天气泡桌面 hover 工具条 `button[aria-label="存为表情"]`、
  移动端长按 sheet、桌面右键菜单三处入口，把 png/jpeg/webp/gif **图片**收藏为个人表情包；
  输入框工具条新增 `.cbar__btn--sticker`，点开 `section.sp[aria-label="表情包"]` 面板选择发送。
  - 后端 `SCHEMA_VERSION` **4 → 5**（新增 `stickers` 表，纯新增无搬迁）；
    新增 `GET /stickers`、`POST /stickers`（201 新建 / 200 幂等）、`DELETE /stickers/:stickerId`。
  - **语义放宽**：普通附件被引用后复用仍 409 `UPLOAD_IN_USE`，但**本人已收藏为表情包的图片不受此限**，
    可任意次发送 —— 这是表情包能反复发的前提。对照用例已锁定「未收藏的同一 PNG 第二次仍 409」。
  - 删表情包：若该图已无消息/帖子引用则连带删上传物；仍有引用则只删表情条目（防历史破图）。
    被表情包引用的上传物 `DELETE /uploads/:id` → 409；孤儿上传清理把「被表情包引用」也算在用。
- **PC 右键菜单**（用户需求）：全局接管 `contextmenu`，浏览器原生菜单换成项目菜单
  （`.ctx-menu[role="menu"][aria-label="操作菜单"]`）。空白区默认项 `refresh` / `copy-link` / `top` / `theme`；
  消息上右键出消息专属项（`copy` / `select-text` / `reply` / `toggle-source` / `toggle-pin` /
  `download-attachment` / `save-sticker` / `recall`）；图片附件右键出 `save-media` / `copy-media-url`。
  - 输入框 / 富文本 / `<select>` 上右键 **保留浏览器原生菜单**（否则粘贴与拼写检查直接坏掉）；
    `Shift + 右键` 是手动放行原生菜单的逃生口。
  - 键盘可达：打开即聚焦第一项，上下键移动、Enter 触发、Esc 关闭；滚动/resize/点外部即关。
- **移动端长按复制失败**（用户报的 bug）：根因三条叠加 ——
  ① 手机通过 `http://<局域网IP>` 访问时 `isSecureContext === false`，`navigator.clipboard` 是
  `undefined`，原 `MessageBubble.copyContent` 直接抛异常 → toast「复制失败」；
  ② `@contextmenu` 无条件 `preventDefault()` 让安卓原生「选择/复制」菜单永不出现，
  且 500ms 长按定时器弹的 AppModal 焦点陷阱会把选区打散；
  ③ `.bubble`/`.bubble__text` 未显式 `user-select: text`（继承属性，祖先写 `none` 就会传染）。
  - 修法：抽出**全仓唯一**剪贴板实现 `frontend/src/utils/clipboard.ts`（`navigator.clipboard` →
    `textarea + execCommand` 兜底），四处重复实现全部收敛（`grep execCommand src/` 只剩 1 处真实调用）；
    已有非空选区时 `contextmenu` 与长按都让给系统；新增菜单项「选择文本」给出系统原生复制柄；
    双层钉死 `user-select: text` 并明确**禁止**加 `-webkit-touch-callout: none`。
  - **该 bug 只在手机用局域网 IP 访问时复现**（localhost 是安全上下文，永远测不出来）——
    需真机验证。
- 契约：openapi 路径 39 → **41**、需求书声明 49 → **52**；版本号仍 `0.3.0`（纯增量）。
  契约校验 **ERROR 0 / WARN 0**。
- **验证（2026-11-05 全量复跑，隔离后端 3099 + vite 5173）**：
  - 单元：后端 `--test test/*.test.ts` **77 / 77**（v2.3 为 64，新增 `sticker.test.ts` 12 例 +
    `db-migration.test.ts` v4→v5 迁移 1 例）；前端 `vitest run` **17 files / 372 tests**
    （v2.3 为 16 / 310）。
  - 类型与构建：`tsc --noEmit` **0**、`vue-tsc --noEmit` **0**、`vite build` exit 0 +
    `strip-mock-worker` 校验通过。
  - e2e：`e2e-sticker-menu.mjs`（**新建**，1305 行 / 分节 A–O）**77 项 → 通过 76 / 失败 0 /
    待验 1**（唯一待验 = headless 无法读回剪贴板，`clipboard-read` 权限被拒）；`e2e-v2.mjs`
    **72 项 0 失败**、`e2e-attachment.mjs` **38/38**、`e2e-ux2-p0.mjs` **50/50**、
    `e2e-matrix.mjs` **93/93**（首跑 91/2 失败，连跑三次确认是限流/时序抖动）、
    `e2e-responsive.mjs` **117 断言 0 失败**、`e2e-gates.mjs` **13/14**（1 项 headless 无法切后台）、
    `verify-dialog-a11y.mjs` **15/15**。
  - 新增证据截图 3 张：`docs/evidence/v24-sticker-panel.png`、`v24-ctx-menu-default.png`、
    `v24-ctx-menu-message.png`。
  - **顺手修掉 `e2e-sticker-menu.mjs` 自身的 4 类取点缺陷**（首跑 9 条假失败全部由此而来，非产品缺陷）：
    ① 右键「空白区」写死 `y = box.y + 8`，消息列表滚到底时该点落在消息行上 → 改为
    `findPaneBlankPoint()` 用 `elementFromPoint` 探测真正属于 `.pane__scroll` 的点；
    ② hover 后单次取 `opacity` 拿到 0.14s 过渡中途值（实测 t=50ms 为 0.837）→ 改为轮询等 `opacity === '1'`；
    ③ 图片右键用 `.first()` 命中滚出屏幕几千像素的旧消息，Playwright 滚动触发 AppContextMenu 的
    `window` 捕获阶段 `scroll` → 菜单立刻被关 → 改为 `scrollIntoViewIfNeeded()` 后用
    `page.mouse.click` 在元素中心发真实右键；
    ④ M/N 节依赖上一节残留菜单状态 → 每节开头显式 `closeMenuIfAny()` 并各自重建前置。

### 仍未关闭的风险

1. **SEC-01 HTTP 明文**：生产入口 `http://mikuyun.xyz/chat/`，密码/token/消息全程明文。切换方案见
   `backend/deploy/HTTPS-LETSENCRYPT.md`，需用户本人操作（助手不登录服务器）。
2. **前端 `npm audit` high = 1**：`source-map-js` < 1.2.2，GHSA-68fv-2mgg-jv7q，有修复版本未升。
3. **真机未验**：所有手机视口都是 Chrome 模拟，软键盘 / 安全区 / 后台标签页已读仍需真机。
4. **`e2e-gates` 1 项待验**：headless 无法模拟切后台。
5. **生产库有真实数据**：线上已有 `QJQ`，历史探针 `qja_probe` 未清理。跑 `reset-db.mjs` 会连真实用户一起删。
6. **运维项未做**：同版 `npm ci` 产物校验、恢复/回滚演练、容量评估、监控告警及责任人。

---

## 历史判定：2026-10-08（v1，已过时，仅作留痕）

> 下列内容为 v1 时代（commit `7ab67ef` 之前）的接管审计记录，**结论 NO-GO 针对的是当时的 v1 源码**。
> v2 已重构相关路径并全量复跑（见上），但其中 SEC-01、真机、运维三项风险延续至今，未因 v2 关闭。

日期：2026-10-08。结论：**NO-GO**。本轮最新稳定源码副本采样时间：11:51（Asia/Shanghai），之后的改动必须再次验收。

## 实际复跑

| 检查 | 命令 | 结果 | 说明 |
|---|---|---|---|
| Node | node --version | v24.15.0 | 本机，不代表生产再次核验 |
| frontend类型 | npm run typecheck | 通过 | 本轮本机复跑 |
| frontend测试 | npm test | 27/27 | 仅normalize单测，不能替代E2E |
| backend类型 | npm run check | 通过 | 本轮本机复跑 |
| backend测试 | node --experimental-strip-types --test test/chat.test.ts | 15/15 | 不覆盖dist；隔离库/本机真实WS |
| frontend运行依赖 | npm audit --omit=dev --json --registry=https://registry.npmjs.org | high=1 | source-map-js，GHSA-68fv-2mgg-jv7q，受影响<1.2.2，有修复；浏览器可达性待分析 |
| backend运行依赖 | 同上 | 0条 | 不代表无未知漏洞 |

默认npmmirror audit为404 NOT_IMPLEMENTED；本轮命令指定官方registry，未改机器配置。审计服务失败不能当“零漏洞”。

隔离build、overlay、契约、独立回归以 `management/evidence/*/report.json` 为准，失败保留，不提前宣称通过。

## 最新隔离验收

稳定副本：`management/evidence/2026-10-08T03-51-53-918Z-6hOSsO/`。

源码指纹：`04bcad65635b996903ade5b9b0d98c30cb74fd860cd71d3e48afd7543f15e283`。这是门禁采样文件的聚合 SHA256，不是 git commit 或全量生产发布编号。

| 门禁 | 实际结果 |
|---|---|
| 已安装依赖版本对锁文件 | 两侧通过；不是干净 npm ci |
| 前端 typecheck、原有单测 | 通过，27/27 |
| 后端编译、原有单测 | 通过，15/15 |
| OpenAPI 重新生成与新鲜度 | 通过，未改工程师的原 OpenAPI |
| 契约比对与注入缺陷自检 | 通过；报告仅写隔离副本 |
| /chat overlay、类型、Vite打包、mock移除 | 通过；不改业务源码与现有 dist |
| PM独立回归 | **13项：7过、6败**，详见 pm-regressions.log |
| Chrome双context本地生产产物 | **9/9通过**：冷深链、双向实时、PC Enter、手机Enter换行与发送键、两端无横向溢出、F5历史、失效退出、无未预期错误 |
| 运行依赖审计 | 前端high=1，后端0；前端未关闭 |
| 验收期间源文件稳定 | 通过，避免把混合在途版本当候选版本 |

浏览器使用一次性内存库和随机密码，不登录公网、不碰正式账号，截图只有合成数据。手机视口是 Chrome 模拟，不是 iOS/Android 真机。

### 仍失败的六个反例（v1 遗留，v2 已重构相关路径并全量复跑）

1. 注销后迟到的消息历史仍回填私密缓存（SEC-02）。
2. stop 后迟到 ticket 仍创建旧 socket（SEC-02）。
3. 旧 socket 的迟到 onclose 清掉新 socket 并触发重连（SEC-02）。
4. stop 后旧 socket 的迟到 onmessage 仍进入应用分发（SEC-02）。
5. 较旧已读请求失败回滚了已成功的新游标（FE-02）。
6. refresh 自身401再次等待自己的 refreshSingleFlight，原请求不结束也不触发失效处理（FE-04）。

反例断言正确目标行为，失败是待修复证据；不以更改测试期望来关闭风险。完整清单与路径已通过 session 反馈给 frontend。

## 配置与历史风险

- DEPLOYED.md历史记录及chat.env.example明确HTTP，无密码/token/消息传输保护；SEC-01阻塞。本轮未访问生产或改Nginx。
- Origin验证、非root systemd、回环监听、scrypt、单次ticket与WS限制是良好基线，不抵消HTTP。
- 原记录明确旧qja_probe清理被阻止且未完成，另有真实用户，不得全库重置。

## 修复进展与剩余风险

- 前端已出现响应式布局、readingId 与正文可见性判据；两个非正文不自动已读、一个正向已读独立回归通过。完整后台/详情/主题/断点矩阵尚未验收，不关闭 FE-01/03。
- auth 清理业务缓存与代际机制已经加入。原“注销和失效残留缓存”两个独立回归、旧列表响应隔离已过；迟到历史/WS仍失败，SEC-02不能整体关闭。
- 已读单次请求失败回滚回归通过，但旧失败覆盖新成功仍失败，FE-02不能关闭。
- 浏览器实测已从失效后仍停在聊天且显示3条气泡，改善为 `/chat/login`、私密气泡0；9项浏览器检查通过，但 refresh401自等待仍阻塞 FE-04。
- 响应式复跑工具存在仓库根路径/旧wire初始化/目标隔离与状态检查风险，已反馈 frontend，不由PM跨目录修改。

## 尚未验收

- UI-RESP已有设计文档、实现与脚本变化，但未收到工程师正式ACK/逐项交付，不推断R1–R6全完成。
- 最新浏览器E2E、iOS/Android真机、HTTPS/WSS、注册治理、隐私/账号删除说明。
- 同版npm ci/产物、恢复/回滚演练、容量、监控告警及责任人。
- 2026-09-28公网截图/文档仅历史证据，不证明新功能通过。

## 沟通状态

已以pm追加边界、上线任务、失败证据与复跑命令。frontend出现与反馈对应的修复，仍未正式ACK；backend未收到本轮ACK或交付。任务单“待ACK”表示协作确认状态，不抹掉源码中已观察到的进展。监控不会自动唤醒，也不保证任务执行；正式上线未完成。
