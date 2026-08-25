/**
 * Skills 领域共用类型与校验工具（纯函数，不依赖 Electron / Node I/O）。
 *
 * 这些工具同时被主进程服务、IPC 层、渲染层类型定义与测试使用，
 * 保证“作用域、仓库地址、路径安全、键值派生”在整条链路上规则一致。
 */

export type SkillScope = 'global' | 'project'

export const SKILL_SCOPES: readonly SkillScope[] = ['global', 'project']

export const DEFAULT_SKILLS_REPOSITORY = 'https://github.com/mattpocock/skills'

export function isValidSkillScope(v: unknown): v is SkillScope {
  return v === 'global' || v === 'project'
}

export type ScopeFilter = SkillScope | 'all'

export function isValidScopeFilter(v: unknown): v is ScopeFilter {
  return v === 'all' || isValidSkillScope(v)
}

const REPO_URL_RE = /^https?:\/\/[^\s/,?#]+[^\s]*$/i

/** 校验 Skills 仓库地址：仅允许公开 http(s) URL，禁止内嵌凭据与本地路径。 */
export function validateRepositoryUrl(input: string): string | null {
  const url = input.trim()
  if (!url) return '仓库地址不能为空'
  if (url.length > 2048) return '仓库地址过长（最多 2048 字符）'
  if (!REPO_URL_RE.test(url)) {
    return '仓库地址仅支持 http(s) URL（例如 https://github.com/mattpocock/skills）'
  }
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return '仓库地址不能包含用户名或密码（请使用公开地址，私有仓库请在设置中配置 GitHub 凭据）'
    if (!parsed.hostname) return '仓库地址缺少主机名'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '仓库地址仅支持 http/https'
  } catch {
    return '仓库地址不是合法的 URL'
  }
  return null
}

/** 校验仓库显示名称：不允许路径分隔符 / 控制字符。 */
export function validateRepositoryName(input: string): string | null {
  const name = input.trim()
  if (!name) return '仓库名称不能为空'
  if (name.length > 120) return '仓库名称过长（最多 120 字符）'
  if (/[\\\u0000-\u001f]/.test(name)) return '仓库名称不能包含反斜杠或控制字符'
  return null
}

/** 安全转 slug：仅保留小写字母数字与 . _ -，其余折叠为连字符。 */
export function slugify(input: string, max = 80): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  const slug = base || 'skill'
  return slug.length > max ? slug.slice(0, max).replace(/-+$/, '') : slug
}

/** deepseek-harness 本地全局 Skills 的来源标识（无仓库来源的 agent 技能）。 */
export const AGENTS_SOURCE_ID = 'agents'

/** deepseek-harness 技能名文法：kebab-case（与上游 SKILL_NAME 一致）。 */
const AGENT_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 是否为 deepseek-harness 认可的 kebab-case 技能名。 */
export function isAgentSkillName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_SKILL_NAME_RE.test(value)
}

/**
 * kebab-case 化：仅保留小写字母数字与连字符（deepseek-harness 技能目录/名规范），
 * 折叠连续连字符、去首尾连字符；无可保留字符时回退 'skill'。
 */
export function kebabSlug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const slug = base || 'skill'
  return isAgentSkillName(slug) ? slug : 'skill'
}

/** 本机全局（user-agents）技能的稳定清单键：agents:<skillName>。 */
export function agentSkillKey(skillName: string): string {
  return `${AGENTS_SOURCE_ID}:${skillName}`
}
/** 稳定短 hash（用于 id 冲突消解 / 短标识）。 */
export function shortHash(input: string, len = 6): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (const ch of input) {
    const c = ch.codePointAt(0) ?? 0
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0').slice(0, len)
}

/**
 * 校验并规范化技能在仓库内的相对路径。
 * 拒绝绝对路径、`.`, `..`、空段、前导/结尾斜杠与非法控制字符。
 */
export function sanitizeSkillPath(input: string): string | null {
  const raw = input.trim()
  if (!raw || raw.startsWith('/') || raw.startsWith('\\')) return null
  const p = raw.replace(/\\/g, '/').replace(/\/+$/g, '')
  if (!p) return null
  if (/[\u0000-\u001f]/.test(p)) return null
  const parts = p.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  if (parts.some((part) => /^\s|\s$/.test(part))) return null
  return p
}

/** 稳定全局键：repoId:repoPath。 */
export function skillKey(repoId: string, repoPath: string): string {
  return `${repoId}:${repoPath}`
}

/** 从 repoId + path 派生安装目录的安全叶名。 */
export function skillLeafName(repoId: string, repoPath: string): string {
  const raw = `${repoId}-${repoPath.replace(/\//g, '-')}`
  const slug = slugify(raw, 100)
  return slug || `skill-${shortHash(raw)}`
}

/** 校验备份文件中的相对文件路径（导出/导入 payload 用）。 */
export function isValidPayloadRelativePath(input: string): boolean {
  // 绝对路径（POSIX 或 Windows 盘符）与 backslash 一律拒绝
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input)) return false
  const p = sanitizeSkillPath(input)
  if (!p) return false
  return !p.split('/').some((part) => part === '..' || part === '.')
}
