import { App, FuzzySuggestModal, Modal, Setting, type FuzzyMatch } from 'obsidian'
import { FACET_LABEL, type Facet, type FacetValue } from './organise'
import { destructive } from '../platform'

/** Searchable picker for one facet's values (folders show indented). Works as a sheet on phones. */
export class FacetSuggestModal extends FuzzySuggestModal<FacetValue> {
  constructor(app: App, private facet: Facet, private values: FacetValue[], private active: string[], private onPick: (v: string) => void) {
    super(app)
    this.setPlaceholder(`Filter by ${FACET_LABEL[facet].toLowerCase()}…`)
    this.modalEl.addClass('octavo-facet-modal')
  }
  getItems() { return this.values }
  getItemText(v: FacetValue) { return v.value }
  renderSuggestion(m: FuzzyMatch<FacetValue>, el: HTMLElement) {
    const v = m.item
    el.addClass('octavo-facet-item')
    if (this.facet === 'folders') el.addClass(`octavo-depth-${Math.min(v.depth, 6)}`)
    el.toggleClass('is-active', this.active.some(a => a.toLowerCase() === v.value.toLowerCase()))
    el.createSpan({ cls: 'octavo-facet-name', text: this.facet === 'folders' ? (v.value.split('/').pop() ?? v.value) : v.value })
    if (this.facet === 'folders' && v.depth) el.createSpan({ cls: 'octavo-facet-path', text: v.value })
    el.createSpan({ cls: 'octavo-facet-n', text: String(v.count) })
  }
  onChooseItem(v: FacetValue) { this.onPick(v.value) }
}

/** Yes/no confirmation with a destructive button. */
export class ConfirmModal extends Modal {
  private done = false
  private resolve!: (v: boolean) => void
  private promise = new Promise<boolean>(r => (this.resolve = r))
  constructor(app: App, private heading: string, private message: string, private yes: string) { super(app) }
  result() { this.open(); return this.promise }
  onOpen() {
    this.setTitle(this.heading)
    this.contentEl.createEl('p', { text: this.message })
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => destructive(b.setButtonText(this.yes)).onClick(() => { this.done = true; this.resolve(true); this.close() }))
  }
  onClose() { if (!this.done) this.resolve(false); this.contentEl.empty() }
}

/**
 * Right-click and long-press (touch) both open `open`. Mobile webviews may also fire `contextmenu`
 * after a long press, so a menu shown by the timer suppresses the next one.
 */
export function onContextOrLongPress(el: HTMLElement, open: (e: MouseEvent | PointerEvent) => void, ms = 500) {
  let timer = 0, fired = 0, x = 0, y = 0
  const cancel = () => { if (timer) window.clearTimeout(timer); timer = 0 }
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return
    x = e.clientX; y = e.clientY
    cancel()
    timer = window.setTimeout(() => { timer = 0; fired = Date.now(); open(e) }, ms)
  })
  el.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel() })
  el.addEventListener('pointerup', cancel)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('click', e => { if (Date.now() - fired < 700) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  el.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (Date.now() - fired < 1000) return
    open(e)
  })
}
