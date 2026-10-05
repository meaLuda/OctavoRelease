import type { ImportedBook } from './types'
import { toIso } from './types'

/** Weave EPUB Reader data note: ```weave-epub-state YAML (format weave-epub-bookmarks/v5). Position + status only (highlight schema unverified). */
export function importWeave(markdown: string): ImportedBook | null {
  const block = /```weave-epub-state\n([\s\S]*?)\n```/.exec(markdown)?.[1]
  if (!block) return null
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*"?([^"\\n]*)"?\\s*$`, 'm').exec(block)?.[1]
  const cfi = get('cfi')
  const percent = Number(get('percent') ?? NaN)
  const status = /^status:\s*(\w+)/m.exec(markdown)?.[1]
  const last = get('lastReadTime')
  return {
    bookPath: get('bookPath'),
    title: get('bookTitle'),
    author: get('bookAuthor')?.replace(/;+$/, '').replace(/;/g, ', '),
    highlights: [],
    position: cfi || Number.isFinite(percent) ? { cfi: cfi || undefined, fraction: Number.isFinite(percent) ? percent / 100 : undefined } : undefined,
    status: status === 'finished' ? 'finished' : status === 'reading' ? 'reading' : undefined,
    lastRead: last ? toIso(Number(last)) : undefined,
  }
}
