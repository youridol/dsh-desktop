/**
 * 版本概览 Widget：复用 app:getState 返回的当前 DSH 版本、桌面壳版本与本机已装
 * 版本列表，汇总为指标卡并提供跳转到版本管理页的入口。版本检测、下载与切换
 * 逻辑仍在版本页，本 Widget 不重复实现。
 */
import { type AppState } from '../../../api'
import { button, kv, row, text } from '../../../ui'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

let host: HTMLElement | null = null

function renderWidget(s: AppState): void {
  if (!host) return
  host.replaceChildren(
    kv([
      ['当前 DSH', s.versionLabel],
      ['桌面壳版本', s.appVersion],
      ['本机已装', `${s.versions.length} 个版本`],
    ]),
    row(
      button({ size: 'sm', onClick: () => goTab('versions') }, text('版本管理')),
    ),
  )
}

async function refresh(ctx: DashboardWidgetContext): Promise<void> {
  try {
    const state = await ctx.bridge().getState()
    renderWidget(state)
  } catch (err) {
    ctx.toast(`版本概览刷新失败：${String(err)}`, true)
  }
}

function goTab(name: string): void {
  document.querySelector<HTMLElement>(`.tab[data-tab="${name}"]`)?.click()
}

registerDashboardWidget({
  id: 'version-overview',
  title: '版本概览',
  refreshIntervalMs: 30_000,
  render(hostEl: HTMLElement, ctx: DashboardWidgetContext): void {
    host = hostEl
    void refresh(ctx)
  },
  refresh(ctx: DashboardWidgetContext): Promise<void> {
    return refresh(ctx)
  },
  dispose(): void {
    host = null
  },
})
