import { parseLuaTable } from './lua'
import { importId, mapColor, toIso, type ImportedBook } from './types'

type Ann = { text?: string; note?: string; chapter?: string; color?: string; drawer?: string; datetime?: string; time?: number; pageno?: number; page?: unknown }

function fromAnnotations(list: Ann[], meta: { title?: string; authors?: string; file?: string }, percent?: number, finished?: boolean): ImportedBook {
  return {
    bookPath: meta.file,
    title: meta.title,
    author: meta.authors?.replace(/\n/g, ', '),
    highlights: list.filter(a => a.text).map(a => ({
      id: importId('ko'),
      color: mapColor(a.color),
      style: a.drawer === 'underscore' || a.drawer === 'strikeout' ? 'underline' as const : 'highlight' as const,
      note: a.note || undefined,
      label: a.chapter || (typeof a.pageno === 'number' ? `p. ${a.pageno}` : undefined),
      created: toIso(a.datetime ?? a.time),
      anchor: { quote: { exact: a.text!, prefix: '', suffix: '' } },
    })),
    position: typeof percent === 'number' ? { fraction: percent } : undefined,
    status: finished ? 'finished' : typeof percent === 'number' ? 'reading' : undefined,
  }
}

/** KOReader sidecar: book.sdr/metadata.<ext>.lua (new `annotations` list, or legacy `highlight`+`bookmarks`). */
export function importKoreaderSidecar(lua: string, bookPath?: string): ImportedBook {
  const t = parseLuaTable(lua) as Record<string, any>
  const props = (t.doc_props ?? {}) as { title?: string; authors?: string }
  let anns: Ann[] = Array.isArray(t.annotations) ? t.annotations : []
  if (!anns.length && t.bookmarks) {
    const bm: any[] = Array.isArray(t.bookmarks) ? t.bookmarks : Object.values(t.bookmarks)
    anns = bm.filter(b => b.highlighted || b.text).map(b => ({ text: b.notes ?? b.text, note: b.text !== b.notes ? undefined : undefined, chapter: b.chapter, datetime: b.datetime, pageno: typeof b.page === 'number' ? b.page : undefined }))
  }
  return fromAnnotations(anns, { ...props, file: bookPath }, typeof t.percent_finished === 'number' ? t.percent_finished : undefined, t.summary?.status === 'complete')
}

/** KOReader "Export highlights → JSON" (exporter.koplugin): a book object or array of them with `entries`. */
export function importKoreaderJson(json: string): ImportedBook[] {
  const data = JSON.parse(json)
  const books: any[] = Array.isArray(data) ? data : data.entries ? [data] : Object.values(data)
  return books.map(b => fromAnnotations(
    (b.entries ?? []).map((e: any) => ({ text: e.text, note: e.note, chapter: e.chapter, color: e.color, drawer: e.drawer, time: e.time, pageno: e.page })),
    { title: b.title, authors: b.author, file: b.file }))
}
