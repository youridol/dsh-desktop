/**
 * Version installs. A "version" is a directory containing a plain npm install
 * of @deepseek-ai/dsh@<version> (package.json + node_modules). Installs run
 * through the vendored npm CLI so machines without Node can still update;
 * progress is streamed to the log bus.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getPaths, npmCliPath, bundledDshDir, bundledExtractDir, runtimeTgzPath } from '../paths'
import { installLog } from '../logger'
import { nodeRuntime } from './nodebin'

const SOURCE_REPO = 'deepseek-ai/deepseek-harness'

export interface SpawnProgress {
  onLine: (line: string) => void
}

/**
 * Key files the bundled runtime must contain to boot. The DSH launcher loads
 * @deepseek-ai/dsh (bin.js) which imports the boot tree; @deepseek-ai/dsh-app-boot
 * imports js-yaml directly, so a tree missing any of these crashes with
 * ERR_MODULE_NOT_FOUND at spawn even though the dsh package itself exists.
 */
const BUNDLED_REQUIRED = [
  ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'],
  ['node_modules', 'js-yaml', 'package.json'],
] as const

/**
 * True when the extracted bundled runtime has all required entry files.
 * The old completeness check only looked for the dsh package dir, so a
 * partially extracted tree (crash / early tar version / stale marker) could
 * pass and then fail at spawn. This is the gate used before and after extract.
 */
export function bundledRuntimeComplete(dir: string): boolean {
  return BUNDLED_REQUIRED.every((parts) => fs.existsSync(path.join(dir, ...parts)))
}

/**
 * Extract the bundled runtime tarball into versions/_bundled on first launch.
 * Uses Windows' built-in bsdtar (System32\tar.exe, present since Win10 1803),
 * so no Node/tar dependency exists on the user machine.
 *
 * Self-healing: a stale .extract-complete marker or a partial tree is detected
 * by bundledRuntimeComplete() and re-extracted from the shipped tarball, so an
 * interrupted or incomplete first extraction cannot leave an unbootable
 * runtime behind.
 */
