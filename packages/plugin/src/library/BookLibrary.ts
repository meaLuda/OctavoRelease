import { App, TFile, normalizePath, moment, Notice } from 'obsidian'
import {
  parseHighlights, upsertHighlight, removeHighlight, parseSubpath, formatCfiSubpath, formatPdfSubpath,
  HIGHLIGHTS_HEADING, type Highlight, type ParsedHighlight, type Subpath,
} from '@octavo/shared'
import type { OctavoSettings } from '../settings'
import { groupDuplicates, mergeHighlightBlocks, mergeProps, type NoteInfo } from './dedupe'

export interface RepairResult { groups: number; removed: number; highlights: number; links: number }

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
  /** Notes created or adopted this session (book path / `id:<octavo-id>` → note path). Survives reindex while the metadata cache catches up. */
  private recent = new Map<string, string>()
  private indexed = false
  constructor(private app: App, private settings: () => OctavoSettings) {}

  /** Rebuild the book→note index from frontmatter `book` links. */
  reindex(): void {
    this.noteByBook.clear()
    for (const f of this.app.vault.getMarkdownFiles()) this.indexNote(f)
    for (const [k, n] of this.recent) {
      if (k.startsWith('id:') || this.noteByBook.has(k)) continue
      if (this.app.vault.getAbstractFileByPath(n) instanceof TFile) this.noteByBook.set(k, n)
    }
    this.indexed = true
  }

  indexNote(f: TFile): void {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
    if (!fm || !fm['octavo-id']) return
    const book = this.resolveBookLink(fm.book, f.path)
    if (book) this.noteByBook.set(book.path, f.path)
  }

  forgetNote(path: string): void {
    for (const [k, v] of this.noteByBook) if (v === path) this.noteByBook.delete(k)
    for (const [k, v] of this.recent) if (v === path) this.recent.delete(k)
  }

  renameBook(oldPath: string, newPath: string): void {
    const n = this.noteByBook.get(oldPath)
    if (n) { this.noteByBook.delete(oldPath); this.noteByBook.set(newPath, n) }
    const r = this.recent.get(oldPath)
    if (r) { this.recent.delete(oldPath); this.recent.set(newPath, r) }
  }

  private resolveBookLink(v: unknown, sourcePath: string): TFile | null {
    if (typeof v !== 'string') return null
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(v.trim()) ?? /^\[[^\]]*\]\(([^)#]+)\)$/.exec(v.trim())
    const linkpath = m ? decodeURI(m[1]) : v
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
  }

  /**
   * The book's note: the index, then notes created this session (the metadata cache may not have
   * indexed them yet). Before the first reindex (views restored at startup) the index is built first.
   * ensureNote additionally scans notes' frontmatter before it creates anything.
   */
  noteFor(book: TFile): TFile | null {
    if (!this.indexed) this.reindex()
    for (const p of [this.noteByBook.get(book.path), this.recent.get(book.path)]) {
      const f = p ? this.app.vault.getAbstractFileByPath(p) : null
      if (f instanceof TFile) return f
    }
    return null
  }

  private remember(book: TFile, id: string, note: TFile): void {
    this.noteByBook.set(book.path, note.path)
    this.recent.set(book.path, note.path)
    if (id) this.recent.set(`id:${id}`, note.path)
  }

  /** octavo-id and book link of a note, from the metadata cache or (not indexed yet) the file's own frontmatter. */
  private async noteKeys(f: TFile): Promise<{ id?: string; book?: unknown } | null> {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
    if (fm) return { id: fm['octavo-id'] != null ? String(fm['octavo-id']) : undefined, book: fm.book }
    const md = await this.app.vault.cachedRead(f).catch(() => '')
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1]
    if (!head) return null
    const val = (k: string) => {
      const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim()
      if (!m) return undefined
      try { return m.startsWith('"') ? String(JSON.parse(m)) : m.replace(/^'(.*)'$/, '$1') } catch { return m }
    }
    return { id: val('octavo-id'), book: val('book') }
  }

  /** Is this note the book's note: same octavo-id (and not linked to another book), or linked to this book? */
  private async isNoteOf(f: TFile, book: TFile, id: string): Promise<boolean> {
    const k = await this.noteKeys(f)
    if (!k?.id) return false
    const linked = this.resolveBookLink(k.book, f.path)
    if (linked) return linked.path === book.path
    return !!id && k.id === id
  }

  /** Slow path before creating a note: scan notes' frontmatter (cache, or the file itself when not indexed yet). */
  private async findExisting(book: TFile, id: string): Promise<TFile | null> {
    const recent = this.recent.get(`id:${id}`)
    const r = recent ? this.app.vault.getAbstractFileByPath(recent) : null
    if (r instanceof TFile && await this.isNoteOf(r, book, id)) return r
    const folder = normalizePath(this.settings().booksFolder || 'Books') + '/'
    for (const f of this.app.vault.getMarkdownFiles()) {
      // notes the cache has not indexed are read only in the book notes folder
      if (!this.app.metadataCache.getFileCache(f) && !f.path.startsWith(folder)) continue
      if (await this.isNoteOf(f, book, id)) return f
    }
    return null
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
    // keyed by book path AND octavo id: the library, a reader view and an import share one creation
    const keys = [book.path, `id:${meta.id}`]
    const pending = keys.map(k => this.creating.get(k)).find(Boolean)
    if (pending) return pending
    const p = this.ensureNoteOnce(book, meta).finally(() => { for (const k of keys) if (this.creating.get(k) === p) this.creating.delete(k) })
    for (const k of keys) this.creating.set(k, p)
    return p
  }

  private async ensureNoteOnce(book: TFile, meta: BookMeta): Promise<TFile> {
    const existing = this.noteFor(book) ?? await this.findExisting(book, meta.id)
    if (existing) { this.remember(book, meta.id, existing); return existing }
    const adopted = await this.adoptOrphan(book, meta)
    if (adopted) return adopted
    const folder = normalizePath(this.settings().booksFolder || 'Books')
    await this.ensureFolder(folder)
    let path = normalizePath(`${folder}/${sanitize(meta.title || book.basename)}.md`)
    for (let i = 2; ; i++) {
      const at = this.app.vault.getAbstractFileByPath(path)
      if (!at) break
      // a note for this very book already sits at the target path (cache not caught up): reuse it
      if (at instanceof TFile && await this.isNoteOf(at, book, meta.id)) { this.remember(book, meta.id, at); return at }
      path = normalizePath(`${folder}/${sanitize(meta.title || book.basename)} ${i}.md`)
    }
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
    this.remember(book, meta.id, note)
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
      this.remember(book, meta.id, f)
      return f
    }
    return null
  }

  /**
   * Merge book notes that share an octavo-id or book link into the oldest one: highlight blocks
   * (deduped by id), furthest progress, latest last-read; links to the duplicates are pointed at
   * the kept note, then the duplicates go to the system trash.
   */
  async repairDuplicates(): Promise<RepairResult> {
    const mc = this.app.metadataCache
    const notes: Array<NoteInfo & { file: TFile }> = []
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = mc.getFileCache(f)?.frontmatter
      if (!fm?.['octavo-id'] || fm['octavo-export']) continue
      notes.push({ file: f, path: f.path, id: String(fm['octavo-id']), book: this.resolveBookLink(fm.book, f.path)?.path, ctime: f.stat.ctime })
    }
    const res: RepairResult = { groups: 0, removed: 0, highlights: 0, links: 0 }
    for (const { keep, dups } of groupDuplicates(notes)) {
      res.groups++
      const dupMds = await Promise.all(dups.map(d => this.app.vault.read(d.file)))
      let added = 0
      await this.app.vault.process(keep.file, md => { const r = mergeHighlightBlocks(md, dupMds); added = r.added; return r.md })
      res.highlights += added
      const props = mergeProps(this.getProps(keep.file), dups.map(d => this.getProps(d.file)))
      let count = 0
      await this.app.vault.process(keep.file, md => { count = parseHighlights(md).length; return md })
      await this.setProps(keep.file, { ...props, highlights: count })
      for (const d of dups) {
        res.links += await this.relink(d.file, keep.file)
        this.forgetNote(d.path)
        await this.app.fileManager.trashFile(d.file)
        res.removed++
      }
      const book = keep.book ? this.app.vault.getAbstractFileByPath(keep.book) : null
      if (book instanceof TFile) this.remember(book, keep.id, keep.file)
    }
    return res
  }

  /** Point every link to `from` (outside `from` itself) at `to`, keeping subpath and alias. Returns links rewritten. */
  private async relink(from: TFile, to: TFile): Promise<number> {
    const mc = this.app.metadataCache
    let n = 0
    for (const [source, dests] of Object.entries(mc.resolvedLinks)) {
      if (source === from.path || !dests?.[from.path]) continue
      const src = this.app.vault.getAbstractFileByPath(source)
      if (!(src instanceof TFile)) continue
      const cache = mc.getFileCache(src)
      const swaps = new Map<string, string>()
      for (const l of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
        const linkpath = l.link.split('#')[0]
        if (mc.getFirstLinkpathDest(linkpath, source)?.path !== from.path) continue
        const sub = l.link.slice(linkpath.length)
        const alias = l.original.includes('|') || /^!?\[[^\]]+\]\(/.test(l.original) ? l.displayText : undefined
        const out = this.app.fileManager.generateMarkdownLink(to, source, sub, alias)
        swaps.set(l.original, l.original.startsWith('!') && !out.startsWith('!') ? '!' + out : out)
      }
      if (!swaps.size) continue
      await this.app.vault.process(src, md => {
        for (const [a, b] of swaps) { const parts = md.split(a); n += parts.length - 1; md = parts.join(b) }
        return md
      })
    }
    return n
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
    await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined) delete fm[k]
        else fm[k] = v
      }
    })
  }

  getProps(note: TFile): Record<string, unknown> {
    return this.app.metadataCache.getFileCache(note)?.frontmatter ?? {}
  }

  async highlights(note: TFile): Promise<ParsedHighlight[]> {
    return parseHighlights(await this.app.vault.cachedRead(note))
  }

  linkFor(book: TFile, note: TFile, h: Highlight): string {
    return this.linkFrom(book, note.path, h)
  }

  /** Deep link to a highlight, written from any note (e.g. an exported literature note). */
  linkFrom(book: TFile, sourcePath: string, h: Highlight): string {
    const sub = h.anchor.cfi ? formatCfiSubpath(h.anchor.cfi, h.color)
      : h.anchor.pdf ? formatPdfSubpath(h.anchor.pdf, h.color) : ''
    return this.app.fileManager.generateMarkdownLink(book, sourcePath, sub, '↗').replace(/^!/, '')
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
      // exported literature notes repeat the book's own highlights: not backlinks
      if (cache?.frontmatter?.['octavo-export']) continue
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
      while (i < lines.length && lines[i].startsWith('- ')) i++
      lines.splice(i, 0, line)
      return lines.join('\n')
    })
  }

  private async dailyNote(): Promise<TFile | null> {
    // Read the core Daily notes options when available; fall back to YYYY-MM-DD at the vault root.
    type Internal = { internalPlugins?: { getPluginById?(id: string): { instance?: { options?: { format?: string; folder?: string } } } | null } }
    const opts = (this.app as App & Internal).internalPlugins?.getPluginById?.('daily-notes')?.instance?.options ?? {}
    const format = opts.format || 'YYYY-MM-DD'
    const folder = opts.folder || ''
    const path = normalizePath(`${folder ? folder + '/' : ''}${moment().format(format)}.md`)
    const f = this.app.vault.getAbstractFileByPath(path)
    if (f instanceof TFile) return f
    try {
      await this.ensureFolder(path.split('/').slice(0, -1).join('/'))
      return await this.app.vault.create(path, '')
    } catch {
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
