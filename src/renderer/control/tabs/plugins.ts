/**
 * 插件管理：通过 dsh plugin --profile <profile> CLI 安装/卸载/启用/禁用/导出。
 * 布局与组件统一走 control/ui 组件库；行为与既有 IPC 通道保持一致。
 */
import { bridge, type PluginInstallSource, type PluginListResult, type PluginView } from '../api'
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

  pane.append(installCard, listCard, applyRow)
  toggleProfileRow()
  void refresh()
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
