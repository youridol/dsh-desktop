/**
 * Skills 仓库注册表与仓库生命周期（克隆 / 拉取 / 刷新 / 同步）。
 *
 * 数据模型独立于 dsh harness：仓库列表保存在 dsh-desktop 运行目录
 * `skills/repositories.json`，克隆缓存位于 `skills/repos/<id>`。
 * 不修改 deepseek-harness 源码，也不写入其 profile 数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { GitRunner } from './gitRunner'
import { rmRobust } from '../../plugins'
import { discoverSkills } from './discovery'
import { validateRepositoryName, validateRepositoryUrl, slugify, shortHash } from './validation'

export interface SkillsRepositoryRecord {
  /** 稳定 id（由 URL 派生，冲突时追加短 hash）。 */
  id: string
  /** 展示名称（默认取仓库名）。 */
  name: string
  /** 仓库 http(s) URL。 */
  url: string
  /** 已解析的默认分支（同步后填充）。 */
  branch: string | null
  /** 是否启用（启用状态下“全部同步”会拉取该仓库）。 */
  enabled: boolean
  addedAt: number
  lastSyncAt: number | null
  lastCommit: string | null
  lastSyncError: string | null
  /** 最近一次同步发现的技能数量。 */
  skillsCount: number | null
}

interface RepositoryStoreFile {
  version: 1
  repositories: SkillsRepositoryRecord[]
}

export interface AddRepositoryInput {
  url: string
  name?: string
}

export type RepositoryPatch = Partial<Pick<SkillsRepositoryRecord, 'name' | 'url' | 'branch' | 'enabled'>>

/** 读取仓库注册表（文件缺失 / 损坏时返回空列表）。 */
export function loadRepositories(configFile: string): SkillsRepositoryRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Partial<RepositoryStoreFile>
    if (!Array.isArray(raw.repositories)) return []
    return raw.repositories.filter(
      (r): r is SkillsRepositoryRecord =>
        !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.url === 'string',
    )
  } catch {
    return []
  }
}

