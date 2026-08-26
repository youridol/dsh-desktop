/**
 * Floating ball: a small transparent child window pinned over the main
 * window's bottom-right corner. Single click toggles the control panel;
 * dragging moves the ball (offset persisted relative to the main window).
 *
 * Self-healing: a supervisor watches the ball's lifecycle. If the window is
 * destroyed or its renderer crashes, the ball is rebuilt and re-shown, and a
 * periodic refresh keeps it positioned + visible in step with the main
 * window — the floating entry never permanently disappears.
 */
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { getConfig, mutateConfig } from '../config'
import { getMainWindow, mainWindowEvents } from './main'
import { toggleControlPanel } from './control'
import { superviseWindow } from './supervisor'

const BALL_SIZE = 56
const DEFAULT_MARGIN = 24
const MIN_OFFSET = { x: -400, y: -400 }
/** A drag is considered finished after this long without new deltas. */
const DRAG_IDLE_MS = 1000

let ball: BrowserWindow | null = null
let disposeSupervisor: (() => void) | null = null
let listenersAttached = false
let dragging = false
let dragTimer: NodeJS.Timeout | null = null

function attachMainWindowListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  mainWindowEvents.on('moved', () => reposition())
  mainWindowEvents.on('hidden-to-tray', () => reposition())
}

function rebuildBall(): void {
  // Idempotency guard: a concurrent recovery may already have rebuilt the
  // ball — never destroy a live, rendering window.
  const live = ball
  if (live && !live.isDestroyed() && !live.webContents.isCrashed()) return
  const old = ball
  ball = null
  if (old && !old.isDestroyed()) old.destroy()
  createFloatingBall()
}

export function createFloatingBall(): void {
  const main = getMainWindow()
  if (!main || (ball && !ball.isDestroyed())) return
  attachMainWindowListeners()

  ball = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    parent: main,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-floating.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // Owned child windows stay above their parent on Windows; that plus the
  // parent link is all the "always on top of the DSH UI" we need.
  void ball.loadFile(path.join(__dirname, 'renderer', 'floating', 'index.html'))
  ball.once('ready-to-show', () => {
    const b = ball
    if (!b || b.isDestroyed()) return
    reposition()
    b.show()
    syncBallVisibility()
  })
  ball.on('moved', () => saveOffsetFromScreenPos())

  if (!disposeSupervisor) {
    disposeSupervisor = superviseWindow({
      name: '悬浮球',
      getWindow: () => ball,
      rebuild: rebuildBall,
      refresh: () => {
        if (dragging) return
        reposition()
        syncBallVisibility()
      },
      isActive: () => getMainWindow() !== null,
    })
  }
}

/** Offset = distance from the main window's bottom-right corner to the ball's top-left. */
function currentOffset(): { x: number; y: number } {
  const cfg = getConfig().ballOffset
  if (cfg) return cfg
  return { x: -(BALL_SIZE + DEFAULT_MARGIN), y: -(BALL_SIZE + DEFAULT_MARGIN) }
}

function reposition(): void {
  const main = getMainWindow()
  if (!main || !ball || ball.isDestroyed()) return
  const b = main.getBounds()
  const off = currentOffset()
  let x = b.x + b.width + off.x
  let y = b.y + b.height + off.y
  // Clamp inside the main window so the ball never drifts off.
  x = Math.min(Math.max(x, b.x + 4), b.x + b.width - BALL_SIZE - 4)
  y = Math.min(Math.max(y, b.y + 4), b.y + b.height - BALL_SIZE - 4)
  ball.setPosition(x, y, false)
}

function saveOffsetFromScreenPos(): void {
  const main = getMainWindow()
  if (!main || !ball || ball.isDestroyed()) return
  const b = main.getBounds()
  const p = ball.getPosition()
  const x = Math.max(p[0] - (b.x + b.width), MIN_OFFSET.x)
  const y = Math.max(p[1] - (b.y + b.height), MIN_OFFSET.y)
  mutateConfig((draft) => {
    draft.ballOffset = { x, y }
  })
}

/** Move by delta while the renderer drags (pointer events drive this). */
export function dragBallBy(dx: number, dy: number): void {
  if (!ball || ball.isDestroyed()) return
  dragging = true
  if (dragTimer) clearTimeout(dragTimer)
  dragTimer = setTimeout(() => {
    dragging = false
    dragTimer = null
  }, DRAG_IDLE_MS)
  const [x, y] = ball.getPosition()
  const main = getMainWindow()
  if (main) {
    const b = main.getBounds()
    const nx = Math.min(Math.max(x + dx, b.x + 4), b.x + b.width - BALL_SIZE - 4)
    const ny = Math.min(Math.max(y + dy, b.y + 4), b.y + b.height - BALL_SIZE - 4)
    ball.setPosition(nx, ny, false)
  } else {
    ball.setPosition(x + dx, y + dy, false)
  }
}

export function ballClicked(): void {
  toggleControlPanel()
}

export function destroyFloatingBall(): void {
  if (disposeSupervisor) {
    disposeSupervisor()
    disposeSupervisor = null
  }
  if (dragTimer) clearTimeout(dragTimer)
  dragTimer = null
  if (ball && !ball.isDestroyed()) ball.destroy()
  ball = null
}

export function syncBallVisibility(): void {
  const main = getMainWindow()
  if (!main || !ball || ball.isDestroyed()) return
  if (main.isVisible() && !main.isMinimized()) {
    if (!ball.isVisible()) ball.showInactive()
  } else if (ball.isVisible()) {
    ball.hide()
  }
}
