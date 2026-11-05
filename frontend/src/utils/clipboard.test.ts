/**
 * 共享剪贴板工具的单测。
 *
 * 【为什么这些用例值得存在】用户报的缺陷「移动端长按复制消息正文失败」
 * 根因就是 `navigator.clipboard` 在非安全上下文不存在、而没有降级。这类 bug
 * 只在**真实手机 + 内网 http** 上复现，e2e 跑不到（e2e 走 localhost = 安全上下文），
 * 所以行为契约只能在 node 里用 stub 钉住。
 *
 * 四类环境都要覆盖：
 *  1. 安全上下文且成功 → 直接 true，**不碰 DOM**（不能白建 textarea）；
 *  2. `navigator` 整个不存在（老 WebView / SSR）→ 走 textarea 降级；
 *  3. `navigator.clipboard` 是 undefined（非安全上下文）→ 走 textarea 降级；
 *  4. `writeText` 抛异常（权限被拒）→ 走 textarea 降级；
 *  5. 连 DOM 都没有（node / 极端环境）→ 返回 false，绝不抛。
 *
 * 用 `vi.stubGlobal` 而不是直接赋值：测试之间必须能可靠回滚，否则
 * 「有 document」的用例会污染后面的用例（假绿）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_FALLBACK_HINT, writeClipboardText } from '@/utils/clipboard'

/** 假 textarea：只实现 `writeViaTextarea` 真正会碰到的成员。 */
interface FakeTextarea {
  value: string
  style: Record<string, string>
  setAttribute: (name: string, value: string) => void
  select: () => void
}

/**
 * 装一个最小的假 DOM。
 *
 * @param execResult `document.execCommand` 的返回值（模拟浏览器拒绝执行）
 * @param calls      可选输出对象，用来断言「选中的文本是什么」「节点有没有被移除」
 */
function stubDom(
  execResult: boolean,
  calls: { selected?: string; appended?: number; removed?: number; attrs?: Record<string, string> } = {},
): FakeTextarea[] {
  const created: FakeTextarea[] = []
  const doc = {
    createElement: (tag: string) => {
      expect(tag).toBe('textarea')
      const ta: FakeTextarea = {
        value: '',
        style: {},
        setAttribute: (name, value) => {
          if (calls.attrs) calls.attrs[name] = value
        },
        select: () => {
          if (calls.selected !== undefined) calls.selected = ta.value
        },
      }
      created.push(ta)
      return ta
    },
    body: {
      appendChild: () => {
        if (calls.appended !== undefined) calls.appended += 1
      },
      removeChild: () => {
        if (calls.removed !== undefined) calls.removed += 1
      },
    },
    execCommand: () => execResult,
  }
  vi.stubGlobal('document', doc)
  return created
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeClipboardText', () => {
  it('空串直接 false：不碰剪贴板也不碰 DOM', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const createElement = vi.fn()
    vi.stubGlobal('document', { createElement })

    expect(await writeClipboardText('')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(createElement).not.toHaveBeenCalled()
  })

  it('安全上下文：clipboard.writeText 成功 → true，且不创建 textarea', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const createElement = vi.fn()
    vi.stubGlobal('document', { createElement })

    expect(await writeClipboardText('你好')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('你好')
    expect(createElement).not.toHaveBeenCalled()
  })

  it('navigator 整个不存在 → 退到 textarea + execCommand，返回 true', async () => {
    vi.stubGlobal('navigator', undefined)
    const calls = { selected: '', appended: 0, removed: 0, attrs: {} as Record<string, string> }
    const created = stubDom(true, calls)

    expect(await writeClipboardText('正文')).toBe(true)
    expect(created).toHaveLength(1)
    expect(calls.selected).toBe('正文')
    // readonly 必须加上：iOS/安卓上不加会把软键盘顶起来
    expect(calls.attrs.readonly).toBe('')
    // 节点必须摘干净，否则连点复制会越堆越多
    expect(calls.appended).toBe(1)
    expect(calls.removed).toBe(1)
  })

  it('非安全上下文（clipboard 为 undefined）→ 退到 textarea，返回 true', async () => {
    // 这就是手机走 http://<局域网IP>:5173 时的真实形态：navigator 在、clipboard 不在
    vi.stubGlobal('navigator', {})
    stubDom(true)

    expect(await writeClipboardText('手机上的消息')).toBe(true)
  })

  it('writeText 抛异常（权限被拒）→ 退到 textarea，返回 true', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    stubDom(true)

    expect(await writeClipboardText('被拒也要能复制')).toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('execCommand 返回 false → 整体返回 false（由调用方给人工兜底提示）', async () => {
    vi.stubGlobal('navigator', {})
    stubDom(false)

    expect(await writeClipboardText('复制不了')).toBe(false)
  })

  it('没有 document（node/极端环境）→ false，不抛异常', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)

    await expect(writeClipboardText('x')).resolves.toBe(false)
  })

  it('textarea 创建/追加过程中抛异常 → false，不把异常泄给调用方', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('DOM 不可用')
      },
    })

    expect(await writeClipboardText('x')).toBe(false)
  })

  it('兜底提示文案固定（调用方 toast 直接引用，避免各处措辞漂移）', () => {
    expect(CLIPBOARD_FALLBACK_HINT).toBe('复制失败，请长按手动选择文本')
  })
})
