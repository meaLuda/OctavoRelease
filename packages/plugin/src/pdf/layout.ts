/** PDF page layout math: fit modes, margin crop, zoom focal point, per-book layout. Pure, so it's unit-tested. */

export type PdfFit = 'auto' | 'width' | 'page'
export type PdfScroll = 'vertical' | 'paged'
/** Reading direction for paged mode: which side is "next" (right-to-left for Arabic, Hebrew, manga). */
export type PdfDir = 'ltr' | 'rtl'
/** Content box as fractions of the page (0..1), y down; `w`×`h` = the page size (pt) it applies to. */
export interface Box { x0: number; y0: number; x1: number; y1: number; w?: number; h?: number }

/** Same page size (±2%)? A crop only applies to pages shaped like the ones it was measured on. */
export const sameSize = (a: { w?: number; h?: number }, b: { w?: number; h?: number }) =>
  !a.w || !b.w || (Math.abs(a.w - b.w) <= a.w * 0.02 && Math.abs((a.h ?? 0) - (b.h ?? 0)) <= (a.h ?? 0) * 0.02)

/** What a book remembers (per device: phone and desktop want different zoom). */
export interface PdfBookLayout { fit?: PdfFit; crop?: boolean; scroll?: PdfScroll; dir?: PdfDir; zoom?: number; box?: Box | null; t?: number }
export interface ResolvedLayout { fit: PdfFit; crop: boolean; scroll: PdfScroll; dir: PdfDir; zoom: number }

export function resolveLayout(saved: PdfBookLayout | undefined, defaults: { crop: boolean }): ResolvedLayout {
  const zoom = Number(saved?.zoom)
  return {
    fit: saved?.fit === 'width' || saved?.fit === 'page' ? saved.fit : 'auto',
    crop: typeof saved?.crop === 'boolean' ? saved.crop : defaults.crop,
    scroll: saved?.scroll === 'paged' ? 'paged' : 'vertical',
    dir: saved?.dir === 'rtl' ? 'rtl' : 'ltr',
    zoom: Number.isFinite(zoom) && zoom > 0 ? clampZoom(zoom) : 1,
  }
}

/** Keep the per-book map small: newest `max` entries win. */
export function pruneLayouts(map: Record<string, PdfBookLayout>, max = 300): Record<string, PdfBookLayout> {
  const keys = Object.keys(map)
  if (keys.length <= max) return map
  return Object.fromEntries(keys.sort((a, b) => (map[b]!.t ?? 0) - (map[a]!.t ?? 0)).slice(0, max).map(k => [k, map[k]!]))
}

/**
 * Page step for a tap on a screen side (or a swipe that moves toward it: swiping left = pressing the right side).
 * Left to right: right = next. Right to left mirrors it; the left-handed setting mirrors taps (not swipes).
 */
export function turnFor(side: 'left' | 'right', dir: PdfDir, leftHanded = false): 1 | -1 {
  return ((side === 'right') !== (dir === 'rtl') !== leftHanded) ? 1 : -1
}

export const clampZoom = (z: number) => Math.min(6, Math.max(0.5, z))

/** Auto fills the width (a two-page spread on a wide desktop view is decided by `useSpread`). */
export const effectiveFit = (fit: PdfFit): 'width' | 'page' => fit === 'page' ? 'page' : 'width'

/** Two-page spread: Auto fit, continuous scroll, not zoomed, and each page gets ≥ ~750px. Never on phones. */
export const useSpread = (l: ResolvedLayout, viewW: number, phone: boolean) => l.fit === 'auto' && l.scroll === 'vertical' && l.zoom === 1 && viewW >= 1550 && !phone

/**
 * Ink bounding box of a low-res render. Paper colour comes from the corners (works for tinted pages);
 * a pixel is ink when it differs from paper by more than `threshold` (sum of RGB deltas). Returns null for
 * a blank page. Rows/columns need `minRun` ink pixels so lone specks of scanner dust don't widen the box.
 */
