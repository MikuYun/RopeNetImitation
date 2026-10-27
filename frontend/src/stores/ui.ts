import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/* ============================================================================
 * 主题系统
 * ----------------------------------------------------------------------------
 * 两层概念，别混：
 *   theme     —— 主题 id（7 个），决定 <html data-theme>，配色由 theme.css 的
 *                预置块提供；'custom' 时由本文件把用户配色写成**内联 CSS 变量**。
 *   themeMode —— 语义明暗（只有 light/dark），决定 <html data-theme-mode>。
 *                Tailwind 的 dark: 变体与既有深色覆盖一律只认它。
 * 这样新增彩主题时不必回头改任何一条 dark: 选择器 —— 这是本文件最重要的一条
 * 设计约束（见 docs/v2/UI-V2.md §2）。
 * ========================================================================== */

export type ThemeId = 'light' | 'dark' | 'ocean' | 'forest' | 'sakura' | 'midnight' | 'custom'
export type ThemeMode = 'light' | 'dark'
export type RailTab = 'chats' | 'contacts'
export type ProfileDrawerStage = 'brief' | 'full'
export type CustomBgMode = 'solid' | 'gradient' | 'image'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

/**
 * 自定义主题的全部可调项。
 * 字段名/顺序与 docs/v2/UI-V2.md §2 的持久化格式一一对应，**不要随意改名**
 * （改名等于让所有老用户的 localStorage 失效）。
 */
export interface CustomTheme {
  /** 主色 hex，如 '#1d88b0' */
  primary: string
  /** 聊天区背景 hex */
  chatCanvas: string
  bubbleSelfBg: string
  bubbleSelfText: string
  bubblePeerBg: string
  bubblePeerText: string
  /** 面板/侧栏背景 hex —— 同时用于自动判定明暗（见 themeMode） */
  panelBg: string
  /** 主文字色 hex */
  textColor: string
  bgMode: CustomBgMode
  /** bgMode==='gradient' 时的第二个色 */
  bgValue2?: string
  /** bgMode==='image' 时的外链（只允许 https）或空 */
  imageUrl?: string
}

export const THEME_IDS: ThemeId[] = [
  'light',
  'dark',
  'ocean',
  'forest',
  'sakura',
  'midnight',
  'custom',
]

export const THEME_LABELS: Record<ThemeId, string> = {
  light: '浅色',
  dark: '深色',
  ocean: '海洋',
  forest: '森林',
  sakura: '樱花',
  midnight: '午夜',
  custom: '自定义',
}

/**
 * 预置主题的语义明暗。
 *
 * 'custom' 这一项只是**静态兜底**：真实值由 customTheme.panelBg 的相对亮度
 * 现算（见 themeMode computed），因为用户可以把面板调成任意明度。
 */
export const THEME_MODES: Record<ThemeId, ThemeMode> = {
  light: 'light',
  dark: 'dark',
  ocean: 'light',
  forest: 'light',
  sakura: 'light',
  midnight: 'dark',
  custom: 'light',
}

const THEME_KEY = 'aitrance.theme'
export const CUSTOM_THEME_KEY = 'aitrance.theme.custom'

/* ── 颜色工具 ─────────────────────────────────────────────────────────
 * 只做两件事：hex 解析（严格校验，因为值会被塞进 style.setProperty，
 * 必须挡掉任意字符串注入）+ WCAG 相对亮度。 */

const HEX_RE = /^#[0-9a-f]{6}$/i

function parseHex(hex: string): [number, number, number] | null {
  if (!HEX_RE.test(hex)) return null
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return [r, g, b]
}

function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度（0=纯黑，1=纯白）。非法 hex 视为纯白，避免算出负值。 */
function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 1
  const [r, g, b] = rgb
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/**
 * 是否是「暗底」。阈值 0.5 是按任务书约定的 WCAG 相对亮度切分：
 * >0.5 判亮，<=0.5 判暗。它比「人眼感知中灰」偏保守（会把中灰判成暗），
 * 但方向正确 —— 判错的代价只是自动字色取浅色，仍可读。
 */
