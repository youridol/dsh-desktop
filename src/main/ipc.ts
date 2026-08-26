/**
 * IPC surface. One registration point; preload bridges expose narrow,
 * window-specific APIs. Log/status updates are pushed to subscribed windows.
 */
import { ipcMain, app, type WebContents } from 'electron'
import { getPaths } from './paths'
import { getConfig, setConfig, readCredentials, writeCredentials } from './config'
import { logEvents, recentLogs, clearLogs } from './logger'
import * as dsh from './dsh/manager'
import * as versions from './versions'
import * as dshPlugin from './services/dsh/DshPluginService'
import { isBuildBlockedError, type InstallPluginOptions } from './services/dsh/DshPluginService'
import * as skills from './services/skills/skillsService'
import { getAutoStart, setAutoStart } from './autostart'
import { getControlPanel } from './windows/control'
import { ballClicked, dragBallBy } from './windows/floating'
import { refreshServiceProbe } from './windows/main'

const logSubscribers = new Set<WebContents>()
let statusForwarderAttached = false

function forwardStatus(wc: WebContents): void {
  if (!statusForwarderAttached) {
    statusForwarderAttached = true
    dsh.dshEvents.on('status', (status) => {
      for (const sub of logSubscribers) {
        if (!sub.isDestroyed()) sub.send('dsh:status', status)
      }
      if (!wc.isDestroyed()) wc.send('dsh:status', status)
    })
  }
}

function pushToSubscribers(channel: string, payload: unknown): void {
  for (const sub of logSubscribers) {
    if (!sub.isDestroyed()) sub.send(channel, payload)
  }
}

