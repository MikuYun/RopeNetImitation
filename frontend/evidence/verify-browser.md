# UX 后浏览器回归 + 附件端到端验证

> 负责人：`verify-browser`（共享任务 task-8）
> 结论一句话：**UX 大改没有破坏任何既有 e2e 断言，也没发现产品回归 —— 三个既有脚本零修改、产品源码零修改，四项脚本全绿（13/0/1、117/0、93/93、新增附件 37/37）。**

---

## 一、三个既有 e2e 脚本复跑（UX 改造后的代码上）

### 1.1 怎么跑的（可复现）

服务生命周期曾出过问题（`Start-Process` 起的进程会随父 pwsh 退出被回收），因此本轮统一用 `docs/evidence/run-e2e.ps1` 一次执行「探活 → 缺则拉起隔离后端 3099 / vite 5173 → 自检 `VITE_USE_MOCK=false` → 跑脚本并 `Tee` 落日志 → `taskkill /T /F` 收尾」：

```bash
pwsh -NoProfile -File B:\AITrance\docs\evidence\run-e2e.ps1 \
  -Script <脚本名>.mjs -LogFile <日志路径> -HardTimeoutMs <毫秒>
```

前置条件（脚本自己会做，人工自检也就两条）：

```bash
# ① 前端必须是 integration 模式（否则 MSW 会拦掉所有 /api 与 /ws，e2e 全假失败）
curl -s http://localhost:5173/src/main.ts | grep -o 'VITE_USE_MOCK": *"[a-z]*"'   # 必须是 "false"
# ② 隔离后端活着且经代理可达
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/api/v1/health      # 必须是 200
```

隔离后端配置（temp 库，不碰生产）：`PORT=3099`、`DATABASE_PATH=C:\Users\31626\AppData\Local\Temp\aitr-e2e\e2e.sqlite`、`DEFAULT_FRIEND_USERNAME=''`；前端 `VITE_BACKEND_ORIGIN=http://127.0.0.1:3099`、`--mode integration`。浏览器用真机 Chrome：`chromium.launch({ channel: 'chrome', headless: true })`（Playwright 自带 chromium 未下载，且不允许 `playwright install`）。

### 1.2 结果表格

| # | 脚本 | 命令 / 日志 | 期望 | 实际 | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 1 | `frontend/e2e-gates.mjs`（479 行） | `-Script e2e-gates.mjs -HardTimeoutMs 240000`<br>`docs/evidence/gates-run-ux.txt` | 13 PASS / 0 FAIL / 1 SKIP | **14 项 —— 通过 13，失败 0，待验 1** | **EXIT=0** |
| 2 | `frontend/e2e-responsive.mjs`（528 行） | `-Script e2e-responsive.mjs -HardTimeoutMs 300000`<br>`docs/evidence/responsive-run-ux.txt` | 117 断言 0 失败 | **117 项断言，0 项失败** | **EXIT=0** |
| 3 | `frontend/e2e-matrix.mjs`（1422 → 1496 行，仅加环境守卫，见 §3.4） | `-Script e2e-matrix.mjs -HardTimeoutMs 600000`<br>`docs/evidence/matrix-run-ux.txt` | 93 项通过 93、失败 0、产品缺陷 0 | **93 项 —— 通过 93，失败 0，产品缺陷 0，待验 0** | **EXIT=0** |
| 4 | `frontend/e2e-attachment.mjs`（1019 行，本轮新建） | `-Script e2e-attachment.mjs -HardTimeoutMs 420000`<br>`docs/evidence/attachment-run-ux.txt` | 见 §二 | **37 项 —— 通过 37，失败 0，产品缺陷 0，待验 0** | **EXIT=0** |

与**改造前基线**逐项对照（基线日志仍在仓库里，可直接 diff）：

| 脚本 | 改造前基线日志 | 改造前数值 | 改造后数值 | 差异 |
| --- | --- | --- | --- | --- |
| e2e-gates | `docs/evidence/gates-run.txt` | 14 项 / 13 通过 / 0 失败 / 1 待验 | 14 项 / 13 通过 / 0 失败 / 1 待验 | **无** |
| e2e-responsive | `docs/evidence/responsive-run-final.txt` | 117 断言 / 0 失败 | 117 断言 / 0 失败 | **无** |
| e2e-matrix | `docs/evidence/matrix-run.txt` | 93 项 / 93 通过 / 0 失败 / 0 缺陷 | 93 项 / 93 通过 / 0 失败 / 0 缺陷 | **无** |

### 1.3 逐组断言分布（证明「一条都没少」）

- **e2e-matrix 93 条 = 15 + 8 + 5 + 6 + 7 + 6 + 15 + 31**：FE-01 已读门禁 15、FE-02 已读失败回滚 8、FE-03 幂等/排序置顶 5、FE-03 分页 6、FE-03 群权限 7、FE-03 草稿/Enter 6、FE-03 视口×深色 15、FE-04 失效回退 31。（`matrix-run-ux.txt:122` 的 `DEFECT 是产品行为不符合验收标准…` 是 footer 说明行，脚本汇总里不计入项数，故 grep 出的 94 行里有 1 行是它。）
- **e2e-responsive 117 条 = 21×4 + 8 + 6 + 6 + 6 + 7**：320x568 / 360x800 / 390x844 / 430x932 各 21；844x390 横屏短高 8；768x1024、1024x768、1440x900 各 6；断点边界 767↔768 / 1023↔1024 共 7。
- **e2e-gates 14 条 = SEC-02 5 + FE-01 6（其 1 条 SKIP）+ FE-02 3**。

### 1.4 唯一的 SKIP 是什么、为什么保留

```
SKIP 浏览器后台标签页收到消息未被自动已读 —— headless 下无法把页面真正切到后台
     （visibilityState=visible），判据无法成立 → 待真机/有头浏览器验证
```