export function inkBox(img: { data: ArrayLike<number>; width: number; height: number }, threshold = 60, minRun = 1): Box | null {
  const { data, width: w, height: h } = img
  if (!w || !h) return null
  const px = (x: number, y: number) => { const i = (y * w + x) * 4; return [data[i]!, data[i + 1]!, data[i + 2]!] as const }
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)]
  // paper = the most common corner colour (a corner may hold a page-number or a bleed image)
  const near = (a: readonly number[], b: readonly number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) <= threshold
  const bg = corners.map(c => ({ c, n: corners.filter(d => near(c, d)).length })).sort((a, b) => b.n - a.n)[0]!.c
  const cols = new Uint32Array(w), rows = new Uint32Array(h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    if (Math.abs(data[i]! - bg[0]) + Math.abs(data[i + 1]! - bg[1]) + Math.abs(data[i + 2]! - bg[2]) > threshold) { cols[x]!++; rows[y]!++ }
  }
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1
  while (x0 < w && cols[x0]! < minRun) x0++
  if (x0 >= w) return null
  while (x1 > x0 && cols[x1]! < minRun) x1--
  while (y0 < h && rows[y0]! < minRun) y0++
  while (y1 > y0 && rows[y1]! < minRun) y1--
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h }
}

/** Full-bleed or edge-touching ink (covers, photos, banners): such pages can't be cropped, so they don't set the crop. */
export const isBleed = (b: Box) => b.x1 - b.x0 >= 0.96 || b.x0 < 0.015 || b.x1 > 0.985

/**
 * One crop box for the whole book (pdf.js shares a scale across pages): the union of the sampled pages'
 * ink boxes plus `pad` (fraction of page width). Full-bleed pages (covers, photos) are left out unless every
 * sample is one (they stay pannable); null means "don't crop".
 */
export function cropBox(boxes: Array<Box | null>, pad = 0.02): Box | null {
  const real = boxes.filter((b): b is Box => !!b)
  const ref = real.find(b => !isBleed(b))
  const narrow = real.filter(b => !isBleed(b) && sameSize(b, ref ?? {}))
  if (!narrow.length) return null
  const u = narrow.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }))
  const box: Box = { x0: Math.max(0, u.x0 - pad), y0: Math.max(0, u.y0 - pad), x1: Math.min(1, u.x1 + pad), y1: Math.min(1, u.y1 + pad), w: ref!.w, h: ref!.h }
  return box.x1 - box.x0 > 0.92 ? null : box // < 8% to gain: not worth panning for
}

/** Grow `crop` so `b` (plus pad) fits; vertical extent too. */
export const widen = (crop: Box, b: Box, pad = 0.02): Box => ({
  ...crop,
  x0: Math.max(0, Math.min(crop.x0, b.x0 - pad)), y0: Math.max(0, Math.min(crop.y0, b.y0 - pad)),
  x1: Math.min(1, Math.max(crop.x1, b.x1 + pad)), y1: Math.min(1, Math.max(crop.y1, b.y1 + pad)),
})

/** Does `b` stick out of `crop` (so the crop must widen to keep content visible)? */
export const outside = (b: Box | null, crop: Box | null) => !!b && !!crop && !isBleed(b) && sameSize(b, crop) && (b.x0 < crop.x0 - 0.002 || b.x1 > crop.x1 + 0.002)

/**
 * pdf.js scale for a fit. `unitW/unitH` = page CSS size at scale 1, `view` = scroll container's inner size,
 * `gutter` = px kept free on each side. With a crop box, the box (not the page) fills the width.
 */
export function fitScale(fit: 'width' | 'page', unitW: number, unitH: number, viewW: number, viewH: number, gutter: number, crop: Box | null): number {
  const cw = crop ? (crop.x1 - crop.x0) : 1
  const sw = Math.max(1, viewW - gutter * 2) / (unitW * cw)
  if (fit === 'width') return sw
  const ch = crop ? (crop.y1 - crop.y0) : 1
  return Math.min(sw, Math.max(1, viewH - gutter * 2) / (unitH * ch))
}

/** Horizontal scroll that puts the crop box's left edge `gutter` px from the view's left edge. */
export const cropScrollLeft = (pageLeft: number, pageW: number, crop: Box | null, gutter: number, viewW: number) =>
  crop ? Math.max(0, pageLeft + crop.x0 * pageW - gutter) : Math.max(0, pageLeft + pageW / 2 - viewW / 2)

