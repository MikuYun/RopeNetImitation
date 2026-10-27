/**
 * 极小子集 Markdown 渲染器 —— **纯 TS，把 Markdown 直接编译成 VNode**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么这里没有 v-html，也永远不会有】
 *
 * 1. 安全边界：本应用把 opaque token 存在 localStorage（`stores/auth.ts`），
 *    一旦允许消息正文注入 HTML，一条消息就能读走 token —— XSS 的影响面被
 *    放大成「账号完全接管」。消息正文是**完全不可信**的输入（对方设备、对方
 *    客户端、中间人、历史脏数据都能决定它的每一个字节），所以它绝不能进入
 *    HTML 解析器。
 * 2. 工程边界：只要出现「MD 字符串 → HTML 字符串 → innerHTML」这条链，就一定
 *    存在一个需要靠「清洗」兜底的点；清洗是黑名单，黑名单在 HTML 这个语法
 *    上永远列不全（`<svg><animate onbegin=…>`、`<math>` 命名空间、实体二次
 *    解码、mXSS…）。本实现的链是「MD 字符串 → VNode 树」，**全程没有任何
 *    一步产生 HTML 字符串**：文本一律作为 VNode 的字符串子节点交给 Vue，
 *    Vue 在 patch 时用 createTextNode 落地，压根没有解析 HTML 的机会。
 * 3. 属性也是：链接的 href/target/rel 由本文件白名单生成，用户输入的 URL
 *    不会成为 HTML 属性源码；`javascript:` / `data:` / 协议相对 `//host`
 *    一律**降级成纯文本**（连 a 标签都不生成）。
 *
 * 结论：这里的「安全」不是靠过滤，而是靠**构造性不可达**（construction-safe）。
 * 单测 `markdown.test.ts` 用 `renderToString` 对真实 VNode 做齿化断言，
 * 并且有一条「变异验证」用例保证：一旦有人往链路里塞 HTML 串，测试必红。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 【支持的子集】（与任务书 §零 一致）
 *   块级：段落 / 软换行(<br>) / `#`~`######` 标题 / ``` 围栏代码块（语言徽标+复制）
 *        / `>` 引用（可嵌套） / 有序、无序列表（支持一层嵌套、任务列表）
 *        / `---` 分割线 / GFM 表格（对齐） / 空行分段
 *   行内：`**粗**`、`*斜*`、`***粗斜***`、`~~删除~~`、`` `行内码` ``、
 *        `[文本](https://…)`、反斜杠转义
 *   不支持（按设计）：原始 HTML 透传、图片语法、脚注、HTML 实体、自动链接。
 *     ——「不支持」意味着**原样显示为文本**，绝不做 HTML 解析。
 */
import { defineComponent, h, onBeforeUnmount, ref, type VNode } from 'vue'

export interface MarkdownRenderOptions {
  /** 代码块复制按钮文案。 */
  copyLabel?: string
  /** 复制成功后的按钮文案。 */
  copiedLabel?: string
  /** 代码块缺少语言标注时的徽标文案。 */
  codeLabel?: string
}

/** 单条消息最多解析多少字符（防御性上限，避免超长脏数据卡住主线程）。 */
const MAX_SOURCE_LENGTH = 200_000
/** 行内/块级递归深度上限（`> > > >` 之类）。 */
const MAX_DEPTH = 6

/* ────────────────────────────── 剪贴板 ────────────────────────────── */

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 权限被拒 / 非安全上下文：继续走 DOM 兜底 */
  }
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 代码块右上角的复制按钮。
 *
 * 用 `defineComponent` 而不是「在渲染函数里塞闭包」的原因：复制成功的
 * 「已复制」回显是一个**局部 UI 状态**，必须能被组件自身的 ref 承载，
 * 否则每次渲染都会被父级覆盖。它依然是纯 TS + h()，不产生任何 HTML 串。
 */