/** 原子写入仓库注册表。 */
export function saveRepositories(configFile: string, repositories: SkillsRepositoryRecord[]): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const data: RepositoryStoreFile = { version: 1, repositories }
  const tmp = path.join(path.dirname(configFile), `.repositories.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, undefined, 2) + '\n', 'utf8')
  fs.renameSync(tmp, configFile)
}

/** 从 URL 派生仓库 id（host 路径 slug，冲突追加短 hash）。 */
export function repoIdFromUrl(url: string, existingIds: string[]): string {
  let host = ''
  let pathname = ''
  try {
    const u = new URL(url)
    host = u.hostname.replace(/^www\./, '')
    pathname = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  } catch {
    /* fall through */
  }
  const base = slugify(`${host}-${pathname}`, 64) || `repo-${shortHash(url)}`
  const ids = new Set(existingIds)
  if (!ids.has(base)) return base
  return slugify(`${base}-${shortHash(url)}`, 72)
}


export class SkillsRepositoryManager {
  private repositories: SkillsRepositoryRecord[]
  private readonly configFile: string
  private readonly reposDir: string
  private readonly git: GitRunner
  private readonly now: () => number

  constructor(options: { configFile: string; reposDir: string; git?: GitRunner; now?: () => number }) {
    this.configFile = options.configFile
    this.reposDir = options.reposDir
    this.git = options.git ?? new GitRunner()
    this.now = options.now ?? Date.now
    this.repositories = loadRepositories(options.configFile)
  }

  list(): SkillsRepositoryRecord[] {
    return this.repositories.map((r) => ({ ...r }))
  }

  get(id: string): SkillsRepositoryRecord | null {
    const r = this.repositories.find((x) => x.id === id)
    return r ? { ...r } : null
  }

  resolveRepoDir(id: string): string {
    return path.join(this.reposDir, id)
  }

  private persist(): void {
    saveRepositories(this.configFile, this.repositories)
  }

  private ensureIdUnique(base: string): string {
    const ids = new Set(this.repositories.map((r) => r.id))
    if (!ids.has(base)) return base
    return slugify(`${base}-${shortHash(base + Date.now().toString())}`, 72)
  }

  /**
   * 添加仓库并立即同步（网络失败会保留记录并回填 lastSyncError）。
   * 返回 existed=true 表示该 URL 已存在。
   */
  async add(input: AddRepositoryInput): Promise<{ repo: SkillsRepositoryRecord; existed: boolean }> {
    const urlError = validateRepositoryUrl(input.url)
    if (urlError) throw new Error(urlError)
    const url = input.url.trim()
    const exists = this.repositories.find((r) => r.url === url)
    if (exists) return { repo: { ...exists }, existed: true }

    const fallback = url.split('/').filter(Boolean).pop()?.replace(/\.git$/i, '') || 'skills-repo'
    const name = input.name?.trim() || fallback
    const nameError = validateRepositoryName(name)
    if (nameError) throw new Error(nameError)

    const id = this.ensureIdUnique(repoIdFromUrl(url, this.repositories.map((r) => r.id)))
    const record: SkillsRepositoryRecord = {
      id,
      name,
      url,
      branch: null,
      enabled: true,
      addedAt: this.now(),
      lastSyncAt: null,
      lastCommit: null,
      lastSyncError: null,
      skillsCount: null,
    }
    this.repositories.push(record)
    this.persist()

    try {
      const synced = await this.sync(id)
      return { repo: synced, existed: false }
    } catch (err) {
      const fresh = this.get(id)
      return { repo: fresh ?? record, existed: false }
    }
  }

  /** 更新仓库（名称 / URL / 启用状态 / 分支）。URL 变更后重新同步。 */
  update(id: string, patch: RepositoryPatch): SkillsRepositoryRecord {
    const idx = this.repositories.findIndex((r) => r.id === id)
    if (idx < 0) throw new Error('仓库不存在')
    const current = this.repositories[idx]
    if (patch.name !== undefined) {
      const nameError = validateRepositoryName(patch.name)
      if (nameError) throw new Error(nameError)
      current.name = patch.name.trim()
    }
    if (patch.url !== undefined && patch.url !== current.url) {
      const urlError = validateRepositoryUrl(patch.url)
      if (urlError) throw new Error(urlError)
      current.url = patch.url.trim()
      current.lastSyncError = 'URL 已变更，请重新同步'
      // 旧克隆的 origin 仍指向旧地址，删除缓存让下次同步重新克隆
      rmRobust(this.resolveRepoDir(id))
    }
    if (patch.branch !== undefined) current.branch = patch.branch
    if (patch.enabled !== undefined) current.enabled = patch.enabled
    this.persist()
    return { ...current }
  }

  setEnabled(id: string, enabled: boolean): SkillsRepositoryRecord {
    return this.update(id, { enabled })
  }

  /** 更新 git 凭据（转发给内部 GitRunner；测试注入的 fake 无 setAuth 时忽略）。 */
  setAuth(auth: { user: string; token: string } | null): void {
    const runner = this.git as { setAuth?: (a: { user: string; token: string } | null) => void }
    runner.setAuth?.(auth)
  }

  remove(id: string): void {
    const idx = this.repositories.findIndex((r) => r.id === id)
    if (idx < 0) throw new Error('仓库不存在')
    this.repositories.splice(idx, 1)
    this.persist()
    // 删除克隆缓存（已安装技能不受影响，安装副本在作用域目录中）。
    rmRobust(this.resolveRepoDir(id))
  }

  /**
   * 同步仓库：克隆（首次）或 fetch + reset（已有缓存），刷新默认分支与 commit，
   * 并重新扫描技能数量。失败时回填 lastSyncError 并抛出。
   */
  async sync(id: string): Promise<SkillsRepositoryRecord> {
    const idx = this.repositories.findIndex((r) => r.id === id)
    if (idx < 0) throw new Error('仓库不存在')
    const record = this.repositories[idx]
    const dir = this.resolveRepoDir(id)
    try {
      let branch = record.branch
      const remote = await this.git.lsRemoteHead(record.url)
      if (remote?.branch) branch = remote.branch
      const cloned = fs.existsSync(path.join(dir, '.git'))
      if (!cloned) {
        await this.git.clone(record.url, dir, branch)
      } else {
        await this.git.fetchAndReset(dir, branch)
      }
      const commit = await this.git.headSha(dir)
      const count = discoverSkills(dir).length
      record.branch = branch
      record.lastCommit = commit
      record.lastSyncAt = this.now()
      record.skillsCount = count
      record.lastSyncError = null
      this.persist()
      return { ...record }
    } catch (err) {
      record.lastSyncError = err instanceof Error ? err.message : String(err)
      // 浅克隆失败后清理残留，避免下次复用损坏目录
      if (fs.existsSync(dir)) rmRobust(dir)
      this.persist()
      throw err
    }
  }

  /** 同步所有启用的仓库（逐个容错，返回成功与失败明细）。 */
  async syncAll(): Promise<{ synced: number; failed: Array<{ id: string; error: string }> }> {
    const failed: Array<{ id: string; error: string }> = []
    let synced = 0
    for (const r of this.repositories) {
      if (!r.enabled) continue
      try {
        await this.sync(r.id)
        synced += 1
      } catch (err) {
        failed.push({ id: r.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { synced, failed }
  }
}

