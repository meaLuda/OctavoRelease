import { BasesView, TFile, normalizePath, setIcon, type QueryController } from 'obsidian'
import { computeStreak } from '@octavo/shared'
import type OctavoPlugin from '../main'

export const SHELF_VIEW = 'octavo-shelf'

/**
 * Bookshelf view for Bases: cover cards with a thin progress bar, Apple-Books
 * style. The library is just a .base file, so shelves are saved queries the
 * user can filter, sort and duplicate.
 */
class ShelfView extends BasesView {
  type = SHELF_VIEW
  constructor(controller: QueryController, private hostEl: HTMLElement, private plugin: OctavoPlugin) {
    super(controller)
  }

  onDataUpdated(): void {
    const root = this.hostEl
    root.empty()
    root.addClass('octavo-shelf')
    const goals = this.plugin.settings.goals
    if (goals.enabled) {
      const st = computeStreak(this.plugin.settings.stats.minutesByDay, goals.dailyMinutes, new Date(), goals.restDaysPerWeek)
      const head = root.createDiv({ cls: 'octavo-shelf-head' })
      const ring = head.createDiv({ cls: 'octavo-goal-ring' })
      ring.style.setProperty('--p', String(Math.min(1, st.todayMinutes / goals.dailyMinutes)))
      ring.setAttribute('aria-label', `${st.todayMinutes} of ${goals.dailyMinutes} minutes today`)
      head.createDiv({ cls: 'octavo-goal-text', text: `${st.todayMinutes}/${goals.dailyMinutes} min today${st.current ? ` · ${st.current}-day streak` : ''}` })
      head.onclick = () => this.plugin.showGoal()
    }
    const grid = root.createDiv({ cls: 'octavo-shelf-grid' })
    const entries = this.data?.data ?? []
    if (!entries.length) {
      root.createDiv({ cls: 'octavo-empty', text: 'No books here yet. Open an EPUB or PDF and it appears on your shelf.' })
      return
    }
    for (const entry of entries) {
      const note = entry.file
      const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {}
      const card = grid.createDiv({ cls: 'octavo-book-card' })
      card.setAttribute('role', 'button')
      card.tabIndex = 0
      const cover = card.createDiv({ cls: 'octavo-book-cover' })
      const coverFile = this.linkTarget(fm.cover, note.path)
      if (coverFile) cover.createEl('img', { attr: { src: this.app.vault.getResourcePath(coverFile), alt: '' } })
      else { cover.addClass('is-placeholder'); cover.createDiv({ cls: 'octavo-book-cover-title', text: String(fm.title ?? note.basename) }) }
      const progress = Number(fm.progress) || 0
      if (fm.status === 'finished') { const b = cover.createDiv({ cls: 'octavo-book-badge' }); setIcon(b, 'check') }
      else if (progress > 0) cover.createDiv({ cls: 'octavo-book-progress' }).style.setProperty('--p', `${progress * 100}%`)
      card.createDiv({ cls: 'octavo-book-title', text: String(fm.title ?? note.basename) })
      card.createDiv({ cls: 'octavo-book-meta', text: [fm.author, progress > 0 && fm.status !== 'finished' ? `${Math.round(progress * 100)}%` : null].filter(Boolean).join(' · ') })
      const open = (newTab: boolean) => {
        const book = this.linkTarget(fm.book, note.path)
        if (book) void this.plugin.openInOctavo(book, this.app.workspace.getLeaf(newTab ? 'tab' : false))
        else void this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(note)
      }
      card.onclick = e => open(e.metaKey || e.ctrlKey)
      card.onkeydown = e => { if (e.key === 'Enter') open(false) }
      card.oncontextmenu = e => { e.preventDefault(); void this.app.workspace.getLeaf('split').openFile(note) }
    }
  }

  private linkTarget(v: unknown, source: string): TFile | null {
    if (typeof v !== 'string') return null
    const m = /\[\[([^\]|#]+)/.exec(v)
    return this.app.metadataCache.getFirstLinkpathDest(m ? m[1]! : v, source)
  }
}

export function registerShelf(plugin: OctavoPlugin) {
  plugin.registerBasesView(SHELF_VIEW, {
    name: 'Bookshelf',
    icon: 'library',
    factory: (controller, containerEl) => new ShelfView(controller, containerEl, plugin),
  })
}

/** Library.base with Reading now / Want to read / Finished shelves (created once, then the user owns it). */
export async function ensureLibraryBase(plugin: OctavoPlugin): Promise<TFile | null> {
  const folder = normalizePath(plugin.settings.booksFolder || 'Books')
  const path = normalizePath(`${folder}/Library.base`)
  const existing = plugin.app.vault.getAbstractFileByPath(path)
  if (existing instanceof TFile) return existing
  if (!plugin.app.vault.getAbstractFileByPath(folder)) await plugin.app.vault.createFolder(folder).catch(() => {})
  const yaml = `filters:
  and:
    - file.hasTag("book")
    - '!file.name.startsWith("Year in review")'
views:
  - type: ${SHELF_VIEW}
    name: Reading now
    filters:
      and:
        - status == "reading"
    sort:
      - property: last-read
        direction: DESC
  - type: ${SHELF_VIEW}
    name: Want to read
    filters:
      and:
        - status == "want"
  - type: ${SHELF_VIEW}
    name: Finished
    filters:
      and:
        - status == "finished"
    sort:
      - property: finished
        direction: DESC
  - type: ${SHELF_VIEW}
    name: All books
    sort:
      - property: title
        direction: ASC
  - type: table
    name: Table
    order:
      - file.name
      - author
      - status
      - progress
      - highlights
      - last-read
`
  return plugin.app.vault.create(path, yaml)
}
