/**
 * pnpm supply-chain policy for dsh profiles.
 *
 * pnpm (>= 10) enforces two profile-scoped gates that fail `dsh plugin add`
 * until the profile's own policy file (pnpm-workspace.yaml) authorizes the
 * exact packages involved:
 *
 *  1. build-script gate — dependency build scripts are blocked by default.
 *     Git-hosted plugins (e.g. GitHub installs) are the sharpest case:
 *     their `prepare` script is refused with
 *     `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` until the exact package spec is
 *     added under `allowBuilds`; registry packages with lifecycle scripts are
 *     listed via `Ignored build scripts: ...`.
 *  2. release-age gate — pnpm >= 11 rejects lockfile entries published
 *     inside the `minimumReleaseAge` cutoff with
 *     `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` /
 *     `NO_MATURE_MATCHING_VERSION`. This breaks ANY install while a
 *     recently-published dependency (e.g. `dshmarket@1.31.2`,
 *     `@linxin666/dsh-chat-recovery@0.3.5`) sits in the profile lockfile.
 *
 * dsh-desktop never edits deepseek-harness itself — it only sets the
 * profile's OWN policy file (pnpm-workspace.yaml) the harness already reads.
 *
 * dsh-desktop opens the managed profile's pnpm policy so NO pnpm behavior is
 * ever intercepted: `minimumReleaseAge: 0` disables the fresh-release hold
 * and `dangerouslyAllowAllBuilds: true` runs every dependency build script
 * (see openProfilePnpmPolicy). The legacy per-ref authorizers below remain
 * for profiles that were set up before the open policy and are kept
 * idempotent, but the desktop's install path no longer surfaces release-age
 * or build-script gates to the user — pnpm simply runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { appLog } from '../../logger'
import { resolveProfileDir, resolveProfileManifestPath } from './profilePaths'

// ---- types ----

export interface BlockedBuildInfo {
  /** Exact package specs for `allowBuilds` (e.g. `pkg@https://.../tar.gz/<sha>`). */
  keys: string[]
  /** Plain package names (scope included) for `pnpm.onlyBuiltDependencies`. */
  names: string[]
}

/**
 * Packages the pnpm minimumReleaseAge gate wants excluded. Each ref is a
 * `name@version` (or `name@range`) spec written verbatim under
 * `minimumReleaseAgeExclude` in pnpm-workspace.yaml.
 */
export interface ReleaseAgeInfo {
  /** Exact `name@version` refs pnpm rejected as too young. */
  refs: string[]
}

export interface BuildAuthorizeResult {
  /** Path of the pnpm-workspace.yaml that was updated (or created). */
  workspacePath: string
  /** Path of the profile manifest updated with `pnpm.onlyBuiltDependencies`. */
  manifestPath: string
  /** Specs added under `allowBuilds`. */
  keys: string[]
  /** Names added to `pnpm.onlyBuiltDependencies`. */
  names: string[]
}

/** File name of pnpm's workspace policy inside a profile directory. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/** Signal phrases that identify a blocked-build failure regardless of pnpm
 * major version / wording. Case-insensitive matching is applied by the
 * caller (`hasBlockedBuildSignal`). */
const BLOCKED_SIGNALS = [
  'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED',
  'ERR_PNPM_IGNORED_BUILDS',
  'ignored build scripts',
  'not in the "allowbuilds" allowlist',
  'needs to execute build scripts',
  'blocked by pnpm by default',
  'pnpm blocks until allowed',
] as const

/** `: true` suffix of a key line inside pnpm's `allowBuilds:` example block. */
const ALLOW_KEY_SUFFIX = ': true'

// ---- detection ----

/** True when the output contains a blocked-build signal. */
export function hasBlockedBuildSignal(output: string): boolean {
  const lower = output.toLowerCase()
  return BLOCKED_SIGNALS.some((signal) => lower.includes(signal.toLowerCase()))
}

