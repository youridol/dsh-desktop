/**
 * Plugin install strategy layer. `installPlugin` selects an installer by the
 * explicit `source` on the request — never by guessing from the name — so a
 * future source (git / url / local / marketplace) can be added without
 * touching the rest of DshPluginService.
 *
 * Every package in this app is an npm-registry package; npm / npx and
 * dsh-profile installs all go through the bundled `dsh plugin --profile`
 * channel (dsh forwards to pnpm inside the profile). The source is still
 * recorded as plugin metadata so the UI and later management operations can
 * tell the three apart.
 */
import { execDsh, type ExecResult } from './DshCommandExecutor'
import { hasBlockedBuildSignal, parseBlockedBuildInfo, type BlockedBuildInfo } from './pnpmBuildPolicy'
import { appLog } from '../../logger'

// ---- types ----

export type PluginInstallSource = 'npm' | 'npx' | 'dsh-profile'

export interface InstallPluginOptions {
  /** npm package name (registry spec, e.g. `dshmarket` or `@scope/pkg`). */
  name: string
  /** Declared install source. */
  source: PluginInstallSource
  /** Target profile name. Required for `dsh-profile`; defaults for others. */
  profile?: string
}

export interface PluginInstallError {
  code: string
  message: string
  cause?: unknown
}

/** Build-blocked failure carrying the packages pnpm wants allowlisted. */
export interface BuildBlockedInstallError extends PluginInstallError {
  code: 'BUILD_BLOCKED'
  keys: string[]
  names: string[]
}

/** Validation error for bad install requests. */
export function validationError(message: string, cause?: unknown): PluginInstallError {
  return { code: 'INVALID_REQUEST', message, cause }
}

/** Failure while executing the install command. */
export function execError(message: string, cause?: unknown): PluginInstallError {
  return { code: 'EXEC_FAILED', message, cause }
}

/** Narrow the catch type to a structured build-blocked error. */
export function isBuildBlockedError(err: unknown): err is BuildBlockedInstallError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as PluginInstallError).code === 'BUILD_BLOCKED'
  )
}

/** Build a user-facing BUILD_BLOCKED error from parsed pnpm output. */
export function buildBlockedError(info: BlockedBuildInfo, cause?: unknown): BuildBlockedInstallError {
  const detail = info.keys.length > 0
    ? info.keys.join(', ')
    : info.names.join(', ')
  const message = `pnpm 默认阻止构建脚本执行（build scripts are blocked by pnpm by default）` +
    (detail ? `：${detail}` : '') + `。放行构建脚本后可重新安装`
  return { code: 'BUILD_BLOCKED', message, keys: info.keys, names: info.names, cause }
}

/** Installer implementations. Each owns one source channel and the command
 * arguments it needs; no installer knows about the others. */
export interface PluginInstaller {
  readonly source: PluginInstallSource
  install(options: InstallPluginOptions): Promise<ExecResult>
}

type Executor = (args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>

// ---- shared helpers ----

/** Profile name used when the request does not pin one. */
export const DEFAULT_PROFILE = 'web'

/** Profile names: alphanumerics, hyphens, underscores — no path tricks. */
const VALID_PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export function validateProfile(profile: string | undefined): string | null {
  if (!profile || profile.length === 0) return 'Profile 不能为空'
  if (!VALID_PROFILE_NAME.test(profile)) return 'Profile 名称非法（仅允许字母、数字、连字符、下划线）'
  return null
}

/** Log a structured install attempt. Never logs secrets. */
function logInstall(opts: InstallPluginOptions, command: string): void {
  appLog.info(
    `[PluginInstall] source=${opts.source} profile=${opts.profile ?? DEFAULT_PROFILE} plugin=${opts.name}`,
  )
  appLog.info(`[PluginInstall] command=dsh ${command}`)
}

/** Full CLI output of an exec result (stdout + stderr). */
function execOutput(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

// ---- npm installer ----

/** npm registry packages, installed as profile dependencies. */
function NpmPluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'npm',
    async install(opts) {
      const command = ['plugin', '--profile', opts.profile ?? DEFAULT_PROFILE, 'add', opts.name]
      logInstall(opts, command.join(' '))
      return exec(command, { timeoutMs: 300_000 })
    },
  }
}

