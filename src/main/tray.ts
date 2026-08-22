/**
 * System tray: residency anchor. Close/minimize hide windows; the tray menu
 * exposes show / control panel / quit. Quit tears DSH down for real.
 */
import path from 'node:path'
import { Menu, Tray, nativeImage, app } from 'electron'
import { showMainWindow } from './windows/main'
import { openControlPanel } from './windows/control'
import { getStatus, dshEvents } from './dsh/manager'
import { appLog } from './logger'

let tray: Tray | null = null

function trayIcon() {
  const png = path.join(__dirname, '..', 'assets', 'icon.png')
  return nativeImage.createFromPath(png).resize({ width: 16, height: 16 })
}

export function createTray(): Tray {
  tray = new Tray(trayIcon())
  tray.setToolTip('DSH Desktop')
  rebuildMenu()
  tray.on('double-click', () => showMainWindow())
  dshEvents.on('status', () => {
    const s = getStatus()
    tray?.setToolTip(`DSH Desktop — ${stateLabel(s.state)} :${s.port}`)
    rebuildMenu()
  })
  return tray
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    starting: '启动中',
    stopping: '停止中',
    stopped: '已停止',
    crashed: '异常退出',
    timeout: '启动超时',
    error: '错误',
  }
  return map[state] ?? state
}

function rebuildMenu(): void {
  if (!tray) return
  const s = getStatus()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态：${stateLabel(s.state)}（:${s.port}）`, enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => {
          showMainWindow()
        },
      },
      {
        label: '打开控制面板',
        click: () => {
          showMainWindow()
          openControlPanel()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          appLog.info('Quit requested from tray')
          ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
          app.quit()
        },
      },
    ]),
  )
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
