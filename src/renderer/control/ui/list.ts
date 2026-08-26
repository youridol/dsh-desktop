/**
 * List 相关组件：统一列表项、空状态、提示行与统计元信息。
 */
import { h, text } from './element'

export function listContainer(id?: string): HTMLElement {
  return h('div', { class: 'list', ...(id ? { id } : {}) })
}

export function listItem(...children: Array<Node | null | undefined>): HTMLElement {
  return h('div', { class: 'item' }, ...children)
}

export function emptyState(message: string): HTMLElement {
  return h('p', { class: 'empty' }, text(message))
}

export function listHint(message: string, className = ''): HTMLElement {
  return h('p', { class: ['muted list-hint', className].filter(Boolean).join(' ') }, text(message))
}

export function statCount(label: string, value: number | string, cls = ''): HTMLElement {
  return h('div', { class: 'stat' },
    h('div', { class: ['dash-count', cls].filter(Boolean).join(' ') }, text(String(value))),
    h('div', { class: 'stat-label muted' }, text(label)),
  )
}