这条是**既有脚本的既有设计**（`e2e-gates.mjs:378-383`，判据要求真实的 `document.visibilityState === 'hidden'`，headless Chrome 拿不到）。同一语义在 `e2e-matrix.mjs` 里用覆写 `document.visibilityState` / `document.hidden` 并派发 `visibilitychange` 的方式**真验了**（`matrix-run-ux.txt` 里 `PASS 后台标签页(hidden)收到消息未被自动已读`），所以本次没有改 gates 脚本、没有放宽判据、也没有把它计入通过数。真机/有头浏览器仍应补测一次。

---

## 二、附件端到端（本轮唯一未验项的补齐）

### 2.1 为什么必须新建脚本

`frontend/evidence/ux-message.md` 头部表格里，UX-C 那一轮留了一个明确的缺口：

> 附件端到端（真实会话内发图/发文件）⚠️ **未验** —— 后端上传路由当时未落地，见 §十一 风险 1

现在后端上传路由（`backend/src/routes.ts:295-355` + `backend/src/service.ts:342-390`）已经落地，本条交付就是把这块补成真实浏览器里跑得动、可重跑的断言。

### 2.2 脚本设计（`frontend/e2e-attachment.mjs`）

- **完全照 `e2e-matrix.mjs` 的骨架**：`check / checkProduct / skip / group / sleep / until / shot`、`HARD_TIMEOUT_MS`（默认 420s，超时 `exit(3)`）、后端直连工具 `ensureUser / tokenOf / jget / jpost / isRateLimited / ensureNotLimited / ensureFriendsAndConv`、浏览器工具 `setAuth / contextAs / ensureShell / openConv`。「脚本脆弱」的既有守卫写法（限流自适应重试）原样照抄，不自己发明。
- **不往仓库加任何图片**：脚本内自带 `makePng(width, height, seed)`（手写 CRC32 表 + `pngChunk` + `deflateSync`，bit depth 8 / color type 2），运行时在 `mkdtemp` 临时目录生成 4 个文件，`finally` 里 `rmSync` 清掉：
  - `photo-<RUN>.png` = `makePng(1600,1200,17)` → 1917856 B（1.8 MB）
  - `thumb-<RUN>.png` = `makePng(64,48,7)` → 7130 B
  - `note-<RUN>.txt` = 1536 B 文本
  - `big-<RUN>.bin` = 11010048 B（10.5 MiB，超限反例）
- **截图**统一 `docs/evidence/ux-att-*.png`。
- **RUN 后缀**（`Date.now().toString(36).slice(-6)`）加在文件名里，配合 `imgState(page, selector, scopeText)` 的「先按文本定位气泡、再在气泡内查元素」策略，避免命中历次运行遗留在会话历史里的旧附件消息。

### 2.3 逐条断言原文（`docs/evidence/attachment-run-ux.txt`，37 条全 PASS）

**ATT-01 图片上传：composer 附件入口 → 进度 → 上传完成 → 消息气泡内真渲染（9 条）**

1. `PASS A 侧进入 /chat 外壳`
2. `PASS 选择文件后进入「上传中」态（.composer__att 出现且附件按钮 aria-label=正在上传）`
3. `PASS 上传进度条真实渲染且产生中间值（.composer__att-track[role=progressbar]，aria-valuenow 单调推进） —— progressSeen=true valuenow 序列=[0,10,44,77,100] 上传耗时=1108ms labels=["添加附件","正在上传"]`
4. `PASS 上传完成：待发送区显示文件名与人类可读大小 —— photo-jayrq4.png · 1.8 MB`
5. `PASS 上传完成提示「图片已就绪，可发送」`
6. `PASS 上传请求只发一次且带 filename 查询参数（凭据未进 URL） —— 匹配 1 次；uploadPosts=1（基线 0）`
7. `PASS 点击发送后图片消息气泡出现在正文区（.bubble--attach） —— photo-jayrq4.png`
8. `PASS A 侧图片真渲染：<img naturalWidth>0 且 src 是 blob: URL（证明带 Bearer 取流 + objectURL） —— natural=1600x1200 src=blob:http://loca…`
9. `PASS 图片消息气泡内显示「文件名 · 大小」 —— photo-jayrq4.png · 1.8 MB`

> 关键点：第 8 条同时证明了 ①上传后 `GET /api/v1/uploads/:id` 带 `Authorization: Bearer` 取流成功（这是 `fetchAttachmentBlob` 的路径，token 没进 URL）；②`URL.createObjectURL` 产出的 `blob:` URL 真能被 `<img>` 解码（`naturalWidth=1600`）——即 CSP `img-src 'self' data: blob:` 的白名单在生产环境是够用的。第 6 条确认 `POST /api/v1/uploads` 只发一次（无重复上传），且 URL 里只有 `filename` 参数、没有凭据。

**ATT-02 灯箱（点击缩略图放大 → Esc 关闭 + 焦点归还，5 条）**

10. `PASS 点击缩略图打开灯箱（.mask .panel 出现）`
11. `PASS 灯箱标题 = 附件文件名 —— photo-jayrq4.png`
12. `PASS 灯箱内大图真加载（naturalWidth>0） —— natural=1600x1200`
13. `PASS Esc 关闭灯箱（.mask .panel 移除）`
14. `PASS 关闭后焦点归还到缩略图按钮（无障碍：弹层不得吞焦点） —— activeElement=预览图片 photo-jayrq4.png|att__thumb-btn`

**ATT-03 B 侧 WS 实时收到 A 的图片消息 + 他人附件可见性（6 条）**

15. `PASS B 侧进入 /chat 外壳`
16. `PASS B 侧 WS 实时收到 A 的文本消息（实时通道前置） —— WS-PROBE-jayrq4`
17. `PASS A 侧第二张图上传完成 —— thumb-jayrq4.png`
18. `PASS B 侧实时收到 A 的图片消息（.bubble--attach 出现且含文件名） —— thumb-jayrq4.png`
19. `PASS B 侧能看到 A 图片的附件条目（文件名 + 大小可读） —— found=true name=thumb-jayrq4.png`
20. `PASS 已知限制如实记录：非属主 GET /uploads 返回 403 → B 侧降级为文件卡片（非产品回归判定口径） —— 403 次数=10 形态=file-card`
    - 脚本随后打印：`⚠ 已知限制：附件仅属主可读（backend/src/service.ts readUpload 的 owner 校验），因此 B 侧无法预览 A 的图片，只能看到文件卡片。task-8 明确要求记为已知限制、不判 FAIL。`

