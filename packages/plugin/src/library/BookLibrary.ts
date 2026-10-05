import { App, TFile, normalizePath, moment, Notice } from 'obsidian'
import {
  parseHighlights, upsertHighlight, removeHighlight, parseSubpath, formatCfiSubpath, formatPdfSubpath,
  HIGHLIGHTS_HEADING, type Highlight, type ParsedHighlight, type Subpath,
} from '@octavo/shared'
import type { OctavoSettings } from '../settings'

export const BOOK_EXTENSIONS = ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'fbz', 'cbz'] as const
export const isBookFile = (f: TFile | null | undefined): f is TFile =>
  !!f && ((BOOK_EXTENSIONS as readonly string[]).includes(f.extension) || f.extension === 'pdf')

export type BookStatus = 'want' | 'reading' | 'finished' | 'abandoned'

export interface BookMeta {
  id: string
  title: string
  author?: string
  language?: string
  publisher?: string
  format: string
}

export interface Backlink {
  sourcePath: string
  subpath: Subpath
  raw: string
  display?: string
}

const sanitize = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'

/** Maps book files ↔ book notes and owns every write to book notes. */
export class BookLibrary {
  private noteByBook = new Map<string, string>() // book path → note path
  constructor(private app: App, private settings: () => OctavoSettings) {}

  /** Rebuild the book→note index from frontmatter `book` links. */
  reindex(): void {
    this.noteByBook.clear()
    for (const f of this.app.vault.getMarkdownFiles()) this.indexNote(f)
  }

  indexNote(f: TFile): void {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
    if (!fm || !fm['octavo-id']) return
    const book = this.resolveBookLink(fm.book, f.path)
    if (book) this.noteByBook.set(book.path, f.path)
  }

  forgetNote(path: string): void {
    for (const [k, v] of this.noteByBook) if (v === path) this.noteByBook.delete(k)
  }

  renameBook(oldPath: string, newPath: string): void {
    const n = this.noteByBook.get(oldPath)
    if (n) { this.noteByBook.delete(oldPath); this.noteByBook.set(newPath, n) }
  }

  private resolveBookLink(v: unknown, sourcePath: string): TFile | null {
    if (typeof v !== 'string') return null
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(v.trim()) ?? /^\[[^\]]*\]\(([^)#]+)\)$/.exec(v.trim())
    const linkpath = m ? decodeURI(m[1]!) : v
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
  }

  noteFor(book: TFile): TFile | null {
    const p = this.noteByBook.get(book.path)
    const f = p ? this.app.vault.getAbstractFileByPath(p) : null
    return f instanceof TFile ? f : null
  }

  bookForNote(note: TFile): TFile | null {
    for (const [b, n] of this.noteByBook) if (n === note.path) {
      const f = this.app.vault.getAbstractFileByPath(b)
      return f instanceof TFile ? f : null
    }
    return null
  }

  allBooks(): Array<{ book: TFile; note: TFile }> {
    const out: Array<{ book: TFile; note: TFile }> = []
    for (const [b, n] of this.noteByBook) {
      const book = this.app.vault.getAbstractFileByPath(b), note = this.app.vault.getAbstractFileByPath(n)
      if (book instanceof TFile && note instanceof TFile) out.push({ book, note })
    }
    return out
  }

  private creating = new Map<string, Promise<TFile>>()

  /** Find or create the book note. Never overwrites user content; concurrent calls for one book share one note. */
  ensureNote(book: TFile, meta: BookMeta): Promise<TFile> {
    const pending = this.creating.get(book.path)
    if (pending) return pending
    const p = this.ensureNoteOnce(book, meta).finally(() => this.creating.delete(book.path))
    this.creating.set(book.path, p)
    return p
  }

  private async ensureNoteOnce(book: TFile, meta: BookMeta): Promise<TFile> {
    const existing = this.noteFor(book)
    if (existing) return existing
    const adopted = await this.adoptOrphan(book, meta)
    if (adopted) return adopted
    const folder = normalizePath(this.settings().booksFolder || 'Books')
    await this.ensureFolder(folder)
    let path = normalizePath(`${folder}/${sanitize(meta.title || book.basename)}.md`)
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++)
      path = normalizePath(`${folder}/${sanitize(meta.title || book.basename)} ${i}.md`)
    const link = this.app.fileManager.generateMarkdownLink(book, path).replace(/^!/, '')
    const today = moment().format('YYYY-MM-DD')
    const fm = [
      '---',
      `octavo-id: ${meta.id}`,
      `book: ${JSON.stringify(link)}`,
      `title: ${JSON.stringify(meta.title || book.basename)}`,
      ...(meta.author ? [`author: ${JSON.stringify(meta.author)}`] : []),
      `format: ${meta.format}`,
      'status: reading',
      'progress: 0',
      `started: ${today}`,
      `last-read: ${moment().format('YYYY-MM-DDTHH:mm')}`,
      'highlights: 0',
      'tags:',
      '  - book',
      '---',
      '',
      `# ${meta.title || book.basename}`,
      '',
      ...(meta.author ? [`*${meta.author}*`, ''] : []),
      HIGHLIGHTS_HEADING,
      '',
    ].join('\n')
    const note = await this.app.vault.create(path, fm)
    this.noteByBook.set(book.path, note.path)
    return note
  }

