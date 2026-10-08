import { FileView, Menu, Notice, Platform, TFile, WorkspaceLeaf, loadPdfJs, moment } from 'obsidian'
import { besideLeaf, canPopout } from '../platform'
import {
  isJunkTitle, cleanBookName, normalizeAuthors, tidyTitle, bookIdFromBytes, findQuote, makeQuote, newHighlightId, parseSubpath, formatPdfSubpath,
  type Highlight, type HighlightColor, type ParsedHighlight, type PdfSelection,
} from '@octavo/shared'
import type OctavoPlugin from '../main'
import type { Backlink } from '../library/BookLibrary'
import { ReaderChrome, SelectionPopover, SidePanel, el, type PanelTab } from '../reader/ui'
import { renderAppearance, resolveLook } from '../reader/appearance'
import { fontStack } from '../reader/themes'
import { COLOR_CSS } from '../reader/colors'
import { Speaker } from '../reader/speech'
import { FocusMode } from '../reader/focus'
import { TextPromptModal } from '../reader/modals'
import { ensurePdfjs, openPdfDocument, PDF_ASSETS } from './source'
import { mergeLines, imageCoverage } from './geometry'
import { reflow, figureBands, continues } from './reflow'

export const PDF_VIEW = 'octavo-pdf'

/**
 * PDF reader built on pdf.js's own PDFViewer (the component Firefox and
 * Obsidian use): rendering queue, page buffer and canvas limits come from
 * pdf.js. Octavo adds highlights, PDF++ links, dark mode and the reading UI.
 */
const vp1h = (page: any) => page.getViewport({ scale: 1 }).height

export class PdfView extends FileView {
  allowNoFile = false
  private pdfjs: any = null
  private viewerLib: any = null
  private doc: any = null
  private eventBus: any = null
  private viewer: any = null
  private root!: HTMLElement
  private container!: HTMLElement
  private chrome!: ReaderChrome
  private popover!: SelectionPopover
  private panel!: SidePanel
  private note: TFile | null = null
  private bookId = ''
  private title = ''
  private outline: Array<{ title: string; page: number; depth: number }> = []
  private highlights = new Map<string, ParsedHighlight>()
  private backlinks: Backlink[] = []
  page = 1
  private saveTimer = 0
  private session = { start: 0, from: 0, highlights: 0 }
  private pendingSubpath: string | null = null
  private ready = false
  focusMode = new FocusMode(() => this.containerEl.doc)
  private zoom: number | 'page-width' = 'page-width'
  private darkKey = ''
  private textCache = new Map<number, { items: string[]; eol: boolean[] }>()
  private textView!: HTMLElement
  private textIO: IntersectionObserver | null = null
  private rawCache = new Map<number, any[]>()

  constructor(leaf: WorkspaceLeaf, private plugin: OctavoPlugin) { super(leaf); this.navigation = true }
  getViewType() { return PDF_VIEW }
  getIcon() { return 'file-text' }
  getDisplayText() { return this.title || this.file?.basename || 'PDF' }
  canAcceptExtension(ext: string) { return ext === 'pdf' }

