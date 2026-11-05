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

## 6. 图标

`components/base/AppIcon.vue` 由 Lead 统一新增。新增图标名清单（其他 agent 直接用）：
`compass`、`image`、`video`、`play`、`heart`、`heart-filled`、`comment`、`send`、`palette`、
`logout`、`shield`、`sun`、`moon`、`plus`、`trash`、`reply`、`undo`、`expand-more`、`drag`。
如确实缺少别名的图标，先 `send_message` 给 lead，不要自行改该文件。