const CopyButton = defineComponent({
  name: 'MdCopyButton',
  props: {
    code: { type: String, required: true },
    label: { type: String, default: '复制' },
    doneLabel: { type: String, default: '已复制' },
  },
  setup(props) {
    const done = ref(false)
    let timer: ReturnType<typeof setTimeout> | null = null
    onBeforeUnmount(() => {
      if (timer) clearTimeout(timer)
    })
    async function copy(): Promise<void> {
      if (!(await writeClipboard(props.code))) return
      done.value = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        done.value = false
        timer = null
      }, 1500)
    }
    return () =>
      h(
        'button',
        {
          class: ['md-code__copy', done.value ? 'md-code__copy--done' : ''],
          type: 'button',
          'aria-label': props.label,
          title: props.label,
          onClick: copy,
        },
        done.value ? props.doneLabel : props.label,
      )
  },
})

/* ──────────────────────────── 链接白名单 ──────────────────────────── */

/** 控制字符（含换行）能拆开协议名（`java\nscript:`），一律视为不安全。 */
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\u0000-\u001F\u007F]/

/**
 * 只放行三种 href：
 *   1. `http:` / `https:`
 *   2. 站内绝对路径 `/foo`
 *   3. 站内相对路径 `./foo`、`../foo`、`foo/bar`（无协议即相对）
 * 其余（`javascript:`、`data:`、`vbscript:`、`file:`、协议相对 `//evil.com`、
 * 夹控制字符的变体）→ false，调用方降级为纯文本。
 */
export function isSafeHref(raw: string): boolean {
  const href = raw.trim()
  if (!href) return false
  if (RE_CONTROL.test(href)) return false
  if (href.startsWith('#')) return true
  // 协议相对 `//host` 会继承当前协议，属于站外跳转，不在白名单里。
  if (href.startsWith('//')) return false
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)
  if (!scheme) return true // 无协议 = 相对路径
  const proto = (scheme[1] ?? '').toLowerCase()
  return proto === 'http' || proto === 'https'
}

/* ──────────────────────────── 行内解析 ──────────────────────────── */

/** 行内节点：原生字符串（Vue 会 createTextNode）或 VNode。 */
export type InlineNode = string | VNode

