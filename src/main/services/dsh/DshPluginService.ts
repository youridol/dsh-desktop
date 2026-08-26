/**
 * DSH web-profile plugin management service.
 *
 * Every operation targets a dsh profile under $DSH_HOME/profiles/<profile>
 * (default `web`). Plugins are npm packages managed through
 * `dsh plugin --profile <profile> <pnpm-args>`; the profile manifest
 * (package.json) is the source of truth for installed and enabled plugins.
 *
 * The install source (npm / npx / dsh-profile) and the profile a plugin was
 * installed into are persisted as plugin metadata in the profile manifest
 * (dsh.desktop.plugins), so later management operations pick the right
 * profile and the UI can label the source. Records written before this
 * metadata existed fall back to source `dsh-profile` + profile `web`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execDsh, type ExecResult } from './DshCommandExecutor'
import {
  runInstall,
  validationError,
  isBuildBlockedError,
  DEFAULT_PROFILE,
  type InstallPluginOptions,
  type PluginInstallSource,
} from './DshPluginInstaller'
import { authorizeBuildScripts } from './pnpmBuildPolicy'
import { resolveProfileDir, resolveProfileManifestPath } from './profilePaths'
import { appLog } from '../../logger'

// ---- types ----

export type { PluginInstallSource, InstallPluginOptions, PluginInstallError } from './DshPluginInstaller'

export interface PluginView {
  /** dsh.profile.bundles id / npm package name. */
  id: string
  /** npm package name (same as id for registry packages). */
  packageName: string
  /** Installed version from the profile's node_modules. */
  version: string | null
  /** Whether the package is in dsh.profile.bundles (activated). */
  enabled: boolean
  /** Whether the package exports a dsh.bundle (is a plugin layer). */
  isBundle: boolean
  /** Human-readable description from the package's package.json. */
  description: string | null
  /** Install channel: 'npm' | 'npx' | 'dsh-profile'. 'dsh-profile' for
   * records predating the source field. */
  source: PluginInstallSource
  /** Profile this plugin was installed into (default 'web'). */
  profile: string
  /** Install timestamp, or null for legacy records. */
  installedAt: number | null
  /** Absolute install directory under the profile's node_modules. */
  installDir: string | null
  /** Error from the last operation on this plugin, if any. */
  error?: string
}

export interface PluginListResult {
  plugins: PluginView[]
  profileDir: string
}

/** Legacy records get these defaults so old data keeps rendering. */
const LEGACY_SOURCE: PluginInstallSource = 'dsh-profile'
const LEGACY_PROFILE = DEFAULT_PROFILE

// ---- constants ----

/** Absolute path to the web profile directory (the one dsh-desktop manages). */
function profileDir(): string {
  return resolveProfileDir(DEFAULT_PROFILE)
}

/** Absolute path to the profile manifest (package.json). */
function profileManifestPath(): string {
  return resolveProfileManifestPath(DEFAULT_PROFILE)
}

// ---- manifest helpers ----

interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
    /** dsh-desktop install metadata, kept separate from dsh's own fields
     * so the harness profile logic is untouched. */
    desktop?: {
      plugins?: Record<string, DesktopPluginRecord>
    }
  }
}

interface DesktopPluginRecord {
  source: PluginInstallSource
  profile: string
  installedAt: number
}

function readManifest(): ProfileManifest {
  try {
    const raw = fs.readFileSync(profileManifestPath(), 'utf8')
    return JSON.parse(raw) as ProfileManifest
  } catch {
    return {}
  }
}

function writeManifest(manifest: ProfileManifest): void {
  const dir = profileDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    profileManifestPath(),
    JSON.stringify(manifest, undefined, 2) + '\n',
    'utf8',
  )
}

/** Read the install metadata map, creating the container if missing. */
function desktopPlugins(manifest: ProfileManifest): Record<string, DesktopPluginRecord> {
  return manifest.dsh?.desktop?.plugins ?? {}
}

