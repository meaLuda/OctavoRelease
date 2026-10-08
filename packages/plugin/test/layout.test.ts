import { describe, expect, it } from 'vitest'
import { inkBox, cropBox, widen, outside, fitScale, cropScrollLeft, focalScroll, blockZoom, columnAt, resolveLayout, pruneLayouts, useSpread, joinCopiedLines, turnFor } from '../src/pdf/layout'

/** w×h RGBA page of `bg` with ink rectangles [x0,y0,x1,y1) in `fg`. */
function page(w: number, h: number, rects: number[][], bg = [255, 255, 255], fg = [20, 20, 20]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ink = rects.some(([a, b, c, d]) => x >= a! && x < c! && y >= b! && y < d!)
    data.set([...(ink ? fg : bg), 255], (y * w + x) * 4)
  }
  return { data, width: w, height: h }
}

describe('inkBox', () => {
  it('finds the text block inside printed margins', () => {
    const b = inkBox(page(100, 140, [[15, 20, 85, 120]]))!
    expect(b).toEqual({ x0: 0.15, y0: 20 / 140, x1: 0.85, y1: 120 / 140 })
  })
  it('blank page → null', () => expect(inkBox(page(50, 50, []))).toBeNull())
  it('tinted paper: background comes from the corners', () => {
    const b = inkBox(page(100, 100, [[30, 30, 70, 70]], [240, 228, 200], [60, 50, 40]))!
    expect(b.x0).toBeCloseTo(0.3); expect(b.x1).toBeCloseTo(0.7)
  })
  it('a page number in one corner does not become the paper colour', () => {
    const b = inkBox(page(100, 100, [[20, 20, 80, 80], [0, 96, 4, 100]]))!
    expect(b.x0).toBe(0); expect(b.x1).toBeCloseTo(0.8)
  })
})

describe('cropBox / widen', () => {
  it('unions pages and pads, ignoring a full-bleed cover', () => {
    const c = cropBox([{ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0.12, y0: 0.1, x1: 0.85, y1: 0.9 }, { x0: 0.15, y0: 0.08, x1: 0.88, y1: 0.92 }], 0.02)!
    expect(c.x0).toBeCloseTo(0.10); expect(c.x1).toBeCloseTo(0.90)
  })
  it('little to gain or all full-bleed → no crop', () => {
    expect(cropBox([{ x0: 0.02, y0: 0, x1: 0.97, y1: 1 }])).toBeNull()
    expect(cropBox([{ x0: 0, y0: 0, x1: 1, y1: 1 }, null])).toBeNull()
  })
  it('a wider page widens the crop so nothing is cut', () => {
    const crop = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9 }, wide = { x0: 0.1, y0: 0.1, x1: 0.85, y1: 0.9 }
    expect(outside(wide, crop)).toBe(true)
    const w = widen(crop, wide, 0.02)
    expect(w.x0).toBeCloseTo(0.08); expect(w.x1).toBeCloseTo(0.87)
    expect(outside(wide, w)).toBe(false)
  })
})

describe('fit and crop scale math', () => {
  // US letter at scale 1 = 816×1056 CSS px; phone view 390×780
  it('width fit fills the view minus gutters', () => expect(fitScale('width', 816, 1056, 390, 780, 6, null)).toBeCloseTo(378 / 816))
  it('crop makes the content box fill the width', () => {
    const crop = { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.95 }
    const s = fitScale('width', 816, 1056, 390, 780, 6, crop)
    expect(816 * s * 0.8).toBeCloseTo(378)
  })
  it('page fit is limited by height', () => expect(fitScale('page', 816, 1056, 1200, 700, 20, null)).toBeCloseTo(660 / 1056))
  it('crop scroll puts the box edge at the gutter', () => {
    expect(cropScrollLeft(0, 1000, { x0: 0.1, y0: 0, x1: 0.9, y1: 1 }, 6, 390)).toBe(94)
    expect(cropScrollLeft(0, 300, null, 6, 390)).toBe(0)
  })
  it('spread only on wide desktop views at fit', () => {
    const L = resolveLayout(undefined, { crop: false })
    expect(useSpread(L, 1600, false)).toBe(true)
    expect(useSpread(L, 1600, true)).toBe(false)
    expect(useSpread({ ...L, zoom: 2 }, 1600, false)).toBe(false)
    expect(useSpread({ ...L, scroll: 'paged' }, 1600, false)).toBe(false)
  })
})

