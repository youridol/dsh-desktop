/**
 * DSH web-profile plugin management service.
 *
 * Every operation targets the `web` profile under $DSH_HOME/profiles/web.
 * Plugins are npm packages managed through `dsh plugin --profile web <pnpm-args>`;
 * the profile manifest (package.json) is the source of truth for installed and
 * enabled plugins.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execDsh, type ExecResult } from './DshCommandExecutor'
import { appLog } from '../../logger'

// ---- types ----

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
  /** 'npm' for registry packages, 'local' for path-installed. */
  source: 'npm' | 'local' | 'unknown'
  /** Absolute install directory under the profile's node_modules. */
  installDir: string | null
  /** Error from the last operation on this plugin, if any. */
  error?: string
}

export interface PluginListResult {
  plugins: PluginView[]
  profileDir: string
}

// ---- constants ----

const PLUGIN_PROFILE = 'web'

/** Absolute path to the web profile directory. */
function profileDir(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', PLUGIN_PROFILE)
}

/** Absolute path to the profile manifest (package.json). */
function profileManifestPath(): string {
  return path.join(profileDir(), 'package.json')
}

// ---- manifest helpers ----

interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
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

/** Validate a plugin name: alphanumeric, hyphens, dots, slashes (scoped), no shell metacharacters. */
const VALID_PLUGIN_NAME = /^@?[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$/
function validatePluginName(name: string): string | null {
  if (!name || name.length === 0) return '插件名称不能为空'
  if (name.length > 214) return '插件名称过长'
  if (!VALID_PLUGIN_NAME.test(name))
    return '插件名称包含非法字符（仅允许字母、数字、连字符、点、斜杠、@）'
  // Reject common shell metacharacters
  if (/[;&|`$(){}[\]<>'"!#~]/.test(name))
    return '插件名称包含非法字符'
  return null
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
  const dir = profileDir()

  const plugins: PluginView[] = []

  for (const [packageName, versionSpec] of Object.entries(deps)) {
    const meta = readPackageMeta(packageName)
    const isBundle = meta?.dsh?.bundle !== undefined

    plugins.push({
      id: packageName,
      packageName,
      version: meta?.version ?? versionSpec ?? null,
      enabled: bundles.has(packageName),
      isBundle,
      description: meta?.description ?? null,
      source: 'npm',
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

/**
 * Install a plugin via `dsh plugin --profile web add <name>`.
 * Returns the added plugin views, or throws with the CLI error.
 */
export async function addPlugin(name: string): Promise<PluginView[]> {
  const validationError = validatePluginName(name)
  if (validationError) throw new Error(validationError)

  const result = await execDsh(['plugin', '--profile', PLUGIN_PROFILE, 'add', name], {
    timeoutMs: 300_000, // 5 min for npm installs
  })

  if (!result.ok) {
    const detail = result.stderr || result.error || `退出码 ${result.exitCode}`
    throw new Error(`插件安装失败：${detail}`)
  }

  // Refresh the list to return the newly installed plugin(s)
  const { plugins } = listPlugins()
  return plugins.filter((p) => p.id === name)
}

/**
 * Remove a plugin via `dsh plugin --profile web remove <name>`.
 */
export async function removePlugin(name: string): Promise<void> {
  const validationError = validatePluginName(name)
  if (validationError) throw new Error(validationError)

  const result = await execDsh(
    ['plugin', '--profile', PLUGIN_PROFILE, 'remove', name],
    { timeoutMs: 120_000 },
  )

  if (!result.ok) {
    const detail = result.stderr || result.error || `退出码 ${result.exitCode}`
    throw new Error(`插件卸载失败：${detail}`)
  }
}

/**
 * Enable a plugin by adding its name to `dsh.profile.bundles`.
 * No-op if already enabled.
 */
export function enablePlugin(id: string): void {
  const manifest = readManifest()

  // Ensure the bundles array exists
  if (!manifest.dsh) manifest.dsh = {}
  if (!manifest.dsh.profile) manifest.dsh.profile = {}
  if (!manifest.dsh.profile.bundles) manifest.dsh.profile.bundles = []

  const bundles = manifest.dsh.profile.bundles

  if (!bundles.includes(id)) {
    bundles.push(id)
    writeManifest(manifest)
    appLog.info(`Enabled plugin ${id} in profile ${PLUGIN_PROFILE}`)
  }
}

/**
 * Disable a plugin by removing its name from `dsh.profile.bundles`.
 * Does NOT uninstall the dependency — the package stays in node_modules.
 * No-op if already disabled or not in bundles.
 */
export function disablePlugin(id: string): void {
  const manifest = readManifest()
  const bundles = manifest.dsh?.profile?.bundles
  if (!bundles || !bundles.includes(id)) return

  manifest.dsh!.profile!.bundles = bundles.filter((b) => b !== id)
  writeManifest(manifest)
  appLog.info(`Disabled plugin ${id} in profile ${PLUGIN_PROFILE}`)
}

/**
 * Uninstall (remove + delete) a plugin.
 * Calls `dsh plugin --profile web remove <name>` which runs pnpm remove,
 * removing the dependency from node_modules and the manifest's dependencies,
 * and reconciling the bundles list.
 */
export async function uninstallPlugin(name: string): Promise<void> {
  await removePlugin(name)
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