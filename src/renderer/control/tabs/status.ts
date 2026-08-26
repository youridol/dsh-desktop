/**
 * 日志与状态：DSH 进程状态卡 + 实时日志滚动。
 * 布局与组件统一走 control/ui 组件库。
 */
import { bridge, type DshStatus, type LogLine } from '../api'
import { alertDialog, badge, button, card, h, row, text } from '../ui'

let pane: HTMLElement
let statusBox: HTMLElement
let logView: HTMLElement
let autoScroll = true
let pending: LogLine[] = []
let flushTimer: number | null = null

const stateLabels: Record<DshStatus['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  crashed: '异常退出',
  timeout: '启动超时',
  error: '错误',
}

function stateBadge(state: DshStatus['state']): HTMLElement {
  const variant = state === 'running' ? 'ok' : state === 'starting' || state === 'stopping' ? 'warn' : 'err'
  return badge(stateLabels[state] ?? state, variant)
}

export function initStatus(paneEl: HTMLElement): void {
  pane = paneEl
  pane.innerHTML = ''

  const statusCard = card(
    { title: 'DSH 服务' },
    h('div', { id: 'statusBody' }),
  )
  statusBox = statusCard.querySelector<HTMLElement>('#statusBody')!

  const actions = row(
    button({ variant: 'primary', size: 'sm', onClick: () => void ctl('restart') }, text('重启')),
    button({ size: 'sm', onClick: () => void ctl('stop') }, text('停止')),
    button({ size: 'sm', onClick: () => void ctl('start') }, text('启动')),
    button({ size: 'sm', onClick: () => void openInBrowser() }, text('在浏览器打开')),
  )

  const logCard = card(
    { title: '日志', actions: [button({ size: 'sm', onClick: () => void bridge().clearLogs() }, text('清空'))] },
    h('div', { id: 'logView' }),
  )
  logView = logCard.querySelector<HTMLElement>('#logView')!

  pane.append(statusCard, actions, logCard)

  logView.addEventListener('scroll', () => {
    autoScroll = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 30
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  const initial = await bridge().subscribeLogs()
  for (const line of initial) appendLine(line, false)
  flush()
  bridge().on('logs:line', (payload) => queueLine(payload as LogLine))
  bridge().on('logs:cleared', () => { logView.innerHTML = '' })
  bridge().on('dsh:status', (payload) => renderStatus(payload as DshStatus))
  const state = await bridge().getState()
  renderStatus(state.status)
}

async function ctl(action: 'start' | 'stop' | 'restart'): Promise<void> {
  try {
    if (action === 'start') await bridge().start()
    else if (action === 'stop') await bridge().stop()
    else await bridge().restart()
  } catch (err) {
    await alertDialog({ title: '操作失败', message: String(err) })
  }
}

async function openInBrowser(): Promise<void> {
  const s = await bridge().getState()
  window.open(s.status.serviceUrl, '_blank')
}

function renderStatus(s: DshStatus): void {
  statusBox.replaceChildren()
  const uptime = s.startedAt && s.state === 'running'
    ? `${Math.floor((Date.now() - s.startedAt) / 1000)} s`
    : '—'
  statusBox.append(
    row(stateBadge(s.state)),
    h('div', { class: 'kv', style: 'margin-top:8px' },
      ...kvEntries([
        ['地址', s.serviceUrl],
        ['端口', String(s.port)],
        ['版本', s.version === 'bundled' ? '捆绑版本' : s.version],
        ['PID', s.pid ? String(s.pid) : '—'],
        ['已运行', uptime],
        ['已启用插件', s.enabledPlugins.length ? s.enabledPlugins.join(', ') : '无'],
      ]),
    ),
  )
  if (s.detail && s.state !== 'running') {
    statusBox.append(h('p', { class: 'muted', style: 'margin:8px 0 0' }, text(s.detail)))
  }
}

function queueLine(line: LogLine): void {
  pending.push(line)
  if (flushTimer !== null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flush()
  }, 120)
}

function flush(): void {
  if (pending.length === 0) return
  const batch = pending
  pending = []
  for (const line of batch) appendLine(line, true)
  while (logView.childElementCount > 2000) logView.firstElementChild?.remove()
  if (autoScroll) logView.scrollTop = logView.scrollHeight
}

function appendLine(line: LogLine, animate: boolean): void {
  const el = h('div', { class: `log-line ${line.level}` },
    h('span', { class: 'src' }, text(`${fmtTime(line.ts)} [${line.source}]`)),
    h('span', { class: 'txt' }, text(line.text)),
  )
  if (!animate) el.style.opacity = '0.75'
  logView.append(el)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function kvEntries(entries: Array<[string, string]>): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const [k, v] of entries) {
    out.push(h('div', { class: 'k' }, text(k)), h('div', { class: 'mono' }, text(v)))
  }
  return out
}
