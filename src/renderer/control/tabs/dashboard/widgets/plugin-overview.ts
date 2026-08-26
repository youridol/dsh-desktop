/**
 * 插件概览 Widget。
 *
 * 复用既有插件服务（plugins:list），只做汇总与入口：已安装 / 已启用 / 异常数量、
 * 最近启用插件短列表，并可跳转到插件管理页。不复制插件安装 / 启停逻辑。
 */
import { type PluginView } from '../../../api'
import { badge, button, h, row, statCount, text } from '../../../ui'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

let host: HTMLElement | null = null

function pluginBadge(p: PluginView): HTMLElement {
  const variant = p.error ? 'err' : p.enabled ? 'ok' : undefined
  const label = p.error ? '异常' : p.enabled ? '已启用' : '已停用'
  return badge(label, variant)
}

function renderWidget(plugins: PluginView[]): void {
  if (!host) return
  const enabled = plugins.filter((p) => p.enabled)
  const errored = plugins.filter((p) => p.error)

  host.replaceChildren(
    row(
      statCount('已安装', plugins.length),
      statCount('已启用', enabled.length, 'ok'),
      statCount('异常', errored.length, errored.length ? 'err' : ''),
    ),
  )

  const list = h('div', { class: 'dash-mini-list' })
  if (enabled.length === 0) {
    list.append(text('暂无启用插件'))
  } else {
    for (const p of enabled.slice(0, 5)) {
      list.append(row(text(p.packageName), pluginBadge(p)))
    }
    if (enabled.length > 5) {
      list.append(h('p', { class: 'muted' }, text(`… 等共 ${enabled.length} 个已启用`)))
    }
  }
  host.append(list)
  host.append(row(button({ size: 'sm', onClick: () => goTab('plugins') }, text('管理插件'))))
}

async function refresh(ctx: DashboardWidgetContext): Promise<void> {
  try {
    const result = await ctx.bridge().listPlugins()
    renderWidget(result.plugins)
  } catch (err) {
    ctx.toast(`插件概览刷新失败：${String(err)}`, true)
  }
}

function goTab(name: string): void {
  document.querySelector<HTMLElement>(`.tab[data-tab="${name}"]`)?.click()
}

registerDashboardWidget({
  id: 'plugin-overview',
  title: '插件概览',
  refreshIntervalMs: 15_000,
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
