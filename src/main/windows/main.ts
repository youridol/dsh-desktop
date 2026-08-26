/**
 * Main window: shows a local loader page while DSH starts, then navigates to
 * the DSH Web UI. Minimize/close hide to tray instead of quitting.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { BrowserWindow, app, shell } from 'electron'
import { getStatus, dshEvents, probeService } from '../dsh/manager'
import { getConfig } from '../config'
import { appLog } from '../logger'

export const mainWindowEvents = new EventEmitter()

let win: BrowserWindow | null = null
let screenshotOnce = false

export function getMainWindow(): BrowserWindow | null {
  return win
}

export function createMainWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'DSH Desktop',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-loader.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const denyPopups = ({ url }: { url: string }): { action: 'deny' } => {
    void shell.openExternal(url)
    return { action: 'deny' }
  }

  win.once('ready-to-show', () => win?.show())
  void win.loadFile(path.join(__dirname, 'renderer', 'loader', 'index.html'))
  win.webContents.setWindowOpenHandler(denyPopups)

  win.on('minimize', () => {
    win?.hide()
    mainWindowEvents.emit('hidden-to-tray')
  })
  win.on('close', (e: Electron.Event) => {
    // Tray-resident app: close hides; the real quit goes through the tray menu.
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      win?.hide()
      mainWindowEvents.emit('hidden-to-tray')
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.on('move', () => mainWindowEvents.emit('moved'))
  win.on('resize', () => mainWindowEvents.emit('moved'))

  dshEvents.on('status', () => void syncNavigation())
  void syncNavigation()

  return win
}

/** Navigate the main window to the loader or the live DSH UI, per service state. */
export async function syncNavigation(): Promise<void> {
  const w = win
  if (!w || w.isDestroyed()) return
  const status = getStatus()
  // getURL() returns '' before the first load completes — treat that as loader.
  let onLoader = true
  try {
    onLoader = new URL(w.webContents.getURL()).protocol === 'file:'
  } catch {
    onLoader = true
  }

  if (status.state === 'running') {
    if (onLoader) {
      appLog.info(`Main window -> DSH UI ${status.serviceUrl}`)
      await w.loadURL(status.serviceUrl)
      void maybeDebugScreenshot()
    }
  } else if (!onLoader) {
    // Service went down while showing the UI — back to the loader/error page.
    await w.loadFile(path.join(__dirname, 'renderer', 'loader', 'index.html'))
  }
  w.webContents.send('dsh:status', status)
}

async function maybeDebugScreenshot(): Promise<void> {
  const shot = process.env.DSH_DESKTOP_SHOT
  if (!shot || screenshotOnce) return
  screenshotOnce = true
  setTimeout(async () => {
    try {
      const image = await win?.webContents.capturePage()
      if (image && !image.isEmpty()) {
        fs.writeFileSync(shot, image.toPNG())
        appLog.info(`Debug screenshot saved: ${shot}`)
      }
    } catch (err) {
      appLog.warn(`Screenshot failed: ${String(err)}`)
    }
  }, 4000)
}

export function showMainWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  mainWindowEvents.emit('restored')
}

export function sendToMainWindow(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function iconPath(): string {
  // Prefer the packaged .ico; fall back to the source png.
  const ico = path.join(__dirname, 'assets', 'icon.ico')
  if (fs.existsSync(ico)) return ico
  return path.join(__dirname, 'assets', 'icon.png')
}

/** Re-check the service without changing DSH state (retry button support). */
export async function refreshServiceProbe(): Promise<boolean> {
  const ok = await probeService(getConfig().port)
  await syncNavigation()
  return ok
}
