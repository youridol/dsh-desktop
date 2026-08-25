/**
 * dsh-desktop Skills 管理服务（门面）。
 *
 * 统一组装仓库管理、技能发现、安装生命周期、GitHub 搜索与备份恢复，
 * 并暴露给 IPC 层。所有数据与操作都局限在 dsh-desktop 自己的运行目录，
 * 不修改 deepseek-harness 上游源码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import { getPaths } from '../../paths'
import { resolveSkillsPaths } from './harnessPaths'
import { getConfig, readCredentials } from '../../config'
import { appLog } from '../../logger'
import { getControlPanel } from '../../windows/control'
import { GitRunner } from './gitRunner'
import {
  SkillsRepositoryManager,
  type SkillsRepositoryRecord,
  type AddRepositoryInput,
  type RepositoryPatch,
} from './repositoryManager'
import { SkillsLifecycle, type InstalledSkill, type SkillLifecycleOptions } from './lifecycle'
import { discoverSkills, type DiscoveredSkill } from './discovery'
import {
  buildExport,
  validateExportBundle,
  applyExportBundle,
  writeBackup,
  listBackups,
  readBackup,
  deleteBackup,
  type SkillsExportBundle,
  type BackupEntry,
} from './backup'
import {
  isValidSkillScope,
  isValidScopeFilter,
  AGENTS_SOURCE_ID,
  type SkillScope,
  type ScopeFilter,
} from './validation'

export type {
  SkillsRepositoryRecord,
  AddRepositoryInput,
  RepositoryPatch,
  InstalledSkill,
  DiscoveredSkill,
  SkillsExportBundle,
  BackupEntry,
  SkillScope,
  ScopeFilter,
}

// ---- paths ----

interface SkillsPaths {
  skillsDir: string
  reposDir: string
  globalDir: string
  projectDir: string
  backupsDir: string
  configFile: string
  agentsHome: string
}

/**
 * 统一路径解析：globalDir = <agentsHome>/skills（deepseek-harness 真实全局根），
 * 仓库缓存/备份/注册表仍位于 dsh-desktop 运行目录；config 覆盖路径支持 `~` 前缀。
 */
function skillsPaths(): SkillsPaths {
  const base = getPaths().skillsDir
  const projectOverride = getConfig().skills?.projectDir
  const p = resolveSkillsPaths({
    runtimeSkillsDir: base,
    projectDir: projectOverride,
    env: process.env,
  })
  return {
    skillsDir: p.skillsDir,
    reposDir: p.reposDir,
    globalDir: p.globalDir,
    projectDir: p.projectDir,
    backupsDir: p.backupsDir,
    configFile: p.configFile,
    agentsHome: p.agentsHome,
  }
}

// ---- singletons ----

let manager: SkillsRepositoryManager | null = null
let lifecycle: SkillsLifecycle | null = null

function ensureServices(): { manager: SkillsRepositoryManager; lifecycle: SkillsLifecycle; paths: SkillsPaths } {
  const p = skillsPaths()
  fs.mkdirSync(p.skillsDir, { recursive: true })
  fs.mkdirSync(p.reposDir, { recursive: true })
  fs.mkdirSync(p.globalDir, { recursive: true })
  fs.mkdirSync(p.projectDir, { recursive: true })
  fs.mkdirSync(p.backupsDir, { recursive: true })
  const auth = gitAuth()
  if (!manager) {
    const git = new GitRunner({ auth })
    manager = new SkillsRepositoryManager({ configFile: p.configFile, reposDir: p.reposDir, git })
  } else {
    manager.setAuth(auth)
  }
  if (!lifecycle) {
    const opts: SkillLifecycleOptions = { globalDir: p.globalDir, projectDir: p.projectDir, reposDir: p.reposDir }
    lifecycle = new SkillsLifecycle(opts)
  }
  return { manager, lifecycle, paths: p }
}

// ---- repositories ----

export function listRepositories(): SkillsRepositoryRecord[] {
  return ensureServices().manager.list()
}

export async function addRepository(input: AddRepositoryInput): Promise<{ repo: SkillsRepositoryRecord; existed: boolean }> {
  const { manager } = ensureServices()
  const result = await manager.add(input)
  appLog.info(`skills: add repository ${result.repo.url} (existed=${result.existed})`)
  return result
}

export function updateRepository(id: string, patch: RepositoryPatch): SkillsRepositoryRecord {
  const { manager } = ensureServices()
  const result = manager.update(id, patch)
  appLog.info(`skills: update repository ${id}`)
  return result
}

