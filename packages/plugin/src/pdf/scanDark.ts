/**
 * Dark mode for scanned pages. A scan is one picture, so pdf.js pageColors can't tell text from photos and
 * a whole-page invert turns photos into negatives. Here the page is split into tiles: tiles that are mostly
 * paper and ink are recoloured (paper → background, ink → foreground); regions full of mid-tones are photos
 * and keep their colours, slightly dimmed.
 */

export interface ScanColors {
  background: string; foreground: string; photoDim: number
  /** Scanned page: pictures can be printed illustrations whose bare paper should darken. Born-digital pages
   *  keep every picture whole (a bright sky in a photo is not paper). */
  scanned?: boolean
  /** Born-digital page: the exact canvas-pixel boxes of its raster images, from the PDF's own drawing
   *  commands. Used instead of guessing from pixels; each is kept only if it looks like a photo. */
  images?: Box[]
}
export interface Box { x0: number; y0: number; x1: number; y1: number }

const TILE = 24
const BLOCK = 4
const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Pixel boxes of photo regions: connected runs of mid-tone tiles, kept only when large enough to be a picture. */
export function findPhotoBoxes(data: Uint8ClampedArray, w: number, h: number, tile = TILE): Box[] {
  const tw = Math.ceil(w / tile), th = Math.ceil(h / tile)
  const photo = new Uint8Array(tw * th)
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let mid = 0, colour = 0, paper = 0, n = 0
      const yEnd = Math.min(h, (ty + 1) * tile), xEnd = Math.min(w, (tx + 1) * tile)
      for (let y = ty * tile; y < yEnd; y += 2) {
        for (let x = tx * tile; x < xEnd; x += 2) {
          const i = (y * w + x) * 4
          const r = data[i], g = data[i + 1], bl = data[i + 2]
          const l = (r * 299 + g * 587 + bl * 114) / 1000
          if (Math.max(r, g, bl) - Math.min(r, g, bl) > 60) colour++
          else if (l > 60 && l < 195) mid++
          else if (l >= 215) paper++
          n++
        }
      }
      // a photo is mostly mid-tones with little bare paper; dense scanned text has grey edges but lots of
      // paper between letters; a coloured print counts on its colour alone
      if (n && ((mid / n > 0.35 && paper / n < 0.35) || colour / n > 0.3)) photo[ty * tw + tx] = 1
    }
  }
  const seen = new Uint8Array(tw * th), boxes: Box[] = []
  const minTiles = Math.max(6, Math.round((tw * th) * 0.004))
  for (let start = 0; start < photo.length; start++) {
    if (!photo[start] || seen[start]) continue
    let count = 0, bx0 = tw, by0 = th, bx1 = 0, by1 = 0
    const stack = [start]; seen[start] = 1
    while (stack.length) {
      const k = stack.pop()!, x = k % tw, y = (k - x) / tw
      count++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y)
      // neighbours up to two tiles away, so light patches inside a photo don't split it
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue
        const j = ny * tw + nx
        if (photo[j] && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    if (count >= minTiles) boxes.push(trim(data, w, { x0: bx0 * tile, y0: by0 * tile, x1: Math.min(w, (bx1 + 1) * tile), y1: Math.min(h, (by1 + 1) * tile) }))
  }
  return boxes.filter(b => b.x1 > b.x0 && b.y1 > b.y0)
}

