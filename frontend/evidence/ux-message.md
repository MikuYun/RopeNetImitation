# UX-C — 消息区 Markdown 渲染 / MD 编辑器 / 附件前端

> 用户反馈原话：「无美化md格式,输入md等富文本格式就是纯文本」+ 附件前端。
> 本文件的每一节都可以独立复核：每项结论后面都给了可重跑的命令或源码坐标。

---

## 一、结论摘要

| 项 | 结果 |
| --- | --- |
| 消息正文 Markdown 渲染 | ✅ 自研纯 TS 子集渲染器，`h()` 组装 VNode，**全程零 HTML 字符串** |
| `v-html` | ✅ 全仓实际使用 **0 处**（12 处字样均为注释里的规则说明，见 §五） |
| 输入框 MD 工具条（11 个格式按钮：粗/斜/删/行内码/代码块/引用/无序/有序/链接/表格/标题）+ 快捷键 | ✅ `Ctrl/⌘ + B / I / E / K` |
| 输入框实时预览（可切回编辑） | ✅ 预览态与草稿共存，textarea 用 `v-show` 保留光标与草稿 |
| 附件：选文件 / 拖拽 / 粘贴 / 进度 / 取消 / 移除 | ✅ 前端 10 MiB 预检、`AbortController` 取消 |
| 附件消息显示（图片缩略图 + 灯箱、文件卡片） | ✅ 图片走 `Authorization: Bearer` → `blob:` → `objectURL`，**token 绝不进 URL** |
| 消息区精修（长文折叠 / 源码切换 / 代码复制 / 未读浮动入口 / 附件发送与重试） | ✅ 折叠用 CSS，正文始终留在 DOM；未读提示在离开底部时出现 |
| 单测 | ✅ **172 条全绿**（基线 67 → 现 172，净增 105） |
| `vue-tsc --noEmit` | ✅ exit 0 |
| `vite build` | ✅ exit 0 |
| 变异验证（故意改坏 XSS 防线） | ✅ 5 条红 → 还原 → 60 条绿 |
| 真机截图 | ✅ **22 张**（`docs/evidence/ux-md-01..22-*.png`），已逐张打开自检 |
| 附件端到端（真实会话内发图/发文件） | ⚠️ **未验** —— 后端上传路由当时未落地，见 §十一 风险 1；组件行为已用隔离页 + 拦截验证（§七 说明） |

**未验项（必须在验收时知道）**：后端上传路由当时尚未落地（详见 §十一）。

---

## 二、渲染器设计：为什么不用 v-html

### 2.1 既有硬规则

`frontend/src/components/message/MessageBubble.vue` 文件头第 5-6 行是仓库的既有安全硬规则，本轮**原文保留**：

> 安全硬规则：消息文本**永不**使用 v-html，一律 `{{ }}` 插值 —— opaque token 存在 localStorage，XSS 的影响被放大，不能用富文本渲染换便利。

这条规则不是风格偏好，是威胁模型推出来的。展开论证：

1. **token 位置放大 XSS 收益。** 会话 token 存在 `localStorage`，任何脚本执行都能直接读走并离线复用；不是 httpOnly Cookie，没有浏览器兜底。所以"渲染便利"换不来任何安全余量——一次 XSS 就是账号完全失守。
2. **`v-html` 是 HTML 注入的原语。** `v-html="str"` 等价于 `el.innerHTML = str`，浏览器会把 `str` 当**标记**解析。只要这条通路存在，任何"看起来安全"的预处理（转义、白名单）都必须在字符串层面做到完美，一旦有遗漏就是 RCE 级漏洞。
3. **"MD → HTML 字符串 → innerHTML"是同一个洞换了个名字。** Markdown 语法本身允许内联 HTML：`**<img src=x onerror=alert(1)>**` 在多数 MD 实现里会把标签原样吐出来。如果渲染器产出 HTML 字符串再交给 `innerHTML`，那么 XSS 的成败就取决于"我的正则有没有漏"——这正是历史上 Markdown 渲染器出过最多次漏洞的地方。**所以这条路本轮完全不采用，包括它的任何变体**（`outerHTML`、`insertAdjacentHTML`、`document.write`、`DOMParser.parseFromString` + 重组）。

### 2.2 采用的方案：解析成数据 → `h()` 组装 VNode

```
消息字符串 ──parseMarkdown──▶ VNode[] ──▶ Vue runtime──▶ 真实 DOM
                    │
                    └─ 中间态是 JS 对象（VNode），不是 HTML 字符串
```

- 文件：`frontend/src/utils/markdown.ts`（692 行），导出 `renderMarkdown(source, options?): VNode[]`。
- 文本一律进 `h('span', text)` / `h('strong', text)` 的**文本子节点**位置——Vue 内部走 `document.createTextNode()`，**构造上不可能被解析成标签**。
- 结构化元素（段落、列表、表格、代码块）用 `h('p'|'ul'|'table'|…)` 建，属性走 JS 对象。全程没有字符串拼接 DOM。
- 不安全链接（`javascript:` / `data:` / `vbscript:` / `file:` / `//host` / 夹控制字符）**降级为纯文本字面量**：直接 `[x](javascript:alert(1))` 原样显示成一串文字，连 `<a>` 都不生成。
- 安全链接固定带 `target="_blank"` `rel="noopener noreferrer nofollow"`——防 `window.opener` 反向控制，也避免把站内链接的权重/引荐信息泄露出去。

