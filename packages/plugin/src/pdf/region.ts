/**
 * Pure geometry and text for PDF regions (PDF++ `rect=`) and page labels: no pdf.js, no DOM, so it's unit-tested.
 *
 * A pdf.js viewport maps PDF user space (points, origin bottom-left) to viewport pixels (origin top-left)
 * with an affine `transform` [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. It already folds
 * in the scale, rotation and the page's view box, so these helpers are exact for rotated and offset pages
 * (the same maths as pdf.js `convertToPdfPoint` / `convertToViewportRectangle`).
 */
export type M6 = readonly [number, number, number, number, number, number]
export type PdfRect = [number, number, number, number] // left, bottom, right, top (PDF points)
export interface ViewBox { x: number; y: number; w: number; h: number }

export function applyM(m: M6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function invertM(m: M6): M6 {
  const det = m[0] * m[3] - m[1] * m[2]
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[4] * m[3]) / det, (m[4] * m[1] - m[5] * m[0]) / det]
}

/** Two viewport corners (any order, from a drag) → PDF++ rect, rounded to whole points like PDF++. */
export function viewportToPdfRect(transform: M6, x1: number, y1: number, x2: number, y2: number): PdfRect {
  const inv = invertM(transform)
  const pts = [applyM(inv, x1, y1), applyM(inv, x2, y1), applyM(inv, x1, y2), applyM(inv, x2, y2)]
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))]
}

/** PDF rect → the box it covers in a viewport (pixels, top-left origin). */
export function pdfRectToViewport(transform: M6, rect: readonly number[]): ViewBox {
  const [l, b, r, t] = rect as PdfRect
  const pts = [applyM(transform, l, b), applyM(transform, r, b), applyM(transform, l, t), applyM(transform, r, t)]
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/**
 * Render plan for a cropped region: the scale so the region is `cssWidth` CSS px wide at `dpr`, and the
 * viewport offsets that put the region's top-left at the canvas origin (pdf.js getViewport offsetX/Y).
 * `box1` is the region in a scale-1 viewport. The canvas is capped at `maxPixels` (iOS canvas memory).
 */
export function regionPlan(box1: ViewBox, cssWidth: number, dpr: number, maxPixels = 2 ** 24): { scale: number; offsetX: number; offsetY: number; width: number; height: number; cssWidth: number; cssHeight: number } {
  const w = Math.max(1, box1.w), h = Math.max(1, box1.h)
  let scale = (cssWidth * dpr) / w
  if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h))
  return {
    scale, offsetX: -box1.x * scale, offsetY: -box1.y * scale,
    width: Math.max(1, Math.ceil(w * scale)), height: Math.max(1, Math.ceil(h * scale)),
    cssWidth, cssHeight: (cssWidth * h) / w,
  }
}

/** Render limits for region canvases: mobile WebViews kill tabs over ~16 MP of canvas, so phones get 4 MP and dpr ≤ 2. */
export function regionLimits(isMobile: boolean, dpr: number): { dpr: number; maxPixels: number } {
  return { dpr: Math.max(1, Math.min(isMobile ? 2 : 3, dpr || 1)), maxPixels: isMobile ? 2 ** 22 : 2 ** 24 }
}

/** Is this error pdf.js saying its document (or worker) was destroyed under a render? Worth one retry with a fresh document. */
export function isDestroyedDocError(e: unknown): boolean {
  const m = `${(e as { name?: string })?.name ?? ''} ${(e as { message?: string })?.message ?? e ?? ''}`
  return /destroy|terminated|transport|worker was|loading aborted|AbortException/i.test(m)
}

/** Clamp a drag (page-relative px) to the page and order its corners; null when it's too small to be meant. */
export function dragBox(x0: number, y0: number, x1: number, y1: number, pageW: number, pageH: number, min = 6): { x: number; y: number; w: number; h: number } | null {
  const cx = (v: number) => Math.max(0, Math.min(pageW, v)), cy = (v: number) => Math.max(0, Math.min(pageH, v))
  const ax = cx(Math.min(x0, x1)), bx = cx(Math.max(x0, x1)), ay = cy(Math.min(y0, y1)), by = cy(Math.max(y0, y1))
  if (bx - ax < min || by - ay < min) return null
  return { x: ax, y: ay, w: bx - ax, h: by - ay }
}

// ───────────────────────── page labels ─────────────────────────

/** The printed page label for physical page n (1-based), or the number itself when the PDF has none. */
export function pageLabel(labels: readonly (string | null | undefined)[] | null | undefined, n: number): string {
  const l = labels?.[n - 1]
  return typeof l === 'string' && l.trim() ? l.trim() : String(n)
}

/** True when the printed label differs from the physical page number (e.g. "xii" on pdf page 12). */
export function hasOwnLabel(labels: readonly (string | null | undefined)[] | null | undefined, n: number): boolean {
  return pageLabel(labels, n) !== String(n)
}

/** Footer: "Page 42 (pdf 58) of 300" when the book prints its own numbers, else "Page 58 of 300". */
export function footerPage(labels: readonly (string | null | undefined)[] | null | undefined, n: number, total: number): string {
  return hasOwnLabel(labels, n) ? `Page ${pageLabel(labels, n)} (pdf ${n}) of ${total}` : `Page ${n} of ${total}`
}

/** Short reference for link aliases and highlight labels: "p. xii". */
export function pageRef(labels: readonly (string | null | undefined)[] | null | undefined, n: number): string {
  return `p. ${pageLabel(labels, n)}`
}

/**
 * "Go to page" input → physical page. A printed label wins (as in pdf.js and Acrobat), then a plain number;
 * null when neither exists.
 */
export function resolvePageInput(labels: readonly (string | null | undefined)[] | null | undefined, input: string, total: number): number | null {
  const q = input.trim().toLowerCase()
  if (!q) return null
  if (labels) {
    const i = labels.findIndex(l => typeof l === 'string' && l.trim().toLowerCase() === q)
    if (i >= 0) return i + 1
  }
  const n = Number(q)
  return Number.isInteger(n) && n >= 1 && n <= total ? n : null
}

/** pdf.js text-content item → its box in PDF space (unrotated text; good enough to mark a quote in a preview). */
export function itemRect(item: { transform: number[]; width: number; height: number }, from = 0, to = 1): PdfRect {
  const [a, b, , , e, f] = item.transform as [number, number, number, number, number, number]
  const h = item.height || Math.hypot(a, b)
  const x0 = e + item.width * from, x1 = e + item.width * to
  return [x0, f - h * 0.25, x1, f + h * 0.85]
}
