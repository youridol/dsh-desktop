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
  addPlugin: (name: string) => ipcRenderer.invoke('plugins:add', name),
  removePlugin: (id: string) => ipcRenderer.invoke('plugins:remove', id),
  enablePlugin: (id: string) => ipcRenderer.invoke('plugins:enable', id),
  disablePlugin: (id: string) => ipcRenderer.invoke('plugins:disable', id),
  uninstallPlugin: (id: string) => ipcRenderer.invoke('plugins:uninstall', id),
  exportPlugin: (id: string) => ipcRenderer.invoke('plugins:export', id),
  applyPlugins: () => ipcRenderer.invoke('plugins:apply'),

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
