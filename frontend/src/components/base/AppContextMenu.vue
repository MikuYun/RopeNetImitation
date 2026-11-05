<script setup lang="ts">
/**
 * 全局唯一的右键菜单（PC）。
 *
 * 【为什么是单例、挂在 App.vue】右键可能发生在页面空白处、图片上、消息气泡上，
 * 三处的菜单项不同，但**任何时候只应该有一个菜单**。若每处各渲染一份，
 * 就会出现两层叠着、或「点外面只关了自己那份」的错位。所以菜单本体只此一个，
 * 状态（坐标 + 菜单项）住在 `stores/ui` 的 `contextMenu` 里，任何组件
 * 调 `ui.openContextMenu(x, y, items)` 都替换同一份状态。
 *
 * 【定位：先渲染，再量，最后夹进视口】菜单宽高取决于文案（中文比英文宽，
 * 有 hint 比没 hint 宽），预估值会让贴边处跳一下。所以流程是：
 *   v-if 挂载 → 先摆在鼠标点且 `visibility: hidden` → `nextTick` 量真实尺寸 →
 *   `clampMenuPosition` 校正 → 显形。用户只会看到菜单一次落地，没有跳动。
 *
 * 【焦点契约】打开即把焦点交给第一项（`AppModal` 同一套约定）；↑↓ 移动、
 * Enter/空格 触发、Esc / Tab / 点击外部 / 滚动 / resize 一律关闭。
 * 不做「关闭后归还焦点」—— 右键菜单是被动弹出的，触发它的是一次鼠标点击，
 * 归还焦点到 body 反而会让键盘用户找不到落点；点外部关闭时焦点本来就已经
 * 跟着鼠标走了。
 *
 * 【样式纪律】只用主题 CSS 变量（`--app-*` / `--color-*` / `--shadow-*` /
 * `--z-*` / `--space-*` / `--radius-*` / `--text-*`），不写任何硬编码颜色，
 * 否则 7 套主题（含 custom 内联变量）切过去就会花。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { clampMenuPosition, type ContextMenuItem } from '@/utils/contextMenu'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()

const menuRef = ref<HTMLElement | null>(null)
/** 校正后的落点（视口坐标，对应 position: fixed 的 left/top）。 */
const pos = ref({ x: 0, y: 0 })
/** 是否已量完并定位。false 时菜单不可见，避免先闪一下再跳位。 */
const positioned = ref(false)
/** 当前键盘高亮项在 items 里的下标（-1 = 无）。 */
const activeIndex = ref(-1)

/** 打开时的锚点。单独存一份：菜单项可能被判 hidden 过滤，但锚点不会变。 */
let anchor = { x: 0, y: 0 }

const items = computed<ContextMenuItem[]>(() => ui.contextMenu?.items ?? [])

/** 可键盘命中的项（禁用项跳过，与原生菜单一致）。 */
function navigableIndexes(): number[] {
  const list: number[] = []
  items.value.forEach((item, index) => {
    if (item.disabled !== true) list.push(index)
  })
  return list
}

function focusItem(index: number): void {
  const safe = items.value[index]
  if (!safe || safe.disabled === true) return
  activeIndex.value = index
  const el = menuRef.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  el?.focus()
}

function close(): void {
  ui.closeContextMenu()
}

function activate(index: number): void {
  const item = items.value[index]
  if (!item || item.disabled === true) return
  close()
  // 动作可能异步（下载图片、写剪贴板），不 await —— 菜单已经关了，
  // 失败由动作自己 toast，阻塞在这里只会留下一个「点了没反应的菜单」。
  if (item.run) void item.run()
}

/** 量尺寸 → 校正落点 → 显形 → 聚焦第一项。 */
async function place(): Promise<void> {
  positioned.value = false
  await nextTick()
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  pos.value = clampMenuPosition(
    anchor.x,
    anchor.y,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
  )
  positioned.value = true
  await nextTick()
  focusItem(navigableIndexes()[0] ?? -1)
}

watch(
  () => ui.contextMenu,
  (state) => {
    if (!state) {
      positioned.value = false
      activeIndex.value = -1
      return
    }
    anchor = { x: state.x, y: state.y }
    pos.value = { ...anchor }
    void place()
  },
  { immediate: true },
)

/* ── 关闭条件：键盘 / 点击外部 / 滚动 / 窗口尺寸变化 ────────────── */

