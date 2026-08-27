/**
 * 插件管理：通过 dsh plugin --profile <profile> CLI 安装/卸载/启用/禁用/导出。
 * 布局与组件统一走 control/ui 组件库；行为与既有 IPC 通道保持一致。
 *
 * 安装来源（source）：
 *  - npm / npx / dsh / pnpm / github：固定安装通道（内部都经 dsh plugin 原生
 *    通道或 profile 内 pnpm，github 模式输入 GitHub 地址）；
 *  - custom：自定义命令（输入完整命令行，如
 *    `npx dsh plugin --profile web add <pkg>` / `pnpm add <pkg>`），
 *    由主进程分词为参数数组执行（永不经过 shell 解释）。
 *
 * 市场：dsh-market 原生 Web UI 直接内嵌在本页卡片容器中（iframe 承载 DSH
 * Web UI → 设置 → 插件市场，100% 官方 React 组件），不再另开窗口。
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
let commandRowEl: HTMLElement
let commandInputEl: HTMLInputElement
let listEl: HTMLElement
let applyBtn: HTMLButtonElement
let marketStatusEl: HTMLElement
let marketInstallBtn: HTMLButtonElement
let marketFrameEl: HTMLIFrameElement
let marketFrameWrap: HTMLElement

const INSTALL_SOURCE_LABELS: Record<PluginInstallSource, string> = {
  npm: 'npm',
  npx: 'npx',
  'dsh-profile': 'dsh',
  pnpm: 'pnpm',
  github: 'GitHub',
  custom: '自定义命令',
}

/** 安装方式是否需要 Profile 输入。 */
function sourceNeedsProfile(source: PluginInstallSource): boolean {
  return source === 'dsh-profile' || source === 'pnpm'
}

/** 安装方式是否需要自定义命令输入。 */
function sourceNeedsCommand(source: PluginInstallSource): boolean {
  return source === 'custom'
}

function sourceLabel(source: PluginInstallSource): string {
  return INSTALL_SOURCE_LABELS[source]
}

function toggleInstallRows(): void {
  if (!profileRowEl) return
  profileRowEl.style.display = sourceNeedsProfile(source) ? '' : 'none'
  if (profileInputEl && sourceNeedsProfile(source) && !profileInputEl.value) profileInputEl.value = 'web'
  if (commandRowEl) commandRowEl.style.display = sourceNeedsCommand(source) ? '' : 'none'
  if (nameInputEl) {
    nameInputEl.placeholder = source === 'github'
      ? 'GitHub 仓库地址，如 github:owner/repo 或 https://github.com/owner/repo'
      : source === 'custom'
        ? '插件名称或包名（命令填在下方命令框）'
        : '插件名称或 GitHub 地址，如 dshmarket / @scope/plugin / github:owner/repo'
  }
}

