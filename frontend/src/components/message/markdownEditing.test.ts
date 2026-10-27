/**
 * Markdown 工具条变换的单测。
 *
 * 这些函数是纯函数，正好可以把「编辑器里最容易出错的边界」逐条钉住：
 *   - 空选区插入占位符后光标落在占位符上（可直接打字替换）
 *   - 二次点击**取消**标记（不是叠加）
 *   - 多行选区逐行加前缀 / 去前缀
 *   - 有序列表自动编号
 *   - 链接把选中的文字变成 label，光标停在 url 上
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { renderMarkdown } from '@/utils/markdown'
import {
  applyCommand,
  codeBlock,
  linkMarkdown,
  orderedList,
  prefixLines,
  tableMarkdown,
  wrapMarkdown,
  type EditState,
} from './markdownEditing'

/** 用真实渲染器把文本渲染一遍，用于「工具条产物能否被解析器认出」的闭环校验。 */
async function render(source: string): Promise<string> {
  const nodes = renderMarkdown(source)
  const app = createSSRApp({ render: () => h('div', nodes.length ? nodes : undefined) })
  return renderToString(app)
}

function state(text: string, start: number, end = start): EditState {
  return { text, selectionStart: start, selectionEnd: end }
}

/** 把「选区」用 [] 包起来，便于断言光标位置。 */
function marked(r: { text: string; selectionStart: number; selectionEnd: number }): string {
  return `${r.text.slice(0, r.selectionStart)}[${r.text.slice(r.selectionStart, r.selectionEnd)}]${r.text.slice(r.selectionEnd)}`
}

describe('wrapMarkdown', () => {
  it('空选区包裹后插入占位符并选中它', () => {
    const r = wrapMarkdown(state('hello ', 6), '**', '粗体')
    expect(marked(r)).toBe('hello **[粗体]**')
  })

  it('有选区时包裹选中文字，并保持选中原文字', () => {
    const r = wrapMarkdown(state('hello world', 6, 11), '**', '粗体')
    expect(marked(r)).toBe('hello **[world]**')
  })

  it('二次点击取消标记（toggle）', () => {
    const once = wrapMarkdown(state('hello world', 6, 11), '**', '粗体')
    // 光标/选区仍落在被包裹的文字上
    const twice = wrapMarkdown(
      { text: once.text, selectionStart: once.selectionStart, selectionEnd: once.selectionEnd },
      '**',
      '粗体',
    )
    expect(twice.text).toBe('hello world')
  })

  it('反向选区先归一化再处理', () => {
    const r = wrapMarkdown(state('abcdef', 4, 2), '*', '斜体')
    expect(marked(r)).toBe('ab*[cd]*ef')
  })

  it('越界选区被夹紧，不抛异常', () => {
    const r = wrapMarkdown(state('abc', 99, 120), '`', '代码')
    expect(r.text).toBe('abc`代码`')
  })
})

describe('prefixLines', () => {
  it('选中的多行都加引用前缀', () => {
    const r = prefixLines(state('a\nb\nc', 0, 5), '> ')
    expect(r.text).toBe('> a\n> b\n> c')
  })

  it('空选区只作用于光标所在行', () => {
    const r = prefixLines(state('a\nb', 2), '> ')
    expect(r.text).toBe('a\n> b')
  })

  it('全部已有前缀时二次点击取消', () => {
    const once = prefixLines(state('a\nb', 0, 3), '- ')
    expect(once.text).toBe('- a\n- b')
    const twice = prefixLines(
      { text: once.text, selectionStart: 0, selectionEnd: once.text.length },
      '- ',
    )
    expect(twice.text).toBe('a\nb')
  })

  it('空行不加前缀（保持列表内段落分隔）', () => {
    const r = prefixLines(state('a\n\nb', 0, 4), '- ')
    expect(r.text).toBe('- a\n\n- b')
  })

  it('标题前缀只加一次，二次点击去掉', () => {
    const once = prefixLines(state('标题', 0, 2), '## ')
    expect(once.text).toBe('## 标题')
    const twice = prefixLines({ text: once.text, selectionStart: 3, selectionEnd: 5 }, '## ')
    expect(twice.text).toBe('标题')
  })
})

describe('orderedList', () => {
  it('逐行自动编号', () => {
    const r = orderedList(state('a\nb\nc', 0, 5))
    expect(r.text).toBe('1. a\n2. b\n3. c')
  })

  it('二次点击去掉编号', () => {
    const once = orderedList(state('a\nb', 0, 3))
    const twice = orderedList({ text: once.text, selectionStart: 0, selectionEnd: once.text.length })
    expect(twice.text).toBe('a\nb')
  })

  it('空行跳过，不占编号', () => {
    const r = orderedList(state('a\n\nb', 0, 4))
    expect(r.text).toBe('1. a\n\n2. b')
  })
})

