import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, moment, normalizePath, setIcon, loadPdfJs, debounce } from 'obsidian'
import { besideLeaf, canPopout } from '../platform'
import { cleanBookName, isJunkTitle, normalizeAuthors, tidyTitle } from '@octavo/shared'
import { makeBook } from '@octavo/foliate/view.js'
import type OctavoPlugin from '../main'
import { BOOK_EXTENSIONS } from './BookLibrary'
import { metaCache, metaKey } from './metaCache'
import { CollectionModal, TextPromptModal } from '../reader/modals'
import { parseStub, STUB_MAX } from '../cloud/stub'
import { openPdfDocument } from '../pdf/source'
import {
  FACETS, FACET_LABEL, collectionEdit, describeFilter, emptyFilter, facetCount, facetValues, isEmptyFilter, makeSmartCollection,
  matchesFilter, normalizeFilter, renameCollectionInSmart, seriesOf, tagsOf, toggleFacet, type Facet, type LibFilter,
} from './organise'
import { ConfirmModal, FacetSuggestModal, onContextOrLongPress } from './filterUi'

export const LIBRARY_VIEW = 'octavo-library'

type Shelf = 'all' | 'reading' | 'want' | 'finished' | 'new' | `c:${string}` | `s:${string}`

interface BookItem {
  file: TFile
  path: string
  note: TFile | null
  title: string
  author?: string
  status: 'reading' | 'want' | 'finished' | 'abandoned' | 'new'
  progress: number
  lastRead: number
  added: number
  collections: string[]
  tags: string[]
  series?: string
  highlights: number
  cover: string | null // resource URL or blob URL
  format: string
  cloud: boolean
}

/**
 * The Octavo Library: a calm, Apple-Books-style shelf of the books in your
 * vault. Every entry is backed by a normal book note (properties = data), so
 * collections and statuses also work in Bases, search and Dataview.
 */
export class LibraryView extends ItemView {
  private shelf: Shelf = 'all'
  private query = ''
  /** Facet filter (folder, tag, series, author, format) shown as removable pills. */
  private filter: LibFilter = emptyFilter()
  /** Smart collection whose filters are loaded for editing ("Update" replaces its spec). */
  private editingSmart: string | null = null
  private items: BookItem[] = []
  private blobUrls: string[] = []
  private queue: BookItem[] = []
  private working = false
  private io: IntersectionObserver | null = null
  private bodyEl!: HTMLElement
  private refreshSoon = debounce(() => this.refresh(), 400, true)

  constructor(leaf: WorkspaceLeaf, private plugin: OctavoPlugin) { super(leaf) }
  getViewType() { return LIBRARY_VIEW }
  getDisplayText() { return 'Library' }
  getIcon() { return 'octavo' }

  async onOpen() {
    await this.plugin.ready
    this.contentEl.empty()
    this.contentEl.addClass('octavo-library')
    this.bodyEl = this.contentEl.createDiv({ cls: 'octavo-lib' })
    this.registerEvent(this.app.metadataCache.on('changed', f => { if (this.plugin.library.bookForNote(f)) this.refreshSoon() }))
    // Watch folders: books dropped (or moved) into the scanned folders appear without reopening the library.
    // A copy can arrive empty and grow, so a book file's first 'modify' also counts (PDF size threshold).
    const watched = (f: unknown) => this.plugin.settings.library.watch && f instanceof TFile && this.isBookExt(f)
    this.registerEvent(this.app.vault.on('create', f => { if (watched(f) && this.isCandidate(f as TFile)) this.refreshSoon() }))
    this.registerEvent(this.app.vault.on('modify', f => { if (watched(f) && !this.items.some(i => i.file === f) && this.isCandidate(f as TFile)) this.refreshSoon() }))
    this.registerEvent(this.app.vault.on('delete', () => this.refreshSoon()))
    this.registerEvent(this.app.vault.on('rename', () => this.refreshSoon()))
    this.refresh()
  }

  async onClose() {
    this.io?.disconnect()
    for (const u of this.blobUrls) URL.revokeObjectURL(u)
  }

  // ───────────────────────── data ─────────────────────────

  private isBookExt(f: TFile): boolean {
    return (BOOK_EXTENSIONS as readonly string[]).includes(f.extension) || f.extension === 'pdf'
  }

  private isCandidate(f: TFile): boolean {
    const lib = this.plugin.settings.library
    if (lib.hidden.includes(f.path)) return false
    if (!this.isBookExt(f)) return false
    if (lib.folders.length && !lib.folders.some(d => f.path.startsWith(normalizePath(d) + '/'))) {
      return !!this.plugin.library.noteFor(f)
    }
    if (f.extension === 'pdf') {
      // PDFs: books, not receipts. Small PDFs count only once you've opened them as a book.
      return !!this.plugin.library.noteFor(f) || f.stat.size >= lib.minPdfMB * 1024 * 1024 || f.stat.size <= STUB_MAX
    }
    return true
  }

