/**
 * 返回导航 —— 手机顶部返回按钮的逻辑。
 *
 * 【为什么不能直接用 router.back()】用户直接打开深链（或刷新后）浏览器历史里
 * 没有站内上一页，back() 会把人退到站外、退到原主站，或者干脆什么都不发生。
 * 任务书 §三要求「必须有站内列表回退」。
 *
 * 【为什么也不无脑 push】如果当前确实是从列表点进来的，back() 更符合系统
 * 手势与用户预期，而且不会让历史栈无限增长（列表↔会话来回点几次就会堆一摞）。
 *
 * 所以按「本次会话里是否已经发生过站内跳转」二选一：
 *   - 有 → router.back()
 *   - 无 → router.push(显式目标)
 *
 * 判定依据是 afterEach 的计数：初次导航（冷启动/刷新）计 1，
 * 之后每跳一次 +1。>1 即说明用户确实在站内走动过。
 */
import type { RouteLocationRaw, Router } from 'vue-router'

let routeChanges = 0

/** 由 router 在 afterEach 里调用。见 router/index.ts。 */
export function countRouteChange(): void {
  routeChanges += 1
}

/** 站内是否已有上一页可退。 */
export function hasInAppHistory(): boolean {
  return routeChanges > 1
}

/** 仅供测试重置。 */
export function resetNavigationHistory(): void {
  routeChanges = 0
}

/**
 * 返回一步。
 *
 * @param router   路由实例
 * @param fallback 站内回退目标（历史里没有站内上一页时使用）
 */
export function goBack(router: Router, fallback: RouteLocationRaw): void {
  if (hasInAppHistory()) {
    router.back()
    // 历史里可能确实退不动（例如被外部页面顶掉），补一个兜底：
    // 下一帧若 URL 没变，说明 back 没生效，改走显式跳转。
    const before = router.currentRoute.value.fullPath
    window.setTimeout(() => {
      if (router.currentRoute.value.fullPath === before) {
        void router.replace(fallback)
      }
    }, 120)
    return
  }
  void router.replace(fallback)
}
