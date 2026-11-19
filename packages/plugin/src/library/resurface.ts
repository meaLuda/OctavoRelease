/**
 * Daily highlights (Readwise-style resurfacing): pick a few highlights from your books for today's daily note.
 * Never-shown highlights come first, then the ones shown longest ago; one per book where possible.
 * Pure: no Obsidian imports, unit-tested.
 */

export interface Candidate { id: string; book: string }

/** Highlights shown within this many days are skipped while others are left. */
export const RESHOW_AFTER_DAYS = 30

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/**
 * `count` highlights for `today` (YYYY-MM-DD). `shown` maps highlight id → the day it was last shown.
 * `rand` returns [0, 1); pass a seeded one in tests.
 */
export function pickHighlights<T extends Candidate>(all: T[], shown: Record<string, string>, count: number, today: string, rand: () => number = Math.random): T[] {
  if (count <= 0 || !all.length) return []
  const weight = (c: T) => {
    const last = shown[c.id]
    if (!last) return 3
    const age = daysBetween(last, today)
    return age < RESHOW_AFTER_DAYS ? 0 : Math.min(2, age / 90)
  }
  let pool = all.map(c => ({ c, w: weight(c) }))
  if (!pool.some(p => p.w > 0)) pool = all.map(c => ({ c, w: 1 })) // everything was shown lately: start over
  const out: T[] = []
  const books = new Set<string>()
  while (out.length < count) {
    // one per book first; allow repeats of a book only when no other book has candidates left
    const fresh = pool.filter(p => p.w > 0 && !books.has(p.c.book))
    const from = fresh.length ? fresh : pool.filter(p => p.w > 0)
    if (!from.length) break
    const total = from.reduce((a, p) => a + p.w, 0)
    let r = rand() * total
    const hit = from.find(p => (r -= p.w) < 0) ?? from[from.length - 1]
    out.push(hit.c)
    books.add(hit.c.book)
    pool = pool.filter(p => p !== hit)
  }
  return out
}

/** `shown` with today's picks recorded and entries older than a year dropped. */
export function recordShown(shown: Record<string, string>, ids: string[], today: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, day] of Object.entries(shown)) if (daysBetween(day, today) < 365) out[id] = day
  for (const id of ids) out[id] = today
  return out
}

/** The daily note section: an embed of each highlight's block in its book note, under one heading. */
export function dailySection(heading: string, embeds: string[]): string {
  return [`## ${heading}`, '', ...embeds.flatMap(e => [e, ''])].join('\n').trimEnd()
}

/**
 * Appends `block` at the end of the "## <heading>" section (up to the next # or ## heading), or adds the section
 * at the end of the note when there is none. Other sections stay where they are.
 */
export function appendUnderHeading(md: string, heading: string, block: string): string {
  const lines = md.replace(/\s+$/, '').split('\n')
  const at = lines.findIndex(l => l.trim() === `## ${heading}`)
  if (at < 0) return `${lines.join('\n')}\n\n## ${heading}\n\n${block}\n`
  let end = at + 1
  while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++
  let ins = end
  while (ins > at + 1 && !lines[ins - 1]!.trim()) ins--
  lines.splice(ins, 0, '', block, ...(ins === end && end < lines.length ? [''] : []))
  return `${lines.join('\n')}\n`
}
