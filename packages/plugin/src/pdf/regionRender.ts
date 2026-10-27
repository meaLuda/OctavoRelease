import { loadPdfJs, Platform, type App, type TFile } from 'obsidian'
import { openPdfDocument } from './source'
import { imageCoverage } from './geometry'
import { pdfRectToViewport, regionPlan, regionLimits, isDestroyedDocError, itemRect, type PdfRect } from './region'
import { recolourScan, type ScanColors } from './scanDark'
import type { PDFDocumentProxy, PDFPageProxy, PdfjsLibModule, TextItem } from './pdfjs'

/**
 * Colours for Octavo's PDF dark modes (null = render as printed). Shared by the reader and embeds. Applied to
 * the rendered pixels by scanDark (photos kept), never as pdf.js pageColors, which turned photos into negatives.
 */
export function darkScanColors(dark: boolean, mode: string, scanned = false): ScanColors | null {
  if (!dark) return null
  if (mode === 'invert-except-images') return { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, scanned }
  if (mode === 'sepia') return { background: '#2b251c', foreground: '#d8c8a8', photoDim: 0.8, scanned }
  return null
}

interface DocEntry { key: string; doc: Promise<PDFDocumentProxy>; users: number; dropped: boolean }

/**
 * A few open pdf.js documents for note embeds and hover previews, keyed by path and evicted
 * least-recently-used, so a note full of region embeds from one book opens that book once.
 * Users hold a document with `use()`: an evicted document is destroyed only once its last user is done.
 */
export class PdfDocCache {
  private docs = new Map<string, DocEntry>()
  private scanned = new Map<string, boolean>()
  constructor(private app: App, private max = 3) {}

  private acquire(file: TFile): DocEntry {
    const key = `${file.path}:${file.stat.mtime}`
    const hit = this.docs.get(file.path)
    let e: DocEntry
    if (hit && hit.key === key) { this.docs.delete(file.path); this.docs.set(file.path, hit); e = hit } else {
      if (hit) this.drop(file.path)
      const doc = (async () => {
        const lib = await loadPdfJs() as PdfjsLibModule
        return openPdfDocument(lib, this.app.vault.getResourcePath(file), file.stat.size, async () => new Uint8Array(await this.app.vault.readBinary(file)))
      })()
      e = { key, doc, users: 0, dropped: false }
      doc.catch(() => { if (this.docs.get(file.path) === e) this.docs.delete(file.path) })
      this.docs.set(file.path, e)
    }
    e.users++
    while (this.docs.size > this.max) this.drop(this.docs.keys().next().value!)
    return e
  }

  private release(e: DocEntry) {
    e.users = Math.max(0, e.users - 1)
    if (e.dropped && !e.users) this.destroy(e)
  }

  /**
   * Run `fn` with the book's document held open (eviction waits for it). A failure because the document was
   * destroyed anyway (pdf.js worker gone) is retried once on a freshly opened document.
   */
  async use<T>(file: TFile, fn: (pdf: PDFDocumentProxy) => Promise<T>, retry = true): Promise<T> {
    const e = this.acquire(file)
    let held = true
    try {
      return await fn(await e.doc)
    } catch (err) {
      if (!retry || !isDestroyedDocError(err)) throw err
      if (this.docs.get(file.path) === e) this.drop(file.path)
      held = false
      this.release(e)
      return await this.use(file, fn, false)
    } finally {
      if (held) this.release(e)
    }
  }

  /** Is page n mostly a raster scan? pdf.js pageColors can't recolour those, so dark mode inverts them in CSS. */
  async isScanned(file: TFile, page: PDFPageProxy, n: number): Promise<boolean> {
    const k = `${file.path}:${n}`
    if (this.scanned.has(k)) return this.scanned.get(k)!
    const lib = await loadPdfJs() as PdfjsLibModule
    const ops = await page.getOperatorList()
    const vp = page.getViewport({ scale: 1 })
    const s = imageCoverage(ops.fnArray, ops.argsArray, lib.OPS, vp.width, vp.height) >= 0.6
    this.scanned.set(k, s)
    return s
  }

  private drop(path: string) {
    const e = this.docs.get(path)
    this.docs.delete(path)
    if (!e || e.dropped) return
    e.dropped = true
    if (!e.users) this.destroy(e)
  }

