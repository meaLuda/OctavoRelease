/**
 * Clean a book filename into { title, author }. Handles common download
 * patterns (Anna's Archive "Title -- Author -- … -- hash -- Anna’s Archive",
 * libgen "Author - Title (Year, Publisher) - libgen.li", "Title_ Subtitle").
 */
export function cleanBookName(filename: string): { title: string; author?: string } {
  let s = filename.replace(/\.[a-z0-9]{2,5}$/i, '')
  const tidy = (x: string) => x.replace(/_ /g, ': ').replace(/_/g, ' ').replace(/\s{2,}/g, ' ').replace(/[\s:,;-]+$/, '').trim()

  if (/ -- /.test(s)) {
    const parts = s.split(' -- ').map(p => p.trim()).filter(p => p && !/anna.?s archive/i.test(p) && !/^[0-9a-f]{32}$/i.test(p) && !/^isbn/i.test(p) && !/^oclc/i.test(p))
    const title = tidy(parts[0] ?? s)
    const authorPart = parts[1]
    const author = authorPart && !/\d{4}|edition|press|publish/i.test(authorPart) ? tidy(authorPart.split(';')[0]!.split(/,\s*(?=[A-Z][a-z]+\s*$)/)[0]!) : undefined
    return { title, author: author || undefined }
  }

  s = s.replace(/\s*-\s*libgen\.[a-z]+$/i, '').replace(/\s*\((?:\d{4}|n\.d\.)[^)]*\)\s*$/, '')
  const dash = / - /.exec(s)
  if (dash && /libgen/i.test(filename)) {
    const author = tidy(s.slice(0, dash.index).replace(/,\s*$/, ''))
    const title = tidy(s.slice(dash.index + 3))
    return { title: title || author, author: title ? author.replace(/_ /g, ', ') : undefined }
  }
  // "Title, Author & Author" (trailing names after the last comma)
  const m = /^(.*?),\s*([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+)+(?:\s*&\s*[A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+)+)*)$/.exec(s)
  if (m && m[1]!.length > 3) return { title: tidy(m[1]!), author: m[2]!.trim() }
  // "Title _ Author"
  const u = /^(.*?)\s+_\s+(.+)$/.exec(s)
  if (u) return { title: tidy(u[1]!), author: tidy(u[2]!) }
  return { title: tidy(s) }
}

/** Embedded PDF/EPUB titles that are really tool or file names ("document1", "PDF77.tmp", "Microsoft Word - x.doc"). */
export function isJunkTitle(t: string | undefined | null): boolean {
  if (!t) return true
  const s = t.trim()
  if (s.length < 3) return true
  return /^(untitled|document\d*|doc\d+|book\d*|pdf\d*|title|unknown|none|null)$/i.test(s)
    || /\.(tmp|pdf|docx?|indd|qxd|rtf|txt|html?)$/i.test(s)
    || /^microsoft (word|powerpoint)/i.test(s)
    || /^[a-f0-9-]{16,}$/i.test(s)
    || /^[\w-]+\.(tmp|indd)$/i.test(s)
}

/** "A;B;B;" / ["A","B"] / "A & B" → "A, B" (deduplicated, trimmed). */
/** Library-catalogue names read better as people: "Strunk, William, 1869-1946" → "William Strunk". */
export function personName(n: string): string {
  let s = n.replace(/\s*\(?\b\d{3,4}\s*[-–]\s*(\d{3,4})?\)?\.?\s*$/, '').replace(/[,\s]+$/, '').trim()
  const parts = s.split(/\s*,\s*/)
  if (parts.length === 2 && parts.every(p => /^[\p{L}][\p{L}.'\- ]*$/u.test(p)) && !/\b(jr|sr|ii|iii|iv)\.?$/i.test(parts[1]!)) s = `${parts[1]} ${parts[0]}`
  return s
}

/** "The elements of style" → "The Elements of Style"; leaves titles that already have capitals alone. */
export function tidyTitle(t: string): string {
  const words = t.trim().split(/\s+/)
  if (words.length < 2 || /[A-Z]/.test(t.slice(1)) || t !== t.trim()) return t.trim()
  const small = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'to', 'at', 'by', 'as', 'via', 'with'])
  return words.map((w, i) => (i === 0 || i === words.length - 1 || !small.has(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

export function normalizeAuthors(v: unknown): string | undefined {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []
  const names = raw.flatMap(s => s.split(/\s*[;\n]\s*/)).map(s => personName(s.trim())).filter(Boolean)
  const seen = new Set<string>()
  const out = names.filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  return out.length ? out.join(', ') : undefined
}
