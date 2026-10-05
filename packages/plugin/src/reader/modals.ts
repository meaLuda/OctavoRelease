import { App, Modal, Setting, MarkdownRenderer, Component } from 'obsidian'

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
