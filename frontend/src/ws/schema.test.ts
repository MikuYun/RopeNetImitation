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
import {
  zInboundEnvelope,
  zMessage,
  zMessageUpdatedData,
  zPostEventData,
  zReadyData,
} from './schema'

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
    // 0.3.0 起 protocolVersion = 2；仍按宽松数字校验（不锁死具体值，便于灰度）
    expect(zReadyData.safeParse({ userId: 'u1', protocolVersion: 2 }).success).toBe(true)
  })

  /*
   * 灰度期兼容性是 v2 契约里最容易踩坏的一条，单独守：
   *   - 旧后端的帧没有 attachments/recalled/recalledAt/replyTo（甚至只有单数
   *     `attachment`），`.default()` 必须把它们补齐成空值，否则整帧被拒 → 丢消息
   *   - `attachment`（单数）必须仍是 optional，不能删（删了旧帧一样被拒）
   */
  it('v1 旧帧（无 attachments/recalled/replyTo）能通过并被补默认值', () => {
    const oldMsg = {
      msgId: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      clientMsgId: null,
      seq: 1,
      type: 'text',
      content: 'hi',
      createdAt: '2026-10-22T12:00:00.000Z',
    }
    const parsed = zMessage.safeParse(oldMsg)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.attachments).toEqual([])
      expect(parsed.data.recalled).toBe(false)
      expect(parsed.data.recalledAt).toBeNull()
      expect(parsed.data.replyTo).toBeNull()
    }
  })

  it('v2 消息形状：video/mixed type、附件数组、撤回与引用字段', () => {
    const att = {
      id: 'a1',
      name: 'v.mp4',
      mimeType: 'video/mp4',
      size: 1024,
      kind: 'video',
      url: '/api/v1/uploads/a1',
      createdAt: '2026-10-22T12:00:00.000Z',
    }
    const msg = {
      msgId: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      clientMsgId: null,
      seq: 2,
      type: 'mixed',
      content: '看这个',
      attachments: [att],
      recalled: true,
      recalledAt: '2026-10-22T12:00:10.000Z',
      replyTo: { msgId: 'm0', senderId: 'u2', senderName: 'Bob', preview: '原文' },
      createdAt: '2026-10-22T12:00:00.000Z',
    }
    expect(zMessage.safeParse(msg).success).toBe(true)
    // 附件 kind 只有 image/video/file 三个合法值
    expect(zMessage.safeParse({ ...msg, attachments: [{ ...att, kind: 'audio' }] }).success).toBe(
      false,
    )
  })

  it('message.updated 两种载荷形态都接受（{message} 与 {conversationId,message}）', () => {
    const message = {
      msgId: 'm1',
      conversationId: 'c1',
      senderId: 'u1',
      clientMsgId: null,
      seq: 1,
      type: 'text',
      content: 'hi',
      createdAt: '2026-10-22T12:00:00.000Z',
    }
    expect(zMessageUpdatedData.safeParse({ message }).success).toBe(true)
    expect(zMessageUpdatedData.safeParse({ conversationId: 'c1', message }).success).toBe(true)
    expect(zMessageUpdatedData.safeParse({}).success).toBe(false)
  })

  it('post.* 事件载荷为 {postId, actorId}', () => {
    expect(zPostEventData.safeParse({ postId: 'p1', actorId: 'u2' }).success).toBe(true)
    expect(zPostEventData.safeParse({ postId: 'p1' }).success).toBe(false)
  })
})
