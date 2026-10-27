# frontend-core 交付证据（SEC-02 / SEC-03 / SEC-04 前端侧）

**摘要（≤120 字）**：补 40 条竞态/探针/焦点单测（27→67 全绿）；修 6 处缺陷（含弹层不聚焦、手机面板 Esc 失效、Tab 逃逸）；锁文件与 node_modules 双端 1.2.2；真 Chrome CSP 14/14、焦点 15/15。

- 环境：Windows / Node 24.15.0 / `frontend/` / 日期 2026-10-22
- 任务：task-3（frontend-core），所有命令均为**本机隔离**执行，未碰 backend / 公网 / 生产。
- 无 git commit / tag（按硬红线）。

---

## 一、命令与退出码（全部实测）

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | **0** | 无类型错误 |
| 2 | `node node_modules/vitest/vitest.mjs run` | **0** | **7 files / 48 tests 全通过** |
| 3 | `PATH="/e/nodejs:$PATH" node /e/nodejs/node_modules/npm/bin/npm-cli.js run build` | **0** | vue-tsc + vite build + strip-mock-worker 全过 |
| 4 | `PATH="/e/nodejs:$PATH" node ... npm-cli.js test` | **0** | 48/48 |
| 5 | `npm audit --omit=dev --json --registry=https://registry.npmjs.org` | 1（有漏洞时 npm 恒返回 1） | see §三 |
| 6 | `npm audit --json --registry=https://registry.npmjs.org` | 1 | see §三 |
| 7 | `node scripts/strip-mock-worker.mjs` | **0** | 产物无 mock 引用 |
| 8 | `node backend/evidence/csp-browser-check.mjs`（真 Chrome，读 `frontend/dist`） | **0** | **assertions=14 failures=0；`violations: style=0 script=0 other=0`**（两种 CSP 各一次） |
| 9 | `node scripts/verify-dialog-a11y.mjs`（真 Chrome，读 `localhost:5173` dev server） | **0** | **15/15 PASS**，见 §六 |

> 单测基线：改造前 **1 file / 27 tests**；SEC-02 后 **5 files / 44 tests**；补 zod CSP 测试后 **7 files / 48 tests**；补对话框焦点测试后 **8 files / 67 tests**（共 +40 条，全部为真实竞态/真实探针计数/真实键盘路径判定，非「函数被调用」断言）。

---

## 二、SEC-02 竞态加固

### 2.1 六反例 × 源码防线（逐条核查，非采信 PM 结论）

| # | 反例（PM 点名） | 现有防线（精确位置） | 本轮结论 |
|---|---|---|---|
| ① | 注销后迟到消息历史回填 | `frontend/src/stores/message.ts:206,237,263` 取 `currentEpoch()`，`211/240/268` 用 `epochValid(gen)` 丢弃；`stores/auth.ts:108` `clearLocal()` 首行 `bumpEpoch()` | **有防线，原本无测** → 补 3 条 |
| ② | `stop()` 后迟到 ticket 建旧 socket | `frontend/src/ws/client.ts:165` 取票后 `if (gen !== this.gen) return` | **有防线，原本无测** → 补 1 条 |
| ③ | 旧 socket 迟到 `onclose` 清掉新 socket | `frontend/src/ws/client.ts:199`（`onclose` 首行代际判断，注释标「勿删」） | **有防线，原本无测** → 补 1 条（与④同一测试） |
| ④ | `stop()` 后旧 `onmessage` 仍分发 | `frontend/src/ws/client.ts:187` `ws.onmessage` 首行代际判断 | 同上 |
| ⑤ | 旧已读失败回滚新游标 | `frontend/src/stores/conversation.ts:196-197` 每会话自增 `readGenByConv`，`:221` `stillLatest` 才回滚 | **有防线，原本无测** → 补 4 条 |
| ⑥ | refresh 自身 401 自等单飞死锁 | `frontend/src/api/http.ts:203` `isRefreshCall(config)` 分支先行终局化，`:210` `refreshFailedTerminally` 短路 | **有防线，原本无测** → 补 1 条 |

### 2.2 发现并就地修补的真实缺口（2 处 + 1 处配套）

**缺口 A — 换账号后旧 token 的在途 401 会踢掉新账号（安全相关）**

- 现象链：旧账号请求 A 在途 → 用户换号，新 token 已写入 → A 返回 401 → `http.ts` 调 `onUnauthorized` → `stores/auth.ts:196 onSessionRevoked()` 只判 `if (!token.value) return`（新 token 存在，不 return）→ **执行 `wsClient.stop()` + `clearLocal()`，把刚登录的新账号登出**。
- 修补：`frontend/src/api/http.ts:72` 请求拦截器打快照 `;(config as RetriableConfig).__authTokenSnapshot = token`；新增 `:157 isStaleAuthFailure(config)`（当前 token ≠ 出发时快照即判定陈旧）；`:196` 401 分支首位拦截，只抛 `ApiError`，**不续期、不登出**。
- 单测：`src/api/http.test.ts` 第 3 条（换账号后旧 token 401 → `onUnauthorized` 未调用、`refresh` 未调用）。

**缺口 B — 续期自身 401 会触发两次 `onUnauthorized`（登出流程跑两遍）**

