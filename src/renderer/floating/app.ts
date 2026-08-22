/**
 * Floating ball behavior: pointerdown captures; small movements (< 5 px) are a
 * click (toggle the control panel), larger ones drag the window by delta via
 * IPC (the window follows the cursor so events keep arriving).
 */
export {}

interface BallBridge {
  dragBy: (dx: number, dy: number) => void
  click: () => void
}

declare global {
  interface Window {
    dshBall?: BallBridge
  }
}

const CLICK_THRESHOLD_PX = 5

const ball = document.getElementById('ball')!
let dragging = false
let moved = 0
let lastX = 0
let lastY = 0

ball.addEventListener('pointerdown', (e: PointerEvent) => {
  if (e.button !== 0) return
  dragging = true
  moved = 0
  lastX = e.screenX
  lastY = e.screenY
  ball.classList.add('dragging')
  ball.setPointerCapture(e.pointerId)
})

ball.addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  if (dx === 0 && dy === 0) return
  lastX = e.screenX
  lastY = e.screenY
  moved += Math.abs(dx) + Math.abs(dy)
  window.dshBall?.dragBy(dx, dy)
})

function endDrag(e: PointerEvent): void {
  if (!dragging) return
  dragging = false
  ball.classList.remove('dragging')
  try {
    ball.releasePointerCapture(e.pointerId)
  } catch {
    /* pointer already gone */
  }
  if (moved < CLICK_THRESHOLD_PX) window.dshBall?.click()
}

ball.addEventListener('pointerup', endDrag)
ball.addEventListener('pointercancel', endDrag)

ball.addEventListener('contextmenu', (e) => e.preventDefault())
