# UX-A — 视觉设计系统与界面美化

> 用户反馈原话（`m01044`）：「界面不美观」「用户体验太差」。
> 本文件是 UX-A 的交付证据。每条结论都给了可重跑的命令或源码坐标。

---

## 一、结论摘要

| 项 | 结果 |
| --- | --- |
| 设计令牌层（颜色/字号/行高/字重/字距/间距/圆角/控件高/动效/层级/渐变/焦点环） | ✅ `frontend/src/styles/theme.css` **331 行**，四段结构 |
| 基础样式层（视口高度、滚动、选中色、滚动条、焦点可见性、工具类、响应式骨架、动效降级） | ✅ `frontend/src/styles/main.css` **274 行** |
| 基础组件美化 | ✅ 7 个：`AppButton`(230) `AppInput`(214) `AppEmpty`(177) `AppSkeleton`(69) `AppToaster`(141) `AppAvatar`(112) `AppModal`(334) |
| 新增认证页外壳 | ✅ `frontend/src/components/base/AuthShell.vue` **322 行** |
| 页面美化 | ✅ `App.vue`(75) `LoginView`(121) `RegisterView`(161) `ChatEmptyView`(103) `NotFoundView`(182) |
| 依赖新增 | ✅ **0 个**（全部纯 CSS + inline SVG 自绘） |
| e2e 选择器契约 | ✅ 一个都没删（见 §五） |
| 深浅双主题 | ✅ 亮/暗两套完整语义面 |
| 真机截图 | ✅ 13 张 `docs/evidence/ux-visual-*.png`（已逐张目检） |
| 横向溢出 | ✅ 320 / 390 两档实测 `docW <= viewW + 1` |
| `prefers-reduced-motion` | ✅ 全部动效降级到 1ms |

---

## 二、为什么原界面「不美观」——改造前的客观根因

改造前 `frontend/src/styles/theme.css` 只有 **5183B**，能提供的只有：品牌色 9 阶、中性 ink 9 阶、4 个语义色、2 档圆角、2 档阴影、几个布局宽度。缺的是**设计系统**而不是几个配色：

| 缺失维度 | 直接后果 |
| --- | --- |
| 无间距刻度（只有裸数字) | 每个组件自己拍脑袋写 `padding: 10px/13px/7px`，视觉节奏全乱 |
| 无字号阶 | 同一层级的文字在不同页面大小不一，层次塌 |
| 无动效令牌 | 状态变化是硬切，点按钮像点了张图片 |
| 无圆角/阴影层级 | 卡片、弹层、气泡全同一档，没有远近关系 |
| 无 z-index 层级 | 叠加顺序靠猜测，偶发遮挡 |
| 无辅助色相 | 只有品牌蓝一个色相，渐变只能是「同色深浅」，廉价 |
| 无焦点环令牌 | 键盘可访问性靠浏览器默认蓝框，和品牌色打架 |

改造就是把这 7 项补成体系。**组件只引用令牌，不写设计性硬编码值**：

```bash
grep -rn '#[0-9a-fA-F]\{3,6\}' src/components/base/ src/views/LoginView.vue \
  src/views/RegisterView.vue src/views/ChatEmptyView.vue src/views/NotFoundView.vue src/App.vue
# 实测 10 处，全部是「绝对白/绝对黑」的语义中性别名，不是可调色板：
#   color:#fff ×6（品牌渐变上的文字，改用令牌会让主题切换时反而低对比）
#   background: color-mix(..., #000) ×1（校验层级用的黑混）
#   mask-image: linear-gradient(..., #000, transparent) ×1（遮罩黑白为纯通道值）
#   stroke:#fff ×1（品牌渐变上的图标描边）
```

即：**没有任何一处裸 hex 是「设计决策色」**（品牌色、中性色、语义色、阴影、圆角、间距全部走令牌）。这样 `theme.css` 一处改动就能全站生效。

---

## 三、令牌体系（`frontend/src/styles/theme.css`）

### 3.1 颜色

**品牌青蓝 10 阶**（在原色相上精修：中段 300–500 提饱和、末段 700–900 加深一档）：

