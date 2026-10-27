/**
 * 会话代际（session epoch）—— 账号切换时的隔离边界。
 *
 * 【要解决的问题】登出时只清 token 是不够的：其余 store（会话、消息、好友、
 * 在线状态）里还留着**上一个账号的数据**，而且更麻烦的是**在途请求**：
 *
 *   - 注销瞬间已经发出的 REST 请求仍在飞，回来后会往 store 里写；
 *   - WS 的 onmessage 回调可能在 `stop()` 之后才跑到；
 *   - ticket 申请的重试定时器可能在新账号登录后才触发。
 *
 * 后果就是 pm 实测到的那条：注销后 URL 还停在 `/chat/chat/:id`、私密气泡
 * 还在屏幕上；更糟的是**下一个账号登录后会看到上一个账号的残留数据**。
 *
 * 【做法】一个单调递增的整数。每次「身份边界」变化（登出、会话失效、
 * 换账号登录）就 +1。所有异步回调在写 store 之前先比对自己出发时的代数，
 * 不一致就丢弃。这比逐个取消请求简单，也不会漏掉定时器与 WS 回调。
 */
import { ref } from 'vue'

const epoch = ref(0)

/** 当前代际。异步操作在开始时取一份，回来时比对。 */
export function currentEpoch(): number {
  return epoch.value
}

/** 推进代际：宣告「从现在起，之前出发的异步结果一律作废」。 */
export function bumpEpoch(): number {
  epoch.value += 1
  return epoch.value
}

/**
 * 包一层异步操作，让它只在**同一代际**内生效。
 *
 * @param fn 实际操作；只有代际未被推进时才会执行
 * @returns 代际已过期时返回 undefined，调用方据此提前退出
 *
 * 用法：
 *   const r = await withEpoch(async () => api.fetchFriends())
 *   if (r === undefined) return   // 期间登出了，丢弃
 */
export async function withEpoch<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const gen = currentEpoch()
  const result = await fn()
  if (gen !== currentEpoch()) return undefined
  return result
}

/** 判断某个出发时记录的代际是否仍然有效。 */
export function epochValid(gen: number): boolean {
  return gen === currentEpoch()
}
