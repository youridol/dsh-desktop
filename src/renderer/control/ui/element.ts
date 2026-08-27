/**
 * 控制面板 UI 基础设施：统一的 DOM 构造器。
 *
 * 所有渲染层代码应当通过本模块构造 DOM，避免在页面中散落
 * document.createElement / innerHTML 字符串拼接，保证结构一致、
 * 可读、可维护（对齐 DSH 原生 Web UI 设计令牌的基础 helpers，无框架依赖）。
 */
export type UiChild = Node | string | number | null | undefined | false

export type UiAttrs = Record<
  string,
  string | number | boolean | EventListener | ((ev: Event) => void) | undefined | null
>

/** 创建元素：属性值为函数时作为事件监听器（onclick -> click）。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: UiAttrs,
  ...children: UiChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null) continue
    if (typeof v === 'function') {
      const evName = k.startsWith('on') ? k.slice(2) : k
      el.addEventListener(evName, v as EventListener)
    } else if (typeof v === 'boolean') {
      el.toggleAttribute(k, v)
    } else {
      el.setAttribute(k, String(v))
    }
  }
  appendChildren(el, children)
  return el
}

export function appendChildren(el: HTMLElement, children: UiChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

/** 创建文本节点（等价于 document.createTextNode 的快捷方式）。 */
export function text(str: string): Text {
  return document.createTextNode(str)
}

/** 水平工具行。 */
export function row(...children: UiChild[]): HTMLElement {
  return h('div', { class: 'row' }, ...children)
}

/** 可伸展占位（flex:1）。 */
export function grow(...children: UiChild[]): HTMLElement {
  return h('div', { class: 'grow' }, ...children)
}

/** 键值对信息网格。 */
export function kv(entries: Array<[string, UiChild]>): HTMLElement {
  const grid = h('div', { class: 'kv' })
  for (const [k, v] of entries) {
    grid.append(
      h('div', { class: 'k' }, text(k)),
      h('div', { class: 'v' }, v),
    )
  }
  return grid
}