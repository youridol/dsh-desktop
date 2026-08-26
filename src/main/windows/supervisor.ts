/**
 * Window supervisor: shared lifecycle / renderer-health watchdog for the
 * app's child windows (floating ball, control panel).
 *
 * Each window module owns its window and plugs in narrow callbacks; the
 * supervisor handles the generic "is the window still alive and rendering"
 * concern so the two modules do not duplicate it:
 *
 *  - hooks `render-process-gone` / `did-fail-load` on every window instance;
 *  - polls for window loss (destroyed / never created) and renderer crashes;
 *  - calls `rebuild()` to recreate a lost/crashed window, or `reload()` to
 *    retry a failed page load while the window itself is still alive;
 *  - calls `refresh()` each tick while healthy (visibility/position sync);
 *  - rate-limits recovery actions so a persistently broken page never turns
 *    into a hot rebuild loop.
 *
 * The pure decision helpers at the top are unit-testable without Electron.
 */
import { BrowserWindow } from 'electron'
import { appLog } from '../logger'

/** Minimum gap between two recovery actions (rebuild / reload). */
export const MIN_RECOVERY_INTERVAL_MS = 5000

/** Health snapshot consumed by the pure decision helper. */
export interface WindowHealthSnapshot {
  /** Window reference exists and is not destroyed. */
  exists: boolean
  /** Renderer process has crashed. */
  crashed: boolean
}

export type WindowHealthDecision = 'rebuild' | 'none'

/**
 * Pure decision: a window must be rebuilt when the reference is gone
 * (destroyed/closed/never created) or its renderer crashed. Unit-tested.
 */
export function evaluateWindowHealth(s: WindowHealthSnapshot): WindowHealthDecision {
  if (!s.exists || s.crashed) return 'rebuild'
  return 'none'
}

/**
 * Pure rate-limit check: a recovery action is throttled when another one
 * happened less than MIN_RECOVERY_INTERVAL_MS ago. `msSinceLast` is -1 when
 * no recovery action ever ran. Unit-tested.
 */
export function isRecoveryRateLimited(msSinceLastRecovery: number, minIntervalMs = MIN_RECOVERY_INTERVAL_MS): boolean {
  return msSinceLastRecovery >= 0 && msSinceLastRecovery < minIntervalMs
}

export interface WindowSupervisorOptions {
  /** Human-readable window name for logs. */
  name: string
  /** Current window, or null before first creation / after destruction. */
  getWindow: () => BrowserWindow | null
  /** Recreate the window from scratch (lost / crashed / load cannot retry). */
  rebuild: (reason: string) => void
  /** Re-run the page load on the existing window (did-fail-load retry). */
  reload?: () => void
  /** Reconcile visibility/position while the window is healthy (per tick). */
  refresh?: () => void
  /** Optional gate; when it returns false the supervisor idles (e.g. quit). */
  isActive?: () => boolean
  /** Health poll interval in ms. Defaults to 3000. */
  intervalMs?: number
}

/**
 * Start supervising a window. Returns a dispose function. The supervisor is
 * intentionally conservative: it never touches the window while healthy, and
 * it only ever acts through the module-provided rebuild/reload callbacks.
 */
export function superviseWindow(opts: WindowSupervisorOptions): () => void {
  const { name, getWindow, rebuild, reload, refresh, isActive, intervalMs = 3000 } = opts
  let disposed = false
  let lastRecoveryAt = -1
  let hooked: BrowserWindow | null = null

  const recovery = (action: () => void, reason: string): void => {
    if (disposed) return
    const now = Date.now()
    if (isRecoveryRateLimited(now - lastRecoveryAt)) {
      appLog.warn(`${name} 自动恢复被限流，稍后重试：${reason}`)
      return
    }
    lastRecoveryAt = now
    appLog.warn(`${name} 自动恢复：${reason}`)
    action()
  }

  const hook = (win: BrowserWindow): void => {
    if (win === hooked) return
    hooked = win
    win.webContents.once('render-process-gone', (_e, details) => {
      if (disposed || win !== hooked) return
      recovery(() => rebuild(`渲染进程异常 (${details.reason})`), `渲染进程异常 (${details.reason})`)
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (disposed || win !== hooked) return
      // ERR_ABORTED (-3) means the navigation was superseded, not a failure.
      if (code === -3) return
      if (reload) {
        recovery(() => reload(), `页面加载失败 (${code} ${desc})`)
      } else {
        recovery(() => rebuild(`页面加载失败 (${code} ${desc})`), `页面加载失败 (${code} ${desc})`)
      }
    })
    win.once('closed', () => {
      if (hooked === win) hooked = null
      // Re-evaluate right away so a lost window is rebuilt without waiting
      // for the next poll tick.
      if (!disposed) setImmediate(tick)
    })
  }

  const tick = (): void => {
    if (disposed) return
    if (isActive && !isActive()) return
    const win = getWindow()
    if (!win || win.isDestroyed()) {
      recovery(() => rebuild('窗口丢失'), '窗口丢失')
      return
    }
    hook(win)
    if (win.webContents.isCrashed()) {
      recovery(() => rebuild('渲染进程崩溃'), '渲染进程崩溃')
      return
    }
    refresh?.()
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()

  return () => {
    disposed = true
    clearInterval(timer)
  }
}