**一句话**：注入面不是"我有没有转义对"，而是"我的代码有没有办法生成一个可执行节点"——答案是没有，因为渲染器只会 `createTextNode` 和 `createElement` 白名单里的那几个。

### 2.3 性能

真机 Chrome 实测（`page.evaluate` 里动态 import 渲染器，每档 200 轮取平均，warmup 已剔除）：

| 输入规模 | 平均单次渲染 |
| --- | --- |
| 短消息 80 字符 | **0.009 ms** |
| 常规 1k 字符 | **0.040 ms** |
| 长文 10k 字符 | **0.295 ms** |
| 上限 100k 字符 | **2.295 ms** |
| GFM 表格 40 行 | **0.036 ms** |
| 全要素样例 ~200 字符 | **0.013 ms** |

任务书性能门是「10k 字符 < 20 ms」，实测 **0.295 ms，留了约 67 倍余量**（单测里 `10k 字符消息渲染 < 20ms` 也作为用例常驻）。

---

## 三、Markdown 子集支持表

| 语法 | 支持 | 产出的 DOM | 备注 |
| --- | --- | --- | --- |
| 段落 | ✅ | `p.md-p` | 空行分段 |
| 段内换行 | ✅ | `br` | 聊天场景下"换行即换行" |
| `#`~`######` 标题 | ✅ | `h1.md-h.md-h--1` … `h6` | 1.3em / 1.2em / 1.1em / 1em |
| `**粗**` / `__粗__` | ✅ | `strong.md-strong` | 词内下划线不误判（`snake_case` 安全） |
| `*斜*` / `_斜_` | ✅ | `em.md-em` | |
| `***粗斜***` | ✅ | `strong > em` | |
| `~~删除~~` | ✅ | `del.md-del` | |
| `` `行内码` `` | ✅ | `code.md-code-inline` | 内部标记不再解析 |
| ```` ```lang ```` 代码块 | ✅ | `div.md-code` + `.md-code__bar` + `.md-code__lang` + `.md-code__copy` + `pre.md-code__pre > code.md-code__code` | 语言徽标 + 一键复制（**不引高亮库**，纯文本 + 深色底） |
| `[文本](http/https/相对)` | ✅ | `a.md-link` | `target=_blank` `rel="noopener noreferrer nofollow"` |
| `[文本](javascript:/data:/vbscript:/file:/…` | ✅ 降级 | 纯文本字面量 | 不生成 `<a>` |
| `> 引用` | ✅ | `blockquote.md-quote` | 支持内部再解析行内语法 |
| `- / * / +` 无序列表 | ✅ | `ul.md-ul > li.md-li` | 支持缩进嵌套一层 |
| `1.` 有序列表 | ✅ | `ol.md-ol > li.md-li` | |
| `- [ ] / - [x]` 任务项 | ✅ | `li.md-li > span.md-task` | |
| `---` / `***` / `___` 分割线 | ✅ | `hr.md-hr` | |
| GFM 表格 | ✅ | `div.md-table-wrap > table.md-table` | 支持 `:---:` 对齐，窄屏横向滚动 |
| 反斜杠转义 `\*` | ✅ | 纯文本 | |
| **原始 HTML 透传** | ❌ **故意不支持** | — | `<script>`、`<img onerror>` 等一律当文本显示 |
| 图片 `![]()` | ❌ | — | 附件走独立的 `AttachmentView`（带鉴权），不从 MD 里加载任意 URL |
| 自动链接 `http://…` | ❌ | — | 需显式 `[]()`，避免意外外链 |

> 设计取舍：图片 `![]()` **不做**，因为 MD 里内联任意 URL 等于给消息正文开一个任意网络请求的出站通道（可做 SSRF/追踪像素/信息外泄）。附件图片必须走上传接口 + Bearer 鉴权 + `blob:`，这是唯一通路。

---

## 四、XSS 测试清单

单测文件：`frontend/src/utils/markdown.test.ts`（60 条，其中 XSS 相关见下）。

### 4.1 正文注入向量（18 条，逐条断言"只有转义后的文本，没有元素/事件属性"）

`frontend/src/utils/markdown.test.ts:268-285`：

1. `<script>alert(1)</script>`
2. `<img src=x onerror=alert(1)>`
3. `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`
4. `<iframe src="javascript:alert(1)"></iframe>`
5. `<a href="javascript:alert(1)">x</a>`
6. `<div onmouseover="alert(1)">hover</div>`
7. `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`（mXSS 变异向量）
8. `"><script>alert(1)</script>`
9. `<style>body{background:url(javascript:alert(1))}</style>`
10. `<!--[if IE]><script>alert(1)</script><![endif]-->`
11. `**<img src=x onerror=alert(1)>**`（强调内嵌标签）
12. `> <script>alert(1)</script>`（引用内嵌）
13. `- <img src=x onerror=alert(1)>`（列表内嵌）
14. 围栏代码块内嵌 `<script>alert(1)</script>`
15. 表格单元格内嵌 `<img src=x onerror=alert(1)>`
16. `[x](javascript:alert(1))`
17. `` `<img src=x onerror=alert(1)>` ``（行内码内嵌）
18. `&lt;script&gt;alert(1)&lt;/script&gt;`（已编码实体——必须不二次解码）

**断言写法（关键）**：不能断言 `not.toMatch(/\son\w+=/i)`——转义后的**文本**里当然含 `onerror=` 这些字符（`&lt;img src=x onerror=alert(1)&gt;`），它们是文本节点内容而不是属性。正确断言是"没有元素"：

```ts
expect(html).not.toMatch(/<img/i)
expect(html).not.toMatch(/<[a-zA-Z][^>]*\son\w+\s*=/i)
expect(html).not.toMatch(/<a\s[^>]*href="\s*(?:javascript|data|vbscript):/i)
```

### 4.2 链接协议白名单（`isSafeHref`）

**放行**（`markdown.test.ts:42-48`）：`https://example.com/a?b=1#c`、`http://localhost:5173/chat`、`/chat/1`、`./docs/a.md`、`../up`、`chat/2`、`#anchor`
**拒绝**（`:56-66`）：`javascript:alert(1)`、`JavaScript:alert(1)`（大小写）、` javascript:alert(1)`（前导空白）、`java\tscript:alert(1)`（制表符夹断）、`java\nscript:alert(1)`（换行夹断）、`data:text/html,<script>alert(1)</script>`、`vbscript:msgbox(1)`、`file:///etc/passwd`、`//evil.example.com/x`（协议相对）、`''`、`'   '`。

其中夹控制字符的两条专门针对浏览器"先剥空白再解析协议"的行为（`java\tscript:` 剥掉 `\t` 后就是 `javascript:`），实现里用 `RE_CONTROL = /[\u0000-\u001F\u007F]/` 先拒：

```ts
if (RE_CONTROL.test(href)) return false
…
const proto = (scheme[1] ?? '').toLowerCase()
return proto === 'http' || proto === 'https'
```

### 4.3 变异验证：证明这些断言真的会抓人

**目的**：如果哪天有人把渲染器改回 `v-html` 路线，测试必须变红——否则测试就是摆设。

**变异体**（改坏 `frontend/src/utils/markdown.ts` 的两处防线）：删掉 `:142` 的 `if (RE_CONTROL.test(href)) return false`，并把 `:149` 的 `return proto === 'http' || proto === 'https'` 改成 `return proto.length >= 0`（放行一切协议）。

**变异后**（`node node_modules/vitest/vitest.mjs run src/utils/markdown.test.ts`）：

```
     × 拒绝 javascript:/data:/vbscript:/file:/协议相对 与夹控制字符的变体 5ms
     × javascript: 链接降级为纯文本，不生成 a 标签 1ms
     × data: 链接降级为纯文本 1ms
     × 向量「[x](javascript:alert(1))」只有转义后的文本，没有元素/事件属性 1ms
     × 窄断言：任何输入都不会出现 <a href="javascript: 1ms
 Test Files  1 failed (1)
      Tests  5 failed | 55 passed (60)
```

失败断言原文（证明它抓到的是真漏洞，不是断言写错）：

```
FAIL  src/utils/markdown.test.ts > XSS：消息正文绝不产生可执行节点 > 窄断言：任何输入都不会出现 <a href="javascript:
AssertionError: expected '<div><p class="md-p"><a class="md-lin…' not to match /<a [^>]*href="(?:javascript|JAVA…/]{2})
- Expected: /<a [^>]*href="(?:javascript|JAVASCRIPT|[/]{2})/i
```

**还原后**：`Test Files 1 passed (1) / Tests 60 passed (60)`，全量 `11 passed / 166 passed`。

另外 `markdown.test.ts:308-320` 常驻一条"反例对照"用例：用 `createSSRApp({ render: () => h('div', { innerHTML: vector }) })` 模拟 v-html 语义的变异体，证明**同样的向量在反例里会真的变成一个 `<img>` 元素**——即断言不是空洞的"什么都没检查"，而是真的能区分两种实现。

---

## 五、`v-html` 与 HTML 字符串中间态的审计

```bash
cd frontend
grep -rnE "v-html\s*=|v-html>|inner-html" src/ | grep -v "^\s*\*" | wc -l   # → 0
grep -rnE "outerHTML|insertAdjacentHTML" src/                              # → 0
```

12 处 `v-html` **字样**全部在注释里（规则说明，不是使用）：

| 文件:行 | 性质 |
| --- | --- |
| `frontend/src/components/base/AppInput.vue:25` | 注释：悬浮提示"不引入 v-html" |
| `frontend/src/components/message/MarkdownView.vue:6` | 注释：本组件永不 v-html |
| `frontend/src/components/message/MessageBubble.vue:5` | **既有安全硬规则原文**（保留） |
| `frontend/src/components/message/MessageBubble.vue:9` | 注释：MD 不是先转 HTML 再 innerHTML |
| `frontend/src/components/message/MessageBubble.vue:70` | 注释：源码态用 `<pre>{{ source }}</pre>` 插值 |
| `frontend/src/components/message/MessageBubble.vue:154` | 模板注释：正文永不 v-html |
| `frontend/src/components/message/MessageComposer.vue:15` | 注释：全程无 v-html / 无 HTML 中间态 |
| `frontend/src/components/message/MessageComposer.vue:414` | 模板注释：预览态同一渲染器 |
| `frontend/src/utils/markdown.test.ts:10` | 注释：说明用例意义 |
| `frontend/src/utils/markdown.test.ts:308` | 注释：反例模拟变异体 |
| `frontend/src/utils/markdown.ts:5` | 注释：为什么这里没有 v-html |
| `frontend/src/views/MessagePane.vue:9` | 注释：消息文本永不 v-html |

`innerHTML` 仅出现在注释与 `markdown.test.ts:312` 的**反例模拟**（用于证明对照关系）。生产路径零 `innerHTML`。

---

## 六、新增/改动文件

### 新增（12 个）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `frontend/src/utils/markdown.ts` | 692 | MD→VNode 渲染器（核心） |
| `frontend/src/utils/markdown.test.ts` | 380 | 60 条：语法 + 18 XSS 向量 + 性能门 + 变异对照 |
| `frontend/src/utils/attachments.ts` | 103 | 10 MiB 预检、`formatBytes`、类型图标分类、预览文案 |
| `frontend/src/utils/attachments.test.ts` | 128 | 18 条纯逻辑用例 |
| `frontend/src/api/uploads.ts` | 139 | upload / blob 取字节 / objectURL / 下载 / 删除 |
| `frontend/src/components/message/MarkdownNodes.ts` | 22 | 渲染函数挂 VNode 数组（模板插值会变 `[object Object]`） |
| `frontend/src/components/message/MarkdownView.vue` | 332 | 渲染/源码双模视图（`renderMode`） |
| `frontend/src/components/message/AttachmentView.vue` | 437 | 图片缩略图+灯箱 / 文件卡片 / 失败降级 |
| `frontend/src/components/message/ComposerToolbar.vue` | 329 | 11 个格式按钮（含表格）+ 手机端 Aa 折叠开关 + 附件 + 预览 |
| `frontend/src/components/message/markdownEditing.ts` | 278 | 选区级编辑变换（包裹/前缀/围栏/链接/表格骨架） |
| `frontend/src/components/message/markdownEditing.test.ts` | 246 | 27 条（含 6 条 `tableMarkdown`） |
| `frontend/src/components/message/composer.ts` | 17 | `ComposerSendPayload` 类型（`<script setup>` 不能顶层 export 故独立） |

### 重写（2 个）

| 文件 | 行数 | 要点 |
| --- | --- | --- |
| `frontend/src/components/message/MessageBubble.vue` | 469 | 保留全部既有类名（`.bubble`/`.line__*`/`.sys*`）与安全硬规则注释；新增 MD 渲染、源码切换、代码复制、长文折叠、附件 |
| `frontend/src/components/message/MessageComposer.vue` | 696 | **保留 `.composer__input`（textarea）与 `.composer__send`（button）**；新增工具条、预览（随草稿保留）、附件、拖拽、粘贴、快捷键 |

### 改动（9 个，全部纯增量、向后兼容）

| 文件 | 改动 |
| --- | --- |
| `frontend/src/types/domain.ts` | `MessageType` 扩为 `'text'\|'system'\|'image'\|'file'`；新增 `Attachment`；`MessagePreview.attachmentKind?`；`WireMessage.attachment?` |
| `frontend/src/api/wire.ts` | 新增 `WireAttachment`；`WireMessage.type` 联扩 + `attachment` |
| `frontend/src/api/normalize.ts` | `normalizeMessageType` 四值；新增 `toAttachment`；`toWireMessage` 双向类型兜底 |
| `frontend/src/api/messages.ts` | `sendMessage` 收 `SendMessageInput`（`type`/`content` 可选 + `attachmentId`） |
| `frontend/src/stores/message.ts` | `normalizeWire` 透传 `attachment`；`appendOptimistic` 收可选 `attachment` |
| `frontend/src/ws/schema.ts` | 新增 `zAttachment`；`zMessage.type` 四值 + `attachment` 可空（保持非 passthrough） |
| `frontend/src/ws/handlers.ts` | MESSAGE_CREATED 补 `attachment`（否则 WS 推来的附件消息只剩空气泡） |
| `frontend/src/components/layout/ConversationItem.vue` | 会话列表预览显示 `[图片]` / `[文件] name` |
| `frontend/src/views/MessagePane.vue` | 705 行：`onSend(ComposerSendPayload)` 分支（有附件发 `{clientMsgId, attachmentId}`、否则发 `{clientMsgId, type:'text', content}`）；`retry` 按 `msg.attachment` 分支；新增 `unseen` 计数 + `jumpToBottom()` + `.pane__jump` 浮动入口 |

> 说明：`ws/schema.ts` 与 `ws/handlers.ts` 属"只读既有行为"范围的**最小必要扩字段**——不改任何既有分支逻辑，只补 `attachment` 与 `type` 联合。不补的话，WS 推送的附件消息会被 `safeParse` 整帧丢弃（schema 非 passthrough）或丢附件（handlers 逐字段构造）。

### 契约适配

按 ux-api 定稿的灰度方案实现（`backend` 侧 `type` 为 optional 字面量 `'text'`）：

- 纯文本：带 `type: 'text'`（兼容旧后端）
- 附件：不带 `type`，只带 `{ clientMsgId, attachmentId }`（服务端按 upload.kind 推导 `image`/`file`）

---

## 七、截图

全部真机 Chrome（`chromium.launch({ channel: 'chrome' })`），目录 `docs/evidence/`。每张都已用 `read_image` 逐张打开目视检查。

| 文件 | 尺寸 | 内容 | 自检结论 |
| --- | --- | --- | --- |
| `ux-md-01-rendered.png` | 1440×900 | 全要素 MD：H1/H2、粗斜删、行内码、两条链接、嵌套列表、有序列表、引用、分隔线、`ts` 代码块（含语言徽标+复制按钮）、GFM 表格、末尾 XSS 向量 `<img src=x onerror=alert(1)>` 显示为纯文本 | 无原始标签、无 `**` 漏出、无横向溢出 |
| `ux-md-02-source.png` | 1440×900 | 同一气泡切到源码态，显示原始 Markdown | 内容完整、等宽对齐 |
| `ux-md-03-toolbar.png` | 1440×900 | 输入区上方格式按钮 + 附件 + 预览 | 排版整齐、未挤压输入框（此图为补表格按钮前所拍，布局一致） |
| `ux-md-04-preview.png` | 1440×900 | 预览态：H2 + 无序列表渲染，按钮变「编辑」 | textarea 隐藏但草稿保留 |
| `ux-md-05-drag.png` | 1440×900 | 拖拽高亮遮罩「松手即可上传（≤10 MB）」 | 遮罩覆盖正确 |
| `ux-md-06-code-copy.png` | 1440×900 | hover 代码块 → 复制按钮可见 → 点击回显 | 状态切换正常 |
| `ux-md-07-dark.png` | 1440×900 | 深色主题同一长消息 | 代码块深底浅字对比清晰 |
| `ux-md-08-mobile-msg.png` | 390×844 @2x | 手机消息页：链接、引用、粗体、列表 | 不溢出、无横向滚动 |
| `ux-md-09-mobile-composer.png` | 390×844 @2x | 手机输入态：工具条、发送键 44×44 | 发送键热区达标（此图为补做前所拍，工具条当时 32px；补做后 44×44 见 `ux-md-21/22`） |
| `ux-md-10-tablet.png` | 1024×800 | 窄桌面/平板布局 | 消息与输入区正常 |
| `ux-md-11-attachment.png` | 1440×900 | 图片消息气泡（缩略图 + 同气泡内 MD 正文）+ 我方文件卡片 + 加载失败自动降级文件卡片 | 缩略图正常出图、降级生效、卡片不溢出 |
| `ux-md-12-lightbox.png` | 1440×900 | 点缩略图后的 `AppModal` 灯箱 | 遮罩/居中/关闭正常 |
| `ux-md-13-upload-progress.png` | 1440×900 | 上传进度条（62% 填充 + 文件名 + `2.3 MB · 上传中 62%`） | 进度条与文案对齐 |
| `ux-md-14-drag-highlight.png` | 1440×900 | 拖拽态：`.composer--dragging` + `.composer__drop` 遮罩「松手即可上传（≤10 MB）」 | 遮罩覆盖整块输入区 |
| `ux-md-15-dark-attachment.png` | 1440×900 | 深色主题下的附件（实测 avgRGB=(24,30,37)、dark 像素 92.8%） | 对比度足够、卡片边界清晰 |
| `ux-md-16-mobile-attachment.png` | 390×844 @2x | 手机附件页 | `scrollWidth=390 = clientWidth` 无横向溢出 |
| `ux-md-17-narrow-320.png` | 320×568 @2x | 极窄视口 320 | `scrollWidth=320 = clientWidth` 无横向溢出，`pageerror` 0 条 |
| `ux-md-18-toolbar-table.png` | 1440×900 | 补做后：工具条 11 个按钮（含新增 ▦）+ 点「表格」插入 GFM 骨架后在预览态渲染出 2 列 3 行表格 | 表头/分隔行/单元格对齐正常，工具条未挤压输入框 |
| `ux-md-19-jump-bottom.png` | 1440×460 | 窄高视口滚到上方后，右下角出现 `.pane__jump` 浮动胶囊（↓ + 「4 条新消息」） | 不遮挡输入区、位于消息区右下角、点击回到底部后消失 |
| `ux-md-20-preview-persist.png` | 1440×900 | 预览态跨会话切换后仍保持预览（草稿文本 + 预览态双保留） | 切回会话仍显示预览表格与工具条高亮 |
| `ux-md-21-mobile-toolbar-collapsed.png` | 390×844 @2x | 手机端默认收起：只剩「Aa」开关 + 附件 + 预览 | 无横向溢出，Aa 开关 44×44 且 `aria-expanded=false` |
| `ux-md-22-mobile-toolbar-open.png` | 390×844 @2x | 点「Aa」展开：11 个格式按钮各 44×44 横向排列、可左右滚动 | `scrollWidth 494 > clientWidth 266` 可横滚、`documentElement` 无横向溢出 |

> **11~17 的拍摄条件必须说明**：这 7 张是**组件隔离演示**，不是真实会话链路。原因见 §十一 风险 1/2 —— 后端 `POST /api/v1/uploads` 当时尚未注册路由（返回 401），且 mock 层 `POST messages` 硬校验 `body.type !== 'text'` → 400，附件消息在真实会话里发不出去。于是临时建了一个演示页挂载 `AttachmentView.vue` / `MessageComposer.vue` / `MessageBubble.vue`，用 Playwright `page.route('**/api/v1/uploads/**')` 拦截返回真实 PNG 字节，从而验证「blob 鉴权取图 → objectURL → `<img>`」「加载失败降级」「进度条」「拖拽遮罩」「深色」「窄屏不溢出」这些**组件自身行为**。演示页与临时脚本在截完后已全部删除（`ls -a frontend/ | grep '^\.tmp-\|^uxmd-demo'` → 空）。**待 ux-api 上传路由落地后，需要补一次真实会话内的端到端附件回归。**

> **18~22 的拍摄条件**：这 5 张是补做 4 项缺口后重新拍的，**全部在真实应用里**（`http://localhost:5173` 登录后进入真实会话），不是隔离演示页。其中 18/19 为桌面视口（19 用 1440×460 窄高视口才能让内容可滚、复现「离开底部」状态），20 是切会话验证预览态保留，21/22 为 390×844 @2x 手机视口。

---

## 八、自检四项输出（真实执行）

### 8.1 类型检查

```bash
cd frontend && node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
# exit 0，0 条 error
```

### 8.2 单测

```bash
cd frontend && node node_modules/vitest/vitest.mjs run
# Test Files  11 passed (11)
# Tests  172 passed (172)
# Duration  841ms   （末次复跑；历次在 648~841ms 区间，条数一致）
```

分文件：

```
✓ src/utils/dialogA11y.test.ts (19 tests)
✓ src/api/normalize.test.ts (27 tests)
✓ src/components/message/markdownEditing.test.ts (27 tests)   ← 本轮新增（含 6 条 tableMarkdown）
✓ src/utils/attachments.test.ts (18 tests)                    ← 本轮新增
✓ src/ws/schema.eval-probe.test.ts (1 test)
✓ src/ws/schema.test.ts (3 tests)
✓ src/utils/markdown.test.ts (60 tests)                       ← 本轮新增
✓ src/api/http.test.ts (5 tests)
✓ src/ws/client.test.ts (4 tests)
✓ src/stores/message.test.ts (4 tests)
✓ src/stores/conversation.test.ts (4 tests)
```

> 基线口径：本轮开工时全量 **8 文件 / 67 条全绿**（与任务书给的口径一致）。本轮新增 3 个测试文件共 **105 条**：`markdown.test.ts` 60 + `markdownEditing.test.ts` 27 + `attachments.test.ts` 18。**67 + 105 = 172**，与 vitest 汇总吻合，基线一条未破。
>
> 其中 `markdownEditing.test.ts` 的 6 条 `tableMarkdown` 用例是交付后自查补做时新增的，覆盖：空选区精确骨架、选区首行成为表头、多行逐行成行、**已是表格不重复插入**、行尾整行替换不留半截、产物能被真实 `renderMarkdown` 渲染成 `<table class="md-table">`。

### 8.3 构建

```bash
cd frontend && node node_modules/vite/bin/vite.js build
# ✓ built in 876ms   exit 0   （历次复跑 597~944ms；补做后产物哈希变化）
# dist/assets/MessagePane-BSRpqthd.js   40.46 kB │ gzip: 14.66 kB   ← 补浮动入口后变大
# dist/assets/messages-vOl69FIs.js      55.29 kB │ gzip: 20.66 kB
# dist/assets/index-CaaLdBw9.js         36.00 kB │ gzip: 14.64 kB
# dist/assets/auth-Dk7XzIHj.js         130.08 kB │ gzip: 41.41 kB
```

### 8.4 变异验证

见 §4.3，三步齐全：改坏 → 5 红 → 还原 → 60 绿（全量 172 绿）。

---

## 九、真机结构断言（30/30 PASS）

用真机 Chrome 在完整应用里跑的 DOM 级断言（不是单测，是端到端结构验证）：

```
PASS H1 渲染 — 标题一
PASS bold — 粗              PASS italic — 斜        PASS strike — 删
PASS inline code — code
PASS 站内链接 href — {"href":"/chat","target":"_blank","rel":"noopener noreferrer nofollow"}
PASS 外链 target/rel — {"href":"https://example.com/x","target":"_blank","rel":"noopener noreferrer nofollow"}
PASS quote — 引用行         PASS ul + 嵌套 ul — nested=1    PASS ol    PASS hr
PASS 代码块语言徽标 — ts    PASS 代码块复制按钮
PASS 表格 1 行 tbody — rows=1
PASS 无原始标签透传         PASS ** 未漏成字面量
PASS 源码模式可见且保留原文 PASS 切回渲染模式
PASS 代码块复制后按钮回显 done — count=1
PASS 拖拽高亮 class         PASS 拖拽遮罩可见
PASS 预览态渲染 h2          PASS 预览态 textarea 隐藏但保留 DOM
PASS 工具条加粗包裹选区 — **加粗我**
PASS 深色主题生效 — rgb(11, 15, 20)
PASS 无 pageerror           PASS 移动端无横向溢出 — overflowX=0
PASS 移动端发送键 44px 热区 — 44x44 / 工具条按钮 ≥32px — h=32
PASS 移动端输入字号 16px 防缩放 — 16px
=== 30/30 PASS ===
```

> 注：上表「工具条按钮 ≥32px — h=32」是补做前的水平。补做后工具条按钮为 44×44（见 §9.1）。

### 9.1 补做 4 项缺口后的新增断言（19/19 PASS）

交付后按任务书逐条复核，发现 4 处规格缺口（工具条缺表格按钮、手机端工具条不达标、缺「↓ 新消息」浮动提示、预览态未随草稿保留），补做后用同一套真机 Chrome 脚本重新验证：

```
PASS 桌面工具条 11 个格式按钮 — count=11 ["B","I","S","</>","```","❝","•—","1.","🔗","▦","H2"]
PASS 含表格按钮                          PASS 桌面不显示 Aa 开关
PASS 表格按钮插入 GFM 骨架                PASS 预览态渲染出 table
PASS 预览态随草稿保留（切会话再切回仍在预览）
PASS 预览态下 textarea 隐藏但保留在 DOM    PASS 预览态下 textarea 仍在 DOM 且带草稿
PASS 会话内容可滚动（浮动入口前提） — scrollable=974
PASS 离开底部出现「↓」浮动入口            PASS 点击后回到底部并隐藏浮动入口
PASS 手机工具条默认收起（格式按钮不可见）  PASS 手机显示 Aa 开关
PASS 手机展开后按钮 44×44 — 44x44
PASS 手机展开后按钮组横向滚动不溢出 — w=266 <= 390
PASS 手机展开后 overflow-x: auto — {"overflowX":"auto","scrollW":494,"clientW":266}
PASS 手机展开后按钮组内容可横滚（scrollWidth > clientWidth） — 494 > 266
PASS 手机展开后可实际横向滚动 — scrollLeft=200
PASS 手机无横向溢出 — overflowX=0
PAGEERRORS none
=== 19/19 PASS ===
```

补做实现要点：

- **表格命令**：`frontend/src/components/message/markdownEditing.ts` 新增 `tableMarkdown()`，空选区插骨架、有内容首行作表头、已存在表格则原样返回（防连点炸两张表）。踩坑：取第二行必须用 `text.indexOf('\\n', to + 1)`，若用 `to` 会取到本行换行符，导致「已有表格」判定永远为真。
- **手机端工具条**：`frontend/src/components/message/ComposerToolbar.vue` 新增 `open` 状态与「Aa」开关（`.cbar__btn--toggle`，桌面 `display:none`），手机段 `.cbar__group{display:none}` 默认收起，`.cbar--open .cbar__group{display:flex;overflow-x:auto}`；按钮提到 `min-width:44px;height:44px`。
- **↓ 新消息**：`frontend/src/views/MessagePane.vue` 新增 `unseen` 计数与 `jumpToBottom()`；`watch(messages.length)` 在非贴底时累加新增条数而不强行拽回底部。`.pane` 用 `position:relative` + `.pane__jump{position:absolute;bottom:76px}`（不用 `fixed`，避免手机软键盘/安全区把它推歪）。
- **预览态随草稿**：`frontend/src/components/message/MessageComposer.vue` 用模块级 `previewByConv: Map<string, boolean>` 记录每会话预览态，切会话时连同 `ui.setDraft` 一起保存/恢复；空草稿不恢复预览（避免一片空白）。未改动 `frontend/src/stores/ui.ts`（`drafts` 只能存 string），取舍记录在此。

---

## 十、附件前端实现要点

1. **token 绝不进 URL。** `GET /api/v1/uploads/:id` 必须带 `Authorization: Bearer`，所以图片**不能**写 `<img src="/api/v1/uploads/xxx">`（会 401）。实现走 `fetchAttachmentBlob()`（`responseType: 'blob'`）→ `URL.createObjectURL(blob)` → 赋给 `img.src`，组件卸载时 `revokeObjectURL` 释放。
2. **复用 `http` 实例**，Bearer 注入、401 续期、`__authTokenSnapshot` 代际守卫、`terminalNotified` 去重全部由 `frontend/src/api/http.ts` 统一管——本轮没有改动它的任何一行守卫。
3. **前端预检 10 MiB**，超限不发请求，直接 toast「文件超过 10.0 MB」；空文件拦 `EMPTY_FILE`。
4. **取消**：`AbortController` + `signal` 透传到 axios；切会话时 `abort()` 并复位进度。
5. **失败降级**：图片加载失败（403/404/网络）→ `failed=true` → 自动降级成文件卡片，不出现破图。
6. **拖拽/粘贴**：`dragenter/dragover/drop` 带计数器防抖，`dragover` 必须 `preventDefault()` 才允许 drop；`paste` 事件拦截剪贴板图片直接上传。
7. **手机端**：发送键 44×44、工具条按钮 44×44（默认收起为「Aa」，展开后可横向滚动）、输入字号 16px（防 iOS 聚焦自动缩放）、附件项 `min-height: 44px`。

---

## 十一、未做 / 风险

| # | 项 | 说明 | 谁能解 |
| --- | --- | --- | --- |
| 1 | **后端上传路由尚未注册到 HTTP 层** | 截至本文件定稿，ux-api 已写好 `backend/src/upload.ts`（魔数嗅探/落盘/sha256），`backend/src/config.ts`、`db.ts`、`schemas.ts`（已定义 `Attachment` 并把 `Message.attachment` 设为 `Union([Attachment, Null()])`）、`service.ts`（`attachment_id` 列 + `attachmentView()`/`attachment()` 回填）也都接上了；但 `backend/src/routes.ts` 里**还没有 `POST/GET/DELETE /api/v1/uploads` 的路由注册**，发送消息的 body schema 也仍是旧的 `{ clientMsgId, type: Literal('text'), content }`（`additionalProperties: false`，传 `attachmentId` 会被 400）。实测 `POST http://127.0.0.1:3099/api/v1/uploads?filename=x.png` → **401**。因此**附件的端到端真机验证（真实上传→发消息→WS 广播→对方看到图片）本轮无法完成**，只验证到前端层（单测 + 组件隔离渲染 + 类型契约）。**待 ux-api 注册路由后需补一次端到端回归。** | ux-api（task-6） |
| 2 | **mock 层不支持附件** | `frontend/mocks/rest/handlers.ts:570` 的 POST messages 硬校验 `body.type !== 'text'` → 400；`frontend/mocks/fixtures/db.ts:21-30` 的 `MockMessage` 无 `attachment` 字段。所以 dev mock 模式下演示不了附件消息。`mocks/` 未列入任何 agent 的所有权，本轮**未改动**（e2e 依赖它，擅动风险高）。 | 需要单独授权 |
| 3 | **CSP `img-src` 需加 `blob:`** | `backend/src/app.ts` 的 `CONTENT_SECURITY_POLICY` 当前 `img-src 'self' data:`。dev 由 vite 供 HTML 无 CSP 所以能显示；**生产环境不加 `blob:` 图片会全挂**。task-6 已列入。 | ux-api |
| 4 | 代码高亮 | 按要求**不引高亮库**，只做语言徽标 + 深色底 + 复制。若后续要着色需重新评估包体积与 CSP。 | 后续迭代 |
| 5 | 图片懒加载 | 图片消息一次取一张 blob；会话很长时可能有较多并发请求。当前没有虚拟滚动，暂未做 `IntersectionObserver` 懒加载。 | 后续迭代 |
| 6 | MD 图片语法 `![]()` | 有意不支持（理由见 §三）。如需，必须走上传接口而非任意 URL。 | 设计决策，非缺陷 |
| 7 | 移动端键盘遮挡 | 手机端输入区用 `--safe-bottom` 安全区适配，但未在真机 iOS Safari 上按键盘弹出实测（本轮只有 Chrome 桌面模拟视口）。 | 需要真机 |
| 8 | 交付后自查补做的 4 项（已修，记录在此以便复核） | 任务书 §三/§五 明确要求但首版未做到的 4 处：①工具条缺「表格」按钮；②手机端工具条未达「横向滚动 + 44×44 + 默认收起 Aa」；③消息区缺「↓ 新消息」浮动提示；④预览态未随草稿保留。已在补做中全部实现并加断言（§9.1），测试 166 → 172、截图 17 → 22 张。 | 已完成 |

---

## 十二、验证命令速查

```bash
cd /b/AITrance/frontend

# 类型检查
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit

# 单测（应 11 files / 172 tests 全绿）
node node_modules/vitest/vitest.mjs run

# 单跑渲染器
node node_modules/vitest/vitest.mjs run src/utils/markdown.test.ts

# 构建
node node_modules/vite/bin/vite.js build

# v-html 审计（应输出 0）
grep -rnE "v-html\s*=|v-html>|inner-html" src/ | grep -v "^\s*\*" | wc -l
```

> 注：本环境 npm/npx 不可直接调用（`'"node"' 不是内部或外部命令`），必须用 `node node_modules/<pkg>/bin/<cli>.js` 的形式。
