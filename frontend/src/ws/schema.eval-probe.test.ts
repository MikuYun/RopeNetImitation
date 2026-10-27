/**
 * 反向证据：`schema.ts` 在构造 schema 期间**不得**触发 zod 的 eval 探针。
 *
 * 上一个文件断言的是「config 已生效」；但 config 生效 ≠ 探针没跑 ——
 * 只要 `z.config({ jitless: true })` 晚于任何一次 `z.object(...)`，
 * 那批 schema 照样会跑 `new Function('')`。这里把全局 `Function` 换成记账代理，
 * 在**零 schema 已加载**的干净模块图里动态引入 schema.ts，直接数调用次数。
 *
 * 之所以单独成文件：本文件顶层不能静态 import schema（那样 import 会先于
 * 代理安装执行），而 vitest 默认按文件隔离模块图，所以这里拿到的是新实例。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ws/schema 构造期不得触发 eval 探针', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('动态引入 schema.ts 全程零次 new Function', async () => {
    const calls: string[] = []
    const RealFunction = globalThis.Function
    const Spy = new Proxy(RealFunction, {
      construct(target, args) {
        calls.push(String(args[0] ?? ''))
        return Reflect.construct(target, args)
      },
      apply(target, thisArg, args) {
        calls.push(String(args[0] ?? ''))
        return Reflect.apply(target, thisArg, args)
      },
    })
    vi.stubGlobal('Function', Spy)

    try {
      const mod = await import('./schema')
      // schema 确实建出来了（否则「零调用」可能只是没执行）
      expect(typeof mod.zInboundEnvelope.safeParse).toBe('function')
      expect(mod.zMessage.safeParse(mod.zMessage.parse({
        msgId: 'm1',
        conversationId: 'c1',
        senderId: 'u1',
        seq: 1,
        type: 'text',
        content: 'hi',
        createdAt: '2026-10-22T12:00:00.000Z',
      })).success).toBe(true)
    } finally {
      vi.stubGlobal('Function', RealFunction)
    }

    expect(calls).toEqual([])
  })
})