export function initPlugins(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  toastFn = toast
  pane.innerHTML = ''

  // ---- 市场原生界面（内嵌卡片容器） ----
  const marketCard = card(
    { title: '插件市场（dsh-market 原生 Web UI）', actions: [button({ size: 'sm', onClick: () => void refreshMarket() }, text('刷新'))] },
    marketStatusEl = h('div', { id: 'marketStatus', class: 'kv' }),
    row(
      marketInstallBtn = button({ size: 'sm', onClick: () => void ensureMarket() }, text('安装插件市场')),
      listHint('直接内嵌 dsh-market 官方原生 Web UI（DSH 设置 → 插件市场 同款组件）：浏览、搜索、一键安装、更新与卸载全部为官方原生行为，操作结果实时写入 Web Profile。'),
    ),
    marketFrameWrap = h('div', { class: 'market-frame-wrap', id: 'marketFrameWrap' },
      marketFrameEl = h('iframe', {
        id: 'marketFrame',
        class: 'market-frame',
        src: 'about:blank',
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
      }) as HTMLIFrameElement,
    ),
  )

  // ---- 安装插件 ----
  const installCard = card(
    { title: '安装插件' },
    row(
      text('安装方式：'),
      segmented<PluginInstallSource>(
        [
          { value: 'npm', label: INSTALL_SOURCE_LABELS.npm },
          { value: 'npx', label: INSTALL_SOURCE_LABELS.npx },
          { value: 'dsh-profile', label: INSTALL_SOURCE_LABELS['dsh-profile'] },
          { value: 'pnpm', label: INSTALL_SOURCE_LABELS.pnpm },
          { value: 'github', label: INSTALL_SOURCE_LABELS.github },
          { value: 'custom', label: INSTALL_SOURCE_LABELS.custom },
        ],
        source,
        (v) => {
          source = v
          toggleInstallRows()
        },
      ),
    ),
    row(
      nameInputEl = inputEl({ type: 'text', placeholder: '插件名称或 GitHub 地址，如 dshmarket / @scope/plugin / github:owner/repo', width: 300 }),
      profileRowEl = h('div', { class: 'row' },
        text('Profile：'),
        profileInputEl = inputEl({ type: 'text', placeholder: 'Profile 名称，如 web', width: 100 }),
      ),
      button({ variant: 'primary', size: 'sm', onClick: () => void installPlugin() }, text('安装')),
    ),
    commandRowEl = h('div', { class: 'row', style: 'display:none' },
      text('命令：'),
      commandInputEl = inputEl({ type: 'text', placeholder: '如 npx dsh plugin --profile web add <包名>', width: 360 }),
    ),
    listHint('npm/npx/dsh/pnpm/GitHub 走官方 dsh plugin 通道；GitHub 模式输入仓库地址；自定义命令按输入原样分词执行（不做 shell 解释）。'),
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

  pane.append(marketCard, installCard, listCard, applyRow)
  toggleInstallRows()
  wireMarketFrameNavigation()
  void refresh()
  void refreshMarket()
  void autoEnsureMarket()
}
// ---- 已安装插件列表 ----

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

/** Build the confirm dialog body listing refs pnpm's minimumReleaseAge gate rejects. */
function buildReleaseAgeMessage(result: { refs: string[] }): HTMLElement {
  const detail = result.refs
  return h('div', {},
    h('p', {}, text('pnpm 的 minimumReleaseAge 供应链策略拦截了近期发布的包（24 小时内），导致安装失败。')),
    h('p', {}, text('点击「放行并重试」会将以下包写入本机 Profile 的 minimumReleaseAgeExclude，并自动重新安装：')),
    h('div', { class: 'mono' }, ...(detail.length > 0 ? detail.map((k) => h('div', {}, text(k))) : [text('（未识别到具体包名，将直接重试）')])),
  )
}

/** Shared success handling for the first attempt and the retry paths. */
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
  const profileNote = sourceNeedsProfile(source) ? ` · Profile：${profile}` : ''
  toastFn(`已安装插件 ${name}（${sourceLabel(source)}${profileNote}），点击「应用并重启 DSH」生效`)
  nameInputEl.value = ''
  if (commandInputEl) commandInputEl.value = ''
  void refresh()
  void refreshMarket()
}
async function installPlugin(): Promise<void> {
  const name = nameInputEl.value.trim()
  const profile = profileInputEl.value.trim()
  if (!name) {
    toastFn('请输入插件名称', true)
    return
  }
  if (sourceNeedsProfile(source) && !profile) {
    toastFn(`${sourceLabel(source)} 安装必须填写 Profile`, true)
    return
  }
  if (source === 'custom') {
    const cmd = (commandInputEl?.value ?? '').trim()
    if (!cmd) {
      toastFn('自定义命令安装必须填写命令', true)
      return
    }
  }
  const opts: { name: string; source: PluginInstallSource; profile?: string; command?: string } = {
    name,
    source,
    ...(sourceNeedsProfile(source) ? { profile } : {}),
    ...(source === 'custom' ? { command: (commandInputEl?.value ?? '').trim() } : {}),
  }
  nameInputEl.disabled = true
  if (commandInputEl) commandInputEl.disabled = true
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
      if (retried.status === 'build-blocked' || retried.status === 'release-age-blocked') {
        toastFn(`放行后仍被拦截：${retried.message}`, true)
        return
      }
      finishInstall(name, source, profile, retried.plugins)
      return
    }
    if (result.status === 'release-age-blocked') {
      const allow = await confirmDialog({
        title: 'minimumReleaseAge 供应链策略拦截',
        message: buildReleaseAgeMessage(result),
        confirmLabel: '放行并重试',
        cancelLabel: '取消',
        width: 560,
      })
      if (!allow) {
        toastFn('已取消安装（未修改任何供应链策略）', true)
        return
      }
      const retried = await bridge().addPlugin({ ...opts, allowReleaseAge: true })
      if (retried.status === 'release-age-blocked') {
        toastFn(`放行后仍被拦截：${retried.message}`, true)
        return
      }
      if (retried.status === 'build-blocked') {
        // 供应链放行后又撞上构建脚本拦截：再走一次构建放行。
        const allowBuild = await confirmDialog({
          title: '构建脚本被 pnpm 拦截',
          message: buildBlockedMessage(retried),
          confirmLabel: '放行构建脚本并重试',
          cancelLabel: '取消',
          width: 560,
        })
        if (!allowBuild) {
          toastFn('已取消安装（未修改任何构建策略）', true)
          return
        }
        const retried2 = await bridge().addPlugin({ ...opts, allowBuilds: true, allowReleaseAge: true })
        if (retried2.status === 'build-blocked' || retried2.status === 'release-age-blocked') {
          toastFn(`放行后仍被拦截：${retried2.message}`, true)
          return
        }
        finishInstall(name, source, profile, retried2.plugins)
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
    if (commandInputEl) commandInputEl.disabled = false
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

// ---- plugin market（内嵌原生 Web UI） ----

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
  const installBtn = marketInstallBtn
  if (installBtn) installBtn.style.display = s.installed ? 'none' : ''
  // 内嵌 iframe：市场就绪时加载真实 DSH Web UI（设置 → 插件市场）。
  updateMarketFrame(s)
}

/** 刷新内嵌市场 iframe：仅在市场已挂载时加载真实 DSH UI。 */
function updateMarketFrame(s: DshMarketStatus): void {
  if (!marketFrameEl || !marketFrameWrap) return
  if (!s.available) {
    marketFrameWrap.classList.add('hidden')
    return
  }
  marketFrameWrap.classList.remove('hidden')
  const url = new URL(s.serviceUrl ?? 'http://127.0.0.1:3080')
  const target = url.origin
  if (marketFrameEl.dataset.loaded === target) return
  marketFrameEl.dataset.loaded = target
  marketFrameEl.src = target
}

/** 市场 iframe 加载完成后，请求主进程在子 frame 中执行市场导航脚本。 */
function wireMarketFrameNavigation(): void {
  if (!marketFrameEl || marketFrameEl.dataset.navWired) return
  marketFrameEl.dataset.navWired = '1'
  marketFrameEl.addEventListener('load', () => {
    if (!marketFrameEl || marketFrameEl.src === 'about:blank') return
    // 每个目标只导航一次（SPA 启动后后续内部跳转不应再触发）。
    if (marketFrameEl.dataset.navTarget === marketFrameEl.src) return
    marketFrameEl.dataset.navTarget = marketFrameEl.src
    // 先给 SPA 启动留一点时间，再触发主进程导航（跨源 frame 只能在主进程执行）。
    setTimeout(() => {
      void bridge().marketNavigateFrame().catch(() => undefined)
    }, 1200)
  })
}

/** 手动安装插件市场（缺失时）。 */
async function ensureMarket(): Promise<void> {
  if (!marketInstallBtn) return
  marketInstallBtn.disabled = true
  marketInstallBtn.textContent = '正在安装…'
  try {
    const status = await bridge().ensureMarket()
    renderMarketStatus(status)
    toastFn(status.installed ? '插件市场已安装，DSH 重启后内嵌界面自动加载' : '插件市场安装失败', !status.installed)
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
        toastFn('插件市场已自动安装，DSH 重启后内嵌界面自动加载')
      }
    } else {
      renderMarketStatus(status)
    }
  } catch (err) {
    toastFn(`自动安装插件市场失败：${String(err)}`, true)
  }
}