/** Shrinks a tile-aligned box to the rows and columns that are really photo, so a caption next to it isn't kept. */
function trim(data: Uint8ClampedArray, w: number, b: Box): Box {
  const midShare = (x0: number, y0: number, x1: number, y1: number) => {
    let mid = 0, n = 0
    const sx = Math.max(1, Math.floor((x1 - x0) / 120)), sy = Math.max(1, Math.floor((y1 - y0) / 120))
    for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) {
      const i = (y * w + x) * 4, l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
      if (l > 60 && l < 195) mid++
      n++
    }
    return n ? mid / n : 0
  }
  const paleShare = (x0: number, y0: number, x1: number, y1: number) => {
    let pale = 0, n = 0
    const sx = Math.max(1, Math.floor((x1 - x0) / 120)), sy = Math.max(1, Math.floor((y1 - y0) / 120))
    for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) {
      const i = (y * w + x) * 4
      if ((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 >= 185) pale++
      n++
    }
    return n ? pale / n : 0
  }
  // an edge strip is "not photo" when it has few mid-tones, or when it's mostly pale paper (a caption band);
  // the pale rule trims at most 10% per side so a bright sky inside a photo is never cut away
  const keep = 0.25, maxPaleY = Math.round((b.y1 - b.y0) * 0.1), maxPaleX = Math.round((b.x1 - b.x0) * 0.1)
  const notPhoto = (x0: number, y0: number, x1: number, y1: number, paleBudget: number) =>
    midShare(x0, y0, x1, y1) < keep || (paleBudget > 0 && paleShare(x0, y0, x1, y1) > 0.6)
  let budget = maxPaleY
  while (b.y1 - b.y0 > 4 && notPhoto(b.x0, b.y1 - 2, b.x1, b.y1, budget)) { b.y1 -= 2; budget -= 2 }
  budget = maxPaleY
  while (b.y1 - b.y0 > 4 && notPhoto(b.x0, b.y0, b.x1, b.y0 + 2, budget)) { b.y0 += 2; budget -= 2 }
  budget = maxPaleX
  while (b.x1 - b.x0 > 4 && notPhoto(b.x1 - 2, b.y0, b.x1, b.y1, budget)) { b.x1 -= 2; budget -= 2 }
  budget = maxPaleX
  while (b.x1 - b.x0 > 4 && notPhoto(b.x0, b.y0, b.x0 + 2, b.y1, budget)) { b.x0 += 2; budget -= 2 }
  // a caption band inside the image: the photo ends at a straight line across the full width, with pale
  // paper and caption text beyond it. Cut at the strongest such line near the top or bottom edge.
  const lum = (x: number, y: number) => { const i = (y * w + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 }
  const edgeShare = (y: number) => {
    let hit = 0, n = 0
    const sx = Math.max(1, Math.floor((b.x1 - b.x0) / 200))
    for (let x = b.x0; x < b.x1; x += sx) { if (Math.abs(lum(x, y) - lum(x, y - 1)) > 25) hit++; n++ }
    return n ? hit / n : 0
  }
  let best = 0, at = -1
  for (let y = b.y1 - 1; y > b.y1 - maxPaleY && y > b.y0 + 1; y--) { const e = edgeShare(y); if (e > best) { best = e; at = y } }
  if (best > 0.5 && paleShare(b.x0, at, b.x1, b.y1) > 0.5) b.y1 = at
  best = 0; at = -1
  for (let y = b.y0 + 1; y < b.y0 + maxPaleY && y < b.y1 - 1; y++) { const e = edgeShare(y); if (e > best) { best = e; at = y } }
  if (best > 0.5 && paleShare(b.x0, b.y0, b.x1, at) > 0.5) b.y0 = at
  return b
}

