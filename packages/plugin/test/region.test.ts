import { describe, expect, it } from 'vitest'
import { viewportToPdfRect, pdfRectToViewport, regionPlan, dragBox, pageLabel, footerPage, pageRef, hasOwnLabel, resolvePageInput, invertM, applyM, itemRect, type M6 } from '../src/pdf/region'

// pdf.js viewport transforms for a US-letter page (viewBox 0 0 612 792)
const letter = (s: number): M6 => [s, 0, 0, -s, 0, 792 * s] // rotation 0
const letter90 = (s: number): M6 => [0, s, s, 0, 0, 0] // rotation 90

describe('region rect conversion (PDF++ left,bottom,right,top)', () => {
  it('maps a drag at scale 1.5 to PDF points with a bottom-left origin', () => {
    // a drag from (108, 135) to (810, 541.5) viewport px = (72, 90)…(540, 361) at scale 1
    expect(viewportToPdfRect(letter(1.5), 810, 541.5, 108, 135)).toEqual([72, 431, 540, 702])
  })

  it('round-trips PDF rect → viewport → PDF rect', () => {
    const rect = [72, 431, 540, 702] as const
    for (const m of [letter(1), letter(2.25), letter90(1.3)]) {
      const b = pdfRectToViewport(m, rect)
      expect(viewportToPdfRect(m, b.x, b.y, b.x + b.w, b.y + b.h)).toEqual([...rect])
    }
  })

  it('handles a view box with a non-zero origin', () => {
    const m: M6 = [1, 0, 0, -1, -10, 802] // viewBox 10 10 622 802
    expect(viewportToPdfRect(m, 0, 0, 100, 100)).toEqual([10, 702, 110, 802])
  })

  it('inverts the affine transform', () => {
    const m = letter(1.7), [x, y] = applyM(m, 33, 44)
    const back = applyM(invertM(m), x, y)
    expect(back[0]).toBeCloseTo(33); expect(back[1]).toBeCloseTo(44)
  })

  it('plans a cropped render with offsets that move the region to the origin', () => {
    const box1 = pdfRectToViewport(letter(1), [72, 431, 540, 702]) // x 72, y 90, w 468, h 271
    expect(box1).toEqual({ x: 72, y: 90, w: 468, h: 271 })
    const p = regionPlan(box1, 468, 2)
    expect(p.scale).toBe(2); expect(p.offsetX).toBe(-144); expect(p.offsetY).toBe(-180)
    expect([p.width, p.height]).toEqual([936, 542])
    expect(p.cssHeight).toBeCloseTo(271)
  })

  it('caps the canvas size', () => {
    const p = regionPlan({ x: 0, y: 0, w: 612, h: 792 }, 6000, 2, 1_000_000)
    expect(p.width * p.height).toBeLessThanOrEqual(1_002_000)
  })

  it('clamps and orders a drag, ignoring tiny ones', () => {
    expect(dragBox(300, 50, -20, 400, 600, 300)).toEqual({ x: 0, y: 50, w: 300, h: 250 })
    expect(dragBox(10, 10, 13, 40, 600, 800)).toBeNull()
  })

  it('boxes a text item for preview marks', () => {
    expect(itemRect({ transform: [10, 0, 0, 10, 100, 500], width: 50, height: 10 }, 0, 0.5)).toEqual([100, 497.5, 125, 508.5])
  })
})

describe('page labels', () => {
  const labels = ['i', 'ii', 'iii', '1', '2', '', null as any]
  it('uses the printed label, else the physical number', () => {
    expect(pageLabel(labels, 2)).toBe('ii')
    expect(pageLabel(labels, 6)).toBe('6')
    expect(pageLabel(null, 9)).toBe('9')
    expect(hasOwnLabel(labels, 4)).toBe(true)
    expect(hasOwnLabel(['1', '2'], 2)).toBe(false)
  })
  it('formats the footer and link references', () => {
    expect(footerPage(labels, 5, 300)).toBe('Page 2 (pdf 5) of 300')
    expect(footerPage(null, 58, 300)).toBe('Page 58 of 300')
    expect(pageRef(labels, 3)).toBe('p. iii')
  })
  it('resolves "go to page" input: label first, then number', () => {
    expect(resolvePageInput(labels, 'III', 7)).toBe(3)
    expect(resolvePageInput(labels, '2', 7)).toBe(5)
    expect(resolvePageInput(labels, '6', 7)).toBe(6)
    expect(resolvePageInput(null, '99', 7)).toBeNull()
    expect(resolvePageInput(null, 'x', 7)).toBeNull()
  })
})
