/**
 * WebSocket 协议常量。
 *
 * 关闭码与超时参数集中在此，改动只需动这一处。
 * 基准：backend/API.md §6（v0.2.0）+ docs/contract/diff-report.md §2.5
 */

/**
 * 信封 `v` 字段版本。
 *
 * 只用于两处：握手 URL 的 `?v=`（后端 `app.ts` 只接受 '1'）与入站信封 `env.v` 比对
 * （不匹配则服务端以 4002 关闭）。**它不是业务协议版本**，不要因为升 API 就改它。
 */
export const WS_ENVELOPE_VERSION = 1 as const

/**
 * 业务协议版本（`ready.data.protocolVersion`）。
 *
 * 后端 0.3.0 起 ready 帧发 `protocolVersion: 2`，但信封 `v` 仍是 1 —— 两者是独立演进的
 * 两件事，混用一个常量会让「升业务协议」把「信封校验」一起打死（表现为一连上就 4002 断连）。
 */
export const WS_PROTOCOL_VERSION = 2 as const

/** 关闭码。基准：backend/API.md §6 关闭码表（v0.2.0）。 */
export const WS_CLOSE = {
  /** 不支持二进制帧 —— 客户端缺陷，修正为 JSON 文本帧 */
  BINARY_UNSUPPORTED: 1003,
  /** 非正常断连或心跳超时 —— 指数退避并获取新票据 */
  ABNORMAL: 1006,
  /** 超连接数或超帧频 —— 退避重连，**不能据此登出** */
  POLICY_VIOLATION: 1008,
  /** 帧过大 —— 检查客户端 */
  MESSAGE_TOO_BIG: 1009,
  /** 慢消费者 —— 退避重连并 sync */
  TRY_AGAIN_LATER: 1013,
  /** ticket 缺失/格式错误/失效/已用 —— 申请新票据后重连 */
  TICKET_INVALID: 4001,
  /** 不支持的 v —— 提示刷新前端，不盲目重连 */
  PROTOCOL_MISMATCH: 4002,
  /** session 过期/注销 —— 停止自动重连，清登录状态，**禁止对失效 token 调 refresh** */
  SESSION_EXPIRED: 4003,
} as const

/**
 * 应用层心跳间隔。传输层由浏览器每 30 秒 ping，服务端连续下一轮无 pong 则终止。
 * 这里额外发应用层 ping 以维持代理链路活性。
 */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** 看门狗：任意帧都算活性；超过 2× 心跳零帧则强制重连。 */
export const WATCHDOG_FACTOR = 2

/** 指数退避序列（毫秒），最后一档为上限。 */
export const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

/** 退避抖动比例（±）。 */
export const BACKOFF_JITTER = 0.2

/** 连续失败多少次后向用户提示「网络异常」。 */
export const RECONNECT_WARN_THRESHOLD = 10

/** session 到期前多久触发静默续期。后端建议过期前 60 秒。 */
export const SESSION_REFRESH_LEAD_MS = 60_000

/** typing 上报节流：后端建议最多每 2 秒一次，这里取 2.5s 留余量。 */
export const TYPING_THROTTLE_MS = 2_500

/** 停止输入多久后发 stop。 */
export const TYPING_IDLE_MS = 5_000

/** 收到 typing active=true 后的本地展示超时（后端建议 5 秒无更新即移除）。 */
export const TYPING_DISPLAY_TTL_MS = 5_000

/** 单条消息文本上限，与后端一致。 */
export const MESSAGE_TEXT_MAX = 4_000

/** 单帧上限 4 KiB —— 超限会被服务端以 1009 断开。 */
export const WS_FRAME_MAX_BYTES = 4 * 1024
