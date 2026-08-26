/**
 * Skills 管理：仓库管理、作用域（全局/项目）安装生命周期、批量操作、
 * Agent 管理（全局/项目目录本机 Agent）、GitHub 搜索、更新检测与备份/导入/导出。
 *
 * 页面结构与表现统一走 control/ui 组件库（shadcn/ui 风格）；所有操作经
 * preload 桥接（window.dshc）转发到主进程 SkillsService；不读写
 * deepseek-harness 源码。
 */
import { bridge, type SkillRepositoryView, type SkillScope, type SkillsState, type SkillBackupView, type InstalledSkill, type DiscoveredSkill } from '../api'
import {
  badge,
  button,
  card,
  checkbox,
  confirmDialog,
  emptyState,
  h,
  inputEl,
  kv,
  listContainer,
  listHint,
  row,
  segmented,
  switchControl,
  text,
} from '../ui'
import { renderAgentsPanel } from './skills/agents-panel'

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
  const overview = card(
    { title: 'Skills 概览', actions: [
      button({ size: 'sm', onClick: () => void checkUpdates() }, text('检测更新')),
      button({ size: 'sm', onClick: () => void updateAllAvailable() }, text('更新全部')),
      button({ variant: 'primary', size: 'sm', onClick: () => void syncAll() }, text('同步全部')),
    ] },
    h('div', { id: 'overviewBody' }),
  )

  const agentCard = card(
    { title: 'Agent 管理' },
    h('div', { id: 'agentPanelBody' }),
  )

  const repoCard = card(
    { title: 'Skills 仓库', bodyClassName: 'card-body' },
    row(
      text('仓库地址：'),
      inputEl({ type: 'text', placeholder: state?.defaultRepository ?? 'https://github.com/mattpocock/skills', width: 220, className: 'repo-url-input' }),
      inputEl({ type: 'text', placeholder: '名称（可选）', width: 110, className: 'repo-name-input' }),
      button({ variant: 'primary', size: 'sm', className: 'repo-add-btn', onClick: () => void addRepo() }, text('添加并拉取')),
    ),
    listHint('支持任意公开 http(s) Skills 仓库；私有仓库请在「设置」页配置 GitHub 凭据。'),
    listContainer('repoList'),
  )

  const instCard = card({ title: '已安装 Skills' })
  const selectAll = checkbox({ id: 'selectAll' })
  selectAll.addEventListener('change', () => {
    selected = selectAll.checked ? new Set(filteredInstalled().map((s) => s.key)) : new Set()
    renderInstalledList()
  })
  const instToolbar = row(
    h('label', { class: 'checkbox-label' }, selectAll, text('全选')),
    button({ size: 'sm', onClick: () => void batchAction('enable') }, text('批量启用')),
    button({ size: 'sm', onClick: () => void batchAction('disable') }, text('批量停用')),
    button({ size: 'sm', onClick: () => void batchAction('uninstall') }, text('批量卸载')),
    button({ size: 'sm', variant: 'danger', onClick: () => void batchAction('delete') }, text('批量删除')),
  )
  instCard.querySelector('.card-body')?.append(
    instToolbar,
    listHint('按当前作用域展示；勾选后可批量启用/停用/卸载/删除。'),
    listContainer('instList'),
  )

  const searchCard = card(
    { title: 'GitHub Skills 搜索' },
    row(
      inputEl({ type: 'text', placeholder: '关键词，如 skills / claude skill / dsh-skill', width: 220, className: 'search-query-input' }),
      button({ variant: 'primary', size: 'sm', className: 'search-btn', onClick: () => void doSearch() }, text('搜索')),
    ),
    listContainer('searchList'),
  )

  const backupCard = card(
    { title: '备份与迁移', actions: [
      button({ size: 'sm', onClick: () => void doExport(false) }, text('导出配置')),
      button({ size: 'sm', onClick: () => void doExport(true) }, text('导出（含内容）')),
      button({ size: 'sm', onClick: () => void doImport() }, text('导入')),
      button({ variant: 'primary', size: 'sm', onClick: () => void doCreateBackup() }, text('创建备份')),
      button({ size: 'sm', onClick: () => void doRefreshBackups() }, text('刷新备份')),
    ] },
    listHint('备份自动保存到备份目录，包含仓库注册表、已安装清单与技能文件内容。'),
    listContainer('backupList'),
  )

  pane.append(overview, agentCard)
  pane.append(h('div', { class: 'skills-cols' }, repoCard, instCard))
  pane.append(h('div', { class: 'skills-cols' }, searchCard, backupCard))
}

// ---- 概览 ----

