# UX2 前端 · 消息域证据（task-10）

> 范围：`frontend/src/components/message/**`、`components/layout/**`、`views/MessagePane.vue`、`views/ChatView.vue`、`api/{pins,uploads,normalize,wire,messages,conversations,auth.types}.ts`、`stores/{pins,message,conversation}.ts`、`types/domain.ts`、`ws/{schema,handlers}.ts`、`components/base/AppModal.vue`。
> 未触碰：`styles/`、`components/base/AppAvatar.vue`、`router/`、`api/admin.ts`、`stores/admin.ts`、`views/{Admin,Profile,ConversationInfo,Login,Register,ChatEmpty,NotFound}View.vue`、`backend/`、`contracts/`、`management/`。

---

## 1. 结论速览

门禁由 Lead 亲跑确认全绿：`vue-tsc --noEmit` exit 0、`vitest run` **14 files / 243 tests** 全过（基线 172，净增 71）、`vite build` `✓ built in 923ms` exit 0。

本轮 6 项交付：① P0 气泡按钮遮挡正文（交互模型整体换掉）② 附件 `kind==='image'` 一律缩略图 ③ 图片/文件双入口 ④ User 扩 `uid/role/status/mutedUntil` + normalize 支持 admin ⑤ 消息置顶（3 接口 + WS 全量广播 + 置顶条）⑥ 单测与真浏览器证据。

真浏览器验证：Playwright × 真 Chrome（`channel:'chrome'`）跑了 **24 项断言，24/24 PASS**，其中 390×844 与 320×568 两个窄屏视口下「气泡正文被遮挡采样点数 = 0」为直接实测（见 §3.2）。

---

## 2. 改动清单

| 文件 | 行数 | 新建/修改 | 作用 |
| --- | --- | --- | --- |
| `src/components/message/MessageBubble.vue` | 753 | 重写 | P0 核心：工具条移出气泡成为 `.bubble-wrap` 内兄弟节点；手机段 `display:none` + 长按菜单；置顶态小图标；保留全部既有类名与安全硬规则注释 |
| `src/components/message/MessageComposer.vue` | 790 | 修改 | 双 `input[type=file]`（图片 / 文件）、`pickImage`/`pickFile`、待发送区图片缩略图、上传进度/取消/移除、拖拽、预览态随草稿保留 |
| `src/components/message/ComposerToolbar.vue` | 380 | 修改 | 拆出「图片」按钮，原「附件」改为纯文件入口（回形针图标），`pickImage`/`pickFile` 两个 emit |
| `src/components/message/AttachmentView.vue` | 481 | 修改 | `showAsImage = isImage`（kind==='image' 永远缩略图，不再因加载失败降级成文件卡片）；失败态留在缩略图位并给「重试」 |
| `src/components/message/messageMenu.ts` | 120 | 新建 | 长按/菜单纯逻辑：`createLongPress`、`shouldOpenMessageMenu`、`messageMenuItems`（无 DOM、node 可测） |
| `src/components/message/messageMenu.test.ts` | 175 | 新建 | 长按判定与菜单项 14 条单测 |
| `src/components/message/MarkdownView.vue` | 326 | 既有（task-7） | Markdown → VNode 渲染承载组件，本轮沿用 |
| `src/components/message/MarkdownNodes.ts` | 22 | 既有（task-7） | VNode 数组挂载器（模板插值会变 `[object Object]`，必须渲染函数） |
| `src/components/message/markdownEditing.ts` | 278 | 既有（task-7） | 编辑器命令（含表格） |
| `src/components/message/composer.ts` | 17 | 既有（task-7） | `ComposerSendPayload` 类型（`<script setup>` 不能顶层 export） |
| `src/components/layout/ConversationItem.vue` | 199 | 修改 | 会话预览支持 `[图片]`/`[文件]` 前缀 |
| `src/components/layout/{ConversationList,ContactPanel,AppRail,MobileNav}.vue` | 149 / 377 / 141 / 328 | 未改 | 本轮仅确认未被破坏 |
| `src/views/MessagePane.vue` | 1067 | 修改 | 置顶条（`pane__pins`/`pane__pins-head`/`aria-expanded`/条目/取消）、点击跳转 `data-msg-id` + 高亮、`pin/unpin` 错误分支 toast、进入会话时 `pinsStore.ensureLoaded` |
| `src/views/ChatView.vue` | 344 | 未改 | 本轮仅确认未被破坏 |
| `src/api/pins.ts` | 60 | 新建 | `listPins` / `pinMessage`（body `{msgId}`）/ `unpinMessage`（`:msgId` 是消息 UUID） |
| `src/stores/pins.ts` | 209 | 新建 | 按会话存 `PinnedMessage[]`，epoch 代际保护，`ensureLoaded`/`pin`/`unpin`（乐观）/`applyFromWs`/`dropConv`/`reset` |
| `src/stores/pins.test.ts` | 264 | 新建 | `ensureLoaded`/`pin`/`unpin`/`applyFromWs`/代际隔离/`dropConv` 等 19 条 |
| `src/stores/message.ts` | 385 | 修改 | `normalizeWire` 透传 `attachment`；`appendOptimistic` 支持可选 `attachment` 并推导 type |
| `src/stores/conversation.ts` | 290 | 未改 | 本轮仅确认未被破坏 |
| `src/api/normalize.ts` | 293 | 修改 | `toUserBrief` 只在字段存在时赋值；`toUser` 补齐 uid/role/status/mutedUntil；新增 `isMutedNow`、`toPinnedMessage` |
| `src/api/wire.ts` | 204 | 修改 | `WireUser` 加 ux2 四字段；新增 `WireUserLike`、`WirePinnedMessage`、`WirePinsPage`；成员/`myRole` 扩 admin |
| `src/api/messages.ts` | 88 | 修改 | `SendMessageInput` 支持 `attachmentId`（灰度：纯文本仍带 `type:'text'`） |
| `src/api/conversations.ts` | 90 | 未改 | 本轮仅确认未被破坏 |
| `src/api/auth.types.ts` | 19 | 修改 | `User` 加 `uid/role/status/mutedUntil` |
| `src/api/normalize.test.ts` | 462 | 修改 | 27 → 46 条（ux2 User 字段 / `isMutedNow` / `toPinnedMessage` / role·type 扩展） |
| `src/types/domain.ts` | 236 | 修改 | `UserRole`/`UserStatus`、`UserBrief` 可选 ux2 字段、`PinnedMessage` |
| `src/ws/schema.ts` | 260 | 修改 | `zUser` 加可选 ux2 字段；`zPinnedMessage`、`zConversationPinsData`、`S2C.CONVERSATION_PINS` |
| `src/ws/handlers.ts` | 423 | 修改 | `conversation.pins` 分支 → `pinsStore.applyFromWs`；会话被移除时 `dropConv` |
| `src/components/base/AppModal.vue` | 334 | 未改 | 手机长按菜单直接复用它（其自身在手机端已呈现为底部 sheet） |