/** Recolours an RGBA buffer in place. Returns the photo boxes it kept. */
export function recolourScan(data: Uint8ClampedArray, w: number, h: number, colors: ScanColors): Box[] {
  whiteBalance(data, w, h)
  const boxes = colors.images ? colors.images.filter(b => photoLike(data, w, b)).map(b => trim(data, w, { ...b })).filter(b => b.x1 - b.x0 > 8 && b.y1 - b.y0 > 8) : findPhotoBoxes(data, w, h)
  const bg = hex(colors.background), fg = hex(colors.foreground)
  // scans rarely have true black ink or white paper: stretch this page's own ink..paper range to fg..bg
  const [ink, paperL] = levels(data, w, h)
  const lut: Uint8Array[] = [0, 1, 2].map(c => {
    const t = new Uint8Array(256)
    for (let v = 0; v < 256; v++) {
      const k = Math.max(0, Math.min(1, (v - ink) / Math.max(40, paperL - ink)))
      t[v] = Math.round(fg[c] + (bg[c] - fg[c]) * k)
    }
    return t
  })
  const inPhoto = new Uint8Array(w * h)
  for (const b of boxes) for (let y = b.y0; y < b.y1; y++) inPhoto.fill(1, y * w + b.x0, y * w + b.x1)
  const dim = colors.photoDim
  // an illustration printed on the page (lots of bare paper inside its box) gets its paper darkened too,
  // so it sits on the page with no light rectangle; a real photo (little bare paper) is kept whole
  const illustration = boxes.map(b => !!colors.scanned && paperShare(data, w, b) > 0.2)
  if (illustration.some(Boolean)) {
    // an illustration's pale fringes (light petals, leaf tips) spill past its box; widen it so they are
    // treated the same as the rest of the drawing, not cut at a straight seam. Paper in the margin is
    // recoloured by the illustration rule anyway, so the wider box costs nothing.
    const pad = Math.round(Math.min(w, h) * 0.04)
    for (const [k, b] of boxes.entries()) {
      if (!illustration[k]) continue
      // aligned to the 4×4 block grid used by outsidePaper, so no sliver of the area falls outside a block
      const snap = (v: number, up: boolean) => (up ? Math.ceil(v / BLOCK) : Math.floor(v / BLOCK)) * BLOCK
      const x0 = Math.max(0, snap(b.x0 - pad, false)), x1 = Math.min(w, snap(b.x1 + pad, true))
      for (let y = Math.max(0, snap(b.y0 - pad, false)); y < Math.min(h, snap(b.y1 + pad, true)); y++) inPhoto.fill(2, y * w + x0, y * w + x1)
    }
  }
  const reached = illustration.some(Boolean) ? outsidePaper(data, w, h, inPhoto) : null
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    // inside a printed illustration: bare paper and plain black ink (outlines, nearby text) are recoloured
    // like the page; colour and shading are kept
    // only paper connected to the page around the drawing counts as paper: a white petal enclosed by its
    // outline is the same colour as paper but stays white
    const pale = inPhoto[p] === 2
      ? Math.max(reached![((p / w / BLOCK) | 0) * Math.ceil(w / BLOCK) + (((p % w) / BLOCK) | 0)] ? paleness(r, g, b) : 0, inkness(r, g, b))
      : 0
    if (inPhoto[p] && pale < 1) {
      // blend the kept picture pixel toward the page background as it gets closer to bare paper
      const l = Math.round((r * 299 + g * 587 + b * 114) / 1000)
      data[i] = r * dim * (1 - pale) + lut[0][l] * pale
      data[i + 1] = g * dim * (1 - pale) + lut[1][l] * pale
      data[i + 2] = b * dim * (1 - pale) + lut[2][l] * pale
    } else {
      // flip lightness, keep hue: each channel keeps its offset from grey (Zathura's "keephue"), so a green
      // heading stays green and black text becomes light grey
      const l = Math.round((r * 299 + g * 587 + b * 114) / 1000)
      data[i] = lut[0][l] + (r - l); data[i + 1] = lut[1][l] + (g - l); data[i + 2] = lut[2][l] + (b - l)
    }
  }
  return boxes
}

/** 0 for ink or colour, 1 for bare paper, smooth in between. */
function paleness(r: number, g: number, b: number): number {
  const l = (r * 299 + g * 587 + b * 114) / 1000, chroma = Math.max(r, g, b) - Math.min(r, g, b)
  if (chroma > 40) return 0
  return Math.max(0, Math.min(1, (l - 205) / 30))
}

function paperShare(data: Uint8ClampedArray, w: number, b: Box): number {
  let pale = 0, n = 0
  const sx = Math.max(1, Math.floor((b.x1 - b.x0) / 150)), sy = Math.max(1, Math.floor((b.y1 - b.y0) / 150))
  for (let y = b.y0; y < b.y1; y += sy) for (let x = b.x0; x < b.x1; x += sx) {
    const i = (y * w + x) * 4
    if (paleness(data[i], data[i + 1], data[i + 2]) >= 1) pale++
    n++
  }
  return n ? pale / n : 0
}

/**
 * Old or scanned paper is beige or grey, not white. Scale each channel so the page's own paper colour
 * (the brightest common colour) becomes white; then "paper" and "ink" mean the same on every book.
 */
