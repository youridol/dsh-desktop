/**
 * Switch 开关组件（DSH 原生 Switch 风格）。
 * 统一的启用/停用开关：label.switch + track，事件经 onChange 回调上抛。
 */
import { h } from './element'

export interface SwitchControl {
  root: HTMLElement
  input: HTMLInputElement
}

export function switchControl(checked: boolean, onChange: (on: boolean) => void): SwitchControl {
  const input = h('input', { type: 'checkbox', checked }) as HTMLInputElement
  input.addEventListener('change', () => onChange(input.checked))
  const root = h('label', { class: 'switch' }, input, h('span', { class: 'track' }))
  return { root, input }
}

/** 带说明文案的开关行。 */
export function switchRow(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const sw = switchControl(checked, onChange)
  return h('label', { class: 'switch-row' }, sw.root, h('span', { class: 'switch-label' }, text(label)))
}

import { text } from './element'