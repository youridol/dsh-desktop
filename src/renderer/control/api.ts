/**
 * Shared types + typed access to the preload bridge (window.dshc).
 * Renderers are framework-free: each tab module exports render()/init().
 */

export type PluginInstallSource = 'npm' | 'npx' | 'dsh-profile'

export interface PluginView {
  id: string
  packageName: string
  version: string | null
  enabled: boolean
  isBundle: boolean
  description: string | null
  /** 安装来源：npm / npx / dsh Harness（旧数据回退 dsh-profile）。 */
  source: PluginInstallSource
  /** 安装到的 profile（旧数据回退 web）。 */
  profile: string
  /** 安装时间（旧数据为 null）。 */
  installedAt: number | null
  installDir: string | null
  error?: string
}

export interface PluginListResult {
  plugins: PluginView[]
  profileDir: string
}

export interface ExportInfo {
  packageName: string
  version: string | null
  description: string | null
}

export interface DshStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'timeout' | 'error'
  port: number
  serviceUrl: string
  pid: number | null
  startedAt: number | null
  version: string
  versionDir: string | null
  detail: string
  enabledPlugins: string[]
}

export interface ReleaseInfo {
  tag: string
  version: string
  publishedAt: string
  prerelease: boolean
  url: string
  notes: string
}

export interface CommitInfo {
  sha: string
  shortSha: string
  message: string
  date: string
  url: string
}

export interface InstalledVersion {
  version: string
  origin: 'bundled' | 'downloaded'
  active: boolean
}

export interface AppSettings {
  port: number
  autoStart: boolean
  checkUpdatesOnStart: boolean
}

// ---- skills ----

export type SkillScope = 'global' | 'project'
export type ScopeFilter = SkillScope | 'all'

export interface SkillRepositoryView {
  id: string
  name: string
  url: string
  branch: string | null
  enabled: boolean
  addedAt: number
  lastSyncAt: number | null
  lastCommit: string | null
  lastSyncError: string | null
  skillsCount: number | null
}

export interface DiscoveredSkill {
  id: string
  name: string
  description: string | null
  path: string
  skillFile: string
  files: string[]
}

export interface InstalledSkill {
  key: string
  id: string
  name: string
  description: string | null
  repoId: string
  repoUrl: string
  path: string
  scope: SkillScope
  commit: string | null
  installedAt: number
  updatedAt: number
  enabled: boolean
  files: string[]
  error?: string
}

export interface SkillBackupView {
  id: string
  dir: string
  createdAt: number
  scope: ScopeFilter
  repoCount: number
  skillCount: number
  sizeBytes: number
}

export interface SkillsState {
  skillsDir: string
  reposDir: string
  globalDir: string
  projectDir: string
  backupsDir: string
  agentsHome: string
  defaultRepository: string
  repositoryCount: number
  installedCount: number
}

export interface SkillImportReport {
  importedRepositories: number
  existingRepositories: number
  importedSkills: number
  conflicts: Array<{ key: string; reason: string }>
  skipped: number
}

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

export interface UpdateCheckResult {
  checkedAt: number
  updated: Array<{ key: string; current: string | null; latest: string }>
  upToDate: number
  errors: Array<{ repoId: string; error: string }>
}

export interface AppState {
  status: DshStatus
  config: AppSettings & { plugins: unknown[] }
  autoStart: boolean
  portable: boolean
  runtimeDir: string
  appVersion: string
  versions: InstalledVersion[]
  versionLabel: string
}