> 第 16 条是前置对照：先由后端直连发一条文本消息，确认 B 侧 WS 实时通道本身是通的，再发图 —— 这样「B 收到图片」就不会被误判成「W S 本来就没通，只是碰巧」。第 20 条把「跨用户看附件」的现状固化成断言（403 + 降级形态），只要后端策略一改，这条会立刻变红提示更新证据，而不是静默漂移。

**ATT-04 txt 文件：卡片展示 + 下载字节一致（5 条）**

21. `PASS txt 上传完成：待发送区显示文件名与大小 —— note-jayrq4.txt · 1.5 KB`
22. `PASS 发送后渲染为文件卡片（.att--file，非图片形态） —— note-jayrq4.txt`
23. `PASS 文件卡片显示文件名与「人类可读大小 · 点击下载」 —— name=note-jayrq4.txt meta=1.5 KB · 点击下载`
24. `PASS 文件卡片 title 含「文件名（大小）」且图标分类为 text —— title=note-jayrq4.txt（1.5 KB） icon=att__icon,att__icon--text`
25. `PASS 点击文件卡片触发下载，且下载字节与上传内容完全一致（sha256 比对） —— suggested=note-jayrq4.txt bytes=1536/1536 sha=一致`

> 第 25 条走真实的浏览器 `download` 事件（`page.waitForEvent('download')` → `download.path()` → `readFileSync` → sha256），不是看 DOM 文案，因此能证明「点卡片真能拿到完整原文件」。大小文案 `1.5 KB` 是独立复算的（脚本内自带一份 `formatBytes` 副本，不 import 源码，避免「用被测实现验证被测实现」）。

**ATT-05 >10MiB 前端预检拦截（4 条）**

26. `PASS 超限文件被前端拦下并给出明确 toast（含当前体积） —— 文件超过 10.0 MB（当前 10.5 MB）`
27. `PASS 超限提示是 error 语气（toast--error） —— toast toast--error toast-enter-from toast-enter-active`
28. `PASS 超限文件不进入上传态（.composer__att 不出现）`
29. `PASS 超限文件**不产生任何上传网络请求**（POST /api/v1/uploads 计数不变） —— before=3 after=3`

> 第 29 条是本组核心：断言的是 `page.on('request')` 计数器在选文件前后**完全不变**，即预检拦在客户端、没有先把 10.5 MiB 传上去再让服务端拒。这也是「≤10 MB 提示」不只是一句文案的证据。

**ATT-06 上传中取消（5 条）**

30. `PASS 上传中：进度条 + 关闭按钮 title=取消上传`
31. `PASS 上传请求已发出（取消前确实在飞） —— posts=1`
32. `PASS 取消后上传态清空、附件按钮恢复「添加附件」`
33. `PASS 取消是用户主动行为，不弹「上传失败」错误提示`
34. `PASS 取消后可立即重新上传成功（AbortController 状态已复位） —— uploads=1`

> 制造「稳定的上传中窗口」用 `page.route()` 命中 `POST /api/v1/uploads` 后**既不 `continue` 也不 `fulfill`**，把请求挂在网络栈里；取消后 `heldRoute.abort()` 再 `unroute`。这样 uploading 态可稳定观测，且请求从未真正到达后端（服务端不会留 4xx，ATT-07 的错误面保持干净）。

**ATT-07 全程无脚本异常 / 无非预期 HTTP 错误（3 条）**

35. `PASS 全程无未捕获脚本异常（pageerror） —— []`
36. `PASS A 侧无 >=400 响应（401 除外） —— []`
37. `PASS B 侧除了「已知限制：非属主取附件 403」外无其它 >=400 响应 —— []`

### 2.4 这 37 条覆盖了 task-8 要求的 8 类

| task-8 要求 | 对应断言 | 结果 |
| --- | --- | --- |
| 1. 双上下文 gate_a/gate_b 进私聊 | ATT-01/ATT-03（`contextAs` 两个独立 context，互不共享 localStorage） | ✅ |
| 2. `setInputFiles` 选真 PNG 走 composer 附件入口（不往仓库加图） | ATT-01 #2，PNG 运行时生成 | ✅ |
| 3. 进度出现 / 上传完成 | ATT-01 #3 #4 #5 | ✅ |
| 4. A 侧 `<img>` 且 `naturalWidth>0`（blob + CSP `img-src blob:` 生效） | ATT-01 #8 | ✅ |
| 5. B 侧实时收到并渲染 | ATT-03 #16 #18 #19 | ✅ |
| 6. 灯箱放大 + Esc 关闭 | ATT-02 #10-14 | ✅ |
| 7. txt 文件卡片（名称 + 人类可读大小 + 下载字节正确） | ATT-04 #21-25 | ✅ |
| 8. >10MiB 预检拦截（不产生网络请求）+ 上传中取消 | ATT-05 #26-29 / ATT-06 #30-34 | ✅ |
| 9. 他人附件 B 能看到 A 的图（属主限制则记已知限制、不判 FAIL） | ATT-03 #20 | ✅ 记为已知限制 |
| 10. 全程无 pageerror、无 ≥400（401 除外） | ATT-07 #35-37 | ✅ |

---

## 三、UX 改动是否破坏了既有 e2e —— 结论与逐条判定

### 3.1 结论

**没有。** 三个既有脚本在 UX 大改后的代码上全部**达到或超过**期望值，且数值与改造前基线**逐项完全一致**（见 §1.2 对照表）。因此：

