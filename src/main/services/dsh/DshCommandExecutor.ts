/**
 * Safe `dsh` CLI executor. Builds argument arrays (never shell strings),
 * spawns through the resolved Node runtime, captures stdout/stderr/exitCode,
 * enforces a timeout, and converts errors into structured results.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { nodeRuntime, type NodeInvocation } from '../../dsh/nodebin'
import { resolveActiveDir } from '../../dsh/install'
import { bundledDshDir } from '../../paths'
import { getConfig } from '../../config'
import { appLog } from '../../logger'

export interface ExecResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** Signal if killed by timeout. */
  timedOut: boolean
  error?: string
}

export interface ExecOptions {
  /** Timeout in ms (default 120_000, i.e. 2 min). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Resolve the absolute path to the dsh launcher bin.js for the active
 * (or bundled) runtime. Returns null when no runtime is available.
 */
function resolveDshBin(): string | null {
  const activeDir =
    resolveActiveDir(getConfig().activeVersion, bundledDshDir()) ??
    bundledDshDir()
  if (!activeDir) return null
  const bin = path.join(
    activeDir,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
  return fs.existsSync(bin) ? bin : null
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* best effort */
    }
  }
}

/**
 * Execute `dsh` with the given arguments (appended after `dsh`),
 * using the resolved Node runtime and dsh bin.
 *
 * Args are passed as an array — never as a shell string — to prevent
 * command injection.
 */
export function execDsh(
  dshArgs: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const node: NodeInvocation = nodeRuntime()
  const bin = resolveDshBin()

  if (!bin) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '未找到可用的 DSH 运行时（捆绑版本缺失或所选版本未安装）',
      timedOut: false,
      error: 'dsh runtime not found',
    })
  }

  const args = [...node.argsPrefix, bin, ...dshArgs]
  appLog.info(`execDsh: ${node.label} ${args.join(' ')}`)

  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(node.command, args, {
        env: { ...node.env },
        windowsHide: true,
      })
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `无法启动 dsh CLI: ${String(err)}`,
        timedOut: false,
        error: `spawn failed: ${String(err)}`,
      })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let finished = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

    const done = (): void => {
      clearTimeout(timer)
    }

    child.on('error', (err) => {
      if (finished) return
      finished = true
      done()
      resolve({
        ok: false,
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        error: `process error: ${err.message}`,
      })
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      done()

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

      if (timedOut) {
        resolve({
          ok: false,
          exitCode: code,
          stdout,
          stderr: stderr || `命令超时（${timeoutMs / 1000} 秒）`,
          timedOut: true,
          error: `timeout after ${timeoutMs}ms`,
        })
        return
      }

      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut: false,
      })
    })
  })
}

/**
 * Run an arbitrary command (program + argument array) through the same
 * safe runner used by execDsh: no shell interpretation, toolchain PATH,
 * timeout + tree-kill, structured result. Used by the custom-install
 * channel where the user typed a full command line (`npx ...`,
 * `pnpm ...`, `npm ...`). On win32 `.cmd` shims need the shell to be
 * resolved via PATHEXT, so `shell: true` is used ONLY for program
 * resolution — arguments are still passed as an array, never as a
 * shell string, so there is no injection surface.
 */
export function execRaw(
  programArgs: string[],
  options: ExecOptions & { cwd?: string } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const [command, ...args] = programArgs
  if (!command) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '命令不能为空',
      timedOut: false,
      error: 'empty command',
    })
  }
  const node: NodeInvocation = nodeRuntime()
  appLog.info(`execRaw: ${command} ${args.join(' ')}${options.cwd ? ` (cwd ${options.cwd})` : ''}`)
  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess
    try {
      // shell: true on win32 lets PATHEXT resolve .cmd/.ps1 shims (npx,
      // pnpm, npm). Args stay an array — no user input is ever joined
      // into a shell string.
      child = spawn(command, args, {
        env: { ...node.env },
        cwd: options.cwd,
        windowsHide: true,
        shell: process.platform === 'win32',
      })
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `无法启动命令: ${String(err)}`,
        timedOut: false,
        error: `spawn failed: ${String(err)}`,
      })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let finished = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

    const done = (): void => {
      clearTimeout(timer)
    }

    child.on('error', (err) => {
      if (finished) return
      finished = true
      done()
      resolve({
        ok: false,
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        error: `process error: ${err.message}`,
      })
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      done()

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

      if (timedOut) {
        resolve({
          ok: false,
          exitCode: code,
          stdout,
          stderr: stderr || `命令超时（${timeoutMs / 1000} 秒）`,
          timedOut: true,
          error: `timeout after ${timeoutMs}ms`,
        })
        return
      }

      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        timedOut: false,
      })
    })
  })
}