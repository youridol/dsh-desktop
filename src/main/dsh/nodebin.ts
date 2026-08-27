/**
 * Resolve a Node.js runtime used to spawn DSH and npm.
 *
 * Preference order:
 *  1. DSH_DESKTOP_NODE env override (power users).
 *  2. A system `node` on PATH — native addons (pty) were installed against the
 *     plain-node ABI, so the system runtime is the safest match when present.
 *  3. This app's own Electron binary in ELECTRON_RUN_AS_NODE mode, so machines
 *     without Node can still run everything.
 *
 * Every invocation inherits the package-manager toolchain PATH (see
 * ./toolchain): deepseek-harness resolves npm / npx / pnpm itself as plain
 * PATH commands, so the child environment must always carry the standard
 * toolchain dirs even when the app was launched from a shortcut with a
 * trimmed PATH.
 */
import { spawnSync } from 'node:child_process'
import { withToolchain } from './toolchain'

export interface NodeInvocation {
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
  label: string
}

let cached: NodeInvocation | null = null

function systemNode(): string | null {
  const probe = process.platform === 'win32' ? 'where node' : 'which node'
  const res = spawnSync(probe, { shell: true, encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0 || !res.stdout.trim()) return null
  const first = res.stdout.trim().split(/\r?\n/)[0]
  return first || null
}

export function nodeRuntime(): NodeInvocation {
  if (cached) return cached
  // dsh's HMR service requires node internals (--expose-internals); harmless
  // for the rest of the runtime, so it is always passed.
  const commonArgs = ['--expose-internals']
  const override = process.env.DSH_DESKTOP_NODE
  if (override) {
    cached = { command: override, argsPrefix: [...commonArgs], env: withToolchain({ ...process.env }), label: override }
    return cached
  }
  const sys = systemNode()
  if (sys) {
    cached = {
      command: sys,
      argsPrefix: [...commonArgs],
      env: withToolchain({ ...process.env }),
      label: `system node (${sys})`,
    }
    return cached
  }
  // ELECTRON_RUN_AS_NODE turns the Electron exe into a plain Node interpreter.
  cached = {
    command: process.execPath,
    argsPrefix: [...commonArgs],
    env: withToolchain({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
    label: `embedded node (${process.execPath})`,
  }
  return cached
}

export function isEmbeddedNode(inv: NodeInvocation): boolean {
  return inv.env.ELECTRON_RUN_AS_NODE === '1'
}
