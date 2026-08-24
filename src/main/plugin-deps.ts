/**
 * Plugin dependency detection + install. Plugins copied from disk or git
 * arrive without their npm dependencies; DSH's cordis loader then aborts with
 * ERR_MODULE_NOT_FOUND when it imports the plugin entry. This module probes
 * each plugin dir's package.json and runs `npm install` (serialized through
 * the resolved Node runtime) only when something is missing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { nodeRuntime } from './dsh/nodebin'
import { npmCliPath } from './paths'
import { appLog } from './logger'

export interface PluginDepsResult {
  status: 'skipped' | 'installed' | 'failed'
  error?: string
  durationMs?: number
}

const INSTALL_TIMEOUT_MS = 10 * 60_000
const NPM_FLAGS = ['install', '--no-audit', '--no-fund', '--loglevel=error']

/** True when the plugin dir declares dependencies that cannot be resolved yet. */
export function needsDepsInstall(dir: string): boolean {
  let meta: { dependencies?: Record<string, string> }
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    // No (or unparseable) package.json — nothing to install.
    return false
  }
  const deps = meta.dependencies
  if (!deps || Object.keys(deps).length === 0) return false
  for (const name of Object.keys(deps)) {
    try {
      require.resolve(name, { paths: [dir] })
    } catch {
      return true
    }
  }
  return false
}

/** True when `npm` is on PATH (Windows resolves npm.cmd through a shell). */
function npmOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['--version'], { windowsHide: true, shell: process.platform === 'win32', stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * Pick the npm invocation: the npm bundled next to the Node runtime (system
 * node ships one), else the vendored npm inside the bundled DSH runtime (covers
 * machines with only the embedded Electron node), else `npm` on PATH.
 * Synchronous probing only — the actual install runs async.
 */
async function resolveNpmInvocation(): Promise<{
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
  label: string
} | null> {
  const node = nodeRuntime()
  const nearNode = path.join(path.dirname(node.command), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(nearNode)) {
    return { command: node.command, argsPrefix: [...node.argsPrefix, nearNode], env: node.env, label: node.label }
  }
  const vendored = npmCliPath()
  if (vendored) {
    return { command: node.command, argsPrefix: [...node.argsPrefix, vendored], env: node.env, label: `${node.label} + vendored npm` }
  }
  if (await npmOnPath()) {
    return { command: 'npm', argsPrefix: [], env: { ...process.env }, label: 'npm (PATH)' }
  }
  return null
}

function pluginId(dir: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
    return meta.name || path.basename(dir)
  } catch {
    return path.basename(dir)
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

// Best-effort kill of any in-flight install; wired into the app-quit cleanup.
let activeChild: ChildProcess | null = null
export function terminateActiveInstall(): void {
  if (activeChild) {
    killTree(activeChild)
    activeChild = null
  }
}

// Serialized installs: concurrent npm runs fight over the lock and the same
// node_modules tree, so every install waits on the previous one.
let queue: Promise<unknown> = Promise.resolve()

export function installPluginDeps(dir: string): Promise<PluginDepsResult> {
  const task = queue.then(() => runInstall(dir))
  // A failed install must not poison the queue for later plugins.
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

async function runInstall(dir: string): Promise<PluginDepsResult> {
  if (!needsDepsInstall(dir)) return { status: 'skipped' }
  const started = Date.now()
  const id = pluginId(dir)
  const inv = await resolveNpmInvocation()
  const fail = (error: string): PluginDepsResult => {
    appLog.info(`Dep install failed for ${id}: ${error}`)
    return { status: 'failed', error, durationMs: Date.now() - started }
  }
  if (!inv) {
    return fail('未检测到 npm，无法安装插件依赖')
  }
  const args = [...inv.argsPrefix, ...NPM_FLAGS]
  appLog.info(`Installing deps for ${id}: ${inv.label} ${args.join(' ')} (cwd ${dir})`)

  return await new Promise<PluginDepsResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(inv.command, args, {
        cwd: dir,
        env: { ...inv.env, npm_config_update_notifier: 'false' },
        windowsHide: true,
        shell: inv.command === 'npm' && process.platform === 'win32',
      })
    } catch (err) {
      resolve(fail(`依赖安装失败：无法启动 npm（${String(err)}）`))
      return
    }
    activeChild = child
    const chunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.stderr?.on('data', (c: Buffer) => chunks.push(c))
    let finished = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, INSTALL_TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = null
    }
    child.on('error', (err) => {
      if (finished) return
      finished = true
      done()
      resolve(fail(`依赖安装失败：无法启动 npm（${err.message}）`))
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      done()
      if (timedOut) {
        resolve(fail('依赖安装超时（10 分钟），已终止安装进程'))
        return
      }
      if (code === 0) {
        const ms = Date.now() - started
        appLog.info(`Installed deps for ${id} in ${ms}ms`)
        resolve({ status: 'installed', durationMs: ms })
        return
      }
      const tail = Buffer.concat(chunks).toString('utf8').trim().slice(-500)
      resolve(fail(`依赖安装失败（npm 退出码 ${code}）${tail ? `: ${tail}` : ''}`))
    })
  })
}

/** Awaitable summary used by callers that only need ok/error. */
export async function ensurePluginDeps(dir: string): Promise<'ok' | { error: string }> {
  const res = await installPluginDeps(dir)
  return res.status === 'failed' ? { error: res.error ?? '依赖安装失败' } : 'ok'
}