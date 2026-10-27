/**
 * UUID v4 生成，含非安全上下文兜底。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）可用。生产环境若通过
 * `http://192.168.x.x` 访问会得到 undefined，因此必须兜底。
 * 见 docs/04-frontend-architecture.md 风险 E.19。
 */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }

  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    // 按 RFC 4122 设置版本号与变体位
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    return formatUuid(bytes)
  }

  // 最后的降级：非密码学随机。仅用于本地开发，且明确告警。
  console.warn(
    '[aitrance-chat] crypto.getRandomValues 不可用，已降级为 Math.random 生成 clientMsgId。' +
      '这会影响幂等键的碰撞概率，请在生产环境使用 HTTPS。',
  )
  const fallback = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    fallback[i] = Math.floor(Math.random() * 256)
  }
  fallback[6] = ((fallback[6] ?? 0) & 0x0f) | 0x40
  fallback[8] = ((fallback[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(fallback)
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = []
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'))
  }
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
