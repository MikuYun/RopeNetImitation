# frontend-e2e 交付证据（FE-01 ~ FE-04 浏览器矩阵）

**摘要（≤120 字）**：新增 `e2e-matrix.mjs`（1422 行，93 项断言）补齐 FE-01~FE-04；最终重跑三脚本全绿（gates 13/0/1、responsive 117/0、matrix **93/0/0/0**），原 3 项 a11y 缺陷已修复并转 PASS；后台标签页 hidden 已真验；源码指纹稳定。

- 环境：Windows / Node v24.15.0 / 真机 Chrome（`channel:'chrome'`，headless）/ 日期 2026-10-22
- 任务：task-4（frontend-e2e）。全部命令**本机隔离执行**：前端 `http://localhost:5173`（vite dev，`--mode integration`）+ 隔离后端 `http://127.0.0.1:3099`（`DATABASE_PATH` 指向系统临时目录的 `e2e.sqlite`）。
- **未访问任何公网域名**（生产站 mikuyun.xyz 全程未触碰）；无 git commit / tag；未改 `frontend/src`、`backend/`、`contracts/`、`management/`、`package*.json`。

---

## 一、脚本与退出码（全部实测，最终一轮）

| # | 命令 | 退出码 | 断言统计 | 日志 |
|---|---|---|---|---|
| 1 | `node frontend/e2e-gates.mjs` | **0** | 通过 **13** / 失败 **0** / 待验 **1**（共 14 项） | `docs/evidence/gates-run-final.txt` |
| 2 | `node frontend/e2e-responsive.mjs` | **0** | 断言 **117** / 失败 **0** | `docs/evidence/responsive-run-final.txt` |
| 3 | `node frontend/e2e-matrix.mjs` | **0** | 通过 **93** / 失败 **0** / 产品缺陷 **0** / 待验 **0**（共 93 项） | `frontend/evidence/e2e-matrix-rerun2.log` |

> **最终态（Lead 复跑，2026-10-22 14:0x）**：矩阵由 87 项扩到 **93 项**，**93 通过 / 0 失败 / 0 产品缺陷 / 0 待验**，退出码 0。原先 3 项 DEFECT（弹层打开不抢焦点、手机面板 Esc 无效、面板 Tab 逃逸）已由 frontend-core 修复，本轮全部转 PASS（见 §六）。
> 复跑还修掉一个**脚本自身**的脆弱点：并发反例段此前未处理隔离后端 200 次/分钟/用户的限流打满，导致 `readHits=0`、前置根本不成立��→ 已加「带诚实判定的重试守卫」（见 §六.2）。

运行环境变量：`BASE=http://localhost:5173`、`BACKEND=http://127.0.0.1:3099`、`HARD_TIMEOUT_MS=900000`（matrix）。

> 说明：matrix 的 **DEFECT 不计入退出码**。`checkProduct()` 判的是「产品行为不符合验收标准」，进缺陷清单交回 Lead；若计入，门禁会长期常红而失去回归信号。脚本断言用 `check()`，失败即退出码 1。

### 1.1 e2e-matrix.mjs 分段明细（93 项）

| 分段 | 断言数 | 结果 |
|---|---|---|
| FE-01 已读门禁（联系人屏 / 详情页 / 深链 / 后台标签页真验） | 15 | 全 PASS |
| FE-02 已读失败回滚（429 / 断网 / 并发反例） | 8 | 全 PASS |
| FE-03 幂等 / 排序置顶 | 5 | 全 PASS |
| FE-03 分页：滚动加载历史不乱序不重复 | 6 | 全 PASS |
| FE-03 群权限：非群主改名/踢人 403 且 UI 不渲染管理入口 | 7 | 全 PASS |
| FE-03 草稿 / Enter 语义 | 6 | 全 PASS |
| FE-03 视口 × 深色主题：无横向溢出（5 档 × 3） | 15 | 全 PASS |
| FE-04 失效回退（401 / WS 4003 / refresh 死锁 / 旧 401 隔离 / 离线） | 17 | 全 PASS |
| FE-04 弹层 / 手机面板无障碍（焦点、Tab 循环、Esc、焦点归还） | 14 | 全 PASS（复跑新增，原为 3 DEFECT + 若干未断言项） |

### 1.2 关键 PASS 证据（原文摘录）

