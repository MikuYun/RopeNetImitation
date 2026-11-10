# AITrance 广场社交流改造 · 设计实现说明书

> **版本**：v1.0（2026-11-10）
> **唯一事实源**：本文件。v0.1–v0.5 的结论已全部并入本文件，旧稿作废，不要再参考。
> **读者**：负责实现的工程师 / agent。按本文件可独立完成开发，不需要再猜设计意图；遇到本文件没写的细节，见 §0.2 第 7 条。
> **本轮范围**：只交付文档，`frontend/**` 代码零改动。
> **参考图**：2800×1260 JPG（近黑底、5 列封面网格、右上分段导航、右下 UID）。参考图只提供**信息层级与视觉密度**，不提供配色、字体与品牌元素。

---

## 0 阅读顺序与强制约定

### 0.1 一句话需求

把现在的「单列文字信息流」广场，改成「封面网格 + 沉浸式详情」：一屏先看封面，点开才看正文与评论；桌面 60/40 弹窗（平板单列弹窗），移动端进整页详情。

### 0.2 强制约定（违反即视为实现错误）

1. **不新增依赖**；不改 `frontend/src/styles/theme.css`、`components/base/AppModal.vue`、`api/**`、`openapi.json`、`package.json`。
2. 颜色 / 字号 / 间距 / 圆角 / 阴影一律取 `theme.css` 语义令牌。组件内禁止裸色值，**唯一例外**：压在封面上的半透明黑底 `rgb(0 0 0 / 0.45)`（角标）与 `rgb(0 0 0 / 0.5)`（播放键）。
3. 断点只用 `useBreakpoint()`（mobile ≤767 / tablet 768–1023 / desktop ≥1024）；不写新的 media 查询断点。**栅格列数是唯一例外**：按容器宽度算（§6.1）。
4. 正文纯文本渲染，**禁止 `v-html`**；链接切分与安全白名单沿用 `utils/markdown.ts`。
5. 附件 URL 必须 `fetchObjectUrl(id)` 换 blob URL、卸载时 `revokeObjectUrl`；Bearer 不能出现在 `<img src>`。
6. DOM 顺序必须等于视觉顺序（网格行优先、评论从旧到新），保证键盘 Tab 与屏幕阅读器顺序自然。
7. 文档没覆盖的细节按以下顺序裁决：① 用语义令牌 ② 不改数据契约 ③ 不动 §10 未列出的文件 ④ 仍不确定就停下提问，**不要自行发明新交互**。

### 0.3 术语

| 词 | 含义 |
|---|---|
| 列表页 | `/chat/square`，封面网格页 |
| 卡片 | `PostCoverCard`，一条内容的封面卡 |
| 封面 | 卡片顶部媒体区（图 / 视频首帧 / 文字占位） |
| 弹窗 | 桌面 / 平板（≥768）的详情弹层：≥1024 为 60/40，768–1023 为单列滚动；组件内渲染，不占路由 |
| 整页 | `/chat/square/:postId` 详情页：≥1024 满屏 60/40，≤1023 单列滚动 |
| 深链 | `?post=<id>`（列表页开弹窗）与 `/:postId`（整页） |
| NEW | 发布 60 分钟内的红色斜体标记 |
| UID 水印 | 页面右下角的当前登录用户 uid |
| Panel | `PostDetailPanel`，弹窗与整页共用的详情主体 |

### 0.4 与既有文档的关系

- `docs/09-responsive-ui.md`：断点、`100dvh`、44px 热区、16px 输入字号、安全区规则继续有效，与本文件一致。
- `docs/v2/UI-V2.md` 中「SquareView 不要自带返回键」是 v2 时期的约束；本期用户明确要求广场顶部有返回键，**以本文件 §4.2 为准**。
- 本文件不引用任何版本演进表；历史决策见附录 B。

---

## 1 目标与验收口径

### 1.1 目标

1. 浏览效率：一屏内看到尽可能多的内容封面，卡片只承担「让人想点开」；
2. 沉浸感：详情占满视野，正文/媒体与评论左右分栏，桌面不打断列表；
3. 零后端改动：全部能力用现有 `Post` 契约在前端派生。

### 1.2 成功标准（可逐条判定）

- [ ] 1440 视口首屏 5 列卡片、无横向滚动；
- [ ] 点卡片：≥1024 出现 60/40 弹窗、768–1023 出现单列弹窗、≤767 进入整页；都可返回列表且滚动位置不变；
- [ ] `/chat/square?post=<id>` 与 `/chat/square/<id>` 两个入口行为符合 §8.2 矩阵；
- [ ] 桌面整页**页面本身不滚动**，只有左栏或右栏内部滚动；
- [ ] NEW 只在 60 分钟内出现，超时**不刷新页面**也会消失；
- [ ] 顶部「推送」由数组渲染，加第二个 tab 只改数据；
- [ ] UID 显示当前登录用户 uid，桌面清晰、手机低调且不挡点击；
- [ ] 7 套主题下无「浅字压浅底 / 深字压深底」事故；
- [ ] 现有能力不退化：发布、点赞、评论、删除、复制链接、9 图 / 1 视频、WS 增量、180s 兜底刷新；
- [ ] 本轮 `git status` 只出现本文件。

---

## 2 范围

### 2.1 本期做

- 列表页：顶部区、筛选、「推送」tab、封面网格、卡片、NEW、UID 水印、空/骨架/错误状态；
- 详情：桌面 60/40 弹窗、平板单列弹窗、桌面 60/40 整页、平板与移动单列整页、评论与发评论；
- 深链：`?post=` 与 `/:postId` 的完整状态机（§8）；
- 前端派生规则（§9）、组件拆分（§10）、状态矩阵（§11）、验收清单（§13）。

### 2.2 本期不做

- 不做等级、MAX 进度条、三段导航（情报板/日程）、运营角标（参考图的「Fairy精选」）、分类体系（`[情报]/[灌水]/[咨询]`）；
- 不做视频时长（接口无 duration 字段）；
- 不做后端字段、不改 `openapi.json`、不改发布表单；
- 不做虚拟滚动（沿用分页 + IntersectionObserver）；
- 不做瀑布流（等高网格，理由见 §6.1）；
- 不做「稍后再看 / 收藏 / 举报」。

---

## 3 视觉基调

### 3.1 光暗与主题

- 广场不锁定深色模式：跟随平台 `data-theme` / `data-theme-mode`。深色主题下自然接近参考图的近黑底；浅色主题下为浅底白卡，**信息结构完全一致**。
- 不允许出现「参考图专属配色」：黄色高亮 `#ffe000`、信息蓝 `#3d6fe0`、涂鸦纹理、游戏字体一律不用。

### 3.2 层级与密度

- 一张卡的信息优先级：**封面 > 标题 > 作者 > 摘要**；除 NEW 与角标外不接受任何浮层元素。
- 卡片上**没有**点赞、评论、分享、更多按钮（决策 2）。所有互动都在详情内完成。

