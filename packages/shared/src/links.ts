import type { HighlightColor, PdfSelection } from './anchor'
import { HIGHLIGHT_COLORS } from './anchor'

/**
 * Octavo deep-link subpaths. EPUB: `#cfi=<encoded>&color=yellow`.
 * PDF uses the PDF++ grammar so existing PDF++ notes keep working:
 * `#page=12&selection=3,0,5,17&color=yellow` (selection = beginIndex,beginOffset,endIndex,endOffset).
 */
export type Subpath =
  | { type: 'cfi'; cfi: string; color?: string }
  | { type: 'page'; page: number; color?: string }
  | { type: 'selection'; selection: PdfSelection; color?: string }
  | { type: 'annotation'; page: number; annotation: string; color?: string }
  | { type: 'rect'; page: number; rect: [number, number, number, number]; color?: string }

export function parseSubpath(subpath: string): Subpath | null {
  if (!subpath) return null
  const raw = subpath.startsWith('#') ? subpath.slice(1) : subpath
  const params = new URLSearchParams(raw)
  const color = params.get('color') ?? undefined
  const cfi = params.get('cfi')
  if (cfi) return { type: 'cfi', cfi, color }
  if (!params.has('page')) return null
  const page = Number(params.get('page'))
  if (!Number.isInteger(page) || page < 1) return null
  const sel = params.get('selection')
  if (sel) {
    const pos = sel.split(',').map(s => parseInt(s.trim(), 10))
    if (pos.length !== 4 || pos.some(n => Number.isNaN(n))) return null
    const [beginIndex, beginOffset, endIndex, endOffset] = pos as [number, number, number, number]
    return { type: 'selection', selection: { page, beginIndex, beginOffset, endIndex, endOffset }, color }
  }
  const annotation = params.get('annotation')
  if (annotation) return { type: 'annotation', page, annotation, color }
  const rect = params.get('rect')
  if (rect) {
    const r = rect.split(',').map(Number)
    if (r.length === 4 && r.every(Number.isFinite)) return { type: 'rect', page, rect: r as [number, number, number, number], color }
  }
  return { type: 'page', page, color }
}

export function formatCfiSubpath(cfi: string, color?: HighlightColor): string {
  // encode everything that would break a wikilink ([ ] | # ^) or URLSearchParams (& =)
  return `#cfi=${encodeURIComponent(cfi)}${color ? `&color=${color}` : ''}`
}

export function formatPdfSubpath(sel: PdfSelection, color?: HighlightColor): string {
  return `#page=${sel.page}&selection=${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}${color ? `&color=${color}` : ''}`
}

export function isHighlightColor(c: string | undefined): c is HighlightColor {
  return !!c && (HIGHLIGHT_COLORS as readonly string[]).includes(c)
}