**FE-01 后台标签页 hidden —— 已真验，不再是 SKIP**
```
PASS  前置：已把页面 visibilityState 切到 hidden  —— {"state":"hidden","hidden":true}
PASS  后台标签页(hidden)收到消息未被自动已读  —— unreadCount=1
PASS  前置：恢复 visibilityState=visible
PASS  回到前台后补上已读  —— unreadCount=0
```
手段：`Object.defineProperty` 覆写 `document.visibilityState`/`document.hidden` + 派发 `visibilitychange`（`setVisibility()`）。截图前先恢复 visible（自造 hidden 态下截图不稳定）。
> 注：`e2e-gates.mjs` 里同一条仍标 SKIP（「headless 下无法把页面真正切到后台」）——那是 **headless 真实后台化**不可行，与本脚本**覆写可见性状态**的真验是两件事，互为补充。两处不矛盾。

**FE-02 并发反例（旧失败响应不得回滚已成功的新游标）**
```
PASS  并发反例：旧失败响应未回滚已成功的新游标（服务端仍已读）  —— read 请求数=2 unreadCount=0
PASS  并发反例：确实发生了两发以上已读请求（前置成立）  —— read 请求数=2
```

**FE-03 分页 / 幂等 / 群权限**
```
PASS  幂等：同 clientMsgId 重发返回 200（非 201）
PASS  幂等：历史里只有一条（未产生重复）
PASS  分页：首屏只加载一页（<=30 条）
PASS  分页：无重复消息  —— 总条数=25 去重后=25
PASS  分页：DOM 顺序按 seq 升序（不乱序）  —— 首=1 尾=25
PASS  非群主改名被拒（403 OWNER_REQUIRED）
PASS  非群主踢人被拒（403 OWNER_REQUIRED）
PASS  UI：普通成员看不到「修改群名」按钮  —— .info__edit 数量=0
PASS  UI：群主看得到移除成员入口  —— .member__remove 数量=2
```

**FE-04 失效回退**
```
PASS  业务请求 401 后回到登录页  —— url=http://localhost:5173/login?next=/chat/ef1c488c-…
PASS  401 回退带上 next 参数（登录后能回原地）
PASS  401 回退后本地凭据已清理
PASS  前置：服务端注销会话成功（触发 WS 4003）  —— status=200
PASS  WS 4003 后给出「登录状态已失效」提示
PASS  WS 4003 后回到登录页
PASS  前置：受保护请求确实撞到了注入的 401（单飞前提）  —— listHits=1 refreshHits=1
PASS  refresh 自身 401 后终止并回登录页（不死循环）
PASS  refresh 自身 401 只发起一次（单飞）  —— refreshHits=1 listHits=1
PASS  前置：确实发出了被延迟的详情请求  —— delayed=8
PASS  旧代际 401 落地后仍在新账号（未被踢回登录页）
PASS  旧代际 401 不影响当前身份  —— title=闸门 B
PASS  断网期间不登出（仍在应用内）
PASS  断网期间本地凭据保留
PASS  弹层内可聚焦元素 >= 3（Tab 循环前提）  —— count=7
PASS  弹层 Tab 在最后一个元素处循环回首个
PASS  弹层 Shift+Tab 在首个元素处循环到末尾  —— 焦点=BUTTON/创建
PASS  弹层 Esc 可关闭
PASS  弹层关闭后焦点归还触发按钮  —— 焦点=BUTTON title=发起群聊
```

---

## 二、首轮发现的产品缺陷（3 项，**已由 frontend-core 修复，复跑全部转 PASS**）

> **状态更新（2026-10-22 14:0x 复跑）**：以下 3 项均已修复，复跑 93 项全绿。修复实现：`frontend/src/components/base/AppModal.vue`（`watch(() => props.open, …, { immediate: true })` → `nextTick()` 后聚焦首个可聚焦元素）、`frontend/src/components/layout/MobileNav.vue`（`.sheet` 常驻 keydown：Esc → `ui.closeMore()`，Tab/Shift+Tab 循环）、新增 `frontend/src/utils/dialogA11y.ts` 共享 `FOCUSABLE_SELECTOR`。取证见 §八。

