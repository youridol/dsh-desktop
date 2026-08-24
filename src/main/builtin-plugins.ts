/**
 * Built-in plugin presets: a pinned list of npm-published DSH plugins that the
 * app installs idempotently on startup and enables by default, so first-time
 * users get e.g. the SiliconFlow LLM provider with zero manual steps.
 *
 * Per-preset flow: preflight (dir/entry/version checks) -> download the pinned
 * tarball -> replace the target dir -> extract -> write the config record
 * (enabled) -> install npm deps. Every step is failure-isolated: a single
 * preset failing never blocks app or DSH startup (failures are collected and
 * logged via appLog.warn). Registry and names come from this fixed manifest —
 * no user input ever feeds the tarball URL or the extraction target.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getPaths } from './paths'
import { getConfig, mutateConfig } from './config'
import { resolveEntry, rmRobust, setPluginDepsError } from './plugins'
import { installPluginDeps } from './plugin-deps'
import { appLog } from './logger'

export interface BuiltinPlugin {
  /** cordis 插件 id（= 插件导出的 name），也用于 PluginRecord.id。 */
  id: string
  /** npm 包名（含 scope）。 */
  packageName: string
  /** 清单锁定版本；与插件目录内 package.json version 比对决定是否需要重装。 */
  version: string
  /** npm registry 根地址。 */
  registry: string
  /** pluginsDir 下的安装目录名。 */
  targetDirName: string
}

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  {
    id: 'llm-siliconflow',
    packageName: '@siliconflow-official/dsh-llm-siliconflow',
    version: '0.2.0-rc.1',
    registry: 'https://registry.npmjs.org',
    targetDirName: 'dsh-llm-siliconflow',
  },
]

/** 读取插件目录内 package.json 的 version；目录/文件缺失或 JSON 解析失败 → null。 */
export function installedVersionOf(dir: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    return null
  }
}

/** npm tarball URL；scoped 包名按 registry 兼容形式把 `/` 编码为 `%2F`。 */
export function tarballUrl(p: BuiltinPlugin): string {
  const slash = p.packageName.lastIndexOf('/')
  const shortName = slash === -1 ? p.packageName : p.packageName.slice(slash + 1)
  const encodedName = slash === -1 ? p.packageName : `${p.packageName.slice(0, slash)}%2F${shortName}`
  return `${p.registry}/${encodedName}/-/${shortName}-${p.version}.tgz`
}

/** 是否需要安装/重装：目标目录缺失、入口缺失或版本与清单不符。 */
export function presetNeedsInstall(p: BuiltinPlugin): boolean {
  const dir = path.join(getPaths().pluginsDir, p.targetDirName)
  if (!fs.existsSync(dir)) return true
  if (resolveEntry(dir) === null) return true
  return installedVersionOf(dir) !== p.version
}

/** 用户是否卸载过该内置插件（suppressedPresets 记录）。 */
export function isSuppressed(p: BuiltinPlugin): boolean {
  return getConfig().suppressedPresets.includes(p.id)
}

/** Windows 用系统自带 bsdtar（System32），其它平台回退 PATH 上的 tar。 */
function tarCommand(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

/** 下载 tarball 到 downloadsDir（60s 超时，失败抛中文错误）。 */
async function downloadTarball(p: BuiltinPlugin): Promise<string> {
  const { downloadsDir } = getPaths()
  fs.mkdirSync(downloadsDir, { recursive: true })
  const tgz = path.join(downloadsDir, `${p.targetDirName}-${p.version}.tgz`)
  let res: Response
  try {
    res = await fetch(tarballUrl(p), { signal: AbortSignal.timeout(60_000) })
  } catch (err) {
    throw new Error(`tarball 下载失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`tarball 下载失败: HTTP ${res.status}`)
  try {
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  } catch (err) {
    throw new Error(`tarball 下载失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return tgz
}

/**
 * 解压已下载 tarball 到目标目录：先替换旧目录（版本不符时），解压失败回滚清理，
 * 避免残留半成品目录。npm tarball 顶层为 `package/`，strip 一层。
 */
function extractToDir(tgz: string, dir: string): void {
  if (fs.existsSync(dir)) rmRobust(dir)
  fs.mkdirSync(dir, { recursive: true })
  const res = spawnSync(tarCommand(), ['-xzf', tgz, '-C', dir, '--strip-components=1'], {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
  })
  if (res.status !== 0) {
    rmRobust(dir)
    const tail = (res.stderr || res.stdout || '').trim().slice(-200)
    throw new Error(`解压失败: ${tail}`)
  }
}

/**
 * 单插件安装：下载 → 替换目录 → 解压 → 写 enabled 记录。入口不可识别时回滚目录
 * 并抛错（不写记录，避免虚假的 missing 条目）。
 */
async function installOne(p: BuiltinPlugin): Promise<string> {
  const tgz = await downloadTarball(p)
  const dir = path.join(getPaths().pluginsDir, p.targetDirName)
  extractToDir(tgz, dir)
  const entry = resolveEntry(dir)
  if (!entry) {
    rmRobust(dir)
    throw new Error('解压后未找到插件入口（package.json main / lib/index.js）')
  }
  mutateConfig((draft) => {
    draft.plugins = draft.plugins.filter((r) => r.dir !== dir)
    draft.plugins.push({
      id: p.id,
      entry,
      dir,
      enabled: true,
      source: 'preset',
      installedAt: Date.now(),
    })
  })
  appLog.info(`Installed preset plugin ${p.id} -> ${entry}`)
  return dir
}

export interface PresetInstallResult {
  installed: string[]
  failed: Array<{ id: string; reason: string }>
}

/**
 * 串行执行内置插件预设：已就绪（目录+入口+版本匹配）跳过并计入 installed；
 * 需要安装时下载→解压→写记录→装依赖（沿用 installPluginDeps 的模块级串行队列）。
 * 任一环节失败只计入 failed（不 throw）；依赖安装失败写 depsError，但插件仍计入
 * installed（挂载与否由 dsh.start() 的 ensureEnabledPluginsReady 决定）。
 */
export async function ensureBuiltinPluginsInstalled(): Promise<PresetInstallResult> {
  const result: PresetInstallResult = { installed: [], failed: [] }
  for (const p of BUILTIN_PLUGINS) {
    if (isSuppressed(p)) continue
    try {
      if (!presetNeedsInstall(p)) {
        result.installed.push(p.id)
        continue
      }
      const dir = await installOne(p)
      const deps = await installPluginDeps(dir)
      if (deps.status === 'failed') {
        setPluginDepsError(dir, deps.error ?? '依赖安装失败')
      }
      result.installed.push(p.id)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: p.id, reason })
      appLog.warn(`内置插件安装失败 ${p.id}: ${reason}`)
    }
  }
  return result
}