export function ensureBundledRuntime(): boolean {
  // Dev mode serves the bundled runtime straight from the checkout's
  // .dsh-runtime (bundledDshDir points there); packaged mode extracts the
  // shipped tarball into versions/_bundled. Completeness is checked against
  // whichever directory is actually used, so dev keeps working without
  // extracting anything.
  const existing = bundledDshDir()
  if (existing && bundledRuntimeComplete(existing)) return true
  // Dev mode: a partial checkout .dsh-runtime cannot be healed by extracting
  // into versions/_bundled (dev serves .dsh-runtime directly), so tell the
  // developer to re-fetch instead of silently extracting an unused tree.
  if (!app.isPackaged && existing) {
    installLog.error('Bundled runtime (dev .dsh-runtime) is incomplete — run `npm run fetch-dsh` to repair')
    return false
  }
  const dest = bundledExtractDir()
  const tgz = runtimeTgzPath()
  if (!tgz) {
    if (fs.existsSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh'))) {
      installLog.error('Bundled runtime incomplete but its tarball is missing — DSH will fail to start')
    } else {
      installLog.error('Bundled runtime tarball not found next to the app')
    }
    return false
  }
  // Incomplete tree present (stale marker / partial extract): drop everything
  // so the re-extract starts clean, matching the first-launch path.
  if (existing || fs.existsSync(path.join(dest, '.extract-complete'))) {
    installLog.warn('Bundled runtime incomplete — re-extracting from the shipped tarball')
  }
  installLog.info(`Extracting bundled DSH runtime from ${tgz} (first launch, may take a minute)`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const res = spawnSync(tar, ['-xzf', tgz, '-C', dest], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) {
    installLog.error(`Extraction failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`)
    return false
  }
  // tar reports success but may still have dropped files — verify the tree is
  // actually bootable before writing the marker.
  if (!bundledRuntimeComplete(dest)) {
    installLog.error('Extraction finished but the runtime tree is incomplete — will retry on next start')
    return false
  }
  fs.writeFileSync(path.join(dest, '.extract-complete'), new Date().toISOString())
  installLog.info('Bundled runtime extracted successfully')
  return true
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

/**
 * 递归删除版本目录；Windows 下含 junction（pnpm/源码安装建）的目录 rmSync
 * 可能 ENOTEMPTY 残留，先删 junction 再重试，保证后续安装不被旧残留污染。
 */
export function rmDirRecursiveSafe(target: string): void {
  if (!fs.existsSync(target)) return
  const link = path.join(target, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    // 先摘除 pnpm/兼容层建立的 dsh junction，避免递归删除时被当作普通目录处理
    fs.rmSync(link, { recursive: true, force: true })
  } catch {
    /* 链接不存在时忽略 */
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (err) {
    // 首次删除残留（Windows junction 时序），重试一次
    if (fs.existsSync(link)) {
      try {
        fs.rmSync(link, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
    fs.rmSync(target, { recursive: true, force: true })
    installLog.info(`Repeated removal of ${target} (${String(err).slice(0, 120)})`)
  }
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
  rmDirRecursiveSafe(versionDir(version))
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
 * versions/src-<sha7>/ → pnpm install --frozen-lockfile（corepack pnpm，解析
 * workspace: 协议）→ pnpm run build（build:lib + build:web，产出
 * apps/cli/lib/bin.js；注入 DSH_CLIENT_COMMIT_HASH 替代 git rev-parse）→
 * 在 dir/node_modules/@deepseek-ai/dsh 建立 junction 指向 apps/cli，对齐 npm 版
 * 布局（isVersionInstalled / manager 的硬编码入口路径零改动兼容）。
 */
export async function ensureCommitInstalled(
  sha: string,
  events: InstallEvents = {},
): Promise<string> {
  const short = sha.slice(0, 7)
  const dir = versionDir(`src-${short}`)
  const linkDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const cliBin = path.join(dir, 'apps', 'cli', 'lib', 'bin.js')
  if (
    fs.existsSync(cliBin) &&
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
  rmDirRecursiveSafe(dir)
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
  // 官方构建（build:lib + build:web）。tarball 不含 .git，注入 commit hash
  // 供 client-build-environment 读取，避免 git rev-parse 失败。
  installLog.info(`Building src-${short} (lib + web)`)
  await runCaptured(
    'pnpm build src-' + short,
    'pnpm',
    ['run', 'build'],
    { ...node.env, DSH_CLIENT_COMMIT_HASH: short },
    emit,
    dir,
    true,
  )
  // 布局兼容层：npm 版安装把 @deepseek-ai/dsh 放 node_modules/@deepseek-ai/dsh；
  // pnpm 版源码位于 apps/cli。建 junction 使硬编码入口路径一致（零改动
  // manager / isVersionInstalled）。
  const scoped = path.join(dir, 'node_modules', '@deepseek-ai')
  const linkPath = path.join(scoped, 'dsh')
  const targetPath = path.join(dir, 'apps', 'cli')
  fs.mkdirSync(scoped, { recursive: true })
  fs.rmSync(linkPath, { recursive: true, force: true })
  // mklink 的 target 相对路径基于 cmd 的 cwd（应用进程目录），必须用绝对路径
  const mklink = spawnSync('cmd.exe', ['/c', 'mklink', '/J', linkPath, targetPath], {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  })
  if (mklink.status !== 0) {
    throw new Error(`创建 dsh junction 失败: ${(mklink.stderr || mklink.stdout || '').slice(0, 500)}`)
  }
  // 入口检查：产物真实位置（apps/cli/lib/bin.js）与兼容层 junction 路径
  if (!fs.existsSync(cliBin) && !fs.existsSync(path.join(linkDir, 'lib', 'bin.js'))) {
    throw new Error(`源码安装完成但入口缺失: ${cliBin} (junction: ${path.join(linkDir, 'lib', 'bin.js')})`)
  }
  installLog.info(`Commit src-${short} installed successfully`)
  return dir
}
