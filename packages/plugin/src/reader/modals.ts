import { AbstractInputSuggest, App, Modal, Setting, MarkdownRenderer, Component } from 'obsidian'
import { applySuggestion, parseTags, tagSuggestions } from './tags'
import { destructive } from '../platform'

/** Small promise-based text prompt (multi-line). Resolves null on cancel. */
export class TextPromptModal extends Modal {
  private value: string
  private done = false
  private resolve!: (v: string | null) => void
  private promise = new Promise<string | null>(r => (this.resolve = r))
  constructor(app: App, private heading: string, initial: string, private placeholder: string) {
    super(app)
    this.value = initial
  }
  result() { this.open(); return this.promise }
  onOpen() {
    this.setTitle(this.heading)
    const ta = this.contentEl.createEl('textarea', { cls: 'octavo-prompt' })
    ta.value = this.value
    ta.placeholder = this.placeholder
    ta.rows = 4
    ta.addEventListener('input', () => (this.value = ta.value))
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submit() } })
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Save').setCta().onClick(() => this.submit()))
    window.setTimeout(() => ta.focus())
  }
  private submit() { this.done = true; this.resolve(this.value.trim()); this.close() }
  onClose() { if (!this.done) this.resolve(null); this.contentEl.empty() }
}

/** New collection: a name plus a checklist of books to put in it. Resolves null on cancel. */
export class CollectionModal extends Modal {
  private done = false
  private resolve!: (v: { name: string; picked: number[] } | null) => void
  private promise = new Promise<{ name: string; picked: number[] } | null>(r => (this.resolve = r))
  private picked = new Set<number>()
  constructor(app: App, private books: Array<{ title: string; author?: string }>, private existing: string[]) { super(app) }
  result() { this.open(); return this.promise }
  onOpen() {
    this.setTitle('New collection')
    const { contentEl } = this
    const name = contentEl.createEl('input', { type: 'text', cls: 'octavo-col-name', attr: { placeholder: 'Name, e.g. Business or exam prep' } })
    const msg = contentEl.createDiv({ cls: 'octavo-col-msg' })
    contentEl.createDiv({ cls: 'octavo-col-label', text: 'Add books' })
    const filter = contentEl.createEl('input', { type: 'search', cls: 'octavo-col-filter', attr: { placeholder: 'Filter books' } })
    const list = contentEl.createDiv({ cls: 'octavo-col-list' })
    const rows = this.books.map((b, i) => {
      const row = list.createEl('label', { cls: 'octavo-col-row' })
      const cb = row.createEl('input', { type: 'checkbox' })
      cb.addEventListener('change', () => { if (cb.checked) this.picked.add(i); else this.picked.delete(i); update() })
      row.createSpan({ cls: 'octavo-col-title', text: b.title })
      if (b.author) row.createSpan({ cls: 'octavo-col-author', text: b.author })
      return { row, text: `${b.title} ${b.author ?? ''}`.toLowerCase() }
    })
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase()
      for (const r of rows) r.row.toggleClass('is-hidden', !!q && !r.text.includes(q))
    })
    let create: { setDisabled(d: boolean): unknown; setButtonText(t: string): unknown } | undefined
    const update = () => {
      const n = name.value.trim()
      const dup = this.existing.some(e => e.toLowerCase() === n.toLowerCase())
      msg.setText(dup ? `“${n}” already exists; the books you pick are added to it.` : '')
      create?.setDisabled(!n || this.picked.size === 0)
      create?.setButtonText(this.picked.size ? `Create with ${this.picked.size} book${this.picked.size === 1 ? '' : 's'}` : 'Create')
    }
    name.addEventListener('input', update)
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); filter.focus() } })
    new Setting(contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => { create = b; b.setButtonText('Create').setCta().setDisabled(true).onClick(() => this.submit(name.value.trim())) })
    window.setTimeout(() => name.focus())
  }
  private submit(name: string) {
    if (!name || !this.picked.size) return
    this.done = true; this.resolve({ name, picked: [...this.picked] }); this.close()
  }
  onClose() { if (!this.done) this.resolve(null); this.contentEl.empty() }
}

