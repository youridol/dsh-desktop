/**
 * DSH process lifecycle: spawn `dsh web --patch <overlay> --port <n>`, poll the
 * service until it answers, stream output to the log bus, and surface state
 * transitions to every window. Crash exits are detected and reported.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { getPaths, bundledDshDir } from '../paths'
import { getConfig, setConfig } from '../config'
import { appLog, dshLog } from '../logger'
import { nodeRuntime } from './nodebin'
import { resolveActiveDir, ensureBundledRuntime } from './install'
import { installPluginDeps, terminateActiveInstall } from '../plugin-deps'
import { writePatchOverlay, setPluginDepsError } from '../plugins'

export type DshState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'timeout'
  | 'error'

export interface DshStatus {
  state: DshState
  port: number
  serviceUrl: string
  pid: number | null
  startedAt: number | null
  version: string
  versionDir: string | null
  /** Human-readable detail for error/timeout/crashed states. */
  detail: string
  enabledPlugins: string[]
}

export const dshEvents = new EventEmitter()

const READY_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 300

let child: ChildProcess | null = null
let state: DshState = 'stopped'
let detail = ''
let startedAt: number | null = null
let startSeq = 0
let manualStop = false

function currentVersionDir(): string | null {
  return resolveActiveDir(getConfig().activeVersion, bundledDshDir())
}

function currentVersion(): string {
  const active = getConfig().activeVersion
  if (active === 'bundled') return 'bundled'
  return active
}

export function getStatus(): DshStatus {
  const port = getConfig().port
  return {
    state,
    port,
    serviceUrl: `http://127.0.0.1:${port}`,
    pid: child?.pid ?? null,
    startedAt,
    version: currentVersion(),
    versionDir: currentVersionDir(),
    detail,
    enabledPlugins: getConfig().plugins.filter((p) => p.enabled).map((p) => p.id),
  }
}

function setState(next: DshState, why = ''): void {
  state = next
  detail = why
  appLog.info(`DSH state -> ${next}${why ? ` (${why})` : ''}`)
  dshEvents.emit('status', getStatus())
}

export function isAlive(): boolean {
  return state === 'running' || state === 'starting' || state === 'stopping'
}

/** GET the service until it answers (any HTTP status means the listener is up). */
async function pollReady(port: number, seq: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline && seq === startSeq) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1500)
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal })
      clearTimeout(t)
      if (res.status < 500) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

/**
 * Install missing deps for every enabled plugin before the overlay is written.
 * Returns the plugins that can load (deps installed or already satisfied) plus
 * a human-readable warning listing plugins excluded for dep failures.
 */
async function ensureEnabledPluginsReady(
  enabled: Array<{ id: string; entry: string; dir: string }>,
): Promise<{ ready: Array<{ id: string; entry: string }>; warning: string }> {
  const ready: Array<{ id: string; entry: string }> = []
  const failed: Array<{ id: string; reason: string }> = []
  for (const p of enabled) {
    const res = await installPluginDeps(p.dir)
    if (res.status === 'failed') {
      const reason = res.error ?? '依赖安装失败'
      setPluginDepsError(p.dir, reason)
      failed.push({ id: p.id, reason })
    } else {
      setPluginDepsError(p.dir, undefined)
      ready.push({ id: p.id, entry: p.entry })
    }
  }
  const warning =
    failed.length > 0
      ? `${failed.length} 个插件依赖安装失败：${failed.map((f) => `${f.id}: ${f.reason}`).join('; ')}`
      : ''
  return { ready, warning }
}

