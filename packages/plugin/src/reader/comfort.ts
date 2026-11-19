import { Platform } from 'obsidian'
import { el } from './ui'
import type { RulerStyle } from '../settings'

/**
 * Reading comfort shared by the EPUB and PDF readers: a dimmer below the screen's lowest brightness,
 * keeping the screen on while reading, and a reading ruler.
 */

/** A black layer over the whole reader (pointer events pass through). 0 = off. */
export class Dimmer {
  private layer: HTMLElement
  constructor(root: HTMLElement) {
    this.layer = el('div', 'octavo-dim', root)
    this.layer.setAttribute('aria-hidden', 'true')
  }
  set(level: number): void {
    const v = Math.max(0, Math.min(0.7, level || 0))
    this.layer.toggle(v > 0)
    this.layer.setCssProps({ '--octavo-dim': String(v) })
  }
}

interface WakeLockSentinelLike { released: boolean; release(): Promise<void> }
type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }

/** Minutes without a page turn or tap after which the screen may sleep again. */
export const AWAKE_IDLE_MS = 10 * 60_000

/**
 * Keeps the screen on while a book is being read (Screen Wake Lock API). The lock is dropped after
 * AWAKE_IDLE_MS without activity, when the tab is hidden or the reader is not the active view, and
 * taken again on the next activity. Does nothing where the API is missing.
 */
export class AwakeKeeper {
  private lock: WakeLockSentinelLike | null = null
  /** A request on its way: further pokes wait for it instead of asking for (and leaking) a second lock. */
  private asking = false
  private idle = 0
  private wanted = false
  constructor(private doc: () => Document, private enabled: () => boolean, private active: () => boolean) {}

  /** Call on page turns, taps and scrolls. */
  poke(): void {
    if (!this.enabled() || !this.active()) return this.release()
    this.wanted = true
    window.clearTimeout(this.idle)
    this.idle = window.setTimeout(() => this.release(), AWAKE_IDLE_MS)
    if ((!this.lock || this.lock.released) && !this.asking) void this.acquire()
  }

  /** The page became visible again: the browser dropped the lock while hidden. */
  onVisible(): void { if (this.wanted && !this.doc().hidden) this.poke() }

  private async acquire(): Promise<void> {
    const wl = (this.doc().defaultView?.navigator as WakeNavigator)?.wakeLock
    if (!wl || this.doc().hidden) return
    this.asking = true
    try {
      const got = await wl.request('screen')
      // released (idle, closed, hidden) while the request was on its way: let it go at once
      if (!this.wanted) void got.release().catch(() => {})
      else this.lock = got
    } catch { this.lock = null } finally { this.asking = false }
  }

  release(): void {
    this.wanted = false
    window.clearTimeout(this.idle)
    const l = this.lock
    this.lock = null
    if (l && !l.released) void l.release().catch(() => {})
  }
}

/** A line of text on screen, top and bottom in viewport pixels. */
export interface LineBand { top: number; bottom: number }

/**
 * Text rectangles (viewport pixels) merged into lines: rectangles that overlap vertically by at least half of
 * the shorter one are the same line (two columns side by side share a line). Only lines fully inside
 * `top`..`bottom` are kept. Sorted top to bottom.
 */
export function mergeTextLines(rects: Array<{ top: number; bottom: number }>, top: number, bottom: number): LineBand[] {
  const rs = rects.filter(r => r.bottom - r.top > 2 && r.top >= top - 1 && r.bottom <= bottom + 1).sort((a, b) => a.top - b.top)
  const out: LineBand[] = []
  for (const r of rs) {
    const last = out[out.length - 1]
    const overlap = last ? Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top) : 0
    if (last && overlap >= 0.5 * Math.min(last.bottom - last.top, r.bottom - r.top)) {
      last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom)
    } else out.push({ top: r.top, bottom: r.bottom })
  }
  return out
}

/** Index of the line nearest to `y` (by its middle), or -1 when there are no lines. */
export function nearestLine(lines: LineBand[], y: number): number {
  let best = -1, d = Infinity
  lines.forEach((l, i) => {
    const dist = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0
    if (dist < d) { d = dist; best = i }
  })
  return best
}

