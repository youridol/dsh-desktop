/**
 * 插件管理：通过 dsh plugin --profile web CLI 安装/卸载/启用/禁用/导出。
 */
import { bridge, h, type PluginView, type PluginListResult } from '../api'

let pane: HTMLElement
let nameInput: HTMLInputElement
let list: HTMLElement
let applyBtn: HTMLButtonElement
let toastFn: (msg: string, err?: boolean) => void = () => {}

export function initPlugins(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  toastFn = toast
  pane.innerHTML = ''

  const installCard = h('div', { class: 'card' })
  installCard.append(h('h3', {}, document.createTextNode('安装插件（npm 包）')))

  nameInput = h('input', {
    type: 'text',
    placeholder: 'npm 包名，如 @scope/dsh-plugin-example',
    style: 'width:320px',
  }) as HTMLInputElement

  const addBtn = h('button', {
    class: 'btn primary',
    onclick: () => void installPlugin(toast),
  }, document.createTextNode('安装'))

  installCard.append(h('div', { class: 'row', style: 'gap:8px' }, nameInput, addBtn))
  const hint = h('p', { class: 'muted' },
    document.createTextNode('通过 dsh plugin --profile web add 安装 npm/npx 插件。需要 pnpm。'))
  installCard.append(hint)

  const listCard = h('div', { class: 'card' })
  const listHeader = h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' })
  listHeader.append(h('h3', {}, document.createTextNode('已安装插件')))
  const refreshBtn = h('button', {
    class: 'btn small',
    onclick: () => void refresh(),
  }, document.createTextNode('刷新'))
  listHeader.append(refreshBtn)
  listCard.append(listHeader)

  list = h('div', { class: 'list' })
  listCard.append(list)

  applyBtn = h('button', {
    class: 'btn primary',
    onclick: () => void applyAndRestart(toast),
  }, document.createTextNode('应用并重启 DSH')) as HTMLButtonElement
  const applyHint = h('p', { class: 'muted' },
    document.createTextNode('启用/禁用状态保存后需重启 DSH 生效。'))

  pane.append(installCard, listCard, h('div', { class: 'row' }, applyBtn, applyHint))
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
  list.innerHTML = ''
  const { plugins, profileDir } = result

  if (plugins.length === 0) {
    list.append(h('p', { class: 'empty' },
      document.createTextNode(`暂无插件。通过上方输入框安装，或运行 dsh plugin --profile web add <包名>。`)))
    return
  }

  const countHint = h('p', { class: 'muted', style: 'margin-bottom:8px' },
    document.createTextNode(`共 ${plugins.length} 个 · 配置目录：${profileDir}`))
  list.append(countHint)

  for (const p of plugins) list.append(renderItem(p))
}

function renderItem(p: PluginView): HTMLElement {
  const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement
  toggle.checked = p.enabled
  toggle.addEventListener('change', async () => {
    try {
      if (toggle.checked) {
        await bridge().enablePlugin(p.id)
      } else {
        await bridge().disablePlugin(p.id)
      }
      toastFn(`插件 ${p.id} 已${toggle.checked ? '启用' : '停用'}，点击“应用并重启 DSH”生效`)
    } catch (err) {
      toggle.checked = !toggle.checked // revert
      toastFn(`操作失败：${String(err)}`, true)
    }
  })

  const metaParts = [
    p.version ? `v${p.version}` : '',
    p.isBundle ? '插件层' : '普通依赖',
    p.source === 'npm' ? 'npm' : p.source,
    p.description ?? '',
  ].filter(Boolean).join(' · ')

  const badges: Node[] = []
  if (p.isBundle) {
    badges.push(h('span', { class: 'badge accent', style: 'margin-left:8px' }, document.createTextNode('插件')))
  }
  if (!p.isBundle && p.enabled) {
    badges.push(h('span', { class: 'badge', style: 'margin-left:8px' }, document.createTextNode('已启用')))
  }
  if (!p.enabled) {
    badges.push(h('span', { class: 'badge muted', style: 'margin-left:8px' }, document.createTextNode('已停用')))
  }

  const removeBtn = h('button', {
    class: 'btn danger small',
    style: 'margin-right:4px',
    onclick: async () => {
      if (!confirm(`确定卸载插件 ${p.id}？此操作将执行 pnpm remove。`)) return
      try {
        await bridge().uninstallPlugin(p.id)
        toastFn(`已卸载 ${p.id}`)
        await refresh()
      } catch (err) {
        toastFn(`卸载失败：${String(err)}`, true)
      }
    },
  }, document.createTextNode('卸载'))

  const exportBtn = h('button', {
    class: 'btn small',
    onclick: async () => {
      try {
        const info = await bridge().exportPlugin(p.id)
        if (info) {
          const text = `${info.packageName}${info.version ? '@' + info.version : ''}`
          await navigator.clipboard.writeText(text)
          toastFn(`已复制到剪贴板：${text}`)
        } else {
          toastFn('未找到插件信息', true)
        }
      } catch (err) {
        toastFn(`导出失败：${String(err)}`, true)
      }
    },
  }, document.createTextNode('导出'))

  return h('div', { class: 'item' },
    h('label', { class: 'switch' }, toggle, h('span', { class: 'track' })),
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' },
        document.createTextNode(p.packageName),
        ...badges,
      ),
      h('div', { class: 'sub mono' }, document.createTextNode(metaParts)),
    ),
    exportBtn,
    removeBtn,
  )
}

async function installPlugin(toast: (msg: string, err?: boolean) => void): Promise<void> {
  const name = nameInput.value.trim()
  if (!name) {
    toast('请输入 npm 包名', true)
    return
  }
  nameInput.disabled = true
  try {
    await bridge().addPlugin(name)
    toast(`已安装插件 ${name}，点击“应用并重启 DSH”生效`)
    nameInput.value = ''
    await refresh()
  } catch (err) {
    toast(`安装失败：${String(err)}`, true)
  } finally {
    nameInput.disabled = false
  }
}

async function applyAndRestart(toast: (msg: string, err?: boolean) => void): Promise<void> {
  applyBtn.disabled = true
  applyBtn.textContent = '正在重启 DSH…'
  try {
    const status = await bridge().applyPlugins()
    toast(status.state === 'running' ? 'DSH 已重启，插件配置已应用' : `DSH 状态：${status.state}`)
  } catch (err) {
    toast(`重启失败：${String(err)}`, true)
  } finally {
    applyBtn.disabled = false
    applyBtn.textContent = '应用并重启 DSH'
  }
}