export function registerIpc(): void {
  // ---- floating ball ----
  ipcMain.on('ball:drag', (_e, dx: number, dy: number) => dragBallBy(dx, dy))
  ipcMain.on('ball:click', () => ballClicked())

  // ---- loader ----
  ipcMain.handle('loader:retry', async () => {
    await dsh.restart()
    return dsh.getStatus()
  })
  ipcMain.handle('loader:probe', () => refreshServiceProbe())

  // ---- control panel ----
  ipcMain.handle('app:getState', () => ({
    status: dsh.getStatus(),
    config: getConfig(),
    autoStart: getAutoStart(),
    portable: getPaths().isPortable,
    runtimeDir: getPaths().runtimeDir,
    appVersion: app.getVersion(),
    versions: versions.listInstalled(),
    versionLabel: versions.currentVersionLabel(),
  }))

  ipcMain.handle('app:start', () => dsh.start())
  ipcMain.handle('app:stop', () => dsh.stop('panel'))
  ipcMain.handle('app:restart', () => dsh.restart())

  // ---- plugins (dsh profile-based) ----
  ipcMain.handle('plugins:list', () => dshPlugin.listPlugins())
  ipcMain.handle('plugins:add', async (_e, options: InstallPluginOptions & { allowBuilds?: boolean }) => {
    try {
      const plugins = await dshPlugin.installPlugin(options, undefined, {
        allowBuilds: options?.allowBuilds === true,
      })
      return { status: 'installed', plugins }
    } catch (err) {
      // pnpm blocked dependency build scripts: hand the structured info back
      // so the renderer can offer a real allow-build-scripts-and-retry action.
      if (isBuildBlockedError(err)) {
        return { status: 'build-blocked', message: err.message, keys: err.keys, names: err.names }
      }
      throw err
    }
  })
  ipcMain.handle('plugins:remove', async (_e, id: string) => {
    await dshPlugin.removePlugin(id)
    return dshPlugin.listPlugins()
  })
  ipcMain.handle('plugins:enable', (_e, id: string) => {
    dshPlugin.enablePlugin(id)
    return dshPlugin.listPlugins()
  })
  ipcMain.handle('plugins:disable', (_e, id: string) => {
    dshPlugin.disablePlugin(id)
    return dshPlugin.listPlugins()
  })
  ipcMain.handle('plugins:uninstall', async (_e, id: string) => {
    await dshPlugin.uninstallPlugin(id)
    return dshPlugin.listPlugins()
  })
  ipcMain.handle('plugins:export', (_e, id: string) => {
    return dshPlugin.exportPluginInfo(id)
  })
  ipcMain.handle('plugins:apply', async () => {
    // Restart DSH to load the updated profile (bundles list changes).
    await dsh.restart()
    return dsh.getStatus()
  })

  // ---- skills (dsh-desktop 自身管理的 Skills 仓库 / 生命周期 / 备份) ----
  ipcMain.handle('skills:listRepos', () => skills.listRepositories())
  ipcMain.handle('skills:addRepo', async (_e, input: { url: string; name?: string }) => skills.addRepository(input))
  ipcMain.handle('skills:updateRepo', (_e, id: string, patch: { name?: string; url?: string }) =>
    skills.updateRepository(id, patch),
  )
  ipcMain.handle('skills:setRepoEnabled', (_e, id: string, enabled: boolean) =>
    skills.setRepositoryEnabled(id, enabled),
  )
  ipcMain.handle('skills:removeRepo', (_e, id: string) => {
    skills.removeRepository(id)
    return skills.listRepositories()
  })
  ipcMain.handle('skills:syncRepo', async (_e, id: string) => skills.syncRepository(id))
  ipcMain.handle('skills:syncAllRepos', async () => skills.syncAllRepositories())
  ipcMain.handle('skills:listAvailable', (_e, repoId: string) => skills.availableSkills(repoId))
  ipcMain.handle('skills:listInstalled', (_e, scope?: 'global' | 'project') => skills.listInstalled(scope))
  ipcMain.handle('skills:install', (_e, opts: { repoId: string; path: string; scope: 'global' | 'project'; overwrite?: boolean }) =>
    skills.installSkillFromRepo(opts),
  )
  ipcMain.handle('skills:installAll', (_e, opts: { repoId: string; scope: 'global' | 'project'; overwrite?: boolean }) =>
    skills.installAllFromRepo(opts),
  )
  ipcMain.handle('skills:uninstall', (_e, key: string, scope: 'global' | 'project') => {
    skills.uninstallSkill(key, scope)
    return skills.listInstalled(scope)
  })
  ipcMain.handle('skills:delete', (_e, key: string, scope: 'global' | 'project') => {
    skills.deleteSkill(key, scope)
    return skills.listInstalled(scope)
  })
  ipcMain.handle('skills:setEnabled', (_e, key: string, scope: 'global' | 'project', enabled: boolean) =>
    skills.setSkillEnabled(key, scope, enabled),
  )
  ipcMain.handle('skills:batch', (_e, keys: string[], scope: 'global' | 'project', action: string) =>
    skills.batchSkills(keys, scope, action as 'enable' | 'disable' | 'uninstall' | 'delete'),
  )
  ipcMain.handle('skills:checkUpdates', async (_e, scope?: 'global' | 'project') =>
    skills.checkSkillUpdates(scope),
  )
  ipcMain.handle('skills:update', async (_e, keys: string[], scope?: 'global' | 'project') =>
    skills.updateSkills(keys, scope),
  )
  ipcMain.handle('skills:search', (_e, query: string) => skills.searchGitHubSkills(query))
  ipcMain.handle('skills:installSearch', async (_e, opts: { fullName: string; scope: 'global' | 'project' }) =>
    skills.installFromGitHubSearch(opts),
  )
  ipcMain.handle('skills:export', async (_e, opts: { scope?: 'all' | 'global' | 'project'; includePayload?: boolean }) =>
    skills.exportSkills(opts),
  )
  ipcMain.handle('skills:import', async () => skills.importSkills())
  ipcMain.handle('skills:createBackup', (_e, scope?: 'all' | 'global' | 'project') => skills.createBackup(scope))
  ipcMain.handle('skills:listBackups', () => skills.listSkillBackups())
  ipcMain.handle('skills:restoreBackup', async (_e, id: string, scope?: 'global' | 'project') =>
    skills.restoreBackup(id, scope),
  )
  ipcMain.handle('skills:deleteBackup', (_e, id: string) => {
    skills.removeBackup(id)
    return skills.listSkillBackups()
  })
  ipcMain.handle('skills:getState', () => skills.getSkillsState())
  // ---- versions ----
  ipcMain.handle('versions:list', () => versions.listInstalled())
  ipcMain.handle('versions:check', (_e, source?: 'release' | 'commit') => versions.checkForUpdates(source))
  ipcMain.handle(
    'versions:download',
    (_e, version: string) =>
      versions.downloadAndSwitch(version, (text) => pushToSubscribers('install:progress', {
        version,
        text,
      })),
  )
  ipcMain.handle('versions:installCommit', (_e, sha: string) =>
    versions.installCommit(sha, (text) => pushToSubscribers('install:progress', {
      version: `src-${sha.slice(0, 7)}`,
      text,
    })),
  )
  ipcMain.handle('versions:switch', (_e, version: string) => versions.switchTo(version))
  ipcMain.handle('versions:delete', (_e, version: string) => versions.deleteVersion(version))

  // ---- settings ----
  ipcMain.handle('settings:set', (_e, patch: { port?: number; autoStart?: boolean; checkUpdatesOnStart?: boolean }) => {
    const prevPort = getConfig().port
    let needsRestart = false
    if (patch.port !== undefined && patch.port !== prevPort) {
      if (!(Number.isInteger(patch.port) && patch.port > 0 && patch.port < 65536)) {
        throw new Error('端口必须是 1-65535 的整数')
      }
      setConfig({ port: patch.port })
      needsRestart = true
    }
    if (patch.autoStart !== undefined) setAutoStart(patch.autoStart)
    if (patch.checkUpdatesOnStart !== undefined) setConfig({ checkUpdatesOnStart: patch.checkUpdatesOnStart })
    return {
      config: getConfig(),
      autoStart: getAutoStart(),
      needsRestart,
    }
  })
  ipcMain.handle('settings:applyRestart', () => dsh.restart())

  ipcMain.handle('credentials:get', () => {
    const c = readCredentials()
    return {
      githubUser: c.githubUser ?? '',
      githubToken: c.githubToken ? '********' : '',
      hasToken: !!c.githubToken,
    }
  })
  ipcMain.handle('credentials:save', (_e, user: string, token: string) => {
    const existing = readCredentials()
    // '********' means "unchanged" from the masked form.
    const nextToken = token === '********' ? existing.githubToken ?? '' : token.trim()
    writeCredentials({ githubUser: user.trim(), githubToken: nextToken })
    return true
  })

  // ---- logs ----
  ipcMain.handle('logs:subscribe', (e) => {
    logSubscribers.add(e.sender)
    e.sender.once('destroyed', () => logSubscribers.delete(e.sender))
    forwardStatus(e.sender)
    return recentLogs()
  })
  ipcMain.handle('logs:clear', () => clearLogs())

  // ---- panel ----
  ipcMain.on('panel:close', () => getControlPanel()?.hide())

  // Push new log lines to subscribed windows.
  logEvents.on('line', (line) => pushToSubscribers('logs:line', line))
  logEvents.on('cleared', () => pushToSubscribers('logs:cleared', null))

  // DSH status changes also go to every subscriber (forwardStatus wires the first).
  dsh.dshEvents.on('status', (status) => pushToSubscribers('dsh:status', status))
}