describe('zoom', () => {
  it('focal point stays under the fingers', () => {
    const before = { sl: 100, st: 2000 }, px = 150, py = 300, k = 2
    const { left, top } = focalScroll(before.sl, before.st, px, py, k)
    // content point under (px,py) before: (250, 2300) → after scaling: (500, 4600), still at (px,py)
    expect(left + px).toBe((before.sl + px) * k)
    expect(top + py).toBe((before.st + py) * k)
  })
  it('block zoom fills the view with the column, clamped', () => {
    expect(blockZoom(180, 390, 6).k).toBeCloseTo(378 / 180)
    expect(blockZoom(180, 390, 6).column).toBe(true)
    expect(blockZoom(370, 390, 6)).toEqual({ k: 2, column: false }) // already fills: 2× around the tap
    expect(blockZoom(null, 390, 6)).toEqual({ k: 2, column: false })
    expect(blockZoom(20, 390, 6).k).toBe(4)
  })
  it('column under the tap on a two-column page', () => {
    const lines = [0, 1, 2, 3].flatMap(i => [
      { left: 20, right: 180, top: 100 + i * 12, bottom: 110 + i * 12 },
      { left: 200, right: 360, top: 100 + i * 12, bottom: 110 + i * 12 },
    ])
    expect(columnAt(lines, 250, 118, 100)).toEqual({ left: 200, right: 360 })
    expect(columnAt(lines, 30, 118, 100)).toEqual({ left: 20, right: 180 })
  })
  it('word-per-span text (OCR) still gives the whole column', () => {
    const words = [0, 1, 2].flatMap(i => [20, 60, 100, 140, 210, 250, 290, 330].map(l => ({ left: l, right: l + 32, top: 100 + i * 12, bottom: 110 + i * 12 })))
    expect(columnAt(words, 75, 112, 100)).toEqual({ left: 20, right: 172 })
    expect(columnAt(words, 300, 112, 100)).toEqual({ left: 210, right: 362 })
  })
})

describe('per-book layout', () => {
  it('defaults: auto fit, vertical, zoom 1; crop from device default', () => {
    expect(resolveLayout(undefined, { crop: true })).toEqual({ fit: 'auto', crop: true, scroll: 'vertical', dir: 'ltr', zoom: 1 })
  })
  it('saved values win and are sanitised', () => {
    expect(resolveLayout({ fit: 'page', crop: false, scroll: 'paged', zoom: 1.7 }, { crop: true })).toEqual({ fit: 'page', crop: false, scroll: 'paged', dir: 'ltr', zoom: 1.7 })
    expect(resolveLayout({ fit: 'bogus' as any, zoom: 99 }, { crop: false })).toMatchObject({ fit: 'auto', zoom: 6 })
  })
  it('keeps the most recent books', () => {
    const map = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`b${i}`, { zoom: 1, t: i }]))
    expect(Object.keys(pruneLayouts(map, 2)).sort()).toEqual(['b3', 'b4'])
  })
})

describe('joinCopiedLines', () => {
  it('joins wrapped lines, keeps paragraph ends and dehyphenates', () => {
    const t = 'The battery carries its energy as fixed\nmass. A generator carries an en-\ngine plus fuel and is lighter.\nNew paragraph starts here and runs\non.'
    expect(joinCopiedLines(t)).toBe('The battery carries its energy as fixed mass. A generator carries an engine plus fuel and is lighter.\nNew paragraph starts here and runs on.')
  })
  it('blank lines and bullets stay breaks', () => {
    expect(joinCopiedLines('one line\n\n• two\n• three')).toBe('one line\n\n• two\n• three')
    expect(joinCopiedLines('via the\nDaraja API.\no Logic Execution: runs')).toBe('via the Daraja API.\no Logic Execution: runs')
  })
})

describe('bleed pages', () => {
  it('a cover image touching one edge does not block the crop', () => {
    const c = cropBox([{ x0: 0, y0: 0, x1: 0.9, y1: 1 }, { x0: 0.094, y0: 0.03, x1: 0.906, y1: 0.97 }])!
    expect(c.x0).toBeCloseTo(0.074); expect(c.x1).toBeCloseTo(0.926)
    expect(outside({ x0: 0, y0: 0, x1: 0.9, y1: 1 }, c)).toBe(false)
  })
})

describe('mixed page sizes', () => {
  it('a landscape page neither sets nor widens a portrait crop', () => {
    const portrait = { x0: 0.081, y0: 0.05, x1: 0.919, y1: 0.95, w: 596, h: 842 }
    const landscape = { x0: 0.037, y0: 0.05, x1: 0.938, y1: 0.95, w: 842, h: 596 }
    const c = cropBox([portrait, landscape, portrait])!
    expect(c.x0).toBeCloseTo(0.061); expect(c.w).toBe(596)
    expect(outside(landscape, c)).toBe(false)
  })
})

describe('paged direction', () => {
  it('left to right: right side / swipe left = next', () => {
    expect(turnFor('right', 'ltr')).toBe(1)
    expect(turnFor('left', 'ltr')).toBe(-1)
  })
  it('right to left mirrors it', () => {
    expect(turnFor('left', 'rtl')).toBe(1)
    expect(turnFor('right', 'rtl')).toBe(-1)
  })
  it('left-handed taps mirror again', () => {
    expect(turnFor('left', 'ltr', true)).toBe(1)
    expect(turnFor('left', 'rtl', true)).toBe(-1)
  })
  it('direction is remembered per book, LTR by default', () => {
    expect(resolveLayout(undefined, { crop: false }).dir).toBe('ltr')
    expect(resolveLayout({ dir: 'rtl' }, { crop: false }).dir).toBe('rtl')
  })
})
