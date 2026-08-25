/**
 * 仪表盘（Dashboard）：控制面板的统一监控入口。
 *
 * 壳本身不关心具体监控内容：所有监控模块通过注册表（./dashboard/widget.ts）
 * 提供，壳只负责挂载卡片、注入上下文、按各自 refreshIntervalMs 周期刷新。
 * 新增、替换或删除监控模块都无需改动本文件之外的核心结构（见 widget.ts）。
 */
import { h, bridge, type Bridge } from '../api'
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
    const body = h('div', { class: 'dash-widget-body' })
    const card = h('section', { class: 'card dash-widget', 'data-widget': w.id },
      h('header', { class: 'dash-widget-head' },
        h('h3', { class: 'grow' }, document.createTextNode(w.title)),
        w.refresh ? h('button', {
          class: 'btn small',
          onclick: () => {
            lastRefresh.set(w.id, Date.now())
            void runRefresh(w, ctx)
          },
        }, document.createTextNode('刷新')) : null,
      ),
      body,
    )
    grid.append(card)
    try {
      w.render(body, ctx)
    } catch (err) {
      body.append(h('p', { class: 'muted' }, document.createTextNode('初始化失败：' + String(err))))
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