### 3.3 参考图采纳对照

| 参考图元素 | 采纳 | 本项目落法 |
|---|---|---|
| 多列封面网格 | ✅ | §6，按容器宽算列数，等高卡片 |
| 封面 + 作者行 + 标题 + 摘要的层级 | ✅ | §5.2 |
| 左上返回键 | ✅ | §4.2，所有断点都显示 |
| 当前用户头像 + 昵称 | ✅ | §4.2（去掉等级与进度条） |
| 单个「推送」tab | ✅ | §4.2，数组驱动 |
| 右对齐筛选胶囊 | ✅ | §4.2，改成「全部/图文/视频/文字」四项 |
| NEW! 斜体标记 | ✅ 改样式 | §5.5：红色斜体、封面右上角内侧、60 分钟 |
| 右下 UID | ✅ 改数据源 | §4.4：当前登录用户 uid |
|                                   |            |                                         |

---

## 4 列表页结构

### 4.1 线框

```
┌──────────────────────────────────────────────────────────────────────┐
│  (←)  (头像) 昵称                        (刷新) (发布)               │ 行 1：48px
│  [ 推送 ]                        [全部][图文][视频][文字]             │ 行 2：40px
├──────────────────────────────────────────────────────────────────────┤
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                       │
│  │ 封面 │ │ 封面 │ │ 封面 │ │ 封面 │ │ 封面 │   ← 等高网格            │
│  │ 4:3  │ │ 4:3  │ │ 4:3  │ │ 4:3  │ │ 4:3  │                       │
│  ├──────┤ ├──────┤ ├──────┤ ├──────┤ ├──────┤                       │
│  │头像昵称│ │      │ │      │ │      │ │      │                       │
│  │标题2行│ │      │ │      │ │      │ │      │                       │
│  │摘要2行│ │      │ │      │ │      │ │      │                       │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                       │
│                                                          UID: 10001 │
└──────────────────────────────────────────────────────────────────────┘
```

- 滚动容器：列表页自身（`.square__body`，`overflow-y:auto`、`overscroll-behavior-y: contain`），沿用现有实现；
- 顶部区 `position: sticky; top: 0`，背景 `color-mix(in srgb, var(--app-panel) 88%, transparent)` + `backdrop-filter: blur(12px)`，底边 1px `var(--app-border)`；
- UID 水印 `position: fixed`，右下角，`pointer-events: none`，`aria-hidden="true"`。

### 4.2 顶部区逐断点规格

| 元素 | desktop ≥1024 | tablet 768–1023 | mobile ≤767 |
|---|---|---|---|
| 行 1 高度 | 48 | 48 | 48 |
| 返回键 | 36×36 圆形，`AppIcon name="back"` 20px | 36×36 | 44×44（热区 ≥44） |
| 用户信息 | 头像 32 + 昵称 14/600，间距 8 | 同桌面 | 头像 28 + 昵称 14/600，间距 8 |
| 刷新 | 34×34 图标按钮 `refresh` | 34×34 | 34×34 |
| 发布 | 38×38 主按钮（现有样式） | 38×38 | 38×38 |
| 行 2 高度 | 40 | 40 | 40 |
| 推送 tab | 左对齐 | 左对齐 | 左对齐 |
| 筛选 | 右对齐，四项平铺 | 右对齐，四项平铺 | 横向可滚动，`scrollbar-width:none` |
| 左右内边距 | 24 | 20 | 12 |
| 上下内边距 | 8 | 8 | 8 |
| 顶部区总高 | 104 | 104 | 104 |

- 行 2 中 tab 与筛选之间用 `flex: 1` 空档分隔；
- 头部整体不参与网格的 `gap`，与网格间距 16（`--space-4`）。

### 4.3 顶部区元素定义

**① 返回键**
- 点击：`router.back()`；若没有站内来源（`utils/backNavigation` 判定为直接进入），`router.replace({ name: 'chat-empty' })`。
- 桌面也显示（覆盖 `docs/v2/UI-V2.md` 旧约束，以本文件为准）。
- `aria-label="返回"`；40px 以下尺寸的按钮必须靠 `::before` 把热区扩到 44。

**② 用户信息**
- 数据源：`useAuthStore().user`（头像、昵称）；点击整体 → `router.push({ name: 'profile' })`。
- 只显示头像 + 昵称，**不显示** uid、等级、进度条、在线状态。
- 未登录时该区域不渲染（广场本身需要登录，正常不会出现）。

**③ 「推送」tab**
- 数据结构（决策 11）：
  ```ts
  interface SquareTab { id: string; label: string; loader?: () => Promise<PostPage> }
  const tabs: SquareTab[] = [{ id: 'feed', label: '推送' }]
  ```
- 模板 `v-for="tab in tabs"`，一期只有一项；点击当前项无副作用。
- 容器：`inline-flex`、`padding: 3px`、`background: var(--app-panel-alt)`、`border-radius: var(--radius-full)`；
- 单项：高 30、横向 padding 16、字号 13/600、`border-radius: var(--radius-full)`；
- 选中项：`background: var(--app-brand-tint-strong)`、`color: var(--color-brand-700)`；未选中：`color: var(--app-text-muted)`；
- 键盘：`role="tablist"` + `role="tab"` + `aria-selected`；左右方向键切换（一期只有一项，逻辑仍写）。

**④ 筛选（决策 1）**
- 四项固定：`全部 / 图文 / 视频 / 文字`，键名 `all | image | video | text`；
- **纯前端过滤已加载的帖子**，不发请求、不写 URL、刷新后回到「全部」；
- 判定：`全部`= 全部；`图文`= 有 image 且无 video；`视频`= 有 video；`文字`= 无任何附件；
- 样式：高 28、padding 0 12、字号 12/500、`border-radius: var(--radius-full)`、`border: 1px solid var(--app-border)`、`color: var(--app-text-muted)`；
- 选中态：`background: var(--app-brand-tint-strong)`、`border-color: transparent`、`color: var(--color-brand-700)`；
- 过滤结果不足时自动补拉：切换筛选后若结果 < 12 条且 `hasMore`，连续 `fetchFeed(false)` 至 ≥12 条或没有更多，**最多连拉 3 次**；
- 空结果：`AppEmpty` + 文案「这个分类下暂时没有内容」。

**⑤ 刷新 / 发布**
- 刷新：`fetchFeed(true)`，请求中按钮 `disabled` 并旋转（现有行为可保留）；
- 发布：打开现有 `PostComposer` 弹层，成功后 `prepend` 新帖并滚动到顶部（现有行为保留）。

### 4.4 UID 水印

