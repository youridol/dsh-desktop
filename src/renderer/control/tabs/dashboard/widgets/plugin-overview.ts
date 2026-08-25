/**
 * 插件概览 Widget。
 *
 * 复用既有插件服务（src/main/services/dsh/DshPluginService.ts 的 plugins:list
 * 通道），只做汇总与入口：已安装 / 已启用 / 异常数量、最近启用插件短列表，
 * 并可直接跳转到插件管理页。不复制插件安装 / 启停逻辑。
 */
import { h, type PluginView } from '../../../api'
import { registerDashboardWidget, type DashboardWidgetContext } from '../widget'

let host: HTMLElement | null = null

function pluginBadge(p: PluginView): HTMLElement {
  const cls = p.error ? 'err' : p.enabled ? 'ok' : ''
  const label = p.error ? '异常' : p.enabled ? '已启用' : '已停用'
  return h('span', { class: `badge ${cls}` }, document.createTextNode(label))
}

function stat(label: string, value: number, cls: string): HTMLElement {
  return h('div', {},
    h('div', { class: `dash-count ${cls}` }, document.createTextNode(String(value))),
    h('div', { class: 'muted' }, document.createTextNode(label)),
  )
}

function renderWidget(plugins: PluginView[]): void {
  if (!host) return
  const enabled = plugins.filter((p) => p.enabled)
  const errored = plugins.filter((p) => p.error)

  host.innerHTML = ''
  host.append(
    h('div', { class: 'row', style: 'gap:18px' },
      stat('已安装', plugins.length, ''),
      stat('已启用', enabled.length, 'ok'),
      stat('异常', errored.length, errored.length ? 'err' : ''),
    ),
  )

  const list = h('div', { class: 'dash-mini-list', style: 'margin-top:6px' })
  if (enabled.length === 0) {
    list.append(h('p', { class: 'muted' }, document.createTextNode('暂无启用插件')))
  } else {
    for (const p of enabled.slice(0, 5)) {
      list.append(h('div', { class: 'row' },
        h('span', { class: 'mono grow' }, document.createTextNode(p.packageName)),
        pluginBadge(p),
      ))
    }
    if (enabled.length > 5) {
      list.append(h('p', { class: 'muted' }, document.createTextNode(`… 等共 ${enabled.length} 个已启用`)))
    }
  }
  host.append(list)

  host.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', { class: 'btn small', onclick: () => goTab('plugins') }, document.createTextNode('管理插件'))))
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
