import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark'
export type RailTab = 'chats' | 'contacts'

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

const THEME_KEY = 'aitrance.theme'

function readTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* 忽略 */
  }
  return 'light'
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>(readTheme())
  const railTab = ref<RailTab>('chats')
  const toasts = ref<Toast[]>([])
  const groupCreateOpen = ref(false)
  const globalError = ref<string | null>(null)

  /**
   * 手机端「更多」面板（主题 / 退出登录的落点）。
   * 手机上底部导航只留两个 tab，这两个入口必须仍然可达（任务书 §三）。
   */
  const moreSheetOpen = ref(false)

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

  function applyTheme(): void {
    document.documentElement.dataset['theme'] = theme.value
  }

  function setTheme(next: ThemeMode): void {
    theme.value = next
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* 忽略 */
    }
    applyTheme()
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
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

  return {
    theme,
    railTab,
    toasts,
    groupCreateOpen,
    globalError,
    moreSheetOpen,
    drafts,
    applyTheme,
    setTheme,
    toggleTheme,
    toast,
    dismissToast,
    setRailTab,
    draftOf,
    setDraft,
    clearDraft,
    clearDrafts,
    openMore,
    closeMore,
  }
})
