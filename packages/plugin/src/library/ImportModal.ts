import { App, Modal, Notice, Setting, TFile, moment } from 'obsidian'
import {
  cleanBookName, importAnnotator, importZotero, isZoteroNote, importElton, importWeave, importKindle, importKoreaderSidecar, importKoreaderJson, importReadestFiles,
  parseHighlights, upsertHighlight, citekeyFrom, importNotePath, type ImportedBook, type NoteKind,
} from '@octavo/shared'
import type OctavoPlugin from '../main'
import { isBookFile } from './BookLibrary'
import { propText } from './dedupe'

type Source = 'annotator' | 'elton' | 'weave' | 'kindle' | 'koreader' | 'readest' | 'zotero'

const SOURCES: Array<[Source, string, string]> = [
  ['annotator', 'Annotator', 'Scans your vault for Annotator notes (annotation-target).'],
  ['elton', 'Elton Book Reader', 'Reads reading-highlights.json and reading-progress.json at the vault root.'],
  ['weave', 'Weave EPUB Reader', 'Reads reading position and status from Weave data notes.'],
  ['kindle', 'Kindle', 'Pick your “My Clippings.txt” from the Kindle’s documents folder.'],
  ['koreader', 'KOReader', 'Pick metadata.*.lua sidecars (book.sdr folders) or an exported highlights .json.'],
  ['readest', 'Readest', 'Pick a book’s config.json and library.json from Readest’s Books folder.'],
  ['zotero', 'Zotero', 'Scans your vault for Zotero Integration literature notes (annotations with zotero://open-pdf links) and adds them to the matching PDF.'],
]

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()

/** One-click "Switch to Octavo": imports highlights and positions from other readers into book notes. */
export class ImportModal extends Modal {
  constructor(app: App, private plugin: OctavoPlugin) { super(app) }

