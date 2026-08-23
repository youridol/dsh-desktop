/**
 * 版本管理：检查 GitHub Releases、下载并切换（npm 安装）、回退与删除。
 */
import { bridge, h, type InstalledVersion, type ReleaseInfo, type CommitInfo } from '../api'

let pane: HTMLElement
let installedList: HTMLElement
let releasesList: HTMLElement
let checkBtn: HTMLButtonElement
let progressWrap: HTMLElement
let progressText: HTMLElement

export function initVersions(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  pane.innerHTML = ''

  const installedCard = h('div', { class: 'card' })
  installedCard.append(h('h3', {}, document.createTextNode('本机版本')))
  installedList = h('div', {})
  installedCard.append(installedList)

  const releaseCard = h('div', { class: 'card' })
  // 来源选择器（默认「最新发布版本」）
  releaseCard.append(h('div', { style: 'margin:8px 0' },
    mkRadio('src-release', 'source', 'release', '最新发布版本', true),
    mkRadio('src-commit', 'source', 'commit', '最新提交（源码）', false),
  ))
  checkBtn = h('button', {
    class: 'btn primary',
    onclick: () => void check(toast),
  }, document.createTextNode('检查更新（GitHub Releases）')) as HTMLButtonElement
  releaseCard.append(h('h3', {}, document.createTextNode('可用版本'), checkBtn))
  progressWrap = h('div', { class: 'progress-wrap hidden' })
  progressText = h('div', { class: 'muted mono' })
  progressWrap.append(h('div', { class: 'progress-bar' }, h('div', { class: 'fill' })), progressText)
  releasesList = h('div', {})
  releaseCard.append(progressWrap, releasesList, h('p', { class: 'muted' },
    document.createTextNode('版本源自 deepseek-ai/deepseek-harness 的 GitHub Releases；安装包经 npm registry 下载并解压到运行目录。')))

  pane.append(installedCard, releaseCard)
  void renderInstalled()
  bridge().on('install:progress', (payload) => {
    const p = payload as { version: string; text: string }
    progressText.textContent = `[${p.version}] ${p.text.slice(0, 160)}`
  })
}

async function renderInstalled(): Promise<void> {
  const versions = await bridge().listVersions()
  installedList.innerHTML = ''
  if (versions.length === 0) {
    installedList.append(h('p', { class: 'empty' }, document.createTextNode('未找到可用版本')))
    return
  }
  for (const v of versions) installedList.append(renderInstalledItem(v))
}

function renderInstalledItem(v: InstalledVersion): HTMLElement {
  const badge = v.active
    ? h('span', { class: 'badge ok' }, document.createTextNode('当前使用'))
    : h('span', { class: 'badge' }, document.createTextNode(v.origin === 'bundled' ? '捆绑' : '已下载'))
  const actions: HTMLElement[] = []
  if (!v.active) {
    actions.push(h('button', {
      class: 'btn small',
      onclick: () => void switchTo(v.version, v.origin),
    }, document.createTextNode(v.origin === 'bundled' ? '回退到此版本' : '切换到此版本')))
    if (v.origin === 'downloaded') {
      actions.push(h('button', {
        class: 'btn danger small',
        onclick: () => void removeVersion(v.version),
      }, document.createTextNode('删除')))
    }
  }
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, document.createTextNode(v.version)),
      h('div', { class: 'sub' }, document.createTextNode(v.origin === 'bundled' ? '随应用捆绑' : '下载安装于运行目录')),
    ),
    badge,
    ...actions,
  )
}