function renderOverview(): void {
  const body = pane.querySelector('#overviewBody')
  if (!body) return
  const list = filteredInstalled()
  const globalCount = installed.filter((s) => s.scope === 'global').length
  const projectCount = installed.filter((s) => s.scope === 'project').length
  const stats = h('div', { class: 'overview-stats' },
    statBox('仓库', state?.repositoryCount ?? 0, ''),
    statBox('已安装', state?.installedCount ?? 0, ''),
    statBox('全局', globalCount, 'ok'),
    statBox('项目', projectCount, 'accent'),
    statBox('备份', backupCache.length, ''),
  )
  const scopeRow = row(
    text('作用域：'),
    segmented(
      [{ value: 'global', label: '全局 Skills' }, { value: 'project', label: '项目 Skills' }],
      currentScope,
      (v) => {
        currentScope = v
        selected.clear()
        renderOverview()
        renderInstalledList()
      },
    ),
    h('span', { class: 'grow' }),
    listHint(`当前作用域：${scopeLabel()}（${list.length} 个已安装）`),
  )
  body.replaceChildren(
    scopeRow,
    stats,
    kv([
      ['Skills 目录', state?.skillsDir ?? '—'],
      ['仓库缓存', state?.reposDir ?? '—'],
      ['全局目录', state?.globalDir ?? '—'],
      ['项目目录', state?.projectDir ?? '—'],
      ['备份目录', state?.backupsDir ?? '—'],
      ['Agents Home', state?.agentsHome ?? '—'],
      ['默认仓库', state?.defaultRepository ?? '—'],
    ]),
  )
}

function statBox(label: string, value: number, cls: string): HTMLElement {
  return h('div', { class: 'stat' },
    h('div', { class: ['dash-count', cls].filter(Boolean).join(' ') }, text(String(value))),
    h('div', { class: 'stat-label' }, text(label)),
  )
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
  renderOverview()
  renderRepoList()
  renderInstalledList()
  const agentBody = pane.querySelector<HTMLElement>('#agentPanelBody')
  if (agentBody) renderAgentsPanel(agentBody, installed.filter((s) => s.repoId === 'agents'), state, refreshAll, toastFn)
  renderBackupList()
  renderSearchList()
}

function filteredInstalled(): InstalledSkill[] {
  return installed.filter((s) => s.scope === currentScope)
}

// ---- repositories ----

async function addRepo(): Promise<void> {
  const urlInput = pane.querySelector<HTMLInputElement>('.repo-url-input')
  const nameInput = pane.querySelector<HTMLInputElement>('.repo-name-input')
  const btn = pane.querySelector<HTMLButtonElement>('.repo-add-btn')
  if (!urlInput || !nameInput || !btn) return
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
  el.replaceChildren()
  if (repos.length === 0) {
    el.append(emptyState('暂无仓库。添加默认示例：https://github.com/mattpocock/skills'))
    return
  }
  for (const repo of repos) el.append(renderRepoItem(repo))
}

function renderRepoItem(repo: SkillRepositoryView): HTMLElement {
  const sw = switchControl(repo.enabled, (on) => {
    void (async () => {
      try {
        await bridge().setSkillRepoEnabled(repo.id, on)
        await refreshAll()
      } catch (err) {
        sw.input.checked = !on
        toastFn(`切换失败：${String(err)}`, true)
      }
    })()
  })
  const badgesArr: Node[] = []
  if (repo.enabled) badgesArr.push(badge('已启用', 'ok'))
  if (repo.lastSyncError) badgesArr.push(badge('同步失败', 'err'))
  else if (repo.lastSyncAt) badgesArr.push(badge(`已同步 ${fmtTs(repo.lastSyncAt)}`))
  badgesArr.push(badge(`分支 ${repo.branch ?? '—'}`))
  badgesArr.push(badge(`commit ${shortCommit(repo.lastCommit)}`))
  badgesArr.push(badge(`${repo.skillsCount ?? '?'} 个技能`, 'accent'))

  return h('div', { class: 'item', 'data-repo-id': repo.id },
    sw.root,
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(repo.name), ...badgesArr),
      h('div', { class: 'sub mono' }, text(`${repo.url}${repo.lastSyncError ? ' · ' + repo.lastSyncError : ''}`)),
    ),
    button({ size: 'sm', onClick: () => void syncRepo(repo.id) }, text('同步')),
    button({ size: 'sm', onClick: () => toggleExpandRepo(repo.id) }, text('查看 Skills')),
    button({ size: 'sm', onClick: () => toggleEditRepo(repo.id) }, text('编辑')),
    button({ size: 'sm', variant: 'danger', onClick: () => void deleteRepo(repo) }, text('删除')),
  )
}