  private collect(): BookItem[] {
    const out: BookItem[] = []
    for (const f of this.app.vault.getFiles()) {
      if (!this.isCandidate(f)) continue
      const note = this.plugin.library.noteFor(f)
      const fm = note ? this.plugin.library.getProps(note) : {}
      const clean = cleanBookName(f.name)
      const coverFile = note ? this.linkTarget(fm.cover, note.path) : null
      const status = (['reading', 'want', 'finished', 'abandoned'].includes(fm.status) ? fm.status : note ? 'reading' : 'new') as BookItem['status']
      const lastRead = fm['last-read'] ? moment(String(fm['last-read'])).valueOf() : 0
      out.push({
        file: f, note, path: f.path,
        title: String(fm.title ?? clean.title),
        author: normalizeAuthors(fm.author) ?? clean.author,
        status: status === 'reading' && !(Number(fm.progress) > 0) && !lastRead ? 'new' : status,
        progress: Number(fm.progress) || 0,
        lastRead,
        added: f.stat.ctime,
        collections: toList(fm.collections),
        tags: tagsOf(fm.tags),
        series: seriesOf(fm.series),
        highlights: Number(fm.highlights) || 0,
        cover: coverFile ? this.app.vault.getResourcePath(coverFile) : null,
        format: f.extension,
        cloud: f.stat.size <= STUB_MAX,
      })
    }
    return out
  }