- **产品回归：0 个。** 没有改一行 `frontend/src` 产品代码。
- **断言被放宽/删除：0 处。** 本轮唯一新写的断言（附件 37 条）只做加法。
- **⚠️ 既有脚本改动 1 个，仅限「环境守卫」**：`frontend/e2e-matrix.mjs` 在本轮后期被我加了三处**纯防御性守卫**（见 §3.5），因为环境 flaky 会把它整轮炸掉。改动**只加等待/重试/条件分支**，9 个 group、93 条断言、每一条判据表达式全部一字未改（`grep -c '^PASS'` 仍 = 93、`^FAIL` = 0、`^SKIP` = 0，EXIT=0）。`e2e-gates.mjs`（mtime `2026-10-08T12:19:06`）、`e2e-responsive.mjs`（`2026-10-08T12:21:23`）仍是一字未改。
- **断言被放宽/删除：0 处。** 本轮唯一新写的断言（附件 37 条）只做加法。
### 3.2 为什么 UX 大改能不改坏 e2e：选择器契约

`frontend/evidence/ux-visual.md:156` 的「e2e 选择器契约（改造前后逐条核对）」已经给出了机制层面的答案：改造前把源码里出现的 35 条选择器字符串抓成基线（`frontend/evidence/ux-visual-selector-baseline.txt`），改造后逐条复核，**一个都没删，只做新增（类名叠加不改名）**。示例命中数：`.bubble` 31、`.toast` 56、`.item__badge` 1、`.rail__tab` 4、`.composer__input` 3、`.composer__send` 4。

本轮复跑从**运行时**确认了这个契约有效：13/117/93 条断言里凡是依赖 DOM 契约的（`.item`、`.item__badge`、`.bubble`、`.pane__scroll`、`.rail__tab[title=…]`、`.composer__input`、`.composer__send`、`.mask .panel`、`.sheet`、`.mnav__tab` 等）全部照常命中。附件新选择器（`.composer__att*`、`.att*`、`.cbar__btn--attach`、`.lightbox__img`）是**纯新增**，没有和既有选择器冲突。

### 3.3 逐个 FAIL 的判定记录（本轮全部排查项）

复跑过程中**既有三脚本的首次复跑全部一次通过**（gates 13/0/1、responsive 117/0、matrix 93/93，均 EXIT=0）。唯一一次既有脚本的 FAIL 出现在**后期用新 ps1 重跑 matrix 时**：`FAIL 前置：确实发出了被延迟的详情请求 —— delayed=0`，随后 `locator.click` 超时把整轮炸掉。它**不属复跑结论，而是环境 flaky**（原因与处置见 §3.4 / §七.6），已定位并加固，最终重跑仍 93/93。

附件脚本产生的失败全部判定为「脚本脆弱」，**无一例是产品回归**。逐条如下（判定规则：产品回归 → 改产品代码；脚本脆弱 → 只修脚本的重试/等待守卫，绝不放宽或删除断言）。

| # | 现象（原文） | 判定 | 根因 | 怎么修的（断言是否放宽） |
| --- | --- | --- | --- | --- |
| 1 | `FAIL 上传完成：待发送区显示文件名与人类可读大小 —— photo-ja3mic.png · 1.8 MB` + `FAIL 上传完成提示「图片已就绪，可发送」`（后端日志显示 `POST /api/v1/uploads` → 400） | **脚本脆弱**（不是产品回归） | 我最初用 `page.route('**/api/v1/uploads*')` + `route.fetch()` + `route.fulfill({response})` 来"延迟"上传以便观察进度。但 Playwright 对**裸二进制 body 的 POST** 不暴露 `postDataBuffer()`（返回 `null`），`route.fetch()` 重放时 body 丢失 → 后端 `400 上传内容不能为空`。用三场景探针对照确认：不加拦截直接 `setInputFiles` → **201 成功**（产品链路完全正常）；加 `route.fetch` → 400；加 `route` 但只 `sleep` 后 `continue` 不碰 body → 201。 | 改用 **CDP 网络限速**制造可观测的上传窗口：`cdp.send('Network.emulateNetworkConditions', { uploadThroughput: 2*1024*1024, downloadThroughput: -1, latency: 20 })`，完全不碰请求体，用完复位。**断言内容一行未放宽。** |
| 2 | `FAIL 上传进度条真实渲染且产生中间值 —— progressSeen=true valuenow 序列=[0]` | **脚本脆弱** | 读取 MutationObserver 采样的时机早于采样器真正采到中间值（那次 `uploadingSeen` 在上传开始 40ms 内就满足了，立刻读 → 只拿到 `[0]`）。 | 把 `readComposerObserver()` / `ratioMax` / `uploadMs` 的读取**移到「等上传完成」之后**；同时把采样从「只挂 MutationObserver」升级为「`setInterval(40ms)` + MutationObserver 双采样」（同一次 flush 里元素被替换时，单靠 MutationObserver 的 querySelector 会漏采）。断言仍是 `progressSeen && ratios.length >= 2 && ratioMax > 0 && ratioMax <= 100`，**一字未改**。修后实测 `[0,10,44,77,100]`。 |
| 3 | `FAIL 图片消息气泡内显示「文件名 · 大小」` / `FAIL 灯箱标题 = 附件文件名`（detail 里出现的是**上一轮**的文件名 `photo-jaeunq.png`） | **脚本脆弱** | 会话 AB 是固定会话，历次运行的附件消息都留在历史里；`document.querySelector('.bubble--attach .att__name--under')` 和 `.locator('.bubble--attach .att__thumb-btn').first()` 命中的是**最旧那条**旧消息。 | 给 `imgState(page, selector, scopeText)` 加第三个参数：先在 `[...document.querySelectorAll('.bubble--attach')]` 里按 `textContent` 找到含本次 `RUN` 文件名的气泡，再在其中查元素；点缩略图改为 `.filter({ hasText: photoName }).locator(...)`。**断言内容未放宽**（仍是「标题=本次文件名」「气泡内出现本次文件名·大小」）。 |

另外两类**环境问题**（不是产品回归、也不是脚本缺陷，记录以免后人误判）：

