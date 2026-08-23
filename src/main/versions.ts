/**
 * High-level version management over GitHub Releases + npm installs:
 * check for updates, download+switch a release, roll back to an installed one.
 */
import fs from 'node:fs'
import { getPaths } from './paths'
import { getConfig, setConfig } from './config'
import { appLog, installLog } from './logger'
import { listReleases, compareVersions, getLatestCommit, GitHubRateLimitError, type ReleaseInfo, type CommitInfo } from './dsh/releases'
import {
  bundledVersion,
  ensureVersionInstalled,
  ensureBundledRuntime,
  isVersionInstalled,
  removeVersion,
  versionDir,
} from './dsh/install'
import { bundledDshDir } from './paths'
import * as dsh from './dsh/manager'

export interface InstalledVersion {
  version: string
  origin: 'bundled' | 'downloaded'
  active: boolean
}

export interface VersionCheckResult {
  current: string
  latest: ReleaseInfo | null
  hasUpdate: boolean
  releases: ReleaseInfo[]
  checkedAt: number
  /** GitHub 限流（403）时为 true，releases/latest 为空。 */
  rateLimited?: boolean
  rateLimitResetAt?: number
  /** 网络不可达（离线）时为 true。 */
  offline?: boolean
  /** source='commit' 时返回的最新提交；release 模式为 null。 */
  latestCommit: CommitInfo | null
}

export function listInstalled(): InstalledVersion[] {
  const out: InstalledVersion[] = []
  const bundled = bundledVersion(bundledDshDir())
  if (bundled) {
    out.push({ version: bundled, origin: 'bundled', active: getConfig().activeVersion === 'bundled' })
  }
  try {
    for (const name of fs.readdirSync(getPaths().versionsDir)) {
      if (!isVersionInstalled(name)) continue
      out.push({ version: name, origin: 'downloaded', active: getConfig().activeVersion === name })
    }
  } catch {
    /* no versions dir */
  }
  return out
}

export function currentVersionLabel(): string {
  const active = getConfig().activeVersion
  if (active === 'bundled') {
    const b = bundledVersion(bundledDshDir())
    return b ? `${b}（捆绑）` : 'bundled（缺失）'
  }
  return active
}

export type VersionSource = 'release' | 'commit'

export async function checkForUpdates(source: VersionSource = 'release'): Promise<VersionCheckResult> {
  const current = getConfig().activeVersion
  const currentV =
    current === 'bundled' ? bundledVersion(bundledDshDir()) ?? '0.0.0' : current
  const base = { current: currentV, latest: null, hasUpdate: false, releases: [], latestCommit: null, checkedAt: Date.now() }

  if (source === 'commit') {
    try {
      const c = await getLatestCommit()
      const installed = isVersionInstalled(`src-${c.shortSha}`)
      appLog.info(`Update check (commit): ${c.shortSha} ${c.message} installed=${installed}`)
      return { ...base, hasUpdate: !installed, latestCommit: c }
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        appLog.warn('Update check (commit): rate limited (403)')
        return { ...base, rateLimited: true, rateLimitResetAt: err.resetAt }
      }
      appLog.warn(`Update check (commit): network error — ${String(err)}`)
      return { ...base, offline: true }
    }
  }

  let releases: ReleaseInfo[]
  try {
    releases = await listReleases()
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      appLog.warn(`Update check: rate limited (403)${err.resetAt ? ` reset@${new Date(err.resetAt).toISOString()}` : ''}`)
      return { ...base, rateLimited: true, rateLimitResetAt: err.resetAt }
    }
    appLog.warn(`Update check: network error — ${String(err)}`)
    return { ...base, offline: true }
  }
  const latest = releases[0] ?? null
  const hasUpdate = latest ? compareVersions(latest.version, currentV) > 0 : false
  appLog.info(
    `Update check: current=${currentV} latest=${latest?.version ?? '?'} hasUpdate=${hasUpdate}`,
  )
  return { ...base, latest, hasUpdate, releases }
}

export interface SwitchOptions {
  restart?: boolean
}

/** Download (npm install) a release version, make it active, restart DSH. */
export async function downloadAndSwitch(
  version: string,
  onProgress?: (text: string) => void,
  opts: SwitchOptions = {},
): Promise<void> {
  if (getConfig().activeVersion === version && isVersionInstalled(version)) {
    installLog.info(`Version ${version} already active`)
    return
  }
  await ensureVersionInstalled(version, { onProgress })
  setConfig({ activeVersion: version })
  appLog.info(`Active version switched to ${version}`)
  if (opts.restart !== false) await dsh.restart()
}

/** Switch to an already-installed version (used for rollback). */
export async function switchTo(
  version: 'bundled' | string,
  opts: SwitchOptions = {},
): Promise<void> {
  if (version !== 'bundled') {
    if (!isVersionInstalled(version)) {
      throw new Error(`版本 ${version} 未安装`)
    }
  } else if (!bundledDshDir() && !ensureBundledRuntime()) {
    throw new Error('捆绑版本不可用')
  }
  setConfig({ activeVersion: version })
  appLog.info(`Active version switched to ${version}`)
  if (opts.restart !== false) await dsh.restart()
}

export async function deleteVersion(version: string): Promise<void> {
  if (getConfig().activeVersion === version) {
    throw new Error('不能删除当前使用中的版本，请先切换到其他版本')
  }
  removeVersion(version)
}

export function versionDirFor(version: string): string | null {
  return isVersionInstalled(version) ? versionDir(version) : null
}
