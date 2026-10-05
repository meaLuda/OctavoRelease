/**
 * PDF → reflowable text ("Text view"). Heuristics follow common practice
 * (Chromium's PDF accessibility tree, pdf-to-markdown tools): median font size
 * and line spacing per page; headings ≈ ≥1.2× median size; paragraph breaks on
 * larger gaps or indentation; hyphenated line ends rejoined; page numbers dropped.
 */
export interface RawItem { str: string; transform: number[]; width: number; height?: number; hasEOL?: boolean; fontName?: string }
export interface Block { type: 'h' | 'p'; text: string; size: number; top?: number; bottom?: number }

interface Line { text: string; y: number; x0: number; x1: number; size: number; font?: string; sizeChars?: Map<number, number> }

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]!
}

export function toLines(items: RawItem[]): Line[] {
  const lines: Line[] = []
  let cur: Line | null = null
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue
    const [a, b, , , e, f] = it.transform as [number, number, number, number, number, number]
    const size = Math.hypot(a, b) || it.height || 10
    const x = e, y = f
    if (cur && Math.abs(cur.y - y) < size * 0.5 && x >= cur.x0 - size) {
      const gap = x - cur.x1
      cur.text += (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str
      cur.x1 = Math.max(cur.x1, x + it.width)
      cur.sizeChars!.set(Math.round(size * 2) / 2, (cur.sizeChars!.get(Math.round(size * 2) / 2) ?? 0) + it.str.length)
    } else if (it.str.trim()) {
      cur = { text: it.str, y, x0: x, x1: x + it.width, size, font: it.fontName, sizeChars: new Map([[Math.round(size * 2) / 2, it.str.length]]) }
      lines.push(cur)
    }
    if (it.hasEOL) cur = null
  }
  // a line's size = the size carrying most of its characters (a drop cap doesn't make a heading)
  return lines.map(l => ({ ...l, size: [...l.sizeChars!.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? l.size, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text)
}

export function reflow(items: RawItem[]): Block[] {
  let lines = toLines(items)
  // drop page numbers / lone running numbers at the very top or bottom
  lines = lines.filter((l, i) => !((i === 0 || i === lines.length - 1) && /^[\divxlcIVXLC\s.\-–—]{1,8}$/.test(l.text)))
  if (!lines.length) return []
  const bodySize = median(lines.map(l => l.size))
  const gaps = lines.slice(1).map((l, i) => lines[i]!.y - l.y).filter(g => g > 0 && g < bodySize * 4)
  const lineGap = median(gaps) || bodySize * 1.3
  const left = median(lines.filter(l => Math.abs(l.size - bodySize) < 0.5).map(l => l.x0))
  const right = Math.max(...lines.map(l => l.x1))
  // body font = the font carrying the most characters
  const fontChars = new Map<string, number>()
  for (const l of lines) if (l.font) fontChars.set(l.font, (fontChars.get(l.font) ?? 0) + l.text.length)
  const bodyFont = [...fontChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const width = right - left
  const blocks: Block[] = []
  let para: Line[] = []
  const flush = () => {
    if (!para.length) return
    let text = ''
    for (const l of para) {
      if (!text) text = l.text
      else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text // re-join hyphenated word
      else text += ' ' + l.text
    }
    blocks.push({ type: 'p', text, size: bodySize, top: para[0]!.y + para[0]!.size, bottom: para[para.length - 1]!.y })
    para = []
  }
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    const short = l.x1 - l.x0 < width * 0.6 && l.text.length < 80 && !/[.,;:]$/.test(l.text)
    const centred = Math.abs((l.x0 + l.x1) / 2 - (left + right) / 2) < bodySize * 2 && l.x0 > left + bodySize * 2
    const otherFont = !!bodyFont && !!l.font && l.font !== bodyFont
    const heading = (l.size >= bodySize * 1.2 && l.text.length < 140) || (short && (otherFont || centred) && !/^\d+[.)]\s/.test(l.text))
    if (heading) {
      flush()
      const last = blocks[blocks.length - 1]
      // multi-line headings: same size, consecutive
      if (last?.type === 'h' && prev && Math.abs(prev.size - l.size) < 0.5 && prev.y - l.y < l.size * 1.8) { last.text += ' ' + l.text; last.bottom = l.y }
      else blocks.push({ type: 'h', text: l.text, size: l.size, top: l.y + l.size, bottom: l.y })
      return
    }
    if (prev && para.length) {
      const gap = prev.y - l.y
      const bigGap = gap > lineGap * 1.4 || gap < 0
      const indented = l.x0 > left + bodySize * 1.2
      const prevShort = prev.x1 < right - bodySize * 4 && /[.!?:"”’)]$/.test(prev.text)
      if (bigGap || (indented && prevShort) || (indented && gap > lineGap * 1.15)) flush()
    }
    para.push(l)
  })
  flush()
  return blocks
}

/**
 * Vertical bands of the page (PDF units, y up) that hold no text but are tall enough
 * to contain a figure: gaps between text blocks, plus the space above the first and
 * below the last block. Callers crop these from the rendered page and keep only bands
 * that actually contain ink.
 */
export function figureBands(blocks: Block[], pageH: number, minHeight: number): Array<{ top: number; bottom: number }> {
  const spans = blocks.filter(b => b.top !== undefined && b.bottom !== undefined).map(b => ({ top: b.top!, bottom: b.bottom! }))
    .sort((a, b) => b.top - a.top)
  const bands: Array<{ top: number; bottom: number }> = []
  let cursor = pageH
  for (const s of spans) {
    if (cursor - s.top >= minHeight) bands.push({ top: cursor, bottom: s.top })
    cursor = Math.min(cursor, s.bottom - 2)
  }
  if (cursor >= minHeight) bands.push({ top: cursor, bottom: 0 })
  return bands
}

/** A paragraph cut by a page break: previous block doesn't end a sentence and the next starts lowercase. */
export function continues(prevText: string, nextText: string): boolean {
  return !/[.!?:"”’)\]]\s*$/.test(prevText.trim()) && /^[a-z(“"‘']/.test(nextText.trim())
}
