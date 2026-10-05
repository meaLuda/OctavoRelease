import { setIcon, Platform } from 'obsidian'
import { HIGHLIGHT_COLORS, type HighlightColor } from '@octavo/shared'

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  parent?.appendChild(e)
  return e
}

export const iconButton = (parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = '') => {
  const b = el('button', `octavo-icon-btn clickable-icon ${cls}`.trim(), parent)
  b.setAttribute('aria-label', label)
  b.setAttribute('data-tooltip-position', 'bottom')
  setIcon(b, icon)
  b.addEventListener('click', e => { e.stopPropagation(); onClick(e) })
  return b
}

export interface ChromeActions {
  toc(): void
  search(): void
  highlights(): void
  bookmark(): void
  appearance(): void
  speak(): void
  more(e: MouseEvent): void
  prev(): void
  next(): void
  footerTap(): void
}

/**
 * Reader chrome: top bar + footer + edge arrows. Fades out `autoHideMs`
 * after it appears; comes back on a centre tap (touch) or when the pointer
 * reaches the top edge (desktop). Controls are opaque (no glass over text).
 */
export class ReaderChrome {
  readonly top: HTMLElement
  readonly title: HTMLElement
  readonly footer: HTMLElement
  readonly footerText: HTMLElement
  readonly progressBar: HTMLElement
  readonly bookmarkBtn: HTMLButtonElement
  readonly speakBtn: HTMLButtonElement
  readonly backChip: HTMLElement
  private timer = 0
  private visible = true
  private pinned = false

  constructor(private root: HTMLElement, actions: ChromeActions, private autoHideMs: () => number, private onVisible: (visible: boolean) => void = () => {}) {
    this.top = el('div', 'octavo-topbar', root)
    const left = el('div', 'octavo-topbar-group', this.top)
    iconButton(left, 'list', 'Contents', () => actions.toc())
    iconButton(left, 'highlighter', 'Highlights & notes', () => actions.highlights())
    this.title = el('div', 'octavo-title', this.top)
    const right = el('div', 'octavo-topbar-group', this.top)
    iconButton(right, 'search', 'Search in book', () => actions.search())
    this.speakBtn = iconButton(right, 'audio-lines', 'Read aloud', () => actions.speak())
    iconButton(right, 'type', 'Themes & settings', () => actions.appearance())
    this.bookmarkBtn = iconButton(right, 'bookmark', 'Bookmark this page', () => actions.bookmark())
    iconButton(right, 'more-horizontal', 'More', e => actions.more(e))

    this.footer = el('div', 'octavo-footer', root)
    this.progressBar = el('div', 'octavo-progress', this.footer)
    this.footerText = el('div', 'octavo-footer-text', this.footer)
    this.footerText.setAttribute('aria-live', 'polite')
    this.footerText.addEventListener('click', e => { e.stopPropagation(); actions.footerTap() })

    if (!Platform.isMobile) {
      const prev = iconButton(root, 'chevron-left', 'Previous page', () => actions.prev(), 'octavo-edge octavo-edge-left')
      const next = iconButton(root, 'chevron-right', 'Next page', () => actions.next(), 'octavo-edge octavo-edge-right')
      void prev; void next
      root.addEventListener('mousemove', e => this.pointerAt(e.clientX, e.clientY))
      root.addEventListener('mouseleave', () => root.removeClasses(['octavo-edge-left-hot', 'octavo-edge-right-hot']))
    }
    this.backChip = el('button', 'octavo-back-chip', root)
    this.backChip.hide()
    for (const bar of [this.top, this.footer]) {
      bar.addEventListener('pointerenter', () => { this.pinned = true; this.show() })
      bar.addEventListener('pointerleave', () => { this.pinned = false; this.scheduleHide() })
    }
    this.show()
  }

  /** Desktop: the pointer near the top brings the bar back; near a side lights that page arrow. Takes
   *  window coordinates, so views can forward moves from inside a book's iframe (which the root never sees). */
  pointerAt(clientX: number, clientY: number): void {
    if (Platform.isMobile) return
    const r = this.root.getBoundingClientRect()
    const y = clientY - r.top, x = clientX - r.left
    this.root.toggleClass('octavo-edge-left-hot', x < 64)
    this.root.toggleClass('octavo-edge-right-hot', x > r.width - 64)
    if (y < 56) this.show()
  }

  show(): void {
    this.visible = true
    this.root.removeClass('octavo-chrome-hidden')
    this.onVisible(true)
    this.scheduleHide()
  }
  hide(): void {
    if (this.pinned || this.root.hasClass('octavo-panel-open')) return
    this.visible = false
    this.root.addClass('octavo-chrome-hidden')
    this.onVisible(false)
  }
  toggle(): void { this.visible ? this.hide() : this.show() }
  scheduleHide(): void {
    window.clearTimeout(this.timer)
    const ms = this.autoHideMs()
    if (ms > 0) this.timer = window.setTimeout(() => this.hide(), ms)
  }
  setBookmarked(on: boolean): void {
    this.bookmarkBtn.toggleClass('is-active', on)
    this.bookmarkBtn.setAttribute('aria-pressed', String(on))
  }
  setSpeaking(on: boolean): void {
    this.speakBtn.toggleClass('is-active', on)
    setIcon(this.speakBtn, on ? 'pause' : 'audio-lines')
  }
  showBack(label: string, onClick: () => void): void {
    this.backChip.empty()
    setIcon(el('span', 'octavo-back-icon', this.backChip), 'undo-2')
    el('span', '', this.backChip, label)
    this.backChip.onclick = e => { e.stopPropagation(); this.backChip.hide(); onClick() }
    this.backChip.show()
  }
  hideBack(): void { this.backChip.hide() }
  destroy(): void { window.clearTimeout(this.timer) }
}

