/**
 * Central path resolution for the app.
 *
 * Two worlds:
 *  - dev:      everything under the project checkout (`dist/`, `dsh-bundle/`, `runtime/`).
 *  - packaged: app code inside `resources/app.asar`, the bundled DSH runtime and
 *              tooling under `process.resourcesPath`, and user-writable runtime
 *              data either next to the exe (portable zip) or in userData (NSIS).
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface AppPaths {
  /** Writable dir holding config, credentials, plugins, versions, logs. */
  runtimeDir: string
  configFile: string
  /** Plaintext credentials, per project policy stored in the runtime dir only. */
  credentialsFile: string
  pluginsDir: string
  versionsDir: string
  downloadsDir: string
  logsDir: string
  /** dsh-desktop 管理的 Skills 数据根目录（仓库缓存 / 作用域 / 备份）。 */
  skillsDir: string
  /** Generated cordis patch overlay passed to `dsh web --patch`. */
  patchFile: string
  /** True when running from the portable zip (runtime data lives next to the exe). */
  isPortable: boolean
}

let cached: AppPaths | null = null

function projectRoot(): string {
  // dist/main.js -> the project root is one level up.
  return path.resolve(__dirname, '..')
}

/**
 * Dev runtime lives in the project's .dsh-runtime checkout; packaged builds
 * carry build-assets/dsh-runtime.tgz and extract it into the runtime dir on
 * first launch (see ensureBundledRuntime in dsh/install.ts).
 */
export function runtimeTgzPath(): string | null {
  if (!app.isPackaged) {
    const dev = path.join(projectRoot(), 'build-assets', 'dsh-runtime.tgz')
    return fs.existsSync(dev) ? dev : null
  }
  const tgz = path.join(process.resourcesPath, 'dsh-runtime.tgz')
  return fs.existsSync(tgz) ? tgz : null
}

/** Directory of the extracted bundled runtime inside the runtime dir. */
export function bundledExtractDir(): string {
  return path.join(getPaths().versionsDir, '_bundled')
}

/** Dir of the bundled DSH install (its node_modules tree), or null. */
export function bundledDshDir(): string | null {
  if (!app.isPackaged) {
    const dev = path.join(projectRoot(), '.dsh-runtime')
    return fs.existsSync(path.join(dev, 'node_modules', '@deepseek-ai', 'dsh')) ? dev : null
  }
  const dir = bundledExtractDir()
  return fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')) ? dir : null
}

/** Path of the vendored npm CLI, or null. */
export function npmCliPath(): string | null {
  const base = bundledDshDir()
  const cli = base && path.join(base, 'tools', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return cli && fs.existsSync(cli) ? cli : null
}

function resolveRuntimeDir(): { dir: string; portable: boolean } {
  if (!app.isPackaged) {
    return { dir: path.join(projectRoot(), 'runtime'), portable: false }
  }
  // The zip build ships `resources/portable.marker`; keep runtime data next to
  // the exe so the folder stays self-contained. NSIS installs have no marker.
  const marker = path.join(process.resourcesPath, 'portable.marker')
  if (fs.existsSync(marker)) {
    return { dir: path.dirname(process.execPath), portable: true }
  }
  return { dir: app.getPath('userData'), portable: false }
}

export function getPaths(): AppPaths {
  if (cached) return cached
  const { dir, portable } = resolveRuntimeDir()
  cached = {
    runtimeDir: dir,
    configFile: path.join(dir, 'config.json'),
    credentialsFile: path.join(dir, 'credentials.json'),
    pluginsDir: path.join(dir, 'plugins'),
    versionsDir: path.join(dir, 'versions'),
    downloadsDir: path.join(dir, 'downloads'),
    logsDir: path.join(dir, 'logs'),
    skillsDir: path.join(dir, 'skills'),
    patchFile: path.join(dir, 'cordis.patch.yml'),
    isPortable: portable,
  }
  return cached
}

export function ensureRuntimeDirs(): void {
  const p = getPaths()
  for (const dir of [p.runtimeDir, p.pluginsDir, p.versionsDir, p.downloadsDir, p.logsDir, p.skillsDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