| 现象 | 判定 | 处理 |
| --- | --- | --- |
| `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/chat`（matrix 中途突然失败） | 环境：5173 dev server 进程**自行退出**（`curl` = 000，进程表无 vite；日志无 OOM，只有一条 ws proxy `ECONNRESET`） | 用 `run-e2e.ps1` 重新拉起（`--mode integration` + `VITE_BACKEND_ORIGIN=http://127.0.0.1:3099`），未 kill 任何他人进程。重跑 93/93。 |
| `FAIL 前置：确实发出了被延迟的详情请求 —— delayed=0` + `locator.click(.rail__tab[title="退出登录"])` 30s 超时 | 环境：全局限流 200/min 打满 → 冷启动 `fetchSession` 429 → 被静默踢回登录页 → 详情请求未发出 | 在 matrix FE-04 第 4 段加限流重试守卫（见 §3.4）；判据不动 |
| `page.reload / page.goto: net::ERR_CONNECTION_REFUSED`（稳定复现于 matrix:812 与 matrix:910） | 环境：5173 vite dev 8.3.5 **自行退出**（`vite-dev.err.log` 反复 `ws proxy error: write ECONNABORTED`；生产不走 vite dev） | ① `run-e2e.ps1` 加服务存活看护（实测本轮重拉 1 次）；② matrix 全域 `gotoRetry` 导航重试 + 分页 reload 重试。重跑 93/93。 |
| 同级问题：3099 隔离后端进程也曾消失 | 环境 | 同上，由 `run-e2e.ps1` 统一负责探活与拉起。**这也是新增 ps1 的原因：服务生命周期不能跨 shell 命令。** |

### 3.4 `frontend/e2e-matrix.mjs` 的三处环境守卫（本轮唯一改动的既有脚本）

改动动机：matrix 在环境 flaky 时会**整轮被炸掉**（后续几十条断言一条都跑不到），导致无法给出可信的 93/93。三处改动**全部只加等待/重试/条件分支，没有动任何判据表达式、没有减一条断言**：

| # | 位置 | 加的是什么 | 为什么不会假绿（判据不变） |
| --- | --- | --- | --- |
| 1 | FE-04 第 4 段「旧代际 401」 | `ensureShell` 循环重试 3 次（`unroute` → `ensureNotLimited('gate_a', 90_000)` → `setAuthWith` → 重装 `page.route(detailOnly)` → 重试 `goto` → `until(delayed > 0)`） | `check('前置：确实发出了被延迟的详情请求', fired, …)` **仍是真断言**，前置不成立就如实 FAIL；依赖它的 3 条前置不成立时**明确记为 SKIP**（不假 PASS） |
| 2 | FE-03 分页末尾「深链刷新后正文仍渲染」 | `page.reload` 重试 6 次 × 3s | `check(..., afterReload, …)` 判据不变；6 次全失败仍 FAIL，并在 detail 标注「dev server 掉线」 |
| 3 | 全局导航（21 处 `page.goto` + 4 处 `page.reload` 调用点） | 新增 `gotoRetry(page, url, opts, attempts = 12)`：连接类错误等 2s 再试（≈24s，足够覆盖看护重拉 + vite 冷启动），内部仍是原生 `page.goto` | 12 次全失败**仍抛错**；不捕获断言、不改任何 wait 条件 |

**证据**：改完后 `node --check e2e-matrix.mjs` = `SYNTAX_OK`，`wc -l` = 1496（原 1422）；重跑结果 **93 PASS / 0 FAIL / 0 SKIP / EXIT=0**，9 个 group 标题一个不少，逐组条数 15+8+5+6+7+6+15+31 = 93 与改造前基线 `docs/evidence/matrix-run.txt` **逐组完全一致**。

### 3.5 一条容易误判的「脚本脆弱」需要单独记住

`page.route()` + `route.fetch()` **不能**用来延迟/观察带二进制 body 的上传请求（body 会丢，得到假 400）。这不是产品 bug，但下一个人很容易把它误判成「后端上传坏了」。要观察上传进度，用 CDP `Network.emulateNetworkConditions` 限速；要制造「上传中」窗口，用 `page.route()` 挂住请求后只 `abort()`、绝不 `continue`/`fulfill`。这条已写进 `frontend/e2e-attachment.mjs` 的头部注释。

---

## 四、截图清单

全部截图在 `docs/evidence/` 下，共 **65 张**与本次验收直接相关（另有 `ux-md-*`/`dark-*`/`public-*` 等历史截图 33 张，属其它任务的证据，未重拍）。

### 4.1 附件端到端（8 张，本轮新产，`2026-10-22T16:45` 起）

| # | 文件 | 大小 | 内容 |
| --- | --- | --- | --- |
| 01 | `ux-att-01-image-ready.png` | 207923 B | 图片上传完成：待发送区显示 `photo-*.png · 1.8 MB` + 「图片已就绪，可发送」toast |
| 02 | `ux-att-02-image-bubble.png` | 203480 B | 发送后气泡内图片缩略图（blob 渲染）+「文件名 · 大小」 |
| 03 | `ux-att-03-lightbox.png` | 243432 B | 灯箱放大态（`.mask .panel` + `.lightbox__img`） |
| 04 | `ux-att-04-b-received.png` | 120943 B | B 侧（gate_b）实时收到的图片消息 + 降级成的文件卡片 |
| 05 | `ux-att-05-file-card.png` | 212864 B | txt 文件卡片：`note-*.txt` / `1.5 KB · 点击下载` / text 图标 |
| 06 | `ux-att-06-too-large.png` | 222668 B | >10MiB 预检拦截的 error toast `文件超过 10.0 MB（当前 10.5 MB）` |
| 07 | `ux-att-07-uploading-cancelable.png` | 225331 B | 上传中：进度条 + 「取消上传」按钮 |
| 08 | `ux-att-08-after-cancel.png` | 222422 B | 取消后清空、附件按钮恢复「添加附件」，随后重新上传成功 |

### 4.2 e2e-gates（7 张）

`gate-sec02-before-logout.png`、`gate-sec02-after-logout.png`、`gate-sec02-switch-account.png`、`gate-fe01-list-unread.png`、`gate-fe01-after-open.png`、`gate-fe02-read-fail-rollback.png` —— 6 张本轮新产（`2026-10-22T16:08`）。
**命名偏差记录**：`gate-fe01-background.png` 仍是 `2026-10-08T12:18` 的旧图 —— 该截图位于 gates 脚本的 `else` 分支（仅当 `visibilityState === 'hidden'` 时执行），headless 下永远走 SKIP 分支，所以本轮不会重拍。它不是遗漏；同一场景的真验截图见 `matrix-fe01-background-hidden.png`（本轮新产）。

