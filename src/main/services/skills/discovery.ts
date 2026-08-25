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
import {
  sanitizeSkillPath,
  slugify,
  isAgentSkillName,
} from './validation'

export interface SkillMetadata {
  name?: string
  description?: string
  version?: string
  source?: string
  license?: string
  whenToUse?: string
  /** 与 deepseek-harness 一致：disable-model-invocation: true 时模型目录不可见。 */
  disableModelInvocation?: boolean
  /** 与 deepseek-harness 一致：user-invocable: false 时人类命令不可见。 */
  userInvocable?: boolean
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
    else if (key === 'whenToUse') meta.whenToUse = value
    else if (key === 'disable-model-invocation') meta.disableModelInvocation = parseInvocationBoolean(value)
    else if (key === 'user-invocable') meta.userInvocable = parseInvocationBoolean(value)
  }
  return meta
}

/** 与 deepseek-harness frontmatterBoolean 一致：true/false、yes/no、on/off、1/0（大小写不敏感）。 */
function parseInvocationBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case '1': return true
    case 'false': case 'no': case 'off': case '0': return false
    default: return undefined
  }
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
/**
 * 扫描 deepseek-harness user-agents 风格的全局 Skills 根目录（仅一层，与上游一致）。
 *
 * deepseek-harness `dsh-skill-filesystem` 只识别两种形态：
 *   - `<root>/<name>/SKILL.md` 目录束；
 *   - `<root>/<name>.md` 扁平 Markdown。
 * 嵌套（子目录内）的 SKILL.md 一律忽略；隐藏条目与 manifest（index.json）不视为技能。
 */
export function discoverAgentSkills(rootDir: string): DiscoveredSkill[] {
  const result: DiscoveredSkill[] = []
  const seen = new Set<string>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (e.name === 'index.json') continue
    const clean = sanitizeSkillPath(e.name)
    if (!clean || seen.has(clean)) continue
    if (e.isDirectory()) {
      const skillFileAbs = SKILL_FILE_NAMES.map((n) => path.join(rootDir, e.name, n))
        .find((p) => {
          try {
            return fs.statSync(p).isFile()
          } catch {
            return false
          }
        })
      if (!skillFileAbs) continue
      seen.add(clean)
      const files: string[] = []
      collectFiles(rootDir, clean, files)
      // files 改为相对技能目录（与 installedDir 语义一致，供备份 payload 使用）
      const relFiles = files.map((f) => f.startsWith(clean + "/") ? f.slice(clean.length + 1) : f)
      const skillFile = clean + "/" + path.basename(skillFileAbs)
      const raw = readSkillFile(skillFileAbs)
      const metadata = parseSkillMetadata(raw)
      const name = isAgentSkillName(metadata.name) ? (metadata.name as string) : prettyName(clean)
      const description = metadata.description ?? extractBodyText(raw)
      result.push({
        id: kebabFromName(name) || clean,
        name,
        description,
        path: clean,
        skillFile,
        files: relFiles.filter((f) => sanitizeSkillPath(f)),
        metadata,
      })
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      seen.add(clean)
      const raw = readSkillFile(path.join(rootDir, e.name))
      const metadata = parseSkillMetadata(raw)
      const name = isAgentSkillName(metadata.name) ? (metadata.name as string) : prettyName(clean.replace(/.md$/i, ""))
      const description = metadata.description ?? extractBodyText(raw)
      result.push({
        id: kebabFromName(name) || clean.replace(/.md$/i, ""),
        name,
        description,
        path: clean,
        skillFile: clean,
        files: [clean],
        metadata,
      })
    }
  }
  return result
}

/** 技能显示名 -> agent kebab id（无有效可保留字符时返回空串）。 */
function kebabFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
}

/**
 * 面向 deepseek-harness 的 SKILL.md frontmatter 修补（行级、保守）。
 *
 * 支持：
 *   - 写入/替换 `name` 与 `description`（用于把仓库技能安装为 agent 技能时规范化）；
 *   - 写入/移除调用策略键 `disable-model-invocation` 与 `user-invocable`（启用/停用）。
 * 没有 frontmatter 时自动补一个 `---` 块；其余键与正文原样保留。
 */
export function patchSkillFrontmatter(
  content: string,
  patch: {
    name?: string
    description?: string
    setInvocation?: 'enabled' | 'disabled'
  },
): string {
  const raw = content.replace(/^\uFEFF/, '')
  const eol0 = raw.includes('\r\n') ? '\r\n' : '\n'
  const bodyLines = raw.split(/\r?\n/)
  // 定位 frontmatter：首行 `---` 且存在闭合 `---`；否则视为纯正文。
  let blockStart = -1
  let blockEnd = -1
  if (bodyLines.length > 0 && bodyLines[0].trim() === '---') {
    for (let i = 1; i < bodyLines.length; i++) {
      if (bodyLines[i].trim() === '---') {
        blockStart = 0
        blockEnd = i
        break
      }
    }
  }
  const block: string[] = blockStart >= 0 ? bodyLines.slice(blockStart + 1, blockEnd) : []
  const body: string[] = blockStart >= 0 ? bodyLines.slice(blockEnd + 1) : bodyLines

  const setKey = (key: string, value: string): void => {
    const idx = block.findIndex((l) => l.trim().toLowerCase().startsWith(key.toLowerCase() + ':'))
    if (idx >= 0) block[idx] = key + ": " + value
    else block.push(key + ": " + value)
  }
  const removeKey = (key: string): void => {
    const idx = block.findIndex((l) => l.trim().toLowerCase().startsWith(key.toLowerCase() + ':'))
    if (idx >= 0) block.splice(idx, 1)
  }
  if (patch.name !== undefined) setKey('name', yamlScalar(patch.name))
  if (patch.description !== undefined) setKey('description', yamlScalar(patch.description))
  if (patch.setInvocation === 'disabled') {
    setKey('disable-model-invocation', 'true')
    setKey('user-invocable', 'false')
  } else if (patch.setInvocation === 'enabled') {
    removeKey('disable-model-invocation')
    removeKey('user-invocable')
  }

  const head = block.length > 0 ? ['---', ...block, '---'] : []
  const joined = [...head, ...body].join(eol0)
  return raw.endsWith(eol0) || joined.endsWith(eol0) ? joined : joined + eol0
}

/** 把技能目录的 SKILL.md 规范化为 deepseek-harness 可识别的形态（kebab 名 + description）。 */
export function ensureAgentSkillFrontmatter(content: string, name: string, description?: string | null): string {
  return patchSkillFrontmatter(content, {
    name,
    description: description ?? name,
  })
}

/** YAML 单行标量：普通字符串直接输出，含特殊字符时用双引号包住。 */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9 ._\-]+$/.test(value) && !/^[\s\-?:]/.test(value)) return value
  return JSON.stringify(value)
}
