import type { Highlight, HighlightColor } from '../anchor'

export interface ImportedBook {
  /** vault path or filename of the book, when the source records it */
  bookPath?: string
  title?: string
  author?: string
  highlights: Highlight[]
  position?: { cfi?: string; fraction?: number }
  status?: 'want' | 'reading' | 'finished'
  lastRead?: string
}

export type ImportSource = 'annotator' | 'elton' | 'weave' | 'kindle' | 'koreader' | 'readest' | 'epub-plugin'

let n = 0
export const importId = (prefix: string) => `${prefix}${(Date.now() % 1e8).toString(36)}${(n++).toString(36)}`

const NAMED: Record<string, HighlightColor> = {
  yellow: 'yellow', green: 'green', blue: 'blue', pink: 'pink', red: 'pink', purple: 'purple',
  violet: 'purple', orange: 'yellow', gray: 'blue', grey: 'blue', cyan: 'blue', olive: 'green',
}
export function mapColor(c: unknown): HighlightColor {
  if (typeof c !== 'string') return 'yellow'
  const k = c.toLowerCase().trim()
  if (NAMED[k]) return NAMED[k]!
  const m = /^#?([0-9a-f]{6})$/i.exec(k)
  if (m) {
    const v = parseInt(m[1]!, 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255
    if (r > 200 && g > 200 && b < 150) return 'yellow'
    if (g > r && g > b) return 'green'
    if (b > r && b > g) return r > 120 ? 'purple' : 'blue'
    if (r > g && b > g) return r > b + 40 ? 'pink' : 'purple'
    if (r > g) return 'pink'
  }
  return 'yellow'
}

export const toIso = (t: unknown): string => {
  if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t).toISOString()
  if (typeof t === 'string') { const d = new Date(t.replace(' ', 'T')); if (!isNaN(+d)) return d.toISOString() }
  return new Date(0).toISOString()
}