export async function start(): Promise<void> {
  if (isAlive()) return
  // First launch: extract the bundled runtime tarball if needed. Fall back to
  // the bundled version when the configured one is missing.
  if (getConfig().activeVersion === 'bundled') {
    ensureBundledRuntime()
  }
  let dir = currentVersionDir()
  if (!dir && getConfig().activeVersion !== 'bundled') {
    // The downloaded active version vanished (cleaned runtime dir) — recover
    // to the bundled runtime instead of refusing to start.
    appLog.warn(`Active version ${getConfig().activeVersion} not found — falling back to bundled`)
    setConfig({ activeVersion: 'bundled' })
    ensureBundledRuntime()
    dir = currentVersionDir()
  }
  if (!dir) {
    setState('error', '未找到可用的 DSH 运行时（捆绑版本缺失或所选版本未安装）')
    return
  }
  const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) {
    setState('error', `DSH 入口不存在: ${bin}`)
    return
  }

  const cfg = getConfig()
  const enabled = cfg.plugins.filter((p) => p.enabled && fs.existsSync(p.entry))

  manualStop = false
  const seq = ++startSeq
  startedAt = Date.now()
  setState('starting')

  // Fix missing plugin deps before writing the overlay — state is already
  // 'starting' so a concurrent start() call returns via isAlive() while the
  // (serialized) installs run. A plugin whose deps fail to install is left out
  // of this launch (still listed with depsError); DSH keeps starting with
  // whatever remains loadable.
  const depsFix = await ensureEnabledPluginsReady(enabled)
  const patchArgs: string[] = []
  if (depsFix.ready.length > 0) {
    writePatchOverlay(depsFix.ready)
    patchArgs.push('--patch', getPaths().patchFile)
  }

  const node = nodeRuntime()
  // Launcher flags (--patch) must precede the app's inner flags: the dsh
  // launcher hands everything after its own options to the booted tree
  // verbatim, and --no-open/--port belong to the web app, not the launcher.
  const args = [...node.argsPrefix, bin, 'web', ...patchArgs, '--no-open', '--port', String(cfg.port)]
  appLog.info(`Spawning DSH: ${node.label} ${args.join(' ')} (cwd ${dir})`)
  try {
    child = spawn(node.command, args, {
      cwd: dir,
      env: { ...node.env, DSH_DESKTOP: '1' },
      windowsHide: true,
    })
  } catch (err) {
    setState('error', `启动失败: ${String(err)}`)
    return
  }

  const wire = (stream: NodeJS.ReadableStream | null, level: 'info' | 'error') => {
    if (!stream) return
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buf += chunk
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) dshLog[level](line)
    })
  }
  wire(child.stdout, 'info')
  wire(child.stderr, 'error')

  child.on('error', (err) => {
    if (seq !== startSeq) return
    setState('error', `进程启动异常: ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    if (seq !== startSeq) return
    child = null
    if (manualStop) {
      setState('stopped', `已停止 (code ${code ?? signal})`)
    } else {
      setState('crashed', `DSH 进程异常退出 (code ${code ?? signal})，可在日志页查看输出`)
      dshLog.error(`DSH exited unexpectedly with code ${code ?? signal}`)
    }
  })

  const ready = await pollReady(cfg.port, seq)
  if (seq !== startSeq) return
  if (ready) {
    setState('running', depsFix.warning)
  } else if (state === 'starting') {
    setState('timeout', `${READY_TIMEOUT_MS / 1000} 秒内服务端口未就绪，请查看日志或更换端口`)
  }
}

/** Kill the whole process tree (DSH spawns children, e.g. shells). */
export async function stop(reason = 'user'): Promise<void> {
  if (!child) {
    state = 'stopped'
    dshEvents.emit('status', getStatus())
    return
  }
  const seq = startSeq
  manualStop = true
  setState('stopping', reason)
  const pid = child.pid
  if (pid && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
  // Safety net: if exit hasn't fired shortly, drop the reference anyway.
  const watchdog = setTimeout(() => {
    if (seq === startSeq && child) {
      child = null
      setState('stopped', 'stopped (watchdog)')
    }
  }, 5000)
  child.once('exit', () => clearTimeout(watchdog))
}

export async function restart(): Promise<void> {
  await stop('restart')
  await new Promise((r) => setTimeout(r, 400))
  await start()
}

/** True when the service port answers right now (no state change). */
export async function probeService(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return res.status < 500
  } catch {
    return false
  }
}

export function shutdownSync(): void {
  // Best-effort synchronous tree kill on app quit.
  terminateActiveInstall()
  const pid = child?.pid
  if (pid && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* best effort */
    }
  }
  child = null
}