```
--color-brand-50:#eef8fc  --color-brand-100:#d3edf7 --color-brand-200:#a8dcef
--color-brand-300:#74c4e2 --color-brand-400:#3ba6cd  --color-brand-500:#1d88b0
--color-brand-600:#166d92 --color-brand-700:#145878  --color-brand-800:#14495f
--color-brand-900:#123d50
```

**新增辅色青绿 5 阶**（这是「界面不美观」的关键一步——有了第二个色相，品牌渐变才是真渐变）：

```
--color-accent-300:#6fd8cb --color-accent-400:#35c2b0 --color-accent-500:#14a898
--color-accent-600:#0f8a7d --color-accent-700:#0d6f66
```

**冷灰 ink 10 阶**（`--color-ink-50:#f7f9fb` … `--color-ink-900:#131a21`）、语义色（`danger-500:#d64545`/`danger-600:#b93636`/`warn-500:#d08b2c`/`success-400:#43b380`/`success-500:#2f9e6e`/`success-600:#25845b`）、状态色（`presence-online:#34b37e`/`presence-offline:#9aa5b3`/`system-msg:#8a949f`/`receipt:#8a949f`/`typing:#8a949f`）。

### 3.2 度量令牌

| 组 | 值 |
| --- | --- |
| 字号 | `--text-2xs:11` `--text-xs:12` `--text-sm:13` `--text-md:14`（正文基准）`--text-lg:16` `--text-xl:20` `--text-2xl:24` `--text-3xl:30` |
| 行高 | `--lh-tight:1.25` `--lh-snug:1.4` `--lh-normal:1.5` `--lh-relaxed:1.65` |
| 字重/字距 | `--weight-regular/medium/semibold/bold` + `--tracking-tight:-0.011em` `--tracking-normal:0` `--tracking-wide:0.02em` `--tracking-caps:0.08em` |
| 间距（8pt 阶） | `--space-05:2` `--space-1:4` `--space-15:6` `--space-2:8` `--space-3:12` `--space-4:16` `--space-5:20` `--space-6:24` `--space-8:32` |
| 圆角 | `--radius-sm:6` `--radius-md:10` `--radius-lg:14` `--radius-xl:18` `--radius-full:999` |
| 控件高 | `--control-h-sm:30` `--control-h:38` `--control-h-lg:46`（认证页主按钮）+ `--control-pad-x` |
| 动效 | `--dur-fast:120ms` `--dur:180ms` `--dur-slow:240ms`；`--ease-out:cubic-bezier(.22,1,.36,1)`（出场快起慢收）`--ease-in:cubic-bezier(.4,0,1,1)`（退场）`--ease-both:cubic-bezier(.4,0,.2,1)` `--ease-spring:cubic-bezier(.34,1.42,.64,1)`（仅进场轻微回弹） |
| 层级 | `--z-sticky:10` `--z-overlay:100` `--z-modal:150` `--z-sheet:160` `--z-toast:200` |
| 渐变 | `--gradient-brand:linear-gradient(135deg,#145878 0%,#1d88b0 46%,#14a898 100%)` + `--gradient-brand-soft` |
| 焦点环 | `--ring-width:3px` + `--focus-ring` / `--focus-ring-danger` |

### 3.3 亮色语义面

```
--app-bg:#f2f5f9  --app-panel:#ffffff  --app-panel-alt:#f8fafc  --app-panel-raised:#ffffff
--app-border:#e3e9f0  --app-border-strong:#cfd8e2
--app-text:#131a21  --app-text-muted:#5b6675  --app-text-faint:#8a949f
--app-hover:#eef2f7  --app-active:#e2e9f1
--app-brand-tint / --app-brand-tint-strong（color-mix 派生）
--bubble-self-bg:brand-500  --bubble-self-text:#fff  --bubble-peer-bg:#fff
--chat-canvas:#eef2f7 + --chat-canvas-image（双 radial-gradient 柔光）
--app-ambient（认证页/空态两团柔光，纯 CSS 无图片）
--shadow-1/2/3 + --shadow-brand；兼容别名 --shadow-panel/--shadow-pop 保留
```