  private linkTarget(v: unknown, source: string): TFile | null {
    if (typeof v !== 'string') return null
    const m = /\[\[([^\]|#]+)/.exec(v)
    return this.app.metadataCache.getFirstLinkpathDest(m ? m[1]! : v, source)
  }

  refresh() {
    this.items = this.collect()
    this.render()
  }

  // ───────────────────────── render ─────────────────────────

  private render() {
    const root = this.bodyEl
    const lib = this.plugin.settings.library
    root.empty()
    this.io?.disconnect()
    this.io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { this.io?.unobserve(e.target); this.enqueue((e.target as any).__item) } }, { root: this.contentEl, rootMargin: '400px' })

    // header
    const head = root.createDiv({ cls: 'octavo-lib-head' })
    const titleWrap = head.createDiv({ cls: 'octavo-lib-titlewrap' })
    titleWrap.createEl('h1', { cls: 'octavo-lib-title', text: 'Library' })
    titleWrap.createDiv({ cls: 'octavo-lib-count', text: `${this.items.length} book${this.items.length === 1 ? '' : 's'}` })
    const tools = head.createDiv({ cls: 'octavo-lib-tools' })
    const search = tools.createEl('input', { cls: 'octavo-lib-search', attr: { type: 'search', placeholder: 'Search title or author', 'aria-label': 'Search library' } })
    search.value = this.query
    search.oninput = () => { this.query = search.value; this.renderShelf(grid) }
    const sort = tools.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Sort' } })
    for (const [v, l] of [['recent', 'Recently read'], ['added', 'Recently added'], ['title', 'Title'], ['author', 'Author'], ['progress', 'Progress']] as const) {
      const o = sort.createEl('option', { text: l, value: v }); if (v === lib.sort) o.selected = true
    }
    sort.onchange = () => { lib.sort = sort.value as typeof lib.sort; void this.plugin.saveSettings(); this.renderShelf(grid) }
    const modeBtn = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': lib.mode === 'grid' ? 'List view' : 'Grid view' } })
    setIcon(modeBtn, lib.mode === 'grid' ? 'list' : 'layout-grid')
    modeBtn.onclick = () => { lib.mode = lib.mode === 'grid' ? 'list' : 'grid'; void this.plugin.saveSettings(); this.render() }
    const add = tools.createEl('button', { cls: 'mod-cta octavo-lib-add', text: 'Add books' })
    add.onclick = () => void this.addBooks()

    // continue reading
    const recent = this.items.filter(i => i.status === 'reading' && i.lastRead).sort((a, b) => b.lastRead - a.lastRead).slice(0, 3)
    if (recent.length && !this.query) {
      const cont = root.createDiv({ cls: 'octavo-lib-continue' })
      cont.createDiv({ cls: 'octavo-lib-section', text: 'Continue reading' })
      const row = cont.createDiv({ cls: 'octavo-lib-continue-row' })
      for (const it of recent) {
        const card = row.createDiv({ cls: 'octavo-lib-hero', attr: { role: 'button', tabindex: '0' } })
        this.coverEl(card.createDiv({ cls: 'octavo-lib-hero-cover' }), it)
        const info = card.createDiv({ cls: 'octavo-lib-hero-info' })
        info.createDiv({ cls: 'octavo-lib-hero-title', text: it.title })
        if (it.author) info.createDiv({ cls: 'octavo-lib-hero-author', text: it.author })
        const bar = info.createDiv({ cls: 'octavo-lib-bar' }); bar.setCssProps({ '--p': `${it.progress * 100}%` })
        info.createDiv({ cls: 'octavo-lib-hero-meta', text: `${Math.round(it.progress * 100)}% · ${moment(it.lastRead).fromNow()}` })
        const resume = info.createEl('button', { cls: 'mod-cta', text: 'Resume' })
        resume.onclick = e => { e.stopPropagation(); this.openBook(it, false) }
        this.wireCard(card, it)
      }
    }

    // shelves
    const chips = root.createDiv({ cls: 'octavo-lib-chips', attr: { role: 'tablist' } })
    const count = (f: (i: BookItem) => boolean) => this.items.filter(f).length
    const shelves: Array<[Shelf, string, number]> = [
      ['all', 'All', this.items.length],
      ['reading', 'Reading', count(i => i.status === 'reading')],
      ['want', 'Want to read', count(i => i.status === 'want')],
      ['new', 'Not started', count(i => i.status === 'new')],
      ['finished', 'Finished', count(i => i.status === 'finished')],
    ]
    const cols = [...new Set(this.items.flatMap(i => i.collections))].sort()
    for (const c of cols) shelves.push([`c:${c}`, c, count(i => i.collections.includes(c))])
    const smart = lib.smart ?? []
    if (this.shelf.startsWith('s:') && !smart.some(x => `s:${x.id}` === this.shelf)) this.shelf = 'all'
    for (const x of smart) shelves.push([`s:${x.id}`, x.name, count(i => matchesFilter(i, x.filter))])
    for (const [id, label, n] of shelves) {
      if (n === 0 && id !== 'all' && !id.startsWith('c:') && !id.startsWith('s:') && id !== this.shelf) continue
      const kind = id.startsWith('c:') ? ' is-collection' : id.startsWith('s:') ? ' is-smart' : ''
      const b = chips.createEl('button', { cls: `octavo-lib-chip${this.shelf === id ? ' is-active' : ''}${kind}`, attr: { role: 'tab', 'aria-selected': String(this.shelf === id), 'data-shelf': id } })
      if (id.startsWith('c:')) setIcon(b.createSpan({ cls: 'octavo-lib-chip-icon' }), 'folder-heart')
      if (id.startsWith('s:')) setIcon(b.createSpan({ cls: 'octavo-lib-chip-icon' }), 'sparkles')
      b.createSpan({ text: label })
      b.createSpan({ cls: 'octavo-lib-chip-n', text: String(n) })
      b.onclick = () => { this.shelf = id; this.render() }
      if (id.startsWith('c:')) onContextOrLongPress(b, e => this.collectionMenu(id.slice(2), e))
      if (id.startsWith('s:')) onContextOrLongPress(b, e => this.smartMenu(id.slice(2), e))
    }
    const newCol = chips.createEl('button', { cls: 'octavo-lib-chip is-ghost', attr: { 'aria-label': 'New collection' } })
    setIcon(newCol, 'plus')
    newCol.onclick = () => void this.newCollection(cols)

    this.renderFilterBar(root)

    const grid = root.createDiv({ cls: `octavo-lib-grid is-${lib.mode}` })
    grid.setCssProps({ '--card': `${lib.size}px` })
    this.renderShelf(grid)

    if (lib.mode === 'grid') {
      const zoom = root.createDiv({ cls: 'octavo-lib-zoom' })
      const minus = zoom.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Smaller covers' } }); setIcon(minus, 'minus')
      const plus = zoom.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Larger covers' } }); setIcon(plus, 'plus')
      minus.onclick = () => { lib.size = Math.max(100, lib.size - 20); grid.setCssProps({ '--card': `${lib.size}px` }); void this.plugin.saveSettings() }
      plus.onclick = () => { lib.size = Math.min(260, lib.size + 20); grid.setCssProps({ '--card': `${lib.size}px` }); void this.plugin.saveSettings() }
    }
  }

  private visible(): BookItem[] {
    const q = this.query.trim().toLowerCase()
    const s = this.shelf
    const lib = this.plugin.settings.library
    const list = this.items.filter(i =>
      (s === 'all' || (s.startsWith('c:') ? i.collections.includes(s.slice(2)) : s.startsWith('s:') ? this.matchesSmart(i, s.slice(2)) : i.status === s)) &&
      matchesFilter(i, this.filter) &&
      (!q || i.title.toLowerCase().includes(q) || (i.author ?? '').toLowerCase().includes(q) || i.file.basename.toLowerCase().includes(q)))
    const by: Record<typeof lib.sort, (a: BookItem, b: BookItem) => number> = {
      recent: (a, b) => b.lastRead - a.lastRead || b.added - a.added,
      added: (a, b) => b.added - a.added,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => (a.author ?? '~').localeCompare(b.author ?? '~') || a.title.localeCompare(b.title),
      progress: (a, b) => b.progress - a.progress,
    }
    return list.sort(by[lib.sort])
  }

  private matchesSmart(i: BookItem, id: string): boolean {
    const sc = (this.plugin.settings.library.smart ?? []).find(x => x.id === id)
    return !sc || matchesFilter(i, sc.filter)
  }

  // ───────────────────────── filters & smart collections ─────────────────────────

  /** "Filter" button, active filters as removable pills, and Save / Update smart collection. */
  private renderFilterBar(root: HTMLElement) {
    const bar = root.createDiv({ cls: 'octavo-lib-filters' })
    const n = facetCount(this.filter)
    const btn = bar.createEl('button', { cls: `octavo-lib-filter-btn${n ? ' is-active' : ''}`, attr: { 'aria-label': 'Filter books', 'aria-haspopup': 'menu' } })
    setIcon(btn.createSpan({ cls: 'octavo-lib-chip-icon' }), 'filter')
    btn.createSpan({ text: n ? `Filter · ${n}` : 'Filter' })
    btn.onclick = e => this.filterMenu(e)
    for (const k of FACETS) for (const v of this.filter[k]) {
      const pill = bar.createEl('button', { cls: 'octavo-lib-pill', attr: { 'aria-label': `Remove filter ${FACET_LABEL[k]}: ${v}`, 'data-facet': k, 'data-value': v } })
      pill.createSpan({ cls: 'octavo-lib-pill-k', text: FACET_LABEL[k] })
      pill.createSpan({ cls: 'octavo-lib-pill-v', text: k === 'folders' ? (v.split('/').pop() ?? v) : v })
      setIcon(pill.createSpan({ cls: 'octavo-lib-pill-x' }), 'x')
      pill.onclick = () => { this.filter = toggleFacet(this.filter, k, v); this.render() }
    }
    const editing = this.editingSmart ? (this.plugin.settings.library.smart ?? []).find(x => x.id === this.editingSmart) : undefined
    if (editing) {
      const up = bar.createEl('button', { cls: 'octavo-lib-pill is-action mod-cta octavo-lib-smart-update', text: `Update “${editing.name}”` })
      up.onclick = () => void this.updateSmart(editing.id)
      const cancel = bar.createEl('button', { cls: 'octavo-lib-pill is-action', text: 'Cancel' })
      cancel.onclick = () => { this.editingSmart = null; this.filter = emptyFilter(); this.render() }
      return
    }
    if (!n) return
    const save = bar.createEl('button', { cls: 'octavo-lib-pill is-action octavo-lib-smart-save', attr: { 'aria-label': 'Save as smart collection' } })
    setIcon(save.createSpan({ cls: 'octavo-lib-chip-icon' }), 'sparkles')
    save.createSpan({ text: 'Save as smart collection' })
    save.onclick = () => void this.saveSmart()
    const clear = bar.createEl('button', { cls: 'octavo-lib-pill is-action', text: 'Clear' })
    clear.onclick = () => { this.filter = emptyFilter(); this.render() }
  }

  private filterMenu(e: MouseEvent) {
    const m = new Menu()
    const icons: Record<Facet, string> = { folders: 'folder', tags: 'tag', series: 'library', authors: 'user', formats: 'file-type' }
    for (const k of FACETS) {
      const values = facetValues(this.items, k)
      const n = this.filter[k].length
      m.addItem(i => i.setTitle(`${FACET_LABEL[k]}${n ? ` (${n})` : ''}`).setIcon(icons[k]).setDisabled(!values.length).onClick(() => this.pickFacet(k)))
    }
    if (facetCount(this.filter)) {
      m.addSeparator()
      m.addItem(i => i.setTitle('Clear filters').setIcon('x').onClick(() => { this.filter = emptyFilter(); this.render() }))
    }
    m.showAtMouseEvent(e)
  }

  /** Open the picker for one facet (also used by QA). Picking a value toggles it. */
  pickFacet(k: Facet) {
    new FacetSuggestModal(this.app, k, facetValues(this.items, k), this.filter[k], v => { this.filter = toggleFacet(this.filter, k, v); this.render() }).open()
  }

  private async saveSmart() {
    const lib = this.plugin.settings.library
    const name = (await new TextPromptModal(this.app, 'Save as smart collection', '', 'Name, e.g. Unread sci-fi').result())?.trim()
    if (!name) return
    const sc = makeSmartCollection(name, this.filter, this.shelf, lib.smart ?? [])
    lib.smart = [...(lib.smart ?? []), sc]
    await this.plugin.saveSettings()
    this.filter = emptyFilter()
    this.shelf = `s:${sc.id}`
    new Notice(`Saved smart collection “${sc.name}”: ${describeFilter(sc.filter)}`)
    this.render()
  }

  private async updateSmart(id: string) {
    const lib = this.plugin.settings.library
    const old = lib.smart.find(x => x.id === id)
    if (!old) return
    const shelf = this.shelf.startsWith('s:') ? 'all' : this.shelf
    const next = { ...makeSmartCollection(old.name, this.filter, shelf, []), id }
    if (isEmptyFilter(next.filter)) { new Notice('Add at least one filter first.'); return }
    lib.smart = lib.smart.map(x => (x.id === id ? next : x))
    await this.plugin.saveSettings()
    this.editingSmart = null
    this.filter = emptyFilter()
    this.shelf = `s:${id}`
    this.render()
  }

  private smartMenu(id: string, e: MouseEvent) {
    const lib = this.plugin.settings.library
    const sc = lib.smart.find(x => x.id === id)
    if (!sc) return
    const m = new Menu()
    m.addItem(i => i.setTitle(describeFilter(sc.filter)).setIcon('sparkles').setDisabled(true))
    m.addSeparator()
    m.addItem(i => i.setTitle('Edit filters').setIcon('filter').onClick(() => {
      const f = normalizeFilter(sc.filter)
      this.filter = { folders: f.folders, tags: f.tags, series: f.series, authors: f.authors, formats: f.formats }
      this.shelf = f.collections?.[0] ? `c:${f.collections[0]}` : (f.status as Shelf | undefined) ?? 'all'
      this.editingSmart = id
      this.render()
    }))
    m.addItem(i => i.setTitle('Rename smart collection').setIcon('pencil').onClick(async () => {
      const name = (await new TextPromptModal(this.app, 'Rename smart collection', sc.name, 'Name').result())?.trim()
      if (!name || name === sc.name) return
      lib.smart = lib.smart.map(x => (x.id === id ? { ...x, name } : x))
      await this.plugin.saveSettings(); this.render()
    }))
    m.addItem(i => i.setTitle('Delete smart collection').setIcon('trash').onClick(async () => {
      lib.smart = lib.smart.filter(x => x.id !== id)
      if (this.shelf === `s:${id}`) this.shelf = 'all'
      if (this.editingSmart === id) this.editingSmart = null
      await this.plugin.saveSettings(); this.render()
      new Notice(`Deleted smart collection “${sc.name}”. No books were changed.`)
    }))
    m.showAtMouseEvent(e)
  }

  private collectionMenu(name: string, e: MouseEvent) {
    const m = new Menu()
    m.addItem(i => i.setTitle('Rename collection').setIcon('pencil').onClick(async () => {
      const next = (await new TextPromptModal(this.app, `Rename “${name}”`, name, 'New name').result())?.trim()
      if (next && next !== name) await this.renameCollection(name, next)
    }))
    m.addItem(i => i.setTitle('Delete collection').setIcon('trash').onClick(async () => {
      const n = this.items.filter(it => it.collections.some(c => c.toLowerCase() === name.toLowerCase())).length
      const ok = await new ConfirmModal(this.app, `Delete “${name}”?`, `Removes the collection from ${n} book note${n === 1 ? '' : 's'}. The books themselves stay in your library.`, 'Delete collection').result()
      if (ok) await this.renameCollection(name, null)
    }))
    m.showAtMouseEvent(e)
  }

  /** Rename (to = string) or delete (to = null) a collection in every book note that has it, and in smart collections. */
  async renameCollection(from: string, to: string | null) {
    let n = 0
    for (const it of this.items) {
      if (!it.note) continue
      const change = collectionEdit(this.plugin.library.getProps(it.note).collections, from, to)
      if (!change) continue
      await this.plugin.library.setProps(it.note, change)
      it.collections = change.collections ?? []
      n++
    }
    const lib = this.plugin.settings.library
    lib.smart = renameCollectionInSmart(lib.smart ?? [], from, to)
    await this.plugin.saveSettings()
    if (this.shelf === `c:${from}`) this.shelf = to ? `c:${to}` : 'all'
    new Notice(to ? `Renamed “${from}” to “${to}” in ${n} book${n === 1 ? '' : 's'}.` : `Deleted “${from}” from ${n} book${n === 1 ? '' : 's'}.`)
    this.render()
    this.refreshSoon()
  }

  private renderShelf(grid: HTMLElement) {
    grid.empty()
    const list = this.visible()
    if (!list.length) {
      const empty = grid.createDiv({ cls: 'octavo-empty' })
      empty.setText(this.items.length ? 'No books match.' : 'Your library is empty. Add EPUB or PDF books to your vault, or use “Add books”.')
      return
    }
    const list_ = this.plugin.settings.library.mode === 'list'
    for (const it of list) {
      const card = grid.createDiv({ cls: 'octavo-lib-card', attr: { role: 'button', tabindex: '0', draggable: 'true', 'aria-label': `${it.title}${it.author ? ` by ${it.author}` : ''}` } })
      const cover = card.createDiv({ cls: 'octavo-lib-cover' })
      this.coverEl(cover, it)
      if (it.status === 'finished') setIcon(cover.createDiv({ cls: 'octavo-lib-badge' }), 'check')
      else if (it.progress > 0) cover.createDiv({ cls: 'octavo-lib-bar is-overlay' }).setCssProps({ '--p': `${it.progress * 100}%` })
      if (it.cloud) setIcon(cover.createDiv({ cls: 'octavo-lib-cloud', attr: { 'aria-label': 'In Octavo Cloud' } }), 'cloud')
      const more = cover.createEl('button', { cls: 'octavo-lib-more clickable-icon', attr: { 'aria-label': 'Book options' } })
      setIcon(more, 'more-horizontal')
      more.onclick = e => { e.stopPropagation(); this.menu(it, e) }
      const info = card.createDiv({ cls: 'octavo-lib-info' })
      info.createDiv({ cls: 'octavo-lib-card-title', text: it.title })
      const meta = [it.author, list_ ? it.format.toUpperCase() : null,
        it.status === 'finished' ? 'Finished' : it.progress > 0 ? `${Math.round(it.progress * 100)}%` : it.status === 'want' ? 'Want to read' : null,
        list_ && it.highlights ? `${it.highlights} highlight${it.highlights === 1 ? '' : 's'}` : null,
        list_ && it.lastRead ? moment(it.lastRead).fromNow() : null].filter(Boolean)
      info.createDiv({ cls: 'octavo-lib-card-meta', text: meta.join(' · ') })
      this.wireCard(card, it)
    }
  }

  private coverEl(parent: HTMLElement, it: BookItem) {
    if (it.cover) { parent.createEl('img', { attr: { src: it.cover, alt: '', loading: 'lazy' } }); return }
    parent.addClass('is-placeholder')
    parent.setCssProps({ '--hue': String(hash(it.title) % 360) })
    parent.createDiv({ cls: 'octavo-lib-ph-title', text: it.title })
    if (it.author) parent.createDiv({ cls: 'octavo-lib-ph-author', text: it.author })
    ;(parent as any).__item = it
    if (!it.cloud) this.io?.observe(parent)
  }

  private wireCard(card: HTMLElement, it: BookItem) {
    card.onclick = e => this.openBook(it, e.metaKey || e.ctrlKey)
    card.onauxclick = e => { if (e.button === 1) this.openBook(it, true) }
    card.onkeydown = e => { if (e.key === 'Enter') this.openBook(it, false); if (e.key === 'ContextMenu') this.menu(it, e as unknown as MouseEvent) }
    card.oncontextmenu = e => { e.preventDefault(); this.menu(it, e) }
    // drag into a note → link to the book (or its note)
    card.ondragstart = e => {
      const target = it.note ?? it.file
      const link = this.app.fileManager.generateMarkdownLink(target, '').replace(/^!/, '')
      e.dataTransfer?.setData('text/plain', link)
    }
    // hover preview of the book note (Obsidian page preview)
    card.addEventListener('mouseover', e => {
      if (!it.note || !(e.metaKey || e.ctrlKey)) return
      this.app.workspace.trigger('hover-link', { event: e, source: 'octavo', hoverParent: this, targetEl: card, linktext: it.note.path, sourcePath: '' })
    })
  }

  private openBook(it: BookItem, newTab: boolean) {
    void this.plugin.openInOctavo(it.file, this.app.workspace.getLeaf(newTab ? 'tab' : false))
  }

  private menu(it: BookItem, e: MouseEvent) {
    const m = new Menu()
    m.addItem(i => i.setTitle('Open').setIcon('book-open').onClick(() => this.openBook(it, false)))
    m.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => this.openBook(it, true)))
    if (canPopout()) m.addItem(i => i.setTitle('Read in new window').setIcon('picture-in-picture-2').onClick(() => void this.plugin.openInOctavo(it.file, this.app.workspace.openPopoutLeaf({ size: { width: 900, height: 1000 } }))))
    if (it.note) m.addItem(i => i.setTitle('Open book note beside').setIcon('file-text').onClick(() => void besideLeaf(this.app).openFile(it.note!)))
    if (it.note) m.addItem(i => i.setTitle('Export highlights to note').setIcon('file-output').onClick(() => void this.plugin.exportHighlights(it.file)))
    m.addSeparator()
    const setStatus = (st: string, label: string, icon: string) => m.addItem(i => i.setTitle(label).setIcon(icon).setChecked(it.status === st).onClick(() => void this.setStatus(it, st)))
    setStatus('want', 'Want to read', 'bookmark-plus'); setStatus('reading', 'Reading', 'book-open'); setStatus('finished', 'Finished', 'check-circle')
    m.addSeparator()
    m.addItem(i => i.setTitle('Add to collection…').setIcon('folder-heart').onClick(async () => {
      const name = await new TextPromptModal(this.app, 'Add to collection', '', 'Collection name, e.g. Business').result()
      if (name) await this.editCollections(it, cs => [...new Set([...cs, name])])
    }))
    for (const c of it.collections) m.addItem(i => i.setTitle(`Remove from “${c}”`).setIcon('folder-minus').onClick(() => void this.editCollections(it, cs => cs.filter(x => x !== c))))
    m.addSeparator()
    if (this.plugin.cloud.signedIn && !it.cloud) m.addItem(i => i.setTitle('Move to Octavo Cloud').setIcon('cloud-upload').onClick(() => void this.plugin.cloud.uploadBook(it.file)))
    m.addItem(i => i.setTitle('Reveal in file explorer').setIcon('folder-open').onClick(() => {
      const fe: any = this.app.workspace.getLeavesOfType('file-explorer')[0]?.view
      fe?.revealInFolder?.(it.file)
    }))
    m.addItem(i => i.setTitle('Hide from library').setIcon('eye-off').onClick(async () => {
      this.plugin.settings.library.hidden.push(it.file.path); await this.plugin.saveSettings(); this.refresh()
      new Notice('Hidden. Unhide it in Settings → Octavo Reader → Library → Hidden books.')
    }))
    m.showAtMouseEvent(e)
  }

  private async ensureNote(it: BookItem): Promise<TFile> {
    if (it.note) return it.note
    const clean = cleanBookName(it.file.name)
    it.note = await this.plugin.library.ensureNote(it.file, { id: `lib-${it.file.stat.size.toString(36)}`, title: it.title || clean.title, author: it.author, format: it.format })
    return it.note
  }

  private async setStatus(it: BookItem, st: string) {
    const note = await this.ensureNote(it)
    await this.plugin.library.setProps(note, { status: st, ...(st === 'finished' ? { finished: moment().format('YYYY-MM-DD'), progress: 1 } : {}) })
    this.refreshSoon()
  }

  /** "+" chip: name a collection and pick its books in one step, then show it. */
  private async newCollection(existing: string[]) {
    const books = [...this.items].sort((a, b) => a.title.localeCompare(b.title))
    const r = await new CollectionModal(this.app, books.map(b => ({ title: b.title, author: b.author })), existing).result()
    if (!r) return
    const name = existing.find(e => e.toLowerCase() === r.name.toLowerCase()) ?? r.name
    for (const i of r.picked) {
      const it = books[i]
      if (it && !it.collections.includes(name)) await this.editCollections(it, cs => [...new Set([...cs, name])], false)
    }
    this.shelf = `c:${name}`
    new Notice(`Added ${r.picked.length} book${r.picked.length === 1 ? '' : 's'} to “${name}”.`)
    this.refreshSoon()
  }

  private async editCollections(it: BookItem, fn: (c: string[]) => string[], refresh = true) {
    const note = await this.ensureNote(it)
    const next = fn(it.collections)
    await this.plugin.library.setProps(note, { collections: next.length ? next : undefined })
    it.collections = next
    if (refresh) this.refreshSoon()
  }

  /** Copy books from disk into the vault's Library folder (desktop + mobile file picker). */
  private async addBooks() {
    const input = createEl('input', { attr: { type: 'file', multiple: '', accept: '.epub,.pdf,.mobi,.azw3,.azw,.fb2,.fbz,.cbz' } })
    input.onchange = async () => {
      const folder = normalizePath(this.plugin.settings.library.folders[0] || 'Library')
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
      let n = 0
      for (const f of Array.from(input.files ?? [])) {
        let path = normalizePath(`${folder}/${f.name}`)
        if (this.app.vault.getAbstractFileByPath(path)) continue
        await this.app.vault.createBinary(path, await f.arrayBuffer())
        n++
      }
      new Notice(`Added ${n} book${n === 1 ? '' : 's'} to ${folder}`)
      this.refresh()
    }
    input.click()
  }

  // ───────────────────────── background metadata ─────────────────────────

  private enqueue(it: BookItem | undefined) {
    if (!it) return
    this.queue.push(it)
    void this.work()
  }

  private async work() {
    if (this.working) return
    this.working = true
    try {
      while (this.queue.length) {
        const it = this.queue.shift()!
        const key = metaKey(it.file.path, it.file.stat.mtime, it.file.stat.size)
        let m = await metaCache.get(key).catch(() => undefined)
        if (!m) {
          m = { key, at: Date.now(), ...(await this.extract(it).catch(() => ({}))) }
          await metaCache.put(m).catch(() => {})
        }
        this.apply(it, m)
        await new Promise(r => window.setTimeout(r, 30))
      }
    } finally { this.working = false }
  }

  private async extract(it: BookItem): Promise<{ title?: string; author?: string; cover?: Blob | null }> {
    const url = this.app.vault.getResourcePath(it.file)
    if (it.format === 'pdf') {
      const pdfjs = await loadPdfJs()
      const doc = await openPdfDocument(pdfjs, url, it.file.stat.size, async () => new Uint8Array(await this.app.vault.readBinary(it.file)))
      try {
        const info = (await doc.getMetadata().catch(() => null))?.info ?? {}
        const page = await doc.getPage(1)
        const v = page.getViewport({ scale: 300 / page.getViewport({ scale: 1 }).width })
        const c = createEl('canvas'); c.width = v.width; c.height = v.height
        await page.render({ canvasContext: c.getContext('2d')!, viewport: v }).promise
        const cover = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.8))
        const t = String(info.Title ?? '').trim()
        return { title: isJunkTitle(t) ? undefined : tidyTitle(t!), author: normalizeAuthors(info.Author), cover }
      } finally { await doc.destroy() }
    }
    const blob = new Blob([await this.app.vault.readBinary(it.file)])
    const book: any = await makeBook(new File([blob], it.file.name))
    const md = book.metadata ?? {}
    const title = typeof md.title === 'string' ? md.title : md.title ? Object.values(md.title)[0] as string : undefined
    const authors = (Array.isArray(md.author) ? md.author : md.author ? [md.author] : []).map((a: any) => typeof a === 'string' ? a : (typeof a.name === 'string' ? a.name : Object.values(a.name ?? {})[0])).filter(Boolean)
    const raw: Blob | null = await book.getCover?.().catch?.(() => null) ?? null
    book.destroy?.()
    return { title, author: normalizeAuthors(authors), cover: raw ? await thumb(raw) : null }
  }

  private apply(it: BookItem, m: { title?: string; author?: string; cover?: Blob | null }) {
    if (!it.note) {
      if (m.title && !isJunkTitle(m.title)) it.title = m.title
      if (m.author) it.author = normalizeAuthors(m.author)
    }
    if (!it.cover && m.cover) {
      it.cover = URL.createObjectURL(m.cover)
      this.blobUrls.push(it.cover)
    }
    // update this card in place
    for (const card of Array.from(this.contentEl.querySelectorAll('.is-placeholder')) as HTMLElement[]) {
      if ((card as any).__item !== it) continue
      card.empty(); card.removeClass('is-placeholder')
      if (it.cover) card.createEl('img', { attr: { src: it.cover, alt: '' } })
      const host = card.closest('.octavo-lib-card')
      const t = host?.querySelector('.octavo-lib-card-title')
      if (t) t.textContent = it.title
      const meta = host?.querySelector('.octavo-lib-card-meta')
      if (meta && it.author && !meta.textContent?.startsWith(it.author)) meta.textContent = [it.author, meta.textContent].filter(Boolean).join(' · ')
    }
  }
}

async function thumb(blob: Blob, width = 300): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob)
    const h = Math.round((bmp.height / bmp.width) * width)
    const c = createEl('canvas'); c.width = width; c.height = h
    c.getContext('2d')!.drawImage(bmp, 0, 0, width, h)
    return (await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.82))) ?? blob
  } catch { return blob }
}

const toList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
void parseStub
