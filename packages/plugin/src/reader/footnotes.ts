import { FootnoteHandler, type FootnoteRender } from '@octavo/foliate/footnotes.js'
import type { Book, View } from '@octavo/foliate/view.js'
import { el, iconButton } from './ui'

/**
 * EPUB footnotes and endnotes in a pop-up over the page, as in Apple Books and Kindle, instead of
 * jumping to the notes section. "Go to note" still follows the link.
 */
export class FootnotePopup {
  private handler = new FootnoteHandler()
  private box: HTMLElement
  private body: HTMLElement
  private href = ''

  constructor(root: HTMLElement, css: () => string, follow: (href: string) => void) {
    this.box = el('div', 'octavo-footnote', root)
    this.box.setAttribute('role', 'dialog')
    this.box.setAttribute('aria-label', 'Note')
    this.box.addEventListener('pointerdown', e => e.stopPropagation())
    this.box.addEventListener('click', e => e.stopPropagation())
    const bar = el('div', 'octavo-footnote-bar', this.box)
    const go = el('button', 'octavo-footnote-go', bar, 'Go to note')
    go.onclick = () => { const h = this.href; this.hide(); follow(h) }
    iconButton(bar, 'x', 'Close', () => this.hide())
    this.body = el('div', 'octavo-footnote-body', this.box)
    this.box.hide()
    this.handler.addEventListener('before-render', e => this.prepare(e.detail, css(), follow))
    this.handler.addEventListener('render', e => { this.href = e.detail.href; this.box.show() })
  }

  /** For the reader's `link` event: true when it was a note and is shown here (the jump is cancelled). */
  handle(book: Book, e: CustomEvent<{ a: HTMLAnchorElement; href: string }>, fallback: (href: string) => void): boolean {
    const shown = this.handler.handle(book, e)
    if (!shown) return false
    shown.catch(() => { this.hide(); fallback(e.detail.href) })
    return true
  }

  get visible(): boolean { return this.box.isShown() }

  hide(): void {
    this.box.hide()
    for (const v of Array.from(this.body.children)) { try { (v as View).close?.() } catch { /* ignore */ } }
    this.body.empty()
  }

  private prepare({ view }: FootnoteRender, css: string, follow: (href: string) => void): void {
    // links inside a note (a note that points at another) follow in the book
    view.addEventListener('link', e => { e.preventDefault(); this.hide(); follow(e.detail.href) })
    view.addEventListener('external-link', e => { e.preventDefault(); window.open(e.detail.href, '_blank') })
    this.body.replaceChildren(view)
    const r = view.renderer
    // only the note: no neighbouring sections scrolled in above or below it
    r.setAttribute('no-continuous-scroll', ''); r.setAttribute('no-preload', '')
    r.setAttribute('flow', 'scrolled')
    r.setAttribute('margin-top', '8px'); r.setAttribute('margin-bottom', '8px')
    r.setAttribute('margin-left', '14px'); r.setAttribute('margin-right', '14px')
    r.setStyles?.(css)
  }
}