export function setRepositoryEnabled(id: string, enabled: boolean): SkillsRepositoryRecord {
  return updateRepository(id, { enabled })
}

export function removeRepository(id: string): void {
  const { manager } = ensureServices()
  manager.remove(id)
  appLog.info(`skills: remove repository ${id}`)
}

export async function syncRepository(id: string): Promise<SkillsRepositoryRecord> {
  const { manager } = ensureServices()
  const result = await manager.sync(id)
  appLog.info(`skills: synced repository ${id} @ ${result.lastCommit}`)
  return result
}

export async function syncAllRepositories(): Promise<{ synced: number; failed: Array<{ id: string; error: string }> }> {
  const { manager } = ensureServices()
  const result = await manager.syncAll()
  appLog.info(`skills: syncAll done synced=${result.synced} failed=${result.failed.length}`)
  return result
}

// ---- available / installed ----

export function availableSkills(repoId: string): { repo: SkillsRepositoryRecord; skills: DiscoveredSkill[] } {
  const { manager } = ensureServices()
  const repo = manager.get(repoId)
  if (!repo) throw new Error('仓库不存在')
  const dir = manager.resolveRepoDir(repoId)
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('仓库尚未同步，请先拉取')
  return { repo, skills: discoverSkills(dir) }
}

export function listInstalled(scope?: SkillScope): InstalledSkill[] {
  return ensureServices().lifecycle.listInstalled(scope)
}

export function installSkillFromRepo(options: {
  repoId: string
  path: string
  scope: SkillScope
  overwrite?: boolean
}): InstalledSkill {
  const { manager, lifecycle: lc } = ensureServices()
  if (!isValidSkillScope(options.scope)) throw new Error('无效的作用域')
  const repo = manager.get(options.repoId)
  if (!repo) throw new Error('仓库不存在')
  const dir = manager.resolveRepoDir(options.repoId)
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('仓库尚未同步，请先拉取')
  const skill = discoverSkills(dir).find((s) => s.path === options.path)
  if (!skill) throw new Error('在仓库中找不到该技能，请先同步')
  const result = lc.installSkill(options.scope, skill, repo, { overwrite: options.overwrite })
  appLog.info(`skills: installed ${result.key} -> ${options.scope}`)
  return result
}

