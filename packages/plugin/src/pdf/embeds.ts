import { HoverPopover, Keymap, MarkdownView, TFile, type HoverParent } from 'obsidian'
import { parseSubpath, splitLinktext, type Subpath } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { besideLeaf } from '../platform'
import { COLOR_CSS } from '../reader/colors'
import { PdfDocCache, addsEmbed, darkScanColors, releaseCanvas, renderRegion, selectionMarks, type Mark } from './regionRender'
import { pageLabel, hasOwnLabel, isDestroyedDocError } from './region'
import { PDF_VIEW } from './PdfView'

/** Embeds of a PDF region (PDF++ `![[Book.pdf#page=N&rect=l,b,r,t]]`), in Reading view and Live Preview alike. */
const REGION_EMBED = '.internal-embed[src*=".pdf#" i][src*="rect=" i]'

/**
 * Region embeds and PDF hover previews in notes.
 *
 * Obsidian renders `![[x.pdf#page=…]]` with its own PDF embed, which ignores `rect`. Octavo adds a cropped
 * canvas inside each such embed and hides the core embed's content with CSS (`.octavo-region-host`), so no
 * private embed registry is needed: if the crop can't be rendered, the class is removed and the core embed
 * shows as before. A post-processor covers Reading view; a MutationObserver per window covers Live Preview
 * (and re-adds the crop when Obsidian re-renders the embed). Hovering a `[[Book.pdf#page=…]]` link shows the
 * page (cropped to `rect`, quote marked for `selection`) in a HoverPopover.
 */
export class PdfNoteEmbeds {
  readonly docs: PdfDocCache
  private scanTimers = new Map<Document, number>()

  constructor(private plugin: OctavoPlugin) {
    this.docs = new PdfDocCache(plugin.app)
  }

  register() {
    const { plugin } = this, app = plugin.app
    plugin.registerMarkdownPostProcessor((el, ctx) => {
      for (const host of Array.from(el.querySelectorAll<HTMLElement>(REGION_EMBED))) this.upgrade(host, ctx.sourcePath)
      if (el.matches?.(REGION_EMBED)) this.upgrade(el, ctx.sourcePath)
    })
    this.observe(document)
    plugin.registerEvent(app.workspace.on('window-open', (_w, win) => this.observe(win.document)))
    plugin.registerEvent(app.workspace.on('css-change', () => { for (const d of this.scanTimers.keys()) this.scan(d, true) }))
    plugin.registerEvent(app.workspace.on('hover-link' as any, (info: any) => this.onHoverLink(info)))
    plugin.register(() => this.docs.clear())
  }

  /** Region crops that left the DOM: free their canvas memory and drop the crop, so a re-attached embed renders again. */
  private releaseRemoved(muts: MutationRecord[]) {
    for (const m of muts) for (const n of Array.from(m.removedNodes)) {
      if (n.nodeType !== 1 || (n as Node).isConnected) continue
      const el = n as HTMLElement
      const boxes = el.matches('.octavo-region-embed') ? [el] : Array.from(el.querySelectorAll<HTMLElement>('.octavo-region-embed'))
      for (const box of boxes) {
        box.querySelectorAll('canvas').forEach(releaseCanvas)
        if (box !== el) box.remove()
      }
    }
  }

  /** Watch a window for region embeds (Live Preview widgets, re-rendered embeds, hover popovers). */
  private observe(doc: Document) {
    if (this.scanTimers.has(doc)) return
    this.scanTimers.set(doc, 0)
    const mo = new MutationObserver(muts => {
      this.releaseRemoved(muts)
      if (!addsEmbed(muts, REGION_EMBED) || this.scanTimers.get(doc)) return
      this.scanTimers.set(doc, window.setTimeout(() => { this.scanTimers.set(doc, 0); this.scan(doc) }, 80))
    })
    mo.observe(doc.body, { childList: true, subtree: true })
    this.plugin.register(() => {
      mo.disconnect(); window.clearTimeout(this.scanTimers.get(doc)); this.scanTimers.delete(doc)
      doc.querySelectorAll<HTMLCanvasElement>('.octavo-region-embed canvas').forEach(releaseCanvas)
    })
    this.scan(doc)
  }