  onOpen() {
    this.setTitle('Import highlights')
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'Highlights are added to each book’s note (duplicates are skipped). Imported highlights without a precise position are located by their text the first time you open the book.' })
    for (const [id, name, desc] of SOURCES) {
      new Setting(this.contentEl).setName(name).setDesc(desc).addButton(b => b.setButtonText('Import').onClick(() => void this.run(id)))
    }
  }

  private pickFiles(accept: string, multiple = true): Promise<File[]> {
    return new Promise(resolve => {
      const input = createEl('input')
      input.type = 'file'; input.accept = accept; input.multiple = multiple
      input.onchange = () => resolve(Array.from(input.files ?? []))
      input.click()
    })
  }

  private async run(source: Source) {
    let books: ImportedBook[] = []
    const vault = this.app.vault
    const sourcePaths = new Set<string>() // the notes highlights were read from: never written to
    try {
      if (source === 'annotator' || source === 'weave') {
        for (const f of vault.getMarkdownFiles()) {
          const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
          if (source === 'annotator' && !fm?.['annotation-target']) continue
          const md = await vault.cachedRead(f)
          if (source === 'weave' && !md.includes('weave-epub-state')) continue
          const b = source === 'annotator' ? importAnnotator(md) : importWeave(md)
          if (b) { books.push(b); sourcePaths.add(f.path) }
        }
      } else if (source === 'zotero') {
        for (const f of vault.getMarkdownFiles()) {
          const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
          if (fm?.['octavo-id'] || fm?.['octavo-export']) continue
          const md = await vault.cachedRead(f)
          if (!isZoteroNote(md)) continue
          const b = importZotero(md)
          if (b) { books.push(b); sourcePaths.add(f.path) }
        }
        if (!books.length) { new Notice('No Zotero annotations found. Import them into a note with Zotero Integration first.'); return }
      } else if (source === 'elton') {
        const read = async (p: string) => (await vault.adapter.exists(p)) ? vault.adapter.read(p) : null
        const hl = await read('reading-highlights.json')
        if (!hl) { new Notice('No reading-highlights.json found at the vault root.'); return }
        books = importElton(hl, (await read('reading-progress.json')) ?? undefined)
      } else if (source === 'kindle') {
        for (const f of await this.pickFiles('.txt', false)) books.push(...importKindle(await f.text()))
      } else if (source === 'koreader') {
        for (const f of await this.pickFiles('.lua,.json')) {
          const t = await f.text()
          if (f.name.endsWith('.json')) books.push(...importKoreaderJson(t))
          else books.push(importKoreaderSidecar(t))
        }
      } else if (source === 'readest') {
        const files = await Promise.all((await this.pickFiles('.json')).map(async f => ({ name: f.name, text: await f.text() })))
        books = importReadestFiles(files)
        if (books.some(b => !b.title && b.highlights.length)) { new Notice('Select library.json (in Readest’s Books folder) together with config.json so highlights reach the right book.'); return }
      }
    } catch (e) {
      new Notice(`Import failed: ${(e as Error).message}`)
      return
    }
    const r = await importBooks(this.plugin, books, { source: SOURCES.find(s => s[0] === source)?.[1] ?? 'Imported', sourcePaths })
    new Notice(`Imported ${r.highlights} highlight${r.highlights === 1 ? '' : 's'} into ${r.notes} book note${r.notes === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} duplicates skipped)` : ''}.`)
  }

  onClose() { this.contentEl.empty() }
}

export async function importBooks(plugin: OctavoPlugin, books: ImportedBook[], opts: { source?: string; sourcePaths?: Set<string> } = {}) {
  const app = plugin.app
  const bookFiles = app.vault.getFiles().filter(f => isBookFile(f))
  let notes = 0, highlights = 0, skipped = 0
  for (const b of books) {
    if (!b.highlights.length && !b.position && !b.status) continue
    let file: TFile | null = null
    if (b.bookPath) {
      const f = app.vault.getAbstractFileByPath(b.bookPath) ?? app.metadataCache.getFirstLinkpathDest(b.bookPath.split('/').pop() ?? '', '')
      if (f instanceof TFile) file = f
    }
    const want = [b.title, b.bookPath ? cleanBookName(b.bookPath.split('/').pop()!).title : undefined].filter(Boolean).map(t => norm(t!))
    if (!file && want.length) {
      const score = (f: TFile) => {
        const names = [norm(f.basename), norm(cleanBookName(f.name).title), norm(propText(plugin.library.noteFor(f) ? plugin.library.getProps(plugin.library.noteFor(f)!).title ?? '' : ''))].filter(Boolean)
        let best = 0
        for (const w of want) for (const n of names) {
          if (w === n) best = Math.max(best, 3)
          else if (n.length > 6 && w.length > 6 && (w.includes(n) || n.includes(w))) best = Math.max(best, 2)
        }
        return best
      }
      file = bookFiles.map(f => [f, score(f)] as const).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    }
    const title = b.title ?? (file ? cleanBookName(file.name).title : b.bookPath ? cleanBookName(b.bookPath.split('/').pop()!).title : 'Imported book')
    let note: TFile | null = file ? plugin.library.noteFor(file) : null
    if (!note && file) note = await plugin.library.ensureNote(file, { id: `import-${Date.now().toString(36)}`, title, author: b.author, format: file.extension })
    if (!note) {
      if (!b.highlights.length) continue // progress for a book that isn't in this vault: nothing worth a note
      note = await orphanNote(plugin, title, b.author, opts.source ?? 'Imported', opts.sourcePaths ?? new Set())
      if (!note) { console.warn(`Octavo: skipped importing "${title}": its note names are taken by other notes`); continue }
    }
    notes++
    const existing = new Set(parseHighlights(await app.vault.read(note)).map(h => norm(h.anchor.quote.exact)))
    for (const h of b.highlights) {
      if (existing.has(norm(h.anchor.quote.exact))) { skipped++; continue }
      existing.add(norm(h.anchor.quote.exact))
      const link = file ? plugin.library.linkFor(file, note, h) : ''
      await app.vault.process(note, md => upsertHighlight(md, h, link))
      highlights++
    }
    const props: Record<string, unknown> = { highlights: parseHighlights(await app.vault.read(note)).length }
    const cur = plugin.library.getProps(note)
    if (b.position?.cfi && !cur.position) props.position = b.position.cfi
    if (b.position?.fraction !== undefined && !(Number(cur.progress) > 0)) props.progress = Math.round(b.position.fraction * 1000) / 1000
    if (b.citekey && !citekeyFrom(cur)) props.citekey = b.citekey
    if (b.status && (!cur.status || cur.status === 'reading')) props.status = b.status
    if (b.lastRead && !cur['last-read']) props['last-read'] = moment(b.lastRead).format('YYYY-MM-DDTHH:mm')
    await plugin.library.setProps(note, props)
  }
  return { notes, highlights, skipped }
}

/**
 * A note for a book that isn't in the vault (e.g. Kindle). It is linked automatically if the book is added later with the
 * same title. An existing note is reused only when it is a book note: never the note the highlights were imported from
 * (a Zotero literature note) or any other note; then `<title> (<source>).md` is used, else the book is skipped (null).
 */
async function orphanNote(plugin: OctavoPlugin, title: string, author: string | undefined, source: string, sourcePaths: Set<string>): Promise<TFile | null> {
  const app = plugin.app
  const folder = plugin.settings.booksFolder || 'Books'
  const kindAt = (p: string): NoteKind => {
    const f = app.vault.getAbstractFileByPath(p)
    if (!f) return 'missing'
    if (!(f instanceof TFile) || f.extension !== 'md' || sourcePaths.has(f.path)) return 'other'
    const fm = app.metadataCache.getFileCache(f)?.frontmatter
    if (fm?.['octavo-id']) return 'book'
    const tags = Array.isArray(fm?.tags) ? fm.tags.map(String) : typeof fm?.tags === 'string' ? fm.tags.split(/[,\s]+/) : []
    return tags.includes('book') && !fm?.['octavo-export'] && !fm?.['annotation-target'] ? 'book' : 'other'
  }
  const path = importNotePath(folder, title, source, kindAt)
  if (!path) return null
  const f = app.vault.getAbstractFileByPath(path)
  if (f instanceof TFile) return f
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder).catch(() => {})
  return app.vault.create(path, `---\ntitle: ${JSON.stringify(title)}\n${author ? `author: ${JSON.stringify(author)}\n` : ''}status: reading\ntags:\n  - book\n---\n\n# ${title}\n\n## Highlights\n`)
}
