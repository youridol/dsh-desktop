/**
 * Plugin management. Plugins live as directories (or single .js files) under
 * the runtime plugins dir; a plugin exports `name` + `apply(ctx)` per the DSH
 * plugin guide. Enabled plugins are written into a generated cordis patch
 * overlay with ABSOLUTE entry paths, passed to `dsh web --patch`.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPaths } from './paths'
import { getConfig, mutateConfig, type PluginRecord } from './config'
import { appLog } from './logger'

/**
 * Recursive delete that survives Windows read-only files (git object files).
 * chmod each entry first, then remove; `attrib -R` as a belt-and-braces pass.
 */
export function rmRobust(target: string): void {
  if (!fs.existsSync(target)) return
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return
  } catch {
    /* fall through to read-only stripping */
  }
  const strip = (p: string) => {
    const stat = fs.lstatSync(p)
    if (stat.isFile() || stat.isSymbolicLink()) {
      try {
        fs.chmodSync(p, 0o666)
      } catch {
        /* best effort */
      }
    } else if (stat.isDirectory()) {
      for (const child of fs.readdirSync(p)) strip(path.join(p, child))
      try {
        fs.chmodSync(p, 0o666)
      } catch {
        /* best effort */
      }
    }
  }
  strip(target)
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

export interface PluginView extends PluginRecord {
  /** Entry file missing on disk. */
  missing: boolean
  description?: string
  version?: string
}

const PLUGIN_EXTS = new Set(['.js', '.cjs', '.mjs'])

