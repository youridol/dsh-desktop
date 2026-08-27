/**
 * Badge 组件（DSH 原生 tag 风格）。
 * 统一状态/来源标签：default / ok / warn / err / accent / muted。
 */
import { h, text } from './element'

export type BadgeVariant = 'default' | 'ok' | 'warn' | 'err' | 'accent' | 'muted'

export function badge(label: string, variant: BadgeVariant = 'default'): HTMLElement {
  const cls = variant === 'default' ? 'badge' : `badge ${variant}`
  return h('span', { class: cls }, text(label))
}