/** Strip `@<version>` / `@<spec>` off a package reference to get its name. */
function packageNameFromRef(ref: string): string {
  // `@scope/name@https://...#sha` -> `@scope/name`; `name@git+...#sha` -> `name`.
  const at = ref.startsWith('@') ? ref.indexOf('@', 1) : ref.indexOf('@')
  return at > 0 ? ref.slice(0, at) : ref
}

/**
 * Extract the package keys pnpm printed inside an `allowBuilds:` example
 * block (the exact specs it wants allowlisted). Lines look like:
 *
 *   allowBuilds:
 *     pkg@https://codeload.github.com/owner/repo/tar.gz/<sha>: true
 *
 * The specs legitimately contain colons (URLs), so each line is taken
 * verbatim minus the trailing `: true`.
 */
function keysFromAllowBuildsExample(lines: string[]): string[] {
  const keys: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== 'allowBuilds:') continue
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (!/^\s/.test(line) || line.trim() === '') break
      if (line.trim().endsWith(ALLOW_KEY_SUFFIX)) {
        keys.push(line.trim().slice(0, -ALLOW_KEY_SUFFIX.length))
      }
    }
  }
  return keys
}

/**
 * Extract plain package names from pnpm's `Ignored build scripts: a, b, c.`
 * list. Entries may carry a version suffix (`cloudflared@0.7.3`) and the
 * sentence may end with a period followed by pnpm's "Run pnpm approve-builds"
 * hint on the same line (older pnpm); each token is trimmed to the first
 * whitespace-delimited word, stripped of a trailing period, and reduced to
 * the bare name via `packageNameFromRef`.
 */
function namesFromIgnoredBuildScripts(output: string): string[] {
  const names: string[] = []
  const re = /ignored build scripts:?\s*([^\r\n]+)/gi
  for (const match of output.matchAll(re)) {
    for (const part of match[1].split(',')) {
      const token = part.trim().split(/\s+/)[0]?.replace(/\.$/, '') ?? ''
      if (token === '') continue
      const name = packageNameFromRef(token)
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Detect whether a CLI failure was pnpm refusing dependency build scripts,
 * and extract the packages it wants allowlisted.
 *
 * Recognized sources:
 *  - pnpm 11 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` (git/GitHub plugins) —
 *    full spec keys come from the embedded `allowBuilds:` example block;
 *  - pnpm `ERR_PNPM_IGNORED_BUILDS` / `Ignored build scripts: ...` — plain
 *    package names;
 *  - the dsh CLI hint and any wording carrying "build scripts are blocked by
 *    pnpm by default".
 *
 * Returns an empty info when the output is unrelated to build-script policy.
 */
export function parseBlockedBuildInfo(output: string): BlockedBuildInfo {
  const keys: string[] = []
  const names: string[] = []

  if (hasBlockedBuildSignal(output)) {
    const lines = output.split(/\r?\n/)
    for (const key of keysFromAllowBuildsExample(lines)) {
      if (!keys.includes(key)) keys.push(key)
    }
    for (const name of namesFromIgnoredBuildScripts(output)) {
      if (!names.includes(name)) names.push(name)
    }
    // Git-dep failures also name the package (`"pkg@1.0.0"`) even when no
    // example block is present — keep those as plain names too.
    const gitPkg = /the git-hosted package "([^"]+)"/i.exec(output)
    if (gitPkg) {
      const name = packageNameFromRef(gitPkg[1])
      if (!names.includes(name)) names.push(name)
      // The stable allowBuilds key pnpm 11.21+ matches is
      // `name@git+https://github.com/owner/repo.git`, derived from the repo
      // named by the fetched codeload URL in the same error line — NOT the
      // commit-pinned codeload key pnpm prints as an example (which changes
      // on every push, so the retry would fail again). Both are authorized:
      // the pinned form covers pnpm < 11.21, the stable form covers the rest.
      const codeload = /codeload\.github\.com\/([^/\s]+)\/([^/\s]+)\/tar\.gz\/[0-9a-f]{7,40}/i.exec(output)
      if (codeload) {
        const owner = codeload[1]
        const repo = codeload[2].replace(/\.git$/, '')
        const stable = `${name}@git+https://github.com/${owner}/${repo}.git`
        if (!keys.includes(stable)) keys.push(stable)
      }
    }
  }

  return { keys, names }
}