/** Scroll offsets that keep the content point under (px, py) — view coordinates — fixed while scaling by k. */
export function focalScroll(scrollLeft: number, scrollTop: number, px: number, py: number, k: number): { left: number; top: number } {
  return { left: Math.max(0, (scrollLeft + px) * k - px), top: Math.max(0, (scrollTop + py) * k - py) }
}

/** Zoom factor (relative to now) that makes a column of width `blockW` px fill the view; 2× around the point when unknown or already full. */
export function blockZoom(blockW: number | null, viewW: number, gutter: number): { k: number; column: boolean } {
  const k = blockW && blockW > 0 ? (viewW - gutter * 2) / blockW : 0
  // the column already (nearly) fills the view: plain 2× around the point instead
  return k >= 1.3 ? { k: Math.min(4, k), column: true } : { k: 2, column: false }
}

/**
 * Column under x. Text-layer spans (often one per word) near the tap are grouped into lines, each line is split
 * into segments at gaps wider than ~1.5 line heights (a column gutter), and the segments under x give the extent.
 * Two-column pages give one column; single-column pages give the text width.
 */
export function columnAt(rects: Array<{ left: number; right: number; top: number; bottom: number }>, x: number, y: number, reach: number): { left: number; right: number } | null {
  const near = rects.filter(r => r.right - r.left > 0.5 && Math.abs((r.top + r.bottom) / 2 - y) <= reach).sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: Array<typeof near> = []
  for (const r of near) {
    const cy = (r.top + r.bottom) / 2, h = r.bottom - r.top
    const line = lines.find(l => Math.abs((l[0]!.top + l[0]!.bottom) / 2 - cy) < Math.min(h, l[0]!.bottom - l[0]!.top) * 0.5)
    if (line) line.push(r); else lines.push([r])
  }
  const hits: Array<{ left: number; right: number }> = []
  for (const l of lines) {
    l.sort((a, b) => a.left - b.left)
    const h = l[0]!.bottom - l[0]!.top
    let seg = { left: l[0]!.left, right: l[0]!.right }
    const segs = [seg]
    for (const r of l.slice(1)) {
      if (r.left - seg.right > h * 1.5) { seg = { left: r.left, right: r.right }; segs.push(seg) } else seg.right = Math.max(seg.right, r.right)
    }
    const hit = segs.find(sg => sg.left - h <= x && sg.right + h >= x)
    if (hit) hits.push(hit)
  }
  if (!hits.length) return null
  // ignore unusually wide segments (a heading spanning both columns)
  const ws = hits.map(r => r.right - r.left).sort((a, b) => a - b)
  const med = ws[Math.floor(ws.length / 2)]!
  const keep = hits.filter(r => r.right - r.left <= med * 1.6)
  return { left: Math.min(...keep.map(r => r.left)), right: Math.max(...keep.map(r => r.right)) }
}

/**
 * Copied PDF text: join the line breaks inside a paragraph, keep paragraph breaks. A line ends a paragraph when
 * it's followed by a blank line, or it ends a sentence and is clearly shorter than the longest line.
 * "exam-\nple" joins as "example" (lowercase continues).
 */
export function joinCopiedLines(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''))
  const longest = Math.max(1, ...lines.map(l => l.trim().length))
  let out = ''
  lines.forEach((line, i) => {
    const t = line.trim()
    if (i === 0) { out = t; return }
    const prev = lines[i - 1]!.trim()
    if (!t) { if (!out.endsWith('\n\n')) out += '\n\n'; return }
    if (!prev) { out += t; return }
    const ends = /[.!?:;"”’)]$/.test(prev) && prev.length < longest * 0.85
    const bullet = /^([•▪◦·\-–—*o\uf0b7]|\d+[.)])\s/.test(t)
    if (ends || bullet) out += '\n' + t
    else if (/[a-z]-$/.test(prev) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t
    else out += ' ' + t
  })
  return out.replace(/\n{3,}/g, '\n\n')
}
