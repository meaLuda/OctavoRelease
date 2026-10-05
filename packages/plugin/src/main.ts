import { addIcon, Plugin, TFile, WorkspaceLeaf, MarkdownView, Notice, Menu, requestUrl, moment, normalizePath, Platform, type TAbstractFile } from 'obsidian'
import { Pace, computeStreak, type Highlight } from '@octavo/shared'
import { DEFAULT_SETTINGS, type OctavoSettings } from './settings'
import { BookLibrary, BOOK_EXTENSIONS, isBookFile } from './library/BookLibrary'
import { EpubView, EPUB_VIEW } from './epub/EpubView'
import { PdfView, PDF_VIEW } from './pdf/PdfView'
import { OctavoSettingTab } from './settingsTab'
import { MarkdownModal } from './reader/modals'
import { registerShelf, ensureLibraryBase } from './library/shelf'
import { ImportModal } from './library/ImportModal'
import { LibraryView, LIBRARY_VIEW } from './library/LibraryView'
import { askAI, aiConfigured } from './ai/ask'
import { CloudClient } from './cloud/CloudClient'

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

    this.registerHoverLinkSource('octavo', { display: 'Octavo', defaultMod: true })
    this.applyPdfRouting()
    this.register(() => { const reg = (this.app as any).viewRegistry; if (reg?.typeByExtension?.pdf === PDF_VIEW) reg.typeByExtension.pdf = this.pdfDefaultType })
    registerShelf(this)

    this.addRibbonIcon('octavo', 'Octavo library', () => void this.openLibrary())
    this.addSettingTab(new OctavoSettingTab(this.app, this))
    this.registerCommands()
    this.registerFileMenu()

    this.app.workspace.onLayoutReady(() => {
      this.library.reindex()
      void this.loadCustomFont()
      this.updateStatus()
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
      overrides: { ...data.overrides },
      tapZones: Array.isArray(data.tapZones) && data.tapZones.length === 9 ? data.tapZones : d.tapZones,
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
      if (this.cloud.signedIn) menu.addItem(i => i.setTitle('Move to Octavo Cloud library').setIcon('cloud-upload').onClick(() => void this.cloud.uploadBook(f)))
    }))
  }

  private registerCommands() {
    this.addCommand({ id: 'open-library', name: 'Open library', callback: () => void this.openLibrary() })
    this.addCommand({ id: 'open-library-base', name: 'Open library as a Base (table / custom views)', callback: () => void this.openLibraryBase() })
    this.addCommand({ id: 'import-highlights', name: 'Import highlights from another reader…', callback: () => new ImportModal(this.app, this).open() })
    this.addCommand({
      id: 'open-current-in-octavo', name: 'Open current file in Octavo',
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
        if (!checking) void this.app.workspace.getLeaf('split').openFile(note)
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
    this.addCommand({ id: 'reading-goal', name: 'Show reading goal and streak', callback: () => this.showGoal() })
    this.addCommand({ id: 'year-in-review', name: 'Write my year in review', callback: () => void this.yearInReview() })
    this.addCommand({ id: 'cloud-sign-in', name: 'Sign in to Octavo Cloud', callback: () => void this.cloud.signIn() })
    this.addCommand({ id: 'cloud-library', name: 'Browse Octavo Cloud library', callback: () => void this.cloud.browse() })
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

  async define(text: string, context: string) {
    const word = text.trim().split(/\s+/).slice(0, 4).join(' ')
    if (!word) return
    const modal = new MarkdownModal(this.app, word, '*Looking up…*', [
      { label: 'Save to vocabulary', cta: true, run: () => void this.saveVocabulary(word, defn, context) },
    ])
    let defn = ''
    modal.open()
    try {
      if (aiConfigured(this.settings)) {
        defn = await askAI(this.settings, `Define "${word}" briefly as used in this sentence. One or two lines, no preamble.\n\nSentence: ${context}`, t => modal.setMarkdown(t))
      } else {
        const res = await requestUrl({ url: `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.toLowerCase())}`, throw: false })
        const en = res.status === 200 ? (res.json?.en ?? []) : []
        defn = en.slice(0, 2).map((p: any) => `*${p.partOfSpeech}* — ${(p.definitions?.[0]?.definition ?? '').replace(/<[^>]+>/g, '')}`).join('\n\n')
      }
    } catch (e) { defn = '' }
    modal.setMarkdown(defn || `No definition found for **${word}**. Set up an AI provider in settings for context-aware definitions.`)
  }

  /** Kindle-style Vocabulary Builder → Spaced Repetition-compatible cards (`word::definition`). */
  private async saveVocabulary(word: string, defn: string, context: string) {
    const path = normalizePath(`${this.settings.booksFolder || 'Books'}/Vocabulary.md`)
    let f = this.app.vault.getAbstractFileByPath(path)
    if (!(f instanceof TFile)) f = await this.app.vault.create(path, '---\ntags:\n  - flashcards\n---\n# Vocabulary\n\n')
    const plain = defn.replace(/\n+/g, ' ').replace(/\*/g, '')
    await this.app.vault.append(f as TFile, `${word}::${plain}\n> ${context.replace(/\n+/g, ' ').slice(0, 300)}\n\n`)
    new Notice(`Saved “${word}” to vocabulary`)
  }

  async ask(selection: string, context: string, title: string, fraction: number) {
    if (!aiConfigured(this.settings)) {
      new Notice('Octavo: add your AI provider (OpenAI, Anthropic or local Ollama) in settings to ask about a passage.')
      return
    }
    let answer = ''
    const modal = new MarkdownModal(this.app, 'Ask', '*Thinking…*', [
      { label: 'Save to book note', cta: true, run: () => void this.saveAnswer(title, selection, answer) },
    ])
    modal.open()
    let last = 0
    const stream = (t: string) => { answer = t; const now = performance.now(); if (now - last > 120) { last = now; modal.setMarkdown(t) } }
    try {
      answer = await askAI(this.settings,
        `You are a reading companion for the book "${title}". The reader is ${Math.round(fraction * 100)}% through. ` +
        `Explain the selected passage clearly in at most 120 words, in plain language. Never reveal events from later in the book (no spoilers).\n\n` +
        `Context:\n${context}\n\nSelected passage:\n"${selection}"`, stream)
      modal.setMarkdown(answer)
    } catch (e) {
      modal.setMarkdown(`Could not reach your AI provider: ${(e as Error).message}`)
    }
  }

  /** Keep an AI answer: appended under "## Ask" in the book note, quoting the passage. */
  private async saveAnswer(title: string, passage: string, answer: string) {
    const note = this.library.allBooks().map(b => b.note).find(n => this.library.getProps(n).title === title)
    if (!note || !answer) return
    const quote = passage.split('\n').map(l => `> ${l}`).join('\n')
    await this.app.vault.process(note, md => `${md.replace(/\s+$/, '')}\n\n## Ask\n\n${quote}\n\n${answer.trim()}\n`.replace(/\n## Ask\n\n([\s\S]*)\n## Ask\n\n/, '\n## Ask\n\n$1\n'))
    new Notice('Saved to the book note')
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
