/** Where a highlight lives. Every highlight stores the superset needed to re-anchor it. */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']
export type HighlightStyle = 'highlight' | 'underline'

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

export interface PdfSelection {
  page: number // 1-based
  beginIndex: number
  beginOffset: number
  endIndex: number
  endOffset: number
}

export interface Anchor {
  /** EPUB CFI (reflowable books) */
  cfi?: string
  /** PDF position (PDF++-compatible text-layer indices) */
  pdf?: PdfSelection
  quote: TextQuote
}

export interface Highlight {
  id: string
  anchor: Anchor
  color: HighlightColor
  style: HighlightStyle
  note?: string
  tags?: string[]
  /** human label, e.g. "p. 42" or chapter title */
  label?: string
  created: string // ISO-8601
}

export const QUOTE_CONTEXT = 32

export function makeQuote(fullText: string, start: number, end: number, context = QUOTE_CONTEXT): TextQuote {
  return {
    exact: fullText.slice(start, end),
    prefix: fullText.slice(Math.max(0, start - context), start),
    suffix: fullText.slice(end, end + context),
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Length of the common suffix of a and b (used to score prefix context). */
function commonSuffix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}
function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

export interface QuoteMatch {
  start: number
  end: number
  score: number
}

/**
 * Find a quote in text. Exact matches are scored by how much prefix/suffix
 * context agrees; if none, falls back to whitespace/case-insensitive matching.
 * Returns null when the quote cannot be found.
 */
export function findQuote(text: string, quote: TextQuote, hint?: number): QuoteMatch | null {
  const { exact, prefix, suffix } = quote
  if (!exact) return null
  const candidates: QuoteMatch[] = []
  let from = 0
  for (;;) {
    const i = text.indexOf(exact, from)
    if (i < 0) break
    const end = i + exact.length
    let score = commonSuffix(text.slice(Math.max(0, i - prefix.length), i), prefix)
      + commonPrefix(text.slice(end, end + suffix.length), suffix)
    if (hint !== undefined) score -= Math.min(10, Math.abs(i - hint) / 1000)
    candidates.push({ start: i, end, score })
    from = i + 1
  }
  if (candidates.length) return candidates.reduce((a, b) => (b.score > a.score ? b : a))
  return findQuoteLoose(text, quote)
}

/** Whitespace- and case-insensitive search, mapped back to original offsets. */
function findQuoteLoose(text: string, quote: TextQuote): QuoteMatch | null {
  const target = norm(quote.exact)
  if (!target) return null
  // build normalized text with an index map
  const map: number[] = []
  let out = ''
  let lastSpace = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      if (!lastSpace) { out += ' '; map.push(i); lastSpace = true }
    } else {
      out += ch.toLowerCase(); map.push(i); lastSpace = false
    }
  }
  const k = out.indexOf(target)
  if (k < 0) return null
  const start = map[k]!
  const end = map[k + target.length - 1]! + 1
  return { start, end, score: 0 }
}