---

## 3. P0：气泡按钮遮挡正文

### 3.1 旧实现 → 新方案

旧实现（问题根因）：

```css
.bubble { position: relative; }
.bubble__tools { position: absolute; top: -10px; z-index: 2; opacity: 0; }
.bubble--mine .bubble__tools { right: 4px; }   /* 压在气泡右上角 */
.bubble--peer .bubble__tools { left: 4px; }    /* 压在气泡左上角 */
@media (max-width: 767px) {
  .bubble__tools { opacity: .92; pointer-events: auto; top: -12px; } /* 手机常显 → 一直压字 */
}
```

新方案：

- **桌面**：`.bubble__tools` 从 `.bubble` 内部移出，成为新增 `.bubble-wrap`（`display:flex; gap:6px; align-items:flex-end`）里 `.bubble` 的**兄弟节点**，`position: static`，靠 flex 排到气泡外侧；`line--mine` 时 `flex-direction: row-reverse` 让工具条落到左侧外侧。显隐仍用 `opacity/pointer-events` + `.bubble-wrap:hover` / `:focus-within`，但因为不定位、不重叠，展开时也不会压住正文。
- **手机（≤767px）**：`.bubble__tools { display: none }`（不是 `opacity:0`——`opacity:0` 仍占位且可能被误触），改为 `@touchstart.passive="onTouchStart"` 起 500ms 计时，`touchend/touchmove/touchcancel` 取消；`@contextmenu.prevent` 兜底；命中后 `AppModal` 弹底部操作菜单（复制正文 / 看 Markdown 源码 / 置顶 / 取消）。判定逻辑全部在纯函数 `messageMenu.ts`（有 14 条单测），组件只做接线。

### 3.2 窄屏实测证据（真 Chrome，非估算）

脚本在真实应用（`http://localhost:5173`）里登录后进入真实会话，用 `getBoundingClientRect()` 判矩形相交、用 `getComputedStyle` 判工具条可见性、用 `document.elementFromPoint()` 在气泡矩形四角+中心取 4 点判「是否被非气泡元素覆盖」：