- 内容：`UID: {auth.user.uid}`（决策 7），`auth.user.uid` 为必填 `number`；
- 位置：`position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom));` 移动端 `right: 12px; bottom: calc(12px + env(safe-area-inset-bottom));`
- 样式：`font-size: var(--text-2xs)`（11px）、`color: var(--app-text-faint)`、`pointer-events: none`、`user-select: none`、`aria-hidden="true"`；
- 移动端（决策 9/14）：`font-size: 9px`、`opacity: .45`；用内联样式或局部 class 覆盖，**不改 theme.css**；
- 不遮挡内容：网格底部额外 `padding-bottom: 40px`。

---

## 5 卡片规格（`PostCoverCard`）

### 5.1 解剖

```
┌───────────────────────────┐
│ ┌ 角标)          (NEW!) ┐ │  ← 封面：aspect-ratio 4/3，上两角随卡片圆角裁切
│ │                        │ │
│ │        (素材)          │ │
│ │                        │ │
│ └────────────────────────┘ │
│ (头像28) 昵称        时间  │  ← 作者行，padding 12
│ 标题最多 2 行（13/600）     │
│ 摘要最多 2 行（12/400 灰）  │
└───────────────────────────┘
```

### 5.2 规格表

| 区域 | 规格 |
|---|---|
| 卡片容器 | `background: var(--app-panel)`；`border: 1px solid var(--app-border)`；`border-radius: var(--radius-lg)`；`overflow: hidden`；`cursor: pointer`；`display: block`（整卡是一个 `<a>`） |
| 封面 | `aspect-ratio: 4 / 3`；`width: 100%`；`object-fit: cover`；加载前底色 `var(--app-panel-alt)` |
| 文字区 | `padding: var(--space-3)`（12）；内部 `display: flex; flex-direction: column; gap: var(--space-15)`（6） |
| 作者行 | 头像 `AppAvatar :size="28"` + 昵称 13/600 `--app-text` + 弹性空档 + 相对时间 11 `--app-text-faint` |
| 标题 | 13/1.4/600，`color: var(--app-text)`，`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden`，`min-height: 2.8em` |
| 摘要 | 12/1.5/400，`color: var(--app-text-muted)`，`-webkit-line-clamp: 2`，`min-height: 3em` |
| 卡片间距 | 网格 `gap: var(--space-4)`（16） |
| 悬停 | 180ms：`border-color: color-mix(in srgb, var(--color-brand-500) 32%, var(--app-border))`；`box-shadow: var(--shadow-2)` |
| 键盘焦点 | `:focus-visible` 用 `var(--focus-ring)`，不使用 outline |

- 卡片高度一致：标题与摘要都预留 2 行高度（即使没有摘要也占位），因此网格是整齐的**等高网格**；
- 整卡可点：`<a>` 包裹全部内容，`:href` 指向详情（见 §8.1），`@click.prevent` 走 SPA 打开逻辑；
- 卡片内**没有任何**按钮 / 菜单（决策 2）。

### 5.3 封面规则

| 帖子附件情况 | 封面内容 |
|---|---|
| 有视频 | `<video preload="metadata" muted playsinline>` 首帧 + 居中播放圆标 |
| 只有图片（≥1 张） | 第一张 `image` 的 blob URL，`object-fit: cover` |
| 只有 `file` 或无附件 | 纯文字封面（§5.4） |

- 播放圆标：40×40 圆形，`background: rgb(0 0 0 / 0.5)`，白色 `play` 图标 20；不显示时长；
- 多图角标：`image` 数量 ≥2 时，封面左上 8px 显示 `${n} 图`（§5.6）；
- 视频不自动播放，点击卡片进详情再播。

### 5.4 纯文字卡

- 封面区背景 `var(--app-brand-tint)`；
- 居中 `AppIcon name="chat"` 28px，`color: var(--app-text-faint)`，`opacity: .6`；
- 无角标；
- 其余结构（作者行 / 标题 / 摘要）不变。

### 5.5 NEW 标记（决策 5）

- 条件：`Date.now() - Date.parse(post.createdAt) < 3_600_000`（严格小于 60 分钟；未来时间也算 NEW）；
- 位置：封面区右上角内侧，`position: absolute; top: 8px; right: 8px;`；
- 样式：11px / 700 / `font-style: italic`；颜色 `color-mix(in srgb, var(--color-danger-500) 78%, var(--app-text))`；底色 `color-mix(in srgb, var(--app-panel) 78%, transparent)`；`padding: 2px 6px`；`border-radius: var(--radius-sm)`；无旋转、无图标；
- 文案固定 `NEW!`；
- 消失：列表页维护 `const now = ref(Date.now())`，`setInterval(60_000)` 重算；组件卸载清除定时器；
- 可访问性：`aria-hidden="true"`，并在卡片链接里加 `sr-only` 文本「（1 小时内发布）」。

### 5.6 角标

- 仅一种：多图数量角标（左上 `8px`，10px/600，白字，`background: rgb(0 0 0 / 0.45)`，`border-radius: var(--radius-sm)`，`padding: 1px 6px`）；
- 不渲染媒体类型文字角标（视频由播放圆标表达）。

### 5.7 高度一致性

| 列 | 卡片总高（估算） |
|---|---|
| 1440、卡宽 196 | 封面 147 + 文字区 136 = **283** |
| 1280、卡宽 209 | 157 + 136 = **293** |
| 390、卡宽 175 | 131 + 136 = **267** |

- 文字区固定 136（上下 padding 12 + 作者行 28 + gap 6 + 标题 36 + gap 6 + 摘要 36）；
- 不使用瀑布流：**理由** = 无限滚动追加时瀑布流会重排已有卡片、造成跳动；等高网格可保证追加稳定、键盘顺序 = 视觉顺序。参考图的错落感放弃。

---

## 6 网格与响应式

### 6.1 列数（唯一规则）

```
cols = clamp(floor((W + 16) / 184), 1, 5)
W   = 网格容器宽度（已扣左右内边距）
184 = 最小卡宽 168 + 间距 16
```

- 在 `SquareView` 用 `ResizeObserver` 观察网格容器宽度，按公式算出 `cols`，以内联 `grid-template-columns: repeat(cols, minmax(0, 1fr))` 应用；**不要**用 CSS 媒体查询猜列数；
- 对照表：

| 视口 | 壳扣减 | 内边距 | W | 列数 | 单卡宽 |
|---|---|---|---|---|---|
| 1920 | rail 60 + sidebar 288 | 24×2 | 1524 | 5（封顶） | 292 |
| 1440 | 348 | 48 | 1044 | **5** | 196 |
| 1280 | 348 | 48 | 884 | **4** | 209 |
| 1024 | 348 | 48 | 628 | **3** | 199 |
| 768（tablet） | rail 52 + sidebar 248 | 20×2 | 428 | **2** | 206 |
| 390（mobile） | 0 | 12×2 | 366 | **2** | 175 |
| 320（mobile） | 0 | 12×2 | 296 | **1** | 296 |

- 壳扣减数据来自 `theme.css`：`--rail-w` 60 / `--rail-w-compact` 52、`--sidebar-w` 288 / `--sidebar-w-compact` 248；移动端无壳，全宽。

