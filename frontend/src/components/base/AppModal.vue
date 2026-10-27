<script setup lang="ts">
/**
 * 居中弹层（桌面）。
 *
 * 【焦点契约】四条联动，缺一条都会让用户「看不见焦点在哪」：
 *   1. 打开瞬间把焦点移进弹层（本轮修：之前焦点一直留在触发按钮上，
 *      键盘用户 Tab 一下才发现焦点还在背后的页面上）；
 *   2. Tab / Shift+Tab 在弹层内循环，不逃到 body（既有行为，保留）；
 *   3. Esc 关闭（既有行为，保留）；
 *   4. **关闭后把焦点还给触发元素**（本轮补：之前这条 e2e 断言之所以 PASS，
 *      是因为焦点从头到尾就没离开过触发按钮 —— 一旦补了第 1 条，没有第 4 条
 *      就会「关掉弹层后焦点掉到 body」，等于用一个缺陷换另一个缺陷」）。
 *
 * 判定逻辑住在 `@/utils/dialogA11y`，与手机底部面板 `MobileNav.vue` 共用同一份，
 * 避免两套实现再次漂移。
 *
 * 【视觉】遮罩用深墨绿蓝 + 背景模糊，开合做「网格淡入 → 面板 scale 0.96→1」的
 * 两段不同节奏；面板顶部一条渐变细线作为品牌锚点。手机上仍是底部抽屉，
 * 改为上滑进场。所有动画都只动 opacity/transform，不动尺寸，故不会破坏
 * 「打开后 500ms 内焦点已在面板内」的既有 e2e 断言。
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import {
  collectFocusables,
  dialogKeyAction,
  initialFocusIndex,
  type DialogKeyAction,
} from '@/utils/dialogA11y'

const props = withDefaults(
  defineProps<{ title: string; open: boolean; width?: number }>(),
  { width: 420 },
)
const emit = defineEmits<{ close: [] }>()

const panelRef = ref<HTMLElement | null>(null)
/** 打开前的焦点位置，关闭时归还。null = 当时没有可归还的元素。 */
let restoreTarget: HTMLElement | null = null

function focusIndexIn(list: HTMLElement[]): number {
  const active = document.activeElement
  if (!active) return -1
  return list.indexOf(active as HTMLElement)
}

function runAction(action: DialogKeyAction, e: KeyboardEvent, list: HTMLElement[]): void {
  if (!action) return
  if (action.type === 'close') {
    e.preventDefault()
    emit('close')
    return
  }
  e.preventDefault()
  const el = action.target === 'first' ? list[0] : list[list.length - 1]
  el?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  const list = collectFocusables(panelRef.value)
  runAction(
    dialogKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      dialogOpen: props.open,
      focusableCount: list.length,
      focusIndex: focusIndexIn(list),
      isComposing: e.isComposing,
    }),
    e,
    list,
  )
}

function restoreFocus(): void {
  const target = restoreTarget
  restoreTarget = null
  // 元素可能已随页面销毁（例如从弹层里触发了跳转），focus 不存在的节点会静默失败，
  // 这里显式判 connected，避免把焦点留在已摘除的节点上。
  if (target && target.isConnected) target.focus()
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      const active = document.activeElement
      restoreTarget = active instanceof HTMLElement ? active : null
      await nextTick()
      const list = collectFocusables(panelRef.value)
      const idx = initialFocusIndex(list.length)
      // idx === -1 时退到容器本身（`.panel` 带 tabindex="-1"），否则焦点会留在触发按钮上。
      if (idx >= 0) list[idx]?.focus()
      else panelRef.value?.focus()
    } else {
      restoreFocus()
    }
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="mask" @click.self="emit('close')">
        <div
          ref="panelRef"
          class="panel"
          :style="{ width: `${width}px` }"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
        >
          <header class="panel__head">
            <h3 class="panel__title">{{ title }}</h3>
            <button class="panel__close" type="button" aria-label="关闭" @click="emit('close')">
              <AppIcon name="close" :size="16" />
            </button>
          </header>
          <div class="panel__body"><slot /></div>
          <footer v-if="$slots.footer" class="panel__foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(14 20 26 / 0.46);
  backdrop-filter: blur(3px) saturate(120%);
  /* 安全区 + 让弹层永远不贴边（否则窄屏上关闭按钮可能被刘海/手势条压住） */
  padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
    calc(16px + var(--safe-bottom)) calc(16px + var(--safe-left));
}