```
PASS 工具条不再绝对定位 — position=static
PASS 工具条与气泡矩形不相交（不压正文） — bubble=[1067,1422] tools=[979,1061]
PASS 桌面不 hover 时工具条不可见（opacity=0） — opacity=0
PASS hover 后工具条可见 — opacity=1
PASS [390] 手机端无悬浮工具条 — {"width":232,"height":110,"visibleToolCount":0,"coveredPoints":0,"scrollOverflow":0}
PASS [390] 气泡正文未被任何元素遮挡 — covered=0
PASS [390] 无横向溢出 — overflowX=0
PASS [320] 手机端无悬浮工具条 — {"width":225,"height":131,"visibleToolCount":0,"coveredPoints":0,"scrollOverflow":0}
PASS [320] 气泡正文未被任何元素遮挡 — covered=0
PASS [320] 无横向溢出 — overflowX=0
PASS [390] 长按 500ms 弹出操作菜单 — ["复制正文纯文本","看 Markdown 源码源码","置顶消息在会话顶部固定","取消"]
PASS [320] 长按 500ms 弹出操作菜单 — ["复制正文纯文本","看 Markdown 源码源码","置顶消息在会话顶部固定","取消"]
=== 24/24 PASS ===
```

截图（`docs/evidence/`，均已逐张打开目视确认）：

| 文件 | 说明 |
| --- | --- |
| `ux2-01-desktop-rest.png` | 桌面常态，气泡上无任何按钮 |
| `ux2-02-desktop-hover-tools.png` | 桌面 hover，工具条落在气泡**外侧**（bubble 1067–1422 / tools 979–1061，无重叠） |
| `ux2-06-mobile-390-message.png` | 390×844，气泡 232×110，三行正文完整可见，无悬浮按钮 |
| `ux2-07-mobile-320-longpress-menu.png` | 320×568，长按 500ms 弹出底部操作菜单，气泡 225×131 正文完整 |
| `ux2-03-desktop-pinbar.png` | 置顶条展开（2 条） |
| `ux2-04-desktop-dual-entry.png` | 工具条右侧「图片」「文件」两个独立按钮 |
| `ux2-05-desktop-pending-thumb.png` | 图片上传后待发送区 40px 缩略图（`blob:` URL） |

> 说明：桌面 hover 时工具条在气泡左侧（`tools=[979,1061]` 结束于 `bubble` 起点 1067 之前），间距 6px。这是 `.bubble-wrap` 的 flex 顺序决定的方向。

### 3.3 脚本层面踩过的坑（记录，避免后人重踩）

拿 mock 环境（`VITE_USE_MOCK=true`）做真浏览器验证时，`GET /api/v1/conversations/:id/pins` 会被 MSW 的 Service Worker 直接 pass-through 到真后端（mock 层无 pins handler），带 mock token 得到 401 → `api/http.ts` 终态登出 → 页面被踢到 `/login?next=/chat/c_e`，`.composer__input` 永不出现。

两种拦截方式都无效：`page.route()` 看不见 SW 内部 pass-through 的请求；改 `window.fetch` 也没用，因为 **axios 在浏览器里走 XHR**。最终办法是 `ctx.addInitScript()` 在主世界替换 `XMLHttpRequest`，只伪造 `/pins` 与 `/api/v1/uploads` 两条路径，其余（含登录 refresh）原样委托真 XHR。**零产品源码改动。**

---

## 4. 图片/文件双入口 + 一律缩略图

- 两个独立入口：`ComposerToolbar` 的 `pickImage` / `pickFile` 各自一个按钮，`MessageComposer` 里对应两个 hidden `input[type=file]`——
  - 图片：`accept="image/png,image/jpeg,image/webp,image/gif"`，**不加 `capture`**（加了会把手机锁死在相机，用户无法选集相册）。
  - 文件：不设 `accept`，由后端白名单决定成败。
  - 实测断言：`图片 input 的 accept 只列图片 — ["image/png,image/jpeg,image/webp,image/gif",null]`、`文件 input 不限制 accept`、`两个入口是不同按钮`。
- 渲染规则统一：**只要 `attachment.kind === 'image'` 就一律渲染缩略图**，与从哪个入口上传无关。`AttachmentView` 里 `showAsImage` 由 `isImage && !failed` 改为 `isImage`。
- **403 不再降级成文件卡片**：旧实现把「加载失败」伪装成「这是个文件」，把后端权限 bug 变成前端选择。现在加载失败仍留在缩略图位，显示 `att__thumb-skeleton--failed`「图片加载失败」+ `att__retry`「重试」按钮，用户能看出这是图片、且能自助重试。
- 待发送区：`composer__att-thumb` 40×40 缩略图（`fetchObjectUrl` → `blob:` URL，组件卸载/替换时 `revokeObjectUrl`），实测 `{"src":"blob:","w":38}`。

---

## 5. 消息置顶

