import type { Highlight } from './anchor'
import { pageFromLabel, renderTemplate, type TemplateVars } from './templates'

/**
 * "Export highlights to note": a literature note generated from the book's highlights.
 *
 * The note template is rendered once, when the note is created. `{{highlights}}` becomes a block
 * fenced by the markers below; a refresh regenerates only what is between the markers, so anything
 * the reader writes outside them (summary, thoughts, frontmatter edits) is kept.
 */
export const EXPORT_START = '%% octavo:start %%'
export const EXPORT_END = '%% octavo:end %%'

export const DEFAULT_EXPORT_NOTE_TEMPLATE = [
  '---',
  'title: {{book}}',
  'author: {{author}}',
  'citekey: {{citekey}}',
  'source: {{source}}',
  'octavo-export: true',
  'tags:',
  '  - literature-note',
  '---',
  '',
  '# {{book}}',
  '',
  '{{highlights}}',
  '',
].join('\n')

export const DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE = [
  '> [!octavo-{{color}}] {{label}}',
  '> {{text}}',
  '>',
  '> {{note}}',
  '> {{tags}}',
  '> {{link}}',
].join('\n')

export interface ExportHighlight {
  highlight: Highlight
  /** deep link back into the book (EPUB CFI link or PDF page + selection link) */
  link: string
}

export interface LiteratureInput {
  book: string
  author?: string
  citekey?: string
  /** link to the book file */
  source: string
  highlights: ExportHighlight[]
  /** YYYY-MM-DD */
  date: string
  noteTemplate?: string
  highlightTemplate?: string
  /** stable id of the book (its note's `octavo-id`, else its path); stored as `octavo-book-id` so same-title books don't share a note */
  bookId?: string
}

/** Frontmatter key that ties an exported literature note to its book. */
export const EXPORT_BOOK_ID = 'octavo-book-id'

/** Lexicographic key for an EPUB CFI (`epubcfi(/6/4!/4/2,/1:0,/1:9)` → [6,4,4,2,1,0]). */
function cfiKey(cfi: string): number[] {
  const inner = cfi.replace(/^epubcfi\(/, '').replace(/\)$/, '').replace(/\[[^\]]*\]/g, '')
  const [parent = '', start = ''] = inner.split(',')
  return (parent + start).split(/[/!:~@]/).filter(Boolean).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n))
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

function positionKey(h: Highlight): number[] | null {
  if (h.anchor.pdf) { const s = h.anchor.pdf; return [s.page, s.beginIndex, s.beginOffset] }
  if (h.anchor.cfi) return cfiKey(h.anchor.cfi)
  const p = Number(pageFromLabel(h.label))
  return Number.isFinite(p) && p > 0 ? [p] : null
}

/** Book order where positions are known; highlights without one keep their note order, after the rest. */
export function sortForExport(items: ExportHighlight[]): ExportHighlight[] {
  return items.map((x, i) => ({ x, i, k: positionKey(x.highlight) }))
    .sort((a, b) => (a.k && b.k ? compareKeys(a.k, b.k) || a.i - b.i : a.k ? -1 : b.k ? 1 : a.i - b.i))
    .map(e => e.x)
}

/** Section heading for a highlight: its chapter, else its page, else "Highlights". */
export function sectionOf(h: Highlight): string {
  const parts = (h.label ?? '').split(' · ').map(s => s.trim()).filter(Boolean)
  const chapter = parts.find(s => !/^p\.\s/.test(s))
  if (chapter) return chapter
  const page = h.anchor.pdf?.page ?? pageFromLabel(h.label)
  return page ? `Page ${page}` : 'Highlights'
}

function highlightVars(x: ExportHighlight, base: TemplateVars): TemplateVars {
  const h = x.highlight
  return {
    ...base,
    text: h.anchor.quote.exact,
    note: h.note ?? '',
    tags: h.tags?.length ? h.tags.map(t => `#${t}`).join(' ') : '',
    color: h.color,
    label: h.label ?? '',
    page: h.anchor.pdf?.page ?? pageFromLabel(h.label) ?? '',
    link: x.link,
    date: h.created.slice(0, 10),
  }
}

/** The generated block, markers included. */
export function renderHighlightsBlock(input: LiteratureInput): string {
  const tpl = input.highlightTemplate ?? DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE
  const base: TemplateVars = { book: input.book, author: input.author ?? '', citekey: input.citekey ?? '' }
  const out: string[] = [EXPORT_START, '']
  let section: string | null = null
  const items = sortForExport(input.highlights)
  if (!items.length) out.push('*No highlights yet.*', '')
  for (const x of items) {
    const s = sectionOf(x.highlight)
    if (s !== section) { out.push(`## ${s}`, ''); section = s }
    out.push(renderTemplate(tpl, highlightVars(x, base), { dropEmptyLines: true }).replace(/[ \t]+$/gm, ''), '')
  }
  out.push(EXPORT_END)
  return out.join('\n')
}

