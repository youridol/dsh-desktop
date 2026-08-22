/** Floating ball bridge: click + manual drag deltas. */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshBall', {
  dragBy: (dx: number, dy: number) => ipcRenderer.send('ball:drag', dx, dy),
  click: () => ipcRenderer.send('ball:click'),
})
