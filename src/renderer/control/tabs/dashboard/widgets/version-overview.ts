/**
 * 版本概览 Widget。
 *
 * 复用 app:getState 返回的当前 DSH 版本 / 桌面壳版本 / 本机已装版本列表，
 * 汇总为指标卡并提供跳转到版本管理页的入口。版本检测、下载与切换逻辑仍在
 * 版本页，本 Widget 不重复实现。
 */
import { h, type AppState } from '../../../api'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

let host: HTMLElement | null = null

function renderWidget(s: AppState): void {
  if (!host) return
  host.innerHTML = ''
  host.append(
    h('div', { class: 'kv' },
      h('div', { class: 'k' }, document.createTextNode('当前 DSH')),
      h('div', { class: 'mono' }, document.createTextNode(s.versionLabel)),
      h('div', { class: 'k' }, document.createTextNode('桌面壳版本')),
      h('div', { class: 'mono' }, document.createTextNode(s.appVersion)),
      h('div', { class: 'k' }, document.createTextNode('本机已装')),
      h('div', { class: 'mono' }, document.createTextNode(`${s.versions.length} 个版本`)),
    ),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn small', onclick: () => goTab('versions') }, document.createTextNode('版本管理'))),
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
