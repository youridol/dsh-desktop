/**
 * DSH Desktop entry point.
 *
 * Boot order: single-instance lock -> runtime dirs/config/logs -> windows
 * (main + floating ball) + tray + IPC -> DSH service autostart.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { getPaths, ensureRuntimeDirs } from './paths'
import { initLogger, appLog } from './logger'
import { getConfig } from './config'
import { registerIpc } from './ipc'
import { createMainWindow, showMainWindow } from './windows/main'
import { createFloatingBall, syncBallVisibility, destroyFloatingBall } from './windows/floating'
import { createControlPanel, destroyControlPanel } from './windows/control'
import { destroyMarketWindow } from './windows/market'
import { createTray, destroyTray } from './tray'
import { setAutoStart } from './autostart'
// Built-in plugin presets removed — use dsh plugin --profile web CLI instead
import * as dsh from './dsh/manager'
import * as versions from './versions'
import { mainWindowEvents } from './windows/main'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Use a productName-scoped userData dir: the bare package name can collide
  // with unrelated leftover data from other projects in %APPDATA%.
  app.setPath('userData', join(app.getPath('appData'), 'DSH Desktop'))

  app.on('second-instance', () => showMainWindow())

  void app.whenReady().then(async () => {
    ensureRuntimeDirs()
    initLogger()
    appLog.info(
      `DSH Desktop starting — version=${app.getVersion()} packaged=${app.isPackaged} ` +
        `portable=${getPaths().isPortable} runtime=${getPaths().runtimeDir}`,
    )
    registerIpc()

    await createMainWindow()
    createFloatingBall()
    createControlPanel()
    createTray()

    // Keep the floating ball in step with main-window visibility.
    mainWindowEvents.on('hidden-to-tray', () => syncBallVisibility())
    mainWindowEvents.on('restored', () => syncBallVisibility())

    // Honor stored auto-start preference in case the exe moved (portable).
    if (app.isPackaged && getConfig().autoStart) setAutoStart(true)

    if (getConfig().checkUpdatesOnStart) {
      versions
        .checkForUpdates()
        .then((r) => {
          if (r.rateLimited) {
            appLog.warn('启动时检查更新：GitHub 限流（403），可在设置中配置 Token 提升限额')
          } else if (r.offline) {
            appLog.warn('启动时检查更新：离线，跳过')
          } else if (r.hasUpdate && r.latest) {
            appLog.warn(`发现新版本 ${r.latest.version}（当前 ${r.current}），可在控制面板-版本管理中更新`)
          }
        })
        .catch((err) => appLog.warn(`启动时检查更新失败: ${String(err)}`))
    }

    await dsh.start()
  })

  app.on('before-quit', () => {
    appLog.info('App quitting — stopping DSH')
    dsh.shutdownSync()
    destroyFloatingBall()
    destroyControlPanel()
    destroyMarketWindow()
    destroyTray()
  })

  app.on('window-all-closed', () => {
    // Tray-resident: quitting happens only via the tray menu.
  })
}