export interface LogLine {
  ts: number
  source: 'app' | 'dsh' | 'install'
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface Bridge {
  getState: () => Promise<AppState>
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>

  listPlugins: () => Promise<PluginListResult>
  addPlugin: (options: { name: string; source: PluginInstallSource; profile?: string }) => Promise<PluginView[]>
  removePlugin: (id: string) => Promise<PluginListResult>
  enablePlugin: (id: string) => Promise<PluginListResult>
  disablePlugin: (id: string) => Promise<PluginListResult>
  uninstallPlugin: (id: string) => Promise<PluginListResult>
  exportPlugin: (id: string) => Promise<ExportInfo | null>
  applyPlugins: () => Promise<DshStatus>

  listVersions: () => Promise<InstalledVersion[]>
  checkUpdates: (source?: 'release' | 'commit') => Promise<{
    current: string
    latest: ReleaseInfo | null
    hasUpdate: boolean
    releases: ReleaseInfo[]
    latestCommit: CommitInfo | null
    checkedAt: number
    rateLimited?: boolean
    rateLimitResetAt?: number
    offline?: boolean
  }>
  downloadVersion: (version: string) => Promise<void>
  switchVersion: (version: string) => Promise<void>
  deleteVersion: (version: string) => Promise<void>
  installCommit: (sha: string) => Promise<void>

  setSettings: (patch: Partial<AppSettings>) => Promise<{ config: AppSettings; autoStart: boolean; needsRestart: boolean }>
  applyRestart: () => Promise<void>
    // ---- skills ----
  listSkillRepos: () => Promise<SkillRepositoryView[]>
  addSkillRepo: (input: { url: string; name?: string }) => Promise<{ repo: SkillRepositoryView; existed: boolean }>
  updateSkillRepo: (id: string, patch: { name?: string; url?: string }) => Promise<SkillRepositoryView>
  setSkillRepoEnabled: (id: string, enabled: boolean) => Promise<SkillRepositoryView>
  removeSkillRepo: (id: string) => Promise<SkillRepositoryView[]>
  syncSkillRepo: (id: string) => Promise<SkillRepositoryView>
  syncAllSkillRepos: () => Promise<{ synced: number; failed: Array<{ id: string; error: string }> }>
  listAvailableSkills: (repoId: string) => Promise<{ repo: SkillRepositoryView; skills: DiscoveredSkill[] }>
  listInstalledSkills: (scope?: SkillScope) => Promise<InstalledSkill[]>
  installSkill: (opts: { repoId: string; path: string; scope: SkillScope; overwrite?: boolean }) => Promise<InstalledSkill>
  installAllFromRepo: (opts: { repoId: string; scope: SkillScope; overwrite?: boolean }) => Promise<{ installed: InstalledSkill[]; failed: Array<{ path: string; error: string }> }>
  uninstallSkill: (key: string, scope: SkillScope) => Promise<InstalledSkill[]>
  deleteSkill: (key: string, scope: SkillScope) => Promise<InstalledSkill[]>
  setSkillEnabled: (key: string, scope: SkillScope, enabled: boolean) => Promise<InstalledSkill>
  batchSkills: (keys: string[], scope: SkillScope, action: 'enable' | 'disable' | 'uninstall' | 'delete') => Promise<{ done: string[]; failed: Array<{ key: string; error: string }> }>
  checkSkillUpdates: (scope?: SkillScope) => Promise<UpdateCheckResult>
  updateSkills: (keys: string[], scope?: SkillScope) => Promise<{ updated: InstalledSkill[]; failed: Array<{ key: string; error: string }> }>
  searchSkills: (query: string) => Promise<GitHubSkillSearchResult[]>
  installSkillFromSearch: (opts: { fullName: string; scope: SkillScope }) => Promise<{ repository: SkillRepositoryView; installed: InstalledSkill[]; available: DiscoveredSkill[] }>
  exportSkills: (opts: { scope?: ScopeFilter; includePayload?: boolean }) => Promise<{ canceled: boolean; filePath?: string; count?: number }>
  importSkills: () => Promise<{ canceled: boolean; filePath?: string; report?: SkillImportReport }>
  createSkillBackup: (scope?: ScopeFilter) => Promise<SkillBackupView>
  listSkillBackups: () => Promise<SkillBackupView[]>
  restoreSkillBackup: (id: string, scope?: SkillScope) => Promise<SkillImportReport>
  deleteSkillBackup: (id: string) => Promise<SkillBackupView[]>
  getSkillsState: () => Promise<SkillsState>
getCredentials: () => Promise<{ githubUser: string; githubToken: string; hasToken: boolean }>
  saveCredentials: (user: string, token: string) => Promise<boolean>

  subscribeLogs: () => Promise<LogLine[]>
  clearLogs: () => Promise<void>

  closePanel: () => void
  on: (channel: string, cb: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    dshc?: Bridge
  }
}

export function bridge(): Bridge {
  if (!window.dshc) throw new Error('控制面板桥接不可用')
  return window.dshc
}

/* ---- tiny dom helpers ---- */

export function h(
  tag: string,
  attrs: Record<string, string | boolean | EventListener> = {},
  ...children: Array<Node | null | undefined>
): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener)
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, '') }
    else el.setAttribute(k, v)
  }
  for (const child of children) if (child) el.append(child)
  return el
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtBytes(n: number): string {
  if (n > 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n > 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}