function isDarkHex(hex: string): boolean {
  return relativeLuminance(hex) <= 0.5
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT_DEFAULT_TEXT = '#131a21'
const DARK_DEFAULT_TEXT = '#e8edf4'

/**
 * 面板底色变了，字色要跟着翻 —— 否则用户把面板调黑、字色还留在默认的
 * #131a21，整页就「黑底黑字」了。规则：
 *   1. 用户没动过字色（还留着另一套模式的默认值）→ 直接自适应；
 *   2. 用户自己挑的字色与面板对比度 <3:1 → 也自适应（那种情况实际上不可读）；
 *   3. 其余一律尊重用户选择。
 */
function effectiveText(panelBg: string, textColor: string): string {
  const dark = isDarkHex(panelBg)
  const fallback = dark ? DARK_DEFAULT_TEXT : LIGHT_DEFAULT_TEXT
  if (!parseHex(textColor)) return fallback
  const picked = textColor.toLowerCase()
  if (dark && picked === LIGHT_DEFAULT_TEXT) return fallback
  if (!dark && picked === DARK_DEFAULT_TEXT) return fallback
  if (contrastRatio(panelBg, textColor) < 3) return fallback
  return textColor
}

/* ── 自定义主题：默认值与持久化 ───────────────────────────────────── */

function defaultCustomTheme(): CustomTheme {
  return {
    primary: '#1d88b0',
    chatCanvas: '#eef2f7',
    bubbleSelfBg: '#1d88b0',
    bubbleSelfText: '#ffffff',
    bubblePeerBg: '#ffffff',
    bubblePeerText: '#131a21',
    panelBg: '#ffffff',
    textColor: '#131a21',
    bgMode: 'solid',
  }
}

function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/\S+$/i.test(value.trim())
}

/**
 * 把所有入口（localStorage / 组件 patch）收敛到一处校验。
 * 内联 CSS 变量等于「用字符串拼 CSS」，imageUrl 尤其危险（url(...) 里可以
 * 塞任意东西），所以这里白名单式地重造对象，绝不做「透传」。
 */
function sanitizeCustom(input: Partial<CustomTheme>): CustomTheme {
  const base = defaultCustomTheme()
  const panelBg = hexOr(input.panelBg, base.panelBg)
  const bgMode: CustomBgMode =
    input.bgMode === 'gradient' || input.bgMode === 'image' ? input.bgMode : 'solid'
  const imageUrl = isHttpsUrl(input.imageUrl) ? input.imageUrl.trim() : ''
  const bgValue2 = hexOr(input.bgValue2, '')
  const next: CustomTheme = {
    primary: hexOr(input.primary, base.primary),
    chatCanvas: hexOr(input.chatCanvas, base.chatCanvas),
    bubbleSelfBg: hexOr(input.bubbleSelfBg, base.bubbleSelfBg),
    bubbleSelfText: hexOr(input.bubbleSelfText, base.bubbleSelfText),
    bubblePeerBg: hexOr(input.bubblePeerBg, base.bubblePeerBg),
    bubblePeerText: hexOr(input.bubblePeerText, base.bubblePeerText),
    panelBg,
    textColor: hexOr(input.textColor, base.textColor),
    bgMode,
  }
  if (bgValue2) next.bgValue2 = bgValue2
  if (imageUrl) next.imageUrl = imageUrl
  return next
}

function readTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved !== null && (THEME_IDS as string[]).includes(saved)) return saved as ThemeId
  } catch {
    /* 隐私模式 / 存储被禁用：回落到默认 */
  }
  return 'light'
}

function readCustomTheme(): CustomTheme {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY)
    if (raw === null) return defaultCustomTheme()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultCustomTheme()
    return sanitizeCustom(parsed as Partial<CustomTheme>)
  } catch {
    /* 解析失败说明是脏数据，直接用默认，避免整站起不来 */
    return defaultCustomTheme()
  }
}

