/**
 * Button 组件（shadcn/ui 风格，紧凑小号）。
 * 统一按钮样式与交互，禁止在页面中直接拼写 <button class="btn ..."> 的变体。
 */
import { h, type UiChild } from './element'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  title?: string
  className?: string
  onClick?: (ev: MouseEvent) => void
}

export function button(opts: ButtonOptions = {}, ...children: UiChild[]): HTMLButtonElement {
  const cls = ['btn']
  if (opts.variant && opts.variant !== 'default') cls.push(opts.variant)
  if (opts.size === 'sm') cls.push('small')
  if (opts.className) cls.push(opts.className)
  return h('button', {
    class: cls.join(' '),
    type: opts.type ?? 'button',
    disabled: opts.disabled ?? false,
    ...(opts.title ? { title: opts.title } : {}),
    onclick: opts.onClick as EventListener | undefined,
  }, ...children)
}

/** 带图标的紧凑按钮（图标为文本字符，如 ✕ / ↻）。 */
export function iconButton(icon: string, opts: Omit<ButtonOptions, 'size'> = {}, title = icon): HTMLButtonElement {
  return button({ ...opts, size: 'sm', title, className: 'icon-btn ' + (opts.className ?? '') }, text(icon))
}

import { text } from './element'
