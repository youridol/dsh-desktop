/**
 * 设置：端口（保存后重启生效）、开机自启、启动时检查更新、GitHub 凭据、
 * 运行目录信息。凭据仅以明文写入运行目录 credentials.json，不入库。
 * 布局与组件统一走 control/ui 组件库。
 */
import { bridge } from '../api'
import { button, card, h, inputEl, kv, row, switchRow, text } from '../ui'

export function initSettings(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  const pane = paneEl
  pane.innerHTML = ''

  const serviceCard = card(
    { title: '服务' },
    row(
      text('DSH Web 端口：'),
      inputEl({ type: 'number', min: 1, max: 65535, width: 90, className: 'port-input' }),
      button({ variant: 'primary', size: 'sm', className: 'save-port-btn', onClick: () => void savePort() }, text('保存并重启 DSH')),
    ),
  )
  const portInput = serviceCard.querySelector<HTMLInputElement>('.port-input')!
  const savePortBtn = serviceCard.querySelector<HTMLButtonElement>('.save-port-btn')!

  const systemCard = card(
    { title: '系统' },
    row(
      switchRow('开机自动启动', false, (on) => {
        void (async () => {
          try {
            const r = await bridge().setSettings({ autoStart: on })
            toast(r.autoStart ? '开机自启：已开启' : '开机自启：已关闭')
            autoStartInput.checked = r.autoStart
          } catch (err) {
            toast(String(err), true)
          }
        })()
      }),
      switchRow('启动时检查版本更新', false, (on) => {
        void bridge().setSettings({ checkUpdatesOnStart: on }).catch((err) => toast(String(err), true))
      }),
    ),
  )
  const autoStartInput = systemCard.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]
  const checkUpdateInput = systemCard.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]

  const credCard = card(
    { title: 'GitHub 凭据' },
    row(
      inputEl({ type: 'text', placeholder: 'GitHub 用户名', width: 140, className: 'cred-user-input' }),
      inputEl({ type: 'password', placeholder: 'Personal Access Token', width: 200, className: 'cred-token-input' }),
      button({ variant: 'primary', size: 'sm', onClick: () => void saveCreds() }, text('保存凭据')),
    ),
    text('用于 GitHub Releases 查询限流提升与私有仓库克隆；以明文保存于运行目录 credentials.json，不会进入仓库。'),
  )
  const userInput = credCard.querySelector<HTMLInputElement>('.cred-user-input')!
  const tokenInput = credCard.querySelector<HTMLInputElement>('.cred-token-input')!

  const aboutCard = card(
    { title: '关于' },
    kv([
      ['应用版本', '—'], [ '运行模式', '—'], ['运行目录', '—'], ['项目主页', '—'],
    ]),
  )
  const aboutBody = aboutCard.querySelector<HTMLElement>('.card-body')!

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
    autoStartInput.checked = state.autoStart
    checkUpdateInput.checked = state.config.checkUpdatesOnStart
    const creds = await bridge().getCredentials()
    userInput.value = creds.githubUser
    tokenInput.value = creds.githubToken
    aboutBody.replaceChildren(
      kv([
        ['应用版本', state.appVersion],
        ['运行模式', state.portable ? '便携版（数据在程序目录）' : '安装版（数据在用户目录）'],
        ['运行目录', state.runtimeDir],
        ['项目主页', h('a', { href: '#', onclick: () => { window.open('https://github.com/youridol/dsh-desktop', '_blank') } }, text('youridol/dsh-desktop'))],
      ]),
    )
  })()
}