function readPackageMeta(dir: string): { name?: string; description?: string; version?: string; main?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Resolve the plugin entry file for an installed dir/file under pluginsDir. */
function resolveEntry(installedPath: string): string | null {
  const stat = fs.statSync(installedPath, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isFile()) {
    return PLUGIN_EXTS.has(path.extname(installedPath)) ? installedPath : null
  }
  const meta = readPackageMeta(installedPath)
  if (meta.main) {
    const main = path.join(installedPath, meta.main)
    if (fs.existsSync(main)) return main
  }
  for (const cand of ['index.js', 'index.cjs', 'index.mjs', 'lib/index.js']) {
    const p = path.join(installedPath, cand)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** Scan pluginsDir and merge with config records (enabled flags, git source). */
export function listPlugins(): PluginView[] {
  const { pluginsDir } = getPaths()
  // Normalize through path.resolve so records written with either separator
  // match scanned directories.
  const records = new Map(getConfig().plugins.map((r) => [path.resolve(r.dir), r]))
  const views: PluginView[] = []
  const seen = new Set<string>()

  try {
    for (const name of fs.readdirSync(pluginsDir)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = path.join(pluginsDir, name)
      const stat = fs.statSync(full, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.isFile() && !PLUGIN_EXTS.has(path.extname(name))) continue
      seen.add(path.resolve(full))
      const rec = records.get(path.resolve(full))
      const entry = resolveEntry(full)
      const meta = stat.isDirectory() ? readPackageMeta(full) : {}
      const id = rec?.id ?? meta.name ?? path.basename(name, path.extname(name))
      views.push({
        id,
        entry: entry ?? rec?.entry ?? full,
        dir: full,
        enabled: rec?.enabled ?? true,
        source: rec?.source ?? 'local',
        gitUrl: rec?.gitUrl,
        installedAt: rec?.installedAt ?? stat.mtimeMs,
        missing: entry === null,
        description: meta.description,
        version: meta.version,
      })
    }
  } catch {
    /* pluginsDir not readable yet */
  }

  // Records pointing at removed dirs are reported (and dropped from config on save).
  for (const rec of records.values()) {
    if (!seen.has(path.resolve(rec.dir))) {
      views.push({ ...rec, missing: true })
    }
  }
  return views.sort((a, b) => a.id.localeCompare(b.id))
}

function uniqueTargetDir(base: string): string {
  const parent = path.dirname(base)
  const ext = path.extname(base)
  const stem = path.basename(base, ext)
  let candidate = base
  let i = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${stem}-${i++}${ext}`)
  }
  return candidate
}

/** Install a plugin from a local directory or file path chosen by the user. */
export function addLocalPlugin(srcPath: string): PluginView {
  if (!fs.existsSync(srcPath)) throw new Error(`路径不存在: ${srcPath}`)
  const { pluginsDir } = getPaths()
  const target = uniqueTargetDir(path.join(pluginsDir, path.basename(srcPath.replace(/[\\/]+$/, ''))))
  fs.cpSync(srcPath, target, { recursive: true })
  const entry = resolveEntry(target)
  if (!entry) {
    // Roll back a copy we cannot load.
    rmRobust(target)
    throw new Error('所选内容不是可识别的插件（未找到入口：package.json main / index.js）')
  }
  const meta = fs.statSync(target).isDirectory() ? readPackageMeta(target) : {}
  const id = meta.name ?? path.basename(target)
  const record: PluginRecord = {
    id,
    entry,
    dir: target,
    enabled: true,
    source: 'local',
    installedAt: Date.now(),
  }
  mutateConfig((draft) => {
    draft.plugins = draft.plugins.filter((p) => p.dir !== target)
    draft.plugins.push(record)
  })
  appLog.info(`Installed local plugin ${id} -> ${entry}`)
  return { ...record, missing: false, description: meta.description, version: meta.version }
}

function gitAvailable(): boolean {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  return res.status === 0
}

/** Common monorepo subdirectory patterns to scan when root has no plugin entry. */
const MONOREPO_PATTERNS = ['packages', 'plugins']

/**
 * Scan known monorepo subdirectories under `repoDir` for valid plugin entries.
 * Returns an array of absolute paths to subdirectories that contain a plugin entry.
 */
function scanSubdirPlugins(repoDir: string): string[] {
  const found: string[] = []
  for (const pattern of MONOREPO_PATTERNS) {
    const subdir = path.join(repoDir, pattern)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(subdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const candidate = path.join(subdir, entry.name)
      if (resolveEntry(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Clone a git repo asynchronously (does not block the Electron main thread).
 */
function cloneGitAsync(cloneUrl: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--depth', '1', cloneUrl, target], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const chunks: Buffer[] = []
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr?.on('data', (c: Buffer) => chunks.push(c))
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('git clone 超时（5 分钟）'))
    }, 5 * 60_000)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`git clone 失败: ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`git clone 执行失败: ${err.message}`))
    })
  })
}

/**
 * Clone a plugin repo into pluginsDir (shallow), using stored GitHub creds when the URL is github.com.
 * Supports monorepo layouts — if the repo root has no plugin entry, scans `packages/*` and `plugins/*`
 * subdirectories and installs every valid plugin found.
 * Returns an array (may contain multiple plugins for monorepos).
 */