async function deleteRepo(repo: SkillRepositoryView): Promise<void> {
  const ok = await confirmDialog({
    title: '删除仓库',
    message: `确定删除仓库 ${repo.name}（${repo.url}）？已安装的 Skill 副本不受影响。`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
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
  const detail = h('div', { class: 'repo-detail' })
  item.append(detail)
  void loadAvailable(repoId, detail)
}

async function loadAvailable(repoId: string, container: HTMLElement): Promise<void> {
  container.replaceChildren(listHint('正在扫描仓库…'))
  try {
    const result = await bridge().listAvailableSkills(repoId)
    renderAvailable(result, container)
  } catch (err) {
    container.replaceChildren(emptyState(`无法读取：${String(err)}`))
  }
}

function renderAvailable(result: { repo: SkillRepositoryView; skills: DiscoveredSkill[] }, container: HTMLElement): void {
  container.replaceChildren(
    row(
      button({ variant: 'primary', size: 'sm', onClick: () => void installAllAvailable(result.repo) }, text(`全部安装到${scopeLabel()}`)),
      listHint(`共 ${result.skills.length} 个技能`),
    ),
  )
  if (result.skills.length === 0) {
    container.append(emptyState('仓库中未发现 SKILL.md 技能'))
    return
  }
  for (const s of result.skills) container.append(renderAvailableItem(result.repo, s))
}

function renderAvailableItem(repo: SkillRepositoryView, skill: DiscoveredSkill): HTMLElement {
  const key = `${repo.id}:${skill.path}`
  const already = installed.some((x) => x.key === key)
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(skill.name), already ? badge('已安装', 'ok') : badge('未安装')),
      h('div', { class: 'sub mono' }, text(`${skill.path} · ${skill.description ?? ''}`)),
    ),
    button({
      size: 'sm',
      variant: already ? 'default' : 'primary',
      disabled: already,
      onClick: () => void installSkill(repo.id, skill.path),
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
  const nameInput = inputEl({ type: 'text', value: repo.name, width: 150 })
  const urlInput = inputEl({ type: 'text', value: repo.url, width: 260 })
  const editRow = h('div', { class: 'repo-edit' },
    text('名称：'), nameInput,
    text('地址：'), urlInput,
    button({ size: 'sm', variant: 'primary', onClick: () => void saveRepoEdit(repoId, nameInput, urlInput) }, text('保存')),
    button({ size: 'sm', onClick: () => editRow.remove() }, text('取消')),
  )
  item.append(editRow)
}

async function saveRepoEdit(repoId: string, nameInput: HTMLInputElement, urlInput: HTMLInputElement): Promise<void> {
  try {
    await bridge().updateSkillRepo(repoId, { name: nameInput.value, url: urlInput.value })
    toastFn('仓库信息已更新')
    await refreshAll()
  } catch (err) {
    toastFn(`更新失败：${String(err)}`, true)
  }
}

// ---- installed ----

function renderInstalledList(): void {
  const el = pane.querySelector('#instList')
  if (!el) return
  const list = filteredInstalled()
  const children: Node[] = []
  children.push(listHint(`共 ${list.length} 个（启用 ${list.filter((s) => s.enabled).length}） · 目录：${currentScope === 'global' ? state?.globalDir : state?.projectDir}`, 'inst-hint'))
  if (list.length === 0) {
    children.push(emptyState('暂无已安装 Skills。请先在上方「Skills 仓库」中添加仓库并安装。'))
  } else {
    for (const s of list) children.push(renderInstalledItem(s))
  }
  el.replaceChildren(...children)
  const selectAll = pane.querySelector<HTMLInputElement>('#selectAll')
  if (selectAll) {
    selectAll.checked = selected.size > 0 && list.length > 0 && selected.size === list.length
    selectAll.indeterminate = selected.size > 0 && selected.size < list.length
  }
}

function renderInstalledItem(s: InstalledSkill): HTMLElement {
  const checkboxSel = checkbox({ checked: selected.has(s.key) })
  checkboxSel.addEventListener('change', () => {
    if (checkboxSel.checked) selected.add(s.key)
    else selected.delete(s.key)
    const all = pane.querySelector<HTMLInputElement>('#selectAll')
    const list = filteredInstalled()
    if (all) {
      all.checked = selected.size === list.length && list.length > 0
      all.indeterminate = selected.size > 0 && selected.size < list.length
    }
  })

  const sw = switchControl(s.enabled, (on) => {
    void (async () => {
      try {
        await bridge().setSkillEnabled(s.key, s.scope, on)
        toastFn(`已${on ? '启用' : '停用'} ${s.name}`)
      } catch (err) {
        sw.input.checked = !on
        toastFn(`操作失败：${String(err)}`, true)
      }
      await refreshAll()
    })()
  })

  const badgesArr: Node[] = []
  badgesArr.push(badge(s.enabled ? '已启用' : '已停用', s.enabled ? 'ok' : 'muted'))
  if (updatesByKey.has(s.key)) badgesArr.push(badge('有更新', 'warn'))
  badgesArr.push(badge(s.scope === 'global' ? '全局' : '项目', 'accent'))

  return h('div', { class: 'item', 'data-key': s.key },
    checkboxSel,
    sw.root,
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(s.name), ...badgesArr),
      h('div', { class: 'sub mono' }, text(s.repoId === 'agents' ? `本地${scopeLabel()} Agent（${s.scope === 'global' ? (state?.globalDir ?? '') : (state?.projectDir ?? '')}） · ${s.path}` : `${s.repoUrl} · ${s.path} · commit ${shortCommit(s.commit)} · 更新于 ${fmtTs(s.updatedAt)}`)),
    ),
    button({ size: 'sm', onClick: () => toggleSkillDetail(s.key) }, text('详情')),
    button({ size: 'sm', disabled: !updatesByKey.has(s.key), onClick: () => void updateSkill(s.key) }, text('更新')),
    button({ size: 'sm', onClick: () => void uninstallSkill(s.key, false) }, text('卸载')),
    button({ size: 'sm', variant: 'danger', onClick: () => void uninstallSkill(s.key, true) }, text('删除')),
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
  const detail = h('div', { class: 'skill-detail' })
  detail.append(kv([
    ['Key', s.key],
    ['来源仓库', s.repoUrl],
    ['仓库内路径', s.path],
    ['版本 / commit', s.commit ?? '—'],
    ['安装时间', fmtTs(s.installedAt)],
    ['文件数', String(s.files.length)],
  ]))
  detail.append(h('pre', { class: 'mono' }, text(s.files.join('\n') || '（无文件）')))
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
  const ok = await confirmDialog({
    title: isDelete ? '删除技能' : '卸载技能',
    message: `确定${isDelete ? '删除' : '卸载'}技能 ${label}？文件副本将从作用域目录移除。`,
    confirmLabel: isDelete ? '删除' : '卸载',
    danger: isDelete,
  })
  if (!ok) return
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
    const ok = await confirmDialog({
      title: `批量${actionLabel}`,
      message: `确定${actionLabel}选中的 ${keys.length} 个技能？`,
      confirmLabel: actionLabel,
      danger: action === 'delete',
    })
    if (!ok) return
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
  const keys = filteredInstalled().filter((s) => s.repoId !== 'agents').map((s) => s.key)
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

async function doSearch(): Promise<void> {
  const input = pane.querySelector<HTMLInputElement>('.search-query-input')
  const btn = pane.querySelector<HTMLButtonElement>('.search-btn')
  if (!input || !btn) return
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
  el.replaceChildren()
  if (searchResults.length === 0) {
    el.append(emptyState('搜索 GitHub 以发现 Skills 仓库（结果为空时可换关键词）。'))
    return
  }
  for (const r of searchResults) el.append(renderSearchItem(r))
}

function renderSearchItem(r: SearchResultView): HTMLElement {
  const btn = button({
    size: 'sm',
    variant: 'primary',
    onClick: () => void installSearch(r, btn),
  }, text(`安装到${scopeLabel()}`))
  return h('div', { class: 'item' },
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(r.fullName), badge(`${r.stars} ★`)),
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
  const el = pane.querySelector('#backupList')
  if (!el) return
  el.replaceChildren()
  if (backupCache.length === 0) {
    el.append(emptyState('暂无备份。点击「创建备份」保存当前配置与已安装技能。'))
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
    button({ size: 'sm', variant: 'primary', onClick: () => void restoreBackupEntry(b) }, text('恢复')),
    button({ size: 'sm', variant: 'danger', onClick: () => void deleteBackupEntry(b) }, text('删除')),
  )
}

async function restoreBackupEntry(b: SkillBackupView): Promise<void> {
  const ok = await confirmDialog({
    title: '恢复备份',
    message: `确定从备份 ${b.id} 恢复？将导入其中的仓库与技能（冲突会跳过并报告）。`,
    confirmLabel: '恢复',
  })
  if (!ok) return
  try {
    const report = await bridge().restoreSkillBackup(b.id, currentScope)
    toastFn(`恢复完成：技能 ${report.importedSkills} 个，冲突 ${report.conflicts.length} 个`, report.conflicts.length > 0)
  } catch (err) {
    toastFn(`恢复失败：${String(err)}`, true)
  }
  await refreshAll()
}

async function deleteBackupEntry(b: SkillBackupView): Promise<void> {
  const ok = await confirmDialog({
    title: '删除备份',
    message: `确定删除备份 ${b.id}？`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    backupCache = await bridge().deleteSkillBackup(b.id)
    toastFn('备份已删除')
  } catch (err) {
    toastFn(`删除失败：${String(err)}`, true)
  }
  await refreshAll()
}
