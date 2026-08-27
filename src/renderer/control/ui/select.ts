/**
 * Select 组件（DSH 原生 select 风格：紧凑原生 select，仅统一外观）。
 */
import { h, text } from './element'

export interface SelectOption {
  value: string
  label: string
}

export function selectControl(
  options: SelectOption[],
  value: string,
  onChange: (value: string) => void,
  opts: { disabled?: boolean; className?: string; title?: string } = {},
): HTMLSelectElement {
  const el = h('select', {
    class: ['select', opts.className].filter(Boolean).join(' ') || undefined,
    title: opts.title,
  }) as HTMLSelectElement
  for (const opt of options) {
    el.append(h('option', { value: opt.value, selected: opt.value === value ? '' : undefined }, text(opt.label)))
  }
  el.disabled = opts.disabled ?? false
  el.addEventListener('change', () => onChange(el.value))
  return el
}