接口（按 `docs/contract/ux2-contract.md` §九 实现，`src/api/pins.ts`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/conversations/:conversationId/pins` | 返回 `{items: PinnedMessage[]}`，`pinned_at DESC` |
| POST | `.../pins` | body `{msgId}`（消息 UUID，不是 seq）；新建 201、重复置顶幂等 200 返回原记录；`INVALID_MESSAGE` 400、`PIN_LIMIT` 409（上限 50） |
| DELETE | `.../pins/:msgId` | `:msgId` 是消息 UUID；`PIN_NOT_FOUND` 404；成功 204 |

WS 广播：`{ type: 'conversation.pins', data: { conversationId, pins: PinnedMessage[] } }` —— 服务端推**完整列表**，前端 `pinsStore.applyFromWs` 整体替换、不做增量合并（避免顺序靠猜）。会话被移除时 `dropConv` 清掉该会话置顶缓存。`zUser` 的 ux2 四字段设为 `.optional()`，避免灰度期缺字段导致整帧 `safeParse` 失败、消息不显示。

置顶条交互（`views/MessagePane.vue`）：
- 头部 `pane__pins-head`（图钉 + 「置顶消息（N）」+ 旋转箭头，`aria-expanded`），展开后 `pane__pins-list` 列出置顶：发送人 + 正文摘要（正文压缩空白；无正文时 `[图片]` / `[文件] name`；两者都无 `（无正文）`）。
- 点击条目 `jumpToPinned(pin)` → `querySelector('[data-msg-id="…"]')` → 找不到先 `ensureLoaded` 再重试 → `scrollIntoView({block:'center'})` + `pane__row--flash` 高亮 1.6s。
- 每条右侧 `pane__pin-x` 可取消置顶。
- 长按菜单 / 桌面 hover 工具条里的图钉按钮 emit `pin`/`unpin`，由 `MessagePane.onPin/onUnpin` 处理；乐观消息（`status !== 'sent'`）拒绝置顶并 toast「消息尚未发送成功，不能置顶」；错误分支：`PIN_LIMIT`→「置顶已满 50 条，请先取消一条」、`INVALID_MESSAGE`→「这条消息已不存在，无法置顶」。
- 实测断言：`置顶条渲染出条目 — items=2 head=置顶消息（2）`、`点开后置顶列表可见 — display=block`、`置顶头 aria-expanded 正确 — aria=true`。

---

## 6. 未验 / 风险（诚实清单）

1. **置顶端到端未验**：`grep -n pins backend/src/routes.ts` 目前 0 命中，后端三端点尚未注册。本轮置顶 UI 全部靠 XHR 垫片伪造的 GET 200 / POST 201 / DELETE 204 验证，**真实后端联调未做**。后端上线后需补一次真实会话回归（含 50 条上限与 `PIN_LIMIT`）。
2. **mock 模式会 401 踢下线（生产不复现）**：`frontend/mocks/rest/handlers.ts` 里 pins handler 数量为 0，请求穿透到真后端携带 mock token → 401 → 终态登出。生产环境后端路由存在 + 真实 token 不会触发；但开发/演示时任何打开会话的动作都会被踢回登录页。建议后端 pins 路由上线，或在 mock 层补 pins handler（mocks/ 不在本任务写作用域，未改动）。
3. **移动端遮挡已在真浏览器（Playwright + 真 Chrome，390/320 视口）验证为 0 覆盖**，但**未在真机触屏**（iOS Safari / Android Chrome）上验证长按手感：真机的系统文本选择菜单、`touch-callout`、长按拖拽可能干扰 500ms 定时器；脚本是用 `TouchEvent('touchstart')` 派发的。这一项建议交 verify-browser（task-12）在真机或更真实的触屏模拟下复核。
4. **附件跨用户可见性依赖后端 task-9 的 `readUpload` 修复**（同会话成员可读）。前端只按契约实现「`kind==='image'` 一律缩略图」，若后端权限回退，前端表现为「图片加载失败 + 重试」而不是静默降级，但图片本身仍不可见。
5. **生产 CSP `img-src` 需含 `blob:`**：缩略图走 `URL.createObjectURL`，若后端 CSP 未加 `blob:`，生产环境图片不显示（dev 无 CSP 所以本地看不出来）。
6. `messageMenu.ts` 的 14 条单测覆盖判定与菜单项，但**长按计时器在真机的时序**（快速滑动期间误触发 / 页面滚动冲突）未单独验证。
7. 本轮未改动 `components/base/AppModal.vue`：手机长按菜单直接复用它，其手机端既有底部 sheet 形态满足需求；若视觉 agent 后续改了它的手机形态，长按菜单外观会随之变化（行为不受影响）。
