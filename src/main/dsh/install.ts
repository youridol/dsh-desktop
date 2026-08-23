/**
 * Version installs. A "version" is a directory containing a plain npm install
 * of @deepseek-ai/dsh@<version> (package.json + node_modules). Installs run
 * through the vendored npm CLI so machines without Node can still update;
 * progress is streamed to the log bus.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getPaths, npmCliPath, bundledDshDir, bundledExtractDir, runtimeTgzPath } from '../paths'
import { installLog } from '../logger'
import { nodeRuntime } from './nodebin'

const SOURCE_REPO = 'deepseek-ai/deepseek-harness'

export interface SpawnProgress {
  onLine: (line: string) => void
}

/**
 * Extract the bundled runtime tarball into versions/_bundled on first launch.
 * Uses Windows' built-in bsdtar (System32\tar.exe, present since Win10 1803),
 * so no Node/tar dependency exists on the user machine.
 */
export function ensureBundledRuntime(): boolean {
  if (bundledDshDir()) return true
  const tgz = runtimeTgzPath()
  if (!tgz) {
    installLog.error('Bundled runtime tarball not found next to the app')
    return false
  }
  const dest = bundledExtractDir()
  const marker = path.join(dest, '.extract-complete')
  if (!fs.existsSync(marker)) {
    installLog.info(`Extracting bundled DSH runtime from ${tgz} (first launch, may take a minute)`)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const res = spawnSync(tar, ['-xzf', tgz, '-C', dest], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
    if (res.status !== 0) {
      installLog.error(`Extraction failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`)
      return false
    }
    fs.writeFileSync(marker, new Date().toISOString())
    installLog.info('Bundled runtime extracted successfully')
  }
  return !!bundledDshDir()
}

/** Run a command, line-buffer stdout+stderr into onLine, resolve on exit code 0. */
export function runCaptured(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  cwd?: string,
  shell = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    installLog.info(`[${label}] ${command} ${args.join(' ')}${cwd ? ` (cwd ${cwd})` : ''}`)
    // Windows 下 .cmd 命令（如 pnpm）需要 shell:true 才能经 PATHEXT 解析
    const child = spawn(command, args, { env, windowsHide: true, cwd, shell })
    let errText = ''
    const wire = (stream: NodeJS.ReadableStream) => {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buf += chunk
        const parts = buf.split(/\r?\n/)
        buf = parts.pop() ?? ''
        for (const line of parts) if (line.trim()) onLine(line)
      })
      stream.on('end', () => {
        if (buf.trim()) onLine(buf)
      })
    }
    wire(child.stdout)
    wire(child.stderr)
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with exit code ${code}: ${errText.slice(-800)}`))
    })
    // Keep last stderr for the error message.
    child.stderr?.on('data', (c: string) => {
      errText += c
    })
  })
}

export function versionDir(version: string): string {
  return path.join(getPaths().versionsDir, version)
}

export function isVersionInstalled(version: string): boolean {
  const dir = versionDir(version)
  return fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
}

export interface InstallEvents {
  onProgress?: (text: string) => void
}

/**
 * Install @deepseek-ai/dsh@version into the runtime versions dir using the
 * vendored npm. Idempotent: existing complete installs are kept.
 */
export async function ensureVersionInstalled(
  version: string,
  events: InstallEvents = {},
): Promise<string> {
  const dir = versionDir(version)
  if (isVersionInstalled(version)) {
    installLog.info(`Version ${version} already installed at ${dir}`)
    return dir
  }
  const cli = npmCliPath()
  if (!cli) {
    throw new Error('Vendored npm not found (tools/node_modules/npm). Build with `npm run fetch-dsh`.')
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  // An explicit package.json pins npm to this directory. Without it npm
  // searches upward for a manifest and would install into (and prune!) an
  // unrelated enclosing project — fatal in dev mode and portable installs.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `dsh-runtime-${version}`, private: true, version: '0.0.0' }, null, 2),
  )
  const node = nodeRuntime()
  const emit = (line: string) => {
    events.onProgress?.(line)
    installLog.info(line)
  }
  installLog.info(`Installing @deepseek-ai/dsh@${version} into ${dir} (via ${node.label})`)
  await runCaptured(
    `install ${version}`,
    node.command,
    [
      ...node.argsPrefix,
      cli,
      'install',
      `@deepseek-ai/dsh@${version}`,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '--registry=https://registry.npmjs.org',
    ],
    node.env,
    emit,
    dir,
  )
  if (!isVersionInstalled(version)) {
    throw new Error(`Install of ${version} finished but the runtime entry is missing`)
  }
  installLog.info(`Version ${version} installed successfully`)
  return dir
}

export function removeVersion(version: string): void {
  fs.rmSync(versionDir(version), { recursive: true, force: true })
  installLog.info(`Removed version dir for ${version}`)
}

/** Directory of the runtime for the active config value ('bundled' | version). */
export function resolveActiveDir(activeVersion: string, bundledDir: string | null): string | null {
  if (activeVersion === 'bundled') return bundledDir
  if (isVersionInstalled(activeVersion)) return versionDir(activeVersion)
  return null
}

export function bundledVersion(bundledDir: string | null): string | null {
  if (!bundledDir) return null
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/**
 * 从源码安装指定 commit：下载 codeload tarball → 解压 monorepo 根到
 * versions/src-<sha7>/ → pnpm install（corepack pnpm，解析 workspace: 协议）
 * → pnpm run build:lib（产出 apps/cli/lib/bin.js）→ 在
 * dir/node_modules/@deepseek-ai/dsh 建立 junction 指向 apps/cli，对齐 npm 版
 * 布局（isVersionInstalled / manager 的硬编码入口路径零改动兼容）。
 */
export async function ensureCommitInstalled(
  sha: string,
  events: InstallEvents = {},
): Promise<string> {
  const short = sha.slice(0, 7)
  const dir = versionDir(`src-${short}`)
  const linkDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  if (
    fs.existsSync(path.join(dir, 'apps', 'cli', 'lib', 'bin.js')) &&
    fs.existsSync(path.join(linkDir, 'lib', 'bin.js'))
  ) {
    installLog.info(`Commit src-${short} already installed at ${dir}`)
    return dir
  }
  const sysroot = process.env.SystemRoot ?? 'C:\\Windows'
  const tar = path.join(sysroot, 'System32', 'tar.exe')
  const tgz = path.join(getPaths().downloadsDir, `dsh-${short}.tar.gz`)
  const emit = (line: string) => {
    events.onProgress?.(line)
    installLog.info(line)
  }
  installLog.info(`Downloading source archive for ${short}`)
  const res = await fetch(`https://codeload.github.com/${SOURCE_REPO}/tar.gz/${sha}`)
  if (!res.ok) throw new Error(`源码下载失败: GitHub ${res.status} for ${sha}`)
  fs.mkdirSync(getPaths().downloadsDir, { recursive: true })
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  // tar 顶层为 <sha>/，strip 一层后把 monorepo 根解压到版本目录
  const extract = spawnSync(tar, ['-xzf', tgz, '-C', dir, '--strip-components=1'], {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  })
  if (extract.status !== 0) {
    throw new Error(`源码解压失败: ${(extract.stderr || extract.stdout || '').slice(0, 500)}`)
  }
  // 仓库根自带 package.json（name=@deepseek-ai/dsh-root, workspaces），
  // 不写入额外 manifest；pnpm 在 monorepo 根解析全部 workspace: 依赖。
  const node = nodeRuntime()
  installLog.info(`Installing workspace deps for src-${short} (pnpm via ${node.label})`)
  await runCaptured('pnpm install src-' + short, 'pnpm', ['install', '--frozen-lockfile'], node.env, emit, dir, true)
  installLog.info(`Building lib for src-${short}`)
  await runCaptured('pnpm build src-' + short, 'pnpm', ['run', 'build:lib'], node.env, emit, dir, true)
  // 布局兼容层：npm 版安装把 @deepseek-ai/dsh 放 node_modules/@deepseek-ai/dsh；
  // pnpm 版源码位于 apps/cli。建 junction 使硬编码入口路径一致（零改动
  // manager / isVersionInstalled）。
  const scoped = path.join(dir, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(scoped, { recursive: true })
  fs.rmSync(path.join(scoped, 'dsh'), { recursive: true, force: true })
  const mklink = spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(scoped, 'dsh'), path.join(dir, 'apps', 'cli')], {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  })
  if (mklink.status !== 0) {
    throw new Error(`创建 dsh junction 失败: ${(mklink.stderr || mklink.stdout || '').slice(0, 500)}`)
  }
  if (!fs.existsSync(path.join(linkDir, 'lib', 'bin.js'))) {
    throw new Error(`源码安装完成但入口缺失: ${path.join(linkDir, 'lib', 'bin.js')}`)
  }
  installLog.info(`Commit src-${short} installed successfully`)
  return dir
}
