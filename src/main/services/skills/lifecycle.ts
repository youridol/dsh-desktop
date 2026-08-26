/**
 * Skills 安装生命周期与作用域隔离（global / project）。
 *
 * 每个作用域拥有安装目录（global = <agentsHome>/skills，deepseek-harness user-agents 全局根；
 * project = <runtime>/skills/project，可用 config.skills.projectDir 覆盖）与独立 `index.json` 清单。
 * 安装 = 把仓库中发现的技能目录复制到作用域目录并登记清单；
 * 启用/停用改清单；global 作用域额外写 deepseek-harness 前导调用策略（disable-model-invocation /
 * user-invocable），使启停对上游 harness 真实生效；卸载/删除移除文件与登记。
 * 两个作用域都会把目录中已有的本机 Agent 技能（目录束 / 扁平 md）合并进列表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { rmRobust } from '../../plugins'
import {
  skillKey,
  skillLeafName,
  sanitizeSkillPath,
  isValidSkillScope,
  AGENTS_SOURCE_ID,
  agentSkillKey,
  isAgentSkillName,
  kebabSlug,
  type SkillScope,
} from './validation'
import { discoverAgentSkills, ensureAgentSkillFrontmatter, patchSkillFrontmatter, type DiscoveredSkill } from './discovery'
import type { SkillsRepositoryRecord } from './repositoryManager'

export interface InstalledSkill {
  /** 全局唯一键：repoId:path（仓库来源）或 agents:<name>（本机 agent 技能）。 */
  key: string
  /** 安装目录叶名（global 为 kebab 技能名，project 为 repoId + path 派生）。 */
  id: string
  name: string
  description: string | null
  /** 来源仓库 id；本机 agent 技能为 AGENTS_SOURCE_ID（agents）。 */
  repoId: string
  /** 来源仓库 URL；本机 agent 技能为空串。 */
  repoUrl: string
  /** 技能在仓库内的相对路径（本机 agent 技能为根目录相对路径，如 <name> 或 <name>.md）。 */
  path: string
  scope: SkillScope
  /** 安装时来源 commit（同步后刷新为最新；本机 agent 技能为 null）。 */
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

