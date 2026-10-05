import { importId, mapColor, toIso, type ImportedBook } from './types'

/** Elton Book Reader: reading-highlights.json ({path: [{text,pre,post,color,created,…}]}) + reading-progress.json ({path: {pct,lastRead}}) */
export function importElton(highlightsJson: string, progressJson?: string): ImportedBook[] {
  const hl = JSON.parse(highlightsJson) as Record<string, Array<Record<string, unknown>>>
  const pr = progressJson ? (JSON.parse(progressJson) as Record<string, { pct?: number; lastRead?: number }>) : {}
  const paths = new Set([...Object.keys(hl), ...Object.keys(pr)])
  return [...paths].map(bookPath => {
    const p = pr[bookPath]
    return {
      bookPath,
      highlights: (hl[bookPath] ?? []).filter(h => typeof h.text === 'string' && h.text).map(h => ({
        id: importId('e'),
        color: mapColor(h.color),
        style: 'highlight' as const,
        note: typeof h.note === 'string' && h.note ? h.note : undefined,
        created: toIso(h.created),
        anchor: { quote: { exact: String(h.text), prefix: String(h.pre ?? ''), suffix: String(h.post ?? '') } },
      })),
      position: typeof p?.pct === 'number' ? { fraction: p.pct } : undefined,
      status: typeof p?.pct === 'number' ? (p.pct >= 0.99 ? 'finished' : 'reading') : undefined,
      lastRead: p?.lastRead ? toIso(p.lastRead) : undefined,
    }
  })
}
