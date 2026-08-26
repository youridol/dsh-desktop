/**
 * 仪表盘（Dashboard）：控制面板的统一监控入口。
 *
 * 壳本身不关心具体监控内容：所有监控模块通过注册表（./dashboard/widget.ts）
 * 提供，壳只负责挂载卡片、注入上下文、按各自 refreshIntervalMs 周期刷新。
 * 新增、替换或删除监控模块都无需改动本文件之外的核心结构（见 widget.ts）。
 */
import { bridge, type Bridge } from '../api'
import { button, card, h, text } from '../ui'
import { dashboardWidgets, type DashboardWidgetContext, type DashboardWidget } from './dashboard/widget'
import './dashboard/widgets/dsh-service'
import './dashboard/widgets/plugin-overview'
import './dashboard/widgets/version-overview'
import './dashboard/widgets/error-log'

const TICK_MS = 5000

let timer: number | null = null

export function initDashboard(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  paneEl.innerHTML = ''
  const lastRefresh = new Map<string, number>()

  const ctx: DashboardWidgetContext = {
    bridge(): Bridge {
      return bridge()
    },
    toast,
  }

  const grid = h('div', { class: 'dash-grid' })
  for (const w of dashboardWidgets()) {
    const actions = w.refresh
      ? [button({ size: 'sm', onClick: () => {
          lastRefresh.set(w.id, Date.now())
          void runRefresh(w, ctx)
        } }, text('刷新'))]
      : []
    const el = card({ className: 'dash-widget', title: w.title, actions })
    const body = el.querySelector<HTMLElement>('.card-body')!
    body.classList.add('dash-widget-body')
    grid.append(el)
    try {
      w.render(body, ctx)
    } catch (err) {
      body.append(h('p', { class: 'muted' }, text('初始化失败：' + String(err))))
    }
    lastRefresh.set(w.id, Date.now())
  }
  paneEl.append(grid)

  if (timer !== null) window.clearInterval(timer)
  timer = window.setInterval(() => {
    const now = Date.now()
    for (const w of dashboardWidgets()) {
      const interval = w.refreshIntervalMs
      if (!interval || now - (lastRefresh.get(w.id) ?? 0) < interval) continue
      lastRefresh.set(w.id, now)
      void runRefresh(w, ctx)
    }
  }, TICK_MS)
}

async function runRefresh(w: DashboardWidget, ctx: DashboardWidgetContext): Promise<void> {
  if (!w.refresh) return
  try {
    await w.refresh(ctx)
  } catch (err) {
    ctx.toast(w.title + ' 刷新失败：' + String(err), true)
  }
}
