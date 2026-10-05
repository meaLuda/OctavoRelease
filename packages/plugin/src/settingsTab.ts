import { App, PluginSettingTab, Setting } from 'obsidian'
import type OctavoPlugin from './main'
import type { TapAction } from './settings'
import { THEMES } from './reader/themes'
import { DEFAULT_MODELS, askAI, listOllamaModels } from './ai/ask'
import { Notice } from 'obsidian'
import { ImportModal } from './library/ImportModal'

const TAP_LABELS: Record<TapAction, string> = { prev: 'Previous page', next: 'Next page', menu: 'Show controls', bookmark: 'Bookmark', toc: 'Contents', search: 'Search', none: 'Nothing' }

export class OctavoSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OctavoPlugin) { super(app, plugin) }

  display(): void {
    const { containerEl: c } = this
    const s = this.plugin.settings
    const save = () => void this.plugin.saveSettings()
    c.empty()

    new Setting(c).setName('Library').setHeading()
    new Setting(c).setName('Book notes folder').setDesc('Each book gets one note here. Highlights are written to it as callouts.')
      .addText(t => t.setValue(s.booksFolder).onChange(v => { s.booksFolder = v.trim() || 'Books'; save() }))
    new Setting(c).setName('Covers folder')
      .addText(t => t.setValue(s.coversFolder).onChange(v => { s.coversFolder = v.trim() || 'Books/covers'; save() }))
    new Setting(c).setName('Open PDFs in Octavo').setDesc('Use Octavo instead of the built-in PDF viewer. Existing PDF++ links keep working.')
      .addToggle(t => t.setValue(s.openPdfInOctavo).onChange(v => { s.openPdfInOctavo = v; this.plugin.applyPdfRouting(); save() }))
    new Setting(c).setName('Import highlights').setDesc('From Annotator, Elton, Weave, Kindle, KOReader or Readest.')
      .addButton(b => b.setButtonText('Import…').onClick(() => new ImportModal(this.app, this.plugin).open()))

    new Setting(c).setName('Reading').setHeading()
    new Setting(c).setName('Theme').addDropdown(d => {
      for (const [id, t] of Object.entries(THEMES)) d.addOption(id, t.name)
      d.setValue(s.theme).onChange(v => { s.theme = v as typeof s.theme; save() })
    })
    new Setting(c).setName('Hide controls after').setDesc('Milliseconds. 0 keeps them visible.')
      .addSlider(sl => sl.setLimits(0, 6000, 500).setValue(s.autoHideMs).setDynamicTooltip().onChange(v => { s.autoHideMs = v; save() }))
    new Setting(c).setName('Left-handed tap zones').setDesc('Mirror the left and right page-turn zones.')
      .addToggle(t => t.setValue(s.leftHanded).onChange(v => { s.leftHanded = v; save() }))
    const grid = c.createDiv({ cls: 'octavo-tapzone-editor' })
    grid.createDiv({ cls: 'setting-item-name', text: 'Tap zones' })
    const cells = grid.createDiv({ cls: 'octavo-tapzone-grid' })
    s.tapZones.forEach((a, i) => {
      const sel = cells.createEl('select', { cls: 'dropdown' })
      for (const [k, label] of Object.entries(TAP_LABELS)) { const o = sel.createEl('option', { text: label, value: k }); if (k === a) o.selected = true }
      sel.onchange = () => { s.tapZones[i] = sel.value as TapAction; save() }
    })
    new Setting(c).setName('Custom font file').setDesc('Path to a .ttf, .otf or .woff2 in your vault (e.g. Atkinson Hyperlegible, Literata, OpenDyslexic). Choose “Custom font” in Appearance.')
      .addText(t => t.setPlaceholder('Fonts/AtkinsonHyperlegible.ttf').setValue(s.customFontPath).onChange(v => { s.customFontPath = v.trim(); save() }))
    new Setting(c).setName('Auto-scroll speed').setDesc('Pixels per second.')
      .addSlider(sl => sl.setLimits(10, 200, 5).setValue(s.autoScrollSpeed).setDynamicTooltip().onChange(v => { s.autoScrollSpeed = v; save() }))

    new Setting(c).setName('Highlights').setHeading()
    new Setting(c).setName('Default colour').addDropdown(d => {
      for (const col of ['yellow', 'green', 'blue', 'pink', 'purple']) d.addOption(col, col[0]!.toUpperCase() + col.slice(1))
      d.setValue(s.defaultColor).onChange(v => { s.defaultColor = v as typeof s.defaultColor; save() })
    })
    new Setting(c).setName('Auto-paste into last note').setDesc('Every new highlight is also inserted, with its link, into the note you last edited — read on one side, write on the other.')
      .addToggle(t => t.setValue(s.autoPaste).onChange(v => { s.autoPaste = v; save() }))

    new Setting(c).setName('Read aloud').setHeading()
    new Setting(c).setName('Voices').setDesc('System voices are free and offline. Natural voices (Kokoro) need Octavo Cloud.')
      .addDropdown(d => d.addOption('system', 'System voices').addOption('cloud', 'Natural voices (Octavo Cloud)')
        .setValue(s.tts.engine).onChange(v => { s.tts.engine = v as 'system' | 'cloud'; save(); this.display() }))
    if (s.tts.engine === 'cloud') new Setting(c).setName('Natural voice').addDropdown(d => {
      const voices: Record<string, string> = { af_heart: 'Heart (US, warm)', af_bella: 'Bella (US)', af_nicole: 'Nicole (US, soft)', am_michael: 'Michael (US)', am_fenrir: 'Fenrir (US, deep)', bf_emma: 'Emma (UK)', bm_george: 'George (UK)', bm_fable: 'Fable (UK)' }
      for (const [k, v] of Object.entries(voices)) d.addOption(k, v)
      d.setValue(s.tts.cloudVoice).onChange(v => { s.tts.cloudVoice = v; save() })
    })
    new Setting(c).setName('System voice').addDropdown(d => {
      d.addOption('', 'System default')
      for (const v of speechSynthesis.getVoices()) d.addOption(v.name, `${v.name} (${v.lang})`)
      d.setValue(s.tts.voice).onChange(v => { s.tts.voice = v; save() })
    })
    new Setting(c).setName('Speed').addSlider(sl => sl.setLimits(0.5, 3, 0.1).setValue(s.tts.rate).setDynamicTooltip().onChange(v => { s.tts.rate = v; save() }))

    new Setting(c).setName('Goals').setHeading()
    new Setting(c).setName('Reading goals').setDesc('Private and off by default: a daily minutes goal with a forgiving streak. Nothing leaves your device.')
      .addToggle(t => t.setValue(s.goals.enabled).onChange(v => { s.goals.enabled = v; save(); this.display() }))
    if (s.goals.enabled) {
      new Setting(c).setName('Minutes per day').addText(t => t.setValue(String(s.goals.dailyMinutes)).onChange(v => { s.goals.dailyMinutes = Math.max(1, Number(v) || 15); save() }))
      new Setting(c).setName('Books per year').addText(t => t.setValue(String(s.goals.yearlyBooks)).onChange(v => { s.goals.yearlyBooks = Math.max(1, Number(v) || 12); save() }))
    }
    new Setting(c).setName('Log reading sessions to the daily note').setDesc('Adds a line like “📖 Book · 25 min · 40% → 52%” under a Reading heading.')
      .addToggle(t => t.setValue(s.dailyNoteLog).onChange(v => { s.dailyNoteLog = v; save() }))

    new Setting(c).setName('AI (your own key)').setHeading()
    c.createEl('p', { cls: 'setting-item-description', text: 'Optional. Requests go directly from this device to the provider you choose, only when you press Ask or Define.' })
    new Setting(c).setName('Provider').addDropdown(d => d
      .addOption('none', 'Off').addOption('anthropic', 'Anthropic').addOption('openai', 'OpenAI-compatible').addOption('ollama', 'Ollama (local)')
      .setValue(s.ai.provider).onChange(v => { s.ai.provider = v as typeof s.ai.provider; save(); this.display() }))
    if (s.ai.provider !== 'none') {
      if (s.ai.provider !== 'ollama') new Setting(c).setName('API key').addText(t => { t.inputEl.type = 'password'; t.setValue(s.ai.apiKey).onChange(v => { s.ai.apiKey = v.trim(); save() }) })
      if (s.ai.provider === 'ollama') {
        const ms = new Setting(c).setName('Model').setDesc('Models installed in your local Ollama. Everything stays on this machine.')
        ms.addDropdown(d => {
          d.addOption('', 'Loading…')
          void listOllamaModels(s).then(models => {
            d.selectEl.empty()
            if (!models.length) { d.addOption('', 'Ollama not reachable — is it running?'); return }
            for (const m of models) d.addOption(m, m)
            if (!s.ai.model || !models.includes(s.ai.model)) { s.ai.model = models[0]!; save() }
            d.setValue(s.ai.model)
          })
          d.onChange(v => { s.ai.model = v; save() })
        })
      } else {
        new Setting(c).setName('Model').setDesc(s.ai.provider === 'openai' ? 'Required.' : `Default: ${DEFAULT_MODELS[s.ai.provider]}`)
          .addText(t => t.setValue(s.ai.model).onChange(v => { s.ai.model = v.trim(); save() }))
      }
      new Setting(c).setName('Base URL').setDesc(s.ai.provider === 'ollama' ? 'Default http://localhost:11434. On a phone, use your computer\'s LAN address (e.g. http://192.168.1.20:11434) with OLLAMA_HOST=0.0.0.0.' : 'Leave empty for the default endpoint.')
        .addText(t => t.setValue(s.ai.baseUrl).onChange(v => { s.ai.baseUrl = v.trim(); save() }))
      new Setting(c).setName('Test connection').addButton(b => b.setButtonText('Test').onClick(async () => {
        b.setDisabled(true); b.setButtonText('Testing…')
        try {
          const t0 = performance.now()
          const out = await askAI(s, 'Reply with exactly: OK')
          new Notice(`AI connected (${Math.round(performance.now() - t0)} ms): ${out.trim().slice(0, 40)}`)
        } catch (e) { new Notice(`AI test failed: ${(e as Error).message}`) }
        b.setDisabled(false); b.setButtonText('Test')
      }))
    }

    new Setting(c).setName('Octavo Cloud').setHeading()
    c.createEl('p', { cls: 'setting-item-description', text: 'Optional paid service: keep books outside your vault (works with Obsidian Sync Standard\'s 5 MB limit), send books by email, OCR for scanned PDFs, natural read-aloud voices and KOReader sync. Octavo itself is free and works fully without it.' })
    this.plugin.cloud.renderSettings(c, () => this.display())
  }
}
