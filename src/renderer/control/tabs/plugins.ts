/**
 * 插件管理：通过 dsh plugin --profile <profile> CLI 安装/卸载/启用/禁用/导出。
 * 布局与组件统一走 control/ui 组件库；行为与既有 IPC 通道保持一致。
 */
import { bridge, type DshMarketStatus, type PluginInstallSource, type PluginListResult, type PluginView } from '../api'
import {
  badge, button, card, confirmDialog, h, inputEl, listContainer, listHint, listItem, row,
  segmented, switchControl, text,
} from '../ui'

let pane: HTMLElement
let toastFn: (msg: string, err?: boolean) => void = () => {}
let source: PluginInstallSource = 'npm'
let nameInputEl: HTMLInputElement
let profileInputEl: HTMLInputElement
let profileRowEl: HTMLElement
let listEl: HTMLElement
let applyBtn: HTMLButtonElement
let marketStatusEl: HTMLElement
let marketOpenBtn: HTMLButtonElement
let marketInstallBtn: HTMLButtonElement

const INSTALL_SOURCE_LABELS: Record<PluginInstallSource, string> = {
  npm: 'npm',
  npx: 'npx',
  'dsh-profile': 'dsh',
}

function sourceLabel(source: PluginInstallSource): string {
  return INSTALL_SOURCE_LABELS[source]
}

function toggleProfileRow(): void {
  if (!profileRowEl) return
  profileRowEl.style.display = source === 'dsh-profile' ? '' : 'none'
  if (profileInputEl && source === 'dsh-profile' && !profileInputEl.value) profileInputEl.value = 'web'
}

export function initPlugins(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  toastFn = toast
  pane.innerHTML = ''

  const marketCard = card(
    { title: '插件市场（dsh-market）', actions: [button({ size: 'sm', onClick: () => void refreshMarket() }, text('刷新'))] },
    marketStatusEl = h('div', { id: 'marketStatus', class: 'kv' }),
    row(
      marketOpenBtn = button({ variant: 'primary', size: 'sm', onClick: () => void openMarket() }, text('在主窗口打开')),
      marketInstallBtn = button({ size: 'sm', onClick: () => void ensureMarket() }, text('安装插件市场')),
      listHint('内置官方插件市场：浏览、搜索、一键安装社区插件。'),
    ),
  )

  const installCard = card(
    { title: '安装插件（npm 包）' },
    row(
      text('安装方式：'),
      segmented<PluginInstallSource>(
        [
          { value: 'npm', label: INSTALL_SOURCE_LABELS.npm },
          { value: 'npx', label: INSTALL_SOURCE_LABELS.npx },
          { value: 'dsh-profile', label: INSTALL_SOURCE_LABELS['dsh-profile'] },
        ],
        source,
        (v) => {
          source = v
          toggleProfileRow()
        },
      ),
    ),
    row(
      nameInputEl = inputEl({ type: 'text', placeholder: '插件名称或 GitHub 地址，如 dshmarket / @scope/plugin / github:owner/repo', width: 280 }),
      profileRowEl = h('div', { class: 'row' },
        text('Profile：'),
        profileInputEl = inputEl({ type: 'text', placeholder: 'Profile 名称，如 web', width: 100 }),
      ),
      button({ variant: 'primary', size: 'sm', onClick: () => void installPlugin() }, text('安装')),
    ),
    listHint('通过 dsh plugin --profile <profile> add 安装 npm/npx 插件；dsh 安装可指定任意 Profile，需要 pnpm。'),
  )

  const listCard = card(
    { title: '已安装插件', actions: [button({ size: 'sm', onClick: () => void refresh() }, text('刷新'))] },
    listEl = listContainer('pluginList'),
    listHint('启用/停用状态保存后需重启 DSH 生效。'),
  )

  const applyRow = row(
    applyBtn = button({ variant: 'primary', size: 'sm', onClick: () => void applyAndRestart() }, text('应用并重启 DSH')),
    listHint('启用/停用状态保存后需重启 DSH 生效。'),
  )

  const embedCard = card(
    { title: '市场原生界面（dsh-market Web UI）' },
    row(
      button({ variant: 'primary', size: 'sm', onClick: () => void openNativeMarketWindow() }, text('打开市场原生界面')),
      listHint('打开独立窗口，直接承载 dsh-market 原生 Web UI（DSH 设置 → 插件市场 同款组件）：浏览、搜索、一键安装、更新与卸载全部为官方原生行为，操作结果实时写入 Web Profile。'),
    ),
  )

  pane.append(marketCard, embedCard, installCard, listCard, applyRow)
  toggleProfileRow()
  void refresh()
  void refreshMarket()
  void autoEnsureMarket()
}