function onKeydown(e: KeyboardEvent): void {
  if (!ui.contextMenu) return
  // 中文输入法组合中的按键不算快捷键（与 AppModal 的判定保持一致）
  if (e.isComposing) return

  const list = navigableIndexes()
  const current = list.indexOf(activeIndex.value)

  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Tab') {
    // 不拦默认行为：菜单不是模态层，焦点继续往下走才符合「轻量弹层」的预期，
    // 但菜单本身必须收起，否则它会孤零零挂在屏幕上。
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (list.length === 0) return
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    // current === -1（焦点在容器上）时：↓ 去第一个，↑ 去最后一个
    const next = current === -1 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length
    focusItem(list[next] ?? -1)
    return
  }
  if (e.key === 'Home' || e.key === 'End') {
    if (list.length === 0) return
    e.preventDefault()
    focusItem(list[e.key === 'Home' ? 0 : list.length - 1] ?? -1)
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (activeIndex.value < 0) return
    e.preventDefault()
    activate(activeIndex.value)
  }
}

/** 点击菜单外部（含右键在别处）关闭。 */
function onPointerDown(e: PointerEvent): void {
  if (!ui.contextMenu) return
  const el = menuRef.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  close()
}

/** 滚动时关闭 —— 菜单位置是相对视口算的，页面一滚就会「脱离」内容。 */
function onScroll(): void {
  if (ui.contextMenu) close()
}

function onResize(): void {
  if (ui.contextMenu) close()
}

/** 右键新位置时先关旧的（浏览器在菜单上右键会再触发一次 contextmenu）。 */
function onContextMenuWhileOpen(): void {
  if (ui.contextMenu) close()
}

window.addEventListener('keydown', onKeydown)
window.addEventListener('pointerdown', onPointerDown, true)
window.addEventListener('scroll', onScroll, true)
window.addEventListener('resize', onResize)
window.addEventListener('contextmenu', onContextMenuWhileOpen, true)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('contextmenu', onContextMenuWhileOpen, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.contextMenu"
      ref="menuRef"
      class="ctx-menu"
      role="menu"
      aria-label="操作菜单"
      tabindex="-1"
      :style="{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        visibility: positioned ? 'visible' : 'hidden',
      }"
      @contextmenu.prevent
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        class="ctx-menu__item"
        :class="{ 'is-danger': item.danger === true, 'is-disabled': item.disabled === true }"
        type="button"
        role="menuitem"
        tabindex="-1"
        :data-index="index"
        :data-id="item.id"
        :aria-disabled="item.disabled === true ? 'true' : undefined"
        @click="activate(index)"
        @pointerenter="item.disabled === true ? undefined : (activeIndex = index)"
      >
        <span class="ctx-menu__label">{{ item.label }}</span>
        <span v-if="item.hint" class="ctx-menu__hint">{{ item.hint }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  /* 盖住气泡/工具条，但低于确认弹层（--z-modal）与 toast —— 菜单不该压住
   * 它自己触发的确认框。 */
  z-index: calc(var(--z-modal, 150) + 1);
  min-width: 168px;
  max-width: 280px;
  padding: var(--space-1) 0;
  background: var(--app-panel-raised);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  outline: none;
  /* 菜单不参与文本选择：拖选会让「点一项」变成「选中一片」 */
  user-select: none;
  animation: ctx-in var(--dur-fast) var(--ease-out);
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(-2px);
  }
}

.ctx-menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--control-h-sm);
  padding: var(--space-15) var(--space-3);
  border: none;
  background: transparent;
  color: var(--app-text);
  font-family: inherit;
  font-size: var(--text-md);
  line-height: var(--lh-snug);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-both);
}

.ctx-menu__item:hover:not(.is-disabled),
.ctx-menu__item:focus-visible {
  background: var(--app-hover);
}

.ctx-menu__item:hover:not(.is-disabled) {
  /* 键盘高亮与 hover 用同一底色，避免「鼠标悬停 A、键盘焦点在 B」两块高亮 */
  outline: none;
}

.ctx-menu__item:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-brand-500) 46%, transparent);
}

.ctx-menu__item.is-danger {
  color: var(--color-danger-500);
}

.ctx-menu__item.is-danger:hover:not(.is-disabled),
.ctx-menu__item.is-danger:focus-visible {
  background: color-mix(in srgb, var(--color-danger-500) 12%, transparent);
}

.ctx-menu__item.is-disabled {
  color: var(--app-text-faint);
  cursor: not-allowed;
}

.ctx-menu__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-menu__hint {
  flex: 0 0 auto;
  color: var(--app-text-faint);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-wide);
}

/* 减少动效：不做缩放位移，直接出现 */
@media (prefers-reduced-motion: reduce) {
  .ctx-menu {
    animation: none;
  }
}
</style>
