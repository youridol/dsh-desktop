/**
 * Skills 管理：仓库管理、作用域（全局/项目）安装生命周期、批量操作、
 * GitHub 搜索、更新检测与备份/导入/导出。
 *
 * UI 保持无框架：所有操作经 preload 桥接（window.dshc）转发到主进程
 * SkillsService；不读写 deepseek-harness 源码。
 */
import {
  bridge,
  h,
  type SkillRepositoryView,
  type SkillScope,
  type SkillsState,
  type SkillBackupView,
  type InstalledSkill,
} from '../api'

let pane: HTMLElement
let toastFn: (msg: string, err?: boolean) => void = () => {}
let currentScope: SkillScope = 'global'
let state: SkillsState | null = null
let repos: SkillRepositoryView[] = []
let installed: InstalledSkill[] = []
let updatesByKey = new Map<string, string>()
let selected = new Set<string>()
let searchResults: SearchResultView[] = []
let backupCache: SkillBackupView[] = []

interface DiscoveredSkillView {
  id: string
  name: string
  description: string | null
  path: string
  skillFile: string
  files: string[]
}
interface SearchResultView {
  fullName: string
  name: string
  description: string | null
  stars: number
  url: string
}

export function initSkills(paneEl: HTMLElement, toast: (msg: string, err?: boolean) => void): void {
  pane = paneEl
  toastFn = toast
  pane.innerHTML = ''
  renderShell()
  void refreshAll()
}

// ---- helpers ----

function text(str: string): Text {
  return document.createTextNode(str)
}

function row(...children: Array<Node | null | undefined>): HTMLElement {
  return h('div', { class: 'row' }, ...children)
}

function badge(t: string, cls = ''): HTMLElement {
  return h('span', { class: `badge ${cls}`.trim() }, text(t))
}