- 现象链：续期请求 401 → 内层 `isRefreshCall` 分支 `onUnauthorized` 一次 → 外层 `newExpiry === null` 落到底部再通知一次 → `onSessionRevoked` 两次，`wsClient.stop()` + `clearLocal()` + toast 各跑两遍（实测 2 次）。
- 修补：`frontend/src/api/http.ts:104` `terminalNotified` 标记 + `:116 notifyTerminal()` 去重；三处调用点 `:205/:211/:222` 全部换成 `notifyTerminal`。
- 单测：`src/api/http.test.ts` 第 1 条断言 `toHaveBeenCalledTimes(1)`。

**缺口 C — 上一轮「终局已播报」标记会吞掉下一轮真失效**

- 修补：`stores/auth.ts:5` import `resetRefreshFailure`；`:58` 在 `applySession()` 写凭据后、`scheduleRefresh()` 前调用 —— 新凭据落地即作废终局标记。

### 2.3 新增 4 个测试文件（17 条）

| 文件 | 条数 | 真实构造的竞态 |
|---|---|---|
| `frontend/src/api/http.test.ts` | 5 | ①续期端点自身 401 不死锁（`Promise.race` + 2s 超时兜底，断言非 timeout、`refreshCalls===1`、`onUnauthorized` 恰 1 次）②3 个并发 401 只打一次续期、各自重放一次 ③换账号旧 token 401 不踢新号 ④同代 401 仍正常续期并登出（参数 `SESSION_EXPIRED`）⑤`markRefreshFailed()` 后不再白试续期 |
| `frontend/src/ws/client.test.ts` | 4 | 手写 `FakeWebSocket` + `vi.stubGlobal`，`vi.mock('@/api/auth')` 手动控制 ticket 何时 resolve：①取票在飞时 `stop()`，迟到 ticket **不建 socket**（`instances.length===0`）②旧 socket 保留 `onmessage`/`onclose` 闭包，在新连接 ready 后触发 → 帧数不变、态仍 `open`、无 `reconnecting`、`instances` 仍 2 ③stop 后旧 close 不重连 ④ticket 401 → `authFailures===['ticket_auth']`、末态 `stopped`、零 socket |
| `frontend/src/stores/message.test.ts` | 4 | `vi.mock('@/api/messages')` + 手动 deferred：①`loadOlder` 在飞时 `bumpEpoch()+reset()` → 迟到响应后 `buckets.size===0` ②`ensureLoaded` 同款（另断言 `isLoaded===false`）③`catchUp` 同款（另断言 `lastSeqOf===0`）④同代际正常合并（对照组，seq `[7,10]`、`hasMoreOlder=false`） |
| `frontend/src/stores/conversation.test.ts` | 4 | `vi.mock('@/api/conversations')` 两发 deferred 精确控制先后：①**后发先成功、先发后失败** → 游标停在 12、未读保持 0（旧失败不回滚新成功）②单发失败仍回滚（9/3）③失败期间推来新消息不被整体覆盖 ④登出清空后迟到失败不重建条目 |

**关键坑（已写入测试注释，防后人踩）**：`message.ts` 的 `loadOlder`/`ensureLoaded` 在 `finally` 里仍调 `bucketOf()`，即使 try 内判了代际，**finally 也会 lazy 重建桶** —— 断言必须看 `buckets.size`，不能只看返回值。

### 2.4 变异测试（证明测试非空转，全部已还原并复跑 44/44 通过）

| 变异动作 | 预期失败用例 | 实测 |
|---|---|---|
| `message.ts` 删掉 `loadOlder` 的 `if (!epochValid(gen)) return 0` | 仅「loadOlder 迟不到账」 | ✅ 1 failed / 3 passed |
| `conversation.ts:221` `stillLatest` 改成 `true` | 仅「旧发失败不回滚新发」 | ✅ 1 failed / 3 passed |
| `ws/client.ts:165`（取票后代际判断）置空 | 仅「ticket 在飞时 stop」 | ✅ 1 failed / 3 passed |
| `ws/client.ts:187`（onmessage 代际判断）置空 | 仅「旧 socket 迟到帧」 | ✅ 1 failed / 3 passed |
| `http.ts:158` `isStaleAuthFailure` 直接 `return false` | 仅「旧 token 不踢新账号」 | ✅ 1 failed / 4 passed |
| `http.ts:117` 去掉 `terminalNotified` 去重 | 仅「续期 401 只触发一次」 | ✅ 1 failed / 4 passed |

### 2.5 overlay 匹配点复核（改完仍在，未触断门禁）

```
frontend/vite.config.ts:24   export default defineConfig({
frontend/src/router/index.ts:6    history: createWebHistory(),
frontend/src/api/http.ts:53  baseURL: '',
frontend/src/ws/client.ts:168  const url = `${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}&v=${WS_PROTOCOL_VERSION}`
```

---

## 三、SEC-03 依赖漏洞

### 3.1 锁文件与 node_modules 双端状态（**一致，均已升级**）

| 检查 | 结果 |
|---|---|
| `grep -n '"version": "1.2.2"' frontend/package-lock.json` | L3234 `node_modules/source-map-js` = **1.2.2**（L917 的 1.2.2 是 `@emnapi/wasi-threads`，无关） |
| 锁文件 integrity | `sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`（与任务书给的完全一致） |
| `node_modules/source-map-js/package.json` | **1.2.2** |
| `node_modules/.package-lock.json` 隐藏锁 | **1.2.2** |
| `lockfileVersion` | 3 |
| `frontend/package.json` | **未改动**（4 条消费方约束均为 `^1.2.1`，1.2.2 落在原 semver 内） |

