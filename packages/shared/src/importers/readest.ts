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