### 6.2 尺寸与间距

| 项 | desktop | tablet | mobile |
|---|---|---|---|
| 列表左右内边距 | 24 | 20 | 12 |
| 网格 gap | 16 | 16 | 16 |
| 顶部区与网格间距 | 16 | 16 | 12 |
| 网格底部留白（含 UID） | 40 | 40 | 48 |

### 6.3 无限滚动

- 沿用现有实现：列表末尾 sentinel + `IntersectionObserver`，`root = 列表滚动容器`，`rootMargin: '240px'`；
- 触发 `fetchFeed(false)`；`hasMore === false` 时显示「没有更多了」；
- 到底后同一游标不重复请求；请求失败只 toast，不清空列表。

---

## 7 详情（弹窗 / 桌面整页 / 平板与移动整页）

### 7.1 共同结构：一个 Panel

弹窗与详情整页**共用** `PostDetailPanel`，只换外框；外框形态与 `mode` 由断点决定：≥1024 用 `mode="split"`（60/40），≤1023 用 `mode="stack"`（单列）。**不要**为不同形态各写一套正文/媒体/评论逻辑。

```
split 模式（≥1024）
┌───────────────────────────────┬──────────────────┐
│  作者行（头像44 昵称 时间）(…) │ 评论 (N)      (×) │
│  正文（14/1.7，可点链接）      │ ───────────────  │
│  媒体（MediaGrid 九宫格）      │  评论 1           │
│  互动条（赞 / 评论数）         │  评论 2           │
│  查看详情页 →（仅弹窗）        │  …                │
│                               │ ───────────────  │
│                               │  [输入框]  (发送)  │
└───────────────────────────────┴──────────────────┘
   flex: 0 0 60%                   flex: 1 1 40%
   min-width: 0                    min-width: 340px
```

### 7.2 数据与加载

- `PostDetailPanel` props：
  ```ts
  { postId: string; mode: 'split' | 'stack' }   // mode = isDesktop ? 'split' : 'stack'
  ```
- `mode` 由外框按断点传入：≥1024 `split`；≤1023 `stack`（平板弹窗与移动整页）。
- 挂载 / `postId` 变化：`fetchPost(postId)`；成功前显示骨架（左：媒体块 + 3 行文字条；右：3 条评论骨架）；失败：面板内空态「内容不存在或无权查看」+ 关闭/返回；
- 自己订阅 `onPostWsEvent`，只处理 `postId` 匹配的事件：`deleted` → emit `gone` 并 toast「内容已被删除」；`liked` → 更新计数；`commented` → 评论列表静默重拉；
- emits：
  ```ts
  { (e: 'close'): void; (e: 'open-detail-page'): void; (e: 'gone'): void;
    (e: 'post-patched', patch: { id: string; likeCount?: number; commentCount?: number; likedByMe?: boolean }): void }
  ```
- 列表收到 `post-patched` 时调 `squareStore.patch(patch)`，不整页刷新。

### 7.3 左栏（内容）

| 元素 | 规格 |
|---|---|
| 作者行 | 头像 44、昵称 14/600（`--text-md`）、`@username` 13 `--app-text-muted`、时间 12 `--app-text-faint`；右端 32×32「…」菜单（桌面/平板 split 模式）；点击作者 → `router.push({ name: 'user-profile', params: { userId } })` |
| 正文 | 14/1.7 `--app-text`，`white-space: pre-wrap`，`overflow-wrap: anywhere`；链接 `--color-brand-600` + hover 下划线；详情内**不折叠**、不显示「全文」 |
| 媒体 | `MediaGrid`（`variant="detail"`，见 §7.4） |
| 互动条 | 点赞按钮（高 44 热区，`heart` / `heart-filled` + 计数）+ 评论数文本；点赞乐观更新并 emit `post-patched`，失败回滚 + toast |
| 查看详情页 | 仅弹窗模式渲染；文字链接「查看详情页 →」，13/600，`--color-brand-600`，hover 下划线（决策 13：文字，不用图标） |

### 7.4 媒体（`MediaGrid` 改造）

- 复用现有 `MediaGrid`，新增 `variant?: 'default' | 'detail'`（默认 `default`）；
- `detail` 模式规则：

| 附件 | 排布 |
|---|---|
| 1 张图片 | 单图居中，`max-height: 52dvh`，`width: auto`，`object-fit: contain`，底色 `var(--app-panel-alt)` |
| 2 张 | 2 列，每格 `aspect-ratio: 1/1` |
| 3–4 张 | 2 列，每格 `aspect-ratio: 1/1` |
| 5–9 张 | 3 列，每格 `aspect-ratio: 1/1` |
| 含视频 | 视频 `16/9`，`controls`，`max-height: 56dvh`；视频点播放后才播 |
| 超过 9 张 | 后端上限 9，超出不处理 |

- 格间 `gap: 6px`、圆角 `var(--radius-sm)`；
- 点击图片 → 打开全屏查看器（§7.9）；
- 媒体整体不超出一屏（桌面整页），超长时左栏滚动。

### 7.5 评论区

- **stack 模式（768–1023 弹窗 / ≤1023 整页）**：评论列表随页面滚动，不再内部滚动；输入条固定在弹窗底部（平板弹窗）或视口底部（整页）。
- split 模式结构：头部（「评论 N」13/600，右端不放菜单）+ 列表（`flex: 1; overflow-y: auto`）+ 底部输入条；
- 列表项：头像 32 + 昵称 13/600 + 时间 11 `--app-text-faint` + 正文 13/1.5；管理员或本人可删（行尾「删除」，二次确认用 `AppModal`）；点击「回复」进入回复态（`replyToId` 只能指向同帖）；
- 分页：`fetchComments(postId, { cursor })`，页面内滚动到底 `IntersectionObserver`，`root = 评论列表容器`；
- 输入条：`textarea` 自动增高 1–4 行（36–96），字号 13（移动端 16 防缩放），`maxlength = COMMENT_MAX_CHARS`，右下角「发送」按钮（32 高）；空内容禁用；发送成功清空并追加；
- 键盘：桌面 Enter 发送、Shift+Enter 换行；移动端只用按钮发送；
- 评论 0 条：空态「还没有评论，来抢沙发」；
- 评论发送失败：保留草稿 + toast。

### 7.6 弹窗（≥768；≥1024 split，768–1023 stack）

