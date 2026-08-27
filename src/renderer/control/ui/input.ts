/**
 * Input / Checkbox 组件（DSH 原生输入控件风格，紧凑小号）。
 * 统一输入控件与事件语义（onChange / onInput / onEnter），
 * 保持与原生控件一致的行为，仅统一外观与构造方式。
 */
import { h, text } from './element'
import { switchControl } from './switch'

export interface InputOptions {
  type?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  title?: string
  width?: string | number
  min?: string | number
  max?: string | number
  step?: string | number
  className?: string
  id?: string
  onChange?: (value: string) => void
  onInput?: (value: string) => void
  onEnter?: (value: string) => void
}

export function inputEl(opts: InputOptions = {}): HTMLInputElement {
  const style = opts.width !== undefined
    ? `width:${typeof opts.width === 'number' ? opts.width + 'px' : opts.width}`
    : undefined
  const el = h('input', {
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder ?? '',
    disabled: opts.disabled ?? false,
    class: ['input', opts.className].filter(Boolean).join(' ') || undefined,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(style ? { style } : {}),
    ...(opts.min !== undefined ? { min: String(opts.min) } : {}),
    ...(opts.max !== undefined ? { max: String(opts.max) } : {}),
    ...(opts.step !== undefined ? { step: String(opts.step) } : {}),
  }) as HTMLInputElement
  el.addEventListener('change', () => opts.onChange?.(el.value))
  el.addEventListener('input', () => opts.onInput?.(el.value))
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') opts.onEnter?.(el.value)
  })
  return el
}

export interface CheckboxOptions {
  checked?: boolean
  disabled?: boolean
  title?: string
  className?: string
  id?: string
  onChange?: (checked: boolean) => void
}

export function checkbox(opts: CheckboxOptions = {}): HTMLInputElement {
  const el = h('input', {
    type: 'checkbox',
    checked: opts.checked ?? false,
    disabled: opts.disabled ?? false,
    class: ['checkbox', opts.className].filter(Boolean).join(' ') || undefined,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  }) as HTMLInputElement
  el.addEventListener('change', () => opts.onChange?.(el.checked))
  return el
}

/** 带文案的勾选框（用于「全选」「启用」等行内选项）。 */
export function checkboxLabel(label: string, opts: CheckboxOptions = {}): HTMLElement {
  const cb = checkbox(opts)
  return h('label', { class: 'checkbox-label' }, cb, text(label))
}

/** 带文案的开关（label.switch 结构）。 */
export function switchLabel(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const sw = switchControl(checked, onChange)
  return h('label', { class: 'switch-wrap' }, sw.root, text(label))
}