/** Persist a plugin's install record (source + profile + time). */
function saveInstallRecord(name: string, source: PluginInstallSource, profile: string): void {
  const manifest = readManifest()
  if (!manifest.dsh) manifest.dsh = {}
  if (!manifest.dsh.desktop) manifest.dsh.desktop = {}
  if (!manifest.dsh.desktop.plugins) manifest.dsh.desktop.plugins = {}
  manifest.dsh.desktop.plugins[name] = { source, profile, installedAt: Date.now() }
  writeManifest(manifest)
}

// ---- validation ----

const VALID_PLUGIN_NAME = /^@?[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$/

/**
 * Git / GitHub install specs pnpm understands, passed through to
 * `dsh plugin --profile <p> add <spec>` verbatim (e.g. GitHub plugin
 * installs). Everything is forwarded as a single argument array — never a
 * shell string — so only whitespace and shell metacharacters are unsafe.
 */
const GIT_SPEC_PREFIX = /^(?:github:|gitlab:|git\+|git:\/\/|git@|https?:\/\/)/i

/** True when the input looks like a git install spec rather than a name. */
function isGitSpec(trimmed: string): boolean {
  return GIT_SPEC_PREFIX.test(trimmed) || /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:#|$)/.test(trimmed)
}

/**
 * Validate a plugin name or git/GitHub install spec: alphanumerics, hyphens,
 * dots, slashes (scoped) for npm packages; git specs (`github:owner/repo`,
 * `https://github.com/...`, `git+https://...`, ...) pass through to pnpm.
 * Shell metacharacters and whitespace are always rejected.
 */
export function validatePluginName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '插件名称不能为空'
  if (trimmed.length > 214) return '插件名称过长'
  // Common shell metacharacters are never allowed, whatever the form. `#` is
  // safe with array args and is pnpm's git ref separator, so it stays.
  if (/[;|&$(){}[\]]<>'"!~]/.test(trimmed)) return '插件名称包含非法字符'
  if (isGitSpec(trimmed)) {
    return /\s/.test(trimmed) ? '插件名称包含非法字符' : null
  }
  if (!VALID_PLUGIN_NAME.test(trimmed))
    return '插件名称包含非法字符（仅允许字母、数字、连字符、点、斜杠、@，或 GitHub/git 地址）'
  return null
}

/** Resolve a package's installed directory under the profile's node_modules. */
function resolvePackageDir(packageName: string): string | null {
  const dir = path.join(profileDir(), 'node_modules', ...packageName.split('/'))
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
}

/** Read a package's own manifest (package.json). */
function readPackageMeta(
  packageName: string,
): { version?: string; description?: string; dsh?: { bundle?: unknown } } | null {
  const dir = resolvePackageDir(packageName)
  if (!dir) return null
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as { version?: string; description?: string; dsh?: { bundle?: unknown } }
  } catch {
    return null
  }
}

// ---- public API ----

/**
 * List every plugin visible in the web profile.
 *
 * A "plugin" is any dependency in the profile manifest. Bundles
 * (packages with `dsh.bundle`) are the active plugin layers;
 * plain dependencies are installed but not plugin layers.
 */