- 外框：宽 `min(1180px, 92vw)`、高 `min(860px, 86dvh)`，居中，`border-radius: var(--radius-xl)`，`background: var(--app-panel)`，`box-shadow: var(--shadow-3)`；
- 遮罩：`rgb(14 20 26 / 0.46)` + `backdrop-filter: blur(3px) saturate(120%)`（与 `AppModal` 视觉一致，但**不复用** `AppModal`）；
- 平板（768–1023）弹窗用 `mode="stack"`：宽 `min(720px, 92vw)`、高 `min(860px, 86dvh)`，单列内部滚动（内容 `max-width: 640px` 居中），底部输入条固定在弹窗内；
- 关闭：右上角 36×36 圆形按钮 `AppIcon name="close"`，`absolute; top: 12px; right: 12px;`；点击、Esc、点遮罩都可关；关闭键在 DOM 中位于面板第一个可聚焦位置，保证 `initialFocusIndex` 落在它上面；
- 焦点：复用 `utils/dialogA11y.ts`（`collectFocusables` / `dialogKeyAction` / `initialFocusIndex`），`role="dialog"`、`aria-modal="true"`、`aria-labelledby` 指向作者名或「内容详情」；打开后焦点落在关闭键，关闭后归还触发卡片；
- 滚动锁：`@vueuse/core` 的 `useScrollLock(document.body)`；开弹窗期间列表不可滚；
- 打开动画：遮罩淡入 + 面板 `opacity 0→1`、`scale(.97→1)` 180ms；关闭 120ms 反向；
- 与整页的唯一差别：外框尺寸、关闭按钮、「查看详情页」链接、焦点陷阱。

### 7.7 桌面整页（`mode="split"`，≥1024）

- 路由：`/chat/square/:postId`，组件 `views/PostDetailPage.vue`；
- 外框：`height: 100dvh; overflow: hidden; background: var(--app-bg)`；**页面本身不滚动**；
- 左上返回：40×40 圆形，`absolute; top: 16px; left: 16px;`，背景 `color-mix(in srgb, var(--app-panel) 86%, transparent)` + blur；点击 `router.back()`，无来源时 `replace({ name: 'square' })`；`Esc` 同效；
- 页面右上不放按钮；`复制链接` / `删除` 在左栏作者行右端的「…」菜单里（见 §7.3、§7.9）；
- 左栏 `flex: 0 0 60%`、`min-width: 0`、`overflow-y: auto`（**唯一允许滚动的区域之一**）、padding 32；
- 右栏 `flex: 1 1 40%`、`min-width: 340px`、`display: flex; flex-direction: column`，`border-left: 1px solid var(--app-border)`；
- 超长内容：左栏内部滚动，右栏与输入框不动（唯一策略，无备选）。

### 7.8 stack 整页（`mode="stack"`，≤1023）

- 同一路由 `/chat/square/:postId`；
- 768–1023（平板）：内容 `max-width: 680px` 居中；≤767：全宽；
- 顶栏 `position: sticky; top: 0; height: 52`：返回 44（热区）+ 居中标题「内容详情」13/600 + 右侧「…」36；背景 `color-mix(in srgb, var(--app-panel) 88%, transparent)` + blur；
- 内容纵向排列，`padding: 12px`，顺序：作者行 → 正文（16/1.65）→ 媒体（`MediaGrid` detail，全宽）→ 互动条 → 评论标题 → 评论列表 → 底部留白 `calc(56px + env(safe-area-inset-bottom) + 12px)`；
- 页面整体滚动；评论分页 `root = 页面滚动容器`；
- 底部输入条：`position: fixed; bottom: 0; left: 0; right: 0;`，高 56 + `env(safe-area-inset-bottom)`，`background: var(--app-panel)`，上边 1px `var(--app-border)`；`textarea` 字号 16；
- 不使用左右分栏；≤767 不出现弹窗（768–1023 的整页同样是单列，弹窗为同一 Panel 的 stack 外框）。

### 7.9 详情内操作

| 操作 | 位置 | 行为 |
|---|---|---|
| 点赞 | 左栏互动条 / 移动内容区互动条 | 乐观更新 → emit `post-patched` |
| 删除 | 「…」菜单（作者/管理员）：桌面/平板在作者行右端，移动在顶栏右侧 | `AppModal` 二次确认 → `deletePost` → 关闭详情 + 移除列表项 + toast |
| 复制链接 | 「…」菜单 | 复制 `location.origin + '/chat/square/' + id`，toast「链接已复制」 |
| 图片预览 | 点击媒体 | 打开全屏查看器：左右切换、Esc/点击关闭、视频 `controls`；进入详情页时暂停 |
| 返回 | 左上返回 / Esc（桌面） | §7.7 |
| 查看详情页 | 弹窗左栏底部 | `router.push({ name: 'square-post', params: { postId }, query: { full: '1' } })` |

- 全屏查看器抽取为 `components/square/MediaLightbox.vue`（从现有 `SquareView` 的 viewer 平移，行为不变），列表与详情共用。

---

## 8 路由与深链（唯一状态机）

### 8.1 路由表

| 名称 | path | 组件 | 说明 |
|---|---|---|---|
| `square` | `square` | `views/SquareView.vue` | 列表页；`?post=<id>` 表示开弹窗 |
| `square-post` | `square/:postId` | `views/PostDetailPage.vue` | 详情页；桌面需 `?full=1` 才整页，否则回列表弹窗 |

- 两条都挂在 `/chat` 子路由下，位置在 `:convId` 之前（静态段优先，沿用现有顺序约定）；
- `name` 使用 `square-post`；
- `views/ChatView.vue` 的 `isContentScreen` 追加 `'square-post'`（移动端只渲染 RouterView）。

### 8.2 入口 → 行为矩阵

| 入口 | 断点 | 结果 | URL 变化 |
|---|---|---|---|
| 点击卡片 | ≥768 | 打开弹窗 | `router.replace({ query: { ...query, post: id } })` |
| 点击卡片 | ≤767 | 进整页 | `router.push({ name: 'square-post', params: { postId: id } })` |
| 打开 `/chat/square?post=<id>` | ≥768 | 列表加载后开弹窗（Panel 自己 fetch） | 不变 |
| 打开 `/chat/square?post=<id>` | ≤767 | 重定向到整页 | `replace` 到 `/chat/square/<id>` |
| 打开 `/chat/square/<id>` | ≥768 | **先弹窗** | `replace` 到 `/chat/square?post=<id>` |
| 打开 `/chat/square/<id>?full=1` | ≥768 | 整页 | 不变 |
| 打开 `/chat/square/<id>?full=1` | ≤767 | 整页（忽略 `full`） | 不变 |
| 弹窗内点「查看详情页」 | ≥768 | 整页 | `push` 到 `/chat/square/<id>?full=1` |
| 关闭弹窗 | ≥768 | 关弹窗 | `replace` 去掉 `post` query |
| 整页返回 | 全部 | 回列表 | `back()`；无来源则 `replace` 到 `/chat/square` |
| 刷新弹窗 URL | ≥768 | 重新开弹窗（预期行为） | 不变 |
| 刷新整页 URL | 全部 | 直接渲染整页 | 不变 |

### 8.3 守卫实现规则

- `square-post` 的 `beforeEnter`（**只用 `window.matchMedia('(max-width: 767px)')`**，不要在守卫里调 `useBreakpoint()`——它需要在组件上下文）：

