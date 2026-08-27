/**
 * Segmented 控件（DSH 原生分段控件风格，用于作用域 / 安装来源 / 版本来源）。
 * 替代分散的 radio 组，提供统一外观与可读的 active 状态管理。
 */
import { h, text } from './element'

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

export function segmented<T extends string>(
  options: SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  const root = h('div', { class: 'seg-group', role: 'tablist' })
  // 用可变 current 记录实际选中值，避免点击回调持有渲染时的旧闭包。
  let current = value
  for (const opt of options) {
    root.append(h('button', {
      class: ['seg', opt.value === current ? 'active' : ''].filter(Boolean).join(' '),
      'data-value': opt.value,
      role: 'tab',
      'aria-selected': String(opt.value === current),
      type: 'button',
      onclick: () => {
        if (opt.value === current) return
        current = opt.value
        setSegmentedValue(root, opt.value)
        onChange(opt.value)
      },
    }, text(opt.label)))
  }
  return root
}

/** 更新已渲染 segmented 的选中态（内部使用）。 */
export function setSegmentedValue(root: HTMLElement, value: string): void {
  for (const seg of root.querySelectorAll<HTMLElement>('.seg')) {
    const active = seg.dataset.value === value
    seg.classList.toggle('active', active)
    seg.setAttribute('aria-selected', String(active))
  }
}