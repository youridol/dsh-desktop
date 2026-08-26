/**
 * Control panel: a frameless child window (plugin / version / logs / settings)
 * with no taskbar entry, hidden and restored in lockstep with the main window.
 *
 * Self-healing: a supervisor watches the panel's lifecycle. If the window is
 * destroyed or its renderer crashes, the panel is rebuilt and — when it was
 * open — re-shown, so it never gets stuck on a white/blank screen. Opening is
 * also renderer-aware: a dead panel is rebuilt first, and a still-loading
 * panel is shown on first paint instead of flashing white.
 */
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { getMainWindow, mainWindowEvents, iconPath } from './main'
import { superviseWindow } from './supervisor'
import { appLog } from '../logger'

let panel: BrowserWindow | null = null
let wasOpen = false
let panelFirstPaint = false
let panelVisible = false
let disposeSupervisor: (() => void) | null = null
let listenersAttached = false

function attachMainWindowListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  mainWindowEvents.on('hidden-to-tray', () => {
    const p = panel
    if (p && !p.isDestroyed() && p.isVisible()) {
      wasOpen = true
      panelVisible = false
      p.hide()
    }
  })
  mainWindowEvents.on('restored', () => {
    const p = panel
    if (!p || p.isDestroyed() || !wasOpen) return
    if (p.webContents.isCrashed()) {
      rebuildPanel('恢复时检测到渲染进程崩溃')
    } else {
      showPanel(p)
      wasOpen = false
    }
  })
}

function rebuildPanel(reason: string): void {
  // Idempotency guard: a concurrent recovery (e.g. open-after-crash racing the
  // supervisor's render-process-gone handler) may already have replaced the
  // window with a healthy one — never destroy a live, rendering panel.
  const live = panel
  if (live && !live.isDestroyed() && !live.webContents.isCrashed()) return
  appLog.warn(`控制面板自动重建：${reason}`)
  const reopen = wasOpen || panelVisible
  const old = panel
  panel = null
  panelFirstPaint = false
  if (old && !old.isDestroyed()) old.destroy()
  createControlPanel()
  if (reopen) {
    const p = getControlPanel()
    const main = getMainWindow()
    if (p && !p.isDestroyed() && main && main.isVisible() && !main.isMinimized()) {
      showPanel(p)
      wasOpen = false
    }
  }
}

export function getControlPanel(): BrowserWindow | null {
  return panel
}

export function createControlPanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel
  attachMainWindowListeners()
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
      // The panel lives hidden for long stretches (tray-resident app); keep
      // its timers/rendering alive so it is fresh the moment it is opened.
      backgroundThrottling: false,
    },
  })
  const p = panel
  panelFirstPaint = false
  void p.loadFile(path.join(__dirname, 'renderer', 'control', 'index.html'))
  p.once('ready-to-show', () => {
    panelFirstPaint = true
  })
  // "在浏览器打开" links out of the shell.
  p.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Remember visibility across tray round-trips of the main window.
  p.on('close', (e: Electron.Event) => {
    e.preventDefault()
    panel?.hide()
    wasOpen = false
    panelVisible = false
  })
  p.on('closed', () => {
    // Only clear the live reference when this is still the current window
    // (a rebuild replaces `panel` before destroying the old one).
    if (panel === p) panel = null
  })

  if (!disposeSupervisor) {
    disposeSupervisor = superviseWindow({
      name: '控制面板',
      getWindow: () => panel,
      rebuild: rebuildPanel,
      reload: () => {
        const w = panel
        if (w && !w.isDestroyed()) {
          void w.loadFile(path.join(__dirname, 'renderer', 'control', 'index.html'))
        }
      },
      isActive: () => getMainWindow() !== null,
    })
  }
  return p
}

/** Show the panel once it is painted, avoiding a white flash on first open. */
function showPanel(p: BrowserWindow): void {
  panelVisible = true
  if (panelFirstPaint) {
    p.show()
    p.focus()
    return
  }
  if (p.webContents.isLoading()) {
    p.once('ready-to-show', () => {
      if (!p.isDestroyed()) {
        p.show()
        p.focus()
      }
    })
    // Safety net: if ready-to-show never fires, show anyway after a moment.
    setTimeout(() => {
      if (!p.isDestroyed() && !p.isVisible()) {
        p.show()
        p.focus()
      }
    }, 1500)
    return
  }
  p.show()
  p.focus()
}

export function openControlPanel(): void {
  const p = ensurePanelHealthy()
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
  showPanel(p)
}

/** Return a live, healthy panel — rebuilding first if the renderer is dead. */
function ensurePanelHealthy(): BrowserWindow {
  const p = panel
  if (!p || p.isDestroyed()) return createControlPanel()
  if (p.webContents.isCrashed()) {
    rebuildPanel('打开时检测到渲染进程崩溃')
    return panel ?? createControlPanel()
  }
  return p
}

export function toggleControlPanel(): void {
  const p = panel
  if (p && !p.isDestroyed() && p.isVisible()) {
    panelVisible = false
    p.hide()
  } else {
    openControlPanel()
  }
}

export function destroyControlPanel(): void {
  if (disposeSupervisor) {
    disposeSupervisor()
    disposeSupervisor = null
  }
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
}
