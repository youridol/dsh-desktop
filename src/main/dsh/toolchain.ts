/**
 * Node / package-manager toolchain discovery for harness child processes.
 *
 * deepseek-harness resolves `pnpm` / `npm` / `npx` as plain PATH commands
 * (the `dsh plugin` command forwards to `spawnSync("pnpm", ..., { shell:
 * win32 })`; version installs and the bundled CLI use npm the same way).
 * dsh-desktop must therefore guarantee that the user's standard toolchain
 * directories are on PATH for every harness process it spawns — otherwise a
 * shortcut / autostart launch with a trimmed or shadowed PATH makes the
 * harness's own npm / npx / pnpm resolution fail (ENOENT / exit 127) even
 * though dsh-desktop itself still works (it resolves node explicitly).
 *
 * This module ONLY prepares the environment (PATH augmentation). It never
 * proxies, intercepts, rewrites or substitutes any package-manager command:
 * the harness keeps choosing and invoking npm / npx / pnpm itself, exactly as
 * upstream behaves.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** PATH separator on win32 (the only platform this app targets). */
const PATH_SEP = process.platform === 'win32' ? ';' : ':'

/** True when the directory currently holds an npm / npx / pnpm entry. */
function hasPackageManagerShim(dir: string): boolean {
  if (!dir || !fs.existsSync(dir)) return false
  const names = ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'pnpm', 'pnpm.cmd', 'pnpm.CMD', 'pnpm.ps1', 'pnpm.exe']
  return names.some((name) => fs.existsSync(path.join(dir, name)))
}

/**
 * Process-side probes used by the real (non-test) discovery. Injecting them
 * lets unit tests exercise the pure path logic hermetically.
 */
export interface ToolchainProbe {
  /** Directory containing the node that will run the harness, or null. */
  nodeDir(): string | null
  /** npm's configured global prefix, or null. */
  npmPrefix(): string | null
}

/**
 * Directory of the Node runtime that will run the harness (or null).
 * Resolved from `where node` first; falls back to the standard per-user /
 * per-machine install locations for PATHs too trimmed for `where`.
 */
export function probeNodeDir(): string | null {
  const override = process.env.DSH_DESKTOP_NODE
  if (override && override.trim()) {
    return path.dirname(override.trim())
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where node' : 'which node', {
    shell: true,
    encoding: 'utf8',
    timeout: 5000,
  })
  const first = probe.status === 0 ? (probe.stdout || '').trim().split(/\r?\n/)[0] : ''
  if (first) return path.dirname(first)
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const candidates = [
    path.join(programFiles, 'nodejs'),
    path.join(programFiles.replace(' (x86)', ''), 'nodejs'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm'),
    path.join(os.homedir(), 'scoop', 'apps', 'nodejs', 'current'),
  ]
  return candidates.find((c) => fs.existsSync(path.join(c, 'node.exe'))) ?? null
}

/**
 * npm's configured global prefix (where global bins land, e.g.
 * `C:\home\user\.npm-global`), or null when npm is unavailable.
 * Queried once and cached — this is a stable machine-level value.
 */
let cachedNpmPrefix: string | null | undefined

export function probeNpmPrefix(): string | null {
  if (cachedNpmPrefix !== undefined) return cachedNpmPrefix
  try {
    // npm is a .cmd on Windows — like the harness's own spawnSync("pnpm",
    // shell: true), the query must go through cmd.exe so PATHEXT resolves it.
    // Args are fully static, so the shell-string form is safe here (and avoids
    // the Node ≥ 24 args-with-shell deprecation).
    const cmd = 'npm prefix -g --no-update-notifier --no-audit --no-fund --loglevel=error'
    const res = spawnSync(cmd, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    const prefix = res.status === 0 ? (res.stdout || '').trim() : ''
    cachedNpmPrefix = prefix || null
  } catch {
    cachedNpmPrefix = null
  }
  return cachedNpmPrefix
}

/** Test hook: reset the cached npm prefix. */
export function resetNpmPrefixCache(): void {
  cachedNpmPrefix = undefined
}

/** The real process probes (default). */
export const realProbe: ToolchainProbe = {
  nodeDir: probeNodeDir,
  npmPrefix: probeNpmPrefix,
}

/**
 * Candidate directories where npm / npx / pnpm shims live on a Windows
 * install, computed purely from an environment + probe. Each is only
 * included when it actually exists and holds at least one of the
 * package-manager commands, so a bare directory never pollutes PATH.
 */
export function toolchainDirs(
  env: NodeJS.ProcessEnv = process.env,
  probe: ToolchainProbe = realProbe,
): string[] {
  const dirs: string[] = []
  const home = env.USERPROFILE || os.homedir()
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')

  const pushIf = (d: string | null | undefined): void => {
    if (d && hasPackageManagerShim(d) && !dirs.includes(path.resolve(d))) dirs.push(path.resolve(d))
  }

  // The Node install dir (npm / npx ship there by default).
  pushIf(probe.nodeDir())

  // npm's configured global prefix (custom prefixes from .npmrc).
  pushIf(probe.npmPrefix())

  // npm's default global bin dir.
  pushIf(path.join(appData, 'npm'))

  // pnpm's default global bin (pnpm ≥ 8) and the legacy pnpm setup dir.
  pushIf(path.join(localAppData, 'pnpm'))
  pushIf(path.join(home, '.pnpm', 'bin'))

  // Version managers commonly used on Windows.
  pushIf(path.join(home, '.nvm'))
  pushIf(path.join(home, '.volta', 'bin'))

  return dirs
}

/**
 * Augment an environment with the discovered toolchain dirs prepended to
 * PATH. Existing PATH entries are preserved verbatim; duplicates are removed;
 * only existing shim-bearing dirs are added — a no-op when nothing extra is
 * found. Never touches any other variable.
 */
export function withToolchain(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = env.PATH || process.env.PATH || ''
  const existing = base
    .split(PATH_SEP)
    .map((p) => p.trim())
    .filter(Boolean)

  const additions = toolchainDirs().filter(
    (dir) => !existing.some((p) => p.toLowerCase() === dir.toLowerCase()),
  )

  const next = { ...env }
  if (additions.length > 0) {
    next.PATH = [...additions, ...existing].join(PATH_SEP)
  }
  return next
}