/** npx-style packages: registry packages that primarily ship a CLI. Installed
 * through the profile channel so they are managed by dsh like any other
 * dependency, but recorded as `npx` so the UI and later operations can tell
 * them apart. */
function NpxPluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'npx',
    async install(opts) {
      const command = ['plugin', '--profile', opts.profile ?? DEFAULT_PROFILE, 'add', opts.name]
      logInstall(opts, command.join(' '))
      return exec(command, { timeoutMs: 300_000 })
    },
  }
}

// ---- dsh-profile installer ----

/**
 * dsh native profile install via `dsh plugin --profile <profile> add
 * <plugin>` — `dsh plugin --profile web add dshmarket` is the requested
 * channel. `profile` is validated before this installer runs.
 */
function DshProfilePluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'dsh-profile',
    async install(opts) {
      const command = ['plugin', '--profile', opts.profile!, 'add', opts.name]
      logInstall(opts, command.join(' '))
      return exec(command, { timeoutMs: 300_000 })
    },
  }
}

// ---- dispatcher ----

/**
 * Resolve the installer for a source. Throws a `PluginInstallError` when the
 * source is unknown — an explicit branch, never a string prefix guess.
 */
function installerFor(source: string, exec: Executor): PluginInstaller {
  switch (source) {
    case 'npm':
      return NpmPluginInstaller(exec)
    case 'npx':
      return NpxPluginInstaller(exec)
    case 'dsh-profile':
      return DshProfilePluginInstaller(exec)
    default:
      throw validationError(`未知安装来源：${source}`)
  }
}

/**
 * Install a plugin by its declared source.
 *
 * - validates the plugin name up front, and the profile for `dsh-profile`
 * - runs the source's installer (argument arrays — no shell strings)
 * - maps exec results into structured errors: build scripts blocked by pnpm /
 *   dsh CLI missing / timeout / spawn failure / non-zero exit
 *
 * Returns the exec result; the caller persists metadata on success.
 */
export async function runInstall(
  opts: InstallPluginOptions,
  validateName: (name: string) => string | null,
  exec: Executor = execDsh,
): Promise<ExecResult> {
  // Source first: an unknown channel must fail before anything else.
  const installer = installerFor(opts.source, exec)

  const nameError = validateName(opts.name)
  if (nameError) throw validationError(nameError)

  if (opts.source === 'dsh-profile') {
    const profileError = validateProfile(opts.profile)
    if (profileError) throw validationError(profileError)
  }

  const result = await installer.install(opts)

  if (result.ok) return result

  // pnpm's own supply-chain gate refused dependency build scripts (git/GitHub
  // plugin `prepare`, registry postinstall, ...). Surface it as a structured
  // BUILD_BLOCKED error so DshPluginService / the UI can authorize and retry.
  const output = execOutput(result)
  const blocked = parseBlockedBuildInfo(output)
  if (blocked.keys.length > 0 || blocked.names.length > 0 || hasBlockedBuildSignal(output)) {
    throw buildBlockedError(blocked, result)
  }

  if (result.timedOut) {
    throw execError('插件安装超时，请检查网络连接后重试', result)
  }
  if (result.exitCode === 127) {
    throw execError('未检测到 pnpm，请安装 pnpm 后重试', result)
  }
  if (result.error) {
    throw execError('未检测到可用的 dsh CLI，请先安装 DeepSeek Harness 并确保 dsh 命令已加入 PATH', result)
  }
  throw execError('插件安装失败，请查看日志了解详情', result)
}
