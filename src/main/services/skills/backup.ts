/**
 * Skills 备份 / 导出 / 导入 / 恢复。
 *
 * 导出格式为独立 JSON 束（kind = dsh-desktop.skills-backup），包含仓库注册表、
 * 已安装技能清单与（可选）技能文件 payload。导入时进行格式、版本、路径与冲突校验。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  isValidSkillScope,
  isValidScopeFilter,
  isValidPayloadRelativePath,
  type SkillScope,
  type ScopeFilter,
} from './validation'
import type { InstalledSkill } from './lifecycle'
import type { SkillsRepositoryRecord, SkillsRepositoryManager } from './repositoryManager'
import type { SkillsLifecycle } from './lifecycle'
import { discoverSkills } from './discovery'

export interface ExportFileResolver {
  /** 读取任意绝对路径文件（返回 null 表示不可读）。 */
  readFile: (abs: string) => string | null
  /** 已安装技能文件在磁盘上的绝对路径。 */
  installedFileAbs: (scope: SkillScope, id: string, rel: string) => string
}

export interface SkillsExportBundle {
  kind: 'dsh-desktop.skills-backup'
  formatVersion: 1
  exportedAt: number
  appVersion: string
  scope: ScopeFilter
  repositories: SkillsRepositoryRecord[]
  /** 已安装技能清单（不含文件内容，文件在 payload 中）。 */
  skills: InstalledSkill[]
  /** scope -> key -> 相对路径 -> 文件内容。 */
  payload?: Record<SkillScope, Record<string, Record<string, string>>>
}

export interface ImportConflict {
  key: string
  reason: string
}

export interface ImportReport {
  importedRepositories: number
  existingRepositories: number
  importedSkills: number
  conflicts: ImportConflict[]
  skipped: number
}

export interface ApplyImportOptions {
  overwrite?: boolean
  /** 仅导入指定作用域（默认全部）。 */
  scopes?: SkillScope[]
}

export interface ApplyImportContext {
  manager: SkillsRepositoryManager
  lifecycle: SkillsLifecycle
}

/** 导出数据（可注入文件读取器便于测试）。 */
export function buildExport(
  scope: ScopeFilter,
  repositories: SkillsRepositoryRecord[],
  installed: InstalledSkill[],
  includePayload: boolean,
  appVersion: string,
  resolver?: ExportFileResolver
): SkillsExportBundle {
  const skills = installed.filter((s) => scope === 'all' || s.scope === scope)
  const payload: Record<SkillScope, Record<string, Record<string, string>>> = { global: {}, project: {} }
  if (includePayload) {
    for (const s of skills) {
      const files: Record<string, string> = {}
      const base = s.scope
      // files 是相对安装目录的路径；由生命周期提供 abs 读取
      for (const rel of s.files) {
        if (!isValidPayloadRelativePath(rel)) continue
        const abs = resolver ? resolver.installedFileAbs(s.scope, s.id, rel) : ""
        const content = resolver ? resolver.readFile(abs) : null
        if (resolver && content !== null) files[rel] = content
      }
      if (Object.keys(files).length > 0) payload[base][s.key] = files
    }
  }
  return {
    kind: 'dsh-desktop.skills-backup',
    formatVersion: 1,
    exportedAt: Date.now(),
    appVersion,
    scope,
    repositories: repositories.map((r) => ({ ...r })),
    skills: skills.map((s) => ({ ...s })),
    payload: includePayload && resolver ? payload : undefined,
  }
}


/** 校验导入数据格式与版本。返回错误信息或 null。 */
export function validateExportBundle(data: unknown): string | null {
  if (!data || typeof data !== 'object') return '导入文件不是有效的 JSON 对象'
  const bundle = data as Partial<SkillsExportBundle>
  if (bundle.kind !== 'dsh-desktop.skills-backup') return '不是 dsh-desktop Skills 备份文件'
  if (bundle.formatVersion !== 1) return `不支持的备份格式版本：${bundle.formatVersion}（当前支持 1）`
  if (!isValidScopeFilter(bundle.scope)) return '备份缺少有效的作用域信息'
  if (!Array.isArray(bundle.repositories)) return '备份缺少仓库列表'
  if (!Array.isArray(bundle.skills)) return '备份缺少已安装技能清单'
  if (bundle.payload !== undefined) {
    if (typeof bundle.payload !== 'object' || bundle.payload === null) return '备份 payload 格式错误'
    for (const scope of ['global', 'project'] as const) {
      const map = bundle.payload[scope]
      if (map === undefined) continue
      if (typeof map !== 'object' || map === null) return `备份 payload（${scope}）格式错误`
      for (const [key, files] of Object.entries(map)) {
        if (typeof files !== 'object' || files === null) return `备份 payload（${scope}:${key}）格式错误`
        for (const rel of Object.keys(files)) {
          if (!isValidPayloadRelativePath(rel)) return `备份 payload 含非法路径：${rel}`
        }
      }
    }
  }
  return null
}

