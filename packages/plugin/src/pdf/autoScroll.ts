/**
 * Pure logic for PDF auto-scroll and the scroll-direction lock (PdfView wires them to the DOM).
 */

export type Axis = 'x' | 'y'

/** Pause at the bottom of a page before turning to the next one (paged mode). */
export const TURN_PAUSE_MS = 1200
/** Movement needed before the dominant axis of a gesture is decided. */
export const LOCK_THRESHOLD = 10
/** A wheel gesture ends after this much quiet. */
export const WHEEL_IDLE_MS = 200

/**
 * Pixels to scroll this frame at `speed` px/s. Fractions carry over (`acc`) so slow speeds still move evenly;
 * a long frame (hitch, background tab) counts as at most 100 ms so the page never jumps.
 */
export function scrollStep(acc: number, dtMs: number, speed: number): { px: number; acc: number } {
  const dt = Math.min(100, Math.max(0, dtMs))
  const total = acc + (dt / 1000) * Math.max(0, speed)
  const px = Math.floor(total)
  return { px, acc: total - px }
}

export type AutoAction = 'scroll' | 'wait' | 'turn' | 'end'

/**
 * What auto-scroll does next. Vertical: scroll until the end of the book. Paged: scroll within the page; at its
 * bottom (or when it fits) wait, then turn. `waited` is ms since the bottom was reached (null = just now).
 * A page that fits stays up as long as scrolling one screen would take at this speed (at least the pause).
 */
export function autoScrollAction(o: { paged: boolean; top: number; view: number; height: number; lastPage: boolean; waited: number | null; speed: number; pauseMs?: number }): AutoAction {
  const atBottom = o.top + o.view >= o.height - 2
  if (!o.paged) return atBottom ? 'end' : 'scroll'
  // a page that (nearly) fits counts as at its bottom: pdf.js parks it a margin below the top (as wheelTurn)
  const fits = o.height - o.view < 120
  if (!fits && !atBottom) return 'scroll'
  if (o.lastPage) return 'end'
  const pause = o.pauseMs ?? TURN_PAUSE_MS
  const need = fits ? Math.max(pause, (o.view / Math.max(1, o.speed)) * 1000) : pause
  return o.waited !== null && o.waited >= need ? 'turn' : 'wait'
}

/** The dominant axis once a gesture has moved `threshold` px (vertical wins a tie), else null. */
export function decideAxis(dx: number, dy: number, threshold = LOCK_THRESHOLD): Axis | null {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (Math.hypot(ax, ay) < threshold) return null
  return ax > ay ? 'x' : 'y'
}

export interface AxisGesture { axis: Axis | null; sx: number; sy: number; last: number }

/**
 * One wheel event of a gesture. A new gesture starts after `idleMs` of quiet; its axis is decided from the
 * first ~10 px and kept until it ends. `suppress` = the event also moves on the other axis, so the caller
 * cancels it and scrolls the locked axis itself.
 */
export function wheelLock(g: AxisGesture | null, dx: number, dy: number, now: number, idleMs = WHEEL_IDLE_MS, threshold = LOCK_THRESHOLD): { gesture: AxisGesture; axis: Axis | null; suppress: boolean } {
  const cur: AxisGesture = !g || now - g.last > idleMs ? { axis: null, sx: 0, sy: 0, last: now } : { ...g, last: now }
  if (!cur.axis) {
    cur.sx += Math.abs(dx); cur.sy += Math.abs(dy)
    cur.axis = decideAxis(cur.sx, cur.sy, threshold)
  }
  const minor = cur.axis === 'x' ? dy : cur.axis === 'y' ? dx : 0
  return { gesture: cur, axis: cur.axis, suppress: !!cur.axis && minor !== 0 }
}