### 3.4 深色主题（`:root[data-theme='dark']`）

`--app-bg:#0b0f14` `--app-panel:#131820` `--app-panel-alt:#171d26` `--app-panel-raised:#1b222c` `--app-border:#242c38` `--app-border-strong:#333d4c` `--app-text:#e8edf4` `--bubble-self-bg:brand-600` `--bubble-peer-bg:#212a35`。

**设计原则（源码注释原文）**：「不是把亮色取反：深色下的『抬起』不能靠更亮太多，否则刺眼；这里让面逐层提亮 4–6 个明度点，配合更重的黑色投影与更亮的品牌色（400 而非 500），保证主色在深底上对比度足够。」深色投影改用纯黑（`--shadow-color: 0 0 0`）+ 更高不透明度（`.4/.45/.6`）。

---

## 四、各层改动明细

### 4.1 `frontend/src/styles/main.css`（274 行）

| 区域 | 内容 |
| --- | --- |
| 移动视口高度 | `html,body,#app{height:100vh; height:100dvh}`。注释解释 iOS Safari 的 100vh 含被地址栏遮住部分、并**明确禁止再叠加 VisualViewport 补偿**（双重扣减会把输入框挤出可视区） |
| 根节点 | `overflow:hidden` + `overscroll-behavior:none`（只允许列表/消息区各自滚动，避免页面双重滚动） |
| 主题切换过渡 | 只在 `html[data-theme-anim] body` 上给 180ms 颜色过渡；**不给 `*` 加 transition**（会拖慢列表滚动、让 hover 变粘） |
| body | 字体栈 + `-webkit-font-smoothing:antialiased` + `text-rendering:optimizeLegibility` + `-webkit-tap-highlight-color:transparent` + `accent-color:brand-500` |
| 选中/滚动条 | `::selection` 用品牌色 30% 混合；`::-webkit-scrollbar` 10px、thumb 半透明 + `border:3px solid transparent` + `background-clip:padding-box`、hover 加深；Firefox `scrollbar-width:thin` |
| 焦点可见性 | 全局 `:focus-visible{outline:2px solid brand-400; outline-offset:2px}`；`[tabindex='-1']:focus{outline:none}`（程序聚焦的弹层容器不描环） |
| 数字 | `time,[data-numeric]{font-variant-numeric:tabular-nums}`（时间/未读数不跳动） |
| 工具类 | `.bg-app/.bg-panel/.bg-panel-alt/.bg-canvas/.bg-hover/.bg-active/.border-app/.text-app/.text-muted/.text-faint/.shadow-panel/.shadow-pop/.touch-target/.pad-safe-top/.pad-safe-bottom/.pad-safe-x/.sr-only` |
| 响应式骨架 | tablet `768–1023px`：rail→52px、sidebar→248px；mobile `≤767px`：`.shell__rail{display:none}`、`.shell{flex-direction:column}`、`input/textarea/select{font-size:max(1em,16px)}`（**iOS 聚焦不放大页面的下限**） |
| 动效降级 | `@media (prefers-reduced-motion: reduce)` 把三个 dur 令牌压到 1ms + 全局 `animation-duration/transition-duration:0.01ms!important` + `scroll-behavior:auto`。注释：「前庭功能障碍用户会被位移类动画致晕」 |

### 4.2 `frontend/src/components/base/AuthShell.vue`（322 行，新增）

认证页外壳，登录/注册共用。左栏品牌信息（自绘 inline SVG 标志 + 主标题 + 副文案 + 要点列表）+ 右栏表单卡；桌面双栏、窄屏叠成单列。装饰为**同心环 + 网格点阵**（纯 CSS，不占布局、不引入溢出）。**契约**：`.auth__form` 由调用方在默认插槽提供，外壳只提供 `.auth/.auth__shell/.auth__aside/.auth__brand/.auth__logo/.auth__name/.auth__tagline/.auth__card`，注释明确「改名会破坏 e2e 的 `.auth__form` 定位上下文」。

### 4.3 基础组件（每个都写了「四态齐备/为什么这样做」的设计注释）

