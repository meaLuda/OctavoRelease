/**
 * Library organisation, kept free of Obsidian APIs so it can be unit tested:
 * facet filters (folder, tags, series, author, format), smart collections
 * (saved filters), renaming/removing a collection across book notes, and
 * grouping the Cloud library by collection.
 */

export type Facet = 'folders' | 'tags' | 'series' | 'authors' | 'formats'
export const FACETS: Facet[] = ['folders', 'tags', 'series', 'authors', 'formats']
export const FACET_LABEL: Record<Facet, string> = { folders: 'Folder', tags: 'Tag', series: 'Series', authors: 'Author', formats: 'Format' }

/** A filter spec. Facets AND together; values within one facet OR together. Empty lists match everything. */
export interface LibFilter {
  folders: string[]
  tags: string[]
  series: string[]
  authors: string[]
  formats: string[]
  /** Optional shelf parts, used by smart collections. */
  status?: string
  collections?: string[]
}

export interface SmartCollection { id: string; name: string; filter: LibFilter }

/** The fields of a library book that filters look at. */
export interface FilterableBook {
  path: string
  format: string
  author?: string
  series?: string
  tags: string[]
  collections: string[]
  status: string
}

export const emptyFilter = (): LibFilter => ({ folders: [], tags: [], series: [], authors: [], formats: [] })

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Coerce anything loaded from settings into a well-formed filter. */
export function normalizeFilter(v: unknown): LibFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const f = emptyFilter()
  for (const k of FACETS) f[k] = [...new Set(strList(o[k]))]
  if (typeof o.status === 'string' && o.status) f.status = o.status
  const cols = strList(o.collections)
  if (cols.length) f.collections = [...new Set(cols)]
  return f
}

export const facetCount = (f: LibFilter): number => FACETS.reduce((n, k) => n + f[k].length, 0)
export const isEmptyFilter = (f: LibFilter): boolean => facetCount(f) === 0 && !f.status && !f.collections?.length

