/**
 * Git CLI 运行器（Skills 仓库克隆 / 同步用）。
 *
 * - 所有命令均以参数数组 spawn，不经过 shell 字符串，避免命令注入；
 * - 私有 GitHub 仓库通过 `http.extraHeader` 携带 Basic Authorization，
 *   不把凭据写进 URL / 命令行参数展示；
 * - 超时与进程树终止与 DshCommandExecutor 保持一致。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { rmRobust } from '../../plugins'

export interface GitExecResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

export interface GitAuth {
  user: string
  token: string
}

export interface GitRunnerOptions {
  auth?: GitAuth | null
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

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

export class GitRunner {
  private auth: GitAuth | null
  private readonly timeoutMs: number

  constructor(options: GitRunnerOptions = {}) {
    this.auth = options.auth ?? null
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 设置/更新凭据（设置页保存 GitHub 凭据后无需重建 runner）。 */
  setAuth(auth: GitAuth | null): void {
    this.auth = auth
  }

  /** 凭据通过 `-c http.extraHeader=…` 传给 git，仅用于本次命令。 */
  private authArgs(): string[] {
    if (!this.auth?.token) return []
    const basic = Buffer.from(
      `${this.auth.user || 'x-access-token'}:${this.auth.token}`,
      'utf8',
    ).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
  }

  run(args: string[], options: { cwd?: string } = {}): Promise<GitExecResult> {
    const fullArgs = [...this.authArgs(), ...args]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    }

    return new Promise<GitExecResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn('git', fullArgs, {
          cwd: options.cwd,
          env,
          windowsHide: true,
        })
      } catch (err) {
        resolve({
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: `无法启动 git：${String(err)}`,
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
      }, this.timeoutMs)

      child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
      child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

      const done = (): void => clearTimeout(timer)

      child.on('error', (err) => {
        if (finished) return
        finished = true
        done()
        resolve({
          ok: false,
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
          timedOut,
          error: `git process error: ${err.message}`,
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
            stderr: stderr || `git 命令超时（${this.timeoutMs / 1000} 秒）`,
            timedOut: true,
            error: `timeout after ${this.timeoutMs}ms`,
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

  /** 读取远端默认分支 HEAD 的 ref 与 commit（无 symref 时 branch 为 null）。 */
  async lsRemoteHead(url: string): Promise<{ branch: string | null; sha: string } | null> {
    const res = await this.run(['ls-remote', '--symref', url, 'HEAD'])
    if (!res.ok) return null
    const lines = res.stdout.split(/\r?\n/).filter(Boolean)
    let branch: string | null = null
    let sha: string | null = null
    for (const line of lines) {
      if (line.startsWith('ref:')) {
        const m = line.match(/ref:\s*refs\/heads\/(\S+)\s+HEAD/)
        if (m) branch = m[1]
      } else if (line.endsWith('\tHEAD')) {
        sha = line.split(/\t/)[0] ?? null
      }
    }
    return sha ? { branch, sha } : null
  }

  /** 浅克隆仓库（可选指定分支）。失败时清理残留目录。 */
  async clone(url: string, dir: string, branch?: string | null): Promise<void> {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    rmRobust(dir)
    const args = ['clone', '--depth', '1', '--single-branch']
    if (branch) args.push('--branch', branch)
    args.push(url, dir)
    const res = await this.run(args)
    if (!res.ok) {
      rmRobust(dir)
      throw new Error(this.formatError(res))
    }
  }

  /** 拉取远端最新提交并重置工作区（保留已安装技能使用的 commit 信息）。 */
  async fetchAndReset(dir: string, branch?: string | null): Promise<void> {
    const fetch = await this.run(['fetch', 'origin', '--depth', '1'], { cwd: dir })
    if (!fetch.ok) throw new Error(this.formatError(fetch))
    const target = branch ? `origin/${branch}` : 'FETCH_HEAD'
    const reset = await this.run(['reset', '--hard', target], { cwd: dir })
    if (!reset.ok) {
      const fallback = await this.run(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir })
      if (!fallback.ok) throw new Error(this.formatError(fallback))
    }
  }

  /** 当前 HEAD commit sha。 */
  async headSha(dir: string): Promise<string | null> {
    const res = await this.run(['rev-parse', 'HEAD'], { cwd: dir })
    return res.ok ? res.stdout || null : null
  }

  private formatError(res: GitExecResult): string {
    if (res.timedOut) return '操作超时，请检查网络连接后重试'
    const detail = (res.stderr || res.stdout || res.error || '').trim().slice(0, 500)
    if (!detail) return `git 命令失败（退出码 ${res.exitCode ?? '?'}）`
    if (/not found|does not appear to be a git repository|repository .* not found/i.test(detail)) {
      return '仓库不存在或无法访问'
    }
    if (/Authentication failed|not authorized|could not read Username|403/i.test(detail)) {
      return '仓库需要权限（可在设置中配置 GitHub 凭据后重试）'
    }
    return `仓库操作失败：${detail}`
  }
}
