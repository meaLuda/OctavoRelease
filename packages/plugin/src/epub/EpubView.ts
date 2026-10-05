import { FileView, Menu, Notice, Platform, TFile, WorkspaceLeaf, moment, setIcon } from 'obsidian'
import { makeBook } from '@octavo/foliate/view.js'
import { Overlayer } from '@octavo/foliate/overlayer.js'
import * as CFI from '@octavo/foliate/epubcfi.js'
import { tag } from '@octavo/foliate/tags.js'
import {
  normalizeAuthors, bookIdFromBytes, findQuote, makeQuote, newHighlightId, parseSubpath, formatCfiSubpath, formatDuration,
  type Highlight, type HighlightColor, type ParsedHighlight, tidyTitle } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { BOOK_EXTENSIONS, type Backlink } from '../library/BookLibrary'
import { ReaderChrome, SelectionPopover, SidePanel, el, type PanelTab } from '../reader/ui'
import { renderAppearance, resolveLook } from '../reader/appearance'
import { bookCss } from '../reader/themes'
import { sanitizeSection, indexText, rangeFromOffsets, rangeRectInHost, hasSelection, offsetOf } from '../reader/dom'
import { COLOR_CSS } from '../reader/colors'
import { Speaker, CloudSpeaker } from '../reader/speech'
import { FocusMode } from '../reader/focus'
import { TextPromptModal } from '../reader/modals'

export const EPUB_VIEW = 'octavo-epub'

interface Loc { cfi: string; fraction: number; index: number; range?: Range; tocItem?: { label?: string; href?: string }; pageItem?: { label?: string }; section?: { current: number; total: number }; location?: { current: number; next: number; total: number } }

export class EpubView extends FileView {
  allowNoFile = false
  private foliate: any = null
  private book: any = null
  private root!: HTMLElement
  private stage!: HTMLElement
  private chrome!: ReaderChrome
  private popover!: SelectionPopover
  private panel!: SidePanel
  private note: TFile | null = null
  private bookId = ''
  private title = ''
  private highlights = new Map<string, ParsedHighlight>()
  private backlinks: Backlink[] = []
  private bookmarks: string[] = []
  private loc: Loc | null = null
  private saveTimer = 0
  private pageEnter = 0
  private pageChars = 0
  private session = { start: 0, from: 0, highlights: 0 }
  private pendingSubpath: string | null = null
  private ready = false
  focusMode = new FocusMode(() => this.containerEl.doc)
  private speaker: Speaker | CloudSpeaker | null = null
  private autoScroll = 0
  private searchState: { query: string; results: Array<{ label: string; subitems: Array<{ cfi: string; excerpt: { pre: string; match: string; post: string } }> }> } = { query: '', results: [] }
  private lastSelection: { range: Range; index: number } | null = null

  constructor(leaf: WorkspaceLeaf, private plugin: OctavoPlugin) {
    super(leaf)
    this.navigation = true
  }

  getViewType() { return EPUB_VIEW }
  getIcon() { return 'octavo' }
  getDisplayText() { return this.title || this.file?.basename || 'Book' }
  canAcceptExtension(ext: string) { return (BOOK_EXTENSIONS as readonly string[]).includes(ext) }

