# AITrance v2 前端约定（agent 间唯一事实来源）

配合 `docs/v2/API-V2.md` 阅读。**路由与外壳（`router/index.ts`、`views/ChatView.vue`、
`components/base/AppIcon.vue`）由 Lead 负责**，其他 agent 不要改这三个文件。

## 1. 新路由（Lead 已加）

| name | path | 组件 | 说明 |
|---|---|---|---|
| `square` | `/chat/square` | `views/SquareView.vue` | 广场（fe-square） |
| `user-profile` | `/chat/user/:userId` | `views/UserProfileView.vue` | 访客资料页（fe-account） |
| `profile` | `/chat/profile` | `views/ProfileView.vue` | 本人详细资料（已有，fe-account 改造） |

静态段必须排在 `:convId` 之前 —— Lead 负责，其他 agent 只消费。

## 2. 主题系统（fe-account）

- `document.documentElement.dataset.theme` = 主题 id：`light | dark | ocean | forest | sakura | midnight | custom`
  （5 套预置 + 1 自定义；`light`/`dark` 保留原名以兼容旧 localStorage 与既有 e2e）。
- `document.documentElement.dataset.themeMode` = `light | dark`。既有 dark 覆盖规则与
  Tailwind `dark:` 变体一律改用 `[data-theme-mode='dark']`，**不再依赖 `[data-theme='dark']`**
  （`styles/main.css` 第 6 行的 `@custom-variant` 与 4 处组件内 `:root[data-theme='dark']` 覆盖要一起改）。
- 每个预置主题在 `styles/theme.css` 里同时覆盖：
  - 品牌色阶 `--color-brand-50..900`、`--color-accent-300..700`（Tailwind v4 的工具类编译成
    `var(--color-brand-500)`，因此改这些变量即可全站换色，不必改 87 处 `brand-` 类名）；
  - 语义面 `--app-*`、气泡 `--bubble-*`、`--chat-canvas`、`--gradient-brand`、`--shadow-brand`。
- 自定义主题：`localStorage['aitrance.theme.custom']` 存 JSON，字段
  `{primary, chatCanvas, bubbleSelfBg, bubbleSelfText, bubblePeerBg, bubblePeerText, panelBg, textColor, bgMode:'solid'|'gradient'|'image', bgValue2?, imageUrl?}`。
  `applyTheme()` 在 `data-theme='custom'` 时把上述值写成 `documentElement.style` 内联 CSS 变量。
- 主题选择面板组件：`components/theme/ThemePicker.vue`（fe-account 新建），
  供 ProfileView 与移动端个人页复用。

## 3. 个人信息入口（fe-account）

- 桌面：`AppRail` 顶部头像**必须传 `:src`**（当前 bug 根因），点击打开
  `components/profile/ProfileDrawer.vue` —— 抽屉覆盖「联系人/会话列表」整列宽度
  （`--spacing-sidebar` = 288px，平板 248px），内含头像/昵称/UID/签名/在线状态 +
  「详细资料」「主题」「退出登录（二次确认）」三个入口。
- 移动端：`MobileNav` 第三位由「更多」改为「个人信息」，点击弹底部上拉抽屉（`brief`）；
  抽屉顶部有拖拽把手，向上拖过 88vh 后切换为 `full` 态，渲染详细资料内容（复用 ProfileView 的内容块）。
- 「退出登录」必须二次确认（`AppModal`），并清空 auth/ui store。

## 4. 广场入口（Lead + fe-account）

- 桌面：`AppRail` 中间图标区新增第三个 tab（`AppIcon name="compass"`），路由 name `square`。
- 移动端：`ChatView` 列表屏顶部横条新增「广场」按钮（Lead 负责）。
- `SquareView.vue` 自身不再放返回按钮处的额外导航。

## 5. 消息渲染（fe-msg）

- `Message.attachments: Attachment[]`（**单数 `attachment` 已删除**）。空数组 = 无附件。
- 附件九宫格：1 张时大图（最大 260px），2–4 张两列，5–9 张三列；视频用 `<video controls preload="metadata">`。
- 视频/图片 URL 必须经 `fetchObjectUrl` 拿 blob URL（同 `api/uploads.ts` 既有纪律），不得把 token 拼进 URL。
- 撤回：`recalled=true` 时渲染「XXX 撤回了一条消息」占位，不渲染正文与附件。
- 引用回复：`replyTo` 非空时气泡顶部渲染引用条（`senderName：preview`，点击滚动定位到原消息）。
- 输入框：正文与附件互不依赖 —— 可只发附件、也可图文同条；只有「既无正文又无附件」时按钮 disabled。有附件时 Enter 不发送（防误发，必须点发送按钮或 Ctrl/⌘+Enter）。

## 6. 表情包（v2.4）

