import { importId, mapColor, toIso, type ImportedBook } from './types'

/** Readest per-book config.json: { progress, location (cfi), booknotes: [{type, cfi, text, note, color, style, createdAt, deletedAt}] } */
export function importReadest(configJson: string, meta?: { bookPath?: string; title?: string; author?: string }): ImportedBook {
  const c = JSON.parse(configJson)
  const notes: any[] = Array.isArray(c.booknotes) ? c.booknotes : []
  const progress = Array.isArray(c.progress) && c.progress[1] ? c.progress[0] / c.progress[1] : undefined
  return {
    ...meta,
    highlights: notes.filter(n => n.type === 'annotation' && !n.deletedAt && n.text).map(n => ({
      id: importId('r'),
      color: mapColor(n.color),
      style: n.style === 'underline' || n.style === 'squiggly' ? 'underline' as const : 'highlight' as const,
      note: n.note || undefined,
      created: toIso(n.createdAt),
      anchor: { cfi: typeof n.cfi === 'string' ? n.cfi : undefined, quote: { exact: n.text, prefix: '', suffix: '' } },
    })),
    position: c.location || progress !== undefined ? { cfi: typeof c.location === 'string' ? c.location : undefined, fraction: progress } : undefined,
  }
}

/**
 * Readest's config.json only carries `bookHash`; titles live in Books/library.json
 * ([{ hash, title, author, … }]). Pass both (picked together) so highlights reach the right book.
 */
export function importReadestFiles(files: Array<{ name: string; text: string }>): ImportedBook[] {
  const lib = new Map<string, { title?: string; author?: string }>()
  for (const f of files) {
    if (f.name !== 'library.json') continue
    const l = JSON.parse(f.text)
    if (Array.isArray(l)) for (const b of l) if (b?.hash && !b.deletedAt) lib.set(b.hash, { title: b.title || undefined, author: b.author || undefined })
  }
  return files.filter(f => f.name !== 'library.json').map(f => {
    const c = JSON.parse(f.text)
    const hash: unknown = c.bookHash ?? (Array.isArray(c.booknotes) ? c.booknotes.find((n: any) => n?.bookHash)?.bookHash : undefined)
    return importReadest(f.text, typeof hash === 'string' ? lib.get(hash) : undefined)
  })
}