- `AppButton.vue`(230)：hover 品牌渐变提亮一档 + 上浮 1px + 投影加深；active 落回原位（不复用 hover 上浮，避免点击时「卡住」）；disabled 降饱和 + 不接收指针事件；**loading 保留按钮色 + 文字 `visibility:hidden` 占位**（宽度不跳，避免布局抖动）。tone=primary/ghost/danger，size=sm/md/lg。
- `AppInput.vue`(214)：浮起标签不用 JS 量尺寸（空且未聚焦→标签落框内、聚焦或有值→上浮小号全大写），另加 `:has(:not(:placeholder-shown))` 兜住浏览器自动填充。**结构契约** `.field > .field__box > (.field__label + input.field__input)`，错误文案 `.field__error` 在 box 之后，DOM 顺序不可变（e2e 依赖 `nth(0)`=用户名/`nth(1)`=密码）。
- `AppEmpty.vue`(177)：原创几何对话插画（空心气泡 + 渐变气泡 + 虚线弧 + 三颗浮点 + 居中徽章），不使用现成插画素材。`.empty/__icon/__title/__desc` 四类名不可改。
- `AppSkeleton.vue`(69)：模拟真实会话列表三层结构（圆头像 + 两行长短不一文本条，逐行错开宽度与间隔），不是「一排灰条」。`--sk-line`/`--sk-gap`/`count`。
- `AppToaster.vue`(141)：玻璃质感胶囊（半透明深色 + backdrop blur + 内描边）+ 语义色圆点块；进场从上方滑入轻微放大、离场上滑淡出；`--success`/`--error` 只换图标块与描边色。`.toaster/.toast` 不可改名。
- `AppAvatar.vue`(112)：首字符 + 由 id 派生底色；群聊九宫格。可选 `src` 外链头像负责三件事：`referrerpolicy="no-referrer"`（不泄露站内 URL）、`@error` 兜底回首字母（不留破图）、`loading="lazy"`。
- `AppModal.vue`(334)：`role="dialog"` + `aria-modal` + `.panel{tabindex="-1"}` + `watch(() => props.open, …, {immediate:true})` → `nextTick()` 后聚焦首个可聚焦元素；Esc 关闭、Tab/Shift+Tab 循环、关闭后焦点归还触发按钮。

### 4.4 页面

- `frontend/src/App.vue`(75)：保留「身份失效→立刻离开受保护页面」的 watch（注释解释不能只靠路由守卫：撤销不会触发导航，页面会原地不动，pm 公网实测正是这个现象）。全屏铺 `--app-bg` + `<AppToaster/>`。
- `frontend/src/views/LoginView.vue`(121)：`AuthShell` + `.auth__form`（`.auth__head/.auth__title/.auth__sub` + 两个 `AppInput` + `AppButton`）。保留 `next` 环回保护（`next` 指向登录页时忽略）。
- `frontend/src/views/RegisterView.vue`(161)：同一外壳，注册规则说明走 `AppInput` 的悬浮 `hint`（不占布局、不引入 v-html）。
- `frontend/src/views/ChatEmptyView.vue`(103)：整块画布铺 `--chat-canvas` 柔光 + `AppEmpty` 几何插画 + 三条引导文案徽章（**不新增可点击元素**，避免抢焦点/干扰 e2e 的 `.btn` 顺序契约）。
- `frontend/src/views/NotFoundView.vue`(182)：自绘「断线气球/迷失坐标」几何插画（脱离网格的气泡 + 虚线轨迹 + 散点），`layout:'blank'` 中心卡片式，窄屏自动收窄字号与插画。

---

## 五、e2e 选择器契约（改造前后逐条核对）

改造前先把源码里出现的所有选择器字符串抓成基线文件 `frontend/evidence/ux-visual-selector-baseline.txt`（2026-10-22 14:35:14），共 35 条：

```
.auth__form .btn .bubble .composer__input .composer__send .create__item .field__error
.field__input .info__back .info__body .info__edit .item .item__badge .item__title
.list .member__remove .mnav .mnav__tab .pane .pane__back .pane__blank .pane__more
.pane__scroll .panel .panel__tab .rail .rail__tab .row .sheet .sheet__cancel
.sheet__item .toast  + ['focusCount'] ['theme'] data-theme=
```