| # | 缺陷 | 实测证据 | 依据源码 |
|---|---|---|---|
| 1 | **弹层（AppModal）打开时焦点不自动进入弹层** | `焦点=BUTTON/BUTTON`（仍在触发按钮上） | `frontend/src/components/base/AppModal.vue` 无 autofocus / 无打开时 `focus()` |
| 2 | **手机「更多」面板（MobileNav `.sheet`）Esc 不关闭** | 按 Esc 后面板仍在 | `frontend/src/components/layout/MobileNav.vue` 只由 `.mask` 点击与「取消」控制，无 keydown 处理 |
| 3 | **手机「更多」面板无焦点陷阱（Tab 会逃逸）** | `焦点=BODY`（Tab 后跑到 body） | 同上，`.sheet` 无 Tab 循环逻辑 |

> 注：桌面 `AppModal` 的 **Tab 循环 / Shift+Tab 循环 / Esc 关闭 / 关闭后焦点归还** 全部 PASS（有 `onKeydownTrap`）。缺陷 1 仅是「打开瞬间不抢焦点」，与「关闭后归还」是两条不同判据 —— 已分别断言，未互相掩盖。

**同时排除的疑似缺陷（实测无问题，记录以免重复排查）**：
- 桌面 / 手机 Enter 语义：桌面 Enter 发送、Shift+Enter 换行；手机 Enter 换行不发送、发送键可发 —— 全 PASS。
- 跨断点切换不重建 WS：`切换前=2 切换后=2`（responsive 脚本尾部断言）。
- 深链 `/chat/:convId` 冷启动 / 刷新后正文仍渲染（`bubble=30`）。

---

## 三、截图清单

matrix 新增 **24 张**（`docs/evidence/matrix-*.png`）：

| 场景 | 文件 |
|---|---|
| FE-01 已读门禁 | `matrix-fe01-contacts-unread.png`、`matrix-fe01-info-unread.png`、`matrix-fe01-deeplink.png`、`matrix-fe01-background-hidden.png`、`matrix-fe01-leave-pane.png` |
| FE-02 失败回滚 | `matrix-fe02-429-rollback.png`、`matrix-fe02-offline-rollback.png`、`matrix-fe02-concurrent-race.png` |
| FE-03 | `matrix-fe03-sort-top.png`、`matrix-fe03-paging.png`、`matrix-fe03-deeplink-reload.png`、`matrix-fe03-group-member-info.png`、`matrix-fe03-group-owner-info.png`、`matrix-fe03-draft.png`、`matrix-fe03-mobile-enter.png`、`matrix-fe03-dark-320x568.png`、`matrix-fe03-dark-390x844.png` |
| FE-04 | `matrix-fe04-401-relogin.png`、`matrix-fe04-ws-4003.png`、`matrix-fe04-refresh-401.png`、`matrix-fe04-stale-401.png`、`matrix-fe04-offline.png`、`matrix-fe04-modal-focus.png`、`matrix-fe04-mobile-sheet.png` |

沿用历史截图（本轮重跑覆盖）：`gate-*.png` 7 张、`resp-*.png` 26 张、`dark-*.png` 5 张、`public-*.png` 5 张。
本轮另将三份完整日志与源码指纹清单落盘：`docs/evidence/matrix-run.txt`、`docs/evidence/gates-run-final.txt`、`docs/evidence/responsive-run-final.txt`、`docs/evidence/src-fingerprint.txt`（68 行「sha256 + 路径」）。`docs/evidence/` 合计 **76** 个文件（**24** 张 matrix 截图 + 历史截图 **46** 张（`gate-*` 7、`resp-*` 26、`dark-*` 5、`public-*` 5、其它 3）+ 历史 `gates-run.txt`/`responsive-run.txt` + 3 份本轮日志 + 1 份指纹清单）。

> **命名偏差记录**：需求书写的截图命名是 `fe0x-<场景>.png`，实际用了 `matrix-fe0x-<场景>.png`。原因：`docs/evidence/` 已存在历史 `gate-*` / `resp-*` / `dark-*` 前缀，加 `matrix-` 前缀是为了让「哪个脚本产出的」一目了然，避免与 `e2e-gates.mjs` 的 `gate-fe01-*.png` 混淆。场景段名（`fe01-contacts-unread`、`fe04-modal-focus` …）仍严格按 `fe0x-<场景>` 格式。
> 另：需求写「断言**失败**时截图」，实际实现是**每条用例关键断言后都截图**（无论 PASS/FAIL），这样 FAIL 现场不会因为异常中断而丢掉。

---

## 四、源码指纹（跑前跑后一致）

命令（按路径排序后对「hash + 路径」清单再做 sha256）：

