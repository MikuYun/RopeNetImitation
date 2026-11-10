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
- **桌面抽屉动画（v2.6）**：`translateX(calc(-100% - var(--pdrawer-left)))` → `0`，入场 300ms
  `cubic-bezier(0.22,0.61,0.36,1)`、离场 180ms `cubic-bezier(0.4,0,1,1)`，只过渡 `transform`/`opacity`。
  `<Transition>` 必须显式给 `:duration="{ enter: 300, leave: 180 }"` —— 否则 Vue 只取根节点（遮罩）
  的 opacity 200ms，会在 200ms 强行结束 300ms 的面板滑入（滑到 -33% 就跳回原位）。
  位移要带上 `--pdrawer-left`（面板 left 在 rail 右缘，纯 -100% 会留一截压在侧栏上）；
  遮罩离场保持 `opacity: 1` 且不过渡，否则面板的滑出会跟着遮罩一起被淡没。
  `prefers-reduced-motion` 下全部关掉。
- 「退出登录」必须二次确认（`AppModal`），并清空 auth/ui store。

## 4. 广场入口（Lead + fe-account）

- 桌面：`AppRail` 中间图标区新增第三个 tab（`AppIcon name="compass"`），路由 name `square`。
- 移动端：`ChatView` 列表屏顶部横条新增「广场」按钮（Lead 负责）。
- `SquareView.vue` 自身不再放返回按钮处的额外导航。

## 5. 消息渲染（fe-msg）

- `Message.attachments: Attachment[]`（**单数 `attachment` 已删除**）。空数组 = 无附件。
- 附件九宫格：**v2.6 起按原图比例弹性布局**，不再固定尺寸。
  - 1 张图：只限最大宽/高 `min(320px,62vw) × min(400px,46vh)`、`object-fit: contain`（旧实现是
    260×260 + `cover`，结果 40×40 的图标被放大到 260 变模糊、1200×300 的横图被裁掉大半）。
  - 2–4 张两列，5–9 张三列；**每格 `aspect-ratio` 取该图真实比例**（`--att-ratio`，由
    `<img @load>` 读 `naturalWidth/naturalHeight` 写入，夹在 0.5~2，`Attachment` 本身没有宽高字段，
    只能靠图片自身尺寸），未加载时退回 1:1 占位。
  - 视频用 `<video controls preload="metadata">`，单视频 ≤`min(320px,66vw)`。
- **视口懒加载（v2.6）**：`AttachmentView` 用 `IntersectionObserver`（`rootMargin: 400px`）等容器
  进入「视口 + 一屏 1/3」才批量取字节，离开/销毁时 disconnect。旧实现 `watch(immediate)` 会在
  v-for 创建节点的瞬间把所有图片请求一起打出去 —— `content-visibility` 只省布局不省 fetch，
  必须在取字节这一步拦。无 `IntersectionObserver` 时降级为立即加载（宁可多拉也不能不显示）。
- **v2.5 媒体消息去噪**：图片/视频消息**不显示文件名、大小、下载链接文字**（原 `.att__name--under`
  图注与 `.att__video-bar` 视频文件名条已删除），下载改由用户主动操作：桌面右键 `save-media`
  「保存图片/视频」，移动端长按同一菜单。文件名降级为 `.sr-only` 保留（读屏 + e2e 用气泡
  `textContent` 含文件名定位消息）；文件卡仍显示文件名与大小、点击即下载（`.att__meta` 不再带
  「· 点击下载」文案，因为卡片本身就是下载按钮）。
- **纯媒体气泡**：只有附件、无正文、无引用回复的消息额外挂 `.bubble--media`
  （`padding:0; background:transparent; box-shadow:none`），避免图片外围出现一圈底色/阴影「边框」。
  `.bubble--attach` 类名保留（e2e 定位带附件消息依赖它）。
- 视频时长不再单独渲染文本，改由原生 `controls` 展示（原先的 `.att__duration` 已删除）。
- 视频/图片 URL 必须经 `fetchObjectUrl` 拿 blob URL（同 `api/uploads.ts` 既有纪律），不得把 token 拼进 URL。
- 撤回：`recalled=true` 时渲染「XXX 撤回了一条消息」占位，不渲染正文与附件。
- 引用回复：`replyTo` 非空时气泡顶部渲染引用条（`senderName：preview`，点击滚动定位到原消息）。
- 输入框：正文与附件互不依赖 —— 可只发附件、也可图文同条；只有「既无正文又无附件」时按钮 disabled。有附件时 Enter 不发送（防误发，必须点发送按钮或 Ctrl/⌘+Enter）。

