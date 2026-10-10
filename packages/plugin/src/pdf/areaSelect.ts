import { dragBox } from './region'

export interface AreaPick {
  pageNumber: number
  /** The drag in page-canvas CSS px (top-left origin), clamped to the page. */
  box: { x: number; y: number; w: number; h: number }
  /** The page canvas's CSS size, to scale the box into the pdf.js viewport. */
  width: number
  height: number
  clientX: number
  clientY: number
  /** Removes the drawn rectangle (call once the follow-up menu closes). */
  clear: () => void
}

/**
 * "Select area" mode for the PDF page view: drag a rectangle over one page with mouse, pen or finger
 * (Pointer Events, so touch works too). While it's on, text selection, tap zones, swipes and pinches are
 * suspended. Esc or `cancel()` leaves the mode. One pick per activation.
 */
export class AreaSelect {
  active = false
  private drag: { pageEl: HTMLElement; wrap: HTMLElement; x0: number; y0: number; rectEl: HTMLElement; id: number } | null = null
  private suppressClickUntil = 0

  constructor(private root: HTMLElement, private container: HTMLElement, private onPick: (p: AreaPick) => void, private onChange: (active: boolean) => void = () => {}) {
    const opts = { capture: true }
    root.addEventListener('pointerdown', e => this.down(e), opts)
    root.addEventListener('pointermove', e => this.move(e), opts)
    root.addEventListener('pointerup', e => this.up(e), opts)
    root.addEventListener('pointercancel', () => this.abortDrag(), opts)
    // keep the reader's own touch gestures (swipe to turn, pinch) and tap zones out of the way
    for (const t of ['touchstart', 'touchmove', 'touchend', 'click', 'dblclick'] as const) {
      root.addEventListener(t, e => {
        if (!this.active && Date.now() > this.suppressClickUntil) return
        if (!this.container.contains(e.target as Node)) return
        e.stopPropagation()
        if (t === 'touchmove' && e.cancelable) e.preventDefault()
      }, { capture: true, passive: false })
    }
  }

  start() {
    if (this.active) return
    this.active = true
    this.root.addClass('is-area-select')
    this.root.ownerDocument.getSelection()?.removeAllRanges()
    this.onChange(true)
  }

  cancel() {
    this.abortDrag()
    if (!this.active) return
    this.active = false
    this.root.removeClass('is-area-select')
    this.onChange(false)
  }

  private down(e: PointerEvent) {
    if (!this.active || e.button > 0) return
    const pageEl = (e.target as Element).closest?.('.page') as HTMLElement | null
    if (!pageEl || !this.container.contains(pageEl)) return
    e.preventDefault(); e.stopPropagation()
    const wrap = (pageEl.querySelector('.canvasWrapper') as HTMLElement | null) ?? pageEl
    const r = wrap.getBoundingClientRect()
    const rectEl = pageEl.createDiv({ cls: 'octavo-pdf-area' })
    this.drag = { pageEl, wrap, x0: e.clientX - r.left, y0: e.clientY - r.top, rectEl, id: e.pointerId }
    try { this.root.setPointerCapture(e.pointerId) } catch { /* synthetic events have no capture */ }
    this.draw(e)
  }

  private move(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return
    e.preventDefault(); e.stopPropagation()
    this.draw(e)
  }

  private draw(e: PointerEvent) {
    const d = this.drag!
    const r = d.wrap.getBoundingClientRect()
    const b = dragBox(d.x0, d.y0, e.clientX - r.left, e.clientY - r.top, r.width, r.height, 0) ?? { x: d.x0, y: d.y0, w: 0, h: 0 }
    d.rectEl.setCssStyles({ left: `${d.wrap.offsetLeft + b.x}px`, top: `${d.wrap.offsetTop + b.y}px`, width: `${b.w}px`, height: `${b.h}px` })
  }

  private up(e: PointerEvent) {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    e.preventDefault(); e.stopPropagation()
    this.drag = null
    this.suppressClickUntil = Date.now() + 400
    try { this.root.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    const r = d.wrap.getBoundingClientRect()
    const box = dragBox(d.x0, d.y0, e.clientX - r.left, e.clientY - r.top, r.width, r.height)
    if (!box) { d.rectEl.remove(); return } // a stray click: stay in area mode
    d.rectEl.addClass('is-done')
    this.cancel()
    this.onPick({ pageNumber: Number(d.pageEl.dataset.pageNumber) || 1, box, width: r.width, height: r.height, clientX: e.clientX, clientY: e.clientY, clear: () => d.rectEl.remove() })
  }

  private abortDrag() {
    this.drag?.rectEl.remove()
    this.drag = null
  }
}