/* ── 内联变量的名字表 ────────────────────────────────────────────────
 * 一张表两处用：写入前清空、写入。用 as const + Record 让 TS 强制
 * 「表里有名字 ⇔ 有值」，避免以后新增变量时漏清（漏清会串主题）。 */
const CUSTOM_VARS = [
  '--color-brand-300',
  '--color-brand-400',
  '--color-brand-500',
  '--color-brand-600',
  '--color-brand-700',
  '--color-accent-400',
  '--color-accent-500',
  '--color-accent-600',
  '--gradient-brand',
  '--app-bg',
  '--app-panel',
  '--app-panel-alt',
  '--app-panel-raised',
  '--app-border',
  '--app-border-strong',
  '--app-text',
  '--app-text-muted',
  '--app-text-faint',
  '--app-hover',
  '--app-active',
  '--app-brand-tint',
  '--app-brand-tint-strong',
  '--bubble-self-bg',
  '--bubble-self-text',
  '--bubble-peer-bg',
  '--bubble-peer-text',
  '--chat-canvas',
  '--chat-canvas-image',
  '--app-ambient',
  '--shadow-brand',
  '--shadow-color',
] as const

type CustomVarName = (typeof CUSTOM_VARS)[number]

/** 聊天画布的底纹：纯色 / 渐变 / 图片三选一 */
function canvasImage(c: CustomTheme): string {
  if (c.bgMode === 'gradient') {
    return `linear-gradient(160deg, ${c.chatCanvas}, ${c.bgValue2 ?? c.chatCanvas})`
  }
  if (c.bgMode === 'image' && c.imageUrl) {
    return `url(${c.imageUrl}) center/cover no-repeat`
  }
  return 'none'
}

/**
 * 从用户配色派生整套变量。
 * 派生而不是让用户填 20 个色：面板/边界/hover/淡字全部由「面板底 + 字色」
 * 用 color-mix 算出来，保证永远是同一套明度阶梯（否则用户填出花来必崩）。
 */