export async function installAllFromRepo(options: {
  repoId: string
  scope: SkillScope
  overwrite?: boolean
}): Promise<{ installed: InstalledSkill[]; failed: Array<{ path: string; error: string }> }> {
  const { repo, skills } = availableSkills(options.repoId)
  const installed: InstalledSkill[] = []
  const failed: Array<{ path: string; error: string }> = []
  for (const skill of skills) {
    try {
      installed.push(ensureServices().lifecycle.installSkill(options.scope, skill, repo, { overwrite: options.overwrite }))
    } catch (err) {
      failed.push({ path: skill.path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { installed, failed }
}

export function uninstallSkill(key: string, scope: SkillScope): void {
  ensureServices().lifecycle.uninstallSkill(scope, key)
}

export function deleteSkill(key: string, scope: SkillScope): void {
  ensureServices().lifecycle.deleteSkill(scope, key)
}

export function setSkillEnabled(key: string, scope: SkillScope, enabled: boolean): InstalledSkill {
  return ensureServices().lifecycle.setEnabled(scope, key, enabled)
}

export function batchSkills(
  keys: string[],
  scope: SkillScope,
  action: 'enable' | 'disable' | 'uninstall' | 'delete',
): { done: string[]; failed: Array<{ key: string; error: string }> } {
  const { lifecycle: lc } = ensureServices()
  const done: string[] = []
  const failed: Array<{ key: string; error: string }> = []
  for (const key of keys) {
    try {
      if (action === 'enable') lc.setEnabled(scope, key, true)
      else if (action === 'disable') lc.setEnabled(scope, key, false)
      else if (action === 'uninstall' || action === 'delete') lc.uninstallSkill(scope, key)
      done.push(key)
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { done, failed }
}

// ---- updates ----

export async function checkSkillUpdates(scope?: SkillScope): Promise<{
  checkedAt: number
  updated: Array<{ key: string; current: string | null; latest: string }>
  upToDate: number
  errors: Array<{ repoId: string; error: string }>
}> {
  const { manager, lifecycle: lc } = ensureServices()
  const installed = lc.listInstalled(scope)
  // 本机全局 agent 技能无来源仓库，不参与仓库 commit 对比
  const byRepo = new Map<string, InstalledSkill[]>()
  for (const s of installed) {
    if (s.repoId === AGENTS_SOURCE_ID) continue
    if (!manager.get(s.repoId)) continue
    const list = byRepo.get(s.repoId) ?? []
    list.push(s)
    byRepo.set(s.repoId, list)
  }
  const updated: Array<{ key: string; current: string | null; latest: string }> = []
  const errors: Array<{ repoId: string; error: string }> = []
  let upToDate = 0
  const git = new GitRunner({ auth: gitAuth() })
  for (const [repoId, skills] of byRepo) {
    const repo = manager.get(repoId)
    if (!repo) {
      errors.push({ repoId, error: '来源仓库已删除' })
      continue
    }
    try {
      const remote = await git.lsRemoteHead(repo.url)
      if (!remote?.sha) {
        errors.push({ repoId, error: '无法读取远端 commit' })
        continue
      }
      for (const s of skills) {
        if (s.commit === remote.sha) upToDate += 1
        else updated.push({ key: s.key, current: s.commit, latest: remote.sha })
      }
    } catch (err) {
      errors.push({ repoId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { checkedAt: Date.now(), updated, upToDate, errors }
}

function gitAuth(): { user: string; token: string } | null {
  const creds = readCredentials()
  return creds.githubToken ? { user: creds.githubUser || 'x-access-token', token: creds.githubToken } : null
}

export async function updateSkills(keys: string[], scope?: SkillScope): Promise<{
  updated: InstalledSkill[]
  failed: Array<{ key: string; error: string }>
}> {
  const { manager, lifecycle: lc } = ensureServices()
  const updated: InstalledSkill[] = []
  const failed: Array<{ key: string; error: string }> = []
  const scopes = scope ? [scope] : (['global', 'project'] as const)
  const byKey = new Map<string, InstalledSkill>()
  for (const s of lc.listInstalled()) if (scopes.includes(s.scope)) byKey.set(s.key, s)
  for (const key of keys) {
    const skill = byKey.get(key)
    if (!skill) {
      failed.push({ key, error: '技能未安装' })
      continue
    }
    if (skill.repoId === AGENTS_SOURCE_ID) {
      failed.push({ key, error: '本地全局 Skills 无来源仓库，无法按仓库更新' })
      continue
    }
    try {
      const repo = manager.get(skill.repoId)
      if (!repo) throw new Error('来源仓库已删除')
      const synced = await manager.sync(skill.repoId)
      const dir = manager.resolveRepoDir(skill.repoId)
      const discovered = discoverSkills(dir).find((s) => s.path === skill.path)
      if (!discovered) throw new Error('仓库中已不存在该技能')
      const installed = lc.installSkill(skill.scope, discovered, synced, { overwrite: true })
      updated.push(installed)
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { updated, failed }
}

// ---- GitHub search ----

export interface GitHubSkillSearchResult {
  fullName: string
  name: string
  owner: string
  url: string
  description: string | null
  stars: number
  updatedAt: string | null
  defaultBranch: string | null
}

export async function searchGitHubSkills(query: string): Promise<GitHubSkillSearchResult[]> {
  const q = query.trim()
  if (!q) throw new Error('请输入搜索关键词')
  const creds = readCredentials()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  }
  if (creds.githubToken) headers.Authorization = `Bearer ${creds.githubToken}`
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch {
    throw new Error('GitHub 搜索失败：网络不可用')
  }
  if (!res.ok) {
    if (res.status === 403) throw new Error('GitHub 搜索限流（403），请在设置中配置 GitHub 凭据后重试')
    if (res.status === 422) throw new Error('GitHub 搜索查询无效（422）')
    throw new Error(`GitHub 搜索失败（${res.status}）`)
  }
  const data = (await res.json()) as { items?: Array<Record<string, unknown>> }
  return (data.items ?? [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      fullName: String(item.full_name ?? ''),
      name: String(item.name ?? ''),
      owner: String((item.owner as Record<string, unknown> | undefined)?.login ?? ''),
      url: String(item.html_url ?? ''),
      description: item.description ? String(item.description) : null,
      stars: Number(item.stargazers_count ?? 0),
      updatedAt: item.updated_at ? String(item.updated_at) : null,
      defaultBranch: item.default_branch ? String(item.default_branch) : null,
    }))
    .filter((r) => r.fullName)
}

export async function installFromGitHubSearch(options: {
  fullName: string
  scope: SkillScope
}): Promise<{ repository: SkillsRepositoryRecord; installed: InstalledSkill[]; available: DiscoveredSkill[] }> {
  if (!isValidSkillScope(options.scope)) throw new Error('无效的作用域')
  const fullName = options.fullName.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error('仓库标识不合法')
  const url = `https://github.com/${fullName}`
  const { manager } = ensureServices()
  const { repo } = await manager.add({ url, name: fullName.split('/').pop() ?? fullName })
  const { installed } = await installAllFromRepo({ repoId: repo.id, scope: options.scope })
  const { skills } = availableSkills(repo.id)
  return { repository: repo, installed, available: skills }
}

// ---- export / import / backup ----

function exportResolver() {
  const { lifecycle: lc } = ensureServices()
  return {
    readFile: (abs: string) => {
      try {
        return fs.readFileSync(abs, 'utf8')
      } catch {
        return null
      }
    },
    installedFileAbs: (scope: SkillScope, id: string, rel: string) =>
      // 扁平 agent 技能：文件即 <globalDir>/<name>.md，rel 与 id 同源
      scope === 'global' && id.endsWith('.md') && rel === id
        ? path.join(lc.scopeDir(scope), id)
        : path.join(lc.scopeDir(scope), id, ...rel.split('/')),
  }
}

export async function exportSkills(options: {
  scope?: ScopeFilter
  includePayload?: boolean
}): Promise<{ canceled: boolean; filePath?: string; count?: number }> {
  const { manager, lifecycle: lc } = ensureServices()
  const scope = options.scope ?? 'all'
  if (!isValidScopeFilter(scope)) throw new Error('无效的作用域')
  const data = buildExport(scope, manager.list(), lc.listInstalled(), !!options.includePayload, appVersion(), exportResolver())
  const win = getControlPanel()
  const result = win
    ? await dialog.showSaveDialog(win, {
      title: '导出 Skills',
      defaultPath: `dsh-skills-${scope === 'all' ? 'all' : scope}-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    : await dialog.showSaveDialog({
        title: '导出 Skills',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, JSON.stringify(data, undefined, 2), 'utf8')
  return { canceled: false, filePath: result.filePath, count: data.skills.length }
}

export async function importSkills(): Promise<{
  canceled: boolean
  report?: import('./backup').ImportReport
  filePath?: string
}> {
  const win = getControlPanel()
  const result = win
    ? await dialog.showOpenDialog(win, {
      title: '导入 Skills',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    : await dialog.showOpenDialog({
        title: '导入 Skills',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const filePath = result.filePaths[0]
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    throw new Error('无法读取导入文件（不是合法 JSON）')
  }
  const error0 = validateExportBundle(data)
  if (error0) throw new Error(error0)
  const { manager, lifecycle: lc } = ensureServices()
  const report = await applyExportBundle(data as SkillsExportBundle, { manager, lifecycle: lc })
  return { canceled: false, filePath, report }
}

export function createBackup(scope?: ScopeFilter): BackupEntry {
  const { manager, lifecycle: lc } = ensureServices()
  const target = scope ?? 'all'
  if (!isValidScopeFilter(target)) throw new Error('无效的作用域')
  const data = buildExport(target, manager.list(), lc.listInstalled(), true, appVersion(), exportResolver())
  const entry = writeBackup(ensureServices().paths.backupsDir, data)
  appLog.info(`skills: backup created ${entry.id}`)
  return entry
}

export function listSkillBackups(): BackupEntry[] {
  return listBackups(ensureServices().paths.backupsDir)
}

export async function restoreBackup(id: string, scope?: SkillScope): Promise<import('./backup').ImportReport> {
  const { manager, lifecycle: lc, paths } = ensureServices()
  const data = readBackup(paths.backupsDir, id)
  if (!data) throw new Error('备份不存在或已损坏')
  return applyExportBundle(data, { manager, lifecycle: lc }, { scopes: scope ? [scope] : undefined })
}

export function removeBackup(id: string): void {
  deleteBackup(ensureServices().paths.backupsDir, id)
}

export function getSkillsState(): {
  skillsDir: string
  reposDir: string
  globalDir: string
  projectDir: string
  backupsDir: string
  agentsHome: string
  defaultRepository: string
  repositoryCount: number
  installedCount: number
} {
  const { manager, lifecycle: lc, paths } = ensureServices()
  return {
    skillsDir: paths.skillsDir,
    reposDir: paths.reposDir,
    globalDir: paths.globalDir,
    projectDir: paths.projectDir,
    backupsDir: paths.backupsDir,
    agentsHome: paths.agentsHome,
    defaultRepository: 'https://github.com/mattpocock/skills',
    repositoryCount: manager.list().length,
    installedCount: lc.listInstalled().length,
  }
}

function appVersion(): string {
  try {
    const pkg = require('../../../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
