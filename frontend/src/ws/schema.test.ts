/**
 * schema 模块的副作用守卫。
 *
 * 本文件不测具体字段（那由 backend/API.md 与 e2e 覆盖），只守一件事：
 * `schema.ts` 必须在**构造任何 schema 之前**调用 `z.config({ jitless: true })`。
 * 少了这一句，zod 会在 object schema 上跑 `new Function('')` 探针生成 JIT
 * 快编译器 —— 功能正常，但严格 CSP（script-src 'self'，无 'unsafe-eval'）下
 * 浏览器会记一条 securitypolicyviolation。真实浏览器裁决见
 * backend/evidence/csp-browser-check.mjs（读 frontend/dist）。
 *
 * 与 `schema.eval-probe.test.ts` 的分工：这里是**静态**引入，验证模块副作用
 * 已生效；那边是**动态**引入 + Function 记账代理，验证构造期真的零探针。
 * 必须拆两个文件 —— 同文件内的静态 import 会先求值完模块，代理就装晚了。
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
// 只为触发模块副作用；同时确认 schema 确实可照常使用
import { zInboundEnvelope, zMessage, zReadyData } from './schema'

describe('ws/schema CSP 兼容性', () => {
  it('导入 schema 模块后 zod 处于 jitless 模式', () => {
    // zod 的 globalConfig 是模块级单例，schema.ts 的顶层 config 调用会改到它
    expect(z.core.globalConfig.jitless).toBe(true)
  })

  it('jitless 下 schema 仍能正常校验（解释模式不改变语义）', () => {
    const env = {
      v: 1,
      id: 'evt-1',
      type: 'message.created',
      timestamp: '2026-10-22T12:00:00.000Z',
      data: {},
    }
    expect(zInboundEnvelope.safeParse(env).success).toBe(true)

    const msg = {
      msgId: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      clientMsgId: null,
      seq: 1,
      type: 'text',
      content: 'hi',
      createdAt: '2026-10-22T12:00:00.000Z',
    }
    expect(zMessage.safeParse(msg).success).toBe(true)
    // 反向用例：脏数据仍被拦住（证明不是「配置关掉后校验失效」）
    expect(zMessage.safeParse({ ...msg, seq: -1 }).success).toBe(false)
    expect(zMessage.safeParse({ ...msg, type: 'unknown' }).success).toBe(false)
  })

  it('ready 帧的宽松策略未被 jitless 影响', () => {
    expect(zReadyData.safeParse({ userId: 'u1', extraFutureField: 'x' }).success).toBe(true)
    expect(zReadyData.safeParse({}).success).toBe(false)
  })
})
