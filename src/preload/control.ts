/**
 * Control panel bridge: a typed invoke/event surface shared by all four tabs.
 * Kept deliberately narrow — only what the panel UI needs.
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getState: () => ipcRenderer.invoke('app:getState'),
  start: () => ipcRenderer.invoke('app:start'),
  stop: () => ipcRenderer.invoke('app:stop'),
  restart: () => ipcRenderer.invoke('app:restart'),

  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  addPlugin: (options: { name: string; source: 'npm' | 'npx' | 'dsh-profile'; profile?: string; allowBuilds?: boolean }) =>
    ipcRenderer.invoke('plugins:add', options),
  removePlugin: (id: string) => ipcRenderer.invoke('plugins:remove', id),
  enablePlugin: (id: string) => ipcRenderer.invoke('plugins:enable', id),
  disablePlugin: (id: string) => ipcRenderer.invoke('plugins:disable', id),
  uninstallPlugin: (id: string) => ipcRenderer.invoke('plugins:uninstall', id),
  exportPlugin: (id: string) => ipcRenderer.invoke('plugins:export', id),
  applyPlugins: () => ipcRenderer.invoke('plugins:apply'),

  // ---- plugin market (dsh-market 快捷配置入口) ----
  marketStatus: () => ipcRenderer.invoke('plugins:marketStatus'),
  ensureMarket: () => ipcRenderer.invoke('plugins:marketEnsure'),
  openMarket: () => ipcRenderer.invoke('plugins:marketOpen'),

  // ---- skills ----
  listSkillRepos: () => ipcRenderer.invoke('skills:listRepos'),
  addSkillRepo: (input: { url: string; name?: string }) => ipcRenderer.invoke('skills:addRepo', input),
  updateSkillRepo: (id: string, patch: { name?: string; url?: string }) =>
    ipcRenderer.invoke('skills:updateRepo', id, patch),
  setSkillRepoEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('skills:setRepoEnabled', id, enabled),
  removeSkillRepo: (id: string) => ipcRenderer.invoke('skills:removeRepo', id),
  syncSkillRepo: (id: string) => ipcRenderer.invoke('skills:syncRepo', id),
  syncAllSkillRepos: () => ipcRenderer.invoke('skills:syncAllRepos'),
  listAvailableSkills: (repoId: string) => ipcRenderer.invoke('skills:listAvailable', repoId),
  listInstalledSkills: (scope?: 'global' | 'project') => ipcRenderer.invoke('skills:listInstalled', scope),
  installSkill: (opts: { repoId: string; path: string; scope: 'global' | 'project'; overwrite?: boolean }) =>
    ipcRenderer.invoke('skills:install', opts),
  installAllFromRepo: (opts: { repoId: string; scope: 'global' | 'project'; overwrite?: boolean }) =>
    ipcRenderer.invoke('skills:installAll', opts),
  uninstallSkill: (key: string, scope: 'global' | 'project') => ipcRenderer.invoke('skills:uninstall', key, scope),
  deleteSkill: (key: string, scope: 'global' | 'project') => ipcRenderer.invoke('skills:delete', key, scope),
  setSkillEnabled: (key: string, scope: 'global' | 'project', enabled: boolean) =>
    ipcRenderer.invoke('skills:setEnabled', key, scope, enabled),
  batchSkills: (keys: string[], scope: 'global' | 'project', action: 'enable' | 'disable' | 'uninstall' | 'delete') =>
    ipcRenderer.invoke('skills:batch', keys, scope, action),
  checkSkillUpdates: (scope?: 'global' | 'project') => ipcRenderer.invoke('skills:checkUpdates', scope),
  updateSkills: (keys: string[], scope?: 'global' | 'project') => ipcRenderer.invoke('skills:update', keys, scope),
  searchSkills: (query: string) => ipcRenderer.invoke('skills:search', query),
  installSkillFromSearch: (opts: { fullName: string; scope: 'global' | 'project' }) =>
    ipcRenderer.invoke('skills:installSearch', opts),
  exportSkills: (opts: { scope?: 'all' | 'global' | 'project'; includePayload?: boolean }) =>
    ipcRenderer.invoke('skills:export', opts),
  importSkills: () => ipcRenderer.invoke('skills:import'),
  createSkillBackup: (scope?: 'all' | 'global' | 'project') => ipcRenderer.invoke('skills:createBackup', scope),
  listSkillBackups: () => ipcRenderer.invoke('skills:listBackups'),
  restoreSkillBackup: (id: string, scope?: 'global' | 'project') => ipcRenderer.invoke('skills:restoreBackup', id, scope),
  deleteSkillBackup: (id: string) => ipcRenderer.invoke('skills:deleteBackup', id),
  getSkillsState: () => ipcRenderer.invoke('skills:getState'),

  listVersions: () => ipcRenderer.invoke('versions:list'),
  checkUpdates: (source?: 'release' | 'commit') => ipcRenderer.invoke('versions:check', source),
  downloadVersion: (version: string) => ipcRenderer.invoke('versions:download', version),
  switchVersion: (version: string) => ipcRenderer.invoke('versions:switch', version),
  deleteVersion: (version: string) => ipcRenderer.invoke('versions:delete', version),
  installCommit: (sha: string) => ipcRenderer.invoke('versions:installCommit', sha),

  setSettings: (patch: { port?: number; autoStart?: boolean; checkUpdatesOnStart?: boolean }) =>
    ipcRenderer.invoke('settings:set', patch),
  applyRestart: () => ipcRenderer.invoke('settings:applyRestart'),
  getCredentials: () => ipcRenderer.invoke('credentials:get'),
  saveCredentials: (user: string, token: string) => ipcRenderer.invoke('credentials:save', user, token),

  subscribeLogs: () => ipcRenderer.invoke('logs:subscribe'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  closePanel: () => ipcRenderer.send('panel:close'),

  on: (channel: string, cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('dshc', api)

export type ControlApi = typeof api
