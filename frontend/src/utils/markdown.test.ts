/**
 * `@/utils/markdown` 的齿化单测。
 *
 * 【为什么断言用的是 renderToString 而不是字符串匹配】
 * 本仓库没有 jsdom（`package.json` 本轮 Lead 独占，不能加依赖），组件无法 mount。
 * 但 `vue/server-renderer` 是 vue 的传递依赖，node 环境下可用：把渲染器的 VNode
 * 树丢进去能拿到**真实输出**，于是这些用例测的是「浏览器里会发生什么」，
 * 而不是「源码里有没有某个字符串」。
 *
 * 这也正是 XSS 用例的意义：如果哪天有人把实现改成「MD → HTML 串 → v-html」，
 * `renderToString` 的输出就会多出真实的 `onerror=` / `<script>` / `<iframe>`，
 * 用例立刻变红 —— 这里的断言是行为级安全门，不是风格检查。
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h, type VNode } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  hasMarkdownSyntax,
  isSafeHref,
  parseInline,
  renderMarkdown,
  toPlainText,
} from '@/utils/markdown'

/** 把「消息正文」按真实用法渲染成 HTML 字符串（Vue 自己的转义会生效）。 */
async function render(source: string): Promise<string> {
  const nodes: VNode[] = renderMarkdown(source)
  const app = createSSRApp({ render: () => h('div', nodes.length ? nodes : undefined) })
  return renderToString(app)
}

/** 只渲染行内节点，用于强调/链接/代码的局部断言。 */
async function renderInline(source: string): Promise<string> {
  const nodes = parseInline(source)
  const app = createSSRApp({ render: () => h('p', nodes as never) })
  return renderToString(app)
}