/** YAML-safe scalar for frontmatter values (quotes anything YAML could misread, e.g. `[[links]]` or `a: b`). */
export function yamlScalar(v: string): string {
  if (!v) return v
  return /^[\w][\w .,'()&-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/^[\d.]+$/.test(v) ? v : JSON.stringify(v)
}

/** A new literature note from the note template. Without `{{highlights}}` the block is appended. */
export function buildLiteratureNote(input: LiteratureInput): string {
  const tpl = input.noteTemplate ?? DEFAULT_EXPORT_NOTE_TEMPLATE
  const vars: TemplateVars = { book: input.book, author: input.author ?? '', citekey: input.citekey ?? '', source: input.source, date: input.date }
  const block = renderHighlightsBlock(input)
  const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(tpl)?.[0] ?? ''
  const head = withBookId(fm ? renderTemplate(fm, vars, { escape: yamlScalar }) : '', input.bookId)
  let body = renderTemplate(tpl.slice(fm.length), { ...vars, highlights: '\u0000' })
  // a function replacer: `$$x^2$$` or `$'` in a highlight must be inserted literally, not as replacement patterns
  body = body.includes('\u0000') ? body.replace('\u0000', () => block) : `${body.replace(/\s+$/, '')}${body.trim() ? '\n\n' : ''}${block}\n`
  return head + body
}

/** Add `octavo-book-id` to a note's frontmatter (creating one if needed) unless it already has the key. */
function withBookId(md: string, bookId: string | undefined): string {
  if (!bookId) return md
  const idLine = `${EXPORT_BOOK_ID}: ${JSON.stringify(bookId)}\n`
  const fm = /^---\n([\s\S]*?\n)?---(?:\n|$)/.exec(md)
  if (!fm) return `---\n${idLine}---\n${md}`
  if (new RegExp(`^${EXPORT_BOOK_ID}:`, 'm').test(fm[1] ?? '')) return md
  return `---\n${fm[1] ?? ''}${idLine}---\n${md.slice(fm[0].length)}`
}

/** [start, end) of each matched start/end marker pair: an end pairs with the last start before it (after the previous pair). */
function markerPairs(md: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let pos = 0
  for (;;) {
    const e = md.indexOf(EXPORT_END, pos)
    if (e < 0) return out
    const s = md.lastIndexOf(EXPORT_START, e)
    if (s >= pos) out.push([s, e + EXPORT_END.length])
    pos = e + EXPORT_END.length
  }
}

/** Remove stray (unpaired) markers from text outside every pair: the marker line when it holds nothing else, else just the marker. */
function stripMarkers(seg: string): string {
  const esc = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`^[ \\t]*(?:${esc(EXPORT_START)}|${esc(EXPORT_END)})[ \\t]*(?:\\r?\\n|$)`, 'gm')
  return seg.replace(line, '').split(EXPORT_START).join('').split(EXPORT_END).join('')
}

/**
 * Refresh an existing literature note: only the text between the first matched pair of markers is regenerated.
 * Unpaired markers (the user deleted the other one) are dropped, never the text around them. A note without a pair
 * gets a fresh block at the end, never a rewrite.
 */
export function refreshLiteratureNote(existing: string, input: LiteratureInput): string {
  const block = renderHighlightsBlock(input)
  const pairs = markerPairs(existing)
  let clean = ''
  let pos = 0
  for (const [s, e] of pairs) { clean += stripMarkers(existing.slice(pos, s)) + existing.slice(s, e); pos = e }
  clean = withBookId(clean + stripMarkers(existing.slice(pos)), input.bookId)
  const first = markerPairs(clean)[0]
  if (!first) return `${clean.replace(/\s+$/, '')}${clean.trim() ? '\n\n' : ''}${block}\n`
  return clean.slice(0, first[0]) + block + clean.slice(first[1])
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * `<folder>/<Book title> highlights.md`, with characters Obsidian rejects in file names removed. `disambiguator`
 * (a citekey or short id) gives `<Book title> (<disambiguator>) highlights.md`, for a second book with the same title.
 */
export function literatureNotePath(folder: string, book: string, disambiguator?: string): string {
  const safe = safeName(book).slice(0, 120) || 'Untitled'
  const d = disambiguator ? safeName(disambiguator).slice(0, 40) : ''
  const dir = folder.replace(/^\/+|\/+$/g, '')
  return `${dir ? `${dir}/` : ''}${safe}${d ? ` (${d})` : ''} highlights.md`
}

/**
 * Where to export a book's highlights. `ownerAt(path)` says who owns an existing note at a path: undefined when there
 * is no note, null when the note belongs to no known book (an older export without an id: treated as this book's),
 * else the book id stored in it. A note owned by another book (same title) is left alone and the citekey (or a
 * short id) is added to the name.
 */
export function resolveLiteratureNotePath(folder: string, book: string, bookId: string, ownerAt: (path: string) => string | null | undefined, citekey?: string): string {
  const base = literatureNotePath(folder, book)
  const owner = ownerAt(base)
  if (owner === undefined || owner === null || owner === bookId) return base
  const shortId = bookId.replace(/^.*\//, '').replace(/\.[^.]+$/, '').slice(0, 12) || bookId.slice(0, 12)
  for (const d of [citekey, shortId].filter((x): x is string => !!x)) {
    const p = literatureNotePath(folder, book, d)
    const o = ownerAt(p)
    if (o === undefined || o === bookId) return p
  }
  return literatureNotePath(folder, book, bookId.slice(0, 40))
}
