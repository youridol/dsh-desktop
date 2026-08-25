/**
 * deepseek-harness Agents/Skills 路径适配层（纯 Node，无 Electron 依赖）。
 *
 * 与上游 `@deepseek-ai/dsh-home-paths` / `dsh-skill-filesystem` 保持同一语义：
 *  - `agentsHome` = `$DSH_AGENTS_HOME`，未设置时默认 `~/.agents`（经 os.homedir() 解析）；
 *  - 全局用户 Skills 根（user-agents）= `<agentsHome>/skills`；
 *  - `~` / `~/` / `~\` 前缀一律按操作系统用户 Home 展开，禁止把 `~` 当作普通相对路径。
 *
 * 同时提供 dsh-desktop Skills 体系的统一路径解析：仓库缓存 / 备份 / 注册表仍位于
 * dsh-desktop 运行目录，`global` 作用域映射到 deepseek-harness 的真实全局 Skills 根。
 */
import os from 'node:os'
import path from 'node:path'

/** dsh-desktop Skills 体系的统一路径（global 作用域 = deepseek-harness user-agents 根）。 */
export interface UnifiedSkillsPaths {
  /** dsh-desktop Skills 数据根目录（仓库缓存 / 备份 / 注册表）。 */
  skillsDir: string
  reposDir: string
  /** 全局作用域安装目录 = <agentsHome>/skills（deepseek-harness 真实读取的目录）。 */
  globalDir: string
  /** 项目作用域安装目录（默认 <skillsDir>/project，可用配置覆盖）。 */
  projectDir: string
  backupsDir: string
  configFile: string
  /** 共享 agent 配置根：$DSH_AGENTS_HOME 或 ~/.agents。 */
  agentsHome: string
}

export interface ResolveSkillsPathsOptions {
  /** dsh-desktop 运行目录内的 skills 数据根。 */
  runtimeSkillsDir: string
  /** 可选的 project 作用域覆盖路径（支持 `~` 前缀）。 */
  projectDir?: string
  env?: NodeJS.ProcessEnv
  homedir?: string
}

/**
 * 展开路径开头的 `~` / `~/` / `~\` 为用户 Home 目录。
 * - 非 `~` 前缀路径原样返回；
 * - `~user/...`（其他用户）不在支持范围，原样返回；
 * - 空输入返回原值。
 */
export function expandHomePath(input: string, homedir: string = os.homedir()): string {
  if (!input) return input
  if (input === '~') return homedir || input
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    const rest = input.slice(2)
    return homedir ? path.join(homedir, rest) : input
  }
  return input
}

/**
 * 解析 deepseek-harness 共享 agent 根：`$DSH_AGENTS_HOME`（支持 `~` 前缀）或 `~/.agents`。
 * 与上游 `FileSystemSkillProvider` 的 `agentsHome` 默认一致：
 * `config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')`。
 */
export function resolveAgentsHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  const configured = env.DSH_AGENTS_HOME
  if (configured && configured.trim()) return expandHomePath(configured.trim(), homedir)
  return homedir ? path.join(homedir, '.agents') : '.agents'
}

/** 解析 deepseek-harness 全局用户 Skills 根（user-agents）：<agentsHome>/skills。 */
export function resolveAgentSkillDir(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  return path.join(resolveAgentsHome(env, homedir), 'skills')
}

/** project 作用域目录：展开 `~` 后必须为绝对路径（相对路径基于 runtime skills 根解析）。 */
function resolveProjectDir(override: string | undefined, base: string, homedir: string): string {
  const raw = override?.trim()
  if (!raw) return path.join(base, 'project')
  const expanded = expandHomePath(raw, homedir)
  return path.isAbsolute(expanded) ? expanded : path.join(base, expanded)
}

/**
 * dsh-desktop Skills 统一路径解析。
 *
 * 规则：
 *  - 仓库缓存 / 备份 / 注册表 = <runtimeSkillsDir>/{repos,backups,repositories.json}；
 *  - `globalDir` = deepseek-harness user-agents 根（真实全局 Skills 路径）；
 *  - `projectDir` 支持 `~` 前缀展开（默认 <runtimeSkillsDir>/project）。
 */
export function resolveSkillsPaths(options: ResolveSkillsPathsOptions): UnifiedSkillsPaths {
  const env = options.env ?? process.env
  const home = options.homedir ?? os.homedir()
  const base = options.runtimeSkillsDir
  const globalDir = resolveAgentSkillDir(env, home)
  return {
    skillsDir: base,
    reposDir: path.join(base, 'repos'),
    globalDir,
    // projectDir 覆盖支持 `~` 前缀；相对路径一律基于运行目录解析为绝对路径（禁止把 `~` 当相对路径）
    projectDir: resolveProjectDir(options.projectDir, base, home),
    backupsDir: path.join(base, 'backups'),
    configFile: path.join(base, 'repositories.json'),
    agentsHome: resolveAgentsHome(env, home),
  }
}