> 过程说明（不隐瞒）：`--package-lock-only` 不改 `node_modules`，实测升完后 node_modules 仍停在 1.2.1（不一致）。为消除该不一致，执行 `rm -rf node_modules/source-map-js && npm install --registry=https://registry.npmjs.org`（正规全量 install，**非** `npm audit fix`），之后双端同步到 1.2.2，且**锁文件字节未变**（install 前后 md5 相同 `121f1a83…`）。

### 3.2 锁文件其余变化（证明没顺手升别的包）

对照升级前备份做结构化 diff：

- `added keys`：`@tailwindcss/oxide-wasm32-wasi` 下的 6 条 `bundleDependencies` 补登记（`@emnapi/core`、`@emnapi/runtime`、`@emnapi/wasi-threads`、`@napi-rs/wasm-runtime`、`@tybys/wasm-util`、`tslib`），全部 `dev+optional+inBundle` —— 是 npm 对 bundled deps 的登记补齐，**不是版本升级**。
- `removed keys`：无。
- `changed versions`：**仅 `node_modules/source-map-js 1.2.1 → 1.2.2`**。
- 其余任何包版本 / resolved / integrity：**未变**。
- 未执行 `npm audit fix --force`，未执行任何 `npm update`。

### 3.3 产物不可达证据（dist 级 grep，实测）

`frontend/dist/` 构建完成后（19 个 js + css，445K）：

| grep | 命中 |
|---|---|
| `grep -rl "source-map-js" dist/` | **无**（exit 1） |
| `grep -rl "SourceMapConsumer" dist/assets/*.js` | **无** |
| `grep -rl "sourceMappingURL" dist/` | **无**（`build.sourcemap: false`） |
| `grep -rl "@tailwindcss\|compiler-sfc\|compiler-core" dist/` | **无** |

结论：4 条消费方（`@tailwindcss/node`、`@vue/compiler-core`、`@vue/compiler-sfc`、`postcss`）**全部停在构建期**，浏览器产物里没有任何路径能走到 `source-map-js`。
**仍不自行宣称豁免** —— 按 prm 要求，产物证据 + 可达性分析交 **PM 复核**后才算关闭。

### 3.4 npm audit 前后 high 数变化（`--registry=https://registry.npmjs.org`，本机默认 npmmirror 会 404 NOT_IMPLEMENTED）

| 命令 | 升级前 | 升级后 |
|---|---|---|
| `npm audit --omit=dev --json` | high **3** / total 3（`follow-redirects`、`source-map-js`、`vite`） | high **2** / total 2（`follow-redirects`、`vite`） |
| `npm audit --json`（含 dev） | high 3 / moderate 2 / total 5 | high 2 / moderate 2 / total 4 |

`'source-map-js' in vulnerabilities` → **false**（已从审计结果消失）。
剩余 high 不在本任务范围：`vite 8.3.0–8.3.2`（直接依赖，升级属发布相关改动）、`follow-redirects`（`axios` 传递依赖）。
基线（升级前）high=3 是在临时目录用备份锁文件复跑得到的对照值，非截图/记忆。

### 3.5 文档更新

- `docs/09-responsive-ui.md` **§十一** 已改写为「已升级 1.2.2 + 产物级证据 + 仍待 PM 复核」，并写入失败信息（audit 前后表、grep 命令）。
- **未改** §9.3 / §十 的 SEC-03「未关闭」行 —— 任务书写作用域限定「只追加/更新 §十一」。**这两处需 PM 按新结论同步，否则文档自相矛盾**（已在 §十一 末尾显式标注该限制，不隐身）。

---

## 四、SEC-04 前端侧

### 4.1 前端在 `default-src 'self'; connect-src 'self' ws: wss:` 下能否工作 —— 实测扫描

| 检查项 | 命令/方法 | 结果 |
|---|---|---|
| 内联 `<style>` / `<script>` | `grep -nE "<script\|<style" frontend/index.html` | 仅 L20 `<script type="module" src="/src/main.ts">`（**外链**）；构建产物 `dist/index.html` 同样只有外链 `/assets/index-*.js` 与 `<link rel=stylesheet>` |
| 内联事件属性（`onclick=` 等字符串） | 模板内 grep，排除 `@click`/`@error` 等 Vue 绑定 | **0 处** |
| `v-html` | `grep -rn "v-html" src/` | **0 处**（2 处仅是注释里的「永不 v-html」声明） |
| `data:image` / `blob:` | `grep -rnE "data:image\|blob:" src/` | **0 处** |
| `https:` 外链资源 | `grep -rnE "https?://" src/` | 仅 `src/utils/uuid.ts:5` 注释 |
| 外部字体 / CDN | `grep -rn "font-face\|fonts.googleapis\|@import" src/ index.html` | 仅 `src/styles/main.css:1-2` 的本地 `@import 'tailwindcss'` / `'theme.css'`（构建期内联成外部 css） |
| dist CSS 内 `url(...)` | `grep -o "url([^)]*)" dist/assets/*.css` | **无** |
| dist 内 `data:` 资源 | `grep -oE "data:[a-z]+/[a-z]+" dist/assets/*` | 0 处（`data:attachment/file` 只是 axios 判断字符串，不加载资源） |
| `eval` / `new Function` | `grep -rn "\beval(\|new Function" src/` + dist | **0 处**（故无需 `'unsafe-eval'`） |
| `<img>` | `grep -rn "<img" src/` | 仅本轮**新增**的 `AppAvatar.vue:50` 外链头像分支（默认不启用） |