async function refresh(): Promise<void> {
  try {
    const result: PluginListResult = await bridge().listPlugins()
    renderList(result)
  } catch (err) {
    toastFn(`获取插件列表失败：${String(err)}`, true)
  }
}

function renderList(result: PluginListResult): void {
  listEl.replaceChildren()
  const { plugins, profileDir } = result
  if (plugins.length === 0) {
    listEl.append(h('p', { class: 'empty' }, text('暂无插件。通过上方输入框选择安装方式安装，或运行 dsh plugin --profile web add <包名>。')))
    return
  }
  listEl.append(listHint(`共 ${plugins.length} 个 · 配置目录：${profileDir}`))
  for (const p of plugins) listEl.append(renderItem(p))
}

function renderItem(p: PluginView): HTMLElement {
  const toggle = switchControl(p.enabled, (on) => {
    void (async () => {
      try {
        if (on) await bridge().enablePlugin(p.id)
        else await bridge().disablePlugin(p.id)
        toastFn(`插件 ${p.id} 已${on ? '启用' : '停用'}，点击「应用并重启 DSH」生效`)
      } catch (err) {
        toggle.input.checked = !on
        toastFn(`操作失败：${String(err)}`, true)
      }
    })()
  })

  const badges: Node[] = []
  if (p.isBundle) badges.push(badge('插件', 'accent'))
  if (!p.isBundle && p.enabled) badges.push(badge('已启用', 'ok'))
  if (!p.enabled) badges.push(badge('已停用', 'muted'))
  badges.push(badge(sourceLabel(p.source)))

  const removeBtn = button({ size: 'sm', variant: 'danger', onClick: () => void uninstallPlugin(p) }, text('卸载'))
  const exportBtn = button({ size: 'sm', onClick: () => void exportPlugin(p) }, text('导出'))

  return listItem(
    toggle.root,
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(p.packageName), ...badges),
      h('div', { class: 'sub mono' }, text([p.version ? `v${p.version}` : '', p.isBundle ? '插件层' : '普通依赖', `Profile：${p.profile}`, p.description ?? ''].filter(Boolean).join(' · '))),
    ),
    exportBtn,
    removeBtn,
  )
}

async function uninstallPlugin(p: PluginView): Promise<void> {
  const ok = await confirmDialog({
    title: '卸载插件',
    message: `确定卸载插件 ${p.packageName}？（来源：${sourceLabel(p.source)}，Profile：${p.profile}）`,
    confirmLabel: '卸载',
    danger: true,
  })
  if (!ok) return
  try {
    await bridge().uninstallPlugin(p.id)
    toastFn(`已卸载 ${p.packageName}`)
    await refresh()
  } catch (err) {
    toastFn(`卸载失败：${String(err)}`, true)
  }
}

async function exportPlugin(p: PluginView): Promise<void> {
  try {
    const info = await bridge().exportPlugin(p.id)
    if (info) {
      const textValue = `${info.packageName}${info.version ? '@' + info.version : ''}`
      await navigator.clipboard.writeText(textValue)
      toastFn(`已复制到剪贴板：${textValue}`)
    } else {
      toastFn('未找到插件信息', true)
    }
  } catch (err) {
    toastFn(`导出失败：${String(err)}`, true)
  }
}