  async onOpen() {
    await this.plugin.ready
    this.contentEl.empty()
    this.contentEl.addClass('octavo-view')
    this.root = el('div', 'octavo-reader octavo-pdf', this.contentEl)
    this.root.tabIndex = 0
    this.container = el('div', 'octavo-pdf-container', this.root)
    el('div', 'pdfViewer', this.container)
    this.textView = el('div', 'octavo-pdf-textview', this.root)
    this.textView.hide()
    this.textView.addEventListener('scroll', () => { this.chrome.hide(); this.onTextScroll() }, { passive: true })
    this.textView.addEventListener('click', e => { if (!this.hasSel()) this.onClick(e) })
    this.chrome = new ReaderChrome(this.root, {
      toc: () => this.panel.open('toc'), search: () => this.panel.open('search'), highlights: () => this.panel.open('highlights'),
      bookmark: () => void this.toggleBookmark(), appearance: () => this.panel.open('appearance'), speak: () => this.speakPage(),
      more: e => this.moreMenu(e), prev: () => this.viewer?.previousPage(), next: () => this.viewer?.nextPage(), footerTap: () => this.panel.open('map'),
    }, () => this.plugin.settings.autoHideMs, visible => this.setImmersive(!visible))
    this.popover = new SelectionPopover(this.root)
    this.panel = new SidePanel(this.root, (t, b) => this.renderPanel(t, b))
    this.container.addEventListener('pointerup', () => window.setTimeout(() => this.checkSelection(), Platform.isMobile ? 350 : 60))
    this.container.addEventListener('click', e => this.onClick(e))
    this.container.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1) } }, { passive: false })
    this.container.addEventListener('scroll', () => this.chrome.hide(), { passive: true })
    this.root.addEventListener('keydown', e => this.onKey(e))
    this.registerDomEvent(this.containerEl.doc, 'selectionchange', () => { if (!this.hasSel()) this.popover.hide() })
    this.registerDomEvent(this.containerEl.doc, 'visibilitychange', () => { if (this.containerEl.doc.hidden) void this.savePosition() })
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyLook()))
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refreshBacklinks()))
    this.registerEvent(this.app.vault.on('modify', f => { if (f === this.note) void this.loadHighlights() }))
    this.registerEvent(this.app.workspace.on('active-leaf-change', l => { if (l !== this.leaf) this.containerEl.doc.body.removeClass('octavo-immersive') }))
    let t = 0
    const ro = new ResizeObserver(() => { window.clearTimeout(t); t = window.setTimeout(() => this.fit(), 120) })
    ro.observe(this.root)
    this.register(() => ro.disconnect())
  }

  async onLoadFile(file: TFile) {
    await this.plugin.ready
    this.ready = false
    const loading = el('div', 'octavo-loading', this.root, 'Opening…')
    try {
      const { lib, viewer } = await ensurePdfjs(loadPdfJs)
      this.pdfjs = lib; this.viewerLib = viewer
      const cloud = await this.plugin.cloud.resolveStub(file).catch(e => { new Notice((e as Error).message); return null })
      if (cloud) {
        this.bookId = await bookIdFromBytes(new Uint8Array(await cloud.slice(0, 1024 * 1024).arrayBuffer()), cloud.size)
        this.doc = await lib.getDocument({ ...PDF_ASSETS, data: new Uint8Array(await cloud.arrayBuffer()), isEvalSupported: false }).promise
      } else {
        const url = this.app.vault.getResourcePath(file)
        const headRes = await fetch(url, { headers: { Range: `bytes=0-${1024 * 1024 - 1}` } }).catch(() => null)
        let head = headRes ? new Uint8Array(await headRes.arrayBuffer()) : null
        if (!head || head.byteLength > 1024 * 1024) head = new Uint8Array(await this.app.vault.readBinary(file)).slice(0, 1024 * 1024)
        this.bookId = await bookIdFromBytes(head, file.stat.size)
        this.doc = await openPdfDocument(lib, url, file.stat.size, async () => new Uint8Array(await this.app.vault.readBinary(file)))
      }
      const meta = await this.doc.getMetadata().catch(() => null)
      const embedded = String(meta?.info?.Title ?? '').trim()
      this.title = isJunkTitle(embedded) ? cleanBookName(file.name).title : tidyTitle(embedded)
      const author = normalizeAuthors(meta?.info?.Author) ?? cleanBookName(file.name).author
      ;(this.leaf as any).updateHeader?.()
      this.note = await this.plugin.library.ensureNote(file, { id: this.bookId, title: this.title, author, format: 'pdf' })
      await this.loadOutline()
      await this.loadHighlights()
      this.refreshBacklinks()
      const props = this.plugin.library.getProps(this.note)
      if (!props.cover) void this.saveCover()
      loading.remove()
      this.buildViewer(this.pendingSubpath ? 1 : Number(props.page) || 1)
      this.applyLook()
      this.ready = true
      this.session = { start: Date.now(), from: this.fraction(), highlights: 0 }
      this.chrome.title.setText(this.title)
      this.root.focus({ preventScroll: true })
    } catch (e) {
      console.error('Octavo: failed to open PDF', e)
      loading.setText(`Could not open this PDF: ${(e as Error).message ?? e}`)
    }
  }

  /** (Re)create the pdf.js viewer — also used when dark-mode colours change (pageColors is a constructor option). */
  private buildViewer(startPage: number) {
    const V = this.viewerLib
    this.viewer?.cleanup?.()
    this.viewer?.setDocument?.(null)
    const inner = this.container.querySelector('.pdfViewer') as HTMLElement
    inner.empty()
    const s = this.plugin.settings
    const dark = this.containerEl.doc.body.hasClass('theme-dark')
    this.darkKey = `${dark}:${s.pdfDark}`
    const eventBus = new V.EventBus()
    const linkService = new V.PDFLinkService({ eventBus, externalLinkTarget: 2 })
    const findController = new V.PDFFindController({ eventBus, linkService })
    // Native "smart invert": pdf.js recolours text and vector art, photos keep their colours.
    const pageColors = dark && s.pdfDark === 'invert-except-images' ? { background: '#1e1e1e', foreground: '#d6d6d6' }
      : dark && s.pdfDark === 'sepia' ? { background: '#2b251c', foreground: '#d8c8a8' } : null
    const viewer = new V.PDFViewer({
      container: this.container, viewer: inner, eventBus, linkService, findController,
      textLayerMode: 1, annotationMode: this.pdfjs.AnnotationMode?.ENABLE ?? 1,
      maxCanvasPixels: Platform.isMobile ? 2 ** 23 : 2 ** 25, // stay under WebKit's canvas memory cap on iOS
      pageColors, removePageBorders: false,
    })
    linkService.setViewer(viewer)
    this.eventBus = eventBus
    this.viewer = viewer
    eventBus.on('pagesinit', async () => {
      this.fit()
      viewer.currentPageNumber = Math.min(this.doc.numPages, Math.max(1, startPage))
      if (this.pendingSubpath) { const sp = this.pendingSubpath; this.pendingSubpath = null; await this.navigateSubpath(sp) }
    })
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      this.page = pageNumber
      this.updateFooter()
      window.clearTimeout(this.saveTimer)
      this.saveTimer = window.setTimeout(() => void this.savePosition(), 2000)
    })
    eventBus.on('textlayerrendered', ({ pageNumber }: { pageNumber: number }) => this.onTextLayer(pageNumber))
    eventBus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => void this.markScanned(pageNumber))
    viewer.setDocument(this.doc)
    linkService.setDocument(this.doc, null)
  }

  /** Fit width; two-page spread when there's room (desktop/tablet landscape). */
  private fit() {
    const v = this.viewer
    if (!v?.pagesCount) return
    const wide = this.root.clientWidth >= 1550 && !Platform.isPhone && this.zoom === 'page-width' // spread only when each page gets ≥ ~750px
    const spread = wide ? 1 : 0 // SpreadMode.ODD | NONE
    if (v.spreadMode !== spread) v.spreadMode = spread
    v.currentScaleValue = this.zoom === 'page-width' ? 'page-width' : this.zoom
  }

  private zoomBy(f: number) {
    if (!this.viewer) return
    this.zoom = Math.min(5, Math.max(0.3, this.viewer.currentScale * f))
    this.fit()
  }

  async onUnloadFile() { await this.closeDoc() }

  private setImmersive(on: boolean) {
    if (!Platform.isMobile) return
    const active = this.app.workspace.getActiveViewOfType(FileView) === this
    this.containerEl.doc.body.toggleClass('octavo-immersive', on && active)
  }

  async onClose() {
    this.containerEl.doc.body.removeClass('octavo-immersive')
    this.focusMode.exit()
    await this.closeDoc()
  }

  private async closeDoc() {
    if (this.ready) { await this.savePosition(); await this.logSession() }
    this.ready = false
    this.viewer?.cleanup?.()
    this.viewer?.setDocument?.(null)
    this.viewer = null
    this.textCache.clear()
    this.rawCache.clear()
    this.textIO?.disconnect()
    this.textView?.empty()
    this.mode = 'pages'
    await this.doc?.destroy?.()
    this.doc = null
    this.chrome?.destroy()
  }

  async setEphemeralState(state: any) {
    super.setEphemeralState?.(state)
    const sub = state?.subpath
    if (typeof sub !== 'string' || !sub) return
    if (!this.ready || !this.viewer?.pagesCount) { this.pendingSubpath = sub; return }
    await this.navigateSubpath(sub)
  }

  private async navigateSubpath(sub: string) {
    const sp = parseSubpath(sub)
    if (!sp || sp.type === 'cfi') return
    const page = sp.type === 'selection' ? sp.selection.page : sp.page
    const from = this.page
    this.goToPage(page)
    if (sp.type === 'selection') this.whenTextLayer(page, () => this.flashSelection(sp.selection))
    if (from !== page) this.offerBack(from)
  }

  goToPage(n: number) {
    if (this.mode === 'text') { this.page = Math.min(this.doc?.numPages ?? n, Math.max(1, n)); this.scrollTextTo(this.page); this.updateFooter(); return }
    if (!this.viewer?.pagesCount) return
    this.viewer.currentPageNumber = Math.min(this.doc.numPages, Math.max(1, n))
  }

  private pageView(n: number): any { return this.viewer?.getPageView?.(n - 1) }

  /** Run `fn` once page n's text layer exists (immediately if it already does). */
  private whenTextLayer(n: number, fn: () => void) {
    if (this.pageView(n)?.textLayer?.textLayer?.textDivs?.length) return fn()
    const handler = ({ pageNumber }: { pageNumber: number }) => { if (pageNumber === n) { this.eventBus.off('textlayerrendered', handler); window.setTimeout(fn, 30) } }
    this.eventBus.on('textlayerrendered', handler)
  }

  // ───────────────────────── text layer, highlights ─────────────────────────

  /** Tag spans with their PDF++ index and draw this page's highlights. */
  private onTextLayer(n: number) {
    const tl = this.pageView(n)?.textLayer?.textLayer
    const divs: HTMLElement[] | undefined = tl?.textDivs
    divs?.forEach((d, i) => (d.dataset.idx = String(i)))
    const strs: string[] | undefined = tl?.textContentItemsStr
    const items: any[] | undefined = tl?.textContentItems
    if (strs) this.textCache.set(n, { items: [...strs], eol: strs.map((_, i) => !!items?.filter((x: any) => 'str' in x)[i]?.hasEOL) })
    this.drawHighlights(n)
  }

  private async pageItems(n: number): Promise<{ items: string[]; eol: boolean[] }> {
    const cached = this.textCache.get(n)
    if (cached) return cached
    const page = await this.doc.getPage(n)
    const textItems = (await page.getTextContent()).items.filter((it: any) => 'str' in it)
    const v = { items: textItems.map((it: any) => it.str as string), eol: textItems.map((it: any) => !!it.hasEOL) }
    this.textCache.set(n, v)
    return v
  }

  /** Page text with spaces at line ends, plus each item's start offset (PDF++ indices ↔ text offsets). */
  private pageString(p: { items: string[]; eol: boolean[] }): { text: string; starts: number[] } {
    let text = ''
    const starts: number[] = []
    p.items.forEach((str, i) => { starts.push(text.length); text += str; if (p.eol[i] && !/\s$/.test(str)) text += ' ' })
    return { text, starts }
  }

  private scannedCache = new Map<number, boolean>()
  /** A page is "scanned" when one raster image covers most of it (OCR text on top doesn't change that). */
  private async markScanned(n: number) {
    const pv = this.pageView(n)
    if (!pv?.div) return
    let scanned = this.scannedCache.get(n)
    if (scanned === undefined) {
      const page = await this.doc.getPage(n)
      const ops = await page.getOperatorList()
      const vp = page.getViewport({ scale: 1 })
      scanned = imageCoverage(ops.fnArray, ops.argsArray, this.pdfjs.OPS, vp.width, vp.height) >= 0.6
      this.scannedCache.set(n, scanned)
    }
    pv.div.toggleClass('is-scanned', scanned)
  }

  private hasSel(): boolean {
    const s = this.containerEl.doc.getSelection()
    return !!s && !s.isCollapsed && this.container.contains(s.anchorNode) && s.toString().trim().length > 0
  }

  private checkSelection() {
    if (!this.hasSel()) return
    const range = this.containerEl.doc.getSelection()!.getRangeAt(0)
    this.popover.show(range.getBoundingClientRect(), {
      color: c => void this.createHighlight(c, 'highlight'),
      underline: () => void this.createHighlight(this.plugin.settings.defaultColor, 'underline'),
      note: () => void this.createHighlight(this.plugin.settings.defaultColor, 'highlight', true),
      copyLink: () => void this.copySelectionLink(),
      define: () => this.plugin.define(range.toString(), range.toString()),
      ask: () => void this.askAbout(range.toString()),
      speak: () => { this.popover.hide(); Speaker.say(range.toString(), this.plugin.settings.tts) },
    })
  }

  private async askAbout(text: string) {
    const ctx = this.pageString(await this.pageItems(this.page)).text.slice(0, 3000)
    this.plugin.ask(text, ctx, this.title, this.fraction())
  }

  private pageOf(node: Node): number | null {
    const pageEl = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('.page') as HTMLElement | null
    const n = Number(pageEl?.dataset.pageNumber)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  /** DOM selection → PDF++ selection (text-layer item index + char offset, both ends). */
  private selectionToPdf(): { sel: PdfSelection; text: string } | null {
    const ds = this.containerEl.doc.getSelection()
    if (!ds || ds.isCollapsed) return null
    const r = ds.getRangeAt(0)
    const page = this.pageOf(r.startContainer)
    if (!page) return null
    const pos = (node: Node, off: number): [number, number] | null => {
      const span = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-idx]') as HTMLElement | null
      if (!span) return null
      let o = 0
      const walker = this.containerEl.doc.createTreeWalker(span, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) { if (t === node) return [Number(span.dataset.idx), o + off]; o += (t as Text).data.length }
      return [Number(span.dataset.idx), node.nodeType === 1 ? (off > 0 ? span.textContent?.length ?? 0 : 0) : off]
    }
    const a = pos(r.startContainer, r.startOffset)
    let b = pos(r.endContainer, r.endOffset)
    if (!a) return null
    if (!b || this.pageOf(r.endContainer) !== page) {
      const items = this.textCache.get(page)?.items ?? []
      b = [Math.max(0, items.length - 1), items.at(-1)?.length ?? 0]
    }
    return { sel: { page, beginIndex: a[0], beginOffset: a[1], endIndex: b[0], endOffset: b[1] }, text: ds.toString() }
  }

  private async quoteOn(sel: PdfSelection) {
    const { text, starts } = this.pageString(await this.pageItems(sel.page))
    const start = (starts[sel.beginIndex] ?? 0) + sel.beginOffset
    const end = (starts[sel.endIndex] ?? text.length) + sel.endOffset
    const q = makeQuote(text, start, Math.max(start, end))
    return { ...q, exact: q.exact.trim() }
  }

  private chapterOf(page: number): { title: string; start: number; end: number } | null {
    const flat = this.outline.filter(o => o.depth === 0)
    for (let i = flat.length - 1; i >= 0; i--) if (flat[i]!.page <= page) return { title: flat[i]!.title, start: flat[i]!.page, end: (flat[i + 1]?.page ?? (this.doc?.numPages ?? page) + 1) - 1 }
    return null
  }

  private async createHighlight(color: HighlightColor, style: 'highlight' | 'underline', withNote = false) {
    if (!this.file || !this.note) return
    const got = this.selectionToPdf()
    if (!got) return
    const h: Highlight = {
      id: newHighlightId(), color, style, created: new Date().toISOString(),
      label: [this.chapterOf(got.sel.page)?.title, `p. ${got.sel.page}`].filter(Boolean).join(' · '),
      anchor: { pdf: got.sel, quote: await this.quoteOn(got.sel) },
    }
    if (withNote) {
      const n = await new TextPromptModal(this.app, 'Note', '', 'Add a note to this highlight').result()
      if (n === null) return
      h.note = n || undefined
    }
    this.containerEl.doc.getSelection()?.removeAllRanges()
    this.popover.hide()
    this.highlights.set(h.id, { ...h, lines: [0, 0] })
    this.drawHighlights(got.sel.page)
    await this.plugin.library.saveHighlight(this.file, this.note, h)
    this.session.highlights++
    if (this.plugin.settings.autoPaste) await this.plugin.autoPaste(h, this.file, this.note)
  }

  private async copySelectionLink() {
    const got = this.selectionToPdf()
    if (!got || !this.file || !this.note) return
    const link = this.app.fileManager.generateMarkdownLink(this.file, this.note.path, formatPdfSubpath(got.sel), got.text.slice(0, 60).replace(/\s+/g, ' ')).replace(/^!/, '')
    await navigator.clipboard.writeText(link)
    new Notice('Link copied')
    this.popover.hide()
  }

  private async loadHighlights() {
    if (!this.note) return
    this.highlights = new Map((await this.plugin.library.highlights(this.note)).map(h => [h.id, h]))
    this.redrawAll()
    this.panel?.tab === 'highlights' && this.panel.refresh()
  }

  /** Rects for a PDF++ selection, relative to the page element, one per line. */
  private selectionRects(n: number, sel: PdfSelection): DOMRect[] {
    const pv = this.pageView(n)
    const divs: HTMLElement[] | undefined = pv?.textLayer?.textLayer?.textDivs
    if (!pv?.div || !divs?.length) return []
    const point = (idx: number, off: number): [Node, number] | null => {
      const sp = divs[idx]
      if (!sp) return null
      const walker = this.containerEl.doc.createTreeWalker(sp, NodeFilter.SHOW_TEXT)
      let o = off
      for (let t = walker.nextNode(); t; t = walker.nextNode()) { const len = (t as Text).data.length; if (o <= len) return [t, o]; o -= len }
      return [sp, sp.childNodes.length]
    }
    const a = point(sel.beginIndex, sel.beginOffset), b = point(sel.endIndex, sel.endOffset)
    if (!a || !b) return []
    const r = this.containerEl.doc.createRange()
    try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]) } catch { return [] }
    const base = pv.div.getBoundingClientRect()
    return mergeLines(Array.from(r.getClientRects()).filter(x => x.width > 0.5 && x.height > 0.5)
      .map(x => new DOMRect(x.left - base.left, x.top - base.top, x.width, x.height)))
  }

  private hlLayer(n: number): HTMLElement | null {
    const pv = this.pageView(n)
    if (!pv?.div) return null
    let layer = pv.div.querySelector(':scope > .octavo-pdf-hl') as HTMLElement | null
    if (!layer) layer = el('div', 'octavo-pdf-hl', pv.div)
    return layer
  }

  private drawHighlights(n: number) {
    const layer = this.hlLayer(n)
    if (!layer || !this.pageView(n)?.textLayer?.textLayer?.textDivs?.length) return
    layer.empty()
    const marks: Array<{ sel: PdfSelection; color: string; cls: string; onClick: (e: MouseEvent) => void }> = []
    for (const h of this.highlights.values()) {
      let sel = h.anchor.pdf
      if (!sel) sel = this.anchorQuote(n, h) ?? undefined
      if (!sel || sel.page !== n) continue
      marks.push({ sel, color: COLOR_CSS[h.color], cls: h.style === 'underline' ? 'is-underline' : '', onClick: e => this.onHighlightClick(h, e) })
    }
    for (const b of this.backlinks) {
      if (b.subpath.type !== 'selection' || b.subpath.selection.page !== n) continue
      marks.push({ sel: b.subpath.selection, color: 'var(--octavo-backlink, #8a7cff)', cls: 'is-backlink', onClick: () => void this.app.workspace.openLinkText(b.sourcePath, '', 'split') })
    }
    for (const m of marks) for (const r of this.selectionRects(n, m.sel)) {
      const d = el('div', `octavo-pdf-hlmark ${m.cls}`, layer)
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--c:${m.color}`
      d.onclick = e => { e.stopPropagation(); m.onClick(e) }
    }
  }

  private redrawAll() { if (this.viewer) for (let n = 1; n <= (this.doc?.numPages ?? 0); n++) if (this.pageView(n)?.textLayer?.textLayer?.textDivs?.length) this.drawHighlights(n) }

  /** Imported highlights (quote only): find on this page and upgrade to a PDF++ selection. */
  private anchorQuote(n: number, h: ParsedHighlight): PdfSelection | null {
    const p = this.textCache.get(n)
    if (!p) return null
    const { text, starts } = this.pageString(p)
    const m = findQuote(text, h.anchor.quote)
    if (!m) return null
    const itemAt = (off: number) => { let i = 0; while (i + 1 < starts.length && starts[i + 1]! <= off) i++; return i }
    const bi = itemAt(m.start), ei = itemAt(Math.max(m.start, m.end - 1))
    const sel = { page: n, beginIndex: bi, beginOffset: m.start - starts[bi]!, endIndex: ei, endOffset: Math.min((p.items[ei] ?? '').length, m.end - starts[ei]!) }
    if (!h.id) return sel
    const up: Highlight = { ...h, anchor: { ...h.anchor, pdf: sel } }
    this.highlights.set(h.id, { ...h, anchor: up.anchor })
    if (this.file && this.note) void this.plugin.library.saveHighlight(this.file, this.note, up)
    return sel
  }

  private onHighlightClick(h: ParsedHighlight, e: MouseEvent) {
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    if ((e.ctrlKey || e.metaKey) && this.note) {
      this.app.workspace.trigger('hover-link', { event: e, source: 'octavo', hoverParent: this, targetEl: e.target, linktext: `${this.note.path}#^oct-${h.id}`, sourcePath: this.file?.path ?? '' })
      return
    }
    this.popover.show(rect, {
      color: c => void this.updateHighlight(h, { color: c, style: 'highlight' }),
      underline: () => void this.updateHighlight(h, { style: h.style === 'underline' ? 'highlight' : 'underline' }),
      note: async () => { const n = await new TextPromptModal(this.app, 'Note', h.note ?? '', 'Note').result(); if (n !== null) await this.updateHighlight(h, { note: n || undefined }) },
      copyLink: async () => { await navigator.clipboard.writeText(this.plugin.library.linkFor(this.file!, this.note!, h)); new Notice('Link copied'); this.popover.hide() },
      define: () => this.plugin.define(h.anchor.quote.exact, h.anchor.quote.exact),
      ask: () => void this.askAbout(h.anchor.quote.exact),
      speak: () => { this.popover.hide(); Speaker.say(h.anchor.quote.exact, this.plugin.settings.tts) },
      remove: async () => { this.popover.hide(); this.highlights.delete(h.id); this.redrawAll(); if (this.note) await this.plugin.library.deleteHighlight(this.note, h.id) },
      openInNote: () => { this.popover.hide(); if (this.note) void this.app.workspace.openLinkText(`${this.note.path}#^oct-${h.id}`, '', 'split') },
    }, { color: h.color, underline: h.style === 'underline' })
  }

  private async updateHighlight(h: ParsedHighlight, patch: Partial<Highlight>) {
    if (!this.file || !this.note) return
    const next = { ...h, ...patch }
    this.highlights.set(h.id, next)
    this.popover.hide()
    this.redrawAll()
    await this.plugin.library.saveHighlight(this.file, this.note, next)
  }

  private flashSelection(sel: PdfSelection) {
    const layer = this.hlLayer(sel.page)
    const rects = this.selectionRects(sel.page, sel)
    if (!layer || !rects.length) return
    for (const r of rects) {
      const d = el('div', 'octavo-pdf-flash', layer)
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
      window.setTimeout(() => d.remove(), 2200)
    }
    const pv = this.pageView(sel.page)
    this.container.scrollTo({ top: pv.div.offsetTop + rects[0]!.top - this.container.clientHeight / 3, behavior: 'smooth' })
  }

  private refreshBacklinks() {
    if (!this.file) return
    this.backlinks = this.plugin.library.backlinks(this.file).filter(b => b.sourcePath !== this.note?.path && b.subpath.type === 'selection')
    this.redrawAll()
  }

  // ───────────────────────── look, position, chrome ─────────────────────────

  applyLook() {
    const s = this.plugin.settings
    const dark = this.containerEl.doc.body.hasClass('theme-dark')
    this.root.toggleClass('octavo-dark', dark)
    this.root.toggleClass('octavo-footer-off', s.footer === 'off')
    this.root.dataset.pdfDark = s.pdfDark
    if (this.viewer && this.darkKey !== `${dark}:${s.pdfDark}`) this.buildViewer(this.page)
    this.styleTextView()
    this.setMode(s.pdfMode)
    this.updateFooter()
  }

  // ───────────────────────── Text view (reflowed PDF) ─────────────────────────

  private mode: 'pages' | 'text' = 'pages'

  private setMode(mode: 'pages' | 'text') {
    if (!this.doc) return
    if (mode === this.mode && (mode === 'pages' || this.textView.childElementCount)) return
    const page = this.page
    this.mode = mode
    this.container.toggle(mode === 'pages')
    this.textView.toggle(mode === 'text')
    this.root.toggleClass('is-textview', mode === 'text')
    if (mode === 'text') { this.buildTextView(); window.setTimeout(() => this.scrollTextTo(page), 30) }
    else { this.goToPage(page); this.fit() }
  }

  private styleTextView() {
    const look = resolveLook(this.plugin.settings, this.containerEl.doc.body.hasClass('theme-dark'))
    const t = look.typo
    const obsidianFont = getComputedStyle(this.containerEl.doc.body).getPropertyValue('--font-text').trim()
    const st = this.textView.style
    st.setProperty('--tv-bg', look.colors.bg)
    st.setProperty('--tv-fg', look.colors.fg)
    st.setProperty('--tv-font', fontStack(t.font === 'publisher' ? 'serif' : t.font, obsidianFont) ?? 'serif')
    st.setProperty('--tv-size', `${(t.fontSize / 100) * 1.15}em`)
    st.setProperty('--tv-lh', String(t.lineHeight))
    st.setProperty('--tv-measure', `${Math.max(28, 40 - t.margin / 8)}em`)
    st.setProperty('--tv-align', t.justify ? 'justify' : 'start')
    st.setProperty('--tv-hyphens', t.hyphenate ? 'auto' : 'manual')
  }

  private buildTextView() {
    this.textIO?.disconnect()
    this.textView.empty()
    const article = el('article', 'octavo-reflow', this.textView)
    this.textIO = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { this.textIO?.unobserve(e.target); void this.fillTextPage(e.target as HTMLElement) }
    }, { root: this.textView, rootMargin: '200% 0px' })
    for (let n = 1; n <= this.doc.numPages; n++) {
      const sec = el('section', 'octavo-reflow-page', article)
      sec.dataset.page = String(n)
      sec.addClass('octavo-reflow-pending')
      this.textIO.observe(sec)
    }
  }

  private async fillTextPage(sec: HTMLElement) {
    const n = Number(sec.dataset.page)
    const page = await this.doc.getPage(n)
    let raw: any[] = this.rawCache.get(n) ?? []
    if (!this.rawCache.has(n)) {
      raw = (await page.getTextContent()).items.filter((it: any) => 'str' in it)
      this.rawCache.set(n, raw)
    }
    const blocks = reflow(raw)
    const vp1 = page.getViewport({ scale: 1 })
    sec.removeClass('octavo-reflow-pending')
    const marker = el('div', 'octavo-reflow-pagenum', sec, String(n))
    marker.setAttribute('aria-label', `Page ${n}`)
    // figures: blank-of-text bands that contain ink, cropped from a rendered page
    const bodySize = blocks.find(b => b.type === 'p')?.size ?? 10
    const bands = figureBands(blocks, vp1.height, bodySize * 4)
    // keep crops clear of neighbouring text lines
    const inset = bodySize * 0.45
    const trimmed = bands.map(b => ({ top: b.top - (b.top < vp1.height - 1 ? inset : 0), bottom: b.bottom + (b.bottom > 1 ? inset : 0) })).filter(b => b.top - b.bottom > bodySize * 3)
    const figures = trimmed.length || !blocks.length ? await this.cropFigures(page, trimmed.length ? trimmed : [{ top: vp1.height, bottom: 0 }]) : []
    type Item = { y: number; el: () => void }
    const items: Item[] = [
      ...blocks.map(b => ({ y: b.top ?? 0, el: () => el(b.type === 'h' ? 'h3' : 'p', '', sec, b.text) })),
      ...figures.map(f => ({ y: f.top, el: () => { const fig = el('figure', 'octavo-reflow-figure', sec); fig.appendChild(f.img) } })),
    ].sort((a, b) => b.y - a.y)
    for (const it of items) it.el()
    if (!blocks.length && !figures.length) el('div', 'octavo-reflow-empty', sec, 'Blank page')
    this.joinAcrossPages(n)
  }

  /** Render the page once and crop each band that actually contains ink (drawings, photos). */
  private async cropFigures(page: any, bands: Array<{ top: number; bottom: number }>): Promise<Array<{ top: number; img: HTMLImageElement }>> {
    const scale = Math.min(2, 1400 / page.getViewport({ scale: 1 }).width) * Math.min(window.devicePixelRatio || 1, 2) / 1.5
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    const out: Array<{ top: number; img: HTMLImageElement }> = []
    for (const b of bands) {
      const y0 = Math.max(0, Math.floor((vp1h(page) - b.top) * scale)), y1 = Math.min(canvas.height, Math.ceil((vp1h(page) - b.bottom) * scale))
      if (y1 - y0 < 20) continue
      const data = ctx.getImageData(0, y0, canvas.width, y1 - y0).data
      // ink bounding box (pixels clearly darker than paper)
      let minX = canvas.width, maxX = 0, minY = y1 - y0, maxY = 0, ink = 0, mid = 0
      for (let y = 0; y < y1 - y0; y += 2) for (let x = 0; x < canvas.width; x += 2) {
        const i = (y * canvas.width + x) * 4
        const sum = data[i]! + data[i + 1]! + data[i + 2]!
        if (sum < 600) { ink++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
        if (sum > 150 && sum < 600) mid++
      }
      if (ink < 40 || maxY - minY < 16) continue
      const pad = 8
      const cx = Math.max(0, minX - pad), cy = y0 + Math.max(0, minY - pad)
      const cw = Math.min(canvas.width - cx, maxX - minX + pad * 2), ch = Math.min(canvas.height - cy, maxY - minY + pad * 2)
      const c2 = document.createElement('canvas'); c2.width = cw; c2.height = ch
      c2.getContext('2d')!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch)
      const img = new Image()
      img.src = c2.toDataURL('image/webp', 0.85)
      img.alt = ''
      // photos have lots of mid-tones; line drawings are mostly paper + ink. Only line art is inverted in dark mode.
      img.className = ink && mid / ink > 0.45 ? 'is-photo' : 'is-lineart'
      img.style.width = `${Math.round((cw / scale) * 1.1)}px` // keep the figure's natural size relative to the text
      out.push({ top: b.top - (minY / scale), img })
      c2.width = c2.height = 0
    }
    canvas.width = canvas.height = 0
    return out
  }

  /** Re-join a paragraph cut by the page break between page n-1 and n (and n and n+1). */
  private joinAcrossPages(n: number) {
    for (const [a, b] of [[n - 1, n], [n, n + 1]] as const) {
      const prevSec = this.textView.querySelector(`[data-page="${a}"]`), nextSec = this.textView.querySelector(`[data-page="${b}"]`)
      const last = prevSec?.querySelector(':scope > :last-child')
      const first = nextSec?.querySelector(':scope > .octavo-reflow-pagenum + p') as HTMLElement | null
      if (last?.tagName !== 'P' || !first || first.dataset.joined) continue
      if (!continues(last.textContent ?? '', first.textContent ?? '')) continue
      last.textContent = `${last.textContent} ${first.textContent}`
      first.dataset.joined = '1'
      first.hide()
    }
  }

  private scrollTextTo(n: number) {
    const sec = this.textView.querySelector(`[data-page="${n}"]`) as HTMLElement | null
    if (sec) this.textView.scrollTop = sec.offsetTop - 40
  }

  private textScrollTimer = 0
  private onTextScroll() {
    window.clearTimeout(this.textScrollTimer)
    this.textScrollTimer = window.setTimeout(() => {
      const top = this.textView.scrollTop + this.textView.clientHeight * 0.3
      let p = this.page
      for (const sec of Array.from(this.textView.querySelectorAll<HTMLElement>('.octavo-reflow-page'))) {
        if (sec.offsetTop <= top) p = Number(sec.dataset.page); else break
      }
      if (p !== this.page) {
        this.page = p
        this.updateFooter()
        window.clearTimeout(this.saveTimer)
        this.saveTimer = window.setTimeout(() => void this.savePosition(), 2000)
      }
    }, 80)
  }

  private fraction() { return this.doc ? (this.page - 1) / Math.max(1, this.doc.numPages - 1) : 0 }

  private updateFooter() {
    if (!this.doc) return
    const total = this.doc.numPages
    const pct = Math.round(this.fraction() * 100)
    this.chrome.progressBar.style.setProperty('--octavo-progress', `${this.fraction() * 100}%`)
    const ch = this.chapterOf(this.page)
    const left = ch ? ch.end - this.page : 0
    const s = this.plugin.settings
    let text = `Page ${this.page} of ${total} · ${pct}%`
    if (s.footer === 'chapter' && ch) text = `${left === 0 ? 'Last page in chapter' : `${left} page${left === 1 ? '' : 's'} left in chapter`} · ${pct}%`
    if (s.footer === 'time') {
      const perPage = this.plugin.pace.estimate(1800)
      text = `${ch ? `${Math.max(1, Math.round((left + 1) * perPage / 60))} min left in chapter · ` : ''}${Math.round((total - this.page) * perPage / 3600 * 10) / 10} h left`
    }
    this.chrome.footerText.setText(text)
    this.chrome.title.setText(ch ? `${this.title} — ${ch.title}` : this.title)
    const bms: unknown = this.note ? this.plugin.library.getProps(this.note).bookmarks : null
    this.chrome.setBookmarked(Array.isArray(bms) && bms.includes(this.page))
  }

  private async savePosition() {
    if (!this.note || !this.doc) return
    const props = this.plugin.library.getProps(this.note)
    const progress = Math.round(this.fraction() * 1000) / 1000
    if (props.page === this.page && props.progress === progress) return
    const patch: Record<string, unknown> = { page: this.page, progress, 'last-read': moment().format('YYYY-MM-DDTHH:mm') }
    if (this.page === this.doc.numPages && props.status !== 'finished') { patch.status = 'finished'; patch.finished = moment().format('YYYY-MM-DD') }
    await this.plugin.library.setProps(this.note, patch)
  }

  private async logSession() {
    if (!this.file || !this.session.start) return
    const minutes = Math.round((Date.now() - this.session.start) / 60000)
    await this.plugin.library.logSession({ book: this.file, note: this.note, title: this.title, minutes, from: this.session.from, to: this.fraction(), highlights: this.session.highlights })
    this.session.start = 0
    await this.plugin.saveSettings()
  }

  private offerBack(page: number) {
    this.chrome.showBack(`Back to page ${page}`, () => this.goToPage(page))
    window.setTimeout(() => this.chrome.hideBack(), 15000)
  }

  private async loadOutline() {
    this.outline = []
    const raw = await this.doc.getOutline().catch(() => null)
    const walk = async (items: any[], depth: number) => {
      for (const it of items ?? []) {
        let page = 0
        try {
          const dest = typeof it.dest === 'string' ? await this.doc.getDestination(it.dest) : it.dest
          if (dest?.[0]) page = (await this.doc.getPageIndex(dest[0])) + 1
        } catch { /* unresolved */ }
        if (page) this.outline.push({ title: String(it.title ?? '').trim(), page, depth })
        if (it.items?.length && depth < 3) await walk(it.items, depth + 1)
      }
    }
    if (raw) await walk(raw, 0)
  }

  private async saveCover() {
    try {
      const page = await this.doc.getPage(1)
      const v = page.getViewport({ scale: 360 / page.getViewport({ scale: 1 }).width })
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height
      await page.render({ canvasContext: c.getContext('2d')!, viewport: v }).promise
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.82))
      const path = await this.plugin.library.saveCover(this.bookId, blob)
      if (path && this.note) await this.plugin.library.setProps(this.note, { cover: `[[${path}]]` })
    } catch { /* no cover */ }
  }

  private onClick(e: MouseEvent) {
    if (this.hasSel() || (e.target as Element).closest('.octavo-pdf-hlmark, a, .annotationLayer section')) return
    if (this.popover.visible) { this.popover.hide(); return }
    if (this.panel.isOpen) { this.panel.close(); return }
    const r = this.root.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    if (Platform.isMobile && (fx < 0.25 || fx > 0.75)) {
      const dir = (fx < 0.25) !== this.plugin.settings.leftHanded ? -1 : 1
      this.container.scrollBy({ top: dir * this.container.clientHeight * 0.9, behavior: 'smooth' })
      return
    }
    this.chrome.toggle()
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select, .octavo-panel')) return
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); this.viewer?.nextPage() }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.viewer?.previousPage() }
    else if ((e.key === '=' || e.key === '+') && mod) { e.preventDefault(); this.zoomBy(1.15) }
    else if (e.key === '-' && mod) { e.preventDefault(); this.zoomBy(1 / 1.15) }
    else if (e.key === '0' && mod) { e.preventDefault(); this.zoom = 'page-width'; this.fit() }
    else if (e.key === 'Escape') { if (!this.popover.visible && !this.panel.isOpen) this.focusMode.exit(); this.popover.hide(); this.panel.close() }
    else if ((e.key === 'h' || e.key === 'H') && this.hasSel()) { e.preventDefault(); void this.createHighlight(this.plugin.settings.defaultColor, 'highlight') }
    else if ((e.key === 'n' || e.key === 'N') && this.hasSel()) { e.preventDefault(); void this.createHighlight(this.plugin.settings.defaultColor, 'highlight', true) }
  }

  private async toggleBookmark() {
    if (!this.note) return
    let next: number[] = []
    await this.app.fileManager.processFrontMatter(this.note, fm => {
      const cur: number[] = Array.isArray(fm.bookmarks) ? fm.bookmarks.filter((x: unknown) => typeof x === 'number') : []
      next = cur.includes(this.page) ? cur.filter(p => p !== this.page) : [...cur, this.page].sort((a, b) => a - b)
      if (next.length) fm.bookmarks = next; else delete fm.bookmarks
    })
    this.chrome.setBookmarked(next.includes(this.page))
  }

  private async speakPage() {
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); this.chrome.setSpeaking(false); return }
    const text = this.pageString(await this.pageItems(this.page)).text
    if (!text.trim()) { new Notice('This page has no text layer. Octavo Cloud can OCR scanned PDFs.'); return }
    const u = new SpeechSynthesisUtterance(text)
    u.rate = this.plugin.settings.tts.rate
    const v = Speaker.voice(this.plugin.settings.tts.voice); if (v) u.voice = v
    u.onend = () => { this.chrome.setSpeaking(false); if (this.page < (this.doc?.numPages ?? 0)) { this.goToPage(this.page + 1); window.setTimeout(() => void this.speakPage(), 600) } }
    this.chrome.setSpeaking(true)
    speechSynthesis.speak(u)
  }

  private moreMenu(e: MouseEvent) {
    const m = new Menu()
    m.addItem(i => i.setTitle(this.focusMode.active ? 'Exit focus mode' : 'Focus mode (full screen)').setIcon(this.focusMode.active ? 'minimize' : 'maximize').onClick(() => this.focusMode.toggle()))
    if (canPopout()) m.addItem(i => i.setTitle('Read in new window').setIcon('picture-in-picture-2').onClick(() => this.file && void this.plugin.openInOctavo(this.file, this.app.workspace.openPopoutLeaf({ size: { width: 900, height: 1000 } }))))
    m.addItem(i => i.setTitle(this.mode === 'text' ? 'Page view' : 'Text view (reflow)').setIcon(this.mode === 'text' ? 'file' : 'align-left').onClick(() => { this.plugin.settings.pdfMode = this.mode === 'text' ? 'pages' : 'text'; void this.plugin.saveSettings(); this.applyLook() }))
    m.addItem(i => i.setTitle('Open book note').setIcon('file-text').onClick(() => this.note && besideLeaf(this.app).openFile(this.note)))
    m.addItem(i => i.setTitle('Zoom in').setIcon('zoom-in').onClick(() => this.zoomBy(1.2)))
    m.addItem(i => i.setTitle('Zoom out').setIcon('zoom-out').onClick(() => this.zoomBy(1 / 1.2)))
    m.addItem(i => i.setTitle('Fit width').setIcon('maximize-2').onClick(() => { this.zoom = 'page-width'; this.fit() }))
    m.addItem(i => i.setTitle('Go to page…').setIcon('hash').onClick(async () => {
      const v = await new TextPromptModal(this.app, 'Go to page', String(this.page), `1–${this.doc?.numPages}`).result()
      if (v && Number(v)) { const from = this.page; this.goToPage(Number(v)); this.offerBack(from) }
    }))
    if (this.pageView(this.page)?.div?.hasClass('is-scanned')) m.addItem(i => i.setTitle('Make searchable (OCR, Octavo Cloud)').setIcon('scan-text').onClick(() => this.file && this.plugin.cloud.requestOcr(this.file)))
    m.addItem(i => i.setTitle('Open in Obsidian’s PDF viewer').setIcon('file').onClick(() => this.leaf.setViewState({ type: 'pdf', state: { file: this.file?.path } })))
    m.showAtMouseEvent(e)
  }

  private renderPanel(tab: PanelTab, body: HTMLElement) {
    if (tab === 'appearance') return renderAppearance(body, this.plugin.settings, this.containerEl.doc.body.hasClass('theme-dark'), () => { this.applyLook(); void this.plugin.saveSettings() }, { pdf: true })
    if (tab === 'toc') {
      if (!this.outline.length) el('div', 'octavo-empty', body, 'This PDF has no outline.')
      const cur = this.chapterOf(this.page)
      for (const o of this.outline) {
        const row = el('div', `octavo-toc-item depth-${Math.min(o.depth, 3)}`, body)
        el('span', '', row, o.title)
        el('span', 'octavo-toc-page', row, String(o.page))
        if (cur && o.page === cur.start && o.depth === 0) row.addClass('is-active')
        row.onclick = () => { const from = this.page; this.goToPage(o.page); this.panel.close(); this.offerBack(from) }
      }
      return
    }
    if (tab === 'highlights') {
      const list = [...this.highlights.values()].sort((a, b) => (a.anchor.pdf?.page ?? 0) - (b.anchor.pdf?.page ?? 0))
      if (!list.length) el('div', 'octavo-empty', body, 'Select text to highlight. Highlights are saved to the book note.')
      for (const h of list) {
        const card = el('div', `octavo-hl-card octavo-hl-${h.color}`, body)
        if (h.label) el('div', 'octavo-hl-label', card, h.label)
        el('div', 'octavo-hl-quote', card, h.anchor.quote.exact)
        if (h.note) el('div', 'octavo-hl-note', card, h.note)
        card.onclick = () => { const sel = h.anchor.pdf; if (sel) { this.goToPage(sel.page); this.whenTextLayer(sel.page, () => this.flashSelection(sel)) } }
      }
      return
    }
    if (tab === 'search') return this.renderSearch(body)
    if (tab === 'map') return this.renderThumbs(body)
  }

  private renderSearch(body: HTMLElement) {
    const input = el('input', 'octavo-search-input', body) as HTMLInputElement
    input.type = 'search'; input.placeholder = 'Search this PDF'
    const status = el('div', 'octavo-search-status', body)
    const list = el('div', 'octavo-search-results', body)
    let token = 0
    const run = async () => {
      const q = input.value.trim().toLowerCase(), my = ++token
      list.empty()
      if (!q) return
      let n = 0
      for (let p = 1; p <= this.doc.numPages && my === token; p++) {
        const { text } = this.pageString(await this.pageItems(p))
        const low = text.toLowerCase()
        for (let i = low.indexOf(q); i >= 0 && n < 500; i = low.indexOf(q, i + q.length)) {
          n++
          const row = el('div', 'octavo-search-hit', list)
          el('span', 'octavo-toc-page', row, `p. ${p}`)
          el('span', '', row, text.slice(Math.max(0, i - 40), i))
          el('mark', '', row, text.slice(i, i + q.length))
          el('span', '', row, text.slice(i + q.length, i + q.length + 40))
          const quote = { exact: text.slice(i, i + q.length), prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(i + q.length, i + q.length + 32) }
          row.onclick = () => {
            this.goToPage(p)
            this.whenTextLayer(p, () => { const sel = this.anchorQuote(p, { id: '', color: 'yellow', style: 'highlight', created: '', lines: [0, 0], anchor: { quote } }); if (sel) this.flashSelection(sel) })
          }
        }
        if (p % 10 === 0) status.setText(`Searching… page ${p} of ${this.doc.numPages}`)
      }
      if (my === token) status.setText(n ? `${n} result${n === 1 ? '' : 's'}` : 'No results')
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') void run() })
    window.setTimeout(() => input.focus())
  }

  /** Page Flip-style thumbnail grid; current page highlighted. */
  private renderThumbs(body: HTMLElement) {
    const grid = el('div', 'octavo-thumbs', body)
    const io = new IntersectionObserver(async entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const c = e.target as HTMLCanvasElement
        io.unobserve(c)
        const page = await this.doc.getPage(Number(c.dataset.page))
        const v = page.getViewport({ scale: 140 / page.getViewport({ scale: 1 }).width })
        c.width = v.width; c.height = v.height
        await page.render({ canvasContext: c.getContext('2d')!, viewport: v }).promise
      }
    }, { root: this.panel.body })
    for (let p = 1; p <= this.doc.numPages; p++) {
      const cell = el('div', `octavo-thumb${p === this.page ? ' is-current' : ''}`, grid)
      const c = el('canvas', '', cell) as HTMLCanvasElement
      c.dataset.page = String(p)
      el('div', 'octavo-thumb-n', cell, String(p))
      cell.onclick = () => { const from = this.page; this.goToPage(p); this.panel.close(); if (from !== p) this.offerBack(from) }
      io.observe(c)
      if (p === this.page) window.setTimeout(() => cell.scrollIntoView({ block: 'center' }))
    }
    this.register(() => io.disconnect())
  }
}
