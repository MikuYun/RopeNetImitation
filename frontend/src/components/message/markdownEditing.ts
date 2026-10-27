/**
 * Markdown 编辑辅助：把「工具条按钮」翻译成对 textarea 文本与选区的纯变换。
 *
 * 为什么不直接在组件里拼字符串：这些变换有大量边界情况（空选区、跨行选区、
 * 已加粗的二次点击要取消、有序列表要自动编号、换行后光标落点）。抽成纯函数
 * 后可以用单测逐条锁死，组件只负责把结果写回 DOM 并恢复选区。
 *
 * 所有函数都是纯函数：`(state, ...) => state`，不读 DOM、不写 DOM、无副作用。
 * `selectionStart === selectionEnd` 表示「无选区，只有光标」。
 */

export interface EditState {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

export type MarkdownCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inline-code'
  | 'code-block'
  | 'link'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'heading'
  | 'table'

/** 归一化选区：越界夹紧、反向选区翻转。 */
function normalize(state: EditState): { start: number; end: number } {
  const len = state.text.length
  const a = Math.max(0, Math.min(state.selectionStart, len))
  const b = Math.max(0, Math.min(state.selectionEnd, len))
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** 用 `[start,end)` 替换文本，得到新文本与新选区。 */
function replace(
  text: string,
  start: number,
  end: number,
  insert: string,
  selectStart: number,
  selectEnd: number,
): EditResult {
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    selectionStart: selectStart,
    selectionEnd: selectEnd,
  }
}

export interface EditResult {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** 行首缩进（空格 / tab / 引用符）不算内容起止，用于判断行内标记。 */
function lineBounds(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nl = text.indexOf('\n', end)
  const to = nl === -1 ? text.length : nl
  return { from, to }
}

/**
 * 用成对标记包裹选区（粗体/斜体/删除线/行内代码）。
 *
 * 无选区：插入 `标记+占位符+标记`，选中占位符，用户可以立刻打字替换。
 * 有选区且已带标记：**取消**（二次点击是 toggle，符合编辑器直觉）。
 */
export function wrapMarkdown(
  state: EditState,
  marker: string,
  placeholder: string,
): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const inner = text.slice(start, end)

  // 已包裹 → 取消（只处理紧贴选区的情况，避免误伤远端的同款标记）
  if (
    text.slice(start - marker.length, start) === marker &&
    text.slice(end, end + marker.length) === marker
  ) {
    return replace(
      text,
      start - marker.length,
      end + marker.length,
      inner,
      start - marker.length,
      end - marker.length,
    )
  }

  const body = inner.length > 0 ? inner : placeholder
  const insert = marker + body + marker
  const bodyStart = start + marker.length
  return replace(text, start, end, insert, bodyStart, bodyStart + body.length)
}

/**
 * 给选中的每一行加前缀（引用 / 无序列表 / 标题）。
 *
 * 再次点击会去掉前缀 —— 否则点错一次就必须手动删。
 * 空选区时只作用于光标所在行。
 */
export function prefixLines(state: EditState, prefix: string): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const { from, to } = lineBounds(text, start, end)
  const block = text.slice(from, to)
  const lines = block.split('\n')

  const hasPrefix = (line: string): boolean =>
    prefix === '> ' ? /^\s*>\s?/.test(line) : line.trimStart().startsWith(prefix.trimEnd())

  const allPrefixed = lines.every((line) => line.trim() === '' || hasPrefix(line))
  const next = lines.map((line) => {
    if (line.trim() === '') return line
    if (allPrefixed) {
      // 取消：只删一个前缀（引用符允许 `> ` / `>`）
      return prefix === '> ' ? line.replace(/^(\s*)>\s?/, '$1') : line.replace(/^(\s*)/, '$1').slice(prefix.length)
    }
    return prefix + line
  })
  const insert = next.join('\n')

  // 选区整体平移：行首加/减的前缀长度一致，故用长度差校正
  const delta = insert.length - block.length
  const caret = Math.min(insert.length, Math.max(0, start - from + (allPrefixed ? -prefix.length : prefix.length)))
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    selectionStart: delta === 0 ? start : from + caret,
    selectionEnd: delta === 0 ? end : from + Math.max(caret, insert.length + (end - to)),
  }
}

/** 有序列表：逐行编号，二次点击去掉编号。 */
export function orderedList(state: EditState): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const { from, to } = lineBounds(text, start, end)
  const block = text.slice(from, to)
  const lines = block.split('\n')
  const numbered = /^\s*\d{1,9}[.)]\s+/
  const allNumbered = lines.every((line) => line.trim() === '' || numbered.test(line))

  let n = 0
  const next = lines.map((line) => {
    if (line.trim() === '') return line
    if (allNumbered) return line.replace(numbered, '')
    n += 1
    return `${n}. ${line}`
  })
  const insert = next.join('\n')
  const delta = insert.length - block.length
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    selectionStart: from + Math.max(0, (start - from) + (allNumbered ? -3 : 3)),
    selectionEnd: from + Math.max(0, (end - from) + delta),
  }
}

