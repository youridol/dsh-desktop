/**
 * 日志与状态：DSH 进程状态卡 + 实时日志滚动。
 */
import { bridge, h, fmtTime, type DshStatus, type LogLine } from '../api'

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

export function initStatus(paneEl: HTMLElement): void {
  pane = paneEl
  pane.innerHTML = ''

  statusBox = h('div', { class: 'card' })
  const actions = h('div', { class: 'row', style: 'margin-top:10px' },
    h('button', { class: 'btn primary', onclick: () => void ctl('restart') }, document.createTextNode('重启')),
    h('button', { class: 'btn', onclick: () => void ctl('stop') }, document.createTextNode('停止')),
    h('button', { class: 'btn', onclick: () => void ctl('start') }, document.createTextNode('启动')),
    h('button', {
      class: 'btn',
      onclick: () => void openInBrowser(),
    }, document.createTextNode('在浏览器打开')),
  )

  const logCard = h('div', { class: 'card', style: 'display:flex;flex-direction:column;min-height:0;flex:1' })
  const logHead = h('div', { class: 'row' },
    h('h3', { class: 'grow', style: 'margin:0' }, document.createTextNode('日志')),
    h('button', { class: 'btn small', onclick: () => void bridge().clearLogs() }, document.createTextNode('清空')),
  )
  logView = h('div', { id: 'logView' })
  logCard.append(logHead, logView)

  const layout = h('div', { style: 'display:flex;flex-direction:column;height:100%;gap:0' }, statusBox, actions, logCard)
  pane.append(layout)

  logView.addEventListener('scroll', () => {
    autoScroll = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 30
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  const initial = await bridge().subscribeLogs()
  for (const line of initial) appendLine(line, false)
  flush()
  bridge().on('logs:line', (payload) => {
    queueLine(payload as LogLine)
  })
  bridge().on('logs:cleared', () => {
    logView.innerHTML = ''
  })
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
    alert(String(err))
  }
}

async function openInBrowser(): Promise<void> {
  const s = await bridge().getState()
  window.open(s.status.serviceUrl, '_blank')
}

function stateBadge(state: DshStatus['state']): HTMLElement {
  const cls = state === 'running' ? 'ok' : state === 'starting' || state === 'stopping' ? 'warn' : 'err'
  return h('span', { class: `badge ${cls}` }, document.createTextNode(stateLabels[state] ?? state))
}

function renderStatus(s: DshStatus): void {
  statusBox.innerHTML = ''
  const uptime = s.startedAt && s.state === 'running'
    ? `${Math.floor((Date.now() - s.startedAt) / 1000)} s`
    : '—'
  statusBox.append(
    h('div', { class: 'row' },
      h('h3', { class: 'grow', style: 'margin:0' }, document.createTextNode('DSH 服务'), stateBadge(s.state)),
    ),
    h('div', { class: 'kv', style: 'margin-top:10px' },
      h('div', { class: 'k' }, document.createTextNode('地址')),
      h('div', { class: 'mono' }, document.createTextNode(s.serviceUrl)),
      h('div', { class: 'k' }, document.createTextNode('端口')),
      h('div', { class: 'mono' }, document.createTextNode(String(s.port))),
      h('div', { class: 'k' }, document.createTextNode('版本')),
      h('div', { class: 'mono' }, document.createTextNode(s.version === 'bundled' ? '捆绑版本' : s.version)),
      h('div', { class: 'k' }, document.createTextNode('PID')),
      h('div', { class: 'mono' }, document.createTextNode(s.pid ? String(s.pid) : '—')),
      h('div', { class: 'k' }, document.createTextNode('已运行')),
      h('div', { class: 'mono' }, document.createTextNode(uptime)),
      h('div', { class: 'k' }, document.createTextNode('已启用插件')),
      h('div', { class: 'mono' }, document.createTextNode(s.enabledPlugins.length ? s.enabledPlugins.join(', ') : '无')),
    ),
  )
  if (s.detail && s.state !== 'running') {
    statusBox.append(h('p', { class: 'muted', style: 'margin:10px 0 0' }, document.createTextNode(s.detail)))
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
  // Keep the DOM bounded.
  while (logView.childElementCount > 2000) logView.firstElementChild?.remove()
  if (autoScroll) logView.scrollTop = logView.scrollHeight
}

function appendLine(line: LogLine, animate: boolean): void {
  const el = h('div', { class: `log-line ${line.level}` },
    h('span', { class: 'src' }, document.createTextNode(`${fmtTime(line.ts)} [${line.source}]`)),
    h('span', { class: 'txt' }, document.createTextNode(line.text)),
  )
  if (!animate) el.style.opacity = '0.75'
  logView.append(el)
}