// ---- release-age gate ----

/** Signal phrases that identify a minimumReleaseAge failure. */
const RELEASE_AGE_SIGNALS = [
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'MINIMUM_RELEASE_AGE_VIOLATION',
  'NO_MATURE_MATCHING_VERSION',
  'minimumReleaseAge cutoff',
  'does not meet the minimumReleaseAge',
  'minimumReleaseAge constraint',
] as const

/** True when the output contains a minimumReleaseAge-blocked signal. */
export function hasReleaseAgeSignal(output: string): boolean {
  const lower = output.toLowerCase()
  return RELEASE_AGE_SIGNALS.some((signal) => lower.includes(signal.toLowerCase()))
}

/**
 * Extract the `name@version` refs pnpm rejected as too young. Sources:
 *  - lockfile verification: `  name@1.2.3 was published at ...`, within the
 *    minimumReleaseAge cutoff (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`);
 *  - resolution strict mode: `name@1.2.3 was published at ...` on its own
 *    line (`NO_MATURE_MATCHING_VERSION`);
 *  - the `failOnImmature` list: `  name@1.2.3 ...not meet the
 *    minimumReleaseAge constraint`.
 */
export function parseReleaseAgeInfo(output: string): ReleaseAgeInfo {
  const refs: string[] = []
  if (!hasReleaseAgeSignal(output)) return { refs }
  const outputLines = output.split(/\r?\n/)
  for (const line of outputLines) {
    // Entry lines are indented: `  name@1.2.3 was published at ...`.
    if (!/^\s+[@a-zA-Z0-9]/.test(line)) continue
    const trimmed = line.trim()
    const m = /^([@a-zA-Z0-9][^\s@]*@[^\s]+?)\s/.exec(trimmed)
    if (!m) continue
    const ref = m[1]
    // A ref that carries the error code is not a package entry.
    if (/ERR_|VIOLATION|cutoff/i.test(ref)) continue
    if (!refs.includes(ref)) refs.push(ref)
  }
  // Fallback: `The git-hosted package "name@1.0.0"` (git installs) — keep the name.
  if (refs.length === 0) {
    const gitPkg = /the git-hosted package "([^"]+)"/i.exec(output)
    if (gitPkg) {
      const name = packageNameFromRef(gitPkg[1])
      if (name) refs.push(name)
    }
  }
  return { refs }
}

// ---- authorization ----

interface WorkspaceDoc {
  packages?: string | string[]
  [key: string]: unknown
}

/** Read the profile's pnpm-workspace.yaml, tolerating absence / bad YAML. */
function readWorkspace(dir: string): { doc: WorkspaceDoc; existed: boolean } {
  const file = path.join(dir, WORKSPACE_FILE)
  if (!fs.existsSync(file)) return { doc: {}, existed: false }
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
    return { doc: (parsed && typeof parsed === 'object' ? parsed : {}) as WorkspaceDoc, existed: true }
  } catch (err) {
    appLog.warn(`pnpm-workspace.yaml unreadable, rewriting: ${String(err)}`)
    return { doc: {}, existed: true }
  }
}

/** Write the workspace doc back to disk. */
function writeWorkspace(dir: string, doc: WorkspaceDoc): string {
  const file = path.join(dir, WORKSPACE_FILE)
  fs.mkdirSync(dir, { recursive: true })
  // Profiles are single-package workspaces; keep `packages` explicit so pnpm
  // always treats the file as a workspace root and honors allowBuilds.
  if (!doc.packages) doc.packages = ['.']
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1 }), 'utf8')
  return file
}

