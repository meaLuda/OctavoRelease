import type { Highlight, HighlightColor } from '../anchor'

export interface ImportedBook {
  /** vault path or filename of the book, when the source records it */
  bookPath?: string
  title?: string
  author?: string
  /** Zotero / Better BibTeX citekey, kept on the book note */
  citekey?: string
  highlights: Highlight[]
  position?: { cfi?: string; fraction?: number }
  status?: 'want' | 'reading' | 'finished'
  lastRead?: string
}

export type ImportSource = 'annotator' | 'elton' | 'weave' | 'kindle' | 'koreader' | 'readest' | 'zotero' | 'epub-plugin'

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
  // "2025-02-03 10:11:12" (KOReader) needs a T; free-form dates ("8 January 2024 21:14:03", Kindle) must be parsed as-is
  if (typeof t === 'string') { const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(t) ? t.replace(' ', 'T') : t); if (!isNaN(+d)) return d.toISOString() }
  return new Date(0).toISOString()
}

/** What is at a vault path: nothing, a book note (Octavo's, or a note it created for an imported book), or any other note. */
export type NoteKind = 'missing' | 'book' | 'other'

/**
 * The note that receives imported highlights for a book that isn't in the vault: `<folder>/<title>.md`, else
 * `<folder>/<title> (<source>).md`. An existing note is reused only when it is a book note, so highlights never
 * land in another plugin's note (e.g. the Zotero literature note they were imported from). Null: skip the book.
 */
export function importNotePath(folder: string, title: string, source: string, kindAt: (path: string) => NoteKind): string | null {
  const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Imported book'
  const dir = folder.replace(/^\/+|\/+$/g, '')
  const at = (name: string) => `${dir ? `${dir}/` : ''}${name}.md`
  for (const p of [at(safe), at(`${safe} (${source})`)]) if (kindAt(p) !== 'other') return p
  return null
}