/** 根据 frontmatter 调用策略推导 agent 技能默认启用状态（与 deepseek-harness 一致）。 */
function policyEnabled(metadata: DiscoveredSkill['metadata']): boolean {
  return !(metadata.disableModelInvocation === true) && metadata.userInvocable !== false
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

  /**
   * 列出已安装技能。每个作用域 = 清单 + 磁盘 Agent 发现合并（deepseek-harness 已有技能可见）。
   */
  listInstalled(scope?: SkillScope): InstalledSkill[] {
    const scopes = scope ? [scope] : (['global', 'project'] as const)
    const out: InstalledSkill[] = []
    for (const s of scopes) {
      out.push(...this.listScope(s))
    }
    return out
  }

  getSkill(scope: SkillScope, key: string): InstalledSkill | null {
    return this.listScope(scope).find((s) => s.key === key) ?? null
  }

  private repoDirOf(repoId: string): string {
    return path.join(this.reposDir, repoId)
  }

  private dirIdFor(scope: SkillScope, repoId: string, safePath: string, name: string): string {
    if (scope === 'global') {
      const leaf = safePath.split('/').filter(Boolean).pop() ?? ''
      const candidate = isAgentSkillName(name) ? name : leaf || name
      return kebabSlug(candidate)
    }
    return skillLeafName(repoId, safePath)
  }

  /** 复用备份中的单段安全 id（历史备份/新备份均按原目录恢复）。 */
  private safeId(input: string | undefined): string | null {
    if (!input) return null
    const clean = sanitizeSkillPath(input)
    if (!clean || clean.includes('/') || clean === '.' || clean === '..') return null
    return clean
  }

  /**
   * 作用域清单与磁盘合并：已登记且目录仍在的条目保留；目录仍存在但未登记的条目按 agent 技能补入。
   * 目录/文件同名时清单条目代表该目录，避免同一技能被计两次。
   */
  private listScope(scope: SkillScope): InstalledSkill[] {
    const manifest = this.readScope(scope).skills.map((x) => ({ ...x, scope }))
    const disk = discoverAgentSkills(this.scopeDir(scope))
    const diskById = new Map(disk.map((d) => [d.path, d]))
    const out: InstalledSkill[] = []
    for (const m of manifest) {
      if (!fs.existsSync(this.installedDir(scope, m.id))) continue
      out.push(m)
      diskById.delete(m.id)
    }
    for (const d of diskById.values()) {
      const id = d.path
      out.push({
        key: agentSkillKey(id),
        id,
        name: d.name,
        description: d.description,
        repoId: AGENTS_SOURCE_ID,
        repoUrl: '',
        path: id,
        scope,
        commit: null,
        installedAt: 0,
        updatedAt: 0,
        enabled: policyEnabled(d.metadata),
        files: d.files,
      })
    }
    return out
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
   * global 作用域使用 kebab 目录名并对 SKILL.md 前导做 harness 规范化。
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
    const id = this.dirIdFor(scope, repo.id, safePath, skill.name)
    const manifest = this.readScope(scope)
    const existing = manifest.skills.find((s) => s.key === key)
    const dirConflict = manifest.skills.find((s) => s.id === id && s.key !== key)
    const destDir = this.installedDir(scope, id)
    // global 目录可能已被 deepseek-harness 或其他工具占用：非覆盖安装时拒绝
    const diskOccupied = scope === 'global' && fs.existsSync(destDir) && !existing
    if (!options.overwrite && (dirConflict || diskOccupied)) {
      const owner = dirConflict ? `${dirConflict.repoId}:${dirConflict.path}` : `磁盘目录 ${id}`
      throw new Error(`目录冲突：${owner} 已占用目录 ${id}，勾选“覆盖”后可替换`)
    }

    const sourceDir = this.repoDirOf(repo.id)
    if (!fs.existsSync(path.join(sourceDir, ...safePath.split('/')))) {
      throw new Error('来源仓库中找不到该技能目录，请先同步仓库')
    }
    if ((dirConflict || diskOccupied) && options.overwrite) rmRobust(destDir)
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

    // global 安装：把 SKILL.md 前导规范化为 kebab 名 + description，使 deepseek-harness 可识别
    if (scope === 'global') {
      const skillMd = copied.find((f) => f.toUpperCase() === 'SKILL.MD')
      if (skillMd) {
        const abs = path.join(destDir, ...skillMd.split('/'))
        const current = fs.readFileSync(abs, 'utf8')
        fs.writeFileSync(abs, ensureAgentSkillFrontmatter(current, id, skill.description ?? skill.name), 'utf8')
      }
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
    if ((dirConflict || diskOccupied) && options.overwrite) {
      manifest.skills = manifest.skills.filter((s) => s.id !== id)
    }
    manifest.skills.push(installed)
    this.writeScope(scope, manifest)
    return installed
  }

  /**
   * 卸载：删除安装副本并移除清单登记。global 下也支持删除纯磁盘（未登记）的 agent 技能。
   */
  uninstallSkill(scope: SkillScope, key: string): void {
    const manifest = this.readScope(scope)
    let skill: InstalledSkill | undefined
    const idx = manifest.skills.findIndex((s) => s.key === key)
    if (idx >= 0) skill = manifest.skills[idx]
    else skill = this.listScope(scope).find((s) => s.key === key)
    if (!skill) throw new Error('技能未安装')
    if (idx >= 0) {
      try {
        rmRobust(this.installedDir(scope, skill.id))
      } finally {
        manifest.skills.splice(idx, 1)
        this.writeScope(scope, manifest)
      }
    } else {
      rmRobust(this.installedDir(scope, skill.id))
    }
  }

  /** 删除：与卸载一致（移除文件与登记），保留为独立入口供批量/单独删除使用。 */
  deleteSkill(scope: SkillScope, key: string): void {
    this.uninstallSkill(scope, key)
  }

  /**
   * 启用/停用。global 作用域同时写 deepseek-harness 前导调用策略，使上游真实生效；
   * 首次切换时把磁盘 agent 技能补进清单。
   */
  setEnabled(scope: SkillScope, key: string, enabled: boolean): InstalledSkill {
    const current = this.listScope(scope).find((s) => s.key === key)
    if (!current) throw new Error('技能未安装')
    const record: InstalledSkill = { ...current, enabled, updatedAt: this.now() }
    const manifest = this.readScope(scope)
    const idx = manifest.skills.findIndex((s) => s.key === key)
    if (idx >= 0) manifest.skills[idx] = record
    else manifest.skills.push(record)
    this.writeScope(scope, manifest)
    // global 沿用现有策略写入；project 仅对本地 agent 技能写策略，仓库安装的技能保持原行为。
    if (scope === 'global' || current.repoId === AGENTS_SOURCE_ID) {
      this.writeInvocationPolicy(record, enabled)
    }
    return record
  }

  /**
   * 把启用/停用写入 SKILL.md 前导（目录束）或扁平 <name>.md 文件：
   * 停用 -> disable-model-invocation: true + user-invocable: false；启用 -> 移除这两个键。
   */
  private writeInvocationPolicy(skill: InstalledSkill, enabled: boolean): void {
    const flat = skill.repoId === AGENTS_SOURCE_ID && skill.path.endsWith('.md')
    let skillFile: string | null = null
    if (flat) {
      skillFile = path.join(this.scopeDir(skill.scope), ...skill.path.split('/'))
    } else {
      const dir = this.installedDir(skill.scope, skill.id)
      skillFile = ['SKILL.md', 'SKILL.MD', 'skill.md']
        .map((n) => path.join(dir, n))
        .find((p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        }) ?? null
    }
    if (!skillFile || !fs.existsSync(skillFile)) return
    const content = fs.readFileSync(skillFile, 'utf8')
    fs.writeFileSync(skillFile, patchSkillFrontmatter(content, { setInvocation: enabled ? 'enabled' : 'disabled' }), 'utf8')
  }

  /** 从任意来源安装文件 payload（备份/导入恢复用，不再依赖仓库缓存）。 */
  restoreFromPayload(
    scope: SkillScope,
    entry: Omit<InstalledSkill, 'scope' | 'installedAt' | 'updatedAt' | 'files'> & { files: Record<string, string> },
    options: { overwrite?: boolean; installedAt?: number; updatedAt?: number } = {},
  ): InstalledSkill {
    const id = this.safeId(entry.id) ?? this.dirIdFor(scope, entry.repoId, entry.path, entry.name)
    const key = skillKey(entry.repoId, entry.path)
    const flat = id.endsWith('.md') || entry.path.endsWith('.md')
    const manifest = this.readScope(scope)
    const existing = manifest.skills.find((s) => s.key === key)
    const dirConflict = manifest.skills.find((s) => s.id === id && s.key !== key)
    const location = flat ? this.scopeDir(scope) : this.installedDir(scope, id)
    const dirOccupied = !flat && scope === 'global' && fs.existsSync(location) && !existing
    if (!options.overwrite && (dirConflict || dirOccupied)) {
      throw new Error(`目录冲突：技能 ${dirConflict?.name ?? id} 已占用目录 ${id}，导入时可选择覆盖`)
    }
    if (!flat && (dirConflict || dirOccupied) && options.overwrite) rmRobust(location)
    if (!flat) fs.mkdirSync(location, { recursive: true })

    const copied: string[] = []
    for (const [rel, content] of Object.entries(entry.files)) {
      const clean = sanitizeSkillPath(rel)
      if (!clean) continue
      const dest = flat ? path.join(this.globalDir, ...clean.split('/')) : path.join(location, ...clean.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content, 'utf8')
      copied.push(clean)
    }
    if (copied.length === 0) throw new Error('备份内容中没有可恢复的文件')

    // global 目录束：恢复时同样规范化 SKILL.md 前导
    if (scope === 'global' && !flat) {
      const skillMd = copied.find((f) => f.toUpperCase() === 'SKILL.MD')
      if (skillMd) {
        const abs = path.join(location, ...skillMd.split('/'))
        if (fs.existsSync(abs)) {
          const current = fs.readFileSync(abs, 'utf8')
          fs.writeFileSync(abs, ensureAgentSkillFrontmatter(current, id, entry.description ?? entry.name), 'utf8')
        }
      }
    }

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