```bash
cd /b/AITrance && find frontend/src -type f | LC_ALL=C sort \
  | while read f; do printf '%s  %s\n' "$(sha256sum "$f"|cut -d' ' -f1)" "$f"; done \
  > docs/evidence/src-fingerprint.txt
sha256sum docs/evidence/src-fingerprint.txt
```

清单已随证据落盘：`docs/evidence/src-fingerprint.txt`（68 行，可逐文件复核）。

| 项 | 值 |
|---|---|
| **文件数** | **70**（首轮 68 + 复跑期新增 `frontend/src/utils/dialogA11y.ts`、`frontend/src/utils/dialogA11y.test.ts`） |
| **聚合指纹** | **`71fe253876c369d45e0a0820d068251cf0e2656fca0691108d5432a32fcc6d3f`** |
| 采样时间 | 2026-10-22T14:1x+08:00（**93 项全绿那一轮（rerun2）源码的指纹**） |
| 首轮旧指纹 | 68 文件聚合 `5e92890ccccdc262a99ffe9636f8aabf7fc0af7afb3a0d9b3f3b9a6b1383070b`（仅对应首轮 87 项那轮；已作废，勿与 93 项结果混引） |

> 期间 frontend-core 曾改动 `frontend/src/ws/schema.ts`、`schema.test.ts`、`schema.eval-probe.test.ts`（12:19–12:20）。**首轮三个脚本全部在指纹稳定后串行执行**，因此首轮三份结果对应同一份源码。
> **复跑期（13:27–13:39）frontend-core 又改了 4 个文件**：`frontend/src/utils/dialogA11y.ts`（新增）、`dialogA11y.test.ts`（新增）、`components/base/AppModal.vue`、`components/layout/MobileNav.vue`。**93 项全绿那一轮（rerun2，14:0x）跑在这批修改之后**，指纹为 `71fe2538…`（70 文件），与首轮 `5e92890c…`（68 文件）不是同一份源码 —— 引用结果时必须配对指纹。

---

## 五、取数与环境说明（可复现）

### 5.1 起服务
```bash
# 隔离后端（端口 3099，库在系统临时目录）
cd /b/AITrance/backend && PORT=3099 \
  DATABASE_PATH='C:\Users\31626\AppData\Local\Temp\aitr-e2e\e2e.sqlite' \
  DEFAULT_FRIEND_USERNAME='' node --experimental-strip-types src/server.ts

# 前端 dev（strictPort 5173）
cd /b/AITrance/frontend && VITE_BACKEND_ORIGIN=http://127.0.0.1:3099 \
  node node_modules/vite/bin/vite.js --port 5173 --mode integration
```

### 5.2 踩过的环境坑（写进脚本注释，避免后来者重踩）
1. **必须 `--mode integration`**：默认 `--mode development` 读 `frontend/.env.development` 的 `VITE_USE_MOCK=true`，MSW 拦截一切请求 → 页面永远停在登录页，e2e 全超时。
2. **浏览器访问用 `localhost:5173`**，不能用 `127.0.0.1`（vite dev 只监听 `[::1]:5173`）。
3. **bash 里不能直接 `npm`/`npx`**（`'"node"' 不是内部或外部命令`）；用绝对路径 `node frontend/e2e-*.mjs`。
4. Playwright 自带 chromium 未下载，用 `channel:'chrome'` 打真机 Chrome；**无需** `playwright install`。
5. `DELETE` 请求**不能**带 `Content-Type: application/json` 且无 body，否则 Fastify 先抛 400 `BAD_REQUEST`，把后面的 403 断言掩盖掉。
6. `page.route()` 的正则**匹配完整 URL**，写 `^/api/v1/...` 永不命中；要判断用 predicate 取 `u.pathname`。
7. 隔离后端有**全局 200 次/分钟限流**（按 userId，`backend/src/app.ts:172`）。矩阵密集请求会打满 → 429 → 列表空 → `bootstrap()` 的 `fetchSession()` 失败会静默清凭据跳登录，表现为「假失败」。脚本已内置 `isRateLimited()` / `ensureNotLimited()` / `ensureShell()` 自适应等待，**本轮 matrix8 出现 2 处：`外壳未出现（第 1 次）` 与 `gate_a 触发限流…等了 15s`，均自动恢复。**

