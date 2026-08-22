/**
 * Windows login auto-start via app.setLoginItemSettings. Packaged builds point
 * at their own exe; the settings page toggles this synchronously.
 */
import { app } from 'electron'

export function getAutoStart(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

export function setAutoStart(enabled: boolean): boolean {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // For portable builds placed anywhere, the exe path is still correct.
      path: app.isPackaged ? process.execPath : undefined,
      args: [],
    })
    return getAutoStart()
  } catch {
    return false
  }
}