  private destroy(e: DocEntry) {
    void e.doc.then(doc => doc.destroy()).catch(() => {})
  }

  clear() { for (const p of [...this.docs.keys()]) this.drop(p); this.scanned.clear() }
}

/**
 * Does this mutation batch add an embed, or re-render a region embed's content (dropping its crop)? Other DOM
 * churn (typing, scrolling, popovers) is ignored, so a busy note isn't rescanned on every keystroke.
 */
export function addsEmbed(muts: readonly MutationRecord[], regionSelector: string): boolean {
  for (const m of muts) for (const n of Array.from(m.addedNodes)) {
    if (n.nodeType !== 1) continue
    const el = n as HTMLElement
    if (el.matches('.internal-embed') || el.querySelector('.internal-embed')) return true
    const host = el.parentElement?.closest<HTMLElement>(regionSelector)
    if (host && !host.querySelector(':scope > .octavo-region-embed')) return true
  }
  return false
}

/** Free a region canvas's backing store now (WebViews keep detached canvases' pixels until GC). */
export function releaseCanvas(c: HTMLCanvasElement) { c.width = 0; c.height = 0 }

export interface Mark { rect: PdfRect; color: string }

/**
 * Render `rect` of a page (or the whole page) into a new canvas `cssWidth` CSS px wide. Marks (PDF rects) are
 * painted over it — used for the quoted selection in hover previews.
 */
export async function renderRegion(page: PDFPageProxy, rect: readonly number[] | null, cssWidth: number, opts: { dark?: ScanColors | null; marks?: Mark[]; dpr?: number; doc?: Document } = {}): Promise<HTMLCanvasElement> {
  const vp1 = page.getViewport({ scale: 1 })
  const box1 = rect ? pdfRectToViewport(vp1.transform, rect) : { x: 0, y: 0, w: vp1.width, h: vp1.height }
  const lim = regionLimits(Platform.isMobile, opts.dpr ?? window.devicePixelRatio ?? 1)
  const plan = regionPlan(box1, cssWidth, lim.dpr, lim.maxPixels)
  const viewport = page.getViewport({ scale: plan.scale, offsetX: plan.offsetX, offsetY: plan.offsetY })
  // Detached: Document.createEl appends to the document itself, which throws. The box that takes it adopts it into its window.
  const canvas = createEl('canvas')
  canvas.width = plan.width; canvas.height = plan.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise
  if (opts.dark && canvas.width && canvas.height) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    recolourScan(img.data, canvas.width, canvas.height, opts.dark)
    ctx.putImageData(img, 0, 0)
  }
  if (opts.marks?.length) {
    ctx.save()
    ctx.globalCompositeOperation = opts.dark ? 'screen' : 'multiply'
    ctx.globalAlpha = opts.dark ? 0.45 : 0.55
    for (const m of opts.marks) {
      const b = pdfRectToViewport(viewport.transform, m.rect)
      ctx.fillStyle = m.color
      ctx.fillRect(b.x, b.y, b.w, b.h)
    }
    ctx.restore()
  }
  canvas.addClass('octavo-region-canvas')
  canvas.setCssProps({ '--octavo-region-w': `${Math.round(plan.cssWidth)}px` }) // CSS: width var, max-width 100%, height auto
  return canvas
}

/** PDF++ selection (textDiv indices + offsets) → PDF rects for preview marks, from the page's text content. */
export async function selectionMarks(page: PDFPageProxy, sel: { beginIndex: number; beginOffset: number; endIndex: number; endOffset: number }, color: string): Promise<Mark[]> {
  const items = (await page.getTextContent()).items.filter((it): it is TextItem => 'str' in it)
  const out: Mark[] = []
  for (let i = sel.beginIndex; i <= sel.endIndex && i < items.length; i++) {
    const it = items[i]
    const len = Math.max(1, it.str.length)
    if (!it.str.trim() || !it.width) continue
    const from = i === sel.beginIndex ? Math.min(1, sel.beginOffset / len) : 0
    const to = i === sel.endIndex ? Math.min(1, sel.endOffset / len) : 1
    if (to > from) out.push({ rect: itemRect(it, from, to), color })
  }
  return out
}