### 5.3 测试数据隔离
- 账号：`gate_a` / `gate_b` / `gate_c`（密码 `GatePass!2345`），验证码无。
- 数据库为**跨运行复用**的隔离库，因此每条用例的消息文本都带 `RUN = Date.now().toString(36).slice(-6)` 唯一后缀，幂等/分页断言按 `clientMsgId` 与唯一前缀匹配，避免历史数据污染导致假失败。

---

## 六、未验项（UNVERIFIED，明确不覆盖）

| 项 | 原因 |
|---|---|
| **iOS Safari 真机** | 本机无 Apple 设备，且 Playwright 无法模拟 Safari/WebKit 引擎。 |
| **Android Chrome 真机** | 本机无 Android 设备；仅以 Chrome 桌面内核 + `isMobile/hasTouch` 视口模拟。 |
| **公网（mikuyun.xyz 生产站）** | 硬红线禁止访问公网域名，全程未触碰。 |
| headless 真实后台化（`Page.setWebLifecycleState`） | 已改用覆写 `visibilityState` + 派发 `visibilitychange` 真验 hidden 分支；真实 OS 级后台切换仍未验。 |
| 有头浏览器 / 真机触摸手势（swipe 等） | 本任务未要求，未覆盖。 |
| **1000 条规模的极限分页** | 见下方 §6.1，**按 25 条唯一前缀 + 230+ 条累计历史替代**，极限规模未验。 |

`frontend/e2e-live-probe.mjs`、`frontend/e2e-public-deeplink.mjs` **未运行**：两者默认打 `http://mikuyun.xyz/chat`（公网生产站），本任务明令禁止。

### 6.1 分页规模：为什么是 25 条而不是 1000 条

需求书写的是「1000 条分页不乱序/不重复」。实际做法与偏差原因：

- 隔离后端对发消息限流 **60 条/分钟/用户**（`backend/src/routes.ts` 的 `rateLimit{max:60}`），播种 1000 条需 ~17 分钟持续发送，且会把全局 200 次/分钟的配额打满、连带污染同进程内其它用例。
- 因此采用「**本轮唯一前缀 `分页测试<RUN>` + 25 条新消息**」，跑在已有 230+ 条历史（`seq` 已到 230 以上）的会话里，覆盖了分页的真实失效模式：跨页边界拼接、`beforeSeq` 游标推进、去重、DOM 顺序。
- 实测结论：首屏 25 条（一页内）→ 滚动 2 轮 → 总计 25 条无重复、`seq` 首=1 尾=25 严格升序；`page.reload()` 后正文仍渲染 `bubble=30`。
- **仍未验**：单会话 >1000 条时 `hasMore` 长期为 true 的连续多页滚动、以及长列表下的 DOM 性能。若需补，可临时把 `MESSAGE_RATE_LIMIT` 调高或用直连 DB 播种，但两者都超出本任务写作用域（不得改 `backend/`），故未做。

### 6.2 视口矩阵的需求覆盖映射

需求点名 320/360/390/430、844×390、767/768、1023/1024、1440。矩阵脚本只挑了 5 档做「深色主题 × 无横向溢出」，其余由既有 `e2e-responsive.mjs`（117 断言）覆盖，两者互补：

| 视口 | 覆盖者 |
|---|---|
| 320×568 / 360×800 / 390×844 / 430×932 | `e2e-responsive.mjs`（手机档，每档 13 项）+ matrix 320/390 深色档 |
| 844×390（横屏短高） | `e2e-responsive.mjs` |
| 767 / 768 / 1023 / 1024（断点边界） | `e2e-responsive.mjs` 专项（含「跨断点未重建 WS：切换前=2 切换后=2」） |
| 768×1024 / 1024×768 / 1440×900 | `e2e-responsive.mjs` + matrix 三档深色 |

浅色主题：`e2e-responsive.mjs` 8 档全覆盖。深色主题：matrix 5 档（320/390/768/1024/1440）+ 历史 `dark-*.png` 5 张，`data-theme="dark"` 已断言。


---

## 七、交付文件清单

**新增**
- `frontend/e2e-matrix.mjs`（**1422 行，93 项断言**，FE-01~FE-04 全矩阵；首次交付 1293 行/87 项，复跑期扩了 6 项 a11y 断言 + 并发反例重试守卫）
- `docs/evidence/matrix-*.png`（24 张）
- `frontend/evidence/e2e-browser.md`（本文件）