/** 应用导入数据（仓库 + 技能），返回报告。 */
export async function applyExportBundle(
  data: SkillsExportBundle,
  context: ApplyImportContext,
  options: ApplyImportOptions = {},
): Promise<ImportReport> {
  const report: ImportReport = {
    importedRepositories: 0,
    existingRepositories: 0,
    importedSkills: 0,
    conflicts: [],
    skipped: 0,
  }
  const error0 = validateExportBundle(data)
  if (error0) throw new Error(error0)

  const targetScopes: SkillScope[] = options.scopes?.length
    ? options.scopes
    : (data.scope === 'all' ? ['global', 'project'] : [data.scope])

  for (const repo of data.repositories) {
    try {
      const { existed } = await context.manager.add({ url: repo.url, name: repo.name })
      if (existed) report.existingRepositories += 1
      else report.importedRepositories += 1
    } catch (err) {
      report.skipped += 1
      report.conflicts.push({ key: `repo:${repo.id}`, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  for (const skill of data.skills) {
    const scope: SkillScope | null = data.scope === 'all' ? (isValidSkillScope(skill.scope) ? skill.scope : null) : data.scope
    if (!scope || !targetScopes.includes(scope)) {
      report.skipped += 1
      continue
    }
    if (context.lifecycle.getSkill(scope, skill.key) && !options.overwrite) {
      report.conflicts.push({ key: skill.key, reason: '该技能已安装（导入未启用覆盖）' })
      continue
    }
    const payloadFiles = data.payload?.[scope]?.[skill.key]
    try {
      if (payloadFiles && Object.keys(payloadFiles).length > 0) {
        context.lifecycle.restoreFromPayload(scope, { ...skill, files: payloadFiles }, { overwrite: options.overwrite })
      } else {
        const repo = context.manager.get(skill.repoId)
        if (!repo) throw new Error('来源仓库未导入')
        const dir = context.manager.resolveRepoDir(skill.repoId)
        const discovered = discoverSkills(dir).find((s) => s.path === skill.path)
        if (!discovered) throw new Error('来源仓库中已不存在该技能，请先同步仓库')
        context.lifecycle.installSkill(scope, discovered, repo, { overwrite: options.overwrite })
      }
      report.importedSkills += 1
    } catch (err) {
      report.conflicts.push({
        key: skill.key,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return report
}

// ---- backups ---- //

export interface BackupEntry {
  id: string
  dir: string
  createdAt: number
  scope: ScopeFilter
  repoCount: number
  skillCount: number
  sizeBytes: number
}

export function writeBackup(backupsDir: string, data: SkillsExportBundle): BackupEntry {
  const id = `backup-${data.exportedAt}`
  const dir = path.join(backupsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'backup.json')
  const text = JSON.stringify(data, undefined, 2)
  fs.writeFileSync(file, text, 'utf8')
  return {
    id,
    dir,
    createdAt: data.exportedAt,
    scope: data.scope,
    repoCount: data.repositories.length,
    skillCount: data.skills.length,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
  }
}

export function listBackups(backupsDir: string): BackupEntry[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: BackupEntry[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('backup-')) continue
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(backupsDir, e.name, 'backup.json'), 'utf8'),
      ) as SkillsExportBundle
      out.push({
        id: e.name,
        dir: path.join(backupsDir, e.name),
        createdAt: data.exportedAt,
        scope: data.scope,
        repoCount: data.repositories.length,
        skillCount: data.skills.length,
        sizeBytes: fs.statSync(path.join(backupsDir, e.name, 'backup.json')).size,
      })
    } catch {
      /* skip corrupt backup */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

export function readBackup(backupsDir: string, id: string): SkillsExportBundle | null {
  const dir = path.join(backupsDir, id)
  if (!dir.startsWith(path.resolve(backupsDir) + path.sep)) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8')) as SkillsExportBundle
  } catch {
    return null
  }
}

export function deleteBackup(backupsDir: string, id: string): void {
  const dir = path.join(backupsDir, id)
  if (!dir.startsWith(path.resolve(backupsDir) + path.sep)) throw new Error('非法备份 id')
  fs.rmSync(dir, { recursive: true, force: true })
}