### 4.2 需要下发的 CSP 指令清单（给 backend-core / PM 参考，**本轮不自编 CSP**）

基线 `default-src 'self'; connect-src 'self' ws: wss:` 下，前端**实际需要**的补充：

| 指令 | 是否必需 | 依据 |
|---|---|---|
| `style-src 'self' 'unsafe-inline'` | **必需** | 4 处 Vue `:style` 绑定会写成元素 inline style 属性：`src/components/base/AppAvatar.vue:49,55`、`src/components/base/AppModal.vue:49`、`src/components/base/AppSkeleton.vue:11`、`src/components/layout/PresenceDot.vue:26`。**没有 `'unsafe-inline'` 这 4 处尺寸/底色会失效**（布局塌）。若要摘掉 `'unsafe-inline'`，需把这 4 处改为 CSS 变量 + class（后续可做，本轮未做，因会动 4 个组件的样式实现） |
| `img-src 'self' data: https:` | **预留（当前非必需）** | 当前产品线**无任何外链头像在渲染**（9 个调用方全部只传 `:name`/`:seed`，走首字母 CSS 兜底）。本轮给 `AppAvatar` 加了可选的 `src` 分支，为将来接入远端头像预留。若届时只允许自有域名，应收紧为 `img-src 'self' data:` + 具体图床域名 |
| `connect-src 'self' ws: wss:` | **必需**（任务书已含） | REST `/api/v1/*` 走同源（`baseURL: ''`），WS 走 `${location.host}/ws?ticket=...`。dev 下经 Vite proxy 同源，生产同源；`ws:`/`wss:` 覆盖协议 |
| `script-src 'self'` | 足够 | 无内联 script、无 `eval`（见 4.1） |
| `base-uri 'self'` / `frame-ancestors 'none'` / `object-src 'none'` | 建议 | 纵深防御，前端无需求冲突 |
| `font-src 'self'` | 足够 | 未引外部字体 |

> **本身份**：以上是「前端实测出的需求清单」，不是 CSP 策略决定。最终响应头由 **backend-core** 下发，避免前后端各写一套冲突。

### 4.3 外链头像 referrerpolicy 实施

`frontend/src/components/base/AppAvatar.vue` 新增可选 `src` prop 与 `<img>` 分支，责任收敛在组件内部：

- `referrerpolicy="no-referrer"` —— 不把站内 URL/来源泄露给第三方图床（核心诉求）；
- `loading="lazy"` + `decoding="async"` —— 长列表不一次性拉全部头像；
- `@error="imgFailed = true"` —— 图挂或被 CSP 拦下时**永久退回首字母**，不留破图；
- `object-fit: cover`（scoped `.avatar-img`）—— 非正方形图不变形。

**默认行为零变化**：`src` 默认 `''`，9 个既有调用方一个都没传，仍走 `{{ initial }}` 首字母路径；`vue-tsc` + 44 单测 + build 均通过，作为回归证据。
**未验**：该 `<img>` 分支**当前无调用方**，且本机 `node_modules` 无 jsdom/happy-dom，无法做 DOM 级渲染断言 → 列为「未验」，不宣称通过。

### 4.4 同源 localStorage token 的信任边界（说明 + 缓解建议）

现状（`frontend/src/stores/auth.ts:14-15`）：`TOKEN_KEY = 'aitrance.session'`、`EXPIRES_KEY = 'aitrance.sessionExpiresAt'`，token 是 **opaque Bearer**（非 JWT），明文存 `localStorage`。

**信任边界**：`localStorage` 的隔离粒度是 **origin（协议+主机+端口）**，不是路径。因此——

1. 同一 origin 下的**任何**页面/脚本（其它路径、子目录、被第三方接管的路由）都能 `localStorage.getItem('aitrance.session')` 读到该 token；
2. 任何一次 **XSS** 都能直接取走 token 并离线重放（这是 opaque token 存 Web Storage 的固有放大效应，`MessageBubble.vue:6` 的注释已把它写成「永不 v-html」的动因）；
3. token 立即使生效期由 `expiresAt` 约束（到期前 60s 静默续期），无「HttpOnly」保护，JS 侧可读写。

**可落地缓解（按代价升序）**：

- **独立源 / 子域隔离**：把聊天应用部署在独立 origin（如 `chat.example.com`）或独立端口，避免与同源其它应用共享 Storage。**这是本轮唯一无需改认证契约的建议**，代价是部署/证书配置。
- **`__Host-` cookie + `SameSite=Strict` + `HttpOnly`**：能挡住 XSS 窃取，但**必须改认证契约**（后端要接受 Cookie 认证、CSRF 防护、ticket 换取链路要跟着改）→ **不在本轮**。
- **缩短 token TTL + 续期绑定设备指纹**：降低泄露后的重放窗口，同样需后端配合。
- 短期**已具备**的缓解：`v-html` 全线禁用（0 处）、无 `eval`、无第三方资源 → XSS 攻击面已收到最小。

