import { describe, expect, it } from 'vitest'
import { warm } from '../src/reader/appearance'
import { THEMES } from '../src/reader/themes'

describe('night light', () => {
  it('warms each theme but keeps them distinct', () => {
    const lum = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
    const dist = (a: string, b: string) => Math.hypot(...lum(a).map((v, i) => v - lum(b)[i]!))
    const paper = THEMES.paper.light.bg, calm = THEMES.calm.light.bg, orig = THEMES.original.light.bg
    expect(dist(warm(paper, 1), warm(calm, 1))).toBeGreaterThan(dist(paper, calm) * 0.8)
    expect(dist(warm(orig, 1), warm(paper, 1))).toBeGreaterThan(10)
    const [r, , b] = lum(warm(orig, 1)); expect(r! - b!).toBeGreaterThan(30) // visibly warmer
    expect(warm(orig, 0)).toBe(orig)
  })
})
