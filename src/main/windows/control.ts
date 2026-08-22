/**
 * Control panel: a frameless child window (plugin / version / logs / settings)
 * with no taskbar entry, hidden and restored in lockstep with the main window.
 */
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { getMainWindow, mainWindowEvents, iconPath } from './main'

let panel: BrowserWindow | null = null
let wasOpen = false

export function getControlPanel(): BrowserWindow | null {
  return panel
}

export function createControlPanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel
  const main = getMainWindow()
  panel = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 520,
    parent: main ?? undefined,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    show: false,
    title: 'DSH 控制面板',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  void panel.loadFile(path.join(__dirname, 'renderer', 'control', 'index.html'))
  // "在浏览器打开" links out of the shell.
  panel.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Remember visibility across tray round-trips of the main window.
  panel.on('close', (e: Electron.Event) => {
    e.preventDefault()
    panel?.hide()
    wasOpen = false
  })
  mainWindowEvents.on('hidden-to-tray', () => {
    if (panel && !panel.isDestroyed() && panel.isVisible()) {
      wasOpen = true
      panel.hide()
    }
  })
  mainWindowEvents.on('restored', () => {
    if (panel && !panel.isDestroyed() && wasOpen) {
      panel.show()
      wasOpen = false
    }
  })
  return panel
}

export function openControlPanel(): void {
  const p = createControlPanel()
  const main = getMainWindow()
  if (main && !main.isVisible()) {
    // Panel is only meaningful together with the app window.
    return
  }
  if (p.isMinimized()) p.restore()
  if (!p.isVisible()) {
    const b = main?.getBounds()
    if (b) {
      const x = Math.max(b.x + Math.round((b.width - p.getBounds().width) / 2), 8)
      const y = Math.max(b.y + 60, 8)
      p.setPosition(x, y, false)
    }
  }
  p.show()
  p.focus()
}

export function toggleControlPanel(): void {
  const p = panel
  if (p && !p.isDestroyed() && p.isVisible()) {
    p.hide()
  } else {
    openControlPanel()
  }
}

export function destroyControlPanel(): void {
  if (panel && !panel.isDestroyed()) {
    panel.destroy()
  }
  panel = null
}
