import { el, iconButton } from './ui'

/** What a reader gives the peek: a range to scrub and a preview of any point in it. */
export interface PeekSource {
  /** Scrub range is 0..max (EPUB: per mille of the book, PDF: pages 1..max). */
  min: number
  max: number
  /** Where the reader is now. */
  value: number
  /** Short text for a point: "p. 12", "34%". */
  label(v: number): string
  /** Draw a preview of point `v` into `host` (called often while scrubbing; keep the last one only). */
  show(v: number, host: HTMLElement): Promise<string | void> | string | void
  /** Move the reader to `v` (Go here). */
  go(v: number): void
  /** Free the preview (closing the peek). */
  dispose?(): void
}

/**
 * Page Flip-style peek: scrub through the book in a preview while the page you are reading stays put.
 * "Go here" moves the reader; Back, Escape or a tap outside return to your page untouched.
 */
export class Peek {
  private box: HTMLElement
  private preview: HTMLElement
  private slider: HTMLInputElement
  private label: HTMLElement
  private detail: HTMLElement
  private src: PeekSource | null = null
  private timer = 0
  private seq = 0

  constructor(root: HTMLElement) {
    this.box = el('div', 'octavo-peek', root)
    this.box.setAttribute('role', 'dialog')
    this.box.setAttribute('aria-label', 'Flip through')
    this.box.addEventListener('pointerdown', e => e.stopPropagation())
    this.box.addEventListener('click', e => { e.stopPropagation(); if (e.target === this.box) this.hide() })
    this.box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.hide() } })
    const card = el('div', 'octavo-peek-card', this.box)
    const head = el('div', 'octavo-peek-head', card)
    this.label = el('div', 'octavo-peek-label', head)
    this.detail = el('div', 'octavo-peek-detail', head)
    iconButton(head, 'x', 'Back to your page', () => this.hide())
    this.preview = el('div', 'octavo-peek-preview', card)
    this.slider = el('input', 'octavo-peek-slider', card)
    this.slider.type = 'range'
    this.slider.setAttribute('aria-label', 'Flip through the book')
    this.slider.addEventListener('input', () => this.scrub())
    const actions = el('div', 'octavo-peek-actions', card)
    el('button', '', actions, 'Back to your page').onclick = () => this.hide()
    const go = el('button', 'mod-cta', actions, 'Go here')
    go.onclick = () => { const s = this.src, v = Number(this.slider.value); this.hide(); s?.go(v) }
    this.box.hide()
  }

  get visible(): boolean { return this.box.isShown() }

  open(src: PeekSource): void {
    this.src = src
    this.slider.min = String(src.min); this.slider.max = String(src.max); this.slider.step = '1'
    this.slider.value = String(src.value)
    this.box.show()
    this.scrub(0)
    window.setTimeout(() => this.slider.focus())
  }

  hide(): void {
    window.clearTimeout(this.timer)
    this.box.hide()
    this.src?.dispose?.()
    this.src = null
    this.preview.empty()
  }

  private scrub(delay = 90): void {
    const src = this.src
    if (!src) return
    const v = Number(this.slider.value)
    this.label.setText(src.label(v))
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      const my = ++this.seq
      void Promise.resolve(src.show(v, this.preview)).then(d => { if (my === this.seq && this.src === src) this.detail.setText(d || '') })
    }, delay)
  }
}
