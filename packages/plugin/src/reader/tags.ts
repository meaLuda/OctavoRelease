/** Highlight tags: parsing, autocomplete and filtering (pure; unit-tested). */

const BAD = /[^\p{L}\p{N}_/-]+/gu

/** Normalise one tag the way Obsidian accepts it: no '#', no spaces or punctuation, not purely numeric. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').replace(BAD, '-').replace(/^[-/]+|[-/]+$/g, '').replace(/-{2,}/g, '-')
  if (!t || /^\d+$/.test(t)) return null
  return t
}

/** "#ideas, to-read  ch 3" → ['ideas', 'to-read', 'ch'] (comma or space separated, deduplicated case-insensitively). */
export function parseTags(input: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of input.split(/[\s,]+/)) {
    const t = normalizeTag(part)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out
}

/** The tag being typed: text after the last comma or space. */
export const currentToken = (input: string) => input.split(/[\s,]+/).pop()!.replace(/^#+/, '')

/** Suggestions for the token being typed: prefix matches first, then substring matches; skips tags already entered. */
export function tagSuggestions(input: string, known: Iterable<string>, limit = 8): string[] {
  const token = currentToken(input).toLowerCase()
  const entered = new Set(parseTags(input.slice(0, input.length - currentToken(input).length)).map(t => t.toLowerCase()))
  const uniq = new Map<string, string>()
  for (const k of known) { const t = k.replace(/^#/, ''); if (t && !uniq.has(t.toLowerCase())) uniq.set(t.toLowerCase(), t) }
  const pre: string[] = [], mid: string[] = []
  for (const [low, t] of uniq) {
    if (entered.has(low) || low === token) continue
    if (!token || low.startsWith(token)) pre.push(t)
    else if (low.includes(token)) mid.push(t)
  }
  pre.sort((a, b) => a.localeCompare(b)); mid.sort((a, b) => a.localeCompare(b))
  return [...pre, ...mid].slice(0, limit)
}

/** Replace the token being typed with `tag`, ready for the next one. */
export function applySuggestion(input: string, tag: string): string {
  const tok = input.split(/[\s,]+/).pop()!
  return `${input.slice(0, input.length - tok.length)}${tag}, `
}

/** Every tag used in these highlights with its count, most used first. */
export function collectTags(items: Iterable<{ tags?: string[] }>): Array<{ tag: string; count: number }> {
  const m = new Map<string, { tag: string; count: number }>()
  for (const h of items) for (const t of h.tags ?? []) {
    const k = t.toLowerCase()
    const e = m.get(k)
    if (e) e.count++; else m.set(k, { tag: t, count: 1 })
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Keep highlights that carry every selected tag (case-insensitive). No selection keeps everything. */
export function matchesTags(h: { tags?: string[] }, selected: Iterable<string>): boolean {
  const have = new Set((h.tags ?? []).map(t => t.toLowerCase()))
  for (const s of selected) if (!have.has(s.toLowerCase())) return false
  return true
}

export const filterByTags = <T extends { tags?: string[] }>(items: T[], selected: Iterable<string>): T[] => {
  const sel = [...selected]
  return sel.length ? items.filter(h => matchesTags(h, sel)) : items
}
