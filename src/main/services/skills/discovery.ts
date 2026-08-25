/**
 * Skills 仓库扫描与解析（纯 Node fs，不依赖 Electron）。
 *
 * 约定（与主流 Skills 生态保持一致）：
 *  - Skill = 仓库中任意包含 `SKILL.md`（大小写不敏感）的目录；
 *  - 该目录内所有文件（含子目录）视为 Skill 的资源文件；
 *  - `SKILL.md` 头部 YAML frontmatter 中的 name / description / version 优先生效；
 *  - 未提供元数据时回退到目录名与正文首段。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeSkillPath, slugify } from './validation'

export interface SkillMetadata {
  name?: string
  description?: string
  version?: string
  source?: string
  license?: string
}

export interface DiscoveredSkill {
  /** slug 形式的技能标识（仓库内路径派生）。 */
  id: string
  /** 显示名称。 */
  name: string
  /** 一句话描述（无则 null）。 */
  description: string | null
  /** 仓库内相对路径（目录，如 skills/productivity/writing-for-agents）。 */
  path: string
  /** SKILL.md 在仓库内的相对路径。 */
  skillFile: string
  /** 该技能目录内的全部文件（仓库内相对路径）。 */
  files: string[]
  metadata: SkillMetadata
}

const SKILL_FILE_NAMES = ['SKILL.md', 'SKILL.MD', 'skill.md']
const MAX_DEPTH = 8

/** 解析 SKILL.md 的 YAML 风格 frontmatter（`---` 分隔，单行 key: value）。 */
export function parseSkillMetadata(content: string): SkillMetadata {
  const meta: SkillMetadata = {}
  const trimmed = content.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) return meta
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return meta
  const block = trimmed.slice(3, end)
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line === '---') continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (!value) continue
    if (key === 'name') meta.name = value
    else if (key === 'description') meta.description = value
    else if (key === 'version') meta.version = value
    else if (key === 'source') meta.source = value
    else if (key === 'license') meta.license = value
  }
  return meta
}

function prettyName(rel: string): string {
  const seg = rel.split('/').filter(Boolean).pop() ?? rel
  return seg
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim()
}

function extractBodyText(content: string): string | null {
  const noMeta = content.replace(/^\uFEFF/, '').replace(/^---[\s\S]*?\n---\s*\n?/, '')
  for (const line of noMeta.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const body = text.replace(/^#+\s*/, '').trim()
    if (!body) continue
    return body.length > 300 ? `${body.slice(0, 300)}…` : body
  }
  return null
}

/** 收集目录内全部文件（相对仓库根），跳过隐藏目录与依赖目录。 */
function collectFiles(rootDir: string, relDir: string, out: string[]): void {
  const abs = path.join(rootDir, relDir)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.venv') continue
      collectFiles(rootDir, rel, out)
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
}

function readSkillFile(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

/** 扫描仓库目录，返回全部发现的技能。 */
export function discoverSkills(repoDir: string): DiscoveredSkill[] {
  const result: DiscoveredSkill[] = []
  const seen = new Set<string>()

  const walk = (absDir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    const skillEntry = entries.find(
      (e) => e.isFile() && SKILL_FILE_NAMES.includes(e.name),
    )
    if (skillEntry) {
      const clean = sanitizeSkillPath(rel)
      if (!clean || seen.has(clean)) return
      seen.add(clean)
      const files: string[] = []
      collectFiles(repoDir, rel, files)
      const skillFile = `${clean}/${skillEntry.name}`
      const content = readSkillFile(path.join(absDir, skillEntry.name))
      const metadata = parseSkillMetadata(content)
      const name = metadata.name || prettyName(clean)
      const description = metadata.description ?? extractBodyText(content)
      result.push({
        id: slugify(clean),
        name,
        description,
        path: clean,
        skillFile,
        files: files.filter((f) => sanitizeSkillPath(f)),
        metadata,
      })
      // 技能目录不再向下递归（子目录属于该技能资源）。
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') && e.name !== '.') continue
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.venv') continue
      const next = rel ? `${rel}/${e.name}` : e.name
      walk(path.join(absDir, e.name), next, depth + 1)
    }
  }

  walk(repoDir, '', 0)
  return result
}