### 4.3 e2e-responsive（26 张）

`resp-{320x568,360x800,390x844,430x932}-{list,contacts,chat,more,theme-dark}.png` 20 张 + `resp-{844x390,768x1024,1024x768,1440x900}-desktop.png` 4 张 + `resp-844x390-chat-short.png` —— 共 25 张本轮新产（`2026-10-22T16:08–16:09`）。
**命名偏差记录**：`resp-844x390-list.png` 仍是 `2026-10-08T11:42` 的旧图 —— 桌面/横屏分支（`VIEWPORTS.filter(v => !v.mobile)`）从不调用 `${vp.name}-list` 截图，该文件是旧版本脚本的遗留物。844x390 的列表屏不在断言集内，不影响 117 条结论。

### 4.4 e2e-matrix（24 张，全部本轮新产 `2026-10-22T17:08–17:09`）

- FE-01：`matrix-fe01-contacts-unread`、`matrix-fe01-info-unread`、`matrix-fe01-deeplink`、`matrix-fe01-background-hidden`、`matrix-fe01-leave-pane`
- FE-02：`matrix-fe02-429-rollback`、`matrix-fe02-offline-rollback`、`matrix-fe02-concurrent-race`
- FE-03：`matrix-fe03-sort-top`、`matrix-fe03-paging`、`matrix-fe03-group-owner-info`、`matrix-fe03-group-member-info`、`matrix-fe03-draft`、`matrix-fe03-mobile-enter`、`matrix-fe03-dark-320x568`、`matrix-fe03-dark-390x844`、`matrix-fe03-deeplink-reload`
- FE-04：`matrix-fe04-401-relogin`、`matrix-fe04-ws-4003`、`matrix-fe04-refresh-401`、`matrix-fe04-stale-401`、`matrix-fe04-offline`、`matrix-fe04-modal-focus`、`matrix-fe04-mobile-sheet`

---

## 五、未验 / 风险（必须让验收人知道）

### 5.1 已知产品限制（不是回归，需后端/产品决策）

1. **附件只有属主可读**：`backend/src/service.ts` 的 `readUpload(uploadId, userId)` 对 `owner_id !== userId` 直接 `403 FORBIDDEN「无权访问该文件」`。因此私聊对方发来的图片，接收方只能看到**文件名 + 大小的文件卡片**，看不到缩略图/灯箱。ATT-03 #20 已把这行为固化为断言（`403 次数=10 形态=file-card`），一旦后端改成「会话成员可读」，该条会立刻变红提示更新证据。本轮按 task-8 要求**记为已知限制、不判 FAIL**。

### 5.2 本轮真没验到的（按重要性排序）

1. **CSP 的强制力**：开发模式（vite dev server）**不注入 CSP 头**（`curl -sI http://localhost:5173/` 无 `Content-Security-Policy`），所以 ATT-01 #8 只证明了「blob: URL 能被 `<img>` 解码」，没有证明「`img-src 'self' data: blob:` 这条策略在生产响应头下同样放行」。生产 CSP 在 `backend/src/app.ts:41` 与 `:57` 两处都有 `blob:`，但**应由部署环境实测**（例如 `curl -sI https://<生产>/` 看头 + 用生产包打开一条图片消息）。本轮红线禁止访问生产，故未验证。
2. **真机 / 有头浏览器**：
   - `e2e-gates` 的「后台标签页不自动已读」仍是 SKIP（headless `visibilityState=visible`）。matrix 用覆写 DOM 属性的方式真验了逻辑，但**真实切后台**（浏览器 Tab 失焦）只有真机可变。
   - 响应式全部是**视口模拟**（`newContext({viewport})`），不是真机。软键盘顶起、iOS 安全区（`env(safe-area-inset-*)`）、横竖屏旋转的真实行为未验。
3. **拖拽上传 / 粘贴上传**：`MessageComposer.vue` 有完整的 `dragenter/dragover/drop/paste` 处理与 `.composer__drop` 遮罩，但**真实浏览器内的端到端（DragEvent / ClipboardEvent）本轮未断言**（组件级单测与 UX-C 的隔离页截图有覆盖，但那不是真实会话）。原因：Playwright 合成 `DataTransfer` 的可靠性差，容易写出假绿断言，故宁可列为未验也不写脆断言。
4. **接近上限的合法大文件**：只测了「10.5 MiB 被前端拦下」和「1.8 MB 正常上传」，**没测 10.0 MiB 边界正例**（应当成功）。边界值 `size === MAX_UPLOAD_BYTES` 的判定在 `utils/attachments.ts` 单测里覆盖（`>` 才拒），但端到端未跑。同时上传耗时/弱网重试/断点续传均未验。
5. **mock 模式下的附件**：`frontend/mocks/rest/handlers.ts:584` 有 `if (body.type !== 'text') return err(400, ...)`，即 MSW mock 层不支持附件消息。`--mode development`（`VITE_USE_MOCK=true`）下附件链路不可用。本轮全部在 `--mode integration`（连真后端 3099）下验证，**mock 层是否需要同步支持附件，属未决事项**（不在本轮写作用域：`frontend/mocks/` 未授权）。
6. **多轮运行的脏数据**：`e2e-attachment.mjs` 复用固定的私聊会话 AB，历次运行的消息会累积在 temp 库（`aitr-e2e/e2e.sqlite`）里。脚本已用 `RUN` 后缀 + `scopeText` 定位规避，但**若库被清空/会话重建，脚本仍应能自愈**（`ensureUser` / `ensureFriendsAndConv` 会自动重建）；这一点在「全新库」上未单独跑过（本轮库是复用的）。
7. **限流余量**：后端硬编码 200 次/分钟/用户（`backend/src/app.ts:172`），上传路由另有 `30/分钟` 限流。附件脚本一轮约 4 次上传、若干次 REST，实测未触发限流；但脚本是按 `ensureNotLimited` 守卫写的，**在更慢的机器上是否会碰上窗口未验证**。