export function addGitPlugin(repoUrl: string): Promise<PluginView[]> {
  return (async () => {
    if (!gitAvailable()) throw new Error('未检测到 git，请先安装 Git')
    if (!/^https?:\/\//.test(repoUrl)) throw new Error('仅支持 https:// 开头的仓库地址')
    const { pluginsDir, credentialsFile } = getPaths()

    // Credentials are read at runtime only, injected per-clone, never logged.
    let creds: { githubUser?: string; githubToken?: string } = {}
    try {
      creds = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
    } catch {
      /* no credentials */
    }
    let cloneUrl = repoUrl
    if (creds.githubToken && /^https:\/\/(www\.)?github\.com\//.test(repoUrl)) {
      cloneUrl = repoUrl.replace(
        /^(https:\/\/)(?:www\.)?github\.com\//,
        `$1${encodeURIComponent(creds.githubUser ?? 'oauth2')}:${encodeURIComponent(creds.githubToken)}@github.com/`,
      )
    }

    const repoName = repoUrl.replace(/[\\/]+$/, '').split('/').pop() ?? 'plugin'
    const name = repoName.replace(/\.git$/, '')
    const cloneTarget = uniqueTargetDir(path.join(pluginsDir, name))
    appLog.info(`Cloning plugin from ${repoUrl} (credentials never logged)`)

    await cloneGitAsync(cloneUrl, cloneTarget)
    rmRobust(path.join(cloneTarget, '.git'))

    // Try root-level plugin entry first
    const rootEntry = resolveEntry(cloneTarget)
    if (rootEntry) {
      const meta = readPackageMeta(cloneTarget)
      const id = meta.name ?? name
      const record: PluginRecord = {
        id,
        entry: rootEntry,
        dir: cloneTarget,
        enabled: true,
        source: 'git',
        gitUrl: repoUrl,
        installedAt: Date.now(),
      }
      mutateConfig((draft) => {
        draft.plugins = draft.plugins.filter((p) => p.dir !== cloneTarget)
        draft.plugins.push(record)
      })
      appLog.info(`Installed git plugin ${id} -> ${rootEntry}`)
      return [{ ...record, missing: false, description: meta.description, version: meta.version }]
    }

    // Root has no plugin entry — scan monorepo subdirectories
    const subdirs = scanSubdirPlugins(cloneTarget)
    if (subdirs.length === 0) {
      rmRobust(cloneTarget)
      throw new Error('仓库中未找到插件入口（根目录及 packages/*/ plugins/*/ 均无有效插件）')
    }

    const views: PluginView[] = []
    for (const subdir of subdirs) {
      const entry = resolveEntry(subdir)!
      const meta = readPackageMeta(subdir)
      const subName = path.basename(subdir)
      const id = meta.name ?? subName
      const target = uniqueTargetDir(path.join(pluginsDir, subName))
      fs.cpSync(subdir, target, { recursive: true })
      const resolvedEntry = resolveEntry(target) ?? entry
      const record: PluginRecord = {
        id,
        entry: resolvedEntry,
        dir: target,
        enabled: true,
        source: 'git',
        gitUrl: repoUrl,
        installedAt: Date.now(),
      }
      mutateConfig((draft) => {
        draft.plugins = draft.plugins.filter((p) => p.dir !== target)
        draft.plugins.push(record)
      })
      appLog.info(`Installed git plugin ${id} from ${subName} -> ${resolvedEntry}`)
      views.push({ ...record, missing: false, description: meta.description, version: meta.version })
    }
    // Clean up the bare clone — plugins have been copied to their own directories
    rmRobust(cloneTarget)
    return views
  })()
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  mutateConfig((draft) => {
    const rec = draft.plugins.find((p) => p.id === id)
    if (rec) rec.enabled = enabled
  })
}

export function removePlugin(id: string): void {
  const rec = getConfig().plugins.find((p) => p.id === id)
  if (!rec) return
  try {
    rmRobust(rec.dir)
  } catch (err) {
    appLog.warn(`Failed to delete plugin dir ${rec.dir}: ${err}`)
  }
  mutateConfig((draft) => {
    draft.plugins = draft.plugins.filter((p) => p.id !== id)
  })
  appLog.info(`Removed plugin ${id}`)
}

/**
 * Write the generated cordis patch overlay. Entry paths are absolute; on
 * Windows they must be file:// URLs — dsh's ESM loader rejects `Y:\...`
 * style paths (only file:, data: and node: schemes are importable).
 */
export function writePatchOverlay(enabled: Array<{ id: string; entry: string }>): string {
  const file = getPaths().patchFile
  const lines = ['# Generated by DSH Desktop — plugin overlay. Do not edit.', '- insert:']
  for (const p of enabled) {
    const entryRef =
      process.platform === 'win32' ? pathToFileURL(p.entry).href : p.entry
    lines.push(`    - id: ${JSON.stringify(p.id)}`)
    lines.push(`      name: '${entryRef}'`)
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  appLog.info(`Wrote patch overlay ${file} (${enabled.length} plugin(s))`)
  return file
}
