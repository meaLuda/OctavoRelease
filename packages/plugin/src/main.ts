import { addIcon, Plugin, TFile, WorkspaceLeaf, MarkdownView, Notice, Menu, requestUrl, moment, normalizePath, Platform, type TAbstractFile } from 'obsidian'
import { Pace, computeStreak, parseHighlights as parseHighlightsFresh, buildLiteratureNote, refreshLiteratureNote, resolveLiteratureNotePath, EXPORT_BOOK_ID, citekeyFrom, type Highlight, type CopyFormat, type LiteratureInput } from '@octavo/shared'
import { upgradeLayouts } from './pdf/layout'
import { DEFAULT_SETTINGS, type OctavoSettings } from './settings'
import { BookLibrary, BOOK_EXTENSIONS, isBookFile } from './library/BookLibrary'
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

/** Octavo mark: an open book with a ribbon bookmark (100×100, currentColor, Lucide-weight strokes). */
const OCTAVO_ICON = `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M50 30C39 22 24 19 9 21v57c15-2 30 1 41 9 11-8 26-11 41-9V21c-15-2-30 1-41 9z"/>
  <path d="M50 30v57"/>
</g>
<path d="M62 23.5V56l9-7.5 9 7.5V20.5c-6 .2-12 1.2-18 3z" fill="currentColor"/>`

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

  async onload() {
    // Register views first (synchronously) so Obsidian can restore open book tabs on startup.
    addIcon('octavo', OCTAVO_ICON)
    this.registerView(EPUB_VIEW, leaf => new EpubView(leaf, this))
    this.registerView(PDF_VIEW, leaf => new PdfView(leaf, this))
    this.registerView(LIBRARY_VIEW, leaf => new LibraryView(leaf, this))
    for (const ext of BOOK_EXTENSIONS) {
      try { this.registerExtensions([ext], EPUB_VIEW) }
      catch { console.warn(`Octavo: .${ext} is already handled by another plugin; use "Open in Octavo".`) }
    }
    this.ready = this.loadSettings()
    await this.ready
    this.pace = Pace.fromJSON(this.settings.pace)
    this.library = new BookLibrary(this.app, () => this.settings)
    this.cloud = new CloudClient(this)
    this.cloud.watchLabels()

    this.registerHoverLinkSource('octavo', { display: 'Octavo', defaultMod: true })
    this.applyPdfRouting()
    this.register(() => { const reg = (this.app as any).viewRegistry; if (reg?.typeByExtension?.pdf === PDF_VIEW) reg.typeByExtension.pdf = this.pdfDefaultType })
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
      void this.loadCustomFont()
      this.updateStatus()
      void this.welcomeOnMobile()
    })
    this.registerEvent(this.app.metadataCache.on('changed', f => this.library.indexNote(f)))
    this.registerEvent(this.app.vault.on('delete', (f: TAbstractFile) => this.library.forgetNote(f.path)))
    this.registerEvent(this.app.vault.on('rename', (f: TAbstractFile, old: string) => {
      if (f instanceof TFile && isBookFile(f)) this.library.renameBook(old, f.path)
      else { this.library.forgetNote(old); if (f instanceof TFile) this.library.indexNote(f) }
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
    const data = (await this.loadData()) ?? {}
    const d = DEFAULT_SETTINGS
    this.settings = {
      ...d, ...data,
      goals: { ...d.goals, ...data.goals },
      stats: { ...d.stats, ...data.stats },
      tts: { ...d.tts, ...data.tts },
      ai: { ...d.ai, ...data.ai },
      cloud: { ...d.cloud, ...data.cloud },
      library: { ...d.library, ...data.library },
      copyTemplates: { ...d.copyTemplates, ...data.copyTemplates },
      overrides: { ...data.overrides },
      pdfLayouts: { ...data.pdfLayouts },
      tapZones: Array.isArray(data.tapZones) && data.tapZones.length === 9 ? data.tapZones : d.tapZones,
    }
    if ((this.settings.pdfLayoutVersion ?? 1) < 2) {
      this.settings.pdfLayouts = upgradeLayouts(this.settings.pdfLayouts)
      this.settings.pdfLayoutVersion = 2
    }
  }

  async saveSettings() {
    this.settings.pace = this.pace?.toJSON() ?? this.settings.pace
    await this.saveData(this.settings)
    this.updateStatus()
  }

  // ───────────────────────── opening books ─────────────────────────

  async openInOctavo(file: TFile, leaf?: WorkspaceLeaf, eState?: Record<string, unknown>) {
    const type = file.extension === 'pdf' ? PDF_VIEW : EPUB_VIEW
    const l = leaf ?? this.app.workspace.getLeaf(false)
    await l.setViewState({ type, state: { file: file.path }, active: true }, eState)
  }

  /**
   * While "Open PDFs in Octavo" is on, Octavo is the registered viewer for .pdf
   * (Obsidian's own mapping is restored when the setting is turned off or the
   * plugin unloads). Links keep their eState, so PDF++ `#page=…&selection=…` works.
   */
  applyPdfRouting() {
    const reg = (this.app as any).viewRegistry
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
    this.addCommand({ id: 'open-library-base', name: 'Open library as a Base (table / custom views)', callback: () => void this.openLibraryBase() })
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
        const v = this.app.workspace.getActiveViewOfType(EpubView)
        if (!v) return false
        if (!checking) v.toggleAutoScroll()
        return true
      },
    })
    this.addCommand({
      id: 'focus-mode', name: 'Toggle focus mode (full screen reading)',
      checkCallback: checking => {
        const v: any = this.app.workspace.getActiveViewOfType(EpubView) ?? this.app.workspace.getActiveViewOfType(PdfView)
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
    this.registerCopyCommands()
    this.addCommand({ id: 'reading-goal', name: 'Show reading goal and streak', callback: () => this.showGoal() })
    this.addCommand({ id: 'year-in-review', name: 'Write my year in review', callback: () => void this.yearInReview() })
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
    const title = String(props.title ?? book.basename)
    const bookId = props['octavo-id'] ? String(props['octavo-id']) : book.path
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
      return tId ? String(tId) : target.path
    }
    const path = normalizePath(resolveLiteratureNotePath(this.settings.exportFolder || 'Books', title, bookId, ownerAt, citekey))
    const highlights = parseHighlightsFresh(await this.app.vault.read(note))
    const input: LiteratureInput = {
      book: title,
      bookId,
      author: Array.isArray(props.author) ? props.author.join(', ') : props.author ? String(props.author) : undefined,
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

  private async copyDiagnostics() {
    const report = await collectDiagnostics(this.app, this.manifest.version)
    try { await navigator.clipboard.writeText(report); new Notice('Octavo diagnostics copied to the clipboard') } catch { /* shown below */ }
    new MarkdownModal(this.app, 'Octavo diagnostics', '```\n' + report + '\n```').open()
  }

  async openLibrary() {
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0]
    if (existing) {
      await (existing as any).loadIfDeferred?.()
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
    try {
      if (aiConfigured(this.settings)) {
        const r = await this.runAi('explain', { text: word, context },
          () => `Define "${word}" briefly as used in this sentence. One or two lines, no preamble.\n\nSentence: ${context}`, t => modal.setMarkdown(t))
        defn = r.text
        footer = r.footer
      } else {
        const res = await requestUrl({ url: `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.toLowerCase())}`, throw: false })
        const en = res.status === 200 ? (res.json?.en ?? []) : []
        defn = en.slice(0, 2).map((p: any) => `*${p.partOfSpeech}* — ${(p.definitions?.[0]?.definition ?? '').replace(/<[^>]+>/g, '')}`).join('\n\n')
      }
    } catch (e) { if (this.hostedAi) { modal.setMarkdown(this.aiError(e)); return } defn = '' }
    modal.setMarkdown(defn ? `${defn}${footer ? `\n\n${footer}` : ''}` : `No definition found for **${word}**. Set up an AI provider in settings for context-aware definitions.`)
  }

  /** Kindle-style Vocabulary Builder → Spaced Repetition-compatible cards (`word::definition`). */
  private async saveVocabulary(word: string, defn: string, context: string) {
    const path = normalizePath(`${this.settings.booksFolder || 'Books'}/Vocabulary.md`)
    let f = this.app.vault.getAbstractFileByPath(path)
    const vocab = f instanceof TFile ? f : await this.app.vault.create(path, '---\ntags:\n  - flashcards\n---\n# Vocabulary\n\n')
    const plain = defn.replace(/\n+/g, ' ').replace(/\*/g, '')
    await this.app.vault.append(vocab, `${word}::${plain}\n> ${context.replace(/\n+/g, ' ').slice(0, 300)}\n\n`)
    new Notice(`Saved “${word}” to vocabulary`)
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
    const note = this.library.allBooks().map(b => b.note).find(n => this.library.getProps(n).title === title)
    if (!note || !answer) return
    const quote = passage.split('\n').map(l => `> ${l}`).join('\n')
    await this.appendToNote(note, heading, `${quote}\n\n${answer.trim()}`)
    new Notice('Saved to the book note')
  }

  /** Appends a block under "## <heading>" (created at the end once; later blocks join the same section). */
  private async appendToNote(note: TFile, heading: string, block: string) {
    const h = `\n## ${heading}\n\n`
    const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await this.app.vault.process(note, md => `${md.replace(/\s+$/, '')}\n${h}${block}\n`.replace(new RegExp(`\\n## ${esc}\\n\\n([\\s\\S]*)\\n## ${esc}\\n\\n`), (_m, body: string) => `\n## ${heading}\n\n${body}\n`))
  }

  /** "Copy & auto-paste": append the new highlight to the last markdown note being edited. */
  async autoPaste(h: Highlight, book: TFile, note: TFile) {
    const leaf = this.lastMarkdownLeaf
    const view = leaf?.view instanceof MarkdownView ? leaf.view : null
    if (!view || view.file === note) return
    const link = this.app.fileManager.generateMarkdownLink(book, view.file?.path ?? '', this.library.linkFor(book, note, h).match(/#[^|\]]*/)?.[0] ?? '', '↗').replace(/^!/, '')
    const quote = h.anchor.quote.exact.split('\n').map(l => `> ${l}`).join('\n')
    view.editor.replaceSelection(`${quote} ${link}\n\n`)
  }

  private async loadCustomFont() {
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

  async yearInReview() {
    const year = moment().format('YYYY')
    const books = this.library.allBooks().map(b => ({ ...b, p: this.library.getProps(b.note) }))
    const finished = books.filter(b => b.p.status === 'finished' && String(b.p.finished ?? '').startsWith(year))
    const minutes = Object.entries(this.settings.stats.minutesByDay).filter(([d]) => d.startsWith(year)).reduce((a, [, m]) => a + m, 0)
    const byMonth = new Map<string, number>()
    for (const [d, m] of Object.entries(this.settings.stats.minutesByDay)) if (d.startsWith(year)) byMonth.set(d.slice(5, 7), (byMonth.get(d.slice(5, 7)) ?? 0) + m)
    const highlights = books.reduce((a, b) => a + (Number(b.p.highlights) || 0), 0)
    const lines = [
      `# ${year} in reading`, '',
      `- **${finished.length}** books finished`, `- **${Math.round(minutes / 60)}** hours read`, `- **${highlights}** highlights kept`, '',
      '## Finished', ...finished.map(b => `- ${this.app.fileManager.generateMarkdownLink(b.note, '')}${b.p.author ? ` — ${b.p.author}` : ''}`), '',
      '## Month by month', ...[...byMonth.entries()].sort().map(([m, v]) => `- ${moment(m, 'MM').format('MMMM')}: ${Math.round(v / 60 * 10) / 10} h`), '',
    ]
    const path = normalizePath(`${this.settings.booksFolder || 'Books'}/Year in review ${year}.md`)
    const existing = this.app.vault.getAbstractFileByPath(path)
    const f = existing instanceof TFile ? (await this.app.vault.modify(existing, lines.join('\n')), existing) : await this.app.vault.create(path, lines.join('\n'))
    await this.app.workspace.getLeaf('tab').openFile(f)
  }
}
