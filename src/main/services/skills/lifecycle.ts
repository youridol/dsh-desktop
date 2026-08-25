/**
 * Skills 安装生命周期与作用域隔离（global / project）。
 *
 * 每个作用域拥有独立的安装目录与 `index.json` 清单：
 *   global  -> <runtime>/skills/global
 *   project -> <runtime>/skills/project（可用 config.skills.projectDir 覆盖）
 * 安装 = 把仓库中发现的技能目录复制到作用域目录并登记清单；
 * 启用/停用只改清单，不删除文件；卸载/删除移除文件与登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { rmRobust } from '../../plugins'
import {
  skillKey,
  skillLeafName,
  sanitizeSkillPath,
  isValidSkillScope,
  type SkillScope,
} from './validation'
import type { DiscoveredSkill } from './discovery'
import type { SkillsRepositoryRecord } from './repositoryManager'

export interface InstalledSkill {
  /** 全局唯一键：repoId:path。 */
  key: string
  /** 安装目录叶名（repoId + path 派生）。 */
  id: string
  name: string
  description: string | null
  /** 来源仓库 id。 */
  repoId: string
  /** 来源仓库 URL。 */
  repoUrl: string
  /** 技能在仓库内的相对路径。 */
  path: string
  scope: SkillScope
  /** 安装时来源 commit（同步后刷新为最新）。 */
  commit: string | null
  installedAt: number
  updatedAt: number
  enabled: boolean
  /** 安装目录内的相对文件列表。 */
  files: string[]
  /** 最近一次错误（可选）。 */
  error?: string
}

export interface ScopeManifest {
  version: 1
  skills: InstalledSkill[]
}

export interface SkillLifecycleOptions {
  globalDir: string
  projectDir: string
  reposDir: string
  now?: () => number
}

export class SkillsLifecycle {
  private readonly globalDir: string
  private readonly projectDir: string
  private readonly reposDir: string
  private readonly now: () => number

  constructor(options: SkillLifecycleOptions) {
    this.globalDir = options.globalDir
    this.projectDir = options.projectDir
    this.reposDir = options.reposDir
    this.now = options.now ?? Date.now
  }

  scopeDir(scope: SkillScope): string {
    return scope === 'global' ? this.globalDir : this.projectDir
  }

  manifestPath(scope: SkillScope): string {
    return path.join(this.scopeDir(scope), 'index.json')
  }

  installedDir(scope: SkillScope, id: string): string {
    return path.join(this.scopeDir(scope), id)
  }

