/**
 * DSH 服务监控 Widget。
 *
 * 直接复用既有 DSH 状态机（src/main/dsh/manager.ts）与 `app:getState` /
 * `dsh:status` 事件：展示运行状态、端口、PID、当前版本与运行时长，并提供
 * 启动 / 停止 / 重启操作入口 —— 不重复实现任何服务生命周期逻辑。
 */
import { h, type DshStatus } from '../../../api'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

const STATE_LABELS: Record<DshStatus['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  crashed: '异常退出',
  timeout: '启动超时',
  error: '错误',
}

let host: HTMLElement | null = null
let ctxRef: DashboardWidgetContext | null = null
let unsubStatus: (() => void) | null = null

function statusBadge(state: DshStatus['state']): HTMLElement {
  const cls = state === 'running' ? 'ok' : state === 'starting' || state === 'stopping' ? 'warn' : 'err'
  return h('span', { class: `badge ${cls}` }, document.createTextNode(STATE_LABELS[state] ?? state))
}

function renderStatus(s: DshStatus): void {
  if (!host) return
  host.innerHTML = ''
  const uptime =
    s.startedAt && s.state === 'running' ? `${Math.floor((Date.now() - s.startedAt) / 1000)} 秒` : '—'
  host.append(
    h('div', { class: 'row' },
      statusBadge(s.state),
      h('span', { class: 'muted' }, document.createTextNode(`端口 :${s.port}`)),
    ),
    h('div', { class: 'kv', style: 'margin-top:8px' },
      h('div', { class: 'k' }, document.createTextNode('地址')),
      h('div', { class: 'mono' }, document.createTextNode(s.serviceUrl)),
      h('div', { class: 'k' }, document.createTextNode('版本')),
      h('div', { class: 'mono' }, document.createTextNode(s.version === 'bundled' ? '捆绑版本' : s.version)),
      h('div', { class: 'k' }, document.createTextNode('PID')),
      h('div', { class: 'mono' }, document.createTextNode(s.pid ? String(s.pid) : '—')),
      h('div', { class: 'k' }, document.createTextNode('已运行')),
      h('div', { class: 'mono' }, document.createTextNode(uptime)),
    ),
  )
  if (s.detail && s.state !== 'running') {
    host.append(h('p', { class: 'muted', style: 'margin:6px 0 0' }, document.createTextNode(s.detail.slice(0, 120))))
  }
  host.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', { class: 'btn small primary', onclick: () => void ctl('restart') }, document.createTextNode('重启')),
    h('button', { class: 'btn small', onclick: () => void ctl('stop') }, document.createTextNode('停止')),
    h('button', { class: 'btn small', onclick: () => void ctl('start') }, document.createTextNode('启动')),
  ))
}

async function ctl(action: 'start' | 'stop' | 'restart'): Promise<void> {
  const ctx = ctxRef
  if (!ctx) return
  try {
    if (action === 'start') await ctx.bridge().start()
    else if (action === 'stop') await ctx.bridge().stop()
    else await ctx.bridge().restart()
  } catch (err) {
    ctx.toast(`操作失败：${String(err)}`, true)
  }
}

registerDashboardWidget({
  id: 'dsh-service',
  title: 'DSH 服务',
  refreshIntervalMs: 10_000,
  render(hostEl: HTMLElement, ctx: DashboardWidgetContext): void {
    host = hostEl
    ctxRef = ctx
    unsubStatus?.()
    unsubStatus = ctx.bridge().on('dsh:status', (payload) => renderStatus(payload as DshStatus))
    void ctx.bridge().getState().then((s) => renderStatus(s.status))
  },
  refresh(ctx: DashboardWidgetContext): Promise<void> {
    return ctx.bridge().getState().then((s) => renderStatus(s.status))
  },
  dispose(): void {
    unsubStatus?.()
    unsubStatus = null
    host = null
    ctxRef = null
  },
})