/** Build the confirm dialog body listing the packages pnpm wants allowlisted. */
function buildBlockedMessage(result: { keys: string[]; names: string[] }): HTMLElement {
  const detail = [...result.keys, ...result.names]
  return h('div', {},
    h('p', {}, text('pnpm 默认阻止依赖运行构建脚本（如 GitHub 插件的 prepare），导致安装失败。')),
    h('p', {}, text('点击「放行构建脚本并重试」会将以下包写入本机 Profile 的 pnpm 构建白名单，并自动重新安装：')),
    h('div', { class: 'mono' }, ...(detail.length > 0 ? detail.map((k) => h('div', {}, text(k))) : [text('（未识别到具体包名，将直接重试）')])),
  )
}

/** Shared success handling for the first attempt and the allow-builds retry. */
function finishInstall(
  name: string,
  source: PluginInstallSource,
  profile: string,
  installed: PluginView[],
): void {
  if (installed.length === 0) {
    toastFn(`安装完成，但列表未显示 ${name}（可能安装到了其他 Profile），请检查`, true)
    return
  }
  toastFn(`已安装插件 ${name}（${sourceLabel(source)}${source === 'dsh-profile' ? ` · Profile：${profile}` : ''}），点击「应用并重启 DSH」生效`)
  nameInputEl.value = ''
  void refresh()
}

async function installPlugin(): Promise<void> {
  const name = nameInputEl.value.trim()
  const profile = profileInputEl.value.trim()
  if (!name) {
    toastFn('请输入插件名称', true)
    return
  }
  if (source === 'dsh-profile' && !profile) {
    toastFn('dsh 安装必须填写 Profile', true)
    return
  }
  const opts: { name: string; source: PluginInstallSource; profile?: string } =
    source === 'dsh-profile' ? { name, source, profile } : { name, source }
  nameInputEl.disabled = true
  try {
    const result = await bridge().addPlugin(opts)
    if (result.status === 'build-blocked') {
      const allow = await confirmDialog({
        title: '构建脚本被 pnpm 拦截',
        message: buildBlockedMessage(result),
        confirmLabel: '放行构建脚本并重试',
        cancelLabel: '取消',
        width: 560,
      })
      if (!allow) {
        toastFn('已取消安装（未修改任何构建策略）', true)
        return
      }
      const retried = await bridge().addPlugin({ ...opts, allowBuilds: true })
      if (retried.status === 'build-blocked') {
        toastFn(`放行构建脚本后仍被拦截：${retried.message}`, true)
        return
      }
      finishInstall(name, source, profile, retried.plugins)
      return
    }
    finishInstall(name, source, profile, result.plugins)
  } catch (err) {
    toastFn(`安装失败：${String(err)}`, true)
  } finally {
    nameInputEl.disabled = false
  }
}

async function applyAndRestart(): Promise<void> {
  applyBtn.disabled = true
  applyBtn.textContent = '正在重启 DSH…'
  try {
    const status = await bridge().applyPlugins()
    toastFn(status.state === 'running' ? 'DSH 已重启，插件配置已应用' : `DSH 状态：${status.state}`)
  } catch (err) {
    toastFn(`重启失败：${String(err)}`, true)
  } finally {
    applyBtn.disabled = false
    applyBtn.textContent = '应用并重启 DSH'
  }
}


// ---- plugin market (dsh-market 快捷配置入口) ----

/** 刷新市场状态展示。 */
async function refreshMarket(): Promise<void> {
  try {
    const status = await bridge().marketStatus()
    renderMarketStatus(status)
  } catch (err) {
    toastFn(`获取插件市场状态失败：${String(err)}`, true)
  }
}