/** Tags from frontmatter: a list or a comma/space separated string, without '#'. */
export function tagsOf(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : []
  return [...new Set(raw.map(t => t.trim().replace(/^#/, '')).filter(Boolean))]
}

/** `series` frontmatter: a string, or the first entry of a list; "Name #3" keeps just the name. */
export function seriesOf(v: unknown): string | undefined {
  const s: unknown = Array.isArray(v) ? v[0] : v
  if (typeof s !== 'string' && typeof s !== 'number') return undefined
  const name = String(s).replace(/\[\[|\]\]/g, '').replace(/\s*#\s*\d+(\.\d+)?\s*$/, '').trim()
  return name || undefined
}

/** EPUB/PDF are what people expect; other formats show as their extension. */
export const formatLabel = (ext: string): string => ext.toUpperCase()

export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** "a/b/c.epub" → ["a", "a/b"]: the folder and every parent, so nested folders can be picked at any level. */
export function folderChain(path: string): string[] {
  const parts = folderOf(path).split('/').filter(Boolean)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const anyCi = (want: string[], have: string[]) => want.some(w => have.some(h => ci(w, h)))

/** The tag "book" is on every book note; matching it would filter nothing. */
export const HIDDEN_TAGS = new Set(['book'])

export function matchesFilter(b: FilterableBook, f: LibFilter): boolean {
  if (f.folders.length && !f.folders.some(d => b.path.startsWith(d.replace(/\/$/, '') + '/') || (d === '/' && !b.path.includes('/')))) return false
  if (f.tags.length && !anyCi(f.tags, b.tags)) return false
  if (f.series.length && !(b.series && f.series.some(s => ci(s, b.series!)))) return false
  if (f.authors.length && !(b.author && f.authors.some(a => ci(a, b.author!)))) return false
  if (f.formats.length && !f.formats.some(x => ci(x, b.format))) return false
  if (f.status && b.status !== f.status) return false
  if (f.collections?.length && !anyCi(f.collections, b.collections)) return false
  return true
}

export interface FacetValue { value: string; count: number; depth: number }

/** Every value a facet can take in this library, with book counts. Folders come as a sorted tree (depth = nesting). */
export function facetValues(books: FilterableBook[], facet: Facet): FacetValue[] {
  const counts = new Map<string, number>()
  const bump = (v: string) => counts.set(v, (counts.get(v) ?? 0) + 1)
  for (const b of books) {
    if (facet === 'folders') for (const d of folderChain(b.path)) bump(d)
    else if (facet === 'tags') for (const t of b.tags) { if (!HIDDEN_TAGS.has(t.toLowerCase())) bump(t) }
    else if (facet === 'series') { if (b.series) bump(b.series) }
    else if (facet === 'authors') { if (b.author) bump(b.author) }
    else bump(formatLabel(b.format))
  }
  const out = [...counts].map(([value, count]) => ({ value, count, depth: facet === 'folders' ? value.split('/').length - 1 : 0 }))
  return out.sort((a, b) => a.value.localeCompare(b.value))
}

/** Add or remove one value of one facet (immutable). Formats compare case-insensitively. */
export function toggleFacet(f: LibFilter, facet: Facet, value: string): LibFilter {
  const has = f[facet].some(v => ci(v, value))
  return { ...f, [facet]: has ? f[facet].filter(v => !ci(v, value)) : [...f[facet], value] }
}

/** Short human summary, e.g. "Folder: Library/Sci-fi · Tag: classic, essay". */
export function describeFilter(f: LibFilter): string {
  const parts: string[] = []
  if (f.status) parts.push(`Status: ${f.status}`)
  if (f.collections?.length) parts.push(`Collection: ${f.collections.join(', ')}`)
  for (const k of FACETS) if (f[k].length) parts.push(`${FACET_LABEL[k]}: ${f[k].join(', ')}`)
  return parts.join(' · ') || 'All books'
}

/** Build a smart collection from the current shelf (status or collection) plus the facet filter. */
export function makeSmartCollection(name: string, facets: LibFilter, shelf: string, existing: SmartCollection[], now = Date.now()): SmartCollection {
  const filter = normalizeFilter(facets)
  if (shelf.startsWith('c:')) filter.collections = [shelf.slice(2)]
  else if (shelf !== 'all' && !shelf.startsWith('s:')) filter.status = shelf
  let id = `sc-${now.toString(36)}`
  for (let i = 2; existing.some(s => s.id === id); i++) id = `sc-${now.toString(36)}-${i}`
  return { id, name: name.trim(), filter }
}

/** Rename a label in a list: exact or case-insensitive match, keeps order, drops duplicates the rename creates. */
export function renameLabel(list: string[], from: string, to: string): string[] {
  const out: string[] = []
  for (const x of list) {
    const v = ci(x, from) ? to : x
    if (!out.some(o => ci(o, v))) out.push(v)
  }
  return out
}

export const removeLabel = (list: string[], name: string): string[] => list.filter(x => !ci(x, name))

/** Keep smart collections pointing at a renamed (or deleted, when `to` is null) collection. */
export function renameCollectionInSmart(smart: SmartCollection[], from: string, to: string | null): SmartCollection[] {
  return smart.map(s => {
    if (!s.filter.collections?.some(c => ci(c, from))) return s
    const cols = to === null ? removeLabel(s.filter.collections, from) : renameLabel(s.filter.collections, from, to)
    const filter = { ...s.filter }
    if (cols.length) filter.collections = cols
    else delete filter.collections
    return { ...s, filter }
  })
}

/** Frontmatter `collections` as a list (a single string counts as one). */
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])

/**
 * Note-property change for renaming (to = string) or deleting (to = null) a collection.
 * Returns undefined when the note does not hold it (nothing to write).
 */
export function collectionEdit(current: unknown, from: string, to: string | null): { collections: string[] | undefined } | undefined {
  const list = listOf(current)
  if (!list.some(c => ci(c, from))) return undefined
  const next = to === null ? removeLabel(list, from) : renameLabel(list, from, to)
  return { collections: next.length ? next : undefined }
}

// ───────────── Cloud ─────────────

export interface Labels { collections: string[]; tags: string[] }

/** The note's labels as the Cloud stores them (book note tags minus the default "book" tag). */
export function noteLabels(fm: Record<string, unknown>): Labels {
  return {
    collections: [...new Set(listOf(fm.collections).map(s => s.trim()).filter(Boolean))].slice(0, 20).map(s => s.slice(0, 60)),
    tags: tagsOf(fm.tags).filter(t => !HIDDEN_TAGS.has(t.toLowerCase())).slice(0, 20).map(s => s.slice(0, 60)),
  }
}

export const labelsKey = (l: Labels): string => JSON.stringify([l.collections, l.tags])

/**
 * The labels key the Cloud itself holds for a book. After copying Cloud labels into a note, this (not the merged
 * union) is what counts as last sent, so local-only labels in the note differ from it and are PATCHed up.
 */
export const cloudLabelsKey = (cloud: Partial<Labels>): string => labelsKey(noteLabels({ collections: cloud.collections ?? [], tags: cloud.tags ?? [] }))

/** Props to write on a downloaded Cloud book's note: union with what the note already has, keeping "book". */
export function mergeCloudLabels(fm: Record<string, unknown>, cloud: Partial<Labels>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const cols = listOf(fm.collections)
  for (const c of cloud.collections ?? []) if (!cols.some(x => ci(x, c))) cols.push(c)
  if (cols.length) out.collections = cols
  const tags = tagsOf(fm.tags)
  if (!tags.length) tags.push('book')
  for (const t of cloud.tags ?? []) if (!tags.some(x => ci(x, t))) tags.push(t)
  out.tags = tags
  return out
}

/** Cloud library list grouped by collection; a book in several collections shows under each. */
export function groupByCollection<T extends { title: string; collections?: string[] }>(books: T[], none = 'Not in a collection'): Array<{ name: string; books: T[] }> {
  const groups = new Map<string, T[]>()
  const loose: T[] = []
  for (const b of books) {
    const cols = b.collections?.length ? b.collections : null
    if (!cols) { loose.push(b); continue }
    for (const c of cols) groups.set(c, [...(groups.get(c) ?? []), b])
  }
  const out = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, books: list.sort((a, b) => a.title.localeCompare(b.title)) }))
  if (loose.length) out.push({ name: none, books: loose.sort((a, b) => a.title.localeCompare(b.title)) })
  return out
}