```ts
if (matchMedia('(max-width: 767px)').matches) return true            // 移动端永远整页
if (to.query.full === '1') return true                               // 桌面显式整页
return { name: 'square', query: { post: String(to.params.postId) }, replace: true }
```

- `square` 的 `beforeEnter`：

```ts
if (matchMedia('(max-width: 767px)').matches && typeof to.query.post === 'string')
  return { name: 'square-post', params: { postId: to.query.post }, replace: true }
```

- `?full=1` 只用于打破「弹窗 ⇄ 整页」重定向循环，**不得**作为弹窗 URL 的参数；
- 所有 URL 同步都用 `replace`，避免浏览器历史里堆积「开/关弹窗」条目；
- 列表页 watch `route.query.post`：有值 → 开弹窗；变空 → 关弹窗；`post` 值无效（Panel fetch 失败）→ toast + `replace` 清 query；
- 站内返回判断复用 `composables/useBackNavigation.ts`（现有能力）。

---

## 9 数据与派生规则

### 9.1 数据契约（不改）

```ts
interface Post {
  id: string; author: User; content: string;
  attachments: SquareAttachment[];   // kind: 'image' | 'video' | 'file'
  likeCount: number; commentCount: number;
  likedByMe: boolean; mine: boolean;
  createdAt: string; updatedAt: string;
}
interface PostComment {
  id: string; postId: string; author: User; content: string;
  replyToId: string | null; replyToAuthorName: string | null; createdAt: string;
}
```

- **没有** `title` / `category` / `cover` / `duration` 字段；一期不新增（决策 12）；
- 现有常量：`POST_MAX_CHARS=5000`、`COMMENT_MAX_CHARS=1000`、`POST_MAX_ATTACHMENTS=9`、`POST_MAX_VIDEOS=1`、`POST_IMAGE_MAX_BYTES=50MiB`、`POST_VIDEO_MAX_BYTES=100MiB`、`POST_PAGE_SIZE=20`；
- 现有 API：`fetchPosts`、`fetchPost`、`createPost`、`deletePost`、`likePost`、`unlikePost`、`fetchComments`、`createComment`、`deleteComment`、`attachmentKindOf`；
- `User.uid: number` 必填（`api/auth.types.ts`）。

### 9.2 派生函数（新增 `utils/postCopy.ts`，纯函数、可单测）

```ts
type CardMediaKind = 'image' | 'video' | 'text'

deriveCardCopy(post: Post): {
  title: string          // 正文首个非空行，>24 字截断加「…」
  excerpt: string        // 去掉标题行后的剩余正文，空白压平；可空
  mediaKind: CardMediaKind
  imageCount: number
  video: SquareAttachment | null
  cover: SquareAttachment | null   // 首个 image / video
}

isNewWithinHour(createdAt: string, now: number): boolean   // now - t < 3_600_000
filterPosts(posts: Post[], filter: 'all' | 'image' | 'video' | 'text'): Post[]
```

派生规则与边界：

| 字段 | 规则 | 边界 |
|---|---|---|
| `title` | `content.trim()` 按 `\r?\n` 切分，取第一个非空行；长度 > 24 → 前 24 字 + `…` | 无正文时：有视频 →「视频」；有图 →「${n} 张图片」；否则 →「附件」 |
| `excerpt` | 去掉标题所在行后的剩余文本，`\s+` → 空格；不重复标题 | 剩余为空 → `''`，模板仍保留 2 行占位 |
| `mediaKind` | 有 `video` → `video`；否则有 `image` → `image`；否则 `text` | `file` 类型一律忽略 |
| `cover` | 第一个 `kind==='video'`，否则第一个 `kind==='image'` | 多图只取第一张 |
| `imageCount` | `attachments.filter(kind==='image').length` | ≥2 时显示「N 图」角标 |
| `isNewWithinHour` | `now - Date.parse(createdAt) < 3_600_000` | 60 分钟整不算 NEW；未来时间算 NEW |

- 单元测试覆盖：1 小时边界（59:59 / 60:00 / 60:01）、无附件、仅 file、超长正文、多行正文、未来时间戳。

### 9.3 时间

- 相对时间沿用 `utils/datetime.ts` 的 `fromNow`；
- NEW 的 `now` 由列表页 60s 定时器驱动；详情页不显示 NEW。

### 9.4 附件 URL

- 列表卡片封面：单张 → `fetchObjectUrl(cover.id)`；卸载/切换时 `revokeObjectUrl`；
- 详情：交给 `MediaGrid`（已有 blob 缓存与回收逻辑）；
- 播放中的视频在关闭详情/切走时 `pause()` 并清 `src`。

---

## 10 组件与文件清单

| 文件 | 动作 | 职责 / 约束 |
|---|---|---|
| `views/SquareView.vue` | 重构 | 顶部区、筛选、网格 `ResizeObserver` 列数、UID、骨架/空态、无限滚动、WS、60s tick、弹窗状态与 `?post=` 同步；**不**直接实现详情内部 |
| `components/square/PostCoverCard.vue` | 新增 | 卡片（封面/NEW/角标/作者行/标题/摘要），整卡 `<a>` |
| `components/square/PostDetailModal.vue` | 新增 | 弹窗外框：遮罩、尺寸、关闭、焦点陷阱、滚动锁；内部只渲染 `PostDetailPanel` |
| `components/square/PostDetailPanel.vue` | 新增 | 唯一详情主体：`mode='split'`（60/40）/`'stack'`（≤1023 单列），自取数、自订阅 WS、emit `close`/`gone`/`post-patched`/`open-detail-page` |
| `components/square/PostCommentPanel.vue` | 新增 | 评论列表 + 分页 + 输入条 + 回复 + 删除（从 `PostComments.vue` 抽取，去掉 `AppModal` 外壳） |
| `components/square/MediaLightbox.vue` | 新增 | 全屏图片/视频查看器（从 `SquareView` 现有 viewer 平移） |
| `views/PostDetailPage.vue` | 新增 | 整页外框：`100dvh`、返回、「…」菜单、按断点选 `mode` |
| `components/square/MediaGrid.vue` | 小改 | 增加 `variant?: 'default' \| 'detail'`，仅用于详情媒体（列表不再使用它） |
| `utils/postCopy.ts` | 新增 | §9.2 派生纯函数 |
| `stores/square.ts` | 小改 | 复用现有 `prepend/patch/remove/bumpCommentCount/refreshPost`；如 `patch` 不满足计数回写则补一个幂等方法 |
| `router/index.ts` | 小改 | 加 `square-post` 路由 + 两个 `beforeEnter` |
| `views/ChatView.vue` | 小改 | `isContentScreen` 追加 `'square-post'` |
| `components/square/PostCard.vue` | 删除 | 由 `PostCoverCard` 取代 |
| `components/square/PostComments.vue` | 删除 | 由 `PostCommentPanel` 取代 |
| `components/square/PostComposer.vue` | 不动 | 发布弹层继续使用 |
| `utils/dialogA11y.ts` | 不动 | 复用；`FOCUSABLE_SELECTOR` 必须与 `frontend/e2e-matrix.mjs` 逐字一致 |
| `components/base/AppModal.vue` | 不动 | 仍有 5+ 调用方，不扩 API |
| `styles/theme.css` | 不动 | 零新增令牌 |
| `api/**`、`openapi.json`、`package.json` | 不动 | 零后端 / 零依赖改动 |

