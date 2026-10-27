import { Modal, Setting, type ToggleComponent } from 'obsidian'
import type OctavoPlugin from '../main'
import { isBookFile } from './BookLibrary'
import { folderCounts, foldersToSave, preselectFolders } from './folderPick'

/**
 * "Where are your books?": pick the folders the library scans. Shown once on the first
 * library open (folders empty, not asked yet) and from Settings → Library → "Choose folders…".
 */
export class FolderPickModal extends Modal {
  /** One picker at a time (two library leaves opening together must not stack two). */
  private static current: FolderPickModal | null = null
  private saved = false

  constructor(private plugin: OctavoPlugin, private onSaved?: () => void) { super(plugin.app) }

  /** First library open only: nothing chosen yet and never asked. Returns true when the modal opened. */
  static maybeAsk(plugin: OctavoPlugin, onSaved?: () => void): boolean {
    const lib = plugin.settings.library
    if (lib.folders.length || lib.foldersAsked) return false
    const counts = folderCounts(plugin.app.vault.getFiles().filter(isBookFile).map(f => f.path))
    if (!counts.length) return false // no books in folders yet: ask once there are some
    if (FolderPickModal.current) return true
    new FolderPickModal(plugin, onSaved).open()
    return true
  }

  onOpen() {
    FolderPickModal.current = this
    const lib = this.plugin.settings.library
    const counts = folderCounts(this.app.vault.getFiles().filter(isBookFile).map(f => f.path))
    const chosen = new Set(lib.folders.length ? lib.folders.map(f => counts.find(c => c.folder === f || f.startsWith(c.folder + '/'))?.folder ?? f)
      : preselectFolders(counts, this.plugin.settings.booksFolder))
    let whole = lib.foldersAsked === true && !lib.folders.length

    this.modalEl.addClass('octavo-folder-pick')
    this.setTitle('Where are your books?')
    const { contentEl: c } = this
    c.createEl('p', { text: 'Octavo shows the EPUB and PDF files in the folders you tick. Books you have already opened always stay in the library.' })

    const toggles: ToggleComponent[] = []
    new Setting(c).setName('Whole vault').setDesc('Every book anywhere in the vault.')
      .addToggle(t => t.setValue(whole).onChange(v => { whole = v; for (const x of toggles) x.setDisabled(v) }))
    const list = c.createDiv({ cls: 'octavo-folder-pick-list' })
    for (const { folder, count } of counts) {
      new Setting(list).setName(folder).setDesc(`${count} book${count === 1 ? '' : 's'}`)
        .addToggle(t => {
          toggles.push(t)
          t.setValue(chosen.has(folder)).setDisabled(whole).onChange(v => { if (v) chosen.add(folder); else chosen.delete(folder) })
        })
    }
    for (const f of lib.folders) if (!counts.some(c2 => c2.folder === f || f.startsWith(c2.folder + '/'))) chosen.add(f) // keep chosen folders with no books yet

    c.createEl('p', { cls: 'setting-item-description', text: 'You can change this any time in the library section of Octavo Reader settings.' })
    new Setting(c)
      .addButton(b => b.setButtonText('Not now').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Show these').setCta().onClick(async () => {
        lib.folders = whole ? [] : foldersToSave([...chosen])
        this.saved = true
        this.close()
      }))
  }

  onClose() {
    if (FolderPickModal.current === this) FolderPickModal.current = null
    this.contentEl.empty()
    // asked once, whichever way it was closed
    this.plugin.settings.library.foldersAsked = true
    void this.plugin.saveSettings().then(() => { if (this.saved) this.onSaved?.() })
  }
}