export function listPlugins(): PluginListResult {
  const manifest = readManifest()
  const deps = manifest.dependencies ?? {}
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const records = desktopPlugins(manifest)
  const dir = profileDir()

  const plugins: PluginView[] = []

  for (const [packageName, versionSpec] of Object.entries(deps)) {
    const meta = readPackageMeta(packageName)
    const isBundle = meta?.dsh?.bundle !== undefined
    const record = records[packageName]

    plugins.push({
      id: packageName,
      packageName,
      version: meta?.version ?? versionSpec ?? null,
      enabled: bundles.has(packageName),
      isBundle,
      description: meta?.description ?? null,
      source: record?.source ?? LEGACY_SOURCE,
      profile: record?.profile ?? LEGACY_PROFILE,
      installedAt: record?.installedAt ?? null,
      installDir: resolvePackageDir(packageName),
    })
  }

  // Sort: bundles first, then alphabetically
  plugins.sort((a, b) => {
    if (a.isBundle !== b.isBundle) return a.isBundle ? -1 : 1
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  return { plugins, profileDir: dir }
}

/** Install controls for installPlugin (kept separate from the plugin request). */
export interface InstallPluginRunOptions {
  /** Authorize pnpm-blocked build scripts and retry once on failure. */
  allowBuilds?: boolean
}

/** Run the install and persist metadata on success (shared by retries). */
async function installAndPersist(
  options: InstallPluginOptions,
  executor: typeof execDsh,
): Promise<PluginView[]> {
  // Dependency diff lets git/GitHub specs (which resolve to the package's
  // real name in the manifest) map back to the installed plugin rows.
  const before = new Set(Object.keys(readManifest().dependencies ?? {}))
  const result = await runInstall(options, validatePluginName, executor)

  if (!result.ok) {
    const detail = result.error || result.stderr || `退出码 ${result.exitCode}`
    throw validationError(`插件安装失败：${detail}`, result)
  }

  const profile = options.profile ?? DEFAULT_PROFILE
  saveInstallRecord(options.name, options.source, profile)

  const after = new Set(Object.keys(readManifest().dependencies ?? {}))
  const added = [...after].filter((dep) => !before.has(dep))
  const names = added.length > 0 ? added : [options.name]
  const { plugins } = listPlugins()
  return plugins.filter((p) => names.includes(p.packageName))
}

/**
 * Install a plugin by its declared source. The source picks the install
 * strategy; name and profile are validated up front. On success the install
 * record (source + profile + time) is persisted and the list refreshed.
 *
 * When pnpm refuses dependency build scripts (git/GitHub plugins' prepare,
 * registry postinstall), `runInstall` throws a structured BUILD_BLOCKED
 * error. With `runOpts.allowBuilds` the blocked packages are first
 * authorized in the target profile (pnpm-workspace.yaml `allowBuilds` +
 * `pnpm.onlyBuiltDependencies`), then the install is re-run automatically —
 * the authorization is a real policy edit, never a UI-only state change.
 *
 * @throws PluginInstallError on failure — never writes a success record.
 * @param options install request (source selects the strategy in the
 *   installer layer)
 * @param executor override for tests; defaults to the real dsh executor.
 * @param runOpts extra install controls (e.g. allow-builds retry).
 */
export async function installPlugin(
  options: InstallPluginOptions,
  executor?: typeof execDsh,
  runOpts: InstallPluginRunOptions = {},
): Promise<PluginView[]> {
  const exec = executor ?? execDsh
  try {
    return await installAndPersist(options, exec)
  } catch (err) {
    if (runOpts.allowBuilds && isBuildBlockedError(err)) {
      authorizeBuildScripts(options.profile ?? DEFAULT_PROFILE, {
        keys: err.keys,
        names: err.names,
      })
      return installAndPersist(options, exec)
    }
    throw err
  }
}

/**
 * Back-compat wrapper: install as a plain npm package into the web profile.
 * Kept so existing callers (`plugins:add` with a bare name) keep working.
 */
export async function addPlugin(name: string): Promise<PluginView[]> {
  return installPlugin({ name, source: 'npm' })
}

/**
 * Remove a plugin from the profile it was installed into via
 * `dsh plugin --profile <profile> remove <name>`. Legacy records (no
 * metadata) fall back to the web profile. The dsh.desktop record stays so
 * the plugin keeps its source label if a reinstall brings it back.
 */
export async function removePlugin(name: string): Promise<void> {
  const validationError_ = validatePluginName(name)
  if (validationError_) throw new Error(validationError_)

  const record = desktopPlugins(readManifest())[name]
  const profile = record?.profile ?? LEGACY_PROFILE

  const result = await execDsh(['plugin', '--profile', profile, 'remove', name], {
    timeoutMs: 120_000,
  })

  if (!result.ok) {
    const detail = result.stderr || result.error || `退出码 ${result.exitCode}`
    throw new Error(`插件卸载失败：${detail}`)
  }
}

/**
 * Enable a plugin by adding its name to `dsh.profile.bundles` in the profile
 * it was installed into. No-op if already enabled.
 */
export function enablePlugin(id: string): void {
  const manifest = readManifest()
  const profile = desktopPlugins(manifest)[id]?.profile ?? LEGACY_PROFILE
  if (profile !== DEFAULT_PROFILE) {
    appLog.warn(`enablePlugin: ${id} 安装在 profile ${profile}，当前列表仅管理 ${DEFAULT_PROFILE}`)
    return
  }

  // Ensure the bundles array exists
  if (!manifest.dsh) manifest.dsh = {}
  if (!manifest.dsh.profile) manifest.dsh.profile = {}
  if (!manifest.dsh.profile.bundles) manifest.dsh.profile.bundles = []

  const bundles = manifest.dsh.profile.bundles

  if (!bundles.includes(id)) {
    bundles.push(id)
    writeManifest(manifest)
    appLog.info(`Enabled plugin ${id} in profile ${profile}`)
  }
}

/**
 * Disable a plugin by removing its name from `dsh.profile.bundles` in the
 * profile it was installed into. Does NOT uninstall the dependency — the
 * package stays in node_modules. No-op if already disabled or not in bundles.
 */
export function disablePlugin(id: string): void {
  const manifest = readManifest()
  const profile = desktopPlugins(manifest)[id]?.profile ?? LEGACY_PROFILE
  if (profile !== DEFAULT_PROFILE) {
    appLog.warn(`disablePlugin: ${id} 安装在 profile ${profile}，当前列表仅管理 ${DEFAULT_PROFILE}`)
    return
  }

  const bundles = manifest.dsh?.profile?.bundles
  if (!bundles || !bundles.includes(id)) return

  manifest.dsh!.profile!.bundles = bundles.filter((b) => b !== id)
  writeManifest(manifest)
  appLog.info(`Disabled plugin ${id} in profile ${profile}`)
}

/**
 * Uninstall (remove + delete) a plugin: remove from the installed profile,
 * then delete its dsh.desktop record so a reinstall gets a fresh record.
 */
export async function uninstallPlugin(name: string): Promise<void> {
  await removePlugin(name)

  const manifest = readManifest()
  const plugins = manifest.dsh?.desktop?.plugins
  if (plugins && plugins[name]) {
    delete plugins[name]
    writeManifest(manifest)
  }
}

/**
 * Export plugin info: read the installed package's metadata and return a
 * portable description (package name + version) suitable for sharing or
 * re-installation.
 */
export function exportPluginInfo(
  id: string,
): { packageName: string; version: string | null; description: string | null } | null {
  const meta = readPackageMeta(id)
  if (!meta) return null
  return {
    packageName: id,
    version: meta.version ?? null,
    description: meta.description ?? null,
  }
}

/**
 * Map a CLI exec result error into a user-facing message.
 */
export function formatCliError(result: ExecResult): string {
  if (result.timedOut) {
    return '操作超时，请检查网络连接后重试'
  }
  if (result.error) {
    return result.error
  }
  if (result.exitCode === 127) {
    return '未检测到 pnpm，请安装 pnpm 后重试'
  }
  const tail = (result.stderr || result.stdout || '').trim().slice(0, 500)
  if (tail) {
    // Clean up common pnpm/cli noise for the user
    return tail
      .replace(/^dsh:\s*/gm, '')
      .replace(/pnpm\s+/g, '')
      .trim() || `命令以退出码 ${result.exitCode} 结束`
  }
  return `命令以退出码 ${result.exitCode} 结束`
}

export { validationError, isBuildBlockedError }