**明确声明：本轮没有改动认证契约** —— `stores/auth.ts` 的存储键、`api/http.ts` 的 Bearer 注入、`baseURL: ''`、WS ticket 流程全部保持原样；仅修了 2.2 节的「旧 token 401 误踢」与「续期重复登出」两个纯前端缺陷。

### 4.5 【追加】发现并修复的缺陷：zod 的 JIT 探针在严格 CSP 下产生 `script-src` 违规

**缺陷来源**：不是静态扫描发现的，是 backend-core 用**真 Chrome 加载生产构建产物**做 CSP 裁决时实测到的（`backend/evidence/csp-browser-check.log`，修复前）：

```
[2.6s] violations: style=0 script=1 other=0
[2.6s] script violations: [{"directive":"script-src","blocked":"eval","sample":"",
        "source":"http://127.0.0.1:58684/assets/auth-DffZJoi6.js:2:13162","disposition":"enforce"}]
```

即：严格策略（`script-src 'self'`，无 `'unsafe-eval'`）下，有一条 **blocked=eval** 的 script-src 违规。

**根因定位**（逐行核对 `node_modules/zod`，非推测）：

1. `frontend/package.json:23` `"zod": "^4.6.5"`（实测安装 4.6.5）；`frontend/src/ws/schema.ts:14` 与 `frontend/src/ws/handlers.ts:17` 引入 zod，被 Vite 打进 `auth` chunk（`dist/assets/auth-*.js`），登录页即加载 → 违规出现在 auth chunk 的 source 上。
2. `frontend/node_modules/zod/v4/core/util.js:216` 的 `allowsEval` 会做一次探针：`const F = Function; new F("");`；异常被 `catch` 吞掉（所以**功能一直是正常的**，只是浏览器仍记违规）。
3. `frontend/node_modules/zod/v4/core/schemas.js:1166` `const jit = !core.globalConfig.jitless;` —— 在 **schema 构造时**读取并固化。
4. zod 自己在 `util.js:219` 的注释里点明了这件事：

   > `// Skip the probe under \`jitless\`: strict CSPs report the caught \`new Function\` as a \`securitypolicyviolation\` even though the throw is swallowed.`
   > `if (globalConfig.jitless) {`

   同时 `frontend/node_modules/zod/v4/core/core.d.ts:70` 的 `$ZodConfig.jitless` 注释：「Disable JIT schema compilation. Useful in environments that disallow `eval`.」

**结论：`z.config({ jitless: true })` 是 zod 官方给出的正规解法，不是我方自创的规避**。

**修复**（唯一改动点，`frontend/src/ws/schema.ts:37`）：

```ts
import { z } from 'zod'
import { WS_PROTOCOL_VERSION } from './constants'

// （37 行）必须在任何 schema 构造之前
z.config({ jitless: true })
```

**为什么放在 `schema.ts` 模块体首行，而不是 `main.ts` 的 bootstrap 里**（实测依据，非推理）：

- ESM 的求值顺序是「先求值完所有 import，再执行模块体」。`main.ts:5` `import { registerWsHandlers } from './ws/handlers'` → `handlers.ts:31` `from './schema'` → `schema.ts` 顶层 `z.object(...)` 会**先于** `main.ts` 的任何语句执行。等 `bootstrap()` 里再调 config，那批 schema 早已 `const jit = !globalConfig.jitless` 固化成 `true`。
- 实测（`Function` 记账代理 + 按 ESM 顺序模拟）：config 之前构造的 schema 会触发 1 次 `new Function`，config 之后构造的为 0 次。
- 变异验证：把 `z.config({ jitless: true })` 从 37 行挪到文件末尾 → 新单测 `schema.eval-probe.test.ts` 立即失败（`1 failed | 47 passed`），证明「顺序」这件事被测住，而不是「config 有没有被调用」被测住。
- 放 `schema.ts` 还能覆盖**单测入口**：测试直接 `import './schema'` 也会走 config；若放 `main.ts`，vitest 路径根本不加载 main.ts，测试就测不到这行。`schema.ts` 是全仓**唯一**的 zod 运行时入口（`handlers.ts:17` 只是 `import type`），覆盖面即全量。

**性能权衡（第 5 点问题的实测回答：可接受）**

用与 `src/ws/schema.ts` 同形的 schema（信封 + message 各一次 `safeParse`）在本机 Node 24 实测，单进程单模式各跑 3 轮（`globalConfig` 是模块级单例，必须分进程才能对照）：

| 模式 | µs / 帧（信封+消息体两次 safeParse） |
|---|---|
| JIT（默认） | 0.289 / 0.427 / 0.313（中位 ≈ **0.31**） |
| `jitless: true` | 1.181 / 1.408 / 1.326（中位 ≈ **1.33**） |

即 jitless 让 zod 校验慢约 **4.3 倍**、每帧多约 **1 µs**。换算到真实量级：WS 帧按连续 1000 帧/秒的最坏轰击算，额外 CPU 约 **1.0 ms/s**（≈0.1% 单核）；聊天 MVP 的实际峰值是个位数帧/秒，额外开销在 **µs/s** 级。对比收益（消除每条违规 + 无 `unsafe-eval` 的严格 CSP），**判定可接受，按 zod 官方建议全量 `jitless`**，不做「仅生产构建关闭」的分裂配置（那会让 dev/生产校验路径不一致，反而难测）。

