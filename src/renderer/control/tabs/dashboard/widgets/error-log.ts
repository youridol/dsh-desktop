/**
 * 异常与错误 Widget。
 *
 * 复用既有日志总线（logs:subscribe / logs:line / logs:cleared 事件），仅保留
 * 最近错误 / 警告并汇总展示，提供「清空日志」与「查看日志」入口。不复制日志
 * 页的滚动查看逻辑。
 */
import { h, type LogLine } from '../../../api'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

const MAX_LINES = 200
const MAX_SHOWN = 6

let host: HTMLElement | null = null
let ctxRef: DashboardWidgetContext | null = null
let lines: LogLine[] = []
let unsubLine: (() => void) | null = null
let unsubCleared: (() => void) | null = null

function pushLines(incoming: LogLine[]): void {
  lines.push(...incoming)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
}

function stat(label: string, value: number, cls: string): HTMLElement {
  return h('div', {},
    h('div', { class: `dash-count ${cls}` }, document.createTextNode(String(value))),
    h('div', { class: 'muted' }, document.createTextNode(label)),
  )
}

function lineEl(l: LogLine): HTMLElement {
  const label = l.level === 'error' ? '错误' : '警告'
  return h('div', { class: `log-line ${l.level}` },
    h('span', { class: 'src' }, document.createTextNode(label)),
    h('span', { class: 'txt mono' }, document.createTextNode(l.text.slice(0, 140))),
  )
}

function renderWidget(): void {
  if (!host) return
  const problems = lines.filter((l) => l.level === 'error' || l.level === 'warn')
  const errors = problems.filter((l) => l.level === 'error')
  const warns = problems.length - errors.length
  const shown = problems.slice(-MAX_SHOWN)

  host.innerHTML = ''
  host.append(
    h('div', { class: 'row', style: 'gap:18px' },
      stat('错误', errors.length, errors.length ? 'err' : ''),
      stat('警告', warns, warns ? 'warn' : ''),
    ),
  )
  if (problems.length === 0) {
    host.append(h('p', { class: 'muted', style: 'margin-top:6px' }, document.createTextNode('最近无异常')))
  } else {
    const list = h('div', { class: 'dash-mini-list', style: 'margin-top:6px' })
    for (const l of shown) list.append(lineEl(l))
    if (problems.length > MAX_SHOWN) {
      list.append(h('p', { class: 'muted' }, document.createTextNode(`… 其余 ${problems.length - MAX_SHOWN} 条见日志页`)))
    }
    host.append(list)
  }
  host.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', { class: 'btn small', onclick: () => void clearLogs() }, document.createTextNode('清空日志')),
    h('button', { class: 'btn small', onclick: () => goTab('status') }, document.createTextNode('查看日志')),
  ))
}

async function clearLogs(): Promise<void> {
  const ctx = ctxRef
  if (!ctx) return
  try {
    await ctx.bridge().clearLogs()
    lines = []
    ctx.toast('日志已清空')
    renderWidget()
  } catch (err) {
    ctx.toast(`清空日志失败：${String(err)}`, true)
  }
}

function goTab(name: string): void {
  document.querySelector<HTMLElement>(`.tab[data-tab="${name}"]`)?.click()
}

registerDashboardWidget({
  id: 'error-log',
  title: '异常与错误',
  render(hostEl: HTMLElement, ctx: DashboardWidgetContext): void {
    host = hostEl
    ctxRef = ctx
    unsubLine?.()
    unsubCleared?.()
    unsubLine = ctx.bridge().on('logs:line', (payload) => {
      pushLines([payload as LogLine])
      renderWidget()
    })
    unsubCleared = ctx.bridge().on('logs:cleared', () => {
      lines = []
      renderWidget()
    })
    void ctx.bridge().subscribeLogs().then((logs) => {
      pushLines(logs)
      renderWidget()
    })
  },
  dispose(): void {
    unsubLine?.()
    unsubCleared?.()
    unsubLine = null
    unsubCleared = null
    host = null
    ctxRef = null
  },
})