/** Merge specs into the `allowBuilds` map (value `true` = build allowed). */
function mergeAllowBuilds(doc: WorkspaceDoc, keys: string[]): string[] {
  const existing = doc.allowBuilds as Record<string, unknown> | undefined
  const allowBuilds: Record<string, unknown> =
    existing && typeof existing === 'object' ? { ...existing } : {}
  const added: string[] = []
  for (const key of keys) {
    if (allowBuilds[key] !== true) {
      allowBuilds[key] = true
      added.push(key)
    }
  }
  doc.allowBuilds = allowBuilds
  return added
}

/** Merge plain names into the manifest's `pnpm.onlyBuiltDependencies`. */
function mergeOnlyBuiltDependencies(profile: string, names: string[]): string[] {
  const file = resolveProfileManifestPath(profile)
  let manifest: { pnpm?: { onlyBuiltDependencies?: string[] } } = {}
  if (fs.existsSync(file)) {
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof manifest
    } catch (err) {
      appLog.warn(`profile manifest unreadable, rewriting: ${String(err)}`)
      manifest = {}
    }
  }
  const list = Array.isArray(manifest.pnpm?.onlyBuiltDependencies)
    ? [...manifest.pnpm.onlyBuiltDependencies]
    : []
  const added: string[] = []
  for (const name of names) {
    if (!list.includes(name)) {
      list.push(name)
      added.push(name)
    }
  }
  manifest.pnpm = { ...manifest.pnpm, onlyBuiltDependencies: list }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
  return added
}

/**
 * Authorize pnpm to run the given packages' build scripts inside a profile.
 *
 * Writes two places, both owned by the profile (never by deepseek-harness
 * source):
 *  1. `allowBuilds` specs in `<profile>/pnpm-workspace.yaml` — the mechanism
 *     pnpm 11 / pnpm >= 10.26 reads (the one the dsh CLI points at);
 *  2. plain names in `<profile>/package.json` `pnpm.onlyBuiltDependencies` —
 *     the pnpm 9 / pnpm 10 <= 10.25 fallback.
 *
 * Idempotent: existing entries are kept, already-true keys are not repeated.
 */
export function authorizeBuildScripts(profile: string, info: BlockedBuildInfo): BuildAuthorizeResult {
  const dir = resolveProfileDir(profile)
  const keys = Array.from(new Set(info.keys.filter((k) => k.trim().length > 0)))
  const names = Array.from(new Set(info.names.filter((n) => n.trim().length > 0)))

  let workspacePath: string
  let keysAdded: string[] = []
  if (keys.length > 0 || names.length > 0) {
    const { doc } = readWorkspace(dir)
    // pnpm 11 reads `allowBuilds` keys for BOTH failure shapes:
    //  - `ERR_PNPM_IGNORED_BUILDS` matches a bare package name entry
    //    (`cloudflared: true`, verified against pnpm 11.22);
    //  - `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` matches the stable
    //    `name@git+https://…` key derived in parseBlockedBuildInfo.
    // The plain names therefore go into pnpm-workspace.yaml as well — writing
    // them only to package.json `pnpm.onlyBuiltDependencies` is ignored by
    // pnpm 11 and the retry would fail again with the same error.
    keysAdded = mergeAllowBuilds(doc, [...keys, ...names])
    workspacePath = writeWorkspace(dir, doc)
    appLog.info(
      `pnpm build policy: allowed ${keysAdded.length} key(s) in ${WORKSPACE_FILE} (profile ${profile})`,
    )
  } else {
    workspacePath = path.join(dir, WORKSPACE_FILE)
    appLog.info(`pnpm build policy: no specs to allow for profile ${profile}`)
  }

  // pnpm 9 / pnpm 10 <= 10.25 fallback: the plain names also land in
  // package.json `pnpm.onlyBuiltDependencies` so older pnpm honors the
  // same approval (newer pnpm simply ignores the key).
  const namesAdded = names.length > 0 ? mergeOnlyBuiltDependencies(profile, names) : []
  if (namesAdded.length > 0) {
    appLog.info(`pnpm build policy: added ${namesAdded.length} name(s) to pnpm.onlyBuiltDependencies (pnpm 9/10 fallback)`)
  }

  return { workspacePath, manifestPath: resolveProfileManifestPath(profile), keys: keysAdded, names: namesAdded }
}