  private darkKey(doc: Document) {
    return `${doc.body.hasClass('theme-dark')}:${this.plugin.settings.pdfDark}`
  }

  private scan(doc: Document, themeChanged = false) {
    for (const host of Array.from(doc.querySelectorAll<HTMLElement>(REGION_EMBED))) {
      if (themeChanged && host.dataset.octavoDark !== undefined && host.dataset.octavoDark !== this.darkKey(doc)) {
        host.querySelector(':scope > .octavo-region-embed')?.remove()
      }
      this.upgrade(host, this.sourcePathOf(host))
    }
  }

  private sourcePathOf(el: HTMLElement): string {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view
      if (v instanceof MarkdownView && v.containerEl.contains(el)) return v.file?.path ?? ''
    }
    return ''
  }

  /** Add the cropped canvas to one embed (idempotent). */
  upgrade(host: HTMLElement, sourcePath: string) {
    if (host.dataset.octavoRegion === 'failed' || host.querySelector(':scope > .octavo-region-embed')) return
    const { path, subpath } = splitLinktext(host.getAttribute('src') ?? '')
    const sp = parseSubpath(subpath)
    if (sp?.type !== 'rect') return
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath)
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') return
    const doc = host.ownerDocument
    host.addClass('octavo-region-host')
    host.dataset.octavoDark = this.darkKey(doc)
    const box = host.createDiv({ cls: 'octavo-region-embed', attr: { role: 'link', tabindex: '0', 'aria-label': `Open ${file.basename} at page ${sp.page} in Octavo` } })
    box.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void this.open(file, subpath, e) })
    box.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void this.open(file, subpath, e) } })
    void this.fill(box, file, sp, Math.min(720, (sp.rect[2] - sp.rect[0]) * 4 / 3)).catch(err => {
      console.warn('Octavo: region embed fell back to the core PDF embed', err)
      box.remove()
      host.removeClass('octavo-region-host')
      // a document destroyed under us (already retried once) is transient: a later scan may try again
      if (!isDestroyedDocError(err)) host.dataset.octavoRegion = 'failed'
    })
  }

  /** Render the page (cropped to rect, quote marked for selection) into `box`. The document is held open while rendering. */
  private fill(box: HTMLElement, file: TFile, sp: Exclude<Subpath, { type: 'cfi' }>, cssWidth: number): Promise<{ pdf: any; n: number }> {
    return this.docs.use(file, async pdf => {
      const n = Math.min(pdf.numPages, sp.type === 'selection' ? sp.selection.page : sp.page)
      const page = await pdf.getPage(n)
      const doc = box.ownerDocument
      const dark = doc.body.hasClass('theme-dark') && this.plugin.settings.pdfDark !== 'none'
      const scanned = dark && await this.docs.isScanned(file, page, n).catch(() => false)
      const color = COLOR_CSS[(sp.color ?? 'yellow') as keyof typeof COLOR_CSS] ?? COLOR_CSS.yellow
      const marks: Mark[] = sp.type === 'selection' ? await selectionMarks(page, sp.selection, color).catch(() => []) : []
      // a quote: the full-width band around it, so the preview opens on the passage
      const vb: number[] = page.view ?? page.getViewport({ scale: 1 }).viewBox
      const band = marks.length ? [vb[0]!, Math.max(vb[1]!, Math.min(...marks.map(m => m.rect[1])) - 140), vb[2]!, Math.min(vb[3]!, Math.max(...marks.map(m => m.rect[3])) + 140)] : null
      const canvas = await renderRegion(page, sp.type === 'rect' ? sp.rect : band, cssWidth, {
        doc, marks, dark: darkScanColors(dark, this.plugin.settings.pdfDark, scanned),
      })
      canvas.addClass('octavo-region-canvas')
      if (!box.isConnected && !box.hasClass('is-hover')) { releaseCanvas(canvas); return { pdf, n } } // the embed went away while rendering
      box.toggleClass('is-dark', dark)
      box.dataset.pdfDark = this.plugin.settings.pdfDark
      box.querySelectorAll('canvas').forEach(releaseCanvas)
      box.empty()
      box.appendChild(canvas)
      return { pdf, n }
    })
  }

  /** Open the book in Octavo at the link (reusing an open Octavo tab for it). */
  private async open(file: TFile, subpath: string, e: MouseEvent | KeyboardEvent) {
    const app = this.plugin.app
    const existing = app.workspace.getLeavesOfType(PDF_VIEW).find(l => (l.view as any).file === file)
    if (existing && !Keymap.isModEvent(e)) {
      await app.workspace.revealLeaf(existing)
      await (existing.view as any).setEphemeralState?.({ subpath })
      return
    }
    const mod = Keymap.isModEvent(e)
    await this.plugin.openInOctavo(file, mod ? app.workspace.getLeaf(mod) : besideLeaf(app), { subpath })
  }

  // ───────────────────────── hover previews ─────────────────────────

  /** Does this hover source need Ctrl/Cmd held? Follows the Page preview settings when they're readable. */
  private needsMod(source: string): boolean {
    const app = this.plugin.app as any
    const ov = app.internalPlugins?.getPluginById?.('page-preview')?.instance?.overrides?.[source]
    if (typeof ov === 'boolean') return ov
    const def = app.workspace?.hoverLinkSources?.[source]?.defaultMod
    return typeof def === 'boolean' ? def : source !== 'preview'
  }

  private onHoverLink(info: { event: MouseEvent; source: string; hoverParent: HoverParent; targetEl: HTMLElement | null; linktext: string; sourcePath?: string }) {
    if (!info?.linktext || !info.hoverParent) return
    const { path, subpath } = splitLinktext(info.linktext)
    if (!/\.pdf$/i.test(path)) return
    const sp = parseSubpath(subpath)
    if (!sp || sp.type === 'cfi') return
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(path, info.sourcePath ?? '')
    if (!(file instanceof TFile)) return
    if (this.needsMod(info.source) && !Keymap.isModEvent(info.event)) return
    // after every other handler (Page preview builds its own PDF popover synchronously): ours replaces it
    queueMicrotask(() => {
      const cur = (info.hoverParent as any).hoverPopover
      if (cur?.octavoPdf && cur.targetEl === info.targetEl) return
      const pop = new HoverPopover(info.hoverParent, info.targetEl)
      ;(pop as any).octavoPdf = true
      pop.hoverEl.addClass('octavo-pdf-hover')
      const head = pop.hoverEl.createDiv({ cls: 'octavo-pdf-hover-title', text: file.basename })
      const box = pop.hoverEl.createDiv({ cls: 'octavo-region-embed is-hover', text: 'Loading…' })
      box.addEventListener('click', e => { e.preventDefault(); (pop as any).hide?.(); void this.open(file, subpath, e) })
      void this.fill(box, file, sp, sp.type === 'rect' ? Math.min(560, Math.max(240, (sp.rect[2] - sp.rect[0]) * 4 / 3)) : 420)
        .then(async ({ pdf, n }) => {
          const labels = await Promise.resolve().then(() => pdf.getPageLabels?.()).catch(() => null)
          head.setText(`${file.basename}, p. ${pageLabel(labels, n)}${hasOwnLabel(labels, n) ? ` (pdf ${n})` : ''}`)
        })
        .catch(err => { box.setText('Could not render this page.'); console.warn('Octavo: PDF hover preview failed', err) })
    })
  }
}