/** 围栏代码块：把选区放进 ``` 里；空选区生成两行空行并落在中间。 */
export function codeBlock(state: EditState): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const inner = text.slice(start, end)

  // 光标前后正好是围栏 → 取消
  if (text.slice(start - 3, start) === '```' && text.slice(end, end + 3) === '```') {
    const body = inner.replace(/^\n/, '').replace(/\n$/, '')
    return replace(text, start - 3, end + 3, body, start - 3, start - 3 + body.length)
  }

  const body = inner.length > 0 ? inner : '代码'
  const before = start === 0 || text[start - 1] === '\n' ? '' : '\n'
  const after = end === text.length || text[end] === '\n' ? '\n' : '\n'
  const insert = `${before}\`\`\`\n${body}\n\`\`\`${after}`
  const bodyStart = start + before.length + 4
  return replace(text, start, end, insert, bodyStart, bodyStart + body.length)
}

/** 链接：`[文字](url)`。选区文字成为 link text，光标停在 url 上方便直接粘贴。 */
export function linkMarkdown(state: EditState, urlPlaceholder = 'https://'): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const inner = text.slice(start, end)

  // 已是链接 → 解包成纯文字
  const around = text.slice(start, end)
  if (start >= 1 && text[start - 1] === '[' && text.slice(end, end + 1) === ']') {
    const afterParen = /^\]\(([^)]*)\)/.exec(text.slice(end))
    if (afterParen) {
      const bodyStart = start
      return replace(text, start - 1, end + afterParen[0].length, around, bodyStart, bodyStart + around.length)
    }
  }

  const label = inner.length > 0 ? inner : '链接文字'
  const insert = `[${label}](${urlPlaceholder})`
  const urlStart = start + 1 + label.length + 2
  return replace(text, start, end, insert, urlStart, urlStart + urlPlaceholder.length)
}

/**
 * GFM 表格骨架。
 *
 * 表格没法像粗体那样「包裹选区」—— 它是块级结构。这里做两件事：
 *   1. 把光标所在行（或选中区域的每一行）当作表头单元格塞进表格；
 *   2. 没有内容时插入一个 2 列 × 3 行的骨架（表头 + 对齐行 + 一行占位）。
 * 已存在表格（光标所在行以 `|` 开头且下一行是分隔行）时**不重复插入**，
 * 避免连点两下炸出两张表。末尾补一个 `\n`：GFM 表格必须有后续换行才闭合，
 * 否则光标停在最后一行末尾时解析器会把它当普通段落。
 */
export function tableMarkdown(state: EditState): EditResult {
  const { start, end } = normalize(state)
  const { text } = state
  const { from, to } = lineBounds(text, start, end)
  const block = text.slice(from, to)
  const rows = block.split('\n').filter((line) => line.trim() !== '')

  // 已是表格 → 原样返回，光标不动
  // 注意从 `to + 1` 往后找换行：`to` 本身可能就是本行的换行符位置。
  const nextLineEnd = text.indexOf('\n', to + 1)
  const nextLine = text.slice(to + 1, nextLineEnd === -1 ? text.length : nextLineEnd)
  if (/^\s*\|/.test(block) && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(nextLine)) {
    return { text, selectionStart: start, selectionEnd: end }
  }

  const body =
    rows.length === 0
      ? '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |'
      : [
          `| ${rows.join(' | ')} |`,
          `| ${rows.map(() => '---').join(' | ')} |`,
          `| ${rows.map(() => '内容').join(' | ')} |`,
        ].join('\n')

  const insert = `${body}\n`
  // 光标落到第一格内容起始处（跳过 `| `），用户直接打字就是表头
  const bodyStart = from + 2
  return replace(text, from, to, insert, bodyStart, bodyStart)
}

/** 工具条命令 → 变换。集中在这里，组件与测试共用同一张映射表。 */
export function applyCommand(state: EditState, command: MarkdownCommand): EditResult {
  switch (command) {
    case 'bold':
      return wrapMarkdown(state, '**', '粗体')
    case 'italic':
      return wrapMarkdown(state, '*', '斜体')
    case 'strike':
      return wrapMarkdown(state, '~~', '删除线')
    case 'inline-code':
      return wrapMarkdown(state, '`', '代码')
    case 'code-block':
      return codeBlock(state)
    case 'link':
      return linkMarkdown(state)
    case 'quote':
      return prefixLines(state, '> ')
    case 'ul':
      return prefixLines(state, '- ')
    case 'ol':
      return orderedList(state)
    case 'heading':
      return prefixLines(state, '## ')
    case 'table':
      return tableMarkdown(state)
    default:
      return { text: state.text, selectionStart: state.selectionStart, selectionEnd: state.selectionEnd }
  }
}