export interface PopoverActions {
  color(c: HighlightColor): void
  underline(): void
  note(): void
  copyLink(): void
  define(): void
  ask(): void
  speak(): void
  remove?(): void
  openInNote?(): void
}

/** Selection / highlight popover: five colours + underline + Note + Copy link + Define + Ask. */
export class SelectionPopover {
  readonly el: HTMLElement
  constructor(private root: HTMLElement) {
    this.el = el('div', 'octavo-popover', root)
    this.el.hide()
    this.el.addEventListener('pointerdown', e => e.stopPropagation())
  }
  show(rect: DOMRect, actions: PopoverActions, current?: { color: HighlightColor; underline: boolean }): void {
    const p = this.el
    p.empty()
    const row = el('div', 'octavo-popover-colors', p)
    for (const c of HIGHLIGHT_COLORS) {
      const b = el('button', `octavo-swatch octavo-swatch-${c}`, row)
      b.setAttribute('aria-label', `Highlight ${c}`)
      if (current?.color === c && !current.underline) b.addClass('is-active')
      b.addEventListener('click', e => { e.stopPropagation(); actions.color(c) })
    }
    const u = iconButton(row, 'underline', 'Underline', () => actions.underline())
    if (current?.underline) u.addClass('is-active')
    const tools = el('div', 'octavo-popover-tools', p)
    const tool = (icon: string, label: string, fn: () => void) => {
      const b = el('button', 'octavo-tool', tools)
      setIcon(el('span', '', b), icon)
      el('span', 'octavo-tool-label', b, label)
      b.addEventListener('click', e => { e.stopPropagation(); fn() })
    }
    tool('sticky-note', 'Note', actions.note)
    tool('link', 'Copy link', actions.copyLink)
    tool('book-a', 'Define', actions.define)
    tool('sparkles', 'Ask', actions.ask)
    tool('volume-2', 'Speak', actions.speak)
    if (actions.openInNote) tool('file-text', 'In note', actions.openInNote)
    if (actions.remove) tool('trash-2', 'Remove', actions.remove)
    p.show()
    // position above the selection, flip below if no room; clamp horizontally
    const r = this.root.getBoundingClientRect()
    const pw = p.offsetWidth, ph = p.offsetHeight
    let x = rect.left + rect.width / 2 - r.left - pw / 2
    x = Math.max(8, Math.min(x, r.width - pw - 8))
    let y = rect.top - r.top - ph - 10
    if (y < 8) y = rect.bottom - r.top + 10
    p.style.left = `${x}px`
    p.style.top = `${Math.min(y, r.height - ph - 8)}px`
  }
  hide(): void { this.el.hide() }
  get visible(): boolean { return this.el.isShown() }
}

export type PanelTab = 'toc' | 'highlights' | 'search' | 'map' | 'appearance'

/** Right-hand drawer hosting Contents / Highlights / Search / Book map / Appearance. */
export class SidePanel {
  readonly el: HTMLElement
  readonly body: HTMLElement
  private header: HTMLElement
  tab: PanelTab | null = null
  constructor(private root: HTMLElement, private render: (tab: PanelTab, body: HTMLElement) => void) {
    this.el = el('div', 'octavo-panel', root)
    this.el.setAttribute('role', 'dialog')
    this.header = el('div', 'octavo-panel-header', this.el)
    this.body = el('div', 'octavo-panel-body', this.el)
    this.el.addEventListener('pointerdown', e => e.stopPropagation())
    this.el.addEventListener('click', e => e.stopPropagation())
    this.el.hide()
  }
  open(tab: PanelTab): void {
    if (this.tab === tab && this.el.isShown()) return this.close()
    this.tab = tab
    this.header.empty()
    const tabs: Array<[PanelTab, string, string]> = [
      ['toc', 'list', 'Contents'], ['highlights', 'highlighter', 'Highlights'],
      ['search', 'search', 'Search'], ['map', 'map', 'Book map'], ['appearance', 'type', 'Appearance'],
    ]
    for (const [t, icon, label] of tabs) {
      const b = iconButton(this.header, icon, label, () => this.open(t))
      if (t === tab) b.addClass('is-active')
    }
    el('div', 'octavo-panel-spacer', this.header)
    iconButton(this.header, 'x', 'Close', () => this.close())
    this.body.empty()
    this.render(tab, this.body)
    this.el.show()
    this.root.addClass('octavo-panel-open')
  }
  refresh(): void { if (this.tab && this.el.isShown()) { this.body.empty(); this.render(this.tab, this.body) } }
  close(): void {
    this.el.hide()
    this.tab = null
    this.root.removeClass('octavo-panel-open')
  }
  get isOpen(): boolean { return this.el.isShown() }
}