function isEscapeNext(ch: string): boolean {
  return /[!-/:-@[-`{-~]/.test(ch) || ch === ' '
}

function runLength(text: string, start: number, ch: string): number {
  let n = 0
  while (start + n < text.length && text[start + n] === ch) n += 1
  return n
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[0-9A-Za-z\u00C0-\uFFFF]/.test(ch)
}

/**
 * 从 `from` 开始找长度 ≥ need 的同类分隔符串；返回起始下标或 -1。
 * 用 indexOf 逐跳推进而不是逐字符正则回溯，10k 字符输入下依然是线性。
 */
function findClose(text: string, from: number, ch: string, need: number): number {
  let idx = text.indexOf(ch.repeat(need), from)
  while (idx !== -1) {
    const after = text[idx + need]
    // 更长的同类 run 继续往后看，避免把 `***` 当成 `**` + `*`
    if (after !== undefined && ch !== '~' && after === ch) {
      idx = text.indexOf(ch.repeat(need), idx + 1)
      continue
    }
    return idx
  }
  return -1
}

/** `[label](href)` → 安全则 a 标签，不安全则原样文本（连标签都不生成）。 */
function parseLinkAt(
  text: string,
  start: number,
  depth: number,
): { nodes: InlineNode[]; end: number } | null {
  const closeBracket = text.indexOf(']', start + 1)
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') return null
  const closeParen = text.indexOf(')', closeBracket + 2)
  if (closeParen === -1) return null
  const label = text.slice(start + 1, closeBracket)
  const hrefRaw = text.slice(closeBracket + 2, closeParen)
  const literal = text.slice(start, closeParen + 1)
  if (!isSafeHref(hrefRaw)) {
    // 纯文本降级：保留用户看到的样子，但没有任何可执行属性。
    return { nodes: [literal], end: closeParen + 1 }
  }
  const children = depth >= MAX_DEPTH ? [label] : parseInline(label, depth + 1)
  return {
    nodes: [
      h(
        'a',
        {
          class: 'md-link',
          href: hrefRaw.trim(),
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
        children,
      ),
    ],
    end: closeParen + 1,
  }
}

/**
 * 行内解析主循环（单行文本）。
 * 输出节点数组的字符串成员会被 Vue 当作纯文本子节点，**不会**被解析成 HTML。
 */
export function parseInline(text: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }

  while (i < text.length) {
    const ch = text[i]

    // 反斜杠转义：`\*` → `*`
    if (ch === '\\' && i + 1 < text.length && isEscapeNext(text[i + 1] ?? '')) {
      buf += text[i + 1] ?? ''
      i += 2
      continue
    }

    // 行内代码：反引号 run 必须等长闭合（``a ` b`` 这种）。
    if (ch === '`') {
      const ticks = runLength(text, i, '`')
      const fence = '`'.repeat(ticks)
      const close = text.indexOf(fence, i + ticks)
      if (close > i + ticks) {
        flush()
        out.push(h('code', { class: 'md-code-inline' }, text.slice(i + ticks, close).replace(/\n/g, ' ')))
        i = close + ticks
        continue
      }
      buf += fence
      i += ticks
      continue
    }

    // 链接
    if (ch === '[') {
      const link = parseLinkAt(text, i, depth)
      if (link) {
        flush()
        out.push(...link.nodes)
        i = link.end
        continue
      }
      buf += ch
      i += 1
      continue
    }

    // 强调 / 删除线
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = runLength(text, i, ch)
      let need = 0
      let tag = ''
      if (ch === '~') {
        if (run >= 2) {
          need = 2
          tag = 'del'
        }
      } else if (run >= 3) {
        need = 3
        tag = 'strong'
      } else if (run >= 2) {
        need = 2
        tag = 'strong'
      } else {
        need = 1
        tag = 'em'
      }

      if (need > 0 && depth < MAX_DEPTH) {
        const from = i + need
        const close = findClose(text, from, ch, need)
        const inner = close === -1 ? '' : text.slice(from, close)
        // `_` 不能在单词内部生效（snake_case 必须原样显示）
        const wordSafe =
          ch !== '_' || (!isWordChar(text[i - 1]) && !isWordChar(text[close + need]))
        if (close !== -1 && inner.length > 0 && inner.trim().length > 0 && wordSafe) {
          flush()
          const kids = parseInline(inner, depth + 1)
          if (need === 3) out.push(h('strong', { class: 'md-strong' }, [h('em', { class: 'md-em' }, kids)]))
          else if (tag === 'del') out.push(h('del', { class: 'md-del' }, kids))
          else if (tag === 'strong') out.push(h('strong', { class: 'md-strong' }, kids))
          else out.push(h('em', { class: 'md-em' }, kids))
          i = close + need
          continue
        }
      }
      buf += ch.repeat(run)
      i += run
      continue
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

/* ──────────────────────────── 块级解析 ──────────────────────────── */

const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/
const RE_UL = /^(\s*)([-*+])[ \t]+(.*)$/
const RE_OL = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

interface FenceMatch {
  marker: string
  lang: string
}

function matchFence(line: string): FenceMatch | null {
  const m = RE_FENCE.exec(line)
  if (!m) return null
  // `noUncheckedIndexedAccess` 下 m[2] 是 string|undefined；正则已保证非空，兜底到反引号
  const marker = (m[2] ?? '`')[0] ?? '`'
  return { marker, lang: (m[3] ?? '').trim() }
}

interface ListMatch {
  indent: number
  ordered: boolean
  start: number
  content: string
}

function matchListItem(line: string): ListMatch | null {
  const ul = RE_UL.exec(line)
  if (ul) return { indent: (ul[1] ?? '').length, ordered: false, start: 1, content: ul[3] ?? '' }
  const ol = RE_OL.exec(line)
  if (ol) {
    return {
      indent: (ol[1] ?? '').length,
      ordered: true,
      start: Number(ol[2] ?? 1),
      content: ol[3] ?? '',
    }
  }
  return null
}

function isTableSep(line: string): boolean {
  return line.includes('|') && RE_TABLE_SEP.test(line)
}

/** 该行是否会**打断**段落（即上一段到此结束）。 */
function startsBlock(line: string): boolean {
  if (matchFence(line)) return true
  if (RE_HR.test(line)) return true
  if (RE_HEADING.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  if (matchListItem(line)) return true
  return false
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
      continue
    }
    if (c === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  cells.push(cur.trim())
  return cells
}

function alignOf(spec: string): 'left' | 'center' | 'right' | null {
  const s = spec.trim()
  const left = s.startsWith(':')
  const right = s.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** 段落内的软换行 → `<br>`（聊天场景下单个换行就该换行）。 */
function paragraphNodes(text: string): InlineNode[] {
  const lines = text.split('\n')
  const nodes: InlineNode[] = []
  lines.forEach((line, idx) => {
    if (idx > 0) nodes.push(h('br'))
    nodes.push(...parseInline(line.trim()))
  })
  return nodes
}

function renderCodeBlock(fence: FenceMatch, body: string, options: MarkdownRenderOptions): VNode {
  const lang = fence.lang.replace(/[^\w#+.-]/g, '').slice(0, 24)
  return h('div', { class: 'md-code' }, [
    h('div', { class: 'md-code__bar' }, [
      h('span', { class: 'md-code__lang' }, lang || options.codeLabel || '代码'),
      h(CopyButton, {
        code: body,
        label: options.copyLabel ?? '复制',
        doneLabel: options.copiedLabel ?? '已复制',
      }),
    ]),
    h('pre', { class: 'md-code__pre' }, [
      h('code', { class: 'md-code__code', 'data-lang': lang || undefined }, body),
    ]),
  ])
}

/** 递归解析块级内容；`baseIndent` 用于列表项内部的续行判定。 */
function parseBlocks(lines: string[], depth: number, options: MarkdownRenderOptions): VNode[] {
  const blocks: VNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (isBlank(line)) {
      i += 1
      continue
    }

    // 1) 围栏代码块（不解析内部任何语法）
    const fence = matchFence(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        if (cur.trimStart().startsWith(fence.marker.repeat(3)) && cur.trim().replace(/`/g, '').replace(/~/g, '') === '') {
          i += 1
          break
        }
        body.push(cur)
        i += 1
      }
      blocks.push(renderCodeBlock(fence, body.join('\n'), options))
      continue
    }

    // 2) 分割线
    if (RE_HR.test(line)) {
      blocks.push(h('hr', { class: 'md-hr' }))
      i += 1
      continue
    }

    // 3) 标题
    const heading = RE_HEADING.exec(line)
    if (heading) {
      const level = (heading[1] ?? '').length
      blocks.push(
        h(`h${level}`, { class: ['md-h', `md-h--${level}`] }, parseInline((heading[2] ?? '').trim())),
      )
      i += 1
      continue
    }

    // 4) 引用（内部递归解析，可嵌套）
    if (RE_QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const m = RE_QUOTE.exec(lines[i] ?? '')
        if (!m) break
        inner.push(m[1] ?? '')
        i += 1
      }
      const kids =
        depth >= MAX_DEPTH
          ? [h('p', { class: 'md-p' }, paragraphNodes(inner.join('\n')))]
          : parseBlocks(inner, depth + 1, options)
      blocks.push(h('blockquote', { class: 'md-quote' }, kids))
      continue
    }

    // 5) 列表（支持一层缩进嵌套；混合缩进按「更深的缩进 = 子列表」处理）
    const firstItem = matchListItem(line)
    if (firstItem) {
      const ordered = firstItem.ordered
      const baseIndent = firstItem.indent
      const items: VNode[] = []
      const itemBuf: { nodes: InlineNode[]; subs: VNode[] }[] = []
      let startNumber = firstItem.start
      while (i < lines.length) {
        const item = matchListItem(lines[i] ?? '')
        if (item && item.ordered === ordered) {
          if (item.indent > baseIndent && itemBuf.length > 0 && depth < MAX_DEPTH) {
            // 子列表：把连续的更深项整体交给递归
            const subLines: string[] = []
            let j = i
            while (j < lines.length) {
              const sub = matchListItem(lines[j] ?? '')
              if (!sub || sub.ordered !== ordered || sub.indent <= baseIndent) break
              subLines.push((lines[j] ?? '').slice(Math.min(sub.indent, (lines[j] ?? '').length)))
              j += 1
            }
            itemBuf[itemBuf.length - 1]?.subs.push(...parseBlocks(subLines, depth + 1, options))
            i = j
            continue
          }
          if (item.indent > baseIndent) break
          const task = RE_TASK.exec(item.content)
          if (task) {
            itemBuf.push({
              nodes: [
                h(
                  'span',
                  { class: 'md-task', 'aria-hidden': 'true' },
                  (task[1] ?? '').toLowerCase() === 'x' ? '☑' : '☐',
                ),
                ...parseInline(task[2] ?? ''),
              ],
              subs: [],
            })
          } else {
            itemBuf.push({ nodes: parseInline(item.content), subs: [] })
          }
          i += 1
          continue
        }
        // 列表项的续行：比基准缩进更深的普通文本
        const contLine = lines[i] ?? ''
        if (itemBuf.length > 0 && !isBlank(contLine) && !startsBlock(contLine)) {
          const indent = contLine.length - contLine.trimStart().length
          if (indent > baseIndent) {
            itemBuf[itemBuf.length - 1]?.nodes.push(...paragraphNodes(contLine.trim()))
            i += 1
            continue
          }
        }
        break
      }

      for (const it of itemBuf) {
        items.push(h('li', { class: 'md-li' }, [...it.nodes, ...it.subs]))
      }
      if (ordered) {
        blocks.push(
          h(
            'ol',
            { class: 'md-ol', start: startNumber !== 1 ? String(startNumber) : undefined },
            items,
          ),
        )
      } else {
        blocks.push(h('ul', { class: 'md-ul' }, items))
      }
      continue
    }

    // 6) GFM 表格：当前行含 `|` 且下一行是对齐分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1] ?? '').map(alignOf)
      const bodyRows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && !isBlank(lines[i] ?? '')) {
        bodyRows.push(splitRow(lines[i] ?? ''))
        i += 1
      }
      const cellStyle = (idx: number) =>
        aligns[idx] ? { textAlign: aligns[idx] as 'left' | 'center' | 'right' } : undefined
      blocks.push(
        h('div', { class: 'md-table-wrap' }, [
          h('table', { class: 'md-table' }, [
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                header.map((cell, idx) => h('th', { style: cellStyle(idx) }, parseInline(cell))),
              ),
            ),
            h(
              'tbody',
              null,
              bodyRows.map((row) =>
                h(
                  'tr',
                  null,
                  header.map((_, idx) =>
                    h('td', { style: cellStyle(idx) }, parseInline(row[idx] ?? '')),
                  ),
                ),
              ),
            ),
          ]),
        ]),
      )
      continue
    }

    // 7) 段落：连续非空且不打断的行
    const paraLines: string[] = [line]
    i += 1
    while (i < lines.length && !isBlank(lines[i] ?? '') && !startsBlock(lines[i] ?? '')) {
      // 段落中间若出现表格分隔行，说明是表格的 header 行，回退
      if ((lines[i] ?? '').includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) break
      paraLines.push(lines[i] ?? '')
      i += 1
    }
    blocks.push(h('p', { class: 'md-p' }, paragraphNodes(paraLines.join('\n'))))
  }

  return blocks
}

/**
 * 主入口：Markdown 源串 → VNode 数组（可直接放进模板的 `<component :is>`/子节点）。
 *
 * 纯函数：同样输入必得同样结构，无副作用、无全局状态，便于单测与 SSR。
 */
export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): VNode[] {
  if (!source) return []
  const text = source.length > MAX_SOURCE_LENGTH ? source.slice(0, MAX_SOURCE_LENGTH) : source
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines, 0, options)
}

/**
 * 降级成纯文本（会话列表的最后一条预览、搜索高亮、无障碍 aria-label 用）。
 * 只做**删除标记**，不做 HTML 处理，永远返回纯字符串。
 */
export function toPlainText(source: string): string {
  if (!source) return ''
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d{1,9}[.)]\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** 源码里是否含有可渲染的 Markdown 标记（用于「渲染/源码」切换按钮是否可用）。 */
export function hasMarkdownSyntax(source: string): boolean {
  if (!source) return false
  return /(^|\n)\s{0,3}(?:#{1,6}\s|>|`{3,}|[-*+]\s|\d{1,9}[.)]\s|\|)|(\*\*|__|~~|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\))/.test(
    source,
  )
}