/**
 * Fully open pnpm's supply-chain gates inside a managed profile so no pnpm
 * behavior is ever intercepted by dsh-desktop:
 *
 *  - `minimumReleaseAge: 0` disables pnpm's fresh-release hold entirely
 *    (the gate that rejected recently-published plugins like dsh-git-graph's
 *    dependency tree with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION /
 *    NO_MATURE_MATCHING_VERSION until exact refs were excluded);
 *  - `dangerouslyAllowAllBuilds: true` runs every dependency build script,
 *    so git-hosted plugins (their `prepare`/prepack step) install in one
 *    shot instead of being blocked by ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED /
 *    ERR_PNPM_IGNORED_BUILDS.
 *
 * This is a policy the profile itself owns (pnpm-workspace.yaml) — it never
 * touches deepseek-harness code. Idempotent: existing content is preserved
 * and re-running is a no-op once the keys are set.
 */
export function openProfilePnpmPolicy(profile: string): { workspacePath: string; changed: boolean } {
  const dir = resolveProfileDir(profile)
  const { doc } = readWorkspace(dir)
  const changed = doc.minimumReleaseAge !== 0 || doc.dangerouslyAllowAllBuilds !== true
  doc.minimumReleaseAge = 0
  doc.dangerouslyAllowAllBuilds = true
  const workspacePath = writeWorkspace(dir, doc)
  if (changed) {
    appLog.info(
      `pnpm policy: opened profile ${profile} (minimumReleaseAge=0, dangerouslyAllowAllBuilds) in ${WORKSPACE_FILE}`,
    )
  }
  return { workspacePath, changed }
}

/**
 * Authorize pnpm's minimumReleaseAge gate to skip the given package refs
 * inside a profile by merging them into `minimumReleaseAgeExclude` in the
 * profile's pnpm-workspace.yaml (the policy file pnpm 11 reads — the same
 * file dsh itself points at when it prints the gate error).
 *
 * Idempotent: existing refs are kept, exact duplicates are not repeated.
 * Returns the refs actually added (empty when all were already excluded).
 */
export function authorizeReleaseAgeExcludes(
  profile: string,
  info: ReleaseAgeInfo,
): { workspacePath: string; added: string[] } {
  const dir = resolveProfileDir(profile)
  const refs = Array.from(new Set(info.refs.filter((r) => r.trim().length > 0)))
  if (refs.length === 0) {
    return { workspacePath: path.join(dir, WORKSPACE_FILE), added: [] }
  }
  const { doc } = readWorkspace(dir)
  const existing = Array.isArray(doc.minimumReleaseAgeExclude)
    ? [...(doc.minimumReleaseAgeExclude as string[])]
    : []
  const added: string[] = []
  for (const ref of refs) {
    if (!existing.includes(ref)) {
      existing.push(ref)
      added.push(ref)
    }
  }
  if (added.length === 0) {
    return { workspacePath: path.join(dir, WORKSPACE_FILE), added: [] }
  }
  doc.minimumReleaseAgeExclude = existing
  const workspacePath = writeWorkspace(dir, doc)
  appLog.info(
    `pnpm release-age policy: excluded ${added.length} ref(s) in ${WORKSPACE_FILE} (profile ${profile})`,
  )
  return { workspacePath, added }
}
