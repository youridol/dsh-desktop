/**
 * Dialog 组件（DSH 原生对话框风格）。
 * 统一替代原生 confirm / alert：标题 + 消息 + 主/次按钮，
 * 返回 Promise，支持 Esc / 点击遮罩取消。
 */
import { button } from './button'
import { h, text, type UiChild } from './element'

export interface DialogOptions {
  title: string
  message?: UiChild
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  width?: number
}

export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'dialog-overlay' })
    const confirmBtn = button(
      { variant: opts.danger ? 'danger' : 'primary', size: 'sm', onClick: () => close(true) },
      text(opts.confirmLabel ?? (opts.danger ? '删除' : '确定')),
    )
    const cancelBtn = button({ size: 'sm', onClick: () => close(false) }, text(opts.cancelLabel ?? '取消'))
    const dialog = h('div', { class: 'dialog', ...(opts.width ? { style: `width:${opts.width}px;max-width:92vw` } : {}) },
      h('div', { class: 'dialog-head' }, h('h3', { class: 'dialog-title' }, text(opts.title))),
      h('div', { class: 'dialog-body' }, ...(opts.message !== undefined ? [opts.message] : [])),
      h('div', { class: 'dialog-actions' }, cancelBtn, confirmBtn),
    )
    overlay.append(dialog)
    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close(false)
    }
    function close(result: boolean): void {
      document.removeEventListener('keydown', keyHandler)
      overlay.remove()
      resolve(result)
    }
    overlay.addEventListener('pointerdown', (ev) => {
      if (ev.target === overlay) close(false)
    })
    document.addEventListener('keydown', keyHandler)
    document.body.append(overlay)
    confirmBtn.focus()
  })
}

export function alertDialog(opts: DialogOptions): Promise<void> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'dialog-overlay' })
    const okBtn = button({ variant: 'primary', size: 'sm', onClick: () => close() }, text(opts.confirmLabel ?? '确定'))
    const dialog = h('div', { class: 'dialog', ...(opts.width ? { style: `width:${opts.width}px;max-width:92vw` } : {}) },
      h('div', { class: 'dialog-head' }, h('h3', { class: 'dialog-title' }, text(opts.title))),
      h('div', { class: 'dialog-body' }, ...(opts.message !== undefined ? [opts.message] : [])),
      h('div', { class: 'dialog-actions' }, okBtn),
    )
    overlay.append(dialog)
    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close()
    }
    function close(): void {
      document.removeEventListener('keydown', keyHandler)
      overlay.remove()
      resolve()
    }
    document.addEventListener('keydown', keyHandler)
    document.body.append(overlay)
    okBtn.focus()
  })
}