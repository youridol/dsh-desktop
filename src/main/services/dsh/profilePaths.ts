/**
 * Shared DSH home / profile path resolution.
 *
 * The harness keeps all user data under a single root (`$DSH_HOME`, falling
 * back to `~/.dsh`) and every profile lives at `<home>/profiles/<name>`
 * (see `@deepseek-ai/dsh-home-paths` `resolveDshHome`). dsh-desktop must
 * resolve exactly the same directory the `dsh` CLI operates on, so profile
 * reads, writes and pnpm policy edits all agree with the harness.
 */
import os from 'node:os'
import path from 'node:path'

/** Resolve the DSH home root: `$DSH_HOME` (non-blank) or `~/.dsh`. */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : path.join(os.homedir(), '.dsh')
}

/** Absolute directory of a profile: `$DSH_HOME/profiles/<profile>`. */
export function resolveProfileDir(profile: string): string {
  return path.join(resolveDshHome(), 'profiles', profile)
}

/** Absolute path to a profile manifest (`package.json`). */
export function resolveProfileManifestPath(profile: string): string {
  return path.join(resolveProfileDir(profile), 'package.json')
}
