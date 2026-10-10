import { Setting } from 'obsidian'
import {
  COPY_FORMATS, COPY_FORMAT_NAMES, DEFAULT_COPY_TEMPLATES, DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE, DEFAULT_EXPORT_NOTE_TEMPLATE, TEMPLATE_VARS,
} from '@octavo/shared'
import type OctavoPlugin from '../main'

/** Settings → "Copy formats" (copy templates, citations) and "Export highlights" (literature note). */
export function renderCopySettings(c: HTMLElement, plugin: OctavoPlugin, redraw: () => void) {
  const s = plugin.settings
  const save = () => void plugin.saveSettings()
  const vars = TEMPLATE_VARS.map(v => `{{${v}}}`).join(' ')

  const area = (name: string, desc: string, get: () => string, set: (v: string) => void, reset: string) => {
    new Setting(c).setName(name).setDesc(desc).setClass('octavo-template-setting')
      .addTextArea(t => {
        t.inputEl.rows = Math.min(10, Math.max(3, get().split('\n').length + 1))
        t.inputEl.addClass('octavo-template-input')
        t.setValue(get()).onChange(v => { set(v); save() })
      })
      .addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Restore default').onClick(() => { set(reset); save(); redraw() }))
  }

  new Setting(c).setName('Copy formats').setHeading()
  c.createEl('p', { cls: 'setting-item-description', text: `"Copy as…" in the selection and highlight menus, and the "Copy selection as…" commands, use these templates. Variables: ${vars}. A missing value is left empty; on a quoted line ("> ") every line of a multi-line passage stays quoted.` })
  for (const f of COPY_FORMATS) area(COPY_FORMAT_NAMES[f], '', () => s.copyTemplates[f], v => { s.copyTemplates[f] = v }, DEFAULT_COPY_TEMPLATES[f])

  const hint = c.createDiv({ cls: 'setting-item-description octavo-citekey-hint' })
  hint.createEl('strong', { text: 'Citations. ' })
  hint.appendText('"Copy citation" copies [@citekey, p. 12] (EPUB books without page numbers use the chapter). Octavo reads the key from the book note\'s properties: citekey, citationKey or zotero-key. Add it by hand, or let the Zotero Integration plugin with Better BibTeX write it when it creates the literature note. Books without a key show this hint instead of copying.')

  new Setting(c).setName('Export highlights').setHeading()
  c.createEl('p', { cls: 'setting-item-description', text: '"Export highlights to note" (book menu and command palette) writes "<Book title> highlights.md". Running it again refreshes only the part between %% octavo:start %% and %% octavo:end %%; anything you write outside those markers is kept.' })
  new Setting(c).setName('Folder').setDesc('Where literature notes are written.')
    .addText(t => t.setPlaceholder('Books').setValue(s.exportFolder).onChange(v => { s.exportFolder = v.trim() || 'Books'; save() }))
  area('Note template', 'Used once, when the note is created. {{highlights}} marks where the highlights go. Also: {{source}} (link to the book).',
    () => s.exportNoteTemplate, v => { s.exportNoteTemplate = v }, DEFAULT_EXPORT_NOTE_TEMPLATE)
  area('Highlight template', `Each highlight, under a heading per chapter or page. ${vars} {{tags}}. Lines left empty are removed.`,
    () => s.exportHighlightTemplate, v => { s.exportHighlightTemplate = v }, DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE)
}
