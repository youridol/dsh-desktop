/**
 * 版本管理：检查 GitHub Releases、下载并切换（npm 安装）、回退与删除。
 * 进度条由真实检测状态驱动（idle → checking → success/error）：
 * 只有 checking 状态显示 indeterminate loading；success/error 后动画立即停止。
 * 布局与组件统一走 control/ui 组件库。
 */
import { bridge, type InstalledVersion, type ReleaseInfo, type CommitInfo } from '../api'
import {
  badge, button, card, confirmDialog, alertDialog, emptyState, h, listContainer, listHint, listItem,
  progressControl, row, segmented, text,
} from '../ui'
import {
  beginVersionCheck,
  beginInstall,
  succeedVersionCheck,
  failVersionCheck,
  resetVersionCheck,
  shouldAnimate,
  type VersionCheckUiState,
} from '../version-check-state'

let pane: HTMLElement
let installedList: HTMLElement
let releasesList: HTMLElement
let checkBtn: HTMLButtonElement
let progressWrap: HTMLElement
let progressText: HTMLElement
let hideTimer: number | null = null
let source: 'release' | 'commit' = 'release'

export function initVersions(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  pane.innerHTML = ''

  const installedCard = card(
    { title: '本机版本' },
    listContainer('installedList'),
  )
  installedList = installedCard.querySelector<HTMLElement>('#installedList')!

  const releaseCard = card(
    { title: '可用版本', actions: [
      checkBtn = button({ variant: 'primary', size: 'sm', onClick: () => void check(toast) }, text('检查更新（GitHub Releases）')),
    ] },
    row(
      text('来源：'),
      segmented<'release' | 'commit'>(
        [{ value: 'release', label: '最新发布版本' }, { value: 'commit', label: '最新提交（源码）' }],
        source,
        (v) => { source = v },
      ),
    ),
    h('div', { id: 'progressSlot' }),
    listContainer('releasesList'),
    listHint('版本源自 deepseek-ai/deepseek-harness 的 GitHub Releases；安装包经 npm registry 下载并解压到运行目录。'),
  )
  releasesList = releaseCard.querySelector<HTMLElement>('#releasesList')!
  checkBtn = releaseCard.querySelector<HTMLButtonElement>('button.btn')!
  const progressSlot = releaseCard.querySelector<HTMLElement>('#progressSlot')!
  const control = progressControl()
  progressWrap = control.root
  progressText = control.textEl
  progressSlot.append(progressWrap)

  pane.append(installedCard, releaseCard)
  setCheckState(resetVersionCheck())
  void renderInstalled()
  bridge().on('install:progress', (payload) => {
    const p = payload as { version: string; text: string }
    progressText.textContent = `[${p.version}] ${p.text.slice(0, 160)}`
  })
}

/** 进度条由真实状态驱动：idle 隐藏，checking 显示 loading，success/error 停止动画并保留文案。 */
function setCheckState(next: VersionCheckUiState): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
  progressText.textContent = next.message
  progressWrap.classList.toggle('hidden', next.status === 'idle')
  progressWrap.classList.toggle('loading', shouldAnimate(next.status))
}

async function renderInstalled(): Promise<void> {
  const versions = await bridge().listVersions()
  installedList.replaceChildren()
  if (versions.length === 0) {
    installedList.append(emptyState('未找到可用版本'))
    return
  }
  for (const v of versions) installedList.append(renderInstalledItem(v))
}

function renderInstalledItem(v: InstalledVersion): HTMLElement {
  const b = v.active
    ? badge('当前使用', 'ok')
    : badge(v.origin === 'bundled' ? '捆绑' : '已下载')
  const actions: HTMLElement[] = []
  if (!v.active) {
    actions.push(button({ size: 'sm', onClick: () => void switchTo(v.version, v.origin) }, text(v.origin === 'bundled' ? '回退到此版本' : '切换到此版本')))
    if (v.origin === 'downloaded') {
      actions.push(button({ size: 'sm', variant: 'danger', onClick: () => void removeVersion(v.version) }, text('删除')))
    }
  }
  return listItem(
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, text(v.version)),
      h('div', { class: 'sub' }, text(v.origin === 'bundled' ? '随应用捆绑' : '下载安装于运行目录')),
    ),
    b,
    ...actions,
  )
}

