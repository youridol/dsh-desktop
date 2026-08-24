/**
 * 插件管理：本地/Git 安装、启停、卸载、应用并重启 DSH。
 */
import { bridge, h, type PluginView } from '../api'

let pane: HTMLElement
let gitInput: HTMLInputElement
let applyBtn: HTMLButtonElement
let list: HTMLElement
let toastFn: (msg: string, err?: boolean) => void = () => {}

export function initPlugins(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  toastFn = toast
  pane.innerHTML = ''

  const installCard = h('div', { class: 'card' })
  installCard.append(h('h3', {}, document.createTextNode('安装插件')))
  const localBtn = h('button', {
    class: 'btn primary',
    onclick: () => void installLocal(toast),
  }, document.createTextNode('从本地目录安装…'))
  gitInput = h('input', { type: 'text', placeholder: 'https://github.com/user/dsh-plugin', style: 'width:280px' }) as HTMLInputElement
  const gitBtn = h('button', {
    class: 'btn',
    onclick: () => void installGit(toast),
  }, document.createTextNode('从 Git 仓库克隆'))
  installCard.append(h('div', { class: 'row' }, localBtn))
  installCard.append(h('div', { class: 'row', style: 'margin-top:10px' }, gitInput, gitBtn))

  const listCard = h('div', { class: 'card' })
  listCard.append(h('h3', {}, document.createTextNode('已安装插件')))
  list = h('div', { class: 'list' })
  listCard.append(list)

  applyBtn = h('button', {
    class: 'btn primary',
    onclick: () => void applyAndRestart(toast),
  }, document.createTextNode('应用并重启 DSH')) as HTMLButtonElement
  const hint = h('p', { class: 'muted' },
    document.createTextNode('启用状态保存后需重启 DSH 生效；插件路径以绝对路径写入 cordis.patch.yml。'))

  pane.append(installCard, listCard, h('div', { class: 'row' }, applyBtn, hint))
  void refresh()
}

async function refresh(): Promise<void> {
  const plugins = await bridge().listPlugins()
  list.innerHTML = ''
  if (plugins.length === 0) {
    list.append(h('p', { class: 'empty' }, document.createTextNode('暂无插件。安装后会出现在这里。')))
    return
  }
  for (const p of plugins) list.append(renderItem(p, toastFn))
}

function renderItem(p: PluginView, toast: (msg: string, err?: boolean) => void): HTMLElement {
  const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement
  toggle.checked = p.enabled && !p.missing
  toggle.disabled = p.missing
  toggle.addEventListener('change', async () => {
    await bridge().setPluginEnabled(p.id, toggle.checked)
    toast(`插件 ${p.id} 已${toggle.checked ? '启用' : '停用'}，点击“应用并重启 DSH”生效`)
  })

  const sub = [
    p.missing ? '⚠ 入口缺失' : p.entry,
    p.source === 'git' ? 'git' : p.source === 'preset' ? '内置' : '本地',
    p.description ?? '',
  ].filter(Boolean).join(' · ')

  const depsErr = p.depsError
    ? h('div', {
        class: 'sub',
        title: p.depsError,
        style: 'color:var(--danger)',
      }, document.createTextNode(`依赖安装失败：${p.depsError}`))
    : null

  const remove = h('button', {
    class: 'btn danger small',
    onclick: async () => {
      if (!confirm(`确定卸载插件 ${p.id}？`)) return
      await bridge().removePlugin(p.id)
      toast(`已卸载 ${p.id}`)
      await refresh()
    },
  }, document.createTextNode('卸载'))

  return h('div', { class: 'item' },
    h('label', { class: 'switch' }, toggle, h('span', { class: 'track' })),
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, document.createTextNode(p.id),
        p.missing ? h('span', { class: 'badge err', style: 'margin-left:8px' }, document.createTextNode('缺失')) : null,
        p.source === 'git' ? h('span', { class: 'badge accent', style: 'margin-left:8px' }, document.createTextNode('git')) : null,
        p.source === 'preset' ? h('span', { class: 'badge accent', style: 'margin-left:8px' }, document.createTextNode('内置')) : null,
      ),
      h('div', { class: 'sub mono', title: p.entry }, document.createTextNode(sub)),
      depsErr,
    ),
    remove,
  )
}

async function installLocal(toast: (msg: string, err?: boolean) => void): Promise<void> {
  try {
    const p = await bridge().addLocalPlugin()
    if (p) {
      toast(`已安装插件 ${p.id}，点击“应用并重启 DSH”生效`)
      await refresh()
    }
  } catch (err) {
    toast(`安装失败：${String(err)}`, true)
  }
}

async function installGit(toast: (msg: string, err?: boolean) => void): Promise<void> {
  const url = gitInput.value.trim()
  if (!url) return toast('请输入仓库地址', true)
  gitInput.disabled = true
  try {
    const installed = await bridge().addGitPlugin(url)
    const names = installed.map((p) => p.id).join('、')
    toast(`已克隆 ${installed.length} 个插件：${names}，点击“应用并重启 DSH”生效`)
    gitInput.value = ''
    await refresh()
  } catch (err) {
    toast(`克隆失败：${String(err)}`, true)
  } finally {
    gitInput.disabled = false
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