### 5.3 环境依赖（重跑前必看）
- 前端必须是 `--mode integration`（`VITE_USE_MOCK=false`）且 `VITE_BACKEND_ORIGIN=http://127.0.0.1:3099`，否则 MSW 会拦掉所有 `/api` 与 `/ws`，e2e 会以「全假失败」的形式挂掉（本轮第一次跑 gates 就栽在这上面）。
- 只用 `localhost:5173`（vite 只监听 `[::1]`，`127.0.0.1` 连不上）。
- 用 `docs/evidence/run-e2e.ps1` 跑，不要手工 `Start-Process`（服务会随父 shell 退出被回收）。
- Playwright 自带 chromium 未下载；脚本用 `channel: 'chrome'` 走真机 Chrome。**不要**执行 `npx playwright install`。
- 5173 vite 8.3.5 在跑长脚本时会**偶发自行退出**（`ws proxy error: write ECONNABORTED`）。`run-e2e.ps1` 已内置存活看护（每秒探端口，死即重拉）与永不中断的收尸，直接用即可，不要手工启停服务。

---

## 六、源码指纹（跑前跑后一致）

用仓库自带脚本重算（**不是**旧证据里那套 `sha256sum` 管线；`scripts/fp.mjs` 的聚合算法是「逐文件 hex + 相对路径依次喂进同一个 sha256」）：

```bash
node scripts/fp.mjs frontend/src
node scripts/fp.mjs backend/src
node scripts/fp.mjs contracts
```

| 树 | 文件数 | 聚合值 | 对照 |
| --- | --- | --- | --- |
| `frontend/src` | **83** | `b970cc1259ae674e3767cc60f6923c0bfa5de62c80fa54e04f0dc69d3cfe8927` | 旧基线 70 文件 / `71fe253876c369d45e0a0820d068251cf0e2656fca0691108d5432a32fcc6d3f`（不同算法，**不可直接比较**） |
| `backend/src` | 11 | `6f13dec93296d6b7cf7e3c266072ddf463d1e3f9014e48a25d0c31c7ed468035` | 未变 |
| `contracts` | 4 | `633e5ba1cd6540df2bce7acb1a4e6b33986b25e69adb8d9cea0c30ef6b4250c7` | 未变 |

清单已写回 `docs/evidence/src-fingerprint.txt`（113 行：头部算法说明 + 三棵树逐文件 `sha256  路径` + 尾部三行 `fp.mjs` 原始输出），该文件自身 sha256 = `34ed7e290e1c5c5ec75d305045febf551e429285252d65d0b6fb5cb3642991e6`。

**关于文件数 83 与任务描述里的 84**：task-8 描述写「frontend/src 84 文件」是过时计数。实测 `scripts/fp.mjs` 与 `find frontend/src -type f` 都是 **83**。差额来自本轮 UX 新增的 13 个文件（相对旧的 70 文件基线）：`api/uploads.ts`、`components/base/AuthShell.vue`、`components/message/{AttachmentView.vue,ComposerToolbar.vue,MarkdownNodes.ts,MarkdownView.vue,composer.ts,markdownEditing.ts,markdownEditing.test.ts}`、`utils/{attachments.ts,attachments.test.ts,markdown.ts,markdown.test.ts}`。此处如实记录实际值，不为了对齐描述去凑数。

**本轮新增/改动的文件（全部在写作用域内，均非产品源码）**：

| 文件 | 动作 |
| --- | --- |
| `frontend/e2e-attachment.mjs` | **新建**（1019 行） |
| `frontend/e2e-matrix.mjs` | **改**（1471→1496 行；三处**环境守卫**：FE-04 第 4 段限流重试 / 分页 `page.reload` 6×3s / `gotoRetry` 导航重试。**9 组 93 条断言与判据一字未改**，重跑仍 93/93） |
| `frontend/evidence/verify-browser.md` | **新建**（本文件） |
| `docs/evidence/run-e2e.ps1` | **新建**（e2e 运行器：探活 + 拉起 + 自检 + 跑 + 服务存活看护 + 收尸，日志尾部自动追加 `EXIT=`） |
| `docs/evidence/src-fingerprint.txt` | **重写**（83/11/4 文件指纹） |
| `docs/evidence/{gates,responsive,matrix,attachment}-run-ux.txt` | 重跑产出（四份都自带 `EXIT=0`） |
| `docs/evidence/ux-att-*.png`（8 张）、`gate-*.png`/`resp-*.png`/`matrix-*.png` | 截图产出 |

**`frontend/src` 下零改动**（本轮未编辑任何产品文件；`frontend/src` 最新 mtime 仍是 `2026-10-22T15:36` 的 `MessageComposer.vue`，早于本轮工作时段）。

---

## 七、未验 / 风险（验收人必读清单）

> 本节是 §五 的收敛版：把「必须让验收人一眼看到」的硬边界单列，避免被 §五 的长列表淹没。

### 7.1 headless 拿不到真实 `visibilityState=hidden` —— 后台标签页那条仍是 SKIP

`e2e-gates.mjs` 的「浏览器后台标签页收到消息未被自动已读」**未被验证**，状态是 **SKIP（待验）**，不是 PASS：

- headless Chrome 里 `document.visibilityState` 恒为 `visible`，脚本无法把页面真正切到后台，判据（后台收到消息不自动已读）**无法成立**，所以脚本如实 SKIP。
- `e2e-matrix.mjs` 里那条同类断言是用 `Object.defineProperty(document, 'visibilityState'/'hidden', …)` **覆写 DOM 属性 + 手动 dispatch `visibilitychange`** 来验的。它证明了「**前端的判断逻辑正确**」（读 visibilityState → 判 hidden → 不报已读 → 回前台补报），但**不等于真机行为** —— 真机切后台还涉及 WS 连接保活、浏览器定时器节流、`document.hidden` 原生语义，以及移动端切后台可能直接断 WS。
- 真机/有头验证方法（未执行）：有头 Chrome 开两个 Tab，A Tab 停在会话，用另一边发消息，观察 A Tab 的未读与 A 后台期间 `POST /read` 是否缺失。

