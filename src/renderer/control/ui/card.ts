/**
 * Card 组件（shadcn/ui 风格）。
 * 统一卡片结构：card-head（card-title + card-actions）+ card-body。
 * 页面只负责内容与行为，间距/边框/标题样式全部收敛到 style.css。
 */
import { appendChildren, h, text, type UiChild } from './element'

export interface CardOptions {
  title?: string
  actions?: UiChild[]
  className?: string
  bodyClassName?: string
}

export function card(opts: CardOptions = {}, ...content: UiChild[]): HTMLElement {
  const el = h('section', { class: ['card', opts.className].filter(Boolean).join(' ') })
  if (opts.title !== undefined || (opts.actions?.length ?? 0) > 0) {
    const head = h('header', { class: 'card-head' })
    if (opts.title !== undefined) head.append(h('h3', { class: 'card-title' }, text(opts.title)))
    const actions = h('div', { class: 'card-actions' })
    for (const a of opts.actions ?? []) if (a) appendChildren(actions, [a])
    head.append(actions)
    el.append(head)
  }
  const bodyEl = h('div', { class: ['card-body', opts.bodyClassName ?? ''].filter(Boolean).join(' ') })
  appendChildren(bodyEl, content)
  el.append(bodyEl)
  return el
}