  async onOpen() {
    await this.plugin.ready
    this.contentEl.empty()
    this.contentEl.addClass('octavo-view')
    this.root = el('div', 'octavo-reader', this.contentEl)
    this.root.tabIndex = 0
    this.stage = el('div', 'octavo-stage', this.root)
    this.chrome = new ReaderChrome(this.root, {
      toc: () => this.panel.open('toc'),
      search: () => this.panel.open('search'),
      highlights: () => this.panel.open('highlights'),
      bookmark: () => void this.toggleBookmark(),
      appearance: () => this.panel.open('appearance'),
      speak: () => void this.toggleSpeak(),
      more: e => this.moreMenu(e),
      prev: () => this.foliate?.goLeft(),
      next: () => this.foliate?.goRight(),
      footerTap: () => this.cycleFooter(),
    }, () => this.plugin.settings.autoHideMs, visible => this.setImmersive(!visible))
    this.popover = new SelectionPopover(this.root)
    this.panel = new SidePanel(this.root, (tab, body) => this.renderPanel(tab, body))
    this.root.addEventListener('keydown', e => this.onKey(e))
    this.registerDomEvent(this.containerEl.doc, 'visibilitychange', () => { if (document.hidden) void this.savePosition(true) })
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyLook()))
    this.registerEvent(this.app.workspace.on('active-leaf-change', l => { if (l !== this.leaf) this.containerEl.doc.body.removeClass('octavo-immersive') }))
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refreshBacklinks()))
    this.registerEvent(this.app.vault.on('modify', f => { if (f === this.note) void this.reloadHighlightsFromNote() }))
    // bookmarks live in the book note's frontmatter: follow it, so several tabs (or synced devices) never overwrite each other
    this.registerEvent(this.app.metadataCache.on('changed', f => {
      if (f !== this.note) return
      const b = this.plugin.library.getProps(f).bookmarks
      this.bookmarks = Array.isArray(b) ? b.filter((x: unknown): x is string => typeof x === 'string') : []
      this.chrome.setBookmarked(this.isBookmarked())
    }))
  }

  async onLoadFile(file: TFile): Promise<void> {
    await this.plugin.ready
    this.ready = false
    this.stage.empty()
    const loading = el('div', 'octavo-loading', this.stage, 'Opening…')
    try {
      const blob = await this.readFile(file)
      const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer())
      this.bookId = await bookIdFromBytes(head, blob.size)
      const fileObj = new File([blob], file.name, { type: blob.type })
      this.book = await makeBook(fileObj)
      this.book.transformTarget?.addEventListener('data', ({ detail }: any) => {
        if (/x?html/.test(detail.type)) detail.data = Promise.resolve(detail.data).then((d: string) => sanitizeSection(d))
      })
      const meta = this.book.metadata ?? {}
      this.title = tidyTitle(formatLang(meta.title) || '') || file.basename
      const author = formatAuthors(meta.author)
      ;(this.leaf as any).updateHeader?.()

      this.note = await this.plugin.library.ensureNote(file, { id: this.bookId, title: this.title, author, format: file.extension, language: meta.language })
      const props = this.plugin.library.getProps(this.note)
      if (!props.cover) {
        try {
          const cover = await this.book.getCover?.()
          const path = await this.plugin.library.saveCover(this.bookId, cover ?? null)
          if (path) await this.plugin.library.setProps(this.note, { cover: `[[${path}]]` })
        } catch { /* no cover */ }
      }
      this.bookmarks = Array.isArray(props.bookmarks) ? props.bookmarks.filter((x: unknown) => typeof x === 'string') : []

      loading.remove()
      const view: any = document.createElement(tag('foliate-view'))
      view.addClass('octavo-foliate')
      this.stage.appendChild(view)
      this.foliate = view
      this.wireFoliate(view)
      await view.open(this.book)
      this.applyLook()
      await this.reloadHighlightsFromNote()
      this.refreshBacklinks()

      const lastLocation = this.pendingSubpath ? null : (typeof props.position === 'string' ? props.position : null)
      if (!lastLocation && typeof props.progress === 'number' && props.progress > 0 && !this.pendingSubpath) {
        await view.init({ showTextStart: false })
        await view.goToFraction(props.progress)
      } else {
        await view.init({ lastLocation, showTextStart: !lastLocation })
      }
      this.ready = true
      this.session = { start: Date.now(), from: this.loc?.fraction ?? 0, highlights: 0 }
      if (this.pendingSubpath) { const s = this.pendingSubpath; this.pendingSubpath = null; await this.navigateSubpath(s) }
      this.chrome.title.setText(this.title)
      this.root.focus({ preventScroll: true })
    } catch (e) {
      console.error('Octavo: failed to open book', e)
      loading.setText(`Could not open this book: ${(e as Error).message ?? e}`)
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.closeBook()
  }

  async onClose(): Promise<void> {
    this.containerEl.doc.body.removeClass('octavo-immersive')
    this.focusMode.exit()
    await this.closeBook()
  }

  /** Mobile: slide Obsidian's toolbar away while reading; it returns with the reader controls. */
  private setImmersive(on: boolean) {
    if (!Platform.isMobile) return
    const active = this.app.workspace.getActiveViewOfType(FileView) === this
    this.containerEl.doc.body.toggleClass('octavo-immersive', on && active)
  }

  private async closeBook() {
    this.stopAutoScroll()
    this.speaker?.stop()
    this.speaker = null
    if (this.ready) {
      await this.savePosition(true)
      await this.logSession()
    }
    this.ready = false
    try { this.foliate?.close?.() } catch { /* ignore */ }
    this.foliate?.remove()
    this.foliate = null
    this.book = null
    this.highlights.clear()
    this.chrome?.destroy()
  }

  /** Deep links: `[[book.epub#cfi=…]]` open here. */
  async setEphemeralState(state: any): Promise<void> {
    super.setEphemeralState?.(state)
    const sub = state?.subpath
    if (typeof sub !== 'string' || !sub) return
    if (!this.ready) { this.pendingSubpath = sub; return }
    await this.navigateSubpath(sub)
  }

  private async navigateSubpath(sub: string) {
    const sp = parseSubpath(sub)
    if (sp?.type !== 'cfi') return
    const from = this.loc?.cfi
    await this.foliate.goTo(sp.cfi)
    this.flash(sp.cfi)
    if (from) this.offerBack(from)
  }

  // ───────────────────────── reading surface ─────────────────────────

  private async readFile(file: TFile): Promise<Blob> {
    const cloud = await this.plugin.cloud.resolveStub(file)
    if (cloud) return cloud
    // Prefer the resource URL: lets the WebView stream from disk instead of one huge ArrayBuffer.
    try {
      const res = await fetch(this.app.vault.getResourcePath(file))
      if (res.ok) return await res.blob()
    } catch { /* fall back */ }
    return new Blob([await this.app.vault.readBinary(file)])
  }

  private wireFoliate(view: any) {
    view.addEventListener('relocate', (e: CustomEvent) => this.onRelocate(e.detail))
    view.addEventListener('load', (e: CustomEvent) => this.onSectionLoad(e.detail.doc, e.detail.index))
    view.addEventListener('create-overlay', (e: CustomEvent) => this.drawSection(e.detail.index))
    view.addEventListener('draw-annotation', (e: CustomEvent) => {
      const { draw, annotation } = e.detail
      const color = COLOR_CSS[annotation.color as HighlightColor] ?? COLOR_CSS.yellow
      if (annotation.kind === 'backlink') draw(Overlayer.squiggly, { color: 'var(--octavo-backlink, #8a7cff)', width: 1.5 })
      else if (annotation.style === 'underline') draw(Overlayer.underline, { color, width: 2.5 })
      else draw(Overlayer.highlight, { color })
    })
    view.addEventListener('show-annotation', (e: CustomEvent) => this.onAnnotationClick(e.detail.value, e.detail.range))
    view.addEventListener('external-link', (e: CustomEvent) => {
      e.preventDefault()
      window.open(e.detail.href, '_blank')
    })
    view.addEventListener('link', (e: CustomEvent) => {
      const from = this.loc?.cfi
      if (from) window.setTimeout(() => this.offerBack(from), 300)
    })
  }

  private applyLook() {
    if (!this.foliate?.renderer) return
    const s = this.plugin.settings
    const look = resolveLook(s, this.containerEl.doc.body.hasClass('theme-dark'))
    const obsidianFont = getComputedStyle(document.body).getPropertyValue('--font-text').trim()
    const r = this.foliate.renderer
    r.setStyles?.(bookCss(look, obsidianFont, this.plugin.customFontUrl ?? undefined))
    r.setAttribute('flow', s.flow)
    r.setAttribute('gap', '6%')
    r.setAttribute('max-inline-size', '720px')
    r.setAttribute('max-column-count', String(look.typo.maxColumns))
    const narrow = this.root.clientWidth < 520
    const m = `${narrow ? Math.min(look.typo.margin, 22) : look.typo.margin}px`
    r.setAttribute('margin-left', m); r.setAttribute('margin-right', m)
    r.setAttribute('margin-top', narrow ? '36px' : '44px'); r.setAttribute('margin-bottom', narrow ? '40px' : '44px')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Slide = GPU transform of the page strip (steady ~9 ms frames in our benchmarks);
    // only Curl uses the View-Transitions snapshot path, which can hitch at turn start.
    if (s.pageEffect === 'none' || reduce) { r.removeAttribute('animated'); r.removeAttribute('turn-style') }
    else {
      r.setAttribute('animated', '')
      r.setAttribute('gpu-composite', '')
      if (s.pageEffect === 'curl') r.setAttribute('turn-style', 'curl')
      else r.removeAttribute('turn-style')
    }
    this.root.style.setProperty('--octavo-bg', look.colors.bg)
    this.root.style.setProperty('--octavo-fg', look.colors.fg)
    this.root.toggleClass('octavo-dark', look.dark)
    this.root.dataset.theme = s.theme
    this.updateFooter()
  }

  private onSectionLoad(doc: Document, index: number) {
    // selection → popover; taps → zones; keys → shortcuts
    let selTimer = 0
    const checkSel = () => {
      window.clearTimeout(selTimer)
      selTimer = window.setTimeout(() => {
        if (!hasSelection(doc)) { if (this.lastSelection?.range.startContainer.ownerDocument === doc) { this.lastSelection = null; this.popover.hide() } return }
        const range = doc.getSelection()!.getRangeAt(0)
        this.lastSelection = { range, index }
        this.showSelectionPopover(range, index)
      }, Platform.isMobile ? 350 : 120)
    }
    doc.addEventListener('selectionchange', checkSel)
    doc.addEventListener('pointerup', checkSel)
    doc.addEventListener('click', (e: MouseEvent) => this.onDocClick(e, doc), false)
    doc.addEventListener('keydown', (e: KeyboardEvent) => this.onKey(e))
    doc.addEventListener('wheel', () => this.chrome.hide(), { passive: true })
    let hoverAt = 0
    doc.addEventListener('mousemove', (e: MouseEvent) => {
      // The book lives in an iframe: tell the reader bar where the pointer is, in window coordinates.
      const fr = doc.defaultView?.frameElement?.getBoundingClientRect()
      if (fr) this.chrome.pointerAt(fr.left + e.clientX, fr.top + e.clientY)
      const t = performance.now()
      if (t - hoverAt < 250) return
      hoverAt = t
      this.hoverPreview(e, doc)
    })
    // anchor quote-only (imported) highlights in this section
    void this.anchorQuotes(doc, index)
  }

  private onDocClick(e: MouseEvent, doc: Document) {
    if (e.defaultPrevented) return
    if ((e.target as Element)?.closest?.('a[href]')) return
    if (hasSelection(doc)) return
    if (this.popover.visible) { this.popover.hide(); return }
    if (this.panel.isOpen) { this.panel.close(); return }
    const frame = doc.defaultView?.frameElement as HTMLElement | null
    const fr = frame?.getBoundingClientRect()
    const rr = this.root.getBoundingClientRect()
    const x = (fr ? fr.left + e.clientX : e.clientX) - rr.left
    const y = (fr ? fr.top + e.clientY : e.clientY) - rr.top
    this.tapAt(x / rr.width, y / rr.height)
  }

  private tapAt(fx: number, fy: number) {
    const s = this.plugin.settings
    let col = fx < 0.25 ? 0 : fx > 0.75 ? 2 : 1
    if (s.leftHanded && col !== 1) col = 2 - col
    const row = fy < 0.2 ? 0 : fy > 0.8 ? 2 : 1
    // top-right corner = one-tap bookmark (Apple's three-tap bookmark is a known complaint)
    if (row === 0 && fx > 0.88 && fy < 0.08) return void this.toggleBookmark()
    const action = s.tapZones[row * 3 + col] ?? 'none'
    switch (action) {
      case 'prev': this.chrome.hide(); return void this.foliate?.goLeft()
      case 'next': this.chrome.hide(); return void this.foliate?.goRight()
      case 'menu': return this.chrome.toggle()
      case 'bookmark': return void this.toggleBookmark()
      case 'toc': return this.panel.open('toc')
      case 'search': return this.panel.open('search')
    }
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest?.('input, textarea, select, .octavo-panel')) return
    const k = e.key
    const sel = this.lastSelection
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); this.foliate?.goLeft() }
    else if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); this.foliate?.goRight() }
    else if (k === ' ' && e.shiftKey) { e.preventDefault(); this.foliate?.goLeft() }
    else if (k === 'Escape') { if (!this.popover.visible && !this.panel.isOpen) this.focusMode.exit(); this.popover.hide(); this.panel.close(); this.stopAutoScroll() }
    else if ((k === 'h' || k === 'H') && sel) { e.preventDefault(); void this.createHighlight(sel, this.plugin.settings.defaultColor, 'highlight') }
    else if ((k === 'n' || k === 'N') && sel) { e.preventDefault(); void this.createHighlight(sel, this.plugin.settings.defaultColor, 'highlight', true) }
    else if ((k === 'u' || k === 'U') && sel) { e.preventDefault(); void this.createHighlight(sel, this.plugin.settings.defaultColor, 'underline') }
  }

  // ───────────────────────── location, footer, pace ─────────────────────────

  private onRelocate(detail: Loc) {
    const now = Date.now()
    if (this.pageEnter && this.pageChars) {
      this.plugin.pace.record((now - this.pageEnter) / 1000, this.pageChars)
    }
    this.pageEnter = now
    this.pageChars = detail.range?.toString().length ?? 0
    this.loc = detail
    this.updateFooter()
    this.chrome.setBookmarked(this.isBookmarked())
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.savePosition(false), 2000)
  }

  private updateFooter() {
    const loc = this.loc
    const s = this.plugin.settings
    this.root.toggleClass('octavo-footer-off', s.footer === 'off')
    if (!loc) return
    const r = this.foliate?.renderer
    const pct = Math.round((loc.fraction ?? 0) * 100)
    this.chrome.progressBar.style.setProperty('--octavo-progress', `${(loc.fraction ?? 0) * 100}%`)
    const pages = r?.pages ?? 0, page = r?.page ?? 0
    const left = Math.max(0, pages - page - 1)
    const sectionSize = this.book?.sections?.[loc.index]?.size ?? 0
    const secFrac = pages > 1 ? Math.min(1, page / Math.max(1, pages - 1)) : 0
    const chapterSecs = this.plugin.pace.estimate(sectionSize * (1 - secFrac) * 0.8)
    const bookChars = loc.location ? (loc.location.total - loc.location.current) * 1500 : 0
    const bookSecs = this.plugin.pace.estimate(bookChars * 0.8)
    const chapter = loc.tocItem?.label?.trim()
    let text: string
    if (s.footer === 'time') text = `${formatDuration(chapterSecs)} left in chapter · ${formatDuration(bookSecs)} left in book`
    else if (s.footer === 'book') text = `${loc.pageItem?.label ? `Page ${loc.pageItem.label} · ` : loc.location ? `Location ${loc.location.current + 1} of ${loc.location.total} · ` : ''}${pct}%`
    else text = `${s.flow === 'scrolled' ? '' : left === 0 ? 'Last page in chapter · ' : `${left} page${left === 1 ? '' : 's'} left in chapter · `}${pct}%`
    this.chrome.footerText.setText(text)
    this.chrome.footerText.setAttribute('title', chapter ?? '')
    this.chrome.title.setText(chapter ? `${this.title} — ${chapter}` : this.title)
  }

  private cycleFooter() {
    const order = ['chapter', 'time', 'book'] as const
    const s = this.plugin.settings
    const i = order.indexOf(s.footer as any)
    s.footer = order[(i + 1) % order.length]!
    void this.plugin.saveSettings()
    this.updateFooter()
  }

  private async savePosition(force: boolean) {
    if (!this.note || !this.loc?.cfi) return
    const fraction = Math.round((this.loc.fraction ?? 0) * 1000) / 1000
    const props = this.plugin.library.getProps(this.note)
    if (!force && props.position === this.loc.cfi) return
    const patch: Record<string, unknown> = { position: this.loc.cfi, progress: fraction, 'last-read': moment().format('YYYY-MM-DDTHH:mm') }
    if (fraction >= 0.995 && props.status !== 'finished') {
      patch.status = 'finished'
      patch.finished = moment().format('YYYY-MM-DD')
      const y = moment().format('YYYY')
      this.plugin.settings.stats.finishedByYear[y] = (this.plugin.settings.stats.finishedByYear[y] ?? 0) + 1
      new Notice(`Finished “${this.title}” 🎉`)
    } else if (props.status === 'want') patch.status = 'reading'
    await this.plugin.library.setProps(this.note, patch)
    this.plugin.settings.pace = this.plugin.pace.toJSON()
    void this.plugin.saveSettings()
  }

  private async logSession() {
    if (!this.file || !this.session.start) return
    const minutes = Math.round((Date.now() - this.session.start) / 60000)
    await this.plugin.library.logSession({ book: this.file, note: this.note, title: this.title, minutes, from: this.session.from, to: this.loc?.fraction ?? this.session.from, highlights: this.session.highlights })
    this.session.start = 0
    await this.plugin.saveSettings()
  }

  // ───────────────────────── highlights ─────────────────────────

  private async reloadHighlightsFromNote() {
    if (!this.note || !this.foliate) return
    const list = await this.plugin.library.highlights(this.note)
    const old = this.highlights
    this.highlights = new Map(list.map(h => [h.id, h]))
    for (const h of old.values()) if (h.anchor.cfi && !this.highlights.has(h.id)) await this.foliate.deleteAnnotation({ value: h.anchor.cfi })
    for (const h of this.highlights.values()) {
      const prev = old.get(h.id)
      if (h.anchor.cfi && (!prev || prev.color !== h.color || prev.style !== h.style || prev.anchor.cfi !== h.anchor.cfi)) {
        await this.foliate.addAnnotation({ value: h.anchor.cfi, color: h.color, style: h.style, id: h.id })
      }
    }
    this.panel.tab === 'highlights' && this.panel.refresh()
  }

  private drawSection(index: number) {
    for (const h of this.highlights.values()) if (h.anchor.cfi) void this.foliate.addAnnotation({ value: h.anchor.cfi, color: h.color, style: h.style, id: h.id })
    for (const b of this.backlinks) if (b.subpath.type === 'cfi') void this.foliate.addAnnotation({ value: b.subpath.cfi, kind: 'backlink' })
    void index
  }

  /** Imported highlights carry only a text quote; find them when their section loads and upgrade to a CFI. */
  private async anchorQuotes(doc: Document, index: number) {
    const pending = [...this.highlights.values()].filter(h => !h.anchor.cfi)
    if (!pending.length || !doc.body) return
    const idx = indexText(doc.body)
    for (const h of pending) {
      const m = findQuote(idx.text, h.anchor.quote)
      if (!m) continue
      const range = rangeFromOffsets(idx, m.start, m.end)
      if (!range) continue
      const cfi = this.foliate.getCFI(index, range)
      const upgraded: Highlight = { ...h, anchor: { ...h.anchor, cfi } }
      this.highlights.set(h.id, { ...h, anchor: upgraded.anchor })
      if (this.file && this.note) await this.plugin.library.saveHighlight(this.file, this.note, upgraded)
      await this.foliate.addAnnotation({ value: cfi, color: h.color, style: h.style, id: h.id })
    }
  }

  private showSelectionPopover(range: Range, index: number) {
    const rect = rangeRectInHost(range)
    const sel = { range, index }
    this.popover.show(rect, {
      color: c => void this.createHighlight(sel, c, 'highlight'),
      underline: () => void this.createHighlight(sel, this.plugin.settings.defaultColor, 'underline'),
      note: () => void this.createHighlight(sel, this.plugin.settings.defaultColor, 'highlight', true),
      copyLink: () => void this.copyLinkFor(sel),
      define: () => this.plugin.define(range.toString(), this.contextOf(range)),
      ask: () => this.plugin.ask(range.toString(), this.contextOf(range), this.title, this.loc?.fraction ?? 0),
      speak: () => { this.speakText(range.toString()) },
    })
  }

  private contextOf(range: Range): string {
    const block = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement)?.closest('p, li, blockquote, div')
    return (block?.textContent ?? range.toString()).trim().slice(0, 2000)
  }

  private quoteFor(range: Range) {
    const doc = range.startContainer.ownerDocument!
    const idx = indexText(doc.body)
    const start = offsetOf(idx, range.startContainer, range.startOffset)
    const end = offsetOf(idx, range.endContainer, range.endOffset)
    return makeQuote(idx.text, start, Math.max(start, end))
  }

  private async createHighlight(sel: { range: Range; index: number }, color: HighlightColor, style: 'highlight' | 'underline', withNote = false) {
    if (!this.file || !this.note) return
    const cfi: string = this.foliate.getCFI(sel.index, sel.range)
    const existing = [...this.highlights.values()].find(h => h.anchor.cfi === cfi)
    const h: Highlight = existing
      ? { ...existing, color, style }
      : { id: newHighlightId(), color, style, created: new Date().toISOString(), label: this.labelFor(), anchor: { cfi, quote: this.quoteFor(sel.range) } }
    if (withNote) {
      const note = await new TextPromptModal(this.app, 'Note', h.note ?? '', 'Add a note to this highlight').result()
      if (note === null) return
      h.note = note || undefined
    }
    sel.range.startContainer.ownerDocument?.getSelection()?.removeAllRanges()
    this.popover.hide()
    this.lastSelection = null
    this.highlights.set(h.id, { ...h, lines: [0, 0] })
    await this.foliate.addAnnotation({ value: cfi, color: h.color, style: h.style, id: h.id })
    await this.plugin.library.saveHighlight(this.file, this.note, h)
    if (!existing) this.session.highlights++
    if (this.plugin.settings.autoPaste) await this.plugin.autoPaste(h, this.file, this.note)
  }

  private labelFor(): string | undefined {
    const ch = this.loc?.tocItem?.label?.trim()
    const pg = this.loc?.pageItem?.label
    return [ch, pg ? `p. ${pg}` : null].filter(Boolean).join(' · ') || undefined
  }

  private onAnnotationClick(value: string, range: Range) {
    const h = [...this.highlights.values()].find(x => x.anchor.cfi === value)
    if (!h) {
      const b = this.backlinks.find(x => x.subpath.type === 'cfi' && x.subpath.cfi === value)
      if (b) void this.app.workspace.openLinkText(b.sourcePath, this.file?.path ?? '', 'split')
      return
    }
    const rect = rangeRectInHost(range)
    this.popover.show(rect, {
      color: c => void this.updateHighlight(h, { color: c, style: 'highlight' }),
      underline: () => void this.updateHighlight(h, { style: h.style === 'underline' ? 'highlight' : 'underline' }),
      note: async () => {
        const note = await new TextPromptModal(this.app, 'Note', h.note ?? '', 'Note').result()
        if (note !== null) await this.updateHighlight(h, { note: note || undefined })
      },
      copyLink: () => void this.copyText(this.plugin.library.linkFor(this.file!, this.note!, h).replace('|↗', `|${shorten(h.anchor.quote.exact)}`)),
      define: () => this.plugin.define(h.anchor.quote.exact, h.anchor.quote.exact),
      ask: () => this.plugin.ask(h.anchor.quote.exact, h.anchor.quote.exact, this.title, this.loc?.fraction ?? 0),
      speak: () => this.speakText(h.anchor.quote.exact),
      remove: () => void this.removeHighlight(h),
      openInNote: () => void this.openInNote(h),
    }, { color: h.color, underline: h.style === 'underline' })
  }

  /** Ctrl/Cmd-hover a highlight → Obsidian page preview of its block in the book note. */
  private hoverPreview(e: MouseEvent, doc: Document) {
    if (!(e.ctrlKey || e.metaKey) || !this.note) return
    const ov = this.foliate?.renderer?.getContents?.().find((c: any) => c.doc === doc)?.overlayer
    const hit = ov?.hitTest?.(e)
    const value: string | undefined = hit?.[0]
    if (!value) return
    const h = [...this.highlights.values()].find(x => x.anchor.cfi === value)
    const b = h ? null : this.backlinks.find(x => x.subpath.type === 'cfi' && x.subpath.cfi === value)
    const linktext = h ? `${this.note.path}#^oct-${h.id}` : b?.sourcePath
    if (!linktext) return
    const rect = rangeRectInHost(hit[1])
    const rr = this.root.getBoundingClientRect()
    const target = el('div', 'octavo-hover-target', this.root)
    target.style.cssText = `left:${rect.left - rr.left}px;top:${rect.top - rr.top}px;width:${Math.max(4, rect.width)}px;height:${Math.max(4, rect.height)}px`
    window.setTimeout(() => target.remove(), 8000)
    this.app.workspace.trigger('hover-link', { event: e, source: 'octavo', hoverParent: this, targetEl: target, linktext, sourcePath: this.file?.path ?? '' })
  }

  private async updateHighlight(h: ParsedHighlight, patch: Partial<Highlight>) {
    if (!this.file || !this.note) return
    const next = { ...h, ...patch }
    this.highlights.set(h.id, next)
    this.popover.hide()
    if (h.anchor.cfi) {
      await this.foliate.deleteAnnotation({ value: h.anchor.cfi })
      await this.foliate.addAnnotation({ value: h.anchor.cfi, color: next.color, style: next.style, id: h.id })
    }
    await this.plugin.library.saveHighlight(this.file, this.note, next)
  }

  private async removeHighlight(h: ParsedHighlight) {
    if (!this.note) return
    this.popover.hide()
    this.highlights.delete(h.id)
    if (h.anchor.cfi) await this.foliate.deleteAnnotation({ value: h.anchor.cfi })
    await this.plugin.library.deleteHighlight(this.note, h.id)
  }

  private async openInNote(h: ParsedHighlight) {
    if (!this.note) return
    this.popover.hide()
    await this.app.workspace.openLinkText(`${this.note.path}#^oct-${h.id}`, this.file?.path ?? '', 'split')
  }

  private async copyLinkFor(sel: { range: Range; index: number }) {
    if (!this.file || !this.note) return
    const cfi = this.foliate.getCFI(sel.index, sel.range)
    const link = this.app.fileManager.generateMarkdownLink(this.file, this.note.path, formatCfiSubpath(cfi), shorten(sel.range.toString())).replace(/^!/, '')
    await this.copyText(link)
    this.popover.hide()
  }

  private async copyText(t: string) {
    await navigator.clipboard.writeText(t)
    new Notice('Link copied')
  }

  private flash(cfi: string) {
    void this.foliate.addAnnotation({ value: `foliate-search:${cfi}` })
    window.setTimeout(() => void this.foliate?.deleteAnnotation({ value: `foliate-search:${cfi}` }), 2500)
  }

  private offerBack(cfi: string) {
    this.chrome.showBack('Back to where you were', () => void this.foliate.goTo(cfi))
    window.setTimeout(() => this.chrome.hideBack(), 15000)
  }

  // ───────────────────────── backlinks ─────────────────────────

  private refreshBacklinks() {
    if (!this.file || !this.foliate) return
    const next = this.plugin.library.backlinks(this.file).filter(b => b.subpath.type === 'cfi')
    const own = new Set([...this.highlights.values()].map(h => h.anchor.cfi))
    const fresh = next.filter(b => b.subpath.type === 'cfi' && !own.has(b.subpath.cfi) && b.sourcePath !== this.note?.path)
    for (const b of this.backlinks) if (b.subpath.type === 'cfi') void this.foliate.deleteAnnotation({ value: b.subpath.cfi })
    this.backlinks = fresh
    for (const b of fresh) if (b.subpath.type === 'cfi') void this.foliate.addAnnotation({ value: b.subpath.cfi, kind: 'backlink' })
  }

  // ───────────────────────── bookmarks ─────────────────────────

  private isBookmarked(): boolean {
    const range = this.loc?.range
    if (!range || !this.bookmarks.length) return false
    return this.bookmarks.some(b => this.cfiOnPage(b))
  }

  private cfiOnPage(cfi: string): boolean {
    const loc = this.loc
    if (!loc?.cfi) return false
    try {
      const start = CFI.collapse(loc.cfi), end = CFI.collapse(loc.cfi, true)
      return CFI.compare(cfi, start) >= 0 && CFI.compare(cfi, end) <= 0
    } catch { return false }
  }

  private async toggleBookmark() {
    if (!this.note || !this.loc?.cfi) return
    const here = CFI.collapse(this.loc.cfi)
    let on = false
    // read-modify-write inside processFrontMatter so concurrent views can't clobber each other
    await this.app.fileManager.processFrontMatter(this.note, fm => {
      const cur: string[] = Array.isArray(fm.bookmarks) ? fm.bookmarks.filter((x: unknown) => typeof x === 'string') : []
      on = cur.some(b => this.cfiOnPage(b))
      const next = on ? cur.filter(b => !this.cfiOnPage(b)) : [...cur, here]
      if (next.length) fm.bookmarks = next; else delete fm.bookmarks
      this.bookmarks = next
    })
    this.chrome.setBookmarked(!on)
  }

  // ───────────────────────── read aloud & auto-scroll ─────────────────────────

  private async toggleSpeak() {
    if (this.speaker?.active) { this.speaker.stop(); this.chrome.setSpeaking(false); return }
    await this.foliate.initTTS('word', undefined, (range: Range) => {
      // highlight the spoken word and keep it on screen
      this.foliate.renderer.scrollToAnchor?.(range, true)
    })
    const t = this.plugin.settings.tts
    this.speaker = t.engine === 'cloud' && this.plugin.cloud.signedIn
      ? new CloudSpeaker(this.foliate, (text, sig) => this.plugin.cloud.tts(text, t.cloudVoice, sig), t.rate, () => this.chrome.setSpeaking(false), e => new Notice(`Read-aloud: ${e.message}`))
      : new Speaker(this.foliate, t, () => this.chrome.setSpeaking(false))
    this.chrome.setSpeaking(true)
    this.speaker.start()
  }

  private speakText(text: string) {
    this.popover.hide()
    Speaker.say(text, this.plugin.settings.tts)
  }

  toggleAutoScroll() {
    if (this.autoScroll) return this.stopAutoScroll()
    if (this.plugin.settings.flow !== 'scrolled') { this.plugin.settings.flow = 'scrolled'; this.applyLook() }
    let last = performance.now()
    const step = (t: number) => {
      const dy = ((t - last) / 1000) * this.plugin.settings.autoScrollSpeed
      last = t
      this.foliate?.renderer?.scrollBy?.(0, dy)
      this.autoScroll = window.requestAnimationFrame(step)
    }
    this.autoScroll = window.requestAnimationFrame(step)
    new Notice('Auto-scroll on — press Esc to stop')
  }
  private stopAutoScroll() { if (this.autoScroll) cancelAnimationFrame(this.autoScroll); this.autoScroll = 0 }

  // ───────────────────────── menus & panels ─────────────────────────

  private moreMenu(e: MouseEvent) {
    const m = new Menu()
    m.addItem(i => i.setTitle(this.focusMode.active ? 'Exit focus mode' : 'Focus mode (full screen)').setIcon(this.focusMode.active ? 'minimize' : 'maximize').onClick(() => this.focusMode.toggle()))
    m.addItem(i => i.setTitle('Read in new window').setIcon('picture-in-picture-2').onClick(() => this.file && void this.plugin.openInOctavo(this.file, this.app.workspace.openPopoutLeaf({ size: { width: 900, height: 1000 } }))))
    m.addItem(i => i.setTitle('Open book note').setIcon('file-text').onClick(() => this.note && this.app.workspace.getLeaf('split').openFile(this.note)))
    m.addItem(i => i.setTitle(this.autoScroll ? 'Stop auto-scroll' : 'Auto-scroll').setIcon('arrow-down-wide-narrow').onClick(() => this.toggleAutoScroll()))
    m.addItem(i => i.setTitle('Go to percentage…').setIcon('percent').onClick(async () => {
      const v = await new TextPromptModal(this.app, 'Go to', String(Math.round((this.loc?.fraction ?? 0) * 100)), 'Percentage (0–100)').result()
      const n = Number(v)
      if (v !== null && Number.isFinite(n)) { const from = this.loc?.cfi; await this.foliate.goToFraction(Math.min(1, Math.max(0, n / 100))); if (from) this.offerBack(from) }
    }))
    m.addSeparator()
    const status = (st: string, label: string) => m.addItem(i => i.setTitle(label).setIcon('bookmark-check').onClick(() => this.note && this.plugin.library.setProps(this.note, { status: st, ...(st === 'finished' ? { finished: moment().format('YYYY-MM-DD') } : {}) })))
    status('want', 'Mark as want to read'); status('finished', 'Mark as finished'); status('abandoned', 'Mark as abandoned')
    m.showAtMouseEvent(e)
  }

  private renderPanel(tab: PanelTab, body: HTMLElement) {
    if (tab === 'appearance') return renderAppearance(body, this.plugin.settings, this.containerEl.doc.body.hasClass('theme-dark'), () => { this.applyLook(); void this.plugin.saveSettings() })
    if (tab === 'toc') return this.renderToc(body)
    if (tab === 'highlights') return this.renderHighlights(body)
    if (tab === 'search') return this.renderSearch(body)
    if (tab === 'map') return this.renderMap(body)
  }

  private renderToc(body: HTMLElement) {
    const list = el('div', 'octavo-toc', body)
    const current = this.loc?.tocItem?.href
    const add = (items: any[], depth: number) => {
      for (const it of items ?? []) {
        const row = el('div', `octavo-toc-item depth-${Math.min(depth, 3)}`, list, (it.label ?? '').trim())
        if (it.href && it.href === current) { row.addClass('is-active'); window.setTimeout(() => row.scrollIntoView({ block: 'center' })) }
        row.onclick = () => { const from = this.loc?.cfi; void this.foliate.goTo(it.href); this.panel.close(); if (from) this.offerBack(from) }
        if (it.subitems?.length) add(it.subitems, depth + 1)
      }
    }
    add(this.book?.toc ?? [], 0)
    if (this.bookmarks.length) {
      el('div', 'octavo-ap-title', body, 'Bookmarks')
      for (const b of this.bookmarks) {
        const row = el('div', 'octavo-toc-item', body)
        setIcon(el('span', 'octavo-inline-icon', row), 'bookmark')
        el('span', '', row, `${Math.round((this.fractionOf(b) ?? 0) * 100)}%`)
        row.onclick = () => { void this.foliate.goTo(b); this.panel.close() }
      }
    }
  }

  private fractionOf(cfi: string): number | null {
    try { const r = this.foliate.resolveCFI?.(cfi); return r ? this.foliate.getSectionFractions?.()[r.index] ?? null : null } catch { return null }
  }

  private renderHighlights(body: HTMLElement) {
    const bar = el('div', 'octavo-hl-filter', body)
    const q = el('input', '', bar) as HTMLInputElement
    q.type = 'search'; q.placeholder = 'Filter highlights'
    let colorFilter: HighlightColor | null = null
    const chips = el('div', 'octavo-hl-chips', bar)
    for (const c of ['yellow', 'green', 'blue', 'pink', 'purple'] as HighlightColor[]) {
      const b = el('button', `octavo-swatch octavo-swatch-${c}`, chips)
      b.setAttribute('aria-label', `Only ${c}`)
      b.onclick = () => { colorFilter = colorFilter === c ? null : c; chips.querySelectorAll('button').forEach(x => x.removeClass('is-active')); if (colorFilter) b.addClass('is-active'); draw() }
    }
    const notesOnly = el('button', 'octavo-chip', chips, 'Has note')
    let onlyNotes = false
    notesOnly.onclick = () => { onlyNotes = !onlyNotes; notesOnly.toggleClass('is-active', onlyNotes); draw() }
    const list = el('div', 'octavo-hl-list', body)
    const draw = () => {
      list.empty()
      const term = q.value.toLowerCase()
      // keep book order: sort by CFI
      const items = [...this.highlights.values()].sort((a, b) => (a.anchor.cfi && b.anchor.cfi ? CFI.compare(a.anchor.cfi, b.anchor.cfi) : 0))
        .filter(h => (!colorFilter || h.color === colorFilter) && (!onlyNotes || h.note) && (!term || h.anchor.quote.exact.toLowerCase().includes(term) || h.note?.toLowerCase().includes(term)))
      if (!items.length) el('div', 'octavo-empty', list, this.highlights.size ? 'No matches' : 'Select text to highlight. Highlights are saved to the book note.')
      for (const h of items) {
        const card = el('div', `octavo-hl-card octavo-hl-${h.color}`, list)
        if (h.label) el('div', 'octavo-hl-label', card, h.label)
        const quote = el('div', 'octavo-hl-quote', card, h.anchor.quote.exact)
        quote.toggleClass('is-collapsed', h.anchor.quote.exact.length > 280)
        if (h.note) el('div', 'octavo-hl-note', card, h.note)
        if (!h.anchor.cfi) el('div', 'octavo-hl-label', card, 'Not located yet — opens when its chapter loads')
        card.onclick = () => { if (h.anchor.cfi) { const from = this.loc?.cfi; void this.foliate.goTo(h.anchor.cfi).then(() => this.flash(h.anchor.cfi!)); if (from) this.offerBack(from) } }
      }
    }
    q.oninput = draw
    draw()
    if (this.backlinks.length) {
      el('div', 'octavo-ap-title', body, 'Linked from your notes')
      for (const b of this.backlinks) {
        const row = el('div', 'octavo-toc-item', body)
        setIcon(el('span', 'octavo-inline-icon', row), 'link')
        el('span', '', row, b.sourcePath.replace(/\.md$/, ''))
        row.onclick = () => void this.app.workspace.openLinkText(b.sourcePath, '', 'split')
      }
    }
  }

  private renderSearch(body: HTMLElement) {
    const input = el('input', 'octavo-search-input', body) as HTMLInputElement
    input.type = 'search'; input.placeholder = 'Search this book'; input.value = this.searchState.query
    const status = el('div', 'octavo-search-status', body)
    const list = el('div', 'octavo-search-results', body)
    const show = () => {
      list.empty()
      for (const r of this.searchState.results) {
        el('div', 'octavo-search-section', list, r.label || '')
        for (const it of r.subitems) {
          const row = el('div', 'octavo-search-hit', list)
          el('span', '', row, it.excerpt.pre)
          el('mark', '', row, it.excerpt.match)
          el('span', '', row, it.excerpt.post)
          row.onclick = () => { const from = this.loc?.cfi; void this.foliate.goTo(it.cfi); if (from) this.offerBack(from) }
        }
      }
    }
    const run = async () => {
      const query = input.value.trim()
      this.foliate.clearSearch?.()
      this.searchState = { query, results: [] }
      list.empty()
      if (!query) { status.setText(''); return }
      status.setText('Searching…')
      let n = 0
      for await (const r of this.foliate.search({ query })) {
        if (this.searchState.query !== query) return
        if (r === 'done') break
        if (r.subitems) { this.searchState.results.push(r); n += r.subitems.length; show(); status.setText(`${n} result${n === 1 ? '' : 's'}…`) }
      }
      status.setText(n ? `${n} result${n === 1 ? '' : 's'}` : 'No results')
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') void run() })
    show()
    window.setTimeout(() => input.focus())
  }

  /** KOReader-style Book Map: one bar per section, sized by length, with progress and highlight marks. */
  private renderMap(body: HTMLElement) {
    const sections: any[] = (this.book?.sections ?? []).filter((s: any) => s.linear !== 'no')
    const total = sections.reduce((a, s) => a + (s.size ?? 0), 0) || 1
    const map = el('div', 'octavo-map', body)
    const counts = new Map<number, number>()
    for (const h of this.highlights.values()) {
      if (!h.anchor.cfi) continue
      try { const r = this.foliate.resolveCFI(h.anchor.cfi); counts.set(r.index, (counts.get(r.index) ?? 0) + 1) } catch { /* ignore */ }
    }
    const toc = new Map<number, string>()
    for (const it of this.book?.toc ?? []) {
      try { const r = this.foliate.resolveNavigation(it.href); if (r && !toc.has(r.index)) toc.set(r.index, (it.label ?? '').trim()) } catch { /* ignore */ }
    }
    const cur = this.loc?.index ?? -1
    this.book.sections.forEach((s: any, i: number) => {
      if (s.linear === 'no') return
      const row = el('div', 'octavo-map-row', map)
      el('div', 'octavo-map-label', row, toc.get(i) ?? '')
      const bar = el('div', 'octavo-map-bar', row)
      bar.style.setProperty('--w', `${Math.max(2, ((s.size ?? 0) / total) * 100 * 6)}%`)
      if (i < cur) bar.addClass('is-read')
      if (i === cur) { bar.addClass('is-current'); bar.style.setProperty('--p', `${(this.loc?.fraction ?? 0) * 100}%`) }
      const c = counts.get(i)
      if (c) el('span', 'octavo-map-count', row, `${c}`)
      row.onclick = () => { void this.foliate.goTo(i); this.panel.close() }
    })
  }
}

function formatLang(x: unknown): string {
  if (!x) return ''
  if (typeof x === 'string') return x
  if (typeof x === 'object') return Object.values(x as Record<string, string>)[0] ?? ''
  return String(x)
}
function formatAuthors(a: unknown): string | undefined {
  const arr = Array.isArray(a) ? a : a ? [a] : []
  return normalizeAuthors(arr.map(x => (typeof x === 'string' ? x : formatLang((x as { name?: unknown }).name ?? x))).filter(Boolean))
}
const shorten = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t }
