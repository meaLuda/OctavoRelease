import { addIcon, FileView, Plugin, TFile, WorkspaceLeaf, MarkdownView, Notice, Menu, requestUrl, moment, normalizePath, Platform, type App, type TAbstractFile } from 'obsidian'
import { Pace, computeStreak, parseHighlights as parseHighlightsFresh, buildLiteratureNote, refreshLiteratureNote, resolveLiteratureNotePath, EXPORT_BOOK_ID, citekeyFrom, type Highlight, type CopyFormat, type LiteratureInput } from '@octavo/shared'
import { upgradeLayouts } from './pdf/layout'
import { DEFAULT_SETTINGS, mergeSyncedStats, type OctavoSettings } from './settings'
import { BookLibrary, BOOK_EXTENSIONS, isBookFile } from './library/BookLibrary'
import { propText } from './library/dedupe'
import { hoursMinutes } from './library/stats'
import { EpubView, EPUB_VIEW } from './epub/EpubView'
import { PdfView, PDF_VIEW } from './pdf/PdfView'
import { OctavoSettingTab } from './settingsTab'
import { MarkdownModal, TextPromptModal } from './reader/modals'
import { registerShelf, ensureLibraryBase } from './library/shelf'
import { ImportModal } from './library/ImportModal'
import { LibraryView, LIBRARY_VIEW } from './library/LibraryView'
import { askAI, aiConfigured } from './ai/ask'
import { BYO_PROMPTS, cardsFileHeader, cardsPath, hostedFooter, newCardLines, parseCards, type AiFeature, type AiInput, type Card } from './ai/hosted'
import { CloudClient } from './cloud/CloudClient'
import { besideLeaf } from './platform'
import { collectDiagnostics } from './diagnostics'
import { PdfNoteEmbeds } from './pdf/embeds'
import { copyAs, copyCitation, type CopySource } from './reader/copy'
import { lookupForms, OfflineDictionary, wiktionaryDefinition } from './reader/dictionary'
import { QuoteCardModal } from './reader/quoteCard'
import { StatsView, STATS_VIEW } from './library/StatsView'
import { appendUnderHeading, dailySection, pickHighlights, recordShown } from './library/resurface'


/** Octavo mark: an open book with a ribbon bookmark (100×100, currentColor, Lucide-weight strokes). */
const OCTAVO_ICON = `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M50 30C39 22 24 19 9 21v57c15-2 30 1 41 9 11-8 26-11 41-9V21c-15-2-30 1-41 9z"/>
  <path d="M50 30v57"/>
</g>
<path d="M62 23.5V56l9-7.5 9 7.5V20.5c-6 .2-12 1.2-18 3z" fill="currentColor"/>`

/** Obsidian's private view registry: which view type opens each file extension. */
const viewRegistry = (app: App) => (app as App & { viewRegistry?: { typeByExtension?: Record<string, string> } }).viewRegistry


/** The generated part of a Year in review note (the rest is yours). */
const YEAR_START = '<!-- octavo:year-in-review -->'
const YEAR_END = '<!-- /octavo:year-in-review -->'
export default class OctavoPlugin extends Plugin {
  declare settings: OctavoSettings
  library!: BookLibrary
  pace!: Pace
  cloud!: CloudClient
  customFontUrl: string | null = null
  private lastMarkdownLeaf: WorkspaceLeaf | null = null
  private statusEl: HTMLElement | null = null
  pdfEmbeds!: PdfNoteEmbeds

  /** Resolves once settings are loaded; views await it so they can be registered synchronously. */
  ready!: Promise<void>
  /** Definitions kept for Define without internet (see reader/dictionary.ts). */
  dict!: OfflineDictionary

