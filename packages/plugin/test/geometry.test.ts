import { describe, expect, it } from 'vitest'
import { mergeLines } from '../src/pdf/geometry'

const R = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h)

describe('mergeLines', () => {
  it('unions fragments on the same line and keeps lines separate', () => {
    const out = mergeLines([R(10, 100, 50, 20), R(62, 101, 80, 19), R(10, 126, 120, 20)])
    expect(out).toHaveLength(2)
    expect(out[0]!.left).toBe(10)
    expect(out[0]!.right).toBeCloseTo(142)
  })
  it('trims tall span boxes so adjacent lines do not overlap', () => {
    const out = mergeLines([R(0, 100, 100, 20), R(0, 98, 40, 34), R(0, 124, 100, 20)])
    expect(out).toHaveLength(2)
    expect(out[0]!.bottom).toBeLessThanOrEqual(out[1]!.top + 0.5)
  })
})

import { pagesToEvict } from '../src/pdf/geometry'
describe('pagesToEvict', () => {
  it('keeps the budget by releasing the farthest pages', () => {
    expect(pagesToEvict([5, 6, 7, 8], 6, 4)).toEqual([])
    expect(pagesToEvict([10, 1, 2, 3, 11, 12], 11, 4).sort((a, b) => a - b)).toEqual([1, 2])
  })
  it('terminates even when every live page is near the current page (old infinite-loop case)', () => {
    expect(pagesToEvict([20, 21, 19, 22, 18, 23], 20, 4)).toHaveLength(2)
  })
})

describe('pagesToEvict with on-screen protection', () => {
  it('never evicts protected (visible) pages, even if far from the anchor page', () => {
    const drop = pagesToEvict([1, 2, 7, 8, 9, 10], 1, 4, new Set([7, 8]))
    expect(drop).not.toContain(7)
    expect(drop).not.toContain(8)
    expect(drop).toHaveLength(2)
  })
  it('may exceed the budget when every live page is visible', () => {
    expect(pagesToEvict([3, 4, 5, 6, 7], 3, 4, new Set([3, 4, 5, 6, 7]))).toEqual([])
  })
})

import { imageCoverage } from '../src/pdf/geometry'
describe('imageCoverage', () => {
  const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6 }
  it('detects a full-page scan even under transforms, and a small figure as not-a-scan', () => {
    expect(imageCoverage([1, 3, 4, 2], [null, [600, 0, 0, 800, 0, 0], null, null], OPS, 612, 792)).toBeGreaterThan(0.95)
    expect(imageCoverage([1, 3, 4, 2], [null, [200, 0, 0, 150, 100, 300], null, null], OPS, 612, 792)).toBeLessThan(0.1)
  })
})