/** Shows markdown (AI answers, definitions) with optional actions. */
export class MarkdownModal extends Modal {
  private comp = new Component()
  constructor(app: App, private heading: string, private markdown: string, private actions: Array<{ label: string; cta?: boolean; run: () => void }> = []) { super(app) }
  onOpen() {
    this.setTitle(this.heading)
    this.comp.load()
    const body = this.contentEl.createDiv({ cls: 'octavo-md-modal' })
    void MarkdownRenderer.render(this.app, this.markdown, body, '', this.comp)
    if (this.actions.length) {
      const s = new Setting(this.contentEl)
      for (const a of this.actions) s.addButton(b => { b.setButtonText(a.label).onClick(() => { a.run(); this.close() }); if (a.cta) b.setCta() })
    }
  }
  setMarkdown(md: string) { this.markdown = md; this.contentEl.empty(); this.onOpen() }
  onClose() { this.comp.unload(); this.contentEl.empty() }
}

/** Every tag in the vault (without '#'), for autocomplete. */
export function vaultTags(app: App): string[] {
  const mc = app.metadataCache as unknown as { getTags?: () => Record<string, number> }
  return Object.keys(mc.getTags?.() ?? {}).map(t => t.replace(/^#/, ''))
}

class TagSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private input: HTMLInputElement, private known: () => string[]) { super(app, input); this.limit = 8 }
  protected getSuggestions(query: string): string[] { return tagSuggestions(query, this.known()) }
  renderSuggestion(tag: string, el: HTMLElement) { el.setText(`#${tag}`) }
  selectSuggestion(tag: string) {
    this.setValue(applySuggestion(this.input.value, tag))
    this.input.dispatchEvent(new Event('input'))
    this.input.focus()
  }
}

/** Prompt for highlight tags (comma or space separated, autocompleted from vault tags). Resolves null on cancel. */
export class TagPromptModal extends Modal {
  private value: string
  private done = false
  private resolve!: (v: string[] | null) => void
  private promise = new Promise<string[] | null>(r => (this.resolve = r))
  constructor(app: App, initial: string[], private known: string[] = vaultTags(app)) {
    super(app)
    this.value = initial.length ? `${initial.join(', ')}, ` : ''
  }
  result() { this.open(); return this.promise }
  onOpen() {
    this.setTitle('Tags')
    const input = this.contentEl.createEl('input', { cls: 'octavo-tag-input', type: 'text', attr: { placeholder: 'idea, to-review, chapter-3', 'aria-label': 'Tags, separated by commas or spaces' } })
    input.value = this.value
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'Separate tags with commas or spaces. Leave empty to remove all tags.' })
    new TagSuggest(this.app, input, () => this.known)
    input.addEventListener('input', () => (this.value = input.value))
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && (e.metaKey || e.ctrlKey || !this.containerEl.doc.querySelector('.suggestion-container'))) { e.preventDefault(); this.submit() } })
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Save').setCta().onClick(() => this.submit()))
    window.setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
  }
  private submit() { this.done = true; this.resolve(parseTags(this.value)); this.close() }
  onClose() { if (!this.done) this.resolve(null); this.contentEl.empty() }
}

/** Destructive confirmation: the button only works once the user types the confirmation word. */
export class TypeToConfirmModal extends Modal {
  private done = false
  private resolve!: (ok: boolean) => void
  private promise = new Promise<boolean>(r => (this.resolve = r))
  constructor(app: App, private heading: string, private message: string, private word: string, private button: string) { super(app) }
  result() { this.open(); return this.promise }
  onOpen() {
    this.setTitle(this.heading)
    this.contentEl.createEl('p', { text: this.message })
    const input = this.contentEl.createEl('input', { cls: 'octavo-tag-input', type: 'text', attr: { placeholder: `Type ${this.word} to confirm`, 'aria-label': `Type ${this.word} to confirm` } })
    let go: HTMLButtonElement | null = null
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => { go = b.buttonEl; destructive(b.setButtonText(this.button)).setDisabled(true).onClick(() => { if (input.value.trim() === this.word) { this.done = true; this.resolve(true); this.close() } }) })
    input.addEventListener('input', () => { if (go) go.disabled = input.value.trim() !== this.word })
    window.setTimeout(() => input.focus())
  }
  onClose() { if (!this.done) this.resolve(false); this.contentEl.empty() }
}
