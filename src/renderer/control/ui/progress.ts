/**
 * Progress 组件（状态驱动的进度条）。
 * idle 隐藏；checking 时显示 indeterminate 动画；success/error 停止动画并保留文案。
 */
import { h, text } from './element'

export interface ProgressControl {
  root: HTMLElement
  textEl: HTMLElement
  setLoading(on: boolean): void
  setText(message: string): void
  show(): void
  hide(): void
}

export function progressControl(): ProgressControl {
  const textEl = h('div', { class: 'progress-text muted mono' })
  const root = h('div', { class: 'progress-wrap hidden' },
    h('div', { class: 'progress-bar' }, h('div', { class: 'fill' })),
    textEl,
  )
  return {
    root,
    textEl,
    setLoading(on) {
      root.classList.toggle('loading', on)
    },
    setText(message) {
      textEl.replaceChildren(text(message))
    },
    show() {
      root.classList.remove('hidden')
    },
    hide() {
      root.classList.add('hidden')
    },
  }
}