.panel {
  position: relative;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
  /* 宽度同时受「设定宽度」与「视口 - 内边距」约束 */
  max-width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 容器可被程序聚焦（tabindex="-1" 的视觉兜底）；去掉默认 outline 以免开屏就是一框 */
  outline: none;
}

/* 顶部渐变细线：给直角矩形一个「品牌锚点」，比整块渐变底色克制 */
.panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: var(--gradient-brand);
  opacity: 0.9;
  pointer-events: none;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--app-border);
}

.panel__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--app-text);
}

.panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-both),
    color var(--dur-fast) var(--ease-both),
    transform var(--dur-fast) var(--ease-out);
}
.panel__close:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.panel__close:active {
  transform: scale(0.92);
}
.panel__close:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.panel__body {
  padding: var(--space-4);
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  flex: 1;
  min-height: 0;
}

.panel__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--app-border);
  background: var(--app-panel-alt);
}

/* ── 进场：遮罩淡入（较快），面板 scale+位移（稍慢、带回弹）────────
 * 两段节奏差让「浮起」有重量感；都只动 opacity/transform，
 * 不影响布局与焦点计算。 */
.modal-enter-active {
  transition: opacity var(--dur) var(--ease-both);
}
.modal-leave-active {
  transition: opacity var(--dur-fast) var(--ease-both);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active .panel {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur-slow) var(--ease-out);
}
.modal-leave-active .panel {
  transition:
    transform var(--dur-fast) var(--ease-both),
    opacity var(--dur-fast) var(--ease-both);
}
.modal-enter-from .panel {
  opacity: 0;
  transform: scale(0.96) translateY(10px);
}
.modal-leave-to .panel {
  opacity: 0;
  transform: scale(0.985) translateY(4px);
}

/* ── 手机：弹层贴底更适合拇指操作，关闭按钮热区放大 ─────────────── */
@media (max-width: 767px) {
  .mask {
    align-items: flex-end;
    padding: 0;
  }
  .panel {
    width: 100% !important; /* 覆盖传入的 width prop，手机上占满宽度 */
    max-width: 100%;
    /* 顶部留出安全区，避免内容顶到刘海里 */
    max-height: calc(100% - var(--safe-top) - 16px);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding-bottom: var(--safe-bottom);
  }
  .panel::before {
    border-radius: inherit;
  }
  .panel__head {
    padding: var(--space-3) var(--space-4);
  }
  .panel__close {
    min-width: var(--spacing-touch-target);
    min-height: var(--spacing-touch-target);
    margin-right: calc(var(--space-2) * -1);
  }
  /* 手机上从底部上滑，比缩放进场更符合抽屉隐喻 */
  .modal-enter-from .panel {
    opacity: 0;
    transform: translateY(100%);
  }
  .modal-enter-active .panel {
    transition: transform var(--dur-slow) var(--ease-out);
  }
  /* 离场时遮罩不淡出，只让抽屉滑下去 —— 面板是遮罩的子节点，
   * 遮罩一旦 opacity:0 会连带把滑出动画一起藏掉。 */
  .modal-leave-active {
    transition: none;
  }
  .modal-leave-to {
    opacity: 1;
  }
  .modal-leave-to .panel {
    opacity: 1;
    transform: translateY(100%);
  }
  .modal-leave-active .panel {
    transition: transform var(--dur) var(--ease-both);
  }
}

/* 减少动效：只保留一次极短的淡入 */
@media (prefers-reduced-motion: reduce) {
  .modal-enter-from .panel,
  .modal-leave-to .panel {
    transform: none;
  }
}
</style>