export function whiteBalance(data: Uint8ClampedArray, w: number, h: number) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  const lh = new Uint32Array(256)
  const step = Math.max(1, Math.floor((w * h) / 200000))
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4, l = Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)
    lh[l]++
  }
  // paper level: the 85th percentile of brightness (most of a page is paper)
  let total = 0; for (const c of lh) total += c
  let acc = 0, paperL = 255
  for (let l = 0; l < 256; l++) { acc += lh[l]; if (acc >= total * 0.85) { paperL = l; break } }
  if (paperL < 120) return // a dark page (photo spread, already-dark design): leave it
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4, l = Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)
    if (Math.abs(l - paperL) <= 6) { hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++ }
  }
  const median = (hh: Uint32Array) => { let t = 0; for (const c of hh) t += c; let a = 0; for (let v = 0; v < 256; v++) { a += hh[v]; if (a >= t / 2) return v } return 255 }
  const paper = [median(hist[0]), median(hist[1]), median(hist[2])]
  if (paper.every(v => v >= 250)) return
  const k = paper.map(v => 255 / Math.max(120, v))
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] * k[0]; data[i + 1] = data[i + 1] * k[1]; data[i + 2] = data[i + 2] * k[2]
  }
}

/** 1 for plain dark ink (text, outlines), 0 for colour or mid-tone shading. */
function inkness(r: number, g: number, b: number): number {
  const l = (r * 299 + g * 587 + b * 114) / 1000, chroma = Math.max(r, g, b) - Math.min(r, g, b)
  if (chroma > 40) return 0
  return Math.max(0, Math.min(1, (90 - l) / 30))
}

/** The page's ink level (2nd percentile of brightness) and paper level (85th). */
function levels(data: Uint8ClampedArray, w: number, h: number): [number, number] {
  const lh = new Uint32Array(256)
  const step = Math.max(1, Math.floor((w * h) / 200000))
  let total = 0
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4
    lh[Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)]++; total++
  }
  let acc = 0, ink = 0, paper = 255
  for (let l = 0; l < 256; l++) { acc += lh[l]; if (acc >= total * 0.02) { ink = l; break } }
  acc = 0
  for (let l = 0; l < 256; l++) { acc += lh[l]; if (acc >= total * 0.85) { paper = l; break } }
  // a page with almost no ink (blank, or very light) keeps a normal range
  return [Math.min(ink, 110), Math.max(paper, 160)]
}

/**
 * Inside illustration areas (inPhoto = 2), which 4×4 blocks are pale paper reachable from the page outside
 * the area. Flood fill over pale blocks, starting where the area meets the rest of the page.
 */
function outsidePaper(data: Uint8ClampedArray, w: number, h: number, inPhoto: Uint8Array): Uint8Array {
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK)
  const pale = new Uint8Array(bw * bh), area = new Uint8Array(bw * bh), reached = new Uint8Array(bw * bh)
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const x = Math.min(w - 1, bx * BLOCK + 1), y = Math.min(h - 1, by * BLOCK + 1), p = y * w + x, i = p * 4
    area[by * bw + bx] = inPhoto[p] === 2 ? 1 : 0
    pale[by * bw + bx] = paleness(data[i], data[i + 1], data[i + 2]) >= 0.5 ? 1 : 0
  }
  const stack: number[] = []
  for (let k = 0; k < bw * bh; k++) {
    if (!area[k] || !pale[k]) continue
    const x = k % bw, y = (k - x) / bw
    const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1 || !area[k - 1] || !area[k + 1] || !area[k - bw] || !area[k + bw]
    if (edge) { reached[k] = 1; stack.push(k) }
  }
  while (stack.length) {
    const k = stack.pop()!, x = k % bw
    for (const j of [x > 0 ? k - 1 : -1, x < bw - 1 ? k + 1 : -1, k - bw, k + bw]) {
      if (j < 0 || j >= bw * bh || reached[j] || !area[j] || !pale[j]) continue
      reached[j] = 1; stack.push(j)
    }
  }
  return reached
}

/** A raster image is a photo (kept) when it is mostly mid-tones or colour; line art (mostly paper and ink) is recoloured. */
function photoLike(data: Uint8ClampedArray, w: number, b: Box): boolean {
  let pic = 0, n = 0
  const sx = Math.max(1, Math.floor((b.x1 - b.x0) / 150)), sy = Math.max(1, Math.floor((b.y1 - b.y0) / 150))
  for (let y = b.y0; y < b.y1; y += sy) for (let x = b.x0; x < b.x1; x += sx) {
    const i = (y * w + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2]
    const l = (r * 299 + g * 587 + bl * 114) / 1000
    if ((l > 60 && l < 195) || Math.max(r, g, bl) - Math.min(r, g, bl) > 60) pic++
    n++
  }
  return n > 0 && pic / n > 0.3
}
