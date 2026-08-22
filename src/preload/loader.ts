/**
 * Main-window loader bridge. Guarded by URL: once the window navigates to the
 * remote DSH Web UI this preload runs again but exposes nothing.
 */
import { contextBridge, ipcRenderer } from 'electron'

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dshLoader', {
    onStatus: (cb: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown) => cb(status)
      ipcRenderer.on('dsh:status', listener)
      return () => ipcRenderer.removeListener('dsh:status', listener)
    },
    retry: () => ipcRenderer.invoke('loader:retry'),
  })
}