**依赖方向**：`SquareView` / `PostDetailPage` → `PostDetailModal` / `PostDetailPanel` → `PostCommentPanel`、`MediaGrid`、`MediaLightbox`；`PostCoverCard` 只依赖 `postCopy` 与 `api/uploads`；`utils/postCopy` 不依赖 Vue。

---

## 11 状态与异常矩阵

| 场景 | 表现 |
|---|---|
| 列表首屏加载 | 骨架卡数量 = 列数 × 2（桌面 10 / 平板 6 / 移动 4）；顶部可交互 |
| 列表空 | `AppEmpty`「广场还没有内容」+「发布第一条」按钮 |
| 筛选空 | `AppEmpty`「这个分类下暂时没有内容」 |
| 列表错误 | 现有错误态 + 重试 |
| 滚动到底 | 「没有更多了」；不重复请求 |
| 新帖（WS） | 顶部悬浮条「有 N 条新动态」，点击才插入；不自动插队 |
| 卡片被删（WS） | 直接从列表移除；若正在看该帖详情 → toast + 关闭 |
| NEW 过期 | 60s 重算后消失，卡片高度不变（NEW 为绝对定位） |
| 封面加载失败 | `--app-panel-alt` 占位 + `image` 图标，不塌陷 |
| 视频首帧失败 | 播放圆标 + 灰底，仍可进详情尝试 |
| 弹窗打开中列表滚到底 | 后台可继续加载，弹窗不受影响 |
| 重复点击同一卡片 | 已打开则忽略 |
| 详情单帖 404/403 | 面板内「内容不存在或无权查看」+ 关闭/返回 |
| 详情打开时帖子被删（WS） | toast「内容已被删除」+ 关闭回列表 |
| 评论 0 条 | 空态「还没有评论，来抢沙发」 |
| 评论发送中 / 失败 | 按钮 loading / 保留草稿 + toast |
| 未登录 | 由现有路由守卫拦截，广场不可达 |
| 桌面整页：左栏超一屏 | 只有左栏滚动，右栏与输入框不动 |
| 桌面整页：纯文字 | 无媒体区，正文 14/1.8 |
| 桌面整页：1 图 | 单图居中，最高 52dvh |
| 桌面整页：视频 | 16:9，最高 56dvh，点才播；离开暂停 |
| `?post=` 指向不存在的帖 | toast + `replace` 清 query，列表不受影响 |
| 浏览器刷新弹窗 URL | 重新打开弹窗（预期，不是 bug） |

---

## 12 无障碍与动效

### 12.1 无障碍

- 卡片：`<a>` 包裹整卡，可用名 = 「{作者}：{标题}」「（1 小时内发布）」；`role="feed"` + `aria-busy` 挂在网格上；
- 键盘：Tab 顺序 = DOM 顺序 = 网格行优先；Enter 打开；Esc 关闭弹窗/整页；
- 弹窗：`role="dialog"`、`aria-modal="true"`、`aria-labelledby`；焦点进入弹窗、Tab 循环、关闭归还；`dialogA11y` 提供原语；
- 图片 `alt`：`{作者名}第 {n} 张图片`；纯装饰封面 `alt=""`；
- NEW / UID 均 `aria-hidden`，NEW 的语义通过 `sr-only` 文本给到卡片链接；
- 对比度：正文/摘要/标题全部走语义令牌（亮暗两套均已核算 ≥4.5:1）；NEW 红 `color-mix(danger-500 78%, text)` 在浅底 ≈6.1:1、深底 ≈5.2:1；
- 触控：移动端可点元素热区 ≥44；输入框字号 ≥16；
- 遵循 `prefers-reduced-motion`。

### 12.2 动效

| 场景 | 规格 |
|---|---|
| 卡片 hover | 180ms `--ease-out`：描边变色 + `--shadow-2`；封面 `scale(1.03)` 240ms |
| 弹窗开 | 180ms：遮罩淡入 + 面板 `opacity 0→1`、`scale(.97→1)` |
| 弹窗关 | 120ms 反向 |
| 筛选切换 | 仅透明度交叉 120ms，不做高度动画 |
| 新内容提示 | 240ms 滑入 |
| NEW 过期 | 无动画，直接消失 |
| 骨架 | 1.2s 呼吸；reduced-motion 下静态 |
| 降级 | `prefers-reduced-motion: reduce` 时移除位移/缩放，只留透明度 |

---

## 13 验收清单

- [ ] 1920 / 1440 / 1280 / 1024 / 768 / 390 / 320 七档无横向滚动、无文字截断乱码；
- [ ] 列数分别为 5 / 5 / 4 / 3 / 2 / 2 / 1，卡宽与 §6.1 对照表一致（±1px）；
- [ ] 顶部区：返回 + 头像 + 昵称 + 推送 tab + 筛选 + 刷新 + 发布，无等级/进度条/三段导航；
- [ ] 「推送」由数组渲染；加一项只需改 `tabs` 数据；
- [ ] 筛选四项：切换即时生效、不写 URL、结果不足自动补拉、空态文案正确；
- [ ] NEW 只在 60 分钟内出现、红色斜体、无旋转；跨过 60 分钟无需刷新自动消失；
- [ ] 卡片无任何按钮；悬停/聚焦/点击热区正确；右键不弹菜单；
- [ ] UID = 当前用户 uid；桌面 11px、移动 9px + `opacity .45`；不遮挡点击；
- [ ] 桌面点卡片出 60/40 弹窗；Esc / 遮罩 / 关闭键都能关；焦点回到卡片；列表滚动位置不变；
- [ ] `/chat/square?post=<id>` 与 `/chat/square/<id>` 桌面都先弹窗；关弹窗后 URL 干净；
- [ ] 弹窗「查看详情页」→ 满屏整页，不再重定向；返回回到广场原位置；
- [ ] 桌面整页页面不滚；左 60% / 右 40%；1024–1279 右栏 340px 保底；中间 1px 分隔；
- [ ] 桌面整页左栏超长时只左栏滚；评论独立滚动；输入框始终贴右栏底部；
- [ ] 整页媒体：纯文字无媒体区、1 图单图居中、2–4 图 2 列、5–9 图 3 列、视频 16:9；点图开全屏查看器；
- [ ] 移动端：点卡片进整页、页面整体滚动、底部输入条固定、16px 输入字号、返回列表位置不变；
- [ ] 详情内点赞/评论后，返回列表计数一致（无整页刷新）；
- [ ] 7 套主题（light/dark/ocean/forest/sakura/midnight/custom）下无对比度事故；
- [ ] `prefers-reduced-motion` 下无位移/缩放；
- [ ] 键盘可完成：进列表 → 打开卡片 → 关闭 → 回卡片；弹窗焦点不逃逸；
- [ ] `git status` 只含预期改动（文档阶段仅本文件）。