- 新增接口层 `frontend/src/api/stickers.ts`：`Sticker`、`normalizeSticker()`、`isStickerMime()`、
  **`stickerToAttachment(sticker): Attachment`（id 取 `uploadId`）**、`listStickers` / `addSticker` / `deleteSticker`。
- `frontend/src/stores/sticker.ts`：epoch 代际保护（不依赖 `auth.ts` 挂 reset），对外
  `ensureLoaded(force)` / `refresh()` / `add(uploadId)` / `remove(id)` / `resetFor(userId)` / `hasUpload()` / `findById()`。
- 面板 `components/message/StickerPanel.vue`（`section.sp[aria-label="表情包"]`）：桌面 4 列 / ≤767px 5 列，
  每格 1:1 `object-fit: contain`、≤360×320；每格删除按钮 `aria-label="删除表情 <name>"`（AppModal 二次确认）；
  图片一律走 blob URL（按 `uploadId` 缓存 + `onUnmounted` 全 revoke），**不得直接塞 `<img src>`**。
- 工具条 `ComposerToolbar.vue` 新增 `.cbar__btn--sticker`（`aria-label` 在「表情包」/「收起表情包」间切换，
  `aria-expanded`、手机 44×44），emit **`toggleStickers`**（开/关语义）。
- 点表情 → `emit('send', {content:'', attachments:[stickerToAttachment(s)], replyToMsgId:null})`，
  走既有发送通道，不绕过 `buildSendInput`；失败 toast 且面板保持打开；切会话自动收面板。
- 保存入口：桌面气泡悬浮工具条 `button[aria-label="存为表情"]` + 长按 sheet `save-sticker` 项 +
  桌面右键菜单 `save-sticker` 项。判定 = 消息带至少一个 png/jpeg/webp/gif 图片附件。

## 7. 项目自有右键菜单（v2.4）

- 纯逻辑层 `frontend/src/utils/contextMenu.ts`：`ContextMenuItem`、`clampMenuPosition()`、
  `shouldKeepNativeMenu()`、`visibleMenuItems()`、`hasVisibleMenuItems()`、`copyTextToClipboard()`（转调 clipboard 工具）。
- store：`ui.contextMenu`、`ui.openContextMenu(x, y, items)`、`ui.closeContextMenu()`。
- 渲染单例 `components/base/AppContextMenu.vue`，挂在 `App.vue`：
  `.ctx-menu[role="menu"][aria-label="操作菜单"]`，项 `button.ctx-menu__item[role="menuitem"][data-id]`，
  危险项 `is-danger`、禁用 `is-disabled` + `aria-disabled="true"`。
- 全局兜底 `App.vue` 的 `window` 级 `contextmenu` 监听：`defaultPrevented` 让位子组件 →
  `e.shiftKey` 放行原生 → `shouldKeepNativeMenu(target)` 对 input/textarea/select/contenteditable 放行原生 →
  否则 `preventDefault` + 弹默认菜单（`refresh` / `copy-link` / `top` / `theme`）。
- 子组件自行接管：消息气泡（`copy` / `select-text` / `reply` / `toggle-source` / `toggle-pin` /
  `download-attachment` / `save-sticker` / `recall`）、图片附件（`save-media` / `copy-media-url`）。
- **新增菜单 id 时注意**：`MessageBubble.vue` 的 `messageContextMenuItems()` 用 `switch (id)` 映射，
  联合类型新增成员 TS **不会**报未处理分支 —— 必须手动补 `case`，否则该项静默消失。

## 8. 剪贴板（v2.4）

- 全仓唯一实现 `frontend/src/utils/clipboard.ts`：`writeClipboardText(text): Promise<boolean>`。
  先试 `navigator.clipboard?.writeText`，不存在/抛错则 `textarea + document.execCommand('copy')` 兜底。
  `grep -rn "execCommand" src/` 只应有 1 处真实调用。
- 手机用 `http://<局域网IP>` 访问时 `isSecureContext === false`、`navigator.clipboard` 为 `undefined`，
  任何「直接 await navigator.clipboard」的写法在该场景必然失败 —— 一律走该工具。
- 气泡文本可选中：`.bubble` 与 `.bubble__text` 显式 `user-select: text`；**禁止**加
  `-webkit-touch-callout: none`（会堵死 iOS 系统菜单）。
- 已有非空选区时，`contextmenu` 与长按定时器都让给系统（`hasActiveTextSelection()`），
  并在菜单里提供「选择文本」作为 Clipboard API 全不可用时的保底通路。

## 9. 图标

`components/base/AppIcon.vue` 由 Lead 统一新增。新增图标名清单（其他 agent 直接用）：
`compass`、`image`、`video`、`play`、`heart`、`heart-filled`、`comment`、`send`、`palette`、
`logout`、`shield`、`sun`、`moon`、`plus`、`trash`、`reply`、`undo`、`expand-more`、`drag`。
如确实缺少别名的图标，先 `send_message` 给 lead，不要自行改该文件。