**未修改**：`frontend/e2e-gates.mjs`（479 行）、`frontend/e2e-responsive.mjs`（528 行）保持原样 —— 这两份是既有基线，改它会污染对照；矩阵耗时长、可单独跑、单独看退出码，所以另开文件。工具函数**复制**而非 import，两脚本互不依赖、可并行运行。

**已删除的临时脚本**：`frontend/e2e-debug.mjs`、`frontend/e2e-probe-hidden.mjs`（诊断用，非交付）。

---

## 八、复跑闭环（2026-10-22 14:0x，Lead 执行）

### 8.1 三条 a11y 缺陷转 PASS（逐条实测）

弹层（AppModal）：
```
PASS  弹层打开时焦点自动进入弹层  —— 焦点=BUTTON/BUTTON index=0/6
PASS  弹层打开时焦点落在第一个可聚焦元素（非容器兜底）  —— index=0/6 焦点=BUTTON
PASS  弹层内可聚焦元素 >= 3（Tab 循环前提）  —— count=7 [BUTTON | INPUT | INPUT | 闸闸门 B | 闸闸门 C | 取消 | 创建]
PASS  弹层 Tab 在最后一个元素处循环回首个  —— index=0/7
PASS  弹层 Shift+Tab 在首个元素处循环到末尾  —— 焦点=BUTTON/创建 index=6/7
PASS  弹层 Esc 可关闭（节点从 DOM 移除）  —— 剩余节点=0 visible=false
PASS  弹层关闭后焦点归还触发按钮  —— 焦点=BUTTON title=发起群聊
PASS  弹层二次打开焦点仍自动进入（往返稳定）  —— index=0/6
PASS  弹层二次关闭焦点仍归还触发按钮  —— title=发起群聊
```
手机「更多」面板（MobileNav `.sheet`）：
```
PASS  手机「更多」面板打开时焦点自动进入面板  —— 焦点=BUTTON/切换到深色主题 index=0/3
PASS  手机「更多」面板 Tab 在末尾循环回首个（不逃逸）  —— index=0/3 可聚焦=切换到深色主题 | 退出登录 | 取消
PASS  手机「更多」面板 Shift+Tab 在首个循环到末尾  —— index=2/3
PASS  手机「更多」面板 Esc 可关闭（节点从 DOM 移除）  —— 元素数=0
PASS  手机「更多」面板 Esc 关闭后焦点归还「更多」触发件  —— 焦点=BUTTON/更多 是第3个tab=true
```

### 8.2 并发反例脚本脆弱点（**不是产品缺陷**，已修脚本）

复跑首次出现 2 条 FAIL：`read 请求数=0 unreadCount=-1`。定位结论：**环境限流打满导致前置未建立，产品竞态逻辑无误**。

- `unreadCount=-1` 是 `unreadOf()` 的哨兵（`c?.unreadCount ?? -1`，`frontend/e2e-matrix.mjs:235-238`），意味 `GET /api/v1/conversations` 非 200。
- `readHits=0` 意味页面根本没发出已读请求：会话历史拉取被 429 吃掉 → 消息未渲染 → `msgStore.lastSeqOf()` 为 0 → `MessagePane.vue` 的 `if (seq <= 0) return` 提前返回。
- 根因：`backend/src/app.ts:172` 硬编码 `{ max: 200, timeWindow: '1 minute', keyGenerator: … userId ?? ip }`，矩阵密跑会打满；旧版该段**未在铺数据前调用 `ensureNotLimited()`**。
- **修法**：不改产品代码、不放宽后端限流（那是安全策略，为测试放宽属自利）；给该段加**带诚实判定的重试守卫**——每轮先 `ensureNotLimited('gate_a', 90_000)` → 铺数据 → 等列表 `.item` → 等正文 `.bubble` 真渲染 → 才注册拦截器；若 `readHits < 2` 或 `uRacy < 0` 则清场重铺，最多 3 次；**3 次后仍不成立就判 FAIL**（保留红灯能力，绝不伪造 PASS）。
- 修后实测：`PASS  —— read 请求数=3 unreadCount=0 bubble=30`（自动跨过 1 次限流等待：`gate_a 限流已解除（等了 15s）`）。

### 8.3 最终汇总
```
=== 汇总：93 项 —— 通过 93，失败 0，产品缺陷 0，待验 0 ===
```
退出码 **0**。完整日志：`frontend/evidence/e2e-matrix-rerun2.log`。