function fmtTs(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function shortCommit(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

function scopeLabel(): string {
  return currentScope === 'global' ? '全局' : '项目'
}

// ---- shell ----

function renderShell(): void {
  pane.innerHTML = ''

  const overview = h('div', { class: 'card' })
  const overviewHead = h('div', { class: 'dash-widget-head' })
  overviewHead.append(h('h3', {}, text('Skills 概览')))
  overviewHead.append(h('button', { class: 'btn primary small', onclick: () => void syncAll() }, text('同步全部')))
  overview.append(overviewHead)
  const kv = h('div', { class: 'kv' })
  kv.append(
    h('div', { class: 'k' }, text('仓库目录')), h('div', { class: 'mono' }, text(state?.reposDir ?? '…')),
    h('div', { class: 'k' }, text('全局 Skills')), h('div', { class: 'mono' }, text(state?.globalDir ?? '…')),
    h('div', { class: 'k' }, text('项目 Skills')), h('div', { class: 'mono' }, text(state?.projectDir ?? '…')),
    h('div', { class: 'k' }, text('备份目录')), h('div', { class: 'mono' }, text(state?.backupsDir ?? '…')),
  )
  overview.append(kv)
  overview.append(row(
    h('span', { class: 'muted' }, text('作用域：')),
    scopeButton('global'),
    scopeButton('project'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small', onclick: () => void checkUpdates() }, text('检测更新')),
    h('button', { class: 'btn small', onclick: () => void updateAllAvailable() }, text('更新全部')),
  ))
  pane.append(overview)

  const repoCard = h('div', { class: 'card' })
  repoCard.append(h('h3', {}, text('Skills 仓库')))
  const urlInput = h('input', {
    type: 'text',
    placeholder: state?.defaultRepository ?? 'https://github.com/mattpocock/skills',
    style: 'width:300px',
  }) as HTMLInputElement
  const nameInput = h('input', { type: 'text', placeholder: '仓库名称（可选）', style: 'width:140px' }) as HTMLInputElement
  const addBtn = h('button', {
    class: 'btn primary',
    onclick: () => void addRepo(urlInput, nameInput, addBtn),
  }, text('添加并拉取')) as HTMLButtonElement
  repoCard.append(
    row(h('span', { class: 'muted' }, text('仓库地址：')), urlInput, nameInput, addBtn),
    h('p', { class: 'muted' }, text('支持任意公开 http(s) Skills 仓库；私有仓库请在“设置”页配置 GitHub 凭据。')),
  )
  const repoList = h('div', { id: 'repoList', class: 'list' })
  repoCard.append(repoList)
  pane.append(repoCard)

  const availCard = h('div', { class: 'card' })
  const availHead = h('div', { class: 'dash-widget-head' })
  availHead.append(h('h3', {}, text('仓库内 Skills')))
  availHead.append(h('span', { class: 'muted' }, text('展开仓库查看可安装技能')))
  availCard.append(availHead)
  const availList = h('div', { id: 'availList', class: 'list' })
  availCard.append(availList)
  pane.append(availCard)

  const instCard = h('div', { class: 'card' })
  instCard.append(h('h3', {}, text('已安装 Skills（全局 / 项目隔离）')))
  const selectAll = h('input', { type: 'checkbox', id: 'selectAll' }) as HTMLInputElement
  selectAll.addEventListener('change', () => {
    selected = selectAll.checked ? new Set(filteredInstalled().map((s) => s.key)) : new Set()
    renderInstalledList()
  })
  instCard.append(row(
    h('label', { style: 'display:inline-flex;align-items:center;gap:6px' }, selectAll, text('全选')),
    h('button', { class: 'btn small', onclick: () => void batchAction('enable') }, text('批量启用')),
    h('button', { class: 'btn small', onclick: () => void batchAction('disable') }, text('批量停用')),
    h('button', { class: 'btn small', onclick: () => void batchAction('uninstall') }, text('批量卸载')),
    h('button', { class: 'btn small danger', onclick: () => void batchAction('delete') }, text('批量删除')),
  ))
  const instList = h('div', { id: 'instList', class: 'list' })
  instCard.append(instList)
  pane.append(instCard)

  const searchCard = h('div', { class: 'card' })
  searchCard.append(h('h3', {}, text('GitHub Skills 搜索')))
  const queryInput = h('input', { type: 'text', placeholder: '关键词，如 skills / claude skill / dsh-skill', style: 'width:260px' }) as HTMLInputElement
  const searchBtn = h('button', { class: 'btn primary', onclick: () => void doSearch(queryInput, searchBtn) }, text('搜索')) as HTMLButtonElement
  searchCard.append(row(queryInput, searchBtn))
  const searchList = h('div', { id: 'searchList', class: 'list' })
  searchCard.append(searchList)
  pane.append(searchCard)

  const backupCard = h('div', { class: 'card' })
  backupCard.append(h('h3', {}, text('备份与迁移')))
  backupCard.append(
    row(
      h('button', { class: 'btn small', onclick: () => void doExport(false) }, text('导出配置')),
      h('button', { class: 'btn small', onclick: () => void doExport(true) }, text('导出（含技能内容）')),
      h('button', { class: 'btn small', onclick: () => void doImport() }, text('导入')),
      h('button', { class: 'btn primary small', onclick: () => void doCreateBackup() }, text('创建备份')),
      h('button', { class: 'btn small', onclick: () => void doRefreshBackups() }, text('刷新备份')),
    ),
    h('p', { class: 'muted' }, text('备份自动保存到备份目录，包含仓库注册表、已安装清单与技能文件内容。')),
  )
  const backupList = h('div', { id: 'backupList', class: 'list' })
  backupCard.append(backupList)
  pane.append(backupCard)
}

function scopeButton(scope: SkillScope): HTMLElement {
  return h('button', {
    class: 'btn small',
    'data-scope': scope,
    onclick: () => {
      currentScope = scope
      selected.clear()
      renderScopeButtons()
      renderInstalledList()
    },
  }, text(scope === 'global' ? '全局 Skills' : '项目 Skills'))
}

function renderScopeButtons(): void {
  pane.querySelectorAll('[data-scope]').forEach((el) => {
    const btn = el as HTMLButtonElement
    btn.classList.toggle('active', btn.dataset.scope === currentScope)
  })
}

// ---- refresh / data ----

async function refreshAll(): Promise<void> {
  const [s, r, i, b] = await Promise.all([
    bridge().getSkillsState(),
    bridge().listSkillRepos(),
    bridge().listInstalledSkills(),
    bridge().listSkillBackups(),
  ])
  state = s
  repos = r
  installed = i
  backupCache = b
  renderScopeButtons()
  renderRepoList()
  renderInstalledList()
  renderBackupList()
  renderSearchList()
}

function filteredInstalled(): InstalledSkill[] {
  return installed.filter((s) => s.scope === currentScope)
}

// ---- repositories ----

async function addRepo(urlInput: HTMLInputElement, nameInput: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  const url = urlInput.value.trim()
  if (!url) {
    toastFn('请输入仓库地址', true)
    return
  }
  btn.disabled = true
  btn.textContent = '正在拉取…'
  try {
    const { repo, existed } = await bridge().addSkillRepo({ url, name: nameInput.value.trim() || undefined })
    toastFn(existed ? `仓库已存在：${repo.name}` : `仓库 ${repo.name} 已添加并同步（发现 ${repo.skillsCount ?? '?'} 个 Skills）`)
    urlInput.value = ''
    nameInput.value = ''
    await refreshAll()
    if (!existed) toggleExpandRepo(repo.id)
  } catch (err) {
    toastFn(`添加仓库失败：${String(err)}`, true)
    await refreshAll()
  } finally {
    btn.disabled = false
    btn.textContent = '添加并拉取'
  }
}

async function syncRepo(id: string): Promise<void> {
  try {
    await bridge().syncSkillRepo(id)
    toastFn('仓库已同步')
  } catch (err) {
    toastFn(`同步失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function syncAll(): Promise<void> {
  try {
    const result = await bridge().syncAllSkillRepos()
    toastFn(result.failed.length ? `同步完成：成功 ${result.synced}，失败 ${result.failed.length}` : `同步完成：${result.synced} 个仓库`)
  } catch (err) {
    toastFn(`同步失败：${String(err)}`, true)
  }
  await refreshAll()
}

function renderRepoList(): void {
  const el = pane.querySelector('#repoList')
  if (!el) return
  el.innerHTML = ''
  if (repos.length === 0) {
    el.append(h('p', { class: 'empty' }, text('暂无仓库。添加默认示例：https://github.com/mattpocock/skills')))
    return
  }
  for (const repo of repos) el.append(renderRepoItem(repo))
}

function renderRepoItem(repo: SkillRepositoryView): HTMLElement {
  const enabledSwitch = h('input', { type: 'checkbox' }) as HTMLInputElement
  enabledSwitch.checked = repo.enabled
  enabledSwitch.addEventListener('change', async () => {
    try {
      await bridge().setSkillRepoEnabled(repo.id, enabledSwitch.checked)
      await refreshAll()
    } catch (err) {
      enabledSwitch.checked = !enabledSwitch.checked
      toastFn(`切换失败：${String(err)}`, true)
    }
  })
  const badgesArr: Node[] = []
  if (repo.enabled) badgesArr.push(badge('已启用', 'ok'))
  if (repo.lastSyncError) badgesArr.push(badge('同步失败', 'err'))
  else if (repo.lastSyncAt) badgesArr.push(badge(`已同步 ${fmtTs(repo.lastSyncAt)}`, ''))
  badgesArr.push(badge(`分支 ${repo.branch ?? '—'}`, ''))
  badgesArr.push(badge(`commit ${shortCommit(repo.lastCommit)}`, ''))
  badgesArr.push(badge(`${repo.skillsCount ?? '?'} 个技能`, 'accent'))

  return h('div', { class: 'item', 'data-repo-id': repo.id },
    h('label', { class: 'switch' }, enabledSwitch, h('span', { class: 'track' })),
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(repo.name), ...badgesArr),
      h('div', { class: 'sub mono' }, text(`${repo.url}${repo.lastSyncError ? ' · ' + repo.lastSyncError : ''}`)),
    ),
    h('button', { class: 'btn small', onclick: () => void syncRepo(repo.id) }, text('同步')),
    h('button', { class: 'btn small', onclick: () => toggleExpandRepo(repo.id) }, text('查看 Skills')),
    h('button', { class: 'btn small', onclick: () => toggleEditRepo(repo.id) }, text('编辑')),
    h('button', {
      class: 'btn small danger',
      onclick: () => void deleteRepo(repo),
    }, text('删除')),
  )
}

async function deleteRepo(repo: SkillRepositoryView): Promise<void> {
  if (!confirm(`确定删除仓库 ${repo.name}（${repo.url}）？已安装的 Skill 副本不受影响。`)) return
  try {
    await bridge().removeSkillRepo(repo.id)
    toastFn(`已删除仓库 ${repo.name}`)
  } catch (err) {
    toastFn(`删除失败：${String(err)}`, true)
  }
  await refreshAll()
}

function repoItemEl(repoId: string): HTMLElement | null {
  return pane.querySelector(`#repoList .item[data-repo-id="${repoId}"]`) as HTMLElement | null
}

function toggleExpandRepo(repoId: string): void {
  const item = repoItemEl(repoId)
  if (!item) return
  const existing = item.querySelector('.repo-detail')
  if (existing) {
    existing.remove()
    return
  }
  const detail = h('div', { class: 'repo-detail', style: 'width:100%' })
  item.append(detail)
  void loadAvailable(repoId, detail)
}

async function loadAvailable(repoId: string, container: HTMLElement): Promise<void> {
  container.innerHTML = ''
  container.append(h('p', { class: 'muted' }, text('正在扫描仓库…')))
  try {
    const result = await bridge().listAvailableSkills(repoId)
    renderAvailable(result, container)
  } catch (err) {
    container.innerHTML = ''
    container.append(h('p', { class: 'empty' }, text(`无法读取：${String(err)}`)))
  }
}

function renderAvailable(result: { repo: SkillRepositoryView; skills: DiscoveredSkillView[] }, container: HTMLElement): void {
  container.innerHTML = ''
  container.append(row(
    h('button', {
      class: 'btn primary small',
      onclick: () => void installAllAvailable(result.repo),
    }, text(`全部安装到${scopeLabel()}`)),
    h('span', { class: 'muted' }, text(`共 ${result.skills.length} 个技能`)),
  ))
  if (result.skills.length === 0) {
    container.append(h('p', { class: 'empty' }, text('仓库中未发现 SKILL.md 技能')))
    return
  }
  for (const s of result.skills) container.append(renderAvailableItem(result.repo, s))
}

function renderAvailableItem(repo: SkillRepositoryView, skill: DiscoveredSkillView): HTMLElement {
  const key = `${repo.id}:${skill.path}`
  const already = installed.some((x) => x.key === key)
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(skill.name), already ? badge('已安装', 'ok') : badge('未安装', '')),
      h('div', { class: 'sub mono' }, text(`${skill.path} · ${skill.description ?? ''}`)),
    ),
    h('button', {
      class: 'btn small primary',
      disabled: already,
      onclick: () => void installSkill(repo.id, skill.path),
    }, text(already ? '已安装' : '安装')),
  )
}

async function installSkill(repoId: string, path: string): Promise<void> {
  try {
    await bridge().installSkill({ repoId, path, scope: currentScope })
    toastFn(`已安装到${scopeLabel()}：${path}`)
  } catch (err) {
    toastFn(`安装失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function installAllAvailable(repo: SkillRepositoryView): Promise<void> {
  try {
    const result = await bridge().installAllFromRepo({ repoId: repo.id, scope: currentScope })
    toastFn(result.failed.length ? `已安装 ${result.installed.length} 个，失败 ${result.failed.length} 个` : `已全部安装 ${result.installed.length} 个到${scopeLabel()}`)
  } catch (err) {
    toastFn(`批量安装失败：${String(err)}`, true)
  }
  await refreshAll()
}

function toggleEditRepo(repoId: string): void {
  const item = repoItemEl(repoId)
  if (!item) return
  const existing = item.querySelector('.repo-edit')
  if (existing) {
    existing.remove()
    return
  }
  const repo = repos.find((r) => r.id === repoId)
  if (!repo) return
  const nameInput = h('input', { type: 'text', value: repo.name, style: 'width:180px' }) as HTMLInputElement
  const urlInput = h('input', { type: 'text', value: repo.url, style: 'width:340px' }) as HTMLInputElement
  const editRow = h('div', { class: 'row repo-edit', style: 'width:100%' },
    h('span', { class: 'muted' }, text('名称：')), nameInput,
    h('span', { class: 'muted' }, text('地址：')), urlInput,
    h('button', {
      class: 'btn small primary',
      onclick: async () => {
        try {
          await bridge().updateSkillRepo(repoId, { name: nameInput.value, url: urlInput.value })
          toastFn('仓库信息已更新')
          await refreshAll()
        } catch (err) {
          toastFn(`更新失败：${String(err)}`, true)
        }
      },
    }, text('保存')),
    h('button', { class: 'btn small', onclick: () => item.querySelector('.repo-edit')?.remove() }, text('取消')),
  )
  item.append(editRow)
}

// ---- installed ----

function renderInstalledList(): void {
  const el = pane.querySelector('#instList')
  if (!el) return
  const list = filteredInstalled()
  const children: Node[] = []
  const hint = h('p', { class: 'muted', style: 'margin-bottom:6px' },
    text(`共 ${list.length} 个（启用 ${list.filter((s) => s.enabled).length}） · 目录：${currentScope === 'global' ? state?.globalDir : state?.projectDir}`))
  children.push(hint)
  if (list.length === 0) {
    children.push(h('p', { class: 'empty' }, text('暂无已安装 Skills。请先在“Skills 仓库”中添加仓库并安装。')))
  } else {
    for (const s of list) children.push(renderInstalledItem(s))
  }
  el.replaceChildren(...children)
  const selectAll = pane.querySelector('#selectAll') as HTMLInputElement | null
  if (selectAll) {
    selectAll.checked = selected.size > 0 && list.length > 0 && selected.size === list.length
    selectAll.indeterminate = selected.size > 0 && selected.size < list.length
  }
}

function renderInstalledItem(s: InstalledSkill): HTMLElement {
  const checkbox = h('input', { type: 'checkbox' }) as HTMLInputElement
  checkbox.checked = selected.has(s.key)
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(s.key)
    else selected.delete(s.key)
    const all = pane.querySelector('#selectAll') as HTMLInputElement | null
    const list = filteredInstalled()
    if (all) {
      all.checked = selected.size === list.length && list.length > 0
      all.indeterminate = selected.size > 0 && selected.size < list.length
    }
  })

  const enabledSwitch = h('input', { type: 'checkbox' }) as HTMLInputElement
  enabledSwitch.checked = s.enabled
  enabledSwitch.addEventListener('change', async () => {
    try {
      await bridge().setSkillEnabled(s.key, s.scope, enabledSwitch.checked)
      toastFn(`已${enabledSwitch.checked ? '启用' : '停用'} ${s.name}`)
    } catch (err) {
      enabledSwitch.checked = !enabledSwitch.checked
      toastFn(`操作失败：${String(err)}`, true)
    }
    await refreshAll()
  })

  const badgesArr: Node[] = []
  badgesArr.push(badge(s.enabled ? '已启用' : '已停用', s.enabled ? 'ok' : 'muted'))
  if (updatesByKey.has(s.key)) badgesArr.push(badge('有更新', 'warn'))
  badgesArr.push(badge(s.scope === 'global' ? '全局' : '项目', 'accent'))

  return h('div', { class: 'item', 'data-key': s.key },
    checkbox,
    h('label', { class: 'switch' }, enabledSwitch, h('span', { class: 'track' })),
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(s.name), ...badgesArr),
      h('div', { class: 'sub mono' }, text(`${s.repoUrl} · ${s.path} · commit ${shortCommit(s.commit)} · 更新于 ${fmtTs(s.updatedAt)}`)),
    ),
    h('button', { class: 'btn small', onclick: () => toggleSkillDetail(s.key) }, text('详情')),
    h('button', { class: 'btn small', disabled: !updatesByKey.has(s.key), onclick: () => void updateSkill(s.key) }, text('更新')),
    h('button', { class: 'btn small', onclick: () => void uninstallSkill(s.key, false) }, text('卸载')),
    h('button', { class: 'btn small danger', onclick: () => void uninstallSkill(s.key, true) }, text('删除')),
  )
}

function installedItemEl(key: string): HTMLElement | null {
  return pane.querySelector(`#instList .item[data-key="${key}"]`) as HTMLElement | null
}

function toggleSkillDetail(key: string): void {
  const item = installedItemEl(key)
  if (!item) return
  const existing = item.querySelector('.skill-detail')
  if (existing) {
    existing.remove()
    return
  }
  const s = installed.find((x) => x.key === key)
  if (!s) return
  const detail = h('div', { class: 'skill-detail', style: 'width:100%' })
  const kv = h('div', { class: 'kv' })
  kv.append(
    h('div', { class: 'k' }, text('Key')), h('div', { class: 'mono' }, text(s.key)),
    h('div', { class: 'k' }, text('来源仓库')), h('div', { class: 'mono' }, text(s.repoUrl)),
    h('div', { class: 'k' }, text('仓库内路径')), h('div', { class: 'mono' }, text(s.path)),
    h('div', { class: 'k' }, text('版本 / commit')), h('div', { class: 'mono' }, text(s.commit ?? '—')),
    h('div', { class: 'k' }, text('安装时间')), h('div', { class: 'mono' }, text(fmtTs(s.installedAt))),
    h('div', { class: 'k' }, text('文件数')), h('div', { class: 'mono' }, text(String(s.files.length))),
  )
  detail.append(kv)
  detail.append(h('pre', { class: 'mono', style: 'white-space:pre-wrap;user-select:text' }, text(s.files.join('\n') || '（无文件）')))
  item.append(detail)
}

async function updateSkill(key: string): Promise<void> {
  try {
    const result = await bridge().updateSkills([key], currentScope)
    toastFn(result.failed.length ? `更新失败：${result.failed[0].error}` : '技能已更新', result.failed.length > 0)
  } catch (err) {
    toastFn(`更新失败：${String(err)}`, true)
  }
  await refreshAll()
  await checkUpdates()
}

async function uninstallSkill(key: string, isDelete: boolean): Promise<void> {
  const s = installed.find((x) => x.key === key)
  const label = s?.name ?? key
  if (!confirm(`确定${isDelete ? '删除' : '卸载'}技能 ${label}？文件副本将从作用域目录移除。`)) return
  try {
    if (isDelete) await bridge().deleteSkill(key, currentScope)
    else await bridge().uninstallSkill(key, currentScope)
    toastFn(`已${isDelete ? '删除' : '卸载'} ${label}`)
  } catch (err) {
    toastFn(`操作失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function batchAction(action: 'enable' | 'disable' | 'uninstall' | 'delete'): Promise<void> {
  const keys = [...selected]
  if (keys.length === 0) {
    toastFn('请先勾选技能', true)
    return
  }
  const actionLabel = action === 'enable' ? '启用' : action === 'disable' ? '停用' : action === 'uninstall' ? '卸载' : '删除'
  if (action === 'uninstall' || action === 'delete') {
    if (!confirm(`确定${actionLabel}选中的 ${keys.length} 个技能？`)) return
  }
  try {
    const result = await bridge().batchSkills(keys, currentScope, action)
    if (result.failed.length) toastFn(`${actionLabel}完成：成功 ${result.done.length}，失败 ${result.failed.length}`, true)
    else toastFn(`已${actionLabel} ${result.done.length} 个技能`)
    selected.clear()
  } catch (err) {
    toastFn(`批量${actionLabel}失败：${String(err)}`, true)
  }
  await refreshAll()
}

// ---- updates ----

async function checkUpdates(): Promise<void> {
  try {
    const result = await bridge().checkSkillUpdates(currentScope)
    updatesByKey = new Map(result.updated.map((u) => [u.key, u.latest]))
    if (result.updated.length) toastFn(`发现 ${result.updated.length} 个可更新技能（${scopeLabel()}）`)
    else if (result.errors.length) toastFn(`更新检测完成，${result.errors.length} 个仓库检测失败`, true)
    else toastFn('没有可用的更新')
  } catch (err) {
    toastFn(`更新检测失败：${String(err)}`, true)
  }
  renderInstalledList()
}

async function updateAllAvailable(): Promise<void> {
  const keys = filteredInstalled().map((s) => s.key)
  if (keys.length === 0) {
    toastFn('没有已安装技能', true)
    return
  }
  try {
    const result = await bridge().updateSkills(keys, currentScope)
    toastFn(result.failed.length ? `已更新 ${result.updated.length} 个，失败 ${result.failed.length}` : `已更新 ${result.updated.length} 个技能`, result.failed.length > 0)
  } catch (err) {
    toastFn(`更新失败：${String(err)}`, true)
  }
  await refreshAll()
  await checkUpdates()
}

// ---- search ----

async function doSearch(input: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  const q = input.value.trim()
  if (!q) {
    toastFn('请输入搜索关键词', true)
    return
  }
  btn.disabled = true
  btn.textContent = '搜索中…'
  try {
    searchResults = await bridge().searchSkills(q)
    renderSearchList()
    toastFn(searchResults.length ? `找到 ${searchResults.length} 个仓库` : '未找到相关仓库')
  } catch (err) {
    toastFn(`搜索失败：${String(err)}`, true)
  } finally {
    btn.disabled = false
    btn.textContent = '搜索'
  }
}

function renderSearchList(): void {
  const el = pane.querySelector('#searchList')
  if (!el) return
  el.innerHTML = ''
  if (searchResults.length === 0) {
    el.append(h('p', { class: 'empty' }, text('搜索 GitHub 以发现 Skills 仓库（结果为空时可换关键词）。')))
    return
  }
  for (const r of searchResults) el.append(renderSearchItem(r))
}

function renderSearchItem(r: SearchResultView): HTMLElement {
  const btn = h('button', {
    class: 'btn small primary',
    onclick: () => void installSearch(r, btn),
  }, text(`安装到${scopeLabel()}`)) as HTMLButtonElement
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(r.fullName), badge(`${r.stars} ★`, '')),
      h('div', { class: 'sub mono' }, text(r.description ?? '')),
    ),
    btn,
  )
}

async function installSearch(r: SearchResultView, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true
  btn.textContent = '安装中…'
  try {
    const result = await bridge().installSkillFromSearch({ fullName: r.fullName, scope: currentScope })
    toastFn(`已添加仓库 ${r.fullName} 并安装 ${result.installed.length} 个技能`)
    const repo = repos.find((x) => x.id === result.repository.id)
    if (repo) toggleExpandRepo(repo.id)
  } catch (err) {
    toastFn(`安装失败：${String(err)}`, true)
  } finally {
    btn.disabled = false
    btn.textContent = `安装到${scopeLabel()}`
  }
  await refreshAll()
}

// ---- backup ----

async function doExport(includePayload: boolean): Promise<void> {
  try {
    const result = await bridge().exportSkills({ scope: currentScope, includePayload })
    if (result.canceled) return
    toastFn(`已导出 ${result.count ?? 0} 个技能到 ${result.filePath ?? ''}`)
  } catch (err) {
    toastFn(`导出失败：${String(err)}`, true)
  }
}

async function doImport(): Promise<void> {
  try {
    const result = await bridge().importSkills()
    if (result.canceled) return
    const report = result.report
    if (report) {
      toastFn(`导入完成：仓库 ${report.importedRepositories} 新增 / ${report.existingRepositories} 已存在，技能 ${report.importedSkills} 个，冲突 ${report.conflicts.length} 个` +
        (report.conflicts.length ? `（首个：${report.conflicts[0].reason}）` : ''), report.conflicts.length > 0)
    }
  } catch (err) {
    toastFn(`导入失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function doCreateBackup(): Promise<void> {
  try {
    const entry = await bridge().createSkillBackup('all')
    toastFn(`备份已创建：${entry.id}（${entry.skillCount} 个技能）`)
  } catch (err) {
    toastFn(`备份失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function doRefreshBackups(): Promise<void> {
  await refreshAll()
}

function renderBackupList(): void {
  const el = pane.querySelector('#backupList') as HTMLElement | null
  if (!el) return
  el.innerHTML = ''
  if (backupCache.length === 0) {
    el.append(h('p', { class: 'empty' }, text('暂无备份。点击“创建备份”保存当前配置与已安装技能。')))
    return
  }
  for (const b of backupCache) el.append(renderBackupItem(b))
}
function renderBackupItem(b: SkillBackupView): HTMLElement {
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(b.id), badge(`${b.scope === 'all' ? '全部' : b.scope} · ${b.skillCount} 技能`, 'accent')),
      h('div', { class: 'sub mono' }, text(`${fmtTs(b.createdAt)} · ${(b.sizeBytes / 1024).toFixed(1)} KB`)),
    ),
    h('button', {
      class: 'btn small primary',
      onclick: () => void restoreBackupEntry(b),
    }, text('恢复')),
    h('button', {
      class: 'btn small danger',
      onclick: () => void deleteBackupEntry(b),
    }, text('删除')),
  )
}

async function restoreBackupEntry(b: SkillBackupView): Promise<void> {
  if (!confirm(`确定从备份 ${b.id} 恢复？将导入其中的仓库与技能（冲突会跳过并报告）。`)) return
  try {
    const report = await bridge().restoreSkillBackup(b.id, currentScope)
    toastFn(`恢复完成：技能 ${report.importedSkills} 个，冲突 ${report.conflicts.length} 个`, report.conflicts.length > 0)
  } catch (err) {
    toastFn(`恢复失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function deleteBackupEntry(b: SkillBackupView): Promise<void> {
  if (!confirm(`确定删除备份 ${b.id}？`)) return
  try {
    backupCache = await bridge().deleteSkillBackup(b.id)
    toastFn('备份已删除')
  } catch (err) {
    toastFn(`删除失败：${String(err)}`, true)
  }
  await refreshAll()
}
