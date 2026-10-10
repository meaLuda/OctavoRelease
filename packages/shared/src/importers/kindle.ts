import { importId, toIso, type ImportedBook } from './types'

/**
 * Kindle "My Clippings.txt". Entries are separated by "==========".
 * Header lines are localized, so we only rely on structure:
 *   Title (Author)\n- <kind> … | … | <date>\n\n<text>
 * Notes attach to the highlight at the same/overlapping location.
 */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff))

export function importKindle(txt: string): ImportedBook[] {
  const books = new Map<string, ImportedBook>()
  const pendingNotes: Array<{ key: string; loc: string; text: string }> = []
  for (const raw of txt.replace(/\r/g, '').replace(BOM, '').split(/^==========\s*$/m)) {
    const lines = raw.split('\n').map(l => l.replace(BOM, '')).filter((l, i, a) => !(i === 0 && l.trim() === '' && a.length > 1))
    while (lines.length && !lines[0]!.trim()) lines.shift()
    if (lines.length < 3) continue
    const head = lines[0]!.trim()
    const meta = lines[1]!.trim()
    const text = lines.slice(2).join('\n').trim()
    if (!text) continue
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(head)
    const title = (m?.[1] ?? head).trim()
    const author = m?.[2]?.trim()
    const key = `${title}\u0000${author ?? ''}`
    if (!books.has(key)) books.set(key, { title, author, highlights: [] })
    const segs = meta.replace(/^-\s*/, '').split('|').map(x => x.trim())
    const kind = segs[0] ?? ''
    const locSeg = segs.length >= 2 ? segs[segs.length - 2]! : kind
    const locM = /(\d+)(?:\s*-\s*(\d+))?\D*$/.exec(locSeg)
    const loc = locM?.[1] ?? ''
    // a note sits at the END of its highlight ("Location 412-414" → note at 414), so keep the whole range
    const locEnd = locM?.[2] ? String(Number(loc.slice(0, Math.max(0, loc.length - locM[2].length)) + locM[2])) : loc
    // "on page 12 | Location 180-182 | Added on …"; PDFs/personal documents have no location: "on page 23 | Added on …"
    const page = segs.length >= 3 || /page|seite|p[áa]gina|ページ|页/i.test(kind) ? /(\d+)/.exec(kind)?.[1] : undefined
    const isNote = /note|notiz|nota|remarque|注/i.test(kind)
    if (/bookmark|lesezeichen|marcador|signet|ブックマーク/i.test(kind)) continue
    if (isNote) { pendingNotes.push({ key, loc, text }); continue }
    const dateSeg = segs[segs.length - 1] ?? ''
    const date = dateSeg.replace(/^[^,]*,\s*/, '')
    const label = page ? `p. ${page}` : loc ? `loc. ${loc}` : undefined
    books.get(key)!.highlights.push({
      id: importId('k'), color: 'yellow', style: 'highlight', label,
      created: toIso(date), anchor: { quote: { exact: text, prefix: '', suffix: '' } },
      // stash location for note matching
      tags: undefined,
      ...( { _loc: loc, _locEnd: locEnd } as object),
    } as any)
  }
  for (const n of pendingNotes) {
    const hs = books.get(n.key)?.highlights as Array<any> | undefined
    const at = Number(n.loc)
    const target = hs?.slice().reverse().find(h => h._loc === n.loc || (Number(h._loc) <= at && at <= Number(h._locEnd)))
    if (target) target.note = target.note ? `${target.note}\n${n.text}` : n.text
  }
  for (const b of books.values()) for (const h of b.highlights as any[]) { delete h._loc; delete h._locEnd }
  return [...books.values()]
}