  async onload() {
    // Register views first (synchronously) so Obsidian can restore open book tabs on startup.
    addIcon('octavo', OCTAVO_ICON)
    this.registerView(EPUB_VIEW, leaf => new EpubView(leaf, this))
    this.registerView(PDF_VIEW, leaf => new PdfView(leaf, this))
    this.registerView(LIBRARY_VIEW, leaf => new LibraryView(leaf, this))
    this.registerView(STATS_VIEW, leaf => new StatsView(leaf, this))
    this.dict = new OfflineDictionary(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`, () => this.vocabularyPath())
    for (const ext of BOOK_EXTENSIONS) {
      try { this.registerExtensions([ext], EPUB_VIEW) }
      catch { console.warn(`Octavo: .${ext} is already handled by another plugin; use "Open in Octavo".`) }
    }
    this.ready = this.loadSettings()
    await this.ready
    this.pace = Pace.fromJSON(this.settings.pace)
    this.library = new BookLibrary(this.app, () => this.settings, () => this.saveSettings())
    this.cloud = new CloudClient(this)
    this.cloud.watchLabels()

    this.registerHoverLinkSource('octavo', { display: 'Octavo', defaultMod: true })
    this.applyPdfRouting()
    this.register(() => { const reg = viewRegistry(this.app); if (reg?.typeByExtension?.pdf === PDF_VIEW) reg.typeByExtension.pdf = this.pdfDefaultType })
    registerShelf(this)
    // PDF region embeds (`![[x.pdf#page=N&rect=…]]`) and PDF page hover previews in notes
    this.pdfEmbeds = new PdfNoteEmbeds(this)
    this.pdfEmbeds.register()

    this.addRibbonIcon('octavo', 'Octavo library', () => void this.openLibrary())
    this.addSettingTab(new OctavoSettingTab(this.app, this))
    this.registerCommands()
    this.registerFileMenu()

    this.app.workspace.onLayoutReady(() => {
      this.library.reindex()
      // the first index can run before every note is parsed: rebuild it once metadata is resolved
      this.afterMetadataResolved(() => {
        this.library.reindex()
        this.app.workspace.getLeavesOfType(LIBRARY_VIEW).forEach(l => { if (l.view instanceof LibraryView) l.view.refresh() })
        if (!this.settings.duplicatesRepaired) void this.repairDuplicateNotes(true)
        void this.addDailyHighlights(true)
      })
      void this.loadCustomFont()
      this.updateStatus()
      void this.welcomeOnMobile()
    })
    this.registerEvent(this.app.metadataCache.on('changed', f => this.library.indexNote(f)))
    this.registerEvent(this.app.vault.on('delete', (f: TAbstractFile) => this.library.forgetNote(f.path)))
    this.registerEvent(this.app.vault.on('rename', (f: TAbstractFile, old: string) => {
      if (f instanceof TFile && isBookFile(f)) {
        this.library.renameBook(old, f.path)
        // hidden books and Continue reading dismissals are kept by path: carry them over
        const lib = this.settings.library
        const i = lib.hidden.indexOf(old)
        const dismissed = lib.continueDismissed?.[old]
        if (i >= 0) lib.hidden[i] = f.path
        if (dismissed !== undefined) { const cd = { ...lib.continueDismissed }; delete cd[old]; cd[f.path] = dismissed; lib.continueDismissed = cd }
        if (i >= 0 || dismissed !== undefined) void this.saveSettings()
      } else { this.library.forgetNote(old); if (f instanceof TFile) this.library.indexNote(f) }
    }))
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) this.lastMarkdownLeaf = leaf
    }))
    this.registerInterval(window.setInterval(() => this.updateStatus(), 60_000))
  }

  onunload() {
    if (this.customFontUrl) URL.revokeObjectURL(this.customFontUrl)
  }

  async loadSettings() {
    this.applySettings(((await this.loadData()) ?? {}) as Partial<OctavoSettings>)
  }

  /**
   * Another device saved its settings (Obsidian Sync). Take its choices, but keep this device's reading stats and
   * daily-highlight history merged in, and save once so the merged copy is what syncs back.
   */
  async onExternalSettingsChange() {
    const mine = this.settings
    if (!mine) return
    this.applySettings(((await this.loadData()) ?? {}) as Partial<OctavoSettings>)
    this.settings.stats = mergeSyncedStats(mine.stats, this.settings.stats)
    this.settings.dailyHighlights.shown = { ...mine.dailyHighlights.shown, ...this.settings.dailyHighlights.shown }
    const saved = ((await this.loadData()) ?? {}) as Partial<OctavoSettings>
    const theirs = JSON.stringify(saved.stats ?? {})
    if (JSON.stringify(this.settings.stats) !== theirs) await this.saveSettings()
    else this.updateStatus()
    this.refreshReaders()
  }

  private applySettings(data: Partial<OctavoSettings>) {
    const d = DEFAULT_SETTINGS
    this.settings = {
      ...d, ...data,
      goals: { ...d.goals, ...data.goals },
      stats: { ...d.stats, ...data.stats, minutesByBook: { ...data.stats?.minutesByBook } },
      tts: { ...d.tts, ...data.tts },
      ai: { ...d.ai, ...data.ai },
      cloud: { ...d.cloud, ...data.cloud },
      library: { ...d.library, ...data.library },
      copyTemplates: { ...d.copyTemplates, ...data.copyTemplates },
      overrides: { ...data.overrides },
      bookThemes: { ...data.bookThemes },
      bookTextSizes: { ...data.bookTextSizes },
      dailyHighlights: { ...d.dailyHighlights, ...data.dailyHighlights, shown: { ...data.dailyHighlights?.shown } },
      pdfLayouts: { ...data.pdfLayouts },
      tapZones: Array.isArray(data.tapZones) && data.tapZones.length === 9 ? data.tapZones : d.tapZones,
    }
    if (data.textSize == null) {
      // text size used to be saved per theme: keep the size of the theme in use, for every theme
      this.settings.textSize = data.overrides?.[this.settings.theme]?.fontSize ?? 100
      for (const o of Object.values(this.settings.overrides)) delete o?.fontSize
    }
    if ((this.settings.pdfLayoutVersion ?? 1) < 3) {
      this.settings.pdfLayouts = upgradeLayouts(this.settings.pdfLayouts, this.settings.pdfLayoutVersion ?? 1)
      this.settings.pdfLayoutVersion = 3
    }
  }

  async saveSettings() {
    this.settings.pace = this.pace?.toJSON() ?? this.settings.pace
    await this.saveData(this.settings)
    this.updateStatus()
  }

  // ───────────────────────── opening books ─────────────────────────

  /** Open books pick up a changed look (a new custom font, the default theme). */
  refreshReaders() {
    for (const l of [...this.app.workspace.getLeavesOfType(EPUB_VIEW), ...this.app.workspace.getLeavesOfType(PDF_VIEW)]) {
      if (l.view instanceof EpubView || l.view instanceof PdfView) l.view.applyLook()
    }
  }

  /** The Octavo reader tab already showing this book, other than `except`. */
  readerLeafFor(file: TFile, except?: WorkspaceLeaf): WorkspaceLeaf | undefined {
    return [...this.app.workspace.getLeavesOfType(EPUB_VIEW), ...this.app.workspace.getLeavesOfType(PDF_VIEW)]
      .find(l => l !== except && l.view instanceof FileView && l.view.file?.path === file.path)
  }

  /**
   * A book is read in one tab only: two readers would both write the position to its note.
   * When `file` is already open elsewhere, that tab is shown (with `eState`, e.g. a deep link) and the other leaf is returned.
   */
  switchToOpenReader(file: TFile, leaf: WorkspaceLeaf | undefined, eState?: unknown): WorkspaceLeaf | undefined {
    const open = this.readerLeafFor(file, leaf)
    if (!open) return undefined
    void this.app.workspace.revealLeaf(open)
    this.app.workspace.setActiveLeaf(open, { focus: true })
    if (eState) open.setEphemeralState(eState)
    return open
  }

  async openInOctavo(file: TFile, leaf?: WorkspaceLeaf, eState?: Record<string, unknown>) {
    const type = file.extension === 'pdf' ? PDF_VIEW : EPUB_VIEW
    if (this.switchToOpenReader(file, leaf, eState)) {
      // getLeaf('tab') already made an empty tab for this book: close it
      if (leaf?.view.getViewType() === 'empty') leaf.detach()
      return
    }
    const l = leaf ?? this.app.workspace.getLeaf(false)
    await l.setViewState({ type, state: { file: file.path }, active: true }, eState)
  }

  /**
   * While "Open PDFs in Octavo" is on, Octavo is the registered viewer for .pdf
   * (Obsidian's own mapping is restored when the setting is turned off or the
   * plugin unloads). Links keep their eState, so PDF++ `#page=…&selection=…` works.
   */
  applyPdfRouting() {
    const reg = viewRegistry(this.app)
    if (!reg?.typeByExtension) return
    if (this.settings.openPdfInOctavo) {
      if (reg.typeByExtension.pdf !== PDF_VIEW) { this.pdfDefaultType = reg.typeByExtension.pdf ?? 'pdf'; reg.typeByExtension.pdf = PDF_VIEW }
    } else if (reg.typeByExtension.pdf === PDF_VIEW) reg.typeByExtension.pdf = this.pdfDefaultType
  }
  private pdfDefaultType = 'pdf'

  private registerFileMenu() {
    this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, f: TAbstractFile) => {
      if (!(f instanceof TFile) || !isBookFile(f)) return
      menu.addItem(i => i.setTitle('Open in Octavo').setIcon('book-open').onClick(() => void this.openInOctavo(f, this.app.workspace.getLeaf('tab'))))
      if (this.library.noteFor(f)) menu.addItem(i => i.setTitle('Export highlights to note').setIcon('file-output').onClick(() => void this.exportHighlights(f)))
      if (this.cloud.signedIn) menu.addItem(i => i.setTitle('Move to Octavo Cloud library').setIcon('cloud-upload').onClick(() => void this.cloud.uploadBook(f)))
    }))
  }

  private registerCommands() {
    this.addCommand({ id: 'open-library', name: 'Open library', icon: 'library', callback: () => void this.openLibrary() })
    this.addCommand({ id: 'copy-diagnostics', name: 'Copy mobile diagnostics', icon: 'stethoscope', callback: () => void this.copyDiagnostics() })
    this.addCommand({ id: 'repair-duplicate-notes', name: 'Repair duplicate book notes', icon: 'copy-check', callback: () => void this.repairDuplicateNotes(false) })
    this.addCommand({ id: 'open-library-base', name: 'Open library as a base (table / custom views)', callback: () => void this.openLibraryBase() })
    this.addCommand({ id: 'import-highlights', name: 'Import highlights from another reader…', callback: () => new ImportModal(this.app, this).open() })
    this.addCommand({
      id: 'open-current-file', name: 'Open current file as a book',
      checkCallback: checking => {
        const f = this.app.workspace.getActiveFile()
        if (!isBookFile(f)) return false
        if (!checking) void this.openInOctavo(f)
        return true
      },
    })
    this.addCommand({
      id: 'open-book-note', name: 'Open book note for current book',
      checkCallback: checking => {
        const v = this.app.workspace.getActiveViewOfType(EpubView) ?? this.app.workspace.getActiveViewOfType(PdfView)
        const note = v?.file ? this.library.noteFor(v.file) : null
        if (!note) return false
        if (!checking) void besideLeaf(this.app).openFile(note)
        return true
      },
    })
    this.addCommand({
      id: 'toggle-auto-scroll', name: 'Toggle auto-scroll',
      checkCallback: checking => {
        const v = this.app.workspace.getActiveViewOfType(EpubView) ?? this.app.workspace.getActiveViewOfType(PdfView)
        if (!v) return false
        if (!checking) v.toggleAutoScroll()
        return true
      },
    })
    this.addCommand({
      id: 'focus-mode', name: 'Toggle focus mode (full screen reading)',
      checkCallback: checking => {
        const v = this.app.workspace.getActiveViewOfType(EpubView) ?? this.app.workspace.getActiveViewOfType(PdfView)
        if (!v) return false
        if (!checking) v.focusMode.toggle()
        return true
      },
    })
    this.addCommand({
      id: 'summarise-chapter', name: 'Summarise chapter into book note',
      checkCallback: checking => {
        const v = this.activeReader()
        if (!v) return false
        if (!checking) void this.summariseChapter(v)
        return true
      },
    })
    this.addCommand({
      id: 'flashcards-from-highlights', name: 'Flashcards from highlights',
      checkCallback: checking => {
        const v = this.activeReader()
        if (!v) return false
        if (!checking) void this.flashcards(v)
        return true
      },
    })
    this.addCommand({
      id: 'pdf-select-area', name: 'Select area in PDF', icon: 'box-select',
      checkCallback: checking => {
        const v = this.app.workspace.getActiveViewOfType(PdfView)
        if (!v) return false
        if (!checking) v.toggleAreaSelect()
        return true
      },
    })
    this.addCommand({ id: 'reading-stats', name: 'Open reading stats', icon: 'bar-chart-3', callback: () => void this.openStats() })
    this.addCommand({ id: 'daily-highlights', name: 'Add highlights from my books to today\'s daily note', icon: 'sparkles', callback: () => void this.addDailyHighlights(false) })
    this.addCommand({
      id: 'story-so-far', name: 'Story so far: a recap up to your page', icon: 'history',
      checkCallback: checking => {
        const v = this.activeReader()
        if (!v) return false
        if (!checking) void this.recap(v)
        return true
      },
    })
    this.addCommand({
      id: 'flip-through', name: 'Flip through pages (peek without losing your place)', icon: 'book-open',
      checkCallback: checking => {
        const v = this.activeReader()
        if (!v) return false
        if (!checking) v.openPeek()
        return true
      },
    })
    this.registerCopyCommands()
    this.addCommand({ id: 'reading-goal', name: 'Show reading goal and streak', callback: () => this.showGoal() })
    this.addCommand({ id: 'year-in-review', name: 'Write my year in review', callback: () => void this.yearInReview().catch(e => new Notice(`Could not write the year in review: ${(e as Error).message}`)) })
    this.addCommand({ id: 'cloud-sign-in', name: 'Sign in to cloud', callback: () => void this.cloud.signIn() })
    this.addCommand({ id: 'cloud-library', name: 'Browse cloud library', callback: () => void this.cloud.browse() })
  }

  // ───────────────────────── copy formats, citation, literature-note export ─────────────────────────

  /** "Copy selection as quote/link/callout", "Copy citation" and "Export highlights to note" (no default hotkeys). */
  private registerCopyCommands() {
    const withSelection = (run: (src: CopySource) => Promise<unknown>) => (checking: boolean) => {
      const v = this.activeReader()
      if (!v) return false
      if (!checking) void v.copySource().then(src => src ? run(src) : void new Notice('Octavo: select some text first.'))
        .catch(e => { console.error('Octavo: copy failed', e); new Notice(`Octavo could not copy that: ${e instanceof Error ? e.message : String(e)}`) })
      return true
    }
    const formats: Array<[CopyFormat, string]> = [['quote', 'quote'], ['link', 'link'], ['callout', 'callout']]
    for (const [f, label] of formats)
      this.addCommand({ id: `copy-selection-${f}`, name: `Copy selection as ${label}`, icon: 'clipboard-copy', checkCallback: withSelection(src => copyAs(this, f, src)) })
    this.addCommand({ id: 'copy-citation', name: 'Copy citation for selection', icon: 'graduation-cap', checkCallback: withSelection(src => copyCitation(this, src)) })
    this.addCommand({
      id: 'export-highlights', name: 'Export highlights to note', icon: 'file-output',
      checkCallback: checking => {
        const active = this.app.workspace.getActiveFile()
        const book = this.activeReader()?.file ?? (isBookFile(active) ? active : active ? this.library.bookForNote(active) : null)
        if (!book || !this.library.noteFor(book)) return false
        if (!checking) void this.exportHighlights(book)
        return true
      },
    })
  }

  /**
   * Writes or refreshes `<export folder>/<Book title> highlights.md`. A refresh regenerates only the block
   * between the `%% octavo:start %%` / `%% octavo:end %%` markers; everything else in the note is the reader's.
   */
  async exportHighlights(book: TFile, open = true): Promise<TFile | null> {
    const note = this.library.noteFor(book)
    if (!note) { new Notice('Octavo: open this book once so it has a book note, then export.'); return null }
    const props = this.library.getProps(note)
    const title = propText(props.title ?? book.basename)
    const bookId = props['octavo-id'] ? propText(props['octavo-id']) : book.path
    const citekey = citekeyFrom(props)
    // Who owns an existing note at a path: its stored book id, else (older exports) the book its `source` links to.
    const ownerAt = (p: string): string | null | undefined => {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(p))
      if (!(f instanceof TFile)) return undefined
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
      if (fm?.[EXPORT_BOOK_ID]) return String(fm[EXPORT_BOOK_ID])
      const src = typeof fm?.source === 'string' ? /\[\[([^\]|#]+)/.exec(fm.source)?.[1] ?? /\]\(<?([^)>]+)>?\)/.exec(fm.source)?.[1] : undefined
      const target = src ? this.app.metadataCache.getFirstLinkpathDest(decodeURI(src), f.path) : null
      if (!target || target.path === book.path) return null
      const tNote = this.library.noteFor(target)
      const tId = tNote ? this.library.getProps(tNote)['octavo-id'] : undefined
      return tId ? propText(tId) : target.path
    }
    const path = normalizePath(resolveLiteratureNotePath(this.settings.exportFolder || 'Books', title, bookId, ownerAt, citekey))
    const highlights = parseHighlightsFresh(await this.app.vault.read(note))
    const input: LiteratureInput = {
      book: title,
      bookId,
      author: Array.isArray(props.author) ? props.author.join(', ') : props.author ? propText(props.author) : undefined,
      citekey,
      source: this.app.fileManager.generateMarkdownLink(book, path).replace(/^!/, ''),
      highlights: highlights.map(h => ({ highlight: h, link: this.library.linkFrom(book, path, h) })),
      date: moment().format('YYYY-MM-DD'),
      noteTemplate: this.settings.exportNoteTemplate,
      highlightTemplate: this.settings.exportHighlightTemplate,
    }
    const existing = this.app.vault.getAbstractFileByPath(path)
    let file: TFile
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, md => refreshLiteratureNote(md, input))
      file = existing
    } else {
      const folder = path.split('/').slice(0, -1).join('/')
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
      file = await this.app.vault.create(path, buildLiteratureNote(input))
    }
    new Notice(`${existing ? 'Refreshed' : 'Exported'} ${highlights.length} highlight${highlights.length === 1 ? '' : 's'} to ${file.basename}`)
    if (open) await besideLeaf(this.app).openFile(file)
    return file
  }

  /** Mobile hides plugin ribbon icons behind the Menu button, so show new users where Octavo lives, once. */
  private async welcomeOnMobile() {
    if (!Platform.isMobile || this.settings.mobileWelcomed) return
    this.settings.mobileWelcomed = true
    await this.saveSettings()
    await this.openLibrary()
    new Notice('Octavo: find your library in the ribbon menu (bottom right) or the command palette. Tap any EPUB or PDF to read it.', 12000)
  }

  /** Runs `fn` once the metadata cache has indexed the vault (first 'resolved', or after 5 s at the latest). */
  private afterMetadataResolved(fn: () => void) {
    let done = false
    const run = () => { if (done) return; done = true; this.app.metadataCache.offref(ref); window.clearTimeout(timer); fn() }
    const ref = this.app.metadataCache.on('resolved', run)
    this.registerEvent(ref)
    const timer = window.setTimeout(run, 5000)
  }

  /** Merge book notes that belong to one book (see BookLibrary.repairDuplicates). `startup`: one-time run, silent when clean. */
  async repairDuplicateNotes(startup: boolean) {
    try {
      const r = await this.library.repairDuplicates()
      if (r.removed) {
        new Notice(`Octavo: merged ${r.removed} duplicate book note${r.removed === 1 ? '' : 's'} into ${r.groups} (${r.highlights} highlight${r.highlights === 1 ? '' : 's'} moved, ${r.links} link${r.links === 1 ? '' : 's'} updated). Duplicates are in the system trash.`, 10000)
      } else if (!startup) new Notice('Octavo: no duplicate book notes found')
      this.settings.duplicatesRepaired = true
      await this.saveSettings()
      return r
    } catch (e) {
      console.error('Octavo: repairing duplicate book notes failed', e)
      new Notice('Octavo: could not repair duplicate book notes (see console)')
      return null
    }
  }

  private async copyDiagnostics() {
    const report = await collectDiagnostics(this.app, this.manifest.version)
    try { await navigator.clipboard.writeText(report); new Notice('Octavo diagnostics copied to the clipboard') } catch { /* shown below */ }
    new MarkdownModal(this.app, 'Octavo diagnostics', '```\n' + report + '\n```').open()
  }

  async openLibrary() {
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0]
    if (existing) {
      await (existing as WorkspaceLeaf & { loadIfDeferred?(): Promise<void> }).loadIfDeferred?.()
      if (!existing.view.containerEl.querySelector('.octavo-lib')) await existing.setViewState({ type: LIBRARY_VIEW, active: true })
      await this.app.workspace.revealLeaf(existing)
      return
    }
    await this.app.workspace.getLeaf('tab').setViewState({ type: LIBRARY_VIEW, active: true })
  }

  async openLibraryBase() {
    const base = await ensureLibraryBase(this)
    if (base) await this.app.workspace.getLeaf(false).openFile(base)
  }

  // ───────────────────────── define / ask / auto-paste ─────────────────────────

  private activeReader(): EpubView | PdfView | null {
    return this.app.workspace.getActiveViewOfType(EpubView) ?? this.app.workspace.getActiveViewOfType(PdfView)
  }

  private get hostedAi() { return this.settings.ai.provider === 'octavo' }

  /** AI is set up (Octavo AI signed in, or a provider of your own); no notice. */
  aiAvailable(): boolean { return aiConfigured(this.settings) }

  /** Tells the user how to turn AI on; false when it isn't set up. */
  private aiReady(): boolean {
    if (aiConfigured(this.settings)) return true
    new Notice(this.hostedAi
      ? 'Octavo AI: sign in to Octavo Cloud (Settings → Octavo → Cloud) with a Cloud + AI plan.'
      : 'Octavo: choose an AI provider in settings (Octavo AI with Cloud + AI, your own key, or local Ollama).')
    return false
  }

  /**
   * Runs one AI feature through Octavo AI (hosted) or the user's own provider. `footer` is a line for the modal
   * (credits left), never saved into notes.
   */
  async runAi(feature: AiFeature, input: AiInput, byoPrompt: () => string, onText?: (t: string) => void): Promise<{ text: string; cards: Card[]; footer: string }> {
    if (this.hostedAi) {
      const r = await this.cloud.ai(feature, input)
      return { text: (r.text ?? '').trim(), cards: r.cards ?? [], footer: hostedFooter(r) }
    }
    const text = await askAI(this.settings, byoPrompt(), onText)
    return { text: text.trim(), cards: feature === 'flashcards' ? parseCards(text) : [], footer: '' }
  }

  private aiError(e: unknown): string {
    return this.hostedAi ? `Octavo AI: ${(e as Error).message}` : `Could not reach your AI provider: ${(e as Error).message}`
  }

  async define(text: string, context: string) {
    const word = text.trim().split(/\s+/).slice(0, 4).join(' ')
    if (!word) return
    const modal = new MarkdownModal(this.app, word, '*Looking up…*', [
      { label: 'Save to vocabulary', cta: true, run: () => void this.saveVocabulary(word, defn, context) },
    ])
    let defn = ''
    let footer = ''
    modal.open()
    let failed: unknown = null
    try {
      if (aiConfigured(this.settings)) {
        const r = await this.runAi('explain', { text: word, context },
          () => `Define "${word}" briefly as used in this sentence. One or two lines, no preamble.\n\nSentence: ${context}`, t => modal.setMarkdown(t))
        defn = r.text
        footer = r.footer
      } else {
        // "Monday" and "Paris" exist only capitalised, "word," only without its comma: try each form until one answers
        for (const form of lookupForms(word)) {
          const res = await requestUrl({ url: `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(form)}`, throw: false })
          defn = res.status === 200 ? wiktionaryDefinition(res.json) : ''
          if (defn) break
        }
      }
    } catch (e) { failed = e; defn = '' }
    if (defn) { void this.dict.put(word, defn); modal.setMarkdown(`${defn}${footer ? `\n\n${footer}` : ''}`); return }
    // offline, or nothing found: a definition kept from an earlier lookup or the Vocabulary note
    const kept = await this.dict.get(word)
    if (kept) { defn = kept; modal.setMarkdown(`${kept}\n\n*Saved definition (offline).*`); return }
    // your own provider's error (bad key, quota, wrong model) is shown, not hidden behind the dictionary
    if (failed && aiConfigured(this.settings)) { modal.setMarkdown(this.aiError(failed)); return }
    if (this.lookUpNatively()) { modal.close(); return }
    modal.setMarkdown(failed
      ? `No connection, and **${word}** has not been looked up on this device before. Words you look up while online are kept for offline use.`
      : `No definition found for **${word}**. Set up an AI provider in settings for context-aware definitions.`)
  }

  /** macOS desktop: the system dictionary pop-up for the current selection (works offline). */
  private lookUpNatively(): boolean {
    if (!Platform.isMacOS || !Platform.isDesktopApp) return false
    const wc = (window as Window & { electronWindow?: { webContents?: { showDefinitionForSelection?: () => void } } }).electronWindow?.webContents
    if (!wc?.showDefinitionForSelection) return false
    wc.showDefinitionForSelection()
    return true
  }

  private vocabularyPath(): string { return normalizePath(`${this.settings.booksFolder || 'Books'}/Vocabulary.md`) }

  /** The language to translate into: the setting, else the device language ("English", "Kiswahili"…). */
  translateTarget(): string {
    const set = this.settings.translateTo.trim()
    if (set) return set
    const tag = (navigator.language || 'en').split('-')[0]
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? 'English' } catch { return 'English' }
  }

  /** Translate a passage with AI; the translation can be copied or kept in the book note. */
  async translate(text: string, title: string) {
    if (!this.aiReady() || !text.trim()) return
    const to = this.translateTarget()
    let out = ''
    const modal = new MarkdownModal(this.app, `Translation · ${to}`, '*Translating…*', [
      { label: 'Copy', run: () => void navigator.clipboard.writeText(out).then(() => new Notice('Translation copied')) },
      { label: 'Save to book note', cta: true, run: () => void this.saveAnswer(title, text, out, 'Translations') },
    ])
    modal.open()
    try {
      const input = { text, to }
      const r = await this.runAi('translate', input, () => BYO_PROMPTS.translate(input), t => { out = t; modal.setMarkdown(t) })
      out = r.text
      modal.setMarkdown(r.footer ? `${out}\n\n${r.footer}` : out)
    } catch (e) { modal.setMarkdown(this.aiError(e)) }
  }

  /** "Story so far": a spoiler-free recap of what the reader has passed, from the reader's own material. */
  async recap(view: EpubView | PdfView) {
    if (!this.aiReady()) return
    const input = await view.recapInput()
    if (!input?.recent.trim()) { new Notice('Octavo: read a little first, then ask for the story so far.'); return }
    let out = ''
    const modal = new MarkdownModal(this.app, 'The story so far', '*Remembering…*', [
      { label: 'Save to book note', cta: true, run: () => void (view.bookNote && this.appendToNote(view.bookNote, 'Story so far', `*${moment().format('YYYY-MM-DD')}, at ${typeof input.position === 'number' ? `${Math.round(input.position * 100)}%` : input.position ?? ''}*\n\n${out}`).then(() => new Notice('Saved to the book note'))) },
    ])
    modal.open()
    try {
      const r = await this.runAi('recap', input, () => BYO_PROMPTS.recap(input), t => { out = t; modal.setMarkdown(t) })
      out = r.text
      modal.setMarkdown(r.footer ? `${out}\n\n${r.footer}` : out)
    } catch (e) { modal.setMarkdown(this.aiError(e)) }
  }

  /** Quote card for a passage: saved next to attachments (Obsidian's attachment folder setting). */
  quoteCard(text: string, title: string, note: TFile | null) {
    const author = note ? propText(this.library.getProps(note).author ?? '') || undefined : undefined
    new QuoteCardModal(this.app, { text, title, author }, name => this.app.fileManager.getAvailablePathForAttachment(name, note?.path ?? '')).open()
  }

  async openStats() {
    const existing = this.app.workspace.getLeavesOfType(STATS_VIEW)[0]
    if (existing) { await this.app.workspace.revealLeaf(existing); if (existing.view instanceof StatsView) existing.view.render(); return }
    await this.app.workspace.getLeaf('tab').setViewState({ type: STATS_VIEW, active: true })
  }

  /**
   * Daily highlights: a few highlights from your books, embedded in today's daily note under "From my books".
   * `auto`: the once-a-day run at startup (only when turned on, quiet when there is nothing to add).
   */
  async addDailyHighlights(auto: boolean) {
    const dh = this.settings.dailyHighlights
    const today = moment().format('YYYY-MM-DD')
    if (auto && (!dh.enabled || dh.lastDay === today)) return
    // at startup, let Daily notes (or Templater) make today's note from its template first
    if (auto) await new Promise(r => window.setTimeout(r, 5000))
    const all: Array<{ id: string; book: string; note: TFile }> = []
    for (const { note } of this.library.allBooks()) for (const h of await this.library.highlights(note)) all.push({ id: h.id, book: note.path, note })
    if (!all.length) { if (!auto) new Notice('Octavo: no highlights yet. Highlight something in a book first.'); return }
    const picks = pickHighlights(all, dh.shown, Math.max(1, dh.count), today)
    const daily = await this.library.dailyNote()
    if (!daily || !picks.length) return
    const embeds = picks.map(p => `!${this.app.fileManager.generateMarkdownLink(p.note, daily.path, `#^oct-${p.id}`).replace(/^!/, '')}`)
    const heading = 'From my books'
    await this.app.vault.process(daily, md => {
      const section = dailySection(heading, embeds)
      // run twice on one day (the command): replace today's picks instead of stacking them
      const re = new RegExp(`\\r?\\n?## ${heading}\\r?\\n[\\s\\S]*?(?=\\r?\\n## |$)`) // \r? for notes saved on Windows
      return re.test(md) ? md.replace(re, `\n${section}\n`) : `${md.replace(/\s+$/, '')}${md.trim() ? '\n\n' : ''}${section}\n`
    })
    dh.shown = recordShown(dh.shown, picks.map(p => p.id), today)
    dh.lastDay = today
    await this.saveSettings()
    if (!auto) { new Notice(`Added ${picks.length} highlight${picks.length === 1 ? '' : 's'} to ${daily.basename}`); await this.app.workspace.getLeaf(false).openFile(daily) }
  }

  /** Kindle-style Vocabulary Builder → Spaced Repetition-compatible cards (`word::definition`). */
  private async saveVocabulary(word: string, defn: string, context: string) {
    if (!defn.trim()) { new Notice('No definition to save yet'); return }
    const folder = normalizePath(this.settings.booksFolder || 'Books')
    const path = normalizePath(`${folder}/Vocabulary.md`)
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
      const f = this.app.vault.getAbstractFileByPath(path)
      const vocab = f instanceof TFile ? f : await this.app.vault.create(path, '---\ntags:\n  - flashcards\n---\n# Vocabulary\n\n')
      const plain = defn.replace(/\n+/g, ' ').replace(/\*/g, '')
      await this.app.vault.append(vocab, `${word}::${plain}\n> ${context.replace(/\n+/g, ' ').slice(0, 300)}\n\n`)
      new Notice(`Saved “${word}” to vocabulary`)
    } catch (e) {
      console.error('Octavo: saving vocabulary failed', e)
      new Notice(`Octavo could not save “${word}” to ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Ask: explains the passage (no spoilers), then offers a follow-up question about it. */
  async ask(selection: string, context: string, title: string, fraction: number) {
    if (!this.aiReady()) return
    let answer = ''
    const modal = new MarkdownModal(this.app, 'Ask', '*Thinking…*', [
      { label: 'Ask a question', run: () => void this.askQuestion(selection, context, title, fraction) },
      { label: 'Save to book note', cta: true, run: () => void this.saveAnswer(title, selection, answer) },
    ])
    modal.open()
    let last = 0
    const stream = (t: string) => { answer = t; const now = performance.now(); if (now - last > 120) { last = now; modal.setMarkdown(t) } }
    try {
      const r = await this.runAi('explain', { text: selection, context, bookTitle: title }, () =>
        `You are a reading companion for the book "${title}". The reader is ${Math.round(fraction * 100)}% through. ` +
        `Explain the selected passage clearly in at most 120 words, in plain language. Never reveal events from later in the book (no spoilers).\n\n` +
        `Context:\n${context}\n\nSelected passage:\n"${selection}"`, stream)
      answer = r.text
      modal.setMarkdown(r.footer ? `${answer}\n\n${r.footer}` : answer)
    } catch (e) {
      modal.setMarkdown(this.aiError(e))
    }
  }

  private async askQuestion(selection: string, context: string, title: string, fraction: number) {
    const question = await new TextPromptModal(this.app, 'Ask about this passage', '', 'Your question (no spoilers beyond where you are)').result()
    if (!question) return
    const input = { question, passages: context.includes(selection) ? [context] : [context, selection], position: fraction, bookTitle: title }
    let answer = ''
    const modal = new MarkdownModal(this.app, question.slice(0, 80), '*Thinking…*', [
      { label: 'Save to book note', cta: true, run: () => void this.saveAnswer(title, selection, answer ? `**${question}**\n\n${answer}` : '') },
    ])
    modal.open()
    try {
      const r = await this.runAi('ask', input, () => BYO_PROMPTS.ask(input), t => { answer = t; modal.setMarkdown(t) })
      answer = r.text
      modal.setMarkdown(r.footer ? `${answer}\n\n${r.footer}` : answer)
    } catch (e) { modal.setMarkdown(this.aiError(e)) }
  }

  /** Summarise a selection; the summary can be kept in the book note. */
  async summarise(selection: string, title: string) {
    if (!this.aiReady() || !selection.trim()) return
    let summary = ''
    const modal = new MarkdownModal(this.app, 'Summary', '*Summarising…*', [
      { label: 'Save to book note', cta: true, run: () => void this.saveAnswer(title, selection, summary, 'Summaries') },
    ])
    modal.open()
    try {
      const r = await this.runAi('summarise', { text: selection }, () => BYO_PROMPTS.summarise(selection), t => { summary = t; modal.setMarkdown(t) })
      summary = r.text
      modal.setMarkdown(r.footer ? `${summary}\n\n${r.footer}` : summary)
    } catch (e) { modal.setMarkdown(this.aiError(e)) }
  }

  /** "Summarise chapter into book note": the current chapter, appended under "## Chapter summaries". */
  async summariseChapter(view: EpubView | PdfView) {
    if (!this.aiReady()) return
    const ch = await view.chapterForAi()
    const note = view.bookNote
    if (!ch?.text.trim() || !note) { new Notice('Octavo: open a chapter first.'); return }
    const notice = new Notice(`Summarising “${ch.title}”…`, 0)
    try {
      const r = await this.runAi('chapter', { text: ch.text, title: ch.title }, () => BYO_PROMPTS.chapter(ch.title, ch.text))
      if (!r.text) throw new Error('No summary came back')
      await this.appendToNote(note, 'Chapter summaries', `### ${ch.title}\n\n${r.text}`)
      notice.hide()
      new Notice(`Chapter summary added to ${note.basename}${r.footer ? `\n${r.footer.replace(/\*/g, '')}` : ''}`, 8000)
    } catch (e) { notice.hide(); new Notice(this.aiError(e), 10000) }
  }

  /** "Flashcards from highlights": Spaced Repetition `Q::A` lines in `Books/<Title> cards.md` (vocabulary-writer style). */
  async flashcards(view: EpubView | PdfView) {
    if (!this.aiReady()) return
    const highlights = view.highlightsForAi()
    if (!highlights.length) { new Notice('Octavo: this book has no highlights yet.'); return }
    const title = view.bookTitle
    const notice = new Notice(`Making flashcards from ${highlights.length} highlight${highlights.length === 1 ? '' : 's'}…`, 0)
    try {
      const input = { highlights, bookTitle: title }
      const r = await this.runAi('flashcards', input, () => BYO_PROMPTS.flashcards(input))
      if (!r.cards.length) throw new Error('No cards came back. Try again.')
      const path = normalizePath(cardsPath(this.settings.booksFolder, title))
      const existing = this.app.vault.getAbstractFileByPath(path)
      const file = existing instanceof TFile ? existing : await this.app.vault.create(path, cardsFileHeader(title))
      const lines = newCardLines(r.cards, await this.app.vault.read(file))
      if (lines.length) await this.app.vault.append(file, `${lines.join('\n')}\n`)
      notice.hide()
      new Notice(`${lines.length ? `Added ${lines.length} card${lines.length === 1 ? '' : 's'}` : 'No new cards'} in ${file.path}${r.footer ? `\n${r.footer.replace(/\*/g, '')}` : ''}`, 8000)
    } catch (e) { notice.hide(); new Notice(this.aiError(e), 10000) }
  }

  /** Keep an AI answer: appended under "## <heading>" in the book note, quoting the passage. */
  private async saveAnswer(title: string, passage: string, answer: string, heading = 'Ask') {
    if (!answer) return
    // the open book's own note; by title only when no reader is open (titles can be edited or shared)
    const note = this.activeReader()?.bookNote ?? this.library.allBooks().map(b => b.note).find(n => this.library.getProps(n).title === title)
    if (!note) { new Notice('Could not find this book\'s note. Open the book and try again.'); return }
    const quote = passage.split('\n').map(l => `> ${l}`).join('\n')
    await this.appendToNote(note, heading, `${quote}\n\n${answer.trim()}`)
    new Notice('Saved to the book note')
  }

  /** Appends a block under "## <heading>" (created at the end once; later blocks join the same section). */
  private async appendToNote(note: TFile, heading: string, block: string) {
    await this.app.vault.process(note, md => appendUnderHeading(md, heading, block))
  }

  /** "Copy & auto-paste": append the new highlight to the last markdown note being edited. */
  async autoPaste(h: Highlight, book: TFile, note: TFile) {
    const leaf = this.lastMarkdownLeaf
    const view = leaf?.view instanceof MarkdownView ? leaf.view : null
    if (!view || view.file === note) return
    const link = this.library.linkFrom(book, view.file?.path ?? '', h) // built from the anchor: works with Markdown links too
    const quote = h.anchor.quote.exact.split('\n').map(l => `> ${l}`).join('\n')
    view.editor.replaceSelection(`${quote} ${link}\n\n`)
  }

  async loadCustomFont() {
    const p = this.settings.customFontPath
    if (!p) return
    const f = this.app.vault.getAbstractFileByPath(normalizePath(p))
    if (!(f instanceof TFile)) return
    const ext = f.extension.toLowerCase()
    const type = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'otf' ? 'font/otf' : 'font/ttf'
    if (this.customFontUrl) URL.revokeObjectURL(this.customFontUrl)
    this.customFontUrl = URL.createObjectURL(new Blob([await this.app.vault.readBinary(f)], { type }))
  }

  // ───────────────────────── goals (private, opt-in) ─────────────────────────

  private updateStatus() {
    const g = this.settings.goals
    if (!g.enabled || Platform.isMobile) { this.statusEl?.remove(); this.statusEl = null; return }
    if (!this.statusEl) { this.statusEl = this.addStatusBarItem(); this.statusEl.addClass('octavo-status'); this.statusEl.onclick = () => this.showGoal() }
    const st = computeStreak(this.settings.stats.minutesByDay, g.dailyMinutes, new Date(), g.restDaysPerWeek)
    this.statusEl.setText(`📖 ${Math.min(st.todayMinutes, g.dailyMinutes)}/${g.dailyMinutes} min${st.current ? ` · ${st.current}-day streak` : ''}`)
  }

  showGoal() {
    const g = this.settings.goals
    const st = computeStreak(this.settings.stats.minutesByDay, g.dailyMinutes, new Date(), g.restDaysPerWeek)
    const year = moment().format('YYYY')
    const finished = this.settings.stats.finishedByYear[year] ?? 0
    new MarkdownModal(this.app, 'Reading goal', [
      `**Today:** ${st.todayMinutes} of ${g.dailyMinutes} minutes${st.metToday ? ' ✓' : ''}`,
      `**Streak:** ${st.current} day${st.current === 1 ? '' : 's'} (best ${st.best}). One rest day a week never breaks it.`,
      `**${year}:** ${finished} of ${g.yearlyBooks} books finished`,
      g.enabled ? '' : '\n*Goals are off. Turn them on in Octavo settings → Goals.*',
    ].join('\n\n')).open()
  }

  async yearInReview(): Promise<void> {
    const year = moment().format('YYYY')
    const books = this.library.allBooks().map(b => ({ ...b, p: this.library.getProps(b.note) }))
    const finished = books.filter(b => b.p.status === 'finished' && propText(b.p.finished ?? '').startsWith(year))
    const minutes = Object.entries(this.settings.stats.minutesByDay).filter(([d]) => d.startsWith(year)).reduce((a, [, m]) => a + m, 0)
    const byMonth = new Map<string, number>()
    for (const [d, m] of Object.entries(this.settings.stats.minutesByDay)) if (d.startsWith(year)) byMonth.set(d.slice(5, 7), (byMonth.get(d.slice(5, 7)) ?? 0) + m)
    // highlights made this year, not every highlight ever
    let highlights = 0
    for (const b of books) for (const h of await this.library.highlights(b.note)) if (h.created && moment(h.created).format('YYYY') === year) highlights++
    const lines = [
      YEAR_START,
      `# ${year} in reading`, '',
      `- **${finished.length}** books finished`, `- **${hoursMinutes(minutes)}** read`, `- **${highlights}** highlights kept`, '',
      '## Finished', ...finished.map(b => `- ${this.app.fileManager.generateMarkdownLink(b.note, '')}${b.p.author ? ` — ${propText(b.p.author)}` : ''}`), '',
      '## Month by month', ...[...byMonth.entries()].sort().map(([m, v]) => `- ${moment(m, 'MM').format('MMMM')}: ${hoursMinutes(v)}`), '',
      YEAR_END,
    ]
    const folder = normalizePath(this.settings.booksFolder || 'Books')
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {})
    const path = normalizePath(`${folder}/Year in review ${year}.md`)
    const existing = this.app.vault.getAbstractFileByPath(path)
    const block = lines.join('\n')
    let f: TFile
    if (existing instanceof TFile) {
      // run again: only the generated part is replaced, what you wrote around it stays
      await this.app.vault.process(existing, md => {
        const a = md.indexOf(YEAR_START), b = md.indexOf(YEAR_END)
        if (a >= 0 && b > a) return md.slice(0, a) + block + md.slice(b + YEAR_END.length)
        // written by an older version without markers: that text was all generated
        return md.startsWith(`# ${year} in reading`) ? block : `${block}\n\n${md}`
      })
      f = existing
    } else f = await this.app.vault.create(path, block)
    await this.app.workspace.getLeaf('tab').openFile(f)
  }
}
