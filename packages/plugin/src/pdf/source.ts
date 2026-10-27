/**
 * Open a PDF without reading it all into memory: Obsidian's resource URLs
 * honour HTTP Range requests, so pdf.js fetches only the pages it needs
 * (huge scanned books stay cheap — essential on phones). Falls back to a
 * full read when ranges aren't honoured (probed once per URL).
 */
import type { PDFDocumentProxy, PdfjsLibModule, PdfjsViewerModule } from './pdfjs'

/** Assets Obsidian bundles with its pdf.js: CJK cmaps, standard fonts, JPX/JBIG2 decoders. */
export const PDF_ASSETS = { cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/lib/pdfjs/standard_fonts/', wasmUrl: '/lib/pdfjs/wasm/', iccUrl: '/lib/pdfjs/iccs/' }


/**
 * pdf.js core + viewer components bundled with Obsidian. `loadPdfJs()` only loads the
 * core; the viewer module (`PDFViewer`, `EventBus`, …) is the same file Obsidian's own
 * PDF view loads lazily — module scripts execute once per URL, so this never conflicts.
 */
export async function ensurePdfjs(loadPdfJs: () => Promise<PdfjsLibModule>): Promise<{ lib: PdfjsLibModule; viewer: PdfjsViewerModule }> {
  const lib = await loadPdfJs()
  let mod: PdfjsViewerModule | null = null
  // Obsidian's own pdf.js viewer module, shipped inside the app (never fetched from the network).
  // @ts-expect-error -- served by Obsidian at runtime; marked external in esbuild.config.mjs, so it has no type declarations
  if (!window.pdfjsViewer) mod = await import('/lib/pdfjs/pdf.viewer.min.mjs') as PdfjsViewerModule
  return { lib, viewer: (window.pdfjsViewer ?? mod)! }
}

export async function openPdfDocument(pdfjs: PdfjsLibModule, url: string, size: number, fallback: () => Promise<Uint8Array>): Promise<PDFDocumentProxy> {
  if (size > 4 * 1024 * 1024 && pdfjs.PDFDataRangeTransport && (await rangesWork(url))) {
    const head = new Uint8Array(await (await rangeFetch(url, `bytes=0-${65535}`)).arrayBuffer())
    class Transport extends pdfjs.PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        rangeFetch(url, `bytes=${begin}-${end - 1}`)
          .then(r => r.arrayBuffer())
          .then(buf => this.onDataRange(begin, new Uint8Array(buf)))
          .catch(e => console.warn('Octavo: range read failed', e))
      }
    }
    const transport = new Transport(size, head)
    return pdfjs.getDocument({ ...PDF_ASSETS, range: transport, length: size, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true, isEvalSupported: false }).promise
  }
  return pdfjs.getDocument({ ...PDF_ASSETS, data: await fallback(), isEvalSupported: false, disableAutoFetch: true }).promise
}

/**
 * A byte-range read of a local vault resource URL (app://…, never the network). This is the one place Octavo
 * uses fetch: requestUrl can't serve it, as it neither reads app:// resource URLs nor returns partial content.
 */
export const rangeFetch = (url: string, range: string) => fetch(url, { headers: { Range: range } })

const probed = new Map<string, boolean>()
async function rangesWork(url: string): Promise<boolean> {
  const key = url.split('?')[0]
  if (probed.has(key)) return probed.get(key)!
  let ok = false
  try {
    const r = await rangeFetch(url, 'bytes=100-1123')
    ok = (await r.arrayBuffer()).byteLength === 1024
  } catch { ok = false }
  probed.set(key, ok)
  return ok
}