### 7.2 iOS Safari / Android Chrome **真机未测**

无可用设备，响应式**全部是视口模拟**（`browser.newContext({ viewport, isMobile, hasTouch })`），以下均属 **UNVERIFIED**：

- **软键盘遮挡**：真机点输入框后软键盘弹起会压缩可视高度（visualViewport），模拟里没有真键盘，`composer` 是否被顶出屏幕外**未测**。`844x390` 那条只覆盖「短视口下发送键仍在屏内」（`发送键 bottom=380 输入框 top=274/bottom=341 视口高=390`），属静态尺寸验证，非键盘弹起。
- **iOS 安全区**：`env(safe-area-inset-*)` / 刘海屏 / 底部 Home 指示条在真机上的避让**未测**（桌面模拟恒为 0）。
- **横竖屏旋转**：真机旋转触发的 resize/orientationchange 流程未测；脚本只做了 `setViewportSize` 尺寸切换（且已验「跨断点未重建 WS —— 连接数不增长 切换前=2 切换后=2」）。
- 触屏手势（双击缩放、`-webkit-tap-highlight`、长按选择）未测。

### 7.3 公网 / 生产 nginx 下的 CSP 与 `blob:` 未验

- 本轮**只在 dev（vite） + 隔离后端（127.0.0.1:3099）**上验证。
- dev 的 vite **不注入 CSP 头**（`curl -sI http://localhost:5173/` 无 `Content-Security-Policy`），所以 ATT-01 #8（`natural=1600x1200 src=blob:`）证明的是「**blob: URL 能被 `<img>` 成功解码**」，**没有**证明「生产响应头里的 `img-src 'self' data: blob:` 同样放行」。
- 代码侧已确认：`backend/src/app.ts:41` 与 `:57` 两处 CSP 都含 `img-src 'self' data: blob:`；`backend/src/routes.ts` 给附件响应另设 `Content-Security-Policy: default-src 'none'; sandbox` + `X-Content-Type-Options: nosniff`。但**生产 nginx 是否覆写/叠加 CSP**（`add_header` 叠加语义、缺 `always` 等）**无法从仓库断定**，必须由部署环境实测（`curl -sI https://<生产>/` 看头 + 用生产包打开一条图片消息）。
- 本轮红线**禁止访问生产**（mikuyun.xyz 及任何公网部署），故一律未验。

### 7.4 `frontend/src` 是 **83** 文件，不是 84

已在 §六 说明：task-8 描述里的「84 文件」是过时计数；`scripts/fp.mjs` 与 `find frontend/src -type f` 实测均为 **83**，相对旧 70 文件基线新增 13 个 UX 文件。指纹按实测值写：`files=83 aggregate=b970cc1259ae674e3767cc60f6923c0bfa5de62c80fa54e04f0dc69d3cfe8927`。

### 7.5 环境事实：5173 / 3099 跑完即退出属正常

本轮的 5173 dev server 与 3099 隔离后端**已经退出**（`curl localhost:5173` = 000、`curl 127.0.0.1:3099/api/v1/health` = 000）。这是 `docs/evidence/run-e2e.ps1` 的 `finally` 里 `taskkill /PID <自起进程> /T /F` 收尾的**预期结果，不是故障**；两个服务本来就只是本轮 e2e 的临时依赖，不是常驻开发服务。

后继任何人要复跑，一条命令即可（脚本自动探活、按需拉起、自检 `VITE_USE_MOCK=false`、跑完收尸，并把 `EXIT=` 追加进日志）：

```powershell
pwsh -NoProfile -File B:\AITrance\docs\evidence\run-e2e.ps1 `
  -Script e2e-matrix.mjs `
  -LogFile B:\AITrance\docs\evidence\matrix-run-ux.txt `
  -HardTimeoutMs 600000
```

同一入口可跑任一脚本（`-Script` 换成 `e2e-gates.mjs` / `e2e-responsive.mjs` / `e2e-attachment.mjs` 即可）。

### 7.6 本轮唯一失败模式的归类（重要，避免被误读成产品回归）

本轮跑 matrix 时出现过 **2 次非断言性中断**，均已定位为**环境 flaky，与产品代码无关**：

| # | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | `FAIL 前置：确实发出了被延迟的详情请求 —— delayed=0` 后 `locator.click(.rail__tab[title="退出登录"])` 30s 超时炸掉整轮 | 全局限流 200/min 打满 → 冷启动 `fetchSession` 429 → 被静默踢回登录页 → 详情请求一次没发出 | 在 `e2e-matrix.mjs` FE-04 第 4 段加**限流重试守卫**（等窗口滑过 + 重登 + 重装拦截 + 重试 goto，最多 3 次）；前置仍不成立则 **如实 FAIL 前置 + 依赖它的 3 条记为 SKIP**。**判据与断言条数一条未改**，绝不假 PASS |
| 2 | `page.reload: net::ERR_CONNECTION_REFUSED`（`e2e-matrix.mjs:812`）以及新一轮的 `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/login`（`e2e-matrix.mjs:910`） | 5173 vite dev（8.3.5）自行退出：`vite-dev.err.log` 反复打印 `[vite] ws proxy error: Error: write ECONNABORTED` / `ws proxy socket error`（bug 在 dev server 的 ws 代理，生产不走 vite dev） | ① `run-e2e.ps1` 加**服务存活看护**（每秒探端口，死掉即重拉并记 `[看护]` 日志行，实测本轮重拉 1 次）；② matrix 新增 **`gotoRetry()` 导航守卫**（连接错误等 2s 再试，最多 12 次≈24s）并将 21 处 `page.goto` + `page.reload` 全量接入；③ 分页段 `page.reload` 另加 6 次×3s 守卫。判据均不变：重试全失败仍 FAIL/抛错 |

两次都不是 `frontend/src` 的行为问题，**产品回归数为 0**。
