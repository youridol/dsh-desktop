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
import { execDsh, execRaw, type ExecResult } from './DshCommandExecutor'
import {
  hasBlockedBuildSignal,
  parseBlockedBuildInfo,
  type BlockedBuildInfo,
} from './pnpmBuildPolicy'
import { appLog } from '../../logger'

// ---- types ----

export type PluginInstallSource = 'npm' | 'npx' | 'dsh-profile' | 'pnpm' | 'github' | 'custom'

export interface InstallPluginOptions {
  /** npm package name (registry spec, e.g. `dshmarket` or `@scope/pkg`). */
  name: string
  /** Declared install source. */
  source: PluginInstallSource
  /** Target profile name. Required for `dsh-profile`; defaults for others. */
  profile?: string
  /** Custom install command for `custom` source (e.g. `npx dsh plugin --profile web add x`). */
  command?: string
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

// ---- pnpm installer ----

/**
 * pnpm-native installs: the same `dsh plugin --profile <profile> add <pkg>`
 * channel the dsh CLI forwards to pnpm inside the profile, recorded with the
 * source label `pnpm` so the UI can distinguish it. The profile is validated
 * before this installer runs.
 */
function PnpmPluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'pnpm',
    async install(opts) {
      const command = ['plugin', '--profile', opts.profile!, 'add', opts.name]
      logInstall(opts, command.join(' '))
      return exec(command, { timeoutMs: 300_000 })
    },
  }
}

// ---- github installer ----

/**
 * GitHub-hosted plugins: install the `github:owner/repo` spec into the
 * profile via the native dsh channel (pnpm resolves GitHub specs itself).
 * The spec is passed through the same validation as git/GitHub URLs.
 */
function GithubPluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'github',
    async install(opts) {
      const command = ['plugin', '--profile', opts.profile ?? DEFAULT_PROFILE, 'add', opts.name]
      logInstall(opts, command.join(' '))
      return exec(command, { timeoutMs: 300_000 })
    },
  }
}

// ---- custom installer ----

/**
 * Custom install command: the user typed a full command line (e.g.
 * `npx dsh plugin --profile web add x`, `pnpm add x`, `npm install x`).
 * The line is split on whitespace into an argument array — never a shell
 * string — so command injection is impossible; the array is handed to the
 * shared raw executor (win32 .cmd resolution via PATHEXT, no shell
 * interpretation of the arguments). A leading `dsh`/`npx dsh` prefix is
 * normalized to the bundled dsh runtime so the CLI is always available
 * regardless of PATH.
 */
function CustomPluginInstaller(exec: Executor): PluginInstaller {
  return {
    source: 'custom',
    async install(opts) {
      const raw = (opts.command ?? opts.name).trim()
      const parts = raw.split(/\s+/).filter(Boolean)
      if (parts.length === 0) throw validationError('自定义安装命令不能为空')
      appLog.info(`[PluginInstall] custom command=${raw}`)
      // `dsh <args>` / `npx dsh <args>` → bundled dsh executor (PATH-free).
      const first = parts[0] === 'npx' ? parts[1] : parts[0]
      if (first === 'dsh') {
        const dshArgs = parts[0] === 'npx' ? parts.slice(2) : parts.slice(1)
        if (dshArgs.length === 0) throw validationError('自定义安装命令缺少 dsh 参数')
        return exec(dshArgs, { timeoutMs: 300_000 })
      }
      // Everything else runs as a raw program in the profile directory
      // (pnpm add / npm install / npx <pkg> ...).
      const profile = opts.profile ?? DEFAULT_PROFILE
      const { resolveProfileDir } = await import('./profilePaths')
      return execRaw(parts, { timeoutMs: 300_000, cwd: resolveProfileDir(profile) })
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
    case 'pnpm':
      return PnpmPluginInstaller(exec)
    case 'github':
      return GithubPluginInstaller(exec)
    case 'custom':
      return CustomPluginInstaller(exec)
    default:
      throw validationError(`未知安装来源：${source}`)
  }
}

/**
 * Install a plugin by its declared source.
 *
 * - validates the plugin name up front, and the profile for `dsh-profile` /
 *   `pnpm`
 * - runs the source's installer (argument arrays — no shell strings)
 * - maps exec results into structured errors: build scripts blocked by pnpm
 *   (surfaced for the caller's allow-builds retry) / dsh CLI missing / timeout
 *   / spawn failure / non-zero exit
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

  // Custom installs carry a free-form command; the name field is only a
  // human label, so strict package-name validation is skipped there.
  if (opts.source !== 'custom') {
    const nameError = validateName(opts.name)
    if (nameError) throw validationError(nameError)
  }

  if (opts.source === 'dsh-profile' || opts.source === 'pnpm') {
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

  // The release-age gate is deliberately NOT intercepted here: the managed
  // profile's pnpm policy is opened (minimumReleaseAge: 0) before any install
  // so pnpm never enforces its fresh-release hold — no RELEASE_AGE_BLOCKED
  // path exists anymore (requirement: no minimumReleaseAge interception).
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