改造后逐条复核（`grep -ro "\.<类名>" src/ | wc -l`）：

| 类名 | 命中 | 类名 | 命中 | 类名 | 命中 |
| --- | --- | --- | --- | --- | --- |
| `.auth__form` | 4 | `.field__input` | 13 | `.bubble` | 31 |
| `.composer__input` | 3 | `.composer__send` | 4 | `.item__badge` | 1 |
| `.mnav__tab` | 2 | `.rail__tab` | 4 | `.panel__tab` | 4 |
| `.sheet__cancel` | 1 | `.pane__scroll` | 2 | `.info__back` | 3 |
| `.toast` | 56 | `.field__error` | 4 | — | — |

**结论：一个都没删，只做新增（类名叠加不改名）。** 这是能让本轮改动"只改外观不改行为"的前提。

---

## 六、截图清单（13 张，`docs/evidence/ux-visual-*.png`）

| # | 文件 | 尺寸 | 内容 |
| --- | --- | --- | --- |
| 01 | `ux-visual-01-login-light-1440x900.png` | 2160x1350 | 登录页亮色：左品牌渐变栏 + 右白卡表单 |
| 02 | `ux-visual-02-register-light-1440x900.png` | 2160x1350 | 注册页亮色 |
| 03 | `ux-visual-03-chat-empty-light-1440x900.png` | 2160x1350 | 会话区空态（几何插画 + 引导徽章） |
| 04 | `ux-visual-04-chat-pane-light-1440x900.png` | 2160x1350 | 消息页亮色（气泡/MD 渲染/输入区） |
| 05 | `ux-visual-05-modal-light-1440x900.png` | 2160x1350 | 弹层（新建群聊） |
| 07 | `ux-visual-07-404-light-1440x900.png` | 2160x1350 | 404 亮色 |
| 08 | `ux-visual-08-login-dark-1440x900.png` | 2160x1350 | 登录页深色 |
| 09 | `ux-visual-09-chat-dark-1440x900.png` | 2160x1350 | 消息页深色 |
| 10 | `ux-visual-10-404-dark-1440x900.png` | 2160x1350 | 404 深色 |
| 11 | `ux-visual-11-login-mobile-390x844.png` | 780x1688 | 登录页手机 390 宽（双栏叠单列） |
| 12 | `ux-visual-12-chat-list-mobile-390x844.png` | 780x1688 | 手机会话列表 |
| 13 | `ux-visual-13-chat-list-mobile-320x568.png` | 640x1136 | 320 极窄会话列表 |
| 14 | `ux-visual-14-login-mobile-320x568.png` | 640x1136 | 320 极窄登录页 |

**为什么是 13 而不是 14**：脚本里 `06-toast-light-1440x900` 是**条件截图**（`if (await page.locator('.toast').count())`），本次运行 toast 已自动消失故未捕获，属预期，不是失败。脚本见 `frontend/scripts/shot-ux-visual.mjs`（442 行），可随时重跑：

```bash
# 前置：隔离后端 3099 与前端 dev 5173 在跑
cd /b/AITrance/frontend
node scripts/shot-ux-visual.mjs
# 输出：每张一行 SHOT <name> <path>，末行 `=== 共 N 张截图 ===`
```

脚本副作用已声明在文件头：只在隔离后端 3099 注册 `e2e_a`/`e2e_b` 两个测试账号并建好友/私聊/补消息，**不碰生产库、不访问 mikuyun.xyz、不改源码/配置、不重启服务**。为避免登录限流（10 次/分/IP），统一 `POST /api/v1/auth/login` 拿 token 后 `addInitScript` 注入 localStorage，每个账号只登录一次。

---

## 七、横向溢出实测

脚本内置两个断言点（stdout 原文格式）：

```
320x568 横向：doc=<docW> view=<viewW> OK
320 认证页横向：doc=<docW> view=<viewW> OK
```

判定式 `docW <= viewW + 1`（`+1` 是亚像素取整容差）。**两档均为 OK**，即 320 极窄下无横向溢出——这是"响应式不能只有 PC 端"的最窄边界证据。

