/** One rect per visual line: union rects whose vertical centres are close, then trim to the line's median height. */
export function mergeLines(rects: DOMRect[]): DOMRect[] {
  const lines: DOMRect[][] = []
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const cy = r.top + r.height / 2
    const line = lines.find(l => { const f = l[0]!; return Math.abs(f.top + f.height / 2 - cy) < Math.min(f.height, r.height) * 0.5 })
    if (line) line.push(r); else lines.push([r])
  }
  const merged = lines.map(l => {
    const hs = l.map(r => r.height).sort((a, b) => a - b)
    const h = hs[Math.floor((hs.length - 1) / 2)]! // lower median: tall span boxes don't win
    const cy = l.reduce((a, r) => a + r.top + r.height / 2, 0) / l.length
    const left = Math.min(...l.map(r => r.left)), right = Math.max(...l.map(r => r.right))
    return new DOMRect(left, cy - h / 2, right - left, h)
  }).sort((a, b) => a.top - b.top)
  // never let neighbouring lines overlap: split any overlap at the midpoint
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1]!, b = merged[i]!
    if (a.bottom > b.top) {
      const mid = (a.bottom + b.top) / 2
      merged[i - 1] = new DOMRect(a.left, a.top, a.width, mid - a.top)
      merged[i] = new DOMRect(b.left, mid, b.width, b.bottom - mid)
    }
  }
  return merged
}

/** Pages to release so at most `max` stay live: the farthest from `current` go first. Pure, so it can't loop. */
export function pagesToEvict(live: number[], current: number, max: number, protect: ReadonlySet<number> = new Set()): number[] {
  if (live.length <= max) return []
  const candidates = live.filter(p => !protect.has(p))
  return candidates.sort((a, b) => Math.abs(b - current) - Math.abs(a - current) || b - a).slice(0, Math.max(0, live.length - max))
}

/**
 * Largest fraction of the page covered by a single raster image, from pdf.js's
 * operator list. ≥0.6 means "a scan" (even if OCR text sits on top), which
 * pdf.js pageColors can't recolour — dark mode inverts those pages instead.
 */
type M6 = [number, number, number, number, number, number]
const mul = (a: M6, b: M6): M6 => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
export function imageCoverage(fnArray: number[], argsArray: any[], OPS: Record<string, number>, pageW: number, pageH: number): number {
  let ctm: M6 = [1, 0, 0, 1, 0, 0]
  const stack: M6[] = []
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter(x => x !== undefined))
  let best = 0
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (fn === OPS.transform) ctm = mul(ctm, args as M6)
    else if (fn === OPS.paintFormXObjectBegin && args?.[0]) { stack.push(ctm); ctm = mul(ctm, args[0] as M6) }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (imageOps.has(fn!)) {
      const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3])
      best = Math.max(best, Math.min(1, (w * h) / (pageW * pageH)))
    }
  }
  return best
}
