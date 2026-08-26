/**
 * DSH 服务监控 Widget。
 *
 * 直接复用既有 DSH 状态机（src/main/dsh/manager.ts）与 app:getState / dsh:status
 * 事件：展示运行状态、端口、PID、当前版本与运行时长，并提供启动 / 停止 / 重启
 * 操作入口 —— 不重复实现任何服务生命周期逻辑。
 */
import { type DshStatus } from '../../../api'
import { badge, button, h, kv, row, text } from '../../../ui'
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
  const variant = state === 'running' ? 'ok' : state === 'starting' || state === 'stopping' ? 'warn' : 'err'
  return badge(STATE_LABELS[state] ?? state, variant)
}

function renderStatus(s: DshStatus): void {
  if (!host) return
  host.replaceChildren(
    kv([
      ['状态', statusBadge(s.state)],
      ['地址', s.serviceUrl],
      ['端口', String(s.port)],
      ['版本', s.version === 'bundled' ? '捆绑版本' : s.version],
      ['PID', s.pid ? String(s.pid) : '—'],
      ['已运行', s.startedAt && s.state === 'running' ? `${Math.floor((Date.now() - s.startedAt) / 1000)} 秒` : '—'],
    ]),
    row(
      button({ size: 'sm', onClick: () => void ctl('restart') }, text('重启')),
      button({ size: 'sm', onClick: () => void ctl('stop') }, text('停止')),
      button({ size: 'sm', onClick: () => void ctl('start') }, text('启动')),
    ),
  )
  if (s.detail && s.state !== 'running') {
    host.append(h('p', { class: 'muted' }, text(s.detail.slice(0, 120))))
  }
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