  /** Notes created by an import (no linked book yet) are adopted when a book with the same title is opened. */
  private async adoptOrphan(book: TFile, meta: BookMeta): Promise<TFile | null> {
    const folder = normalizePath(this.settings().booksFolder || 'Books')
    const key = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
    const want = [key(meta.title || ''), key(book.basename)].filter(Boolean)
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(folder + '/')) continue
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
      if (!fm || fm['octavo-id'] || fm.book || !fm.title) continue
      const t = key(String(fm.title))
      if (!want.some(w => w === t || (t.length > 8 && (w.includes(t) || t.includes(w))))) continue
      const link = this.app.fileManager.generateMarkdownLink(book, f.path).replace(/^!/, '')
      await this.setProps(f, { 'octavo-id': meta.id, book: link, format: meta.format })
      this.noteByBook.set(book.path, f.path)
      return f
    }
    return null
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder || this.app.vault.getAbstractFileByPath(folder)) return
    const parts = folder.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p).catch(() => {})
    }
  }

  async setProps(note: TFile, props: Record<string, unknown>): Promise<void> {
    await this.app.fileManager.processFrontMatter(note, fm => {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined) delete fm[k]
        else fm[k] = v
      }
    })
  }

  getProps(note: TFile): Record<string, any> {
    return this.app.metadataCache.getFileCache(note)?.frontmatter ?? {}
  }

  async highlights(note: TFile): Promise<ParsedHighlight[]> {
    return parseHighlights(await this.app.vault.cachedRead(note))
  }

  linkFor(book: TFile, note: TFile, h: Highlight): string {
    const sub = h.anchor.cfi ? formatCfiSubpath(h.anchor.cfi, h.color)
      : h.anchor.pdf ? formatPdfSubpath(h.anchor.pdf, h.color) : ''
    return this.app.fileManager.generateMarkdownLink(book, note.path, sub, '↗').replace(/^!/, '')
  }

  async saveHighlight(book: TFile, note: TFile, h: Highlight): Promise<void> {
    const link = this.linkFor(book, note, h)
    let count = 0
    await this.app.vault.process(note, md => {
      const out = upsertHighlight(md, h, link)
      count = parseHighlights(out).length
      return out
    })
    await this.setProps(note, { highlights: count })
  }

  async deleteHighlight(note: TFile, id: string): Promise<void> {
    let count = 0
    await this.app.vault.process(note, md => {
      const out = removeHighlight(md, id)
      count = parseHighlights(out).length
      return out
    })
    await this.setProps(note, { highlights: count })
  }

  /** Every link in the vault that points into this book with a position subpath (Octavo or PDF++ grammar). */
  backlinks(book: TFile): Backlink[] {
    const out: Backlink[] = []
    const mc = this.app.metadataCache
    const resolved = mc.resolvedLinks
    for (const source in resolved) {
      if (!resolved[source]?.[book.path]) continue
      const cache = mc.getCache(source)
      for (const l of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
        const hash = l.link.indexOf('#')
        if (hash < 0) continue
        const dest = mc.getFirstLinkpathDest(l.link.slice(0, hash), source)
        if (dest?.path !== book.path) continue
        const sp = parseSubpath(l.link.slice(hash))
        if (sp) out.push({ sourcePath: source, subpath: sp, raw: l.original, display: l.displayText })
      }
    }
    return out
  }

  /** Reading session → stats, optional line in today's daily note. */
  async logSession(s: { book: TFile; note: TFile | null; title: string; minutes: number; from: number; to: number; highlights: number }): Promise<void> {
    const settings = this.settings()
    if (s.minutes < 1) return
    const day = moment().format('YYYY-MM-DD')
    settings.stats.minutesByDay[day] = (settings.stats.minutesByDay[day] ?? 0) + s.minutes
    if (!settings.dailyNoteLog) return
    const daily = await this.dailyNote()
    if (!daily) return
    const link = s.note ? this.app.fileManager.generateMarkdownLink(s.note, daily.path, '', s.title) : s.title
    const pct = (x: number) => `${Math.round(x * 100)}%`
    const line = `- 📖 ${link} · ${s.minutes} min · ${pct(s.from)} → ${pct(s.to)}${s.highlights ? ` · ${s.highlights} highlight${s.highlights > 1 ? 's' : ''}` : ''}`
    await this.app.vault.process(daily, md => {
      const heading = '## Reading'
      if (!md.includes(heading)) return `${md.replace(/\s+$/, '')}\n\n${heading}\n${line}\n`
      const lines = md.split('\n')
      let i = lines.findIndex(l => l.trim() === heading) + 1
      while (i < lines.length && lines[i]!.startsWith('- ')) i++
      lines.splice(i, 0, line)
      return lines.join('\n')
    })
  }

  private async dailyNote(): Promise<TFile | null> {
    // Read the core Daily notes options when available; fall back to YYYY-MM-DD at the vault root.
    const opts = (this.app as any).internalPlugins?.getPluginById?.('daily-notes')?.instance?.options ?? {}
    const format: string = opts.format || 'YYYY-MM-DD'
    const folder: string = opts.folder || ''
    const path = normalizePath(`${folder ? folder + '/' : ''}${moment().format(format)}.md`)
    const f = this.app.vault.getAbstractFileByPath(path)
    if (f instanceof TFile) return f
    try {
      await this.ensureFolder(path.split('/').slice(0, -1).join('/'))
      return await this.app.vault.create(path, '')
    } catch (e) {
      new Notice('Octavo: could not create today\'s daily note')
      return null
    }
  }

  async saveCover(id: string, blob: Blob | null): Promise<string | undefined> {
    if (!blob) return undefined
    const folder = normalizePath(this.settings().coversFolder || 'Books/covers')
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'
    const path = normalizePath(`${folder}/${id}.${ext}`)
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.ensureFolder(folder)
      await this.app.vault.createBinary(path, await blob.arrayBuffer())
    }
    return path
  }
}