**修复后实测**（产物已重建，`node backend/evidence/csp-browser-check.mjs`，`CSP_EXIT=0`；完整输出存档于 `frontend/evidence/csp-browser-check-after-jitless.log`）：

```
[3.3s]  violations: style=0 script=0 other=0
[11.3s] violations: style=0 script=0 other=0
assertions=14 failures=0
```

两种策略（strict `style-src 'self'` / relaxed `'unsafe-inline'`）下 **script 违规均归零**，其余 14 条断言全 PASS，功能无回归（登录 → /chat → 打开「发起群聊」弹层均正常）。产物级佐证：`grep -o "jitless:!0" dist/assets/auth-*.js` → 命中 1 次，说明 config 调用确实进了生产包。

**新增单测 2 个文件 4 条**（`27 → 48`）：

- `frontend/src/ws/schema.test.ts`（3 条）：静态 import 后 `z.core.globalConfig.jitless === true`；jitless 下 schema 语义不变（正例通过、`seq:-1` 与 `type:'unknown'` 仍被拒）；`zReadyData` 的 passthrough 宽松策略未受影响。
- `frontend/src/ws/schema.eval-probe.test.ts`（1 条）：把全局 `Function` 换成记账代理后**动态** `import('./schema')`，断言 `calls === []`（构造期零 `new Function`）。必须独立成文件——同文件里的静态 import 会先求值完模块，代理装晚了就测不到。

**为什么不在当前环境复现「浏览器违规→0」以外的验证**：script violation 的消除只能由真浏览器判定（`new Function` 被 CSP 拦的时机是浏览器行为，Node 里没有 CSP），故以 `backend/evidence/csp-browser-check.mjs` 的实测为准，本条结论即该脚本 `script=0` 的输出。

---


## 五、逐条验收结论

| 项 | 结论 |
|---|---|
| A1 六反例逐条核查源码防线 | **PASS**（§2.1，附精确行号） |
| A2 新增 ≥4 条真实竞态单测 | **PASS**（新增 21 条，超要求 4 条） |
| A3 发现缺口就地修 + 保持 4 处 overlay 匹配点 | **PASS**（修 3 处 + 1 处配套；§2.5 复核） |
| B1 锁文件指向 1.2.2 | **PASS**（锁文件 + node_modules 双端 1.2.2） |
| B2 产物不可达证据 | **PASS**（§3.3 四条 grep 全无命中） |
| B3 docs §十一 更新 + 注明待 PM 复核 | **PASS**（§十一 已改写；§9.3/§十 受作用域限制未改，已显式标注） |
| B4 npm audit high 数变化 | **PASS**（high 3→2，`source-map-js` 消失） |
| C1 CSP 需求清单 | **PASS**（§4.2，交 backend-core 决定最终头） |
| C2 外链头像 referrerpolicy | **代码 PASS，渲染未验**（无调用方 + 无 DOM 测试环境） |
| C3 localStorage 信任边界 + 缓解 | **PASS**（§4.4，明确未改认证契约） |
| C4 不动 `baseURL: ''` | **PASS**（`:53` 原样） |
| D1 严格 CSP 下 script-src 违规消除（zod JIT 探针） | **PASS**（真 Chrome 实测 `script=0`，14/14 断言；§4.5） |
| D2 jitless 性能可接受性 | **PASS**（实测 +1 µs/帧、约 4.3×，真实量级 <0.1% 单核；§4.5） |
| E1 弹层打开瞬间焦点进入弹层 | **PASS**（§六；真 Chrome 断言 + 变异可击穿） |
| E2 手机面板 Esc 可关闭 | **PASS**（§六；修前 `焦点=BUTTON` 面板仍在） |
| E3 手机面板 Tab 不逃逸到 body | **PASS**（§六；修前 `焦点=BODY`） |
| E4 弹层既有 4 项焦点行为不回归 | **PASS**（§六；Tab 循环 / Shift+Tab / Esc / 关闭归还全部复验） |
| E5 遮罩点击、「取消」关闭不回归 | **PASS**（§六；两条原有 PASS 路径复验） |
| typecheck / test / build | **PASS**（§一 全部 exit 0） |

**未验 / BLOCK（不宣称通过）**：

1. `AppAvatar` 的 `<img>` 分支**无调用方**，且本机无 jsdom/happy-dom → 无 DOM 级渲染断言，**未验**。
2. CSP 在**真实浏览器**下是否放行（4 处 inline style、未来外链头像）—— 已由 `backend/evidence/csp-browser-check.mjs` 实测 14/14 PASS，但**落成正式响应头仍需 backend-core 下发后再由 e2e 复验**，仍是 **BLOCK（依赖 backend-core + e2e 任务）**。
3. 真机 iOS/Android 不受本轮影响，仍按 `docs/09` §9.3 计「待真机验证」，**未验**。
4. `docs/09` §9.3 与 §十 的 SEC-03 状态行仍写「未关闭」——**受写作用域限制未同步，需 PM 处理**（非 BLOCK，是交接口）。
5. 剩余 high 漏洞（`vite`、`follow-redirects`）不在本任务范围，**未处理**。
6. jitless 的性能数据取自 **Node 24 本机**，未在低端移动设备实测；按 §4.5 的量级推算可忽略，但若后续引入高频流式校验需重新评估。

---

