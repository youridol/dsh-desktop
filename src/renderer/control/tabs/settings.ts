/**
 * 设置：端口（保存后重启生效）、开机自启、启动时检查更新、GitHub 凭据、
 * 运行目录信息。凭据仅以明文写入运行目录 credentials.json，不入库。
 */
import { bridge, h } from '../api'

export function initSettings(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  const pane = paneEl
  pane.innerHTML = ''

  const serviceCard = h('div', { class: 'card' })
  const portInput = h('input', { type: 'number', min: '1', max: '65535', style: 'width:110px' }) as HTMLInputElement
  const savePortBtn = h('button', {
    class: 'btn primary',
    onclick: () => void savePort(),
  }, document.createTextNode('保存并重启 DSH'))
  serviceCard.append(h('h3', {}, document.createTextNode('服务')))
  serviceCard.append(h('div', { class: 'row' },
    h('label', {}, document.createTextNode('DSH Web 端口')), portInput, savePortBtn))

  const systemCard = h('div', { class: 'card' })
  const autoStartSwitch = mkSwitch(false, async (on) => {
    const r = await bridge().setSettings({ autoStart: on })
    toast(r.autoStart ? '开机自启：已开启' : '开机自启：已关闭')
    autoStartSwitch.input.checked = r.autoStart
  })
  const checkUpdateSwitch = mkSwitch(false, async (on) => {
    await bridge().setSettings({ checkUpdatesOnStart: on })
  })
  systemCard.append(h('h3', {}, document.createTextNode('系统')))
  systemCard.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
    autoStartSwitch.root, document.createTextNode('开机自动启动')))
  systemCard.append(h('div', { class: 'row' },
    checkUpdateSwitch.root, document.createTextNode('启动时检查版本更新')))

  const credCard = h('div', { class: 'card' })
  const userInput = h('input', { type: 'text', placeholder: 'GitHub 用户名', style: 'width:170px' }) as HTMLInputElement
  const tokenInput = h('input', { type: 'password', placeholder: 'Personal Access Token', style: 'width:230px' }) as HTMLInputElement
  const saveCredBtn = h('button', {
    class: 'btn primary',
    onclick: () => void saveCreds(),
  }, document.createTextNode('保存凭据'))
  credCard.append(h('h3', {}, document.createTextNode('GitHub 凭据')))
  credCard.append(h('div', { class: 'row' }, userInput, tokenInput, saveCredBtn))
  credCard.append(h('p', { class: 'muted', style: 'margin:10px 0 0' },
    document.createTextNode('用于 GitHub Releases 查询限流提升与私有插件仓库克隆；以明文保存于运行目录 credentials.json，不会进入仓库。')))

  const aboutCard = h('div', { class: 'card' })
  aboutCard.append(h('h3', {}, document.createTextNode('关于')))
  const aboutBody = h('div', { class: 'kv' })
  aboutCard.append(aboutBody)

  pane.append(serviceCard, systemCard, credCard, aboutCard)

  async function savePort(): Promise<void> {
    const port = Number(portInput.value)
    try {
      const r = await bridge().setSettings({ port })
      portInput.value = String(r.config.port)
      if (r.needsRestart) {
        savePortBtn.textContent = '正在重启…'
        await bridge().applyRestart()
        savePortBtn.textContent = '保存并重启 DSH'
        toast(`端口已切换为 ${r.config.port} 并重启 DSH`)
      } else {
        toast('端口未变化')
      }
    } catch (err) {
      toast(String(err), true)
    }
  }

  async function saveCreds(): Promise<void> {
    try {
      await bridge().saveCredentials(userInput.value, tokenInput.value)
      tokenInput.value = '********'
      toast('凭据已保存到运行目录 credentials.json')
    } catch (err) {
      toast(String(err), true)
    }
  }

  void (async () => {
    const state = await bridge().getState()
    portInput.value = String(state.config.port)
    autoStartSwitch.input.checked = state.autoStart
    checkUpdateSwitch.input.checked = state.config.checkUpdatesOnStart
    const creds = await bridge().getCredentials()
    userInput.value = creds.githubUser
    tokenInput.value = creds.githubToken
    aboutBody.innerHTML = ''
    aboutBody.append(
      h('div', { class: 'k' }, document.createTextNode('应用版本')),
      h('div', { class: 'mono' }, document.createTextNode(state.appVersion)),
      h('div', { class: 'k' }, document.createTextNode('运行模式')),
      h('div', { class: 'mono' }, document.createTextNode(state.portable ? '便携版（数据在程序目录）' : '安装版（数据在用户目录）')),
      h('div', { class: 'k' }, document.createTextNode('运行目录')),
      h('div', { class: 'mono', title: state.runtimeDir }, document.createTextNode(state.runtimeDir)),
      h('div', { class: 'k' }, document.createTextNode('项目主页')),
      h('div', { class: 'mono' }, h('a', { href: '#', onclick: () => { window.open('https://github.com/youridol/dsh-desktop', '_blank') } }, document.createTextNode('youridol/dsh-desktop'))),
    )
  })()
}

function mkSwitch(
  initial: boolean,
  onchange: (on: boolean) => void | Promise<void>,
): { root: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = initial
  input.addEventListener('change', () => void onchange(input.checked))
  const root = h('label', { class: 'switch' }, input, h('span', { class: 'track' }))
  return { root, input }
}