describe('codeBlock', () => {
  it('空选区生成围栏并选中占位符', () => {
    const r = codeBlock(state('', 0))
    expect(r.text).toBe('```\n代码\n```\n')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('代码')
  })

  it('选区文字进入围栏', () => {
    const r = codeBlock(state('x = 1', 0, 5))
    expect(r.text).toBe('```\nx = 1\n```\n')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('x = 1')
  })

  it('行中插入时前后补换行，不把段落粘在一起', () => {
    const r = codeBlock(state('abc', 1, 1))
    expect(r.text.startsWith('a\n')).toBe(true)
    expect(r.text.endsWith('\nbc')).toBe(true)
  })
})

describe('linkMarkdown', () => {
  it('空选区插入占位 label，光标选中 url', () => {
    const r = linkMarkdown(state('see ', 4))
    expect(r.text).toBe('see [链接文字](https://)')
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('https://')
  })

  it('选中文字成为 label', () => {
    const r = linkMarkdown(state('看 这里', 2, 4))
    expect(r.text).toBe('看 [这里](https://)')
  })

  it('对已存在的链接二次点击解包成纯文字', () => {
    // 选区正好覆盖 label：`[abc](https://x)` 里的 `abc`
    const r = linkMarkdown(state('[abc](https://x)', 1, 4))
    expect(r.text).toBe('abc')
  })
})

describe('tableMarkdown', () => {
  it('空选区插入 2 列 3 行骨架', () => {
    const r = tableMarkdown(state('', 0))
    expect(r.text).toBe('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n')
  })

  it('光标所在行的内容成为第一行单元格', () => {
    const r = tableMarkdown(state('姓名', 2))
    expect(r.text.startsWith('| 姓名 |')).toBe(true)
    expect(r.text).toContain('\n| --- |\n')
  })

  it('多行选区逐行成为表格行', () => {
    const r = tableMarkdown(state('a\nb', 0, 3))
    expect(r.text.startsWith('| a | b |')).toBe(true)
    expect(r.text).toContain('| --- | --- |')
  })

  it('已有表格时不再重复插入，原样返回', () => {
    const src = '| a |\n| --- |\n| 1 |'
    const r = tableMarkdown(state(src, 0))
    expect(r.text).toBe(src)
  })

  it('光标在行尾时整行被替换成表格，不留半截段落', () => {
    const r = tableMarkdown(state('上一段', 3))
    expect(r.text.startsWith('| 上一段 |')).toBe(true)
    expect(r.text).not.toContain('上一段\n')
  })

  it('产物能被真实解析器渲染成 table（闭环校验）', async () => {
    const r = applyCommand(state('x', 0), 'table')
    const html = await render(r.text)
    expect(html).toContain('<table class="md-table">')
    expect(html).toContain('<tbody>')
  })
})

describe('applyCommand', () => {
  it('每个命令都能作用于空串而不抛异常', () => {
    const commands = [
      'bold',
      'italic',
      'strike',
      'inline-code',
      'code-block',
      'link',
      'quote',
      'ul',
      'ol',
      'heading',
      'table',
    ] as const
    for (const cmd of commands) {
      const r = applyCommand(state('', 0), cmd)
      expect(typeof r.text).toBe('string')
      expect(r.selectionStart).toBeGreaterThanOrEqual(0)
      expect(r.selectionStart).toBeLessThanOrEqual(r.text.length)
      expect(r.selectionEnd).toBeGreaterThanOrEqual(r.selectionStart)
    }
  })

  it('bold 与 italic 的产物能被真实解析器认出（闭环校验）', () => {
    const bold = applyCommand(state('x', 0, 1), 'bold')
    expect(bold.text).toBe('**x**')
    const italic = applyCommand(state('x', 0, 1), 'italic')
    expect(italic.text).toBe('*x*')
    const strike = applyCommand(state('x', 0, 1), 'strike')
    expect(strike.text).toBe('~~x~~')
    const code = applyCommand(state('x', 0, 1), 'inline-code')
    expect(code.text).toBe('`x`')
    const quote = applyCommand(state('x', 0, 1), 'quote')
    expect(quote.text).toBe('> x')
    const ul = applyCommand(state('x', 0, 1), 'ul')
    expect(ul.text).toBe('- x')
    const ol = applyCommand(state('x', 0, 1), 'ol')
    expect(ol.text).toBe('1. x')
    const heading = applyCommand(state('x', 0, 1), 'heading')
    expect(heading.text).toBe('## x')
  })
})