  readScope(scope: SkillScope): ScopeManifest {
    const file = this.manifestPath(scope)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ScopeManifest>
      const skills = Array.isArray(raw.skills) ? raw.skills.filter((s): s is InstalledSkill => !!s && typeof s.key === 'string') : []
      return { version: 1, skills }
    } catch {
      return { version: 1, skills: [] }
    }
  }

  writeScope(scope: SkillScope, manifest: ScopeManifest): void {
    fs.mkdirSync(this.scopeDir(scope), { recursive: true })
    const data: ScopeManifest = { version: 1, skills: manifest.skills }
    const tmp = path.join(this.scopeDir(scope), `.index.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(data, undefined, 2) + '\n', 'utf8')
    fs.renameSync(tmp, this.manifestPath(scope))
  }

  listInstalled(scope?: SkillScope): InstalledSkill[] {
    const scopes = scope ? [scope] : (['global', 'project'] as const)
    const out: InstalledSkill[] = []
    for (const s of scopes) {
      out.push(...this.readScope(s).skills.map((x) => ({ ...x, scope: s })))
    }
    return out
  }

  getSkill(scope: SkillScope, key: string): InstalledSkill | null {
    const found = this.readScope(scope).skills.find((s) => s.key === key)
    return found ? { ...found, scope } : null
  }

  private repoDirOf(repoId: string): string {
    return path.join(this.reposDir, repoId)
  }

  getSkillFiles(sourceRepoDir: string, skill: DiscoveredSkill): Array<{ rel: string; abs: string }> {
    const files: Array<{ rel: string; abs: string }> = []
    const prefix = skill.path.replace(/\/+$/, '') + '/'
    for (const rel of skill.files) {
      const clean = sanitizeSkillPath(rel)
      if (!clean) continue
      // 安装副本内文件路径 = 仓库相对路径去掉技能目录前缀（如 SKILL.md、agents/openai.yaml）
      const skillRel = clean.startsWith(prefix) ? clean.slice(prefix.length) : clean
      const relSafe = sanitizeSkillPath(skillRel)
      if (!relSafe) continue
      const abs = path.join(sourceRepoDir, ...clean.split('/'))
      // 防目录穿越：最终绝对路径必须落在仓库目录下
      const base = path.resolve(sourceRepoDir) + path.sep
      const target = path.resolve(abs)
      if (!target.startsWith(base)) continue
      let st: fs.Stats | null = null
      try {
        st = fs.lstatSync(target)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      files.push({ rel: relSafe, abs: target })
    }
    return files
  }

  /**
   * 安装 / 更新技能：把仓库内技能副本复制到作用域目录，并写清单。
   * overwrite=true 时允许覆盖同名目录；已存在同 key 时原地更新并保留 enabled/installedAt。
   */
  installSkill(
    scope: SkillScope,
    skill: DiscoveredSkill,
    repo: SkillsRepositoryRecord,
    options: { overwrite?: boolean } = {},
  ): InstalledSkill {
    if (!isValidSkillScope(scope)) throw new Error('无效的作用域')
    const safePath = sanitizeSkillPath(skill.path)
    if (!safePath || safePath !== skill.path.trim().replace(/^\/+|\/+$/g, '')) {
      throw new Error('技能路径不合法')
    }
    const key = skillKey(repo.id, safePath)
    const id = skillLeafName(repo.id, safePath)
    const manifest = this.readScope(scope)
    const existing = manifest.skills.find((s) => s.key === key)
    const dirConflict = manifest.skills.find((s) => s.id === id && s.key !== key)
    if (dirConflict && !options.overwrite) {
      throw new Error(
        `目录冲突：技能 ${dirConflict.name}（${dirConflict.repoId}:${dirConflict.path}）已占用目录 ${id}，勾选“覆盖”后可替换`,
      )
    }

    const sourceDir = this.repoDirOf(repo.id)
    const destDir = this.installedDir(scope, id)
    if (!fs.existsSync(path.join(sourceDir, ...safePath.split('/')))) {
      throw new Error('来源仓库中找不到该技能目录，请先同步仓库')
    }
    if (dirConflict && options.overwrite) rmRobust(destDir)
    fs.mkdirSync(destDir, { recursive: true })

    const copied: string[] = []
    const files = this.getSkillFiles(sourceDir, skill)
    if (files.length === 0) throw new Error('技能目录中没有可复制文件')
    for (const f of files) {
      const dest = path.join(destDir, ...f.rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(f.abs, dest)
      copied.push(f.rel)
    }

    const now = this.now()
    const installed: InstalledSkill = {
      key,
      id,
      name: skill.name,
      description: skill.description,
      repoId: repo.id,
      repoUrl: repo.url,
      path: safePath,
      scope,
      commit: repo.lastCommit,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      enabled: existing?.enabled ?? true,
      files: copied,
    }

    manifest.skills = manifest.skills.filter((s) => s.key !== key)
    if (dirConflict && options.overwrite) {
      manifest.skills = manifest.skills.filter((s) => s.id !== id)
    }
    manifest.skills.push(installed)
    this.writeScope(scope, manifest)
    return installed
  }

  /** 卸载：删除安装副本并移除清单登记。deleteRecord 为 true 时行为相同（兼容“删除”入口）。 */
  uninstallSkill(scope: SkillScope, key: string): void {
    const manifest = this.readScope(scope)
    const idx = manifest.skills.findIndex((s) => s.key === key)
    if (idx < 0) throw new Error('技能未安装')
    const skill = manifest.skills[idx]
    try {
      rmRobust(this.installedDir(scope, skill.id))
    } finally {
      manifest.skills.splice(idx, 1)
      this.writeScope(scope, manifest)
    }
  }

  /** 删除：与卸载一致（移除文件与登记），保留为独立入口供批量/单独删除使用。 */
  deleteSkill(scope: SkillScope, key: string): void {
    this.uninstallSkill(scope, key)
  }

  setEnabled(scope: SkillScope, key: string, enabled: boolean): InstalledSkill {
    const manifest = this.readScope(scope)
    const idx = manifest.skills.findIndex((s) => s.key === key)
    if (idx < 0) throw new Error('技能未安装')
    manifest.skills[idx].enabled = enabled
    manifest.skills[idx].updatedAt = this.now()
    this.writeScope(scope, manifest)
    return { ...manifest.skills[idx], scope }
  }

  /** 从任意来源安装文件 payload（备份/导入恢复用，不再依赖仓库缓存）。 */
  restoreFromPayload(
    scope: SkillScope,
    entry: Omit<InstalledSkill, 'scope' | 'installedAt' | 'updatedAt' | 'files'> & { files: Record<string, string> },
    options: { overwrite?: boolean; installedAt?: number; updatedAt?: number } = {},
  ): InstalledSkill {
    const id = skillLeafName(entry.repoId, entry.path)
    const key = skillKey(entry.repoId, entry.path)
    const manifest = this.readScope(scope)
    const existing = manifest.skills.find((s) => s.key === key)
    const dirConflict = manifest.skills.find((s) => s.id === id && s.key !== key)
    if (dirConflict && !options.overwrite) {
      throw new Error(`目录冲突：技能 ${dirConflict.name} 已占用目录 ${id}，导入时可选择覆盖`)
    }
    const destDir = this.installedDir(scope, id)
    if (dirConflict && options.overwrite) rmRobust(destDir)
    fs.mkdirSync(destDir, { recursive: true })

    const copied: string[] = []
    for (const [rel, content] of Object.entries(entry.files)) {
      const clean = sanitizeSkillPath(rel)
      if (!clean) continue
      const dest = path.join(destDir, ...clean.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content, 'utf8')
      copied.push(clean)
    }
    if (copied.length === 0) throw new Error('备份内容中没有可恢复的文件')

    const now = this.now()
    const installed: InstalledSkill = {
      key,
      id,
      name: entry.name,
      description: entry.description,
      repoId: entry.repoId,
      repoUrl: entry.repoUrl,
      path: entry.path,
      scope,
      commit: entry.commit,
      installedAt: options.installedAt ?? existing?.installedAt ?? now,
      updatedAt: options.updatedAt ?? now,
      enabled: entry.enabled,
      files: copied,
    }
    manifest.skills = manifest.skills.filter((s) => s.key !== key)
    if (dirConflict && options.overwrite) manifest.skills = manifest.skills.filter((s) => s.id !== id)
    manifest.skills.push(installed)
    this.writeScope(scope, manifest)
    return installed
  }
}