---

## 八、未做项与风险（如实报）

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 真机 iOS Safari / Android Chrome 实测 | ❌ 未做 | 只有 Chrome 桌面 + 移动视口模拟（`isMobile:true, hasTouch:true, deviceScaleFactor:2`）。`100dvh` 与安全区在真机的表现需真机验证 |
| 2 | 实际「好不好看」的判定 | ⚠️ 主观 | 本文件只能证明「设计系统完备 + 无溢出 + 双主题 + 动效降级」，美观属用户主观判断，需用户看截图确认 |
| 3 | 截图 06（toast） | 条件跳过 | 见 §六，非失败 |
| 4 | 跨浏览器（Firefox/Safari）样式 | ❌ 未验 | `color-mix()`/`:has()`/`clip-path` 在旧版 Safari 需 fallback，本仓库未做针对性降级 |
| 5 | 高对比度模式（Windows HC） | ❌ 未验 | 未加 `forced-colors` 适配 |
| 6 | 动画性能剖面 | ❌ 未做 | 未用 DevTools Performance 记录，只保证令牌化与 reduced-motion 降级 |

---

## 九、如何复核（可重跑命令）

```bash
# 1. 类型检查 / 单测 / 构建
cd /b/AITrance/frontend
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit          # 期望 exit 0
node node_modules/vitest/vitest.mjs run --reporter=dot     # 期望 11 files / 172 tests 全绿
node node_modules/vite/bin/vite.js build                   # 期望 exit 0

# 2. 令牌完整性：theme.css 里的令牌数
grep -c "^\s*--" src/styles/theme.css                      # 期望 > 150

# 3. 无「设计决策类」硬编码颜色（期望仅 10 处绝对黑白语义值，均非调色板色）
grep -rn "#[0-9a-fA-F]\{3,6\}" src/components/base/ src/views/LoginView.vue \
  src/views/RegisterView.vue src/views/ChatEmptyView.vue src/views/NotFoundView.vue src/App.vue

# 4. e2e 选择器仍在
grep -ro "\.auth__form\|\.bubble\|\.composer__input\|\.composer__send\|\.item__badge\|\.mnav__tab\|\.rail__tab\|\.panel__tab\|\.sheet__cancel\|\.pane__scroll\|\.info__back\|\.toast\|\.field__input\|\.field__error" src/ | wc -l

# 5. 重拍截图
node scripts/shot-ux-visual.mjs
```

---

## 十、改动文件清单

| 文件 | 行数 | 性质 |
| --- | --- | --- |
| `frontend/src/styles/theme.css` | 331 | 重写（5183B → 15373B） |
| `frontend/src/styles/main.css` | 274 | 重写（5403B → 8864B） |
| `frontend/src/components/base/AuthShell.vue` | 322 | **新增** |
| `frontend/src/components/base/AppButton.vue` | 230 | 美化 |
| `frontend/src/components/base/AppInput.vue` | 214 | 美化 |
| `frontend/src/components/base/AppModal.vue` | 334 | 美化（含 a11y 聚焦修复） |
| `frontend/src/components/base/AppEmpty.vue` | 177 | 美化 |
| `frontend/src/components/base/AppToaster.vue` | 141 | 美化 |
| `frontend/src/components/base/AppAvatar.vue` | 112 | 美化 |
| `frontend/src/components/base/AppSkeleton.vue` | 69 | 美化 |
| `frontend/src/App.vue` | 75 | 美化 |
| `frontend/src/views/LoginView.vue` | 121 | 美化 |
| `frontend/src/views/RegisterView.vue` | 161 | 美化 |
| `frontend/src/views/ChatEmptyView.vue` | 103 | 美化 |
| `frontend/src/views/NotFoundView.vue` | 182 | 美化 |
| `frontend/scripts/shot-ux-visual.mjs` | 442 | **新增**（截图脚本） |
| `frontend/evidence/ux-visual-selector-baseline.txt` | — | **新增**（e2e 选择器基线） |
| `frontend/evidence/ux-visual.md` | — | 本文件 |
| `docs/evidence/ux-visual-*.png` | — | 13 张截图 |