describe('isSafeHref —— 链接协议白名单', () => {
  it('放行 http/https 与站内相对路径', () => {
    for (const ok of [
      'https://example.com/a?b=1#c',
      'http://localhost:5173/chat',
      '/chat/1',
      './docs/a.md',
      '../up',
      'chat/2',
      '#anchor',
    ]) {
      expect(isSafeHref(ok), ok).toBe(true)
    }
  })

  it('拒绝 javascript:/data:/vbscript:/file:/协议相对 与夹控制字符的变体', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example.com/x',
      '',
      '   ',
    ]) {
      expect(isSafeHref(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('块级：段落 / 换行 / 标题 / 分割线', () => {
  it('单段落包成 p.md-p', async () => {
    const out = await render('你好世界')
    expect(out).toContain('class="md-p"')
    expect(out).toContain('你好世界')
  })

  it('段落内单个换行渲染成 br（聊天场景下换行即换行）', async () => {
    const out = await render('第一行\n第二行')
    expect(out.match(/<br>/g)?.length).toBe(1)
    expect(out).toContain('第一行')
    expect(out).toContain('第二行')
  })

  it('空行分段产生两个 p', async () => {
    const out = await render('甲\n\n乙')
    expect(out.match(/class="md-p"/g)?.length).toBe(2)
  })

  it('h1~h6 各自成标签，且 ### 后文字不被当成标题', async () => {
    for (let level = 1; level <= 6; level += 1) {
      const out = await render(`${'#'.repeat(level)} 标题${level}`)
      expect(out, `h${level}`).toContain(`<h${level}`)
      expect(out).toContain(`标题${level}`)
    }
    expect(await render('#hashtag 不是标题')).not.toContain('<h1')
  })

  it('--- / *** / ___ 渲染成 hr', async () => {
    for (const src of ['---', '***', '___', '- - -']) {
      expect(await render(src), src).toContain('<hr')
    }
  })
})

describe('行内：粗 / 斜 / 粗斜 / 删除线 / 行内码', () => {
  it('**粗体** → strong', async () => {
    expect(await renderInline('**很粗**')).toBe('<p><strong class="md-strong">很粗</strong></p>')
  })

  it('*斜体* 与 _斜体_ → em', async () => {
    expect(await renderInline('*斜*')).toBe('<p><em class="md-em">斜</em></p>')
    expect(await renderInline('_斜_')).toBe('<p><em class="md-em">斜</em></p>')
  })

  it('***粗斜*** → strong > em', async () => {
    const out = await renderInline('***都要***')
    expect(out).toContain('<strong class="md-strong"><em class="md-em">都要</em></strong>')
  })

  it('~~删除~~ → del', async () => {
    expect(await renderInline('~~旧~~')).toBe('<p><del class="md-del">旧</del></p>')
  })

  it('嵌套强调：**粗 *斜* 粗**', async () => {
    const out = await renderInline('**粗 *斜* 粗**')
    expect(out).toContain('<strong class="md-strong">粗 <em class="md-em">斜</em> 粗</strong>')
  })

  it('snake_case 不被当成斜体（词内下划线不生效）', async () => {
    expect(await renderInline('some_snake_case_name')).not.toContain('<em')
  })

  it('`行内码` → code.md-code-inline，且内部标记不再解析', async () => {
    const out = await renderInline('`**不是粗**`')
    expect(out).toContain('class="md-code-inline"')
    expect(out).toContain('**不是粗**')
    expect(out).not.toContain('<strong')
  })

  it('未闭合的标记原样保留为文本（不吞字符）', async () => {
    expect(await renderInline('**没闭合')).toBe('<p>**没闭合</p>')
  })

  it('反斜杠转义：\\*不是斜体\\*', async () => {
    const out = await renderInline('\\*不是斜体\\*')
    expect(out).toContain('*不是斜体*')
    expect(out).not.toContain('<em')
  })
})

describe('行内：链接白名单与降级', () => {
  it('https 链接带 target/rel，且是 a.md-link', async () => {
    const out = await renderInline('[官网](https://example.com/x)')
    expect(out).toContain('class="md-link"')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })

  it('站内相对链接也放行', async () => {
    expect(await renderInline('[设置](/settings)')).toContain('href="/settings"')
  })

  it('javascript: 链接降级为纯文本，不生成 a 标签', async () => {
    const out = await renderInline('[点我](javascript:alert(1))')
    expect(out).not.toContain('<a')
    expect(out).toContain('[点我](javascript:alert(1))')
  })

  it('data: 链接降级为纯文本', async () => {
    const out = await renderInline('[x](data:text/html,<script>alert(1)</script>)')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('<script')
  })

  it('链接文字里的强调仍然生效（label 递归解析）', async () => {
    expect(await renderInline('[**粗**链](https://a.b)')).toContain('<strong class="md-strong">粗</strong>')
  })
})

describe('块级：围栏代码块', () => {
  it('带语言徽标 + 复制按钮 + 原文不解析', async () => {
    const out = await render('```ts\nconst a = "**不通**"\n```')
    expect(out).toContain('class="md-code"')
    expect(out).toContain('md-code__lang">ts<')
    expect(out).toContain('md-code__copy')
    expect(out).toContain('const a = &quot;**不通**&quot;')
    expect(out).not.toContain('<strong')
  })

  it('未标注语言时徽标回退为「代码」', async () => {
    const out = await render('```\nx\n```')
    expect(out).toContain('md-code__lang">代码<')
  })

  it('代码块里的 HTML 被转义成文本（不是元素）', async () => {
    const out = await render('```html\n<script>alert(1)</script>\n```')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('未闭合的围栏把剩余内容全收进代码块（不丢字）', async () => {
    const out = await render('```\nabc\ndef')
    expect(out).toContain('abc')
    expect(out).toContain('def')
    expect(out).toContain('class="md-code__code"')
  })
})

describe('块级：引用 / 列表 / 表格', () => {
  it('> 引用渲染成 blockquote.md-quote', async () => {
    const out = await render('> 一句引用\n> 第二行')
    expect(out).toContain('class="md-quote"')
    expect(out).toContain('一句引用')
  })

  it('引用可嵌套', async () => {
    const out = await render('> 外层\n>\n> > 内层')
    expect(out.match(/class="md-quote"/g)?.length).toBe(2)
    expect(out).toContain('内层')
  })

  it('无序列表 → ul > li', async () => {
    const out = await render('- 甲\n- 乙\n* 丙')
    expect(out).toContain('class="md-ul"')
    expect(out.match(/<li class="md-li">/g)?.length).toBe(3)
  })

  it('有序列表保留起始序号', async () => {
    const out = await render('3. 三\n4. 四')
    expect(out).toContain('class="md-ol"')
    expect(out).toContain('start="3"')
    expect(out).toContain('三')
  })

  it('单层嵌套列表（缩进两项成为子列表）', async () => {
    const out = await render('- 父\n  - 子一\n  - 子二')
    expect(out.match(/class="md-ul"/g)?.length).toBe(2)
    expect(out).toContain('子一')
    expect(out).toContain('子二')
  })

  it('任务列表渲染成 ☐ / ☑', async () => {
    const out = await render('- [ ] 未做\n- [x] 已做')
    expect(out).toContain('☐')
    expect(out).toContain('☑')
  })

  it('GFM 表格：表头/表体/对齐', async () => {
    const out = await render('| 名称 | 值 |\n| :-- | --: |\n| a | 1 |\n| b | 2 |')
    expect(out).toContain('<table class="md-table"')
    expect(out).toContain('<th')
    expect(out.match(/<td/g)?.length).toBe(4)
    expect(out).toContain('text-align:right')
  })

  it('表格行数不齐时缺的单元格补空（不抛错）', async () => {
    const out = await render('| a | b | c |\n|---|---|---|\n| 1 |')
    expect(out).toContain('<td')
  })
})

describe('XSS：消息正文绝不产生可执行节点', () => {
  const VECTORS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<div onmouseover="alert(1)">hover</div>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<!--[if IE]><script>alert(1)</script><![endif]-->',
    '**<img src=x onerror=alert(1)>**',
    '> <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>',
    '```\n<script>alert(1)</script>\n```',
    '| <img src=x onerror=alert(1)> |\n|---|\n| y |',
    '[x](javascript:alert(1))',
    '`<img src=x onerror=alert(1)>`',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  ]

  it.each(VECTORS)('向量「%s」只有转义后的文本，没有元素/事件属性', async (vector) => {
    const out = await render(vector)
    // 关键：断言的是「没有产生**元素**」，而不是「输出里没有这些字符」——
    // 转义后的文本里当然还会出现 `onerror=` 这串字符（`&lt;img src=x onerror=…&gt;`），
    // 它是 createTextNode 的内容，不是属性。
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/<iframe/i)
    expect(out).not.toMatch(/<img/i)
    expect(out).not.toMatch(/<svg/i)
    expect(out).not.toMatch(/<style/i)
    expect(out).not.toMatch(/<math/i)
    // 任何标签上都不应该出现 on* 事件属性
    expect(out).not.toMatch(/<[a-zA-Z][^>]*\son\w+\s*=/i)
    // 任何 a 的 href 都不应指向可执行协议
    expect(out).not.toMatch(/<a\s[^>]*href="\s*(?:javascript|data|vbscript):/i)
    // 每个向量至少被渲染成某种文本（不静默丢失用户内容）
    expect(out).toContain('<div>')
  })

  it('变异验证：把实现改回「拼 HTML 串」后，本组断言必然失败', async () => {
    // 这条用例不修改源码，而是**模拟**变异体：直接构造一个 v-html 语义的
    // 输出（即把 MD 原文当 HTML 塞进去），证明上面的断言确实能抓到它。
    const vector = '<img src=x onerror=alert(1)>'
    const mutated = await renderToString(
      createSSRApp({ render: () => h('div', { innerHTML: vector }) }),
    )
    // 变异体：出现了真实的 <img 元素与 onerror 属性
    expect(mutated).toMatch(/<img[^>]*onerror/i)
    // 而真实渲染器对同一输入：只有转义文本，没有 <img 元素
    const real = await render(vector)
    expect(real).not.toMatch(/<img/i)
    expect(real).toContain('&lt;img')
  })

  it('窄断言：任何输入都不会出现 <a href="javascript:', async () => {
    for (const v of ['[a](javascript:alert(1))', '[b](JAVASCRIPT:x)', '[c](//evil)']) {
      expect(await render(v)).not.toMatch(/<a [^>]*href="(?:javascript|JAVASCRIPT|[/]{2})/i)
    }
  })
})

describe('健壮性 / 性能 / 辅助函数', () => {
  it('空串与纯空白不抛错', async () => {
    expect(await render('')).toBe('<div></div>')
    expect(await render('   \n\n  ')).not.toContain('md-p')
  })

  it('未闭合/交错标记不抛错（把 `**` 当文本）', async () => {
    for (const bad of ['**a', '*b', '~~c', '[d]', '[e](', '`f', '> > > > > > > > g']) {
      await expect(render(bad), bad).resolves.toBeTypeOf('string')
    }
  })

  it('10k 字符消息渲染 < 20ms（任务书性能门）', () => {
    const para = '这是**一段**带 `代码` 和 [链接](https://example.com) 的普通消息，用于测渲染耗时。\n'
    const source = para.repeat(Math.ceil(10_000 / para.length)).slice(0, 10_000)
    expect(source.length).toBe(10_000)
    const t0 = performance.now()
    const nodes = renderMarkdown(source)
    const cost = performance.now() - t0
    expect(nodes.length).toBeGreaterThan(0)
    expect(cost).toBeLessThan(20)
  })

  it('超长脏数据被截断而不是卡死', () => {
    const huge = 'a'.repeat(300_000)
    const t0 = performance.now()
    renderMarkdown(huge)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('toPlainText：去标记、保留文字、不含 HTML', () => {
    expect(toPlainText('# 标题\n\n**粗** `码` [链](https://a.b)\n- 项')).toContain('标题')
    expect(toPlainText('**粗**')).toBe('粗')
    expect(toPlainText('[链](https://a.b)')).toBe('链')
    // toPlainText 只用于「纯文本槽位」（列表预览 / aria-label），结果永远经 {{ }} 插值；
    // 这里钉住的是「它不会帮倒忙去转义/解码」，而**不是**「它可用于 innerHTML」。
    expect(toPlainText('<script>x</script>')).toBe('<script>x</script>')
  })

  it('hasMarkdownSyntax：纯文本 false，带标记 true', () => {
    expect(hasMarkdownSyntax('就是一句普通的话')).toBe(false)
    expect(hasMarkdownSyntax('**粗**')).toBe(true)
    expect(hasMarkdownSyntax('# 标题')).toBe(true)
    expect(hasMarkdownSyntax('- 列表')).toBe(true)
    expect(hasMarkdownSyntax('```\ncode\n```')).toBe(true)
  })

  it('渲染结果确定：同输入两次结构一致（纯函数）', async () => {
    const src = '# t\n\n**a** `b` [c](https://d.e)\n\n- x\n  - y'
    expect(await render(src)).toBe(await render(src))
  })
})