## 6. 表情包（v2.4）

- 新增接口层 `frontend/src/api/stickers.ts`：`Sticker`、`normalizeSticker()`、`isStickerMime()`、
  **`stickerToAttachment(sticker): Attachment`（id 取 `uploadId`）**、`listStickers` / `addSticker` / `deleteSticker`。
- `frontend/src/stores/sticker.ts`：epoch 代际保护（不依赖 `auth.ts` 挂 reset），对外
  `ensureLoaded(force)` / `refresh()` / `add(uploadId)` / `saveFromAttachment(att)` / `remove(id)` /
  `resetFor(userId)` / `hasUpload()` / `findById()`。
- **收藏时压缩（v2.5）**：`saveFromAttachment()` 先取原图 blob → `utils/imageCompress.ts`
  缩到最大边 512px、`canvas.toBlob('image/webp', 0.82)` → 重新上传 → 把压缩图收藏成表情。
  静图 >64 KiB 才压（小图压缩收益不足以抵消多一条 uploads 记录）；转码后必须比原图小
  20% 以上才采用，否则引用原图更省。GIF 不转码（canvas 只取首帧会丢动画），按原字节引用并受
  2 MiB 上限约束。任何一步失败都回退成「收藏原图」，绝不阻断收藏；前端无法压缩且原图超限时
  抛错提示用户裁剪。压缩逻辑与后端 `MAX_STICKER_BYTES` 双保险（客户端可绕过，服务端必须自挡）。
- 面板 `components/message/StickerPanel.vue`（`section.sp[aria-label="表情包"]`）：桌面 4 列 / ≤767px 5 列，
  每格 1:1 `object-fit: contain`、≤360×320；每格删除按钮 `aria-label="删除表情 <name>"`（AppModal 二次确认）；
  图片一律走 blob URL（按 `uploadId` 缓存 + `onUnmounted` 全 revoke），**不得直接塞 `<img src>`**。
  **v2.6 修掉格子不方/图片变形**：方形必须挂在**格子**上（`.sp__cell { aspect-ratio: 1/1; overflow: hidden }`）
  + `.sp__pick { position: absolute; inset: 0 }`；旧写法把 `aspect-ratio` 挂在内容撑高的 `.sp__pick` 上，
  `img { height: 100% }` 又找不到确定高度的包含块，结果格子高度随图变、图片被拉长。
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
  `download-attachment` / `save-sticker` / `recall`）、图片附件（`save-media` / `copy-media-url` /
  `open-preview`）、灯箱（`zoom-in` / `zoom-out` / `zoom-reset` + 上面三项图片菜单）。
- **图片专属菜单（v2.6）**：缩略图右键 = 「保存图片 / 复制图片地址 / 查看大图」三项，视频只有前两项。
  `AttachmentView` 在 `@contextmenu` 里 `preventDefault + stopPropagation`，否则会冒泡到
  `MessageBubble` 的 `.line` 或 `App.vue` 的 window 兜底，弹出「刷新页面 / 复制页面链接 / 回到顶部 /
  切换深浅色」这类跟图片毫无关系的总菜单 —— 这是用户反馈的实际问题。灯箱是 `Teleport to="body"`，
  不在附件子树里，所以灯箱面板自己也要接 `@contextmenu`（`lightboxMenuItems()`）。
- **灯箱（v2.6 重做）**：全屏深色（`rgba(6,9,12,0.96)`，`padding: 0`），**去掉白底面板/边框/圆角/阴影**
  （用户说的「有边界」就是旧 `.lb__panel` 的 `border + border-radius:16px + background: var(--app-panel)`）。
  顶部标题与右上角工具条改为绝对定位浮层 + 顶部渐变压暗；底部计数与「滚轮缩放 · 拖拽平移 · Esc 关闭」
  提示也是浮层（触屏不显示该提示）。
  缩放：滚轮（`exp(-deltaY/400)` 平滑）、`+`/`-`/`0` 键、双击在 1x↔2.5x 间切换、按钮 ±；范围 1x–6x，
  **以光标位置为锚点**缩放（否则放大后目标总跑到屏幕外）。放大后可拖拽平移（`setPointerCapture`，
  放大态 `cursor: grab/grabbing`，且关闭 `transform` 过渡以保证跟手）。切图/关闭自动复位到 1x。
  灯箱必须保留 `.mask .panel` / `.panel__title` / `.lightbox__img` 三个类名，e2e 依赖它们。
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
