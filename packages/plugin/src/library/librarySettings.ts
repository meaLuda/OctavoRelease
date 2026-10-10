import { AbstractInputSuggest, App, Setting, TFolder, normalizePath } from 'obsidian'
import type OctavoPlugin from '../main'
import { LIBRARY_VIEW, LibraryView } from './LibraryView'
import { describeFilter } from './organise'
import { TextPromptModal } from '../reader/modals'

class FolderSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private input: HTMLInputElement) { super(app, input); this.limit = 20 }
  protected getSuggestions(q: string): string[] {
    const low = q.toLowerCase()
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
      .map(f => f.path).filter(p => p.toLowerCase().includes(low)).sort()
  }
  renderSuggestion(p: string, el: HTMLElement) { el.setText(p) }
  selectSuggestion(p: string) { this.setValue(p); this.input.dispatchEvent(new Event('input')); this.close() }
}

const refreshLibraries = (plugin: OctavoPlugin) => {
  for (const leaf of plugin.app.workspace.getLeavesOfType(LIBRARY_VIEW)) if (leaf.view instanceof LibraryView) leaf.view.refresh()
}

/** Settings → Library: folders to scan, hidden books, minimum PDF size. LibraryView's "Hide from library" notice points here. */
export function renderLibrarySettings(c: HTMLElement, plugin: OctavoPlugin, redraw: () => void) {
  const lib = plugin.settings.library
  const save = async () => { await plugin.saveSettings(); refreshLibraries(plugin) }

  new Setting(c).setName('Folders to scan').setDesc(lib.folders.length
    ? 'The library shows books in these folders, plus any book you have opened (it has a book note).'
    : 'The library scans the whole vault. Add folders to limit it.')
  const list = c.createDiv({ cls: 'octavo-settings-list' })
  for (const folder of lib.folders) {
    new Setting(list).setName(folder).addExtraButton(b => b.setIcon('x').setTooltip('Remove folder').onClick(async () => {
      lib.folders = lib.folders.filter(f => f !== folder); await save(); redraw()
    }))
  }
  let draft = ''
  new Setting(list).setName('Add a folder').addSearch(t => {
    t.setPlaceholder('Library/Books').onChange(v => (draft = v))
    new FolderSuggest(plugin.app, t.inputEl)
  }).addButton(b => b.setButtonText('Add').onClick(async () => {
    const f = normalizePath(draft.trim())
    if (!f || f === '/' || lib.folders.includes(f)) return
    lib.folders = [...lib.folders, f]; await save(); redraw()
  }))

  new Setting(c).setName('Auto-add books dropped into these folders')
    .setDesc('New EPUB and PDF files in the scanned folders (or anywhere, when no folders are set) show up in an open library right away.')
    .addToggle(t => t.setValue(lib.watch !== false).onChange(async v => { lib.watch = v; await save() }))

  new Setting(c).setName('Download Cloud books to folder')
    .setDesc('Where books opened from your Octavo Cloud library are placed. Their Cloud collections and tags are copied to the book note.')
    .addSearch(t => {
      t.setPlaceholder('Library').setValue(lib.cloudFolder ?? 'Library').onChange(v => {
        const f = normalizePath(v.trim() || 'Library')
        if (f === '/') return
        lib.cloudFolder = f; void plugin.saveSettings()
      })
      new FolderSuggest(plugin.app, t.inputEl)
    })

  const smart = lib.smart ?? []
  new Setting(c).setName('Smart collections').setDesc(smart.length
    ? 'Saved filters shown as chips in the library. Right-click (or long-press) a chip to edit or rename it.'
    : 'None yet. Filter the library, then choose "Save as smart collection".')
  if (smart.length) {
    const sl = c.createDiv({ cls: 'octavo-settings-list' })
    for (const sc of smart) {
      new Setting(sl).setName(sc.name).setDesc(describeFilter(sc.filter))
        .addExtraButton(b => b.setIcon('pencil').setTooltip('Rename').onClick(async () => {
          const name = (await new TextPromptModal(plugin.app, 'Rename smart collection', sc.name, 'Name').result())?.trim()
          if (!name) return
          lib.smart = lib.smart.map(x => (x.id === sc.id ? { ...x, name } : x)); await save(); redraw()
        }))
        .addExtraButton(b => b.setIcon('trash').setTooltip('Delete').onClick(async () => {
          lib.smart = lib.smart.filter(x => x.id !== sc.id); await save(); redraw()
        }))
    }
  }

  new Setting(c).setName('Hidden books').setDesc(lib.hidden.length
    ? 'Books you hid from the library with "Hide from library". They stay in your vault.'
    : 'None. Right-click a book in the library and choose "Hide from library" to hide it.')
  if (lib.hidden.length) {
    const hidden = c.createDiv({ cls: 'octavo-settings-list' })
    for (const path of lib.hidden) {
      new Setting(hidden).setName(path.split('/').pop() ?? path).setDesc(path).addButton(b => b.setButtonText('Unhide').onClick(async () => {
        lib.hidden = lib.hidden.filter(p => p !== path); await save(); redraw()
      }))
    }
  }

  new Setting(c).setName('Minimum PDF size').setDesc('In MB. Smaller PDFs (receipts, papers) only appear once you have opened them in Octavo.')
    .addText(t => {
      t.inputEl.type = 'number'; t.inputEl.min = '0'; t.inputEl.step = '0.5'
      t.setValue(String(lib.minPdfMB)).onChange(v => {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) return
        lib.minPdfMB = n; void save()
      })
    })
}