## 六、task-4 浏览器矩阵报出的 3 个组件缺陷（修复与复验）

**来源**：`frontend/evidence/e2e-browser.md:94-98` 的缺陷表（frontend-e2e 用真浏览器跑出）：

```
1. 焦点=BUTTON/BUTTON      → 弹层打开后焦点仍停在触发按钮上
2. Esc 后面板仍在          → 手机「更多」面板 Esc 无效
3. 焦点=BODY               → 手机面板 Tab 逃逸到 body
```

**核对结论：3 条都是真缺陷，无一条误报。**依据：

| 缺陷 | 修前代码证据 | 为何是真缺陷 |
|---|---|---|
| 1 打开瞬间不聚焦 | `AppModal.vue` 改前只有 `onKeydown`（Esc）与 `onKeydownTrap`（Tab），**没有任何初始聚焦逻辑**，也没有 `tabindex` 可退的容器 | `role="dialog" aria-modal="true"` 声明了模态语义却不接管焦点，键盘/读屏用户的实际焦点仍在背后页面 |
| 2 手机 Esc 无效 | `MobileNav.vue` 的 `.sheet` 改前**一行 keydown 处理都没有** | 桌面弹层能 Esc 关、手机面板不能 —— 同一产品两条不一致契约 |
| 3 Tab 逃逸 | 同上，无 Tab 拦截 | 焦点跑到 `<body>` 后键盘用户需从头 Tab 才能回到界面 |

### 6.1 根因（一句话）

两条对话框实现各自演化，`AppModal` 只长了「循环/关闭」两半、`MobileNav` 一点键盘支持都没长 → **判定规则分裂**。

### 6.2 修法（不重写，只收敛 + 补齐）

1. **抽公共判定到 `frontend/src/utils/dialogA11y.ts`**（新增，~150 行，纯函数）：
   - `FOCUSABLE_SELECTOR`：与 `e2e-matrix.mjs:311/325` 的 `focusables()`/`focusNth()` **逐字相同**（`button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])`）+ `isFocusableLike` 过滤 `disabled` 与 `offsetParent === null`。
   - `dialogKeyAction({key, shiftKey, dialogOpen, focusableCount, focusIndex, isComposing})` → `{type:'close'} | {type:'focus',target:'first'|'last'} | null`。
   - `initialFocusIndex(count)` → `count > 0 ? 0 : -1`。
   - 三个细节判定（都是为了不引入新缺陷）：
     - `dialogOpen === false` 直接 `null` —— 窗口监听是常驻的，不判会误关。
     - `isComposing === true` 不拦 Esc —— 中文输入法组合中按 Esc 会误触。
     - `focusIndex === -1` 时**正向 Tab 不拦**（容器带 `tabindex="-1"`，浏览器会自然走到容器内首个元素；强行 preventDefault 反而把焦点卡在容器上），仅 `Shift+Tab` 兜底到末尾。
2. **`AppModal.vue`**：判定改为调用共享函数（**不重写行为**，原 4 项 PASS 逐条保留）；新增 `watch(() => props.open, ..., { immediate: true })` 做初始聚焦 + 关闭归还（`restoreTarget` + `isConnected` 判定）；`.panel` 补 `tabindex="-1"`；两个 `window.addEventListener` 合并为一个（原先 `onKeydown` + `onKeydownTrap` 双监听）。
3. **`MobileNav.vue`**：补 `ref="sheetRef"` + `tabindex="-1"` + 常驻 `keydown` 监听（Esc → `ui.closeMore()`；Tab/Shift+Tab 循环）+ 初始聚焦 + 关闭归还。**`@click.self` 遮罩关闭与「取消」按钮原样未动**。

> **关于「不要重写整个焦点逻辑」**：Lead 明确要求别推倒重来。本次 4 项既有 PASS 行为的**表达式全部保留**（Tab/Shift+Tab/Esc/归还的语义一条未改），改动是「判定搬进共享函数 + 新增初始聚焦」；搬家的收益是 MobileNav 能复用同一份规则，而不是复制粘贴出第二份会漂移的实现。

### 6.3 验证方式（三层，均实测）

| 层 | 手段 | 结果 |
|---|---|---|
| 纯函数单测 | `frontend/src/utils/dialogA11y.test.ts`（新增 19 条） | 67/67 绿 |
| 契约锁单测 | 最后 3 条：①`e2e-matrix.mjs` 中 `FOCUSABLE_SELECTOR` 出现 ≥2 次；②`AppModal`/`MobileNav` 都 `import '@/utils/dialogA11y'` + 调 `dialogKeyAction(` + 有 `addEventListener('keydown'`；③两者都含 `tabindex="-1"` | 67/67 绿 —— **防止「函数写完没人用」的假绿** |
| 真浏览器 | 新增 `frontend/scripts/verify-dialog-a11y.mjs`（~270 行，真 Chrome） | **15/15 PASS** |

真浏览器 15 项明细（`node scripts/verify-dialog-a11y.mjs` → `汇总：15/15 PASS`）：