async function check(toast: (msg: string, err?: boolean) => void): Promise<void> {
  checkBtn.disabled = true
  checkBtn.textContent = '正在检查…'
  setCheckState(beginVersionCheck(source))
  try {
    const result = await bridge().checkUpdates(source)
    releasesList.replaceChildren()
    if (result.rateLimited) {
      setCheckState(failVersionCheck('GitHub 限流（403），检查未完成'))
      releasesList.append(row(
        badge('GitHub 限流（403）', 'warn'),
        text(' 请在 设置 → GitHub 凭据 配置 Token 提升速率上限，或稍后重试；本地版本切换不受影响。'),
        button({ size: 'sm', onClick: () => document.querySelector<HTMLElement>('.tab[data-tab="settings"]')?.click() }, text('前往设置')),
      ))
      return
    }
    if (result.offline) {
      setCheckState(failVersionCheck('无法连接 GitHub（离线）'))
      releasesList.append(row(
        badge('离线', 'warn'),
        text(' 无法连接 GitHub，本地版本切换不受影响'),
      ))
      return
    }
    if (result.latestCommit) {
      setCheckState(succeedVersionCheck(`检查完成：最新提交 ${result.latestCommit.shortSha}`))
      releasesList.append(renderCommit(result.latestCommit))
      return
    }
    if (result.hasUpdate && result.latest) {
      setCheckState(succeedVersionCheck(`检查完成：发现新版本 ${result.latest.version}（当前 ${result.current}）`))
      releasesList.append(row(
        badge('有新版本', 'warn'),
        text(` 最新 ${result.latest.version}，当前 ${result.current}`),
      ))
    } else {
      setCheckState(succeedVersionCheck(`检查完成：已是最新（当前 ${result.current}）`))
      releasesList.append(row(
        badge('已是最新', 'ok'),
        text(` 当前 ${result.current}`),
      ))
    }
    for (const r of result.releases.slice(0, 12)) releasesList.append(renderRelease(r))
  } catch (err) {
    setCheckState(failVersionCheck(`检查失败：${String(err)}`))
    toast(`检查更新失败：${String(err)}（离线或限流时仍可切换本地版本）`, true)
  } finally {
    checkBtn.disabled = false
    checkBtn.textContent = '检查更新（GitHub Releases）'
  }
}

function renderRelease(r: ReleaseInfo): HTMLElement {
  const date = r.publishedAt ? r.publishedAt.slice(0, 10) : ''
  const btn = button({ size: 'sm', variant: 'primary', onClick: () => void downloadAndSwitch(r) }, text('下载并切换'))
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, text(r.version), r.prerelease ? badge('预发布', 'warn') : null),
      h('div', { class: 'sub' }, text(`${r.tag} · ${date}`)),
    ),
    btn,
  )
}

async function downloadAndSwitch(r: ReleaseInfo): Promise<void> {
  setCheckState(beginInstall(`[${r.version}] 开始下载安装…`))
  try {
    await bridge().downloadVersion(r.version)
    await renderInstalled()
    setCheckState(succeedVersionCheck(`[${r.version}] 安装完成并已切换`))
  } catch (err) {
    setCheckState(failVersionCheck(`[${r.version}] 失败: ${String(err).slice(0, 200)}`))
  } finally {
    hideTimer = window.setTimeout(() => progressWrap.classList.add('hidden'), 4000)
  }
}

async function switchTo(version: string, origin: string): Promise<void> {
  try {
    await bridge().switchVersion(origin === 'bundled' ? 'bundled' : version)
    await renderInstalled()
  } catch (err) {
    await alertDialog({ title: '切换失败', message: String(err) })
  }
}

async function removeVersion(version: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除版本',
    message: `确定删除版本 ${version}？`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await bridge().deleteVersion(version)
    await renderInstalled()
  } catch (err) {
    await alertDialog({ title: '删除失败', message: String(err) })
  }
}

function renderCommit(c: CommitInfo): HTMLElement {
  const btn = button({ size: 'sm', variant: 'primary', onClick: () => void downloadCommit(c) }, text('下载源码并安装'))
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name mono' }, text(c.shortSha)),
      h('div', { class: 'sub' }, text(`${c.message} · ${c.date.slice(0, 10)}`)),
    ),
    btn,
  )
}

async function downloadCommit(c: CommitInfo): Promise<void> {
  setCheckState(beginInstall(`[${c.shortSha}] 开始下载源码并安装…`))
  try {
    await bridge().installCommit(c.sha)
    await renderInstalled()
    setCheckState(succeedVersionCheck(`[src-${c.shortSha}] 安装完成并已切换`))
  } catch (err) {
    setCheckState(failVersionCheck(`[src-${c.shortSha}] 失败: ${String(err).slice(0, 200)}`))
  } finally {
    hideTimer = window.setTimeout(() => progressWrap.classList.add('hidden'), 4000)
  }
}
