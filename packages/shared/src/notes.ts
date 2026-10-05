import type { Highlight, HighlightColor, HighlightStyle } from './anchor'
import { isHighlightColor } from './links'

/**
 * Book-note highlight blocks. Each highlight is an Obsidian callout:
 *
 *   > [!octavo-yellow] Chapter 3 · p. 42
 *   > The highlighted text.
 *   >
 *   > A note the user typed.
 *   > [[book.epub#cfi=…&color=yellow|↗]]
 *   > %%octavo:{"id":"k3j2","cfi":"…","p":"prefix","s":"suffix",…}%% ^oct-k3j2
 *
 * The `%%…%%` comment is hidden in reading view and carries the anchor; the
 * visible text and note are read back from the callout so users can edit them.
 */
export const HIGHLIGHTS_HEADING = '## Highlights'
const META_RE = /%%octavo:(\{.*\})%%/
const HEADER_RE = /^> \[!octavo-([a-z]+)\]([+-]?)\s?(.*)$/

interface Meta {
  id: string
  cfi?: string
  pdf?: [number, number, number, number, number]
  p: string
  s: string
  st?: HighlightStyle
  c: string
  t?: string[]
}

const quoteLines = (text: string) =>
  text.split('\n').map(l => `> ${l}`.trimEnd())

export function renderHighlight(h: Highlight, link: string): string {
  const meta: Meta = { id: h.id, p: h.anchor.quote.prefix, s: h.anchor.quote.suffix, c: h.created }
  if (h.anchor.cfi) meta.cfi = h.anchor.cfi
  if (h.anchor.pdf) { const s = h.anchor.pdf; meta.pdf = [s.page, s.beginIndex, s.beginOffset, s.endIndex, s.endOffset] }
  if (h.style !== 'highlight') meta.st = h.style
  if (h.tags?.length) meta.t = h.tags
  const lines = [`> [!octavo-${h.color}] ${h.label ?? ''}`.trimEnd(), ...quoteLines(h.anchor.quote.exact)]
  if (h.note) lines.push('>', ...quoteLines(h.note))
  if (h.tags?.length) lines.push(`> ${h.tags.map(t => `#${t}`).join(' ')}`)
  lines.push(`> ${link}`)
  // JSON may not contain "%%" — escape it
  lines.push(`> %%octavo:${JSON.stringify(meta).replace(/%%/g, '%\\u0025')}%% ^oct-${h.id}`)
  return lines.join('\n')
}

export interface ParsedHighlight extends Highlight {
  /** line range of the callout in the note, [start, end) */
  lines: [number, number]
}

export function parseHighlights(markdown: string): ParsedHighlight[] {
  const lines = markdown.split('\n')
  const out: ParsedHighlight[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = HEADER_RE.exec(lines[i]!)
    if (!head) continue
    let j = i + 1
    while (j < lines.length && lines[j]!.startsWith('>')) j++
    const body = lines.slice(i + 1, j).map(l => l.replace(/^> ?/, ''))
    const metaIdx = body.findIndex(l => META_RE.test(l))
    if (metaIdx < 0) { i = j - 1; continue }
    let meta: Meta
    try { meta = JSON.parse(META_RE.exec(body[metaIdx]!)![1]!) } catch { i = j - 1; continue }
    // content = everything before the link line (the line just before meta)
    const content = body.slice(0, Math.max(0, metaIdx - 1))
    const tagLine = content.length && /^(#[\w/-]+\s*)+$/.test(content[content.length - 1]!) ? content.pop() : undefined
    const blank = content.indexOf('')
    const exact = (blank < 0 ? content : content.slice(0, blank)).join('\n')
    const note = blank < 0 ? undefined : content.slice(blank + 1).join('\n').trim() || undefined
    const color: HighlightColor = isHighlightColor(head[1]) ? head[1] : 'yellow'
    const tags = tagLine ? tagLine.split(/\s+/).filter(Boolean).map(t => t.slice(1)) : meta.t
    out.push({
      id: meta.id,
      color,
      style: meta.st ?? 'highlight',
      label: head[3] || undefined,
      note,
      tags: tags?.length ? tags : undefined,
      created: meta.c,
      anchor: {
        cfi: meta.cfi,
        pdf: meta.pdf ? { page: meta.pdf[0], beginIndex: meta.pdf[1], beginOffset: meta.pdf[2], endIndex: meta.pdf[3], endOffset: meta.pdf[4] } : undefined,
        quote: { exact, prefix: meta.p, suffix: meta.s },
      },
      lines: [i, j],
    })
    i = j - 1
  }
  return out
}

/** Insert or replace a highlight block; new blocks go at the end of the Highlights section. */
export function upsertHighlight(markdown: string, h: Highlight, link: string): string {
  const block = renderHighlight(h, link)
  const existing = parseHighlights(markdown).find(x => x.id === h.id)
  const lines = markdown.split('\n')
  if (existing) {
    lines.splice(existing.lines[0], existing.lines[1] - existing.lines[0], ...block.split('\n'))
    return lines.join('\n')
  }
  let at = lines.findIndex(l => l.trim() === HIGHLIGHTS_HEADING)
  if (at < 0) {
    const trimmed = markdown.replace(/\s+$/, '')
    return `${trimmed}${trimmed ? '\n\n' : ''}${HIGHLIGHTS_HEADING}\n\n${block}\n`
  }
  // end of section = next heading of level <= 2, or EOF
  let end = lines.length
  for (let k = at + 1; k < lines.length; k++) if (/^#{1,2} /.test(lines[k]!)) { end = k; break }
  while (end > at + 1 && lines[end - 1]!.trim() === '') end--
  lines.splice(end, 0, '', ...block.split('\n'))
  return lines.join('\n')
}

export function removeHighlight(markdown: string, id: string): string {
  const h = parseHighlights(markdown).find(x => x.id === id)
  if (!h) return markdown
  const lines = markdown.split('\n')
  let [s, e] = h.lines
  // also drop one adjacent blank line
  if (lines[e]?.trim() === '') e++
  else if (s > 0 && lines[s - 1]?.trim() === '') s--
  lines.splice(s, e - s)
  return lines.join('\n')
}

export function newHighlightId(): string {
  const a = new Uint8Array(5)
  crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 8)
}