function customVarValues(c: CustomTheme): Record<CustomVarName, string> {
  const dark = isDarkHex(c.panelBg)
  const text = effectiveText(c.panelBg, c.textColor)
  const panel = c.panelBg
  return {
    '--color-brand-300': `color-mix(in srgb, ${c.primary} 68%, #ffffff)`,
    '--color-brand-400': `color-mix(in srgb, ${c.primary} 88%, #ffffff)`,
    '--color-brand-500': c.primary,
    '--color-brand-600': `color-mix(in srgb, ${c.primary} 88%, #000000)`,
    '--color-brand-700': `color-mix(in srgb, ${c.primary} 74%, #000000)`,
    '--color-accent-400': `color-mix(in srgb, ${c.primary} 62%, #ffffff)`,
    '--color-accent-500': `color-mix(in srgb, ${c.primary} 88%, #ffffff)`,
    '--color-accent-600': `color-mix(in srgb, ${c.primary} 84%, #000000)`,
    '--gradient-brand': `linear-gradient(135deg, color-mix(in srgb, ${c.primary} 74%, #000000) 0%, ${c.primary} 46%, color-mix(in srgb, ${c.primary} 66%, #ffffff) 100%)`,
    '--app-bg': `color-mix(in srgb, ${panel} 92%, #000000)`,
    '--app-panel': panel,
    '--app-panel-alt': `color-mix(in srgb, ${panel} 96%, ${text})`,
    '--app-panel-raised': dark ? `color-mix(in srgb, ${panel} 92%, ${text})` : panel,
    '--app-border': `color-mix(in srgb, ${text} 14%, ${panel})`,
    '--app-border-strong': `color-mix(in srgb, ${text} 26%, ${panel})`,
    '--app-text': text,
    '--app-text-muted': `color-mix(in srgb, ${text} 64%, ${panel})`,
    '--app-text-faint': `color-mix(in srgb, ${text} 46%, ${panel})`,
    '--app-hover': `color-mix(in srgb, ${text} 7%, ${panel})`,
    '--app-active': `color-mix(in srgb, ${text} 12%, ${panel})`,
    '--app-brand-tint': `color-mix(in srgb, ${c.primary} 14%, ${panel})`,
    '--app-brand-tint-strong': `color-mix(in srgb, ${c.primary} 24%, ${panel})`,
    '--bubble-self-bg': c.bubbleSelfBg,
    '--bubble-self-text': c.bubbleSelfText,
    '--bubble-peer-bg': c.bubblePeerBg,
    '--bubble-peer-text': c.bubblePeerText,
    '--chat-canvas': c.chatCanvas,
    '--chat-canvas-image': canvasImage(c),
    '--app-ambient': `radial-gradient(60% 55% at 18% 12%, color-mix(in srgb, ${c.primary} 16%, transparent) 0%, transparent 70%), radial-gradient(55% 50% at 88% 88%, color-mix(in srgb, ${c.primary} 10%, transparent) 0%, transparent 70%)`,
    '--shadow-brand': `0 6px 18px color-mix(in srgb, ${c.primary} 30%, transparent)`,
    '--shadow-color': dark ? '0 0 0' : '19 30 45',
  }
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeId>(readTheme())
  const customTheme = ref<CustomTheme>(readCustomTheme())

  /**
   * 语义明暗。所有 dark: 变体与旧深色覆盖都挂在这个值上，
   * 所以「切到 midnight」和「切到 dark」对它们毫无区别 —— 这正是目的。
   */
  const themeMode = computed<ThemeMode>(() =>
    theme.value === 'custom'
      ? isDarkHex(customTheme.value.panelBg)
        ? 'dark'
        : 'light'
      : THEME_MODES[theme.value],
  )

  const railTab = ref<RailTab>('chats')
  const toasts = ref<Toast[]>([])
  const groupCreateOpen = ref(false)
  const globalError = ref<string | null>(null)

  /**
   * 手机端「更多」面板。
   * 迁移期保留（fe-profile 正在把主题/退出登录搬进个人信息抽屉），
   * 新代码不要再依赖它，否则下次删不掉。
   */
  const moreSheetOpen = ref(false)

  /** 个人信息抽屉（桌面从侧栏头像打开，移动端从底部导航第三位打开） */
  const profileDrawerOpen = ref(false)
  const profileDrawerStage = ref<ProfileDrawerStage>('brief')

  /** 退出登录二次确认（破坏性操作，必须收一次确认） */
  const logoutConfirmOpen = ref(false)

  /**
   * 会话草稿。convId -> 未发送文本。
   *
   * 【为什么放在 store 而不是组件里】手机端列表与正文**互斥渲染**：
   * 从正文返回列表时 MessagePane 会被卸载。若草稿存在组件的局部 ref 里，
   * 用户切出去看一眼列表再回来，打了一半的字就没了。
   * 存在 store 里则跨断点、跨导航都保留（任务书 §三「保留草稿」）。
   */
  const drafts = ref<Map<string, string>>(new Map())

  let toastSeq = 0

  function clearCustomVars(): void {
    const root = document.documentElement
    for (const name of CUSTOM_VARS) root.style.removeProperty(name)
  }

  /**
   * 把当前主题落到 <html>。
   *
   * 必须在 mount 之前调用一次（main.ts），否则首帧会用 :root 的亮色闪一下。
   * 非 custom 主题要**主动清空**上一轮的内联变量：内联样式优先级高于任何
   * 选择器，残留一条就会让新主题「缺一个角」。
   */
  function applyTheme(): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.dataset['theme'] = theme.value
    root.dataset['themeMode'] = themeMode.value
    clearCustomVars()
    if (theme.value !== 'custom') return
    const values = customVarValues(customTheme.value)
    for (const name of CUSTOM_VARS) root.style.setProperty(name, values[name])
  }

  function setTheme(next: ThemeId): void {
    theme.value = THEME_IDS.includes(next) ? next : 'light'
    try {
      localStorage.setItem(THEME_KEY, theme.value)
    } catch {
      /* 忽略：存不进去不影响本次会话 */
    }
    applyTheme()
  }

  function persistCustom(): void {
    try {
      localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(customTheme.value))
    } catch {
      /* 忽略 */
    }
  }

  /** 合并式更新：ThemePicker 里每个 color input 都走这里，天然支持实时预览 */
  function setCustomTheme(patch: Partial<CustomTheme>): void {
    customTheme.value = sanitizeCustom({ ...customTheme.value, ...patch })
    persistCustom()
    if (theme.value === 'custom') applyTheme()
  }

  function resetCustomTheme(): void {
    customTheme.value = defaultCustomTheme()
    persistCustom()
    if (theme.value === 'custom') applyTheme()
  }

  /**
   * 保留的快捷开关：只在「浅色 / 深色」之间来回。
   * 判断依据是 themeMode 而不是 theme —— 用户当前可能在 midnight，
   * 按一下应该回到浅色，而不是回到「他上次用的那套彩主题」。
   */
  function toggleTheme(): void {
    setTheme(themeMode.value === 'dark' ? 'light' : 'dark')
  }

  function toast(text: string, tone: Toast['tone'] = 'info'): void {
    toastSeq += 1
    const item: Toast = { id: toastSeq, text, tone }
    toasts.value = [...toasts.value, item]
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== item.id)
    }, 3_200)
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function setRailTab(tab: RailTab): void {
    railTab.value = tab
  }

  /* ── 草稿 ─────────────────────────────────────────────────────── */

  function draftOf(conversationId: string): string {
    return drafts.value.get(conversationId) ?? ''
  }

  function setDraft(conversationId: string, text: string): void {
    if (!conversationId) return
    const next = new Map(drafts.value)
    if (text) next.set(conversationId, text)
    else next.delete(conversationId)
    // 整体替换：Map 内部变更不会自动追踪，必须换引用
    drafts.value = next
  }

  function clearDraft(conversationId: string): void {
    setDraft(conversationId, '')
  }

  /** 注销/换账号时清空全部草稿 —— 草稿是上一个账号的会话内容。 */
  function clearDrafts(): void {
    drafts.value = new Map()
  }

  /* ── 更多面板 ─────────────────────────────────────────────────── */

  function openMore(): void {
    moreSheetOpen.value = true
  }

  function closeMore(): void {
    moreSheetOpen.value = false
  }

  /* ── 个人信息抽屉 / 退出确认 ──────────────────────────────────── */

  function openProfileDrawer(): void {
    profileDrawerStage.value = 'brief'
    profileDrawerOpen.value = true
  }

  function closeProfileDrawer(): void {
    profileDrawerOpen.value = false
  }

  function setProfileDrawerStage(stage: ProfileDrawerStage): void {
    profileDrawerStage.value = stage
  }

  function openLogoutConfirm(): void {
    logoutConfirmOpen.value = true
  }

  function closeLogoutConfirm(): void {
    logoutConfirmOpen.value = false
  }

  return {
    theme,
    themeMode,
    customTheme,
    railTab,
    toasts,
    groupCreateOpen,
    globalError,
    moreSheetOpen,
    profileDrawerOpen,
    profileDrawerStage,
    logoutConfirmOpen,
    drafts,
    applyTheme,
    setTheme,
    toggleTheme,
    setCustomTheme,
    resetCustomTheme,
    toast,
    dismissToast,
    setRailTab,
    draftOf,
    setDraft,
    clearDraft,
    clearDrafts,
    openMore,
    closeMore,
    openProfileDrawer,
    closeProfileDrawer,
    setProfileDrawerStage,
    openLogoutConfirm,
    closeLogoutConfirm,
  }
})