---

## 14 建议实现顺序

1. `utils/postCopy.ts` + 单测（纯函数，先把派生规则钉死）；
2. `PostCoverCard.vue` + `SquareView` 网格/顶部区/筛选/NEW/UID（先跑通列表视觉）；
3. `MediaGrid.vue` 加 `variant` + `MediaLightbox.vue`（把查看器从 SquareView 抽出）;
4. `PostCommentPanel.vue`（从 `PostComments.vue` 抽取，先保证功能不退化）；
5. `PostDetailPanel.vue`（split + stack 两种模式）+ `PostDetailModal.vue`；
6. `views/PostDetailPage.vue` + 路由/守卫 + `ChatView`；
7. 深链状态机联调（§8.2 全部行）；
8. 删除 `PostCard.vue` / `PostComments.vue`，同步 e2e 断言；
9. 对照 §13 逐条验收。

---

## 附录 A 令牌引用（全部已存在于 `theme.css`，不新增）

| 用途 | 令牌 | 备注 |
|---|---|---|
| 页面底 | `--app-bg` | 亮 `#f2f5f9` / 暗 `#0b0f14` |
| 卡片 / 面板底 | `--app-panel` | 亮 `#fff` / 暗 `#131820` |
| 卡片悬停底 | `--app-hover` | |
| 封面占位 / 媒体舞台 | `--app-panel-alt` | 亮 `#f8fafc` / 暗 `#171d26` |
| 分隔线 / 描边 | `--app-border` | |
| 强描边 | `--app-border-strong` | |
| 主文字 | `--app-text` | |
| 次文字 | `--app-text-muted` | |
| 弱文字 / UID | `--app-text-faint` | UID 非正文，允许 <4.5:1 |
| 选中 tab / 筛选底 | `--app-brand-tint-strong` | |
| 选中文字 / 链接 | `--color-brand-600`、`--color-brand-700` | |
| NEW 红 | `color-mix(in srgb, var(--color-danger-500) 78%, var(--app-text))` | |
| 遮罩 | `rgb(14 20 26 / 0.46)` + blur 3px | 与 AppModal 一致 |
| 圆角 | `--radius-sm` 6 / `--radius-md` 10 / `--radius-lg` 14 / `--radius-xl` 18 / `--radius-full` 999 | |
| 间距 | `--space-1`4 / `--space-15`6 / `--space-2`8 / `--space-3`12 / `--space-4`16 / `--space-5`20 / `--space-6`24 / `--space-8`32 | |
| 字号 | `--text-2xs`11 / `--text-xs`12 / `--text-sm`13 / `--text-md`14 / `--text-lg`16 | |
| 行高 | `--lh-tight`1.25 / `--lh-snug`1.4 / `--lh-normal`1.5 / `--lh-relaxed`1.65 | |
| 字重 | `--weight-medium`500 / `--weight-semibold`600 / `--weight-bold`700 | |
| 阴影 | `--shadow-1` / `--shadow-2` / `--shadow-3` | 暗色有独立值 |
| 动效 | `--dur-fast`120 / `--dur`180 / `--dur-slow`240 / `--ease-out` / `--ease-in` | |
| 层级 | `--z-sticky`10 / `--z-overlay`100 / `--z-modal`150 / `--z-toast`200 | |

## 附录 B 已定决策索引（全部源自用户拍板）

| # | 决策 | 落点 |
|---|---|---|
| 1 | 筛选「全部 / 图文 / 视频 / 文字」，纯前端 | §4.3④ |
| 2 | 卡片上不放点赞 / 评论按钮 | §3.2、§5.2 |
| 3 | 详情用纯组件内弹窗（不新增依赖） | §7.6 |
| 4 | 主题跟随平台原有主题，不另搞一套 | §3.1、附录 A |
| 5 | NEW = 1 小时内、红色斜体 | §5.5 |
| 6 | 顶部 = 返回 + 用户信息（无等级/进度条）+ 单个「推送」tab，可维护 | §4.2、§4.3 |
| 7 | UID 水印 = 当前用户 uid | §4.4 |
| 8 | 桌面支持 `?post=<id>` 深链开弹窗 | §8.2 |
| 9 | UID 手机端也显示，但要低调 | §4.4 |
| 10 | 桌面直达 `/:postId` 先弹窗，弹窗内有「查看详情页」 | §8.2、§7.3 |
| 11 | tab 扩展契约 `{ id, label, loader? }[]` | §4.3③ |
| 12 | 卡片标题取正文首行截断，不改 `Post` 契约 | §9.2 |
| 13 | 「查看详情页」用文字链接，不用纯图标 | §7.3 |
| 14 | 手机 UID 再小（9px / `opacity .45`） | §4.4 |
| 15 | 桌面整页满屏、不滚动，左 60% 内容九宫格 + 右 40% 评论 + 底部输入框 | §7.7 |

## 附录 C 本次修订（v0.5 → v1.0）要点

| 旧稿问题 | 本版处理 |
|---|---|
| 顶部返回键「桌面也保留」与 `SquareView` 实际（仅移动端有）矛盾 | 统一为所有断点都显示，并明确覆盖 `UI-V2` 旧约束（§0.4、§4.2） |
| 列数同时出现「5/4/3/2/2」「≥1440 5 列」「1440 首屏 ≥4 列」三套口径 | 收敛为单一公式 + 对照表（§6.1） |
| 弹窗媒体（单主媒体+缩略条）与整页媒体（九宫格）两套逻辑 | 统一为一个 Panel + `MediaGrid variant="detail"`（§7.1、§7.4） |
| 「卡片不放按钮」与「详情内可点赞/评论」容易被读成冲突 | 明确「卡片零按钮、互动全在详情」（§3.2、§7.3、§7.9） |
| 路由规则分散在 §5.4/§5.5/§5.6，读起来像三种实现 | 收敛为单一状态机 + 两段守卫代码（§8） |
| `PostComments` 既写「复用」又写「退役」 | 明确「抽取为 `PostCommentPanel`，原文件删除」（§10） |
| 版本演进表与决策表两套事实源 | 删除版本演进表，只保留决策索引（附录 B） |
| 标题「是否保留 `[分类]` 前缀」未定 | 明确「不额外渲染前缀；正文自带的原样保留」（§9.2） |
| 筛选是否写 URL 未定 | 明确不写 URL（§4.3④） |
| 新增令牌提案（highlight 色）残留 | 明确零新增令牌（§0.2、附录 A） |