```
PASS  弹层打开时焦点自动进入弹层  —— 焦点=BUTTON/          ← 缺陷 1
PASS  打开瞬间焦点已离开触发按钮  —— title=                 ← 缺陷 1（防 inside 假绿）
PASS  弹层 Tab 在最后一个元素处循环回首个（未回归）
PASS  弹层 Shift+Tab 在首个元素处循环到末尾（未回归）
PASS  弹层 Esc 可关闭（未回归）
PASS  弹层关闭后焦点归还触发按钮  —— title=发起群聊
PASS  手机「更多」面板可打开
PASS  手机面板打开时焦点进入面板  —— 焦点=BUTTON/切换到深色主题
PASS  手机面板 Esc 可关闭                                ← 缺陷 2
PASS  手机面板 Esc 关闭后焦点归还「更多」按钮  —— cls=mnav__tab
PASS  手机面板 Tab 焦点不逃逸到 body  —— 焦点=BUTTON/切换到深色主题   ← 缺陷 3
PASS  手机「更多」面板可关闭（取消，未回归）
PASS  手机面板 Shift+Tab 焦点不逃逸到 body  —— 焦点=BUTTON/取消
PASS  手机「更多」面板可关闭（取消，未回归）
PASS  手机面板遮罩点击仍可关闭（未回归）
```

截图：`frontend/evidence/focusfix-modal-open.png`、`frontend/evidence/focusfix-sheet-trap.png`。

### 6.4 变异验证（证明断言非空转，已全部还原）

| 变异 | 击穿情况 |
|---|---|
| 删掉 `AppModal` watch 里的 `list[idx]?.focus()`/容器聚焦 | 浏览器 2 条 FAIL（`弹层打开时…`、`打开瞬间焦点已离开触发按钮`），13/15 |
| `dialogA11y.ts` 把 `key === 'Escape'` 改成永假 | 单测 1 failed / 66 passed |
| 删掉 `MobileNav` 的 `window.addEventListener('keydown', onSheetKeydown)` | 单测 1 failed（契约锁第 2 条命中）/ 66 passed |

全部还原后复跑：`Test Files 8 passed (8) / Tests 67 passed (67)`、`TYPECHECK_EXIT=0`、浏览器 `15/15 PASS`、`BUILD_EXIT=0`。

### 6.5 复跑数字

```
单测     48 → 67（+19）  8 files / 67 tests，exit 0
vue-tsc  exit 0
build    exit 0（dist/assets/auth-*.js 129.82 kB；strip-mock-worker 校验通过）
浏览器   15/15 PASS（新增，覆盖 3 条缺陷 + 5 条防回归）
```

---

## 七、改动文件清单

```
frontend/src/api/http.ts                     +~50 行：token 快照防误踢、终局通知去重
frontend/src/stores/auth.ts                  +2 行：applySession 重置终局标记
frontend/src/components/base/AppAvatar.vue   +~25 行：可选 src + referrerpolicy/no-referrer + error 兜底
frontend/src/ws/schema.ts                    +24 行注释/1 行代码：z.config({ jitless: true })（严格 CSP，§4.5）
frontend/src/api/http.test.ts                新增 5 tests
frontend/src/ws/client.test.ts               新增 4 tests
frontend/src/stores/message.test.ts          新增 4 tests
frontend/src/stores/conversation.test.ts     新增 4 tests
frontend/src/ws/schema.test.ts               新增 3 tests（jitless 生效 + 语义不变）
frontend/src/ws/schema.eval-probe.test.ts    新增 1 test（构造期零 new Function，变异可击穿）
frontend/src/utils/dialogA11y.ts             新增 ~150 行：对话框焦点判定纯函数（与 e2e 选择器同源）
frontend/src/utils/dialogA11y.test.ts        新增 19 tests（Esc / Tab 循环 / 初始焦点 / 契约锁）
frontend/src/components/base/AppModal.vue    重写 ~240 行：初始聚焦 + 关闭归还 + 判定外置
frontend/src/components/layout/MobileNav.vue +~95 行：Esc 关闭 + Tab 陷阱 + 初始聚焦 + 关闭归还
frontend/scripts/verify-dialog-a11y.mjs      新增 ~270 行：真 Chrome 15 项焦点断言
frontend/evidence/focusfix-*.png             新增 2 张截图（弹层打开态 / 面板 Tab 陷阱态）
frontend/package-lock.json                   source-map-js 1.2.1→1.2.2 + 6 条 bundleDeps 登记
docs/09-responsive-ui.md                     §十一 改写（仅此节）
frontend/evidence/frontend-core.md           本文件
```

**回滚方式**：源码为纯新增/局部替换，`git checkout -- <path>` 即回滚（仓库当前为 untracked 初始态，故实际以文件备份为准：
`/tmp/http.bak`、`/tmp/client.bak`、`/tmp/conv.bak` 为 SEC-02 变异测试的还原源，`/tmp/AppModal.vue.bak`（md5 a851c5863f8c7337ee28a307d31ba257）、`/tmp/MobileNav.vue.bak`（md5 3e43e89c8c2e17d94abe736c5be911f9）为 §六 组件修复的还原源，均已 `cp` 回并复跑 **67/67** 验证）；锁文件回滚 = 把 `node_modules/source-map-js` 块改回 1.2.1 后 `npm install`。

**§六 新增文件的回滚**：`frontend/src/utils/dialogA11y.ts` 与其测试、`frontend/scripts/verify-dialog-a11y.mjs` 均为全新文件，直接删除即回滚；但删了必须同步把 `AppModal.vue` / `MobileNav.vue` 一并回滚到 `/tmp/*.bak`，否则 import 断裂、vue-tsc 必红。
