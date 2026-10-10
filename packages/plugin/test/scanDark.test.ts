import { describe, expect, it } from 'vitest'
import { findPhotoBoxes, recolourScan } from '../src/pdf/scanDark'

/** A white 480×480 "scan" with black text lines on top and a mid-grey noisy photo at the bottom right. */
function page() {
  const w = 480, h = 480, d = new Uint8ClampedArray(w * h * 4).fill(255)
  const set = (x: number, y: number, v: number) => { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v }
  for (let line = 0; line < 6; line++) for (let y = 20 + line * 30; y < 30 + line * 30; y++) for (let x = 20; x < 440; x++) if (x % 7 < 4) set(x, y, 0)
  for (let y = 260; y < 460; y++) for (let x = 200; x < 460; x++) set(x, y, 80 + ((x * 31 + y * 17) % 90))
  return { w, h, d }
}

describe('dark mode for scanned pages', () => {
  it('finds the photo and ignores text', () => {
    const { w, h, d } = page()
    const boxes = findPhotoBoxes(d, w, h)
    expect(boxes).toHaveLength(1)
    const b = boxes[0]!
    expect(b.x0).toBeLessThanOrEqual(200); expect(b.x1).toBeGreaterThanOrEqual(456)
    expect(b.y0).toBeLessThanOrEqual(264); expect(b.y0).toBeGreaterThan(200)
  })

  it('recolours paper and ink, keeps the photo (dimmed, not inverted)', () => {
    const { w, h, d } = page()
    const before = d[(300 * w + 300) * 4]!
    recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, scanned: true })
    expect(d[(5 * w + 5) * 4]).toBe(0x1e)            // paper → dark background
    expect(d[(22 * w + 21) * 4]).toBe(0xd6)          // ink → light text
    expect(d[(300 * w + 300) * 4]).toBe(Math.floor(before * 0.85)) // photo pixel dimmed, same tone
  })

  it('a page of plain text has no photo boxes', () => {
    const w = 240, h = 240, d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 10; y < 230; y += 12) for (let x = 10; x < 230; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0 }
    expect(findPhotoBoxes(d, w, h)).toEqual([])
  })
})

describe('old paper and printed illustrations', () => {
  it('beige paper becomes the page background, not a kept "photo" box', () => {
    const w = 480, h = 480, d = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < d.length; i += 4) { d[i] = 222; d[i + 1] = 208; d[i + 2] = 186; d[i + 3] = 255 }
    for (let y = 40; y < 440; y += 14) for (let y2 = y; y2 < y + 6; y2++) for (let x = 30; x < 450; x++) if (x % 9 < 5) { const i = (y2 * w + x) * 4; d[i] = 40; d[i + 1] = 35; d[i + 2] = 30 }
    const boxes = recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, scanned: true })
    expect(boxes).toEqual([])
    expect(d[(10 * w + 10) * 4]).toBe(0x1e)
  })

  it('a coloured illustration on paper keeps its colours and loses its paper rectangle', () => {
    const w = 480, h = 480, d = new Uint8ClampedArray(w * h * 4).fill(255)
    // red petals scattered across a 240px area, with bare paper between them
    for (let y = 120; y < 360; y++) for (let x = 120; x < 360; x++) if (((x / 30) | 0) % 2 === ((y / 30) | 0) % 2) { const i = (y * w + x) * 4; d[i] = 200; d[i + 1] = 40; d[i + 2] = 40 }
    const boxes = recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, scanned: true })
    expect(boxes.length).toBe(1)
    const petal = (125 * w + 125) * 4, gap = (125 * w + 155) * 4
    expect(d[petal]! > d[petal + 1]! + 60).toBe(true)  // still red
    expect(d[gap]).toBe(0x1e)                            // paper inside the box is dark, no light rectangle
  })
})

describe('white parts of an illustration', () => {
  it('a white petal enclosed by its outline stays white; open paper around it goes dark', () => {
    const w = 480, h = 480, d = new Uint8ClampedArray(w * h * 4).fill(255)
    // a green leaf mass with a white petal (ringed by green) in its middle
    for (let y = 120; y < 360; y++) for (let x = 120; x < 360; x++) {
      const i = (y * w + x) * 4, inPetal = x > 200 && x < 280 && y > 200 && y < 280
      if (!inPetal && ((((x / 20) | 0) + ((y / 20) | 0)) % 3 !== 0 || (x > 190 && x < 290 && y > 190 && y < 290))) { d[i] = 60; d[i + 1] = 150; d[i + 2] = 60 }
    }
    recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, scanned: true })
    expect(d[(240 * w + 240) * 4]!).toBeGreaterThan(180) // petal still light
    expect(d[(20 * w + 20) * 4]).toBe(0x1e)               // page paper dark
  })
})

describe('born-digital pages use the PDF image boxes', () => {
  it('keeps each photo box exactly and recolours the paper gap between two photos', () => {
    const w = 480, h = 480, d = new Uint8ClampedArray(w * h * 4).fill(255)
    const photo = (x0: number, x1: number) => { for (let y = 100; y < 300; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 80 + ((x * 13 + y * 7) % 100) } }
    photo(40, 200); photo(230, 440)
    const before = d[(150 * w + 100) * 4]!
    const kept = recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, images: [{ x0: 40, y0: 100, x1: 200, y1: 300 }, { x0: 230, y0: 100, x1: 440, y1: 300 }] })
    expect(kept).toHaveLength(2)
    expect(d[(150 * w + 215) * 4]).toBe(0x1e)                       // gap between the photos: page background
    expect(d[(150 * w + 100) * 4]).toBe(Math.floor(before * 0.85))  // photo kept
  })
  it('an image of line art is recoloured, not kept as a white rectangle', () => {
    const w = 200, h = 200, d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 20; y < 180; y += 10) for (let x = 20; x < 180; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0 }
    const kept = recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, images: [{ x0: 10, y0: 10, x1: 190, y1: 190 }] })
    expect(kept).toEqual([])
    expect(d[(25 * w + 25) * 4]).toBe(0x1e)
  })
})

describe('colour text', () => {
  it('a green heading stays green after the lightness flip', () => {
    const w = 100, h = 100, d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 10; y < 20; y++) for (let x = 10; x < 90; x++) { const i = (y * w + x) * 4; d[i] = 60; d[i + 1] = 170; d[i + 2] = 60 }
    recolourScan(d, w, h, { background: '#1e1e1e', foreground: '#d6d6d6', photoDim: 0.85, images: [] })
    const i = (15 * w + 50) * 4
    expect(d[i + 1]! - d[i]!).toBeGreaterThan(80)  // still clearly green
  })
})