async function check(toast: (msg: string, err?: boolean) => void): Promise<void> {
  checkBtn.disabled = true
  checkBtn.textContent = '正在检查…'
  try {
    const source = (document.querySelector('input[name="source"]:checked') as HTMLInputElement | null)?.value ?? 'release'
    const result = await bridge().checkUpdates(source as 'release' | 'commit')
    releasesList.innerHTML = ''
    if (result.rateLimited) {
      releasesList.append(h('div', { style: 'display:flex;align-items:center;gap:10px;margin:8px 0' },
        h('span', { class: 'badge warn' }, document.createTextNode('GitHub 限流（403）')),
        document.createTextNode('请在 设置 → GitHub 凭据 配置 Token 提升速率上限，或稍后重试；本地版本切换不受影响。'),
        h('button', {
          class: 'btn small',
          onclick: () => document.querySelector<HTMLElement>('.tab[data-tab="settings"]')?.click(),
        }, document.createTextNode('前往设置')),
      ))
      return
    }
    if (result.offline) {
      releasesList.append(h('p', { class: 'muted' },
        h('span', { class: 'badge warn' }, document.createTextNode('离线')),
        document.createTextNode(' 无法连接 GitHub，本地版本切换不受影响')))
      return
    }
    if (result.latestCommit) {
      releasesList.append(renderCommit(result.latestCommit))
      return
    }
    if (result.hasUpdate && result.latest) {
      releasesList.append(h('p', { class: 'muted' },
        h('span', { class: 'badge warn' }, document.createTextNode('有新版本')),
        document.createTextNode(` 最新 ${result.latest.version}，当前 ${result.current}`)))
    } else {
      releasesList.append(h('p', { class: 'muted' },
        h('span', { class: 'badge ok' }, document.createTextNode('已是最新')),
        document.createTextNode(` 当前 ${result.current}`)))
    }
    for (const r of result.releases.slice(0, 12)) releasesList.append(renderRelease(r))
  } catch (err) {
    toast(`检查更新失败：${String(err)}（离线或限流时仍可切换本地版本）`, true)
  } finally {
    checkBtn.disabled = false
    checkBtn.textContent = '检查更新（GitHub Releases）'
  }
}

function renderRelease(r: ReleaseInfo): HTMLElement {
  const date = r.publishedAt ? r.publishedAt.slice(0, 10) : ''
  const btn = h('button', {
    class: 'btn small primary',
    onclick: () => void downloadAndSwitch(r),
  }, document.createTextNode('下载并切换'))
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, document.createTextNode(r.version),
        r.prerelease ? h('span', { class: 'badge warn', style: 'margin-left:8px' }, document.createTextNode('预发布')) : null,
      ),
      h('div', { class: 'sub' }, document.createTextNode(`${r.tag} · ${date}`)),
    ),
    btn,
  )
}

async function downloadAndSwitch(r: ReleaseInfo): Promise<void> {
  progressWrap.classList.remove('hidden')
  progressText.textContent = `[${r.version}] 开始下载安装…`
  try {
    await bridge().downloadVersion(r.version)
    await renderInstalled()
    progressText.textContent = `[${r.version}] 安装完成并已切换`
  } catch (err) {
    progressText.textContent = `[${r.version}] 失败: ${String(err).slice(0, 200)}`
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 4000)
  }
}

async function switchTo(version: string, origin: string): Promise<void> {
  try {
    await bridge().switchVersion(origin === 'bundled' ? 'bundled' : version)
    await renderInstalled()
  } catch (err) {
    alert(`切换失败：${String(err)}`)
  }
}

async function removeVersion(version: string): Promise<void> {
  if (!confirm(`确定删除版本 ${version}？`)) return
  try {
    await bridge().deleteVersion(version)
    await renderInstalled()
  } catch (err) {
    alert(String(err))
  }
}

function mkRadio(id: string, name: string, value: string, label: string, checked: boolean): HTMLElement {
  const input = document.createElement('input')
  input.type = 'radio'
  input.id = id
  input.name = name
  input.value = value
  input.checked = checked
  return h('label', { style: 'margin-right:16px;cursor:pointer' }, input, document.createTextNode(` ${label}`))
}

function renderCommit(c: CommitInfo): HTMLElement {
  const btn = h('button', {
    class: 'btn small primary',
    onclick: () => void downloadCommit(c),
  }, document.createTextNode('下载源码并安装'))
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, document.createTextNode(c.shortSha)),
      h('div', { class: 'sub' }, document.createTextNode(`${c.message} · ${c.date.slice(0, 10)}`)),
    ),
    btn,
  )
}

async function downloadCommit(c: CommitInfo): Promise<void> {
  progressWrap.classList.remove('hidden')
  progressText.textContent = `[${c.shortSha}] 开始下载源码并安装…`
  try {
    await bridge().installCommit(c.sha)
    await renderInstalled()
    progressText.textContent = `[src-${c.shortSha}] 安装完成并已切换`
  } catch (err) {
    progressText.textContent = `[src-${c.shortSha}] 失败: ${String(err).slice(0, 200)}`
  } finally {
    setTimeout(() => progressWrap.classList.add('hidden'), 4000)
  }
}