/** The band over line `i` (and its neighbours when `count` is 3), with a little air above and below. */
export function bandOver(lines: LineBand[], i: number, count: 1 | 3): LineBand {
  const a = count === 3 ? Math.max(0, i - 1) : i, b = count === 3 ? Math.min(lines.length - 1, i + 1) : i
  const first = lines[a], last = lines[b]
  const pad = Math.max(2, (first.bottom - first.top) * 0.18)
  return { top: first.top - pad, bottom: last.bottom + pad }
}

/** Rectangles of the text under `root` (a book section or the PDF Text view) inside `view` (viewport pixels). */
export function textRects(root: Node, view: DOMRect, dx = 0, dy = 0): Array<{ top: number; bottom: number }> {
  const doc = root.ownerDocument ?? (root as Document)
  const out: Array<{ top: number; bottom: number }> = []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (!(n as Text).data.trim() || n.parentElement?.closest('script,style,rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const range = doc.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const box = n.parentElement?.getBoundingClientRect()
    if (box && (box.bottom + dy < view.top || box.top + dy > view.bottom || box.right + dx < view.left || box.left + dx > view.right)) continue
    range.selectNodeContents(n)
    for (const r of Array.from(range.getClientRects())) {
      if (r.right + dx < view.left || r.left + dx > view.right || r.width < 1) continue
      out.push({ top: r.top + dy, bottom: r.bottom + dy })
    }
  }
  return out
}

export interface RulerLook { style: RulerStyle; lines: 1 | 3; darkness: number }

/**
 * Reading ruler (styles from the CHI 2023 study "Digital Reading Rulers"): Lightbox clears the line and dims the
 * rest, Shade dims only what is above (already read), Bar tints the line, Underline draws a line under it.
 * The band sits on real lines of text when the reader gives it a `lines` source, otherwise on a band of
 * `fallbackH`. Desktop: slides freely with the pointer, one line tall. Touch: drag the handle. Keys: up and down step it onto the next line (`step`);
 * after a page turn it starts on the first line again. Colours come from the theme; it glides between lines
 * unless the system asks for reduced motion.
 */
export class Ruler {
  private box: HTMLElement
  private handle: HTMLElement
  /** middle of the band, in pixels from the top of the reader */
  private y = -1
  private fallbackH = 28
  private look: RulerLook = { style: 'lightbox', lines: 1, darkness: 0.25 }
  private source: (() => LineBand[] | null) | null = null
  private cache: LineBand[] | null = null
  private pendingEdge: 1 | -1 | 0 = 0
  /** following the pointer or a finger: the band slides freely (a ruler over the page); keys and read-aloud step it onto lines */
  private free = false
  private timer = 0
  on = false

  constructor(private root: HTMLElement) {
    this.box = el('div', 'octavo-ruler', root)
    this.box.setAttribute('aria-hidden', 'true')
    el('div', 'octavo-ruler-above', this.box)
    el('div', 'octavo-ruler-band', this.box)
    el('div', 'octavo-ruler-below', this.box)
    this.handle = el('div', 'octavo-ruler-handle', this.box)
    this.handle.setAttribute('aria-label', 'Drag the reading ruler')
    this.handle.addEventListener('pointerdown', e => this.drag(e))
    this.box.hide()
  }

  set(on: boolean, look: RulerLook, fallbackLineH: number): void {
    const was = this.on
    this.on = on
    this.look = look
    this.fallbackH = Math.max(14, fallbackLineH)
    this.box.toggle(on)
    this.handle.toggle(Platform.isMobile)
    this.box.dataset.style = look.style
    this.box.setCssProps({ '--ruler-dark': String(Math.max(0.05, Math.min(0.7, look.darkness))) })
    if (on && !was) this.pendingEdge = 1
    this.invalidate()
  }

  /** Where the lines of text are now (viewport pixels); null when there is no text layer. */
  setSource(fn: (() => LineBand[] | null) | null): void { this.source = fn; this.invalidate() }

  /**
   * The text moved (page turn, scroll, resize, new look): find the lines again once layout settles.
   * `edge`: a page turn forwards (1) puts the ruler on the first line, backwards (-1) on the last.
   */
  invalidate(edge: 1 | -1 | 0 = 0): void {
    if (edge) this.pendingEdge = this.pendingEdge || edge
    this.cache = null
    if (!this.on) return
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.place(), 180)
  }

  /** Pointer position in window coordinates (desktop), forwarded from the book's iframe too. */
  pointerAt(clientY: number): void {
    if (!this.on || Platform.isMobile) return
    this.y = clientY - this.root.getBoundingClientRect().top
    this.free = true
    this.pendingEdge = 0 // the pointer is where the reader is looking: it wins over "start at the top"
    this.place()
  }

  /** Read-aloud: put the ruler on the line being spoken (window coordinates). */
  follow(top: number, bottom: number): void {
    if (!this.on) return
    this.cache = null
    this.pendingEdge = 0
    this.free = false
    this.y = (top + bottom) / 2 - this.root.getBoundingClientRect().top
    this.place()
  }

  /** One line down (1) or up (-1). Returns false at the last (or first) line, where the page should turn. */
  step(dir: 1 | -1): boolean {
    const lines = this.lines()
    const rt = this.root.getBoundingClientRect().top
    if (lines?.length) {
      const i = nearestLine(lines, this.y + rt)
      this.free = false
      const next = i + dir
      if (next < 0 || next >= lines.length) { this.pendingEdge = dir; return false }
      this.y = (lines[next].top + lines[next].bottom) / 2 - rt
      this.place()
      return true
    }
    const h = this.root.clientHeight || 1
    const next = this.y + dir * this.fallbackH
    if (next > h * 0.92 || next < h * 0.06) { this.pendingEdge = dir; return false }
    this.y = next
    this.place()
    return true
  }

  private lines(): LineBand[] | null {
    if (this.cache) return this.cache
    if (!this.source) return null
    try { this.cache = this.source() } catch { this.cache = null }
    return this.cache?.length ? this.cache : null
  }

  private place(): void {
    if (!this.on) return
    const rr = this.root.getBoundingClientRect()
    const h = rr.height || 1
    const lines = this.lines()
    const n = this.look.lines
    let top: number, bottom: number
    if (this.pendingEdge) this.free = false
    if (lines?.length && this.free) {
      // slide with the pointer, as tall as the lines under it (their spacing, so it never cuts a line in half)
      const i = nearestLine(lines, this.y + rr.top)
      const l = lines[i], next = lines[i + 1], prev = lines[i - 1]
      const pitch = next ? next.top - l.top : prev ? l.top - prev.top : (l.bottom - l.top) * 1.3
      const bh = Math.max(l.bottom - l.top, Math.min(pitch, (l.bottom - l.top) * 2)) * n + (l.bottom - l.top) * 0.3
      top = Math.max(0, Math.min(h - bh, this.y - bh / 2)); bottom = top + bh
    } else if (lines?.length) {
      let i: number
      if (this.pendingEdge) i = this.pendingEdge > 0 ? Math.min(lines.length - 1, n === 3 ? 1 : 0) : Math.max(0, lines.length - (n === 3 ? 2 : 1))
      else i = nearestLine(lines, this.y < 0 ? rr.top + h * 0.3 : this.y + rr.top)
      const b = bandOver(lines, i, n)
      top = b.top - rr.top; bottom = b.bottom - rr.top
      this.y = (lines[i].top + lines[i].bottom) / 2 - rr.top
    } else {
      if (this.pendingEdge) this.y = this.pendingEdge > 0 ? h * 0.1 : h * 0.88
      else if (this.y < 0) this.y = h * 0.3
      const bh = this.fallbackH * (n === 3 ? 3 : 1) * 1.25
      top = Math.max(0, Math.min(h - bh, this.y - bh / 2)); bottom = top + bh
    }
    this.pendingEdge = 0
    this.box.toggleClass('is-free', this.free)
    this.box.setCssProps({ '--ruler-top': `${Math.round(top)}px`, '--ruler-h': `${Math.round(bottom - top)}px` })
  }

  private drag(e: PointerEvent): void {
    e.preventDefault(); e.stopPropagation()
    const win = this.root.win
    const move = (ev: PointerEvent) => { this.y = ev.clientY - this.root.getBoundingClientRect().top; this.free = true; this.pendingEdge = 0; this.place() }
    const up = () => { win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up) }
    win.addEventListener('pointermove', move)
    win.addEventListener('pointerup', up)
    win.addEventListener('pointercancel', up)
  }
}
