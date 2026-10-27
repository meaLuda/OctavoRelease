import { parseHighlights, HIGHLIGHTS_HEADING } from '@octavo/shared'

/**
 * Duplicate book notes (two notes for one book, e.g. "X.md" and "X 2.md"):
 * pure grouping and merge logic, used by BookLibrary.repairDuplicates.
 */

export interface NoteInfo {
  path: string
  /** frontmatter `octavo-id` */
  id: string
  /** path of the book the `book` link resolves to, if any */
  book?: string
  /** creation time (ms); the oldest note is kept */
  ctime: number
}

export interface DuplicateGroup<T extends NoteInfo = NoteInfo> {
  keep: T
  dups: T[]
}

/** Notes sharing an octavo-id or a resolved book link form one group (transitively). Groups of one are dropped. */
export function groupDuplicates<T extends NoteInfo>(notes: T[]): DuplicateGroup<T>[] {
  const parent = notes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  const byKey = new Map<string, number>()
  notes.forEach((n, i) => {
    for (const key of [n.id ? `id:${n.id}` : '', n.book ? `book:${n.book}` : '']) {
      if (!key) continue
      const j = byKey.get(key)
      if (j === undefined) byKey.set(key, i)
      else union(j, i)
    }
  })
  const groups = new Map<number, T[]>()
  notes.forEach((n, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), n]) })
  const out: DuplicateGroup<T>[] = []
  for (const g of groups.values()) {
    if (g.length < 2) continue
    // oldest first; ties → shortest path ("X.md" before "X 2.md"), then alphabetical
    const sorted = [...g].sort((a, b) => a.ctime - b.ctime || a.path.length - b.path.length || a.path.localeCompare(b.path))
    out.push({ keep: sorted[0], dups: sorted.slice(1) })
  }
  return out
}

/** Append the duplicates' highlight blocks to the kept note's Highlights section, skipping ids it already has. */
export function mergeHighlightBlocks(keepMd: string, dupMds: string[]): { md: string; added: number } {
  const have = new Set(parseHighlights(keepMd).map(h => h.id))
  const blocks: string[] = []
  for (const md of dupMds) {
    const lines = md.split('\n')
    for (const h of parseHighlights(md)) {
      if (have.has(h.id)) continue
      have.add(h.id)
      blocks.push(lines.slice(h.lines[0], h.lines[1]).join('\n'))
    }
  }
  if (!blocks.length) return { md: keepMd, added: 0 }
  const lines = keepMd.split('\n')
  const at = lines.findIndex(l => l.trim() === HIGHLIGHTS_HEADING)
  if (at < 0) {
    const trimmed = keepMd.replace(/\s+$/, '')
    return { md: `${trimmed}${trimmed ? '\n\n' : ''}${HIGHLIGHTS_HEADING}\n\n${blocks.join('\n\n')}\n`, added: blocks.length }
  }
  let end = lines.length
  for (let k = at + 1; k < lines.length; k++) if (/^#{1,2} /.test(lines[k])) { end = k; break }
  while (end > at + 1 && lines[end - 1].trim() === '') end--
  const insert = blocks.flatMap(b => ['', ...b.split('\n')])
  if (end < lines.length) insert.push('')
  lines.splice(end, 0, ...insert)
  return { md: lines.join('\n'), added: blocks.length }
}

const STATUS_RANK: Record<string, number> = { want: 0, reading: 1, abandoned: 2, finished: 3 }

/** A frontmatter value as text; lists are comma-joined, as String() does. */
export function propText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (Array.isArray(v)) return v.map(propText).join(',')
  return JSON.stringify(v)
}

/**
 * Frontmatter changes for the kept note: furthest progress (with its position and status),
 * latest last-read, earliest started. Only keys that change are returned.
 */
export function mergeProps(keep: Record<string, unknown>, dups: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  let best = keep
  for (const d of dups) if (num(d.progress) > num(best.progress)) best = d
  if (best !== keep) {
    out.progress = best.progress
    if (best.position !== undefined) out.position = best.position
  }
  const statuses = [keep, ...dups].map(p => propText(p.status ?? '')).filter(s => s in STATUS_RANK)
  const status = statuses.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0]
  if (status && status !== keep.status) out.status = status
  const latest = [keep, ...dups].map(p => p['last-read']).filter(v => v != null).map(propText).sort().at(-1)
  if (latest && latest !== propText(keep['last-read'] ?? '')) out['last-read'] = latest
  const started = [keep, ...dups].map(p => p.started).filter(v => v != null).map(propText).sort()[0]
  if (started && started !== propText(keep.started ?? '')) out.started = started
  for (const d of dups) for (const [k, v] of Object.entries(d)) {
    // carry over properties only the duplicate has (collections, rating, cover…)
    if (keep[k] === undefined && out[k] === undefined && v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}
