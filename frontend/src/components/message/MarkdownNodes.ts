/**
 * 极薄的 VNode 数组挂载器。
 *
 * 为什么需要它：模板里 `{{ nodes }}` 会走 toDisplayString，把 VNode 数组变成
 * `[object Object]`；而 `<component :is>` 只接受单个组件/元素。要把「一排 VNode」
 * 作为子节点交给 Vue，唯一干净的写法就是在渲染函数里 `h('div', null, nodes)`。
 * 注意这里**没有任何 HTML 字符串**：nodes 里的文本成员会被 Vue 用
 * createTextNode 落地，永远不经过 HTML 解析器 —— 这正是本任务的安全底线。
 */
import { defineComponent, h, type VNode } from 'vue'

export const MarkdownNodes = defineComponent({
  name: 'MarkdownNodes',
  props: {
    nodes: { type: Array as () => VNode[], required: true },
  },
  setup(props) {
    return () => h('div', { class: 'md__body' }, props.nodes)
  },
})

export default MarkdownNodes