function renderMarketStatus(s: DshMarketStatus): void {
  if (!marketStatusEl) return
  const rows: Array<[string, string]> = []
  if (!s.installed) {
    rows.push(['状态', '未安装'])
  } else {
    rows.push(['状态', s.enabled ? (s.active ? '已启用并挂载' : '已启用（重启后挂载）') : '已停用'])
    rows.push(['版本', s.activeVersion ?? s.version ?? '—'])
  }
  rows.push(['DSH 服务', s.dshRunning ? '运行中' : '未运行'])
  marketStatusEl.replaceChildren(
    ...rows.map(([k, v]) => h('div', { class: 'row' }, text(k + '：'), text(v))),
  )
  const openBtn = marketOpenBtn
  const installBtn = marketInstallBtn
  if (openBtn) openBtn.disabled = !s.installed
  if (installBtn) installBtn.style.display = s.installed ? 'none' : ''
}

/** 打开插件市场：确保已装（缺失自动安装）→ 重启生效 → 在主窗口打开市场。 */
async function openMarket(): Promise<void> {
  if (!marketOpenBtn) return
  marketOpenBtn.disabled = true
  marketOpenBtn.textContent = '正在打开插件市场…'
  try {
    const status = await bridge().openMarket()
    renderMarketStatus(status)
    toastFn(status.available
      ? '插件市场已打开（DSH Web 界面）'
      : '插件市场入口已就绪，请在主窗口点击 设置 → 插件市场')
  } catch (err) {
    toastFn(`打开插件市场失败：${String(err)}`, true)
  } finally {
    if (marketOpenBtn) {
      marketOpenBtn.disabled = false
      marketOpenBtn.textContent = '打开插件市场'
    }
  }
}

/** 手动安装插件市场（缺失时）。 */
async function ensureMarket(): Promise<void> {
  if (!marketInstallBtn) return
  marketInstallBtn.disabled = true
  marketInstallBtn.textContent = '正在安装…'
  try {
    const status = await bridge().ensureMarket()
    renderMarketStatus(status)
    toastFn(status.installed ? '插件市场已安装，打开时将重启 DSH 生效' : '插件市场安装失败', !status.installed)
  } catch (err) {
    toastFn(`安装插件市场失败：${String(err)}`, true)
  } finally {
    if (marketInstallBtn) {
      marketInstallBtn.disabled = false
      marketInstallBtn.textContent = '安装插件市场'
    }
  }
}

/** 本地环境没有 dsh-market 时自动安装（进入插件页签时触发一次）。 */
let marketAutoEnsureRan = false
async function autoEnsureMarket(): Promise<void> {
  if (marketAutoEnsureRan) return
  marketAutoEnsureRan = true
  try {
    const status = await bridge().marketStatus()
    if (!status.installed) {
      toastFn('检测到本地未安装插件市场，正在自动安装 dshmarket…')
      const after = await bridge().ensureMarket()
      renderMarketStatus(after)
      if (after.installed) {
        toastFn('插件市场已自动安装，点击「打开插件市场」重启 DSH 后生效')
      }
    } else {
      renderMarketStatus(status)
    }
  } catch (err) {
    toastFn(`自动安装插件市场失败：${String(err)}`, true)
  }
}

// ---- 市场原生界面（独立窗口承载 dsh-market 原生 Web UI） ----

/**
 * 打开市场原生界面窗口。
 *
 * dsh-market 的原生 UI 是注册在 DSH 设置对话框 settings.section 槽位
 * （id = 'market'）里的 React 组件，没有独立 URL，且 DSH SPA 在 webview
 * guest 中无法可靠运行。因此这里打开一个独立窗口，以与主窗口完全相同的
 * 路径加载真实 DSH Web UI，并自动定位到 设置 → 插件市场——所有交互仍是
 * dsh-market 官方 React 组件（浏览 / 搜索 / 一键安装 / 更新 / 卸载），
 * 行为与主窗口完全一致，不改造 deepseek-harness / dsh-market。
 */
async function openNativeMarketWindow(): Promise<void> {
  try {
    const ok = await bridge().openMarketWindow()
    if (ok) {
      toastFn('市场原生界面窗口已打开（DSH Web UI → 设置 → 插件市场）')
    } else {
      toastFn('正在启动 DSH 服务，就绪后自动打开市场…')
    }
  } catch (err) {
    toastFn(`打开市场原生界面失败：${String(err)}`, true)
  }
}

