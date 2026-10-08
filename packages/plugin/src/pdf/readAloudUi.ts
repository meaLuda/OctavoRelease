import { Menu, Notice, setIcon } from 'obsidian'
import { hasCloud } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { el, iconButton } from '../reader/ui'
import { Speaker } from '../reader/speech'
import { PdfReadAloud, SystemEngine, CloudEngine, type ItemRange, type PageInput, type ReadState, type SpeechEngine } from './readAloud'

export interface ReadAloudHost {
  root: HTMLElement
  pageCount(): number
  /** Text items of page n (pdf.js getTextContent items that have `str`, same indices as the text layer's spans). */
  pageInput(n: number): Promise<PageInput | null>
  /** The page's text-layer spans, if it is rendered. */
  spans(n: number): HTMLElement[] | undefined
  goToPage(n: number): void
  currentPage(): number
  /** First page of each top-level outline entry. */
  sections(): number[]
  setSpeaking(on: boolean): void
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
const CURRENT = 'octavo-tts-current'

/**
 * Read-aloud for the PDF view: owns the controller, the mini player bar and the
 * current-sentence highlight (a class on the text-layer spans being read).
 */
export class PdfReadAloudUi {
  private ctl: PdfReadAloud | null = null
  private bar: HTMLElement
  private playBtn!: HTMLElement
  private rateBtn!: HTMLElement
  private sleepBtn!: HTMLElement
  private info!: HTMLElement
  private ranges: ItemRange[] = []
  private lit: HTMLElement[] = []
  private noTextShown = false
  private infoTimer = 0

  constructor(private plugin: OctavoPlugin, private host: ReadAloudHost) {
    this.bar = el('div', 'octavo-tts-bar', host.root)
    this.bar.hide()
    this.bar.addEventListener('click', e => e.stopPropagation())
    iconButton(this.bar, 'skip-back', 'Previous sentence', () => this.ctl?.prev())
    this.playBtn = iconButton(this.bar, 'pause', 'Pause', () => this.ctl?.toggle())
    iconButton(this.bar, 'skip-forward', 'Next sentence', () => this.ctl?.next())
    this.rateBtn = el('button', 'octavo-tts-rate clickable-icon', this.bar)
    this.rateBtn.setAttribute('aria-label', 'Speed')
    this.rateBtn.addEventListener('click', e => { e.stopPropagation(); this.rateMenu(e) })
    this.sleepBtn = iconButton(this.bar, 'timer', 'Sleep timer', e => this.sleepMenu(e))
    this.info = el('span', 'octavo-tts-info', this.bar)
    iconButton(this.bar, 'square', 'Stop reading', () => this.stop())
    this.showRate()
  }

  get active() { return !!this.ctl?.active }

  /** Speak button: start at the current page, or pause/resume a running session. */
  toggle() {
    if (this.ctl?.active) this.ctl.toggle()
    else void this.play(this.host.currentPage())
  }

  /** Start reading at `page`, optionally at the sentence containing text item `item` (char `offset`). */
  async play(page: number, item?: number, offset?: number) {
    this.ctl?.dispose()
    this.noTextShown = false
    const ctl = new PdfReadAloud({
      engine: await this.engine(),
      pageCount: this.host.pageCount(),
      rate: this.plugin.settings.tts.rate,
      sections: this.host.sections(),
      onPageNeeded: n => this.host.pageInput(n),
      onSentence: (p, ranges) => this.highlight(p, ranges, true),
      onState: s => this.onState(s),
      onNoText: p => {
        if (this.noTextShown) return
        this.noTextShown = true
        new Notice(`Page ${p} has no text layer (scanned), so read-aloud skips it. Octavo Cloud can OCR scanned PDFs (More menu → Make searchable).`)
      },
      onEnd: reason => {
        this.clearHighlight()
        if (reason === 'notext') new Notice('No readable text here: these pages are scanned images.')
        if (reason === 'sleep') new Notice('Read-aloud: sleep timer stopped playback.')
      },
      onError: e => new Notice(`Read-aloud: ${e.message}`),
    })
    this.ctl = ctl
    await ctl.play(page, item, offset)
  }

  stop() { this.ctl?.stop() }
  dispose() { this.ctl?.dispose(); this.ctl = null; window.clearInterval(this.infoTimer); this.bar.remove() }

  /** Re-apply the highlight after a page's text layer is (re)rendered. */
  onTextLayer(n: number) { if (this.ctl?.active && this.ranges.some(r => r.page === n)) this.highlight(this.ctl.page, this.ranges, false) }

  private async engine(): Promise<SpeechEngine> {
    const t = this.plugin.settings.tts
    const cloud = this.plugin.cloud
    if (t.engine === 'cloud' && cloud.signedIn) {
      if (!cloud.ent) await cloud.refresh().catch(() => null)
      if (hasCloud(cloud.ent?.tier)) return new CloudEngine((text, sig) => cloud.tts(text, t.cloudVoice, sig))
      new Notice('Natural voices need an Octavo Cloud plan; using the system voice.')
    }
    return new SystemEngine(() => Speaker.voice(t.voice))
  }

  private onState(s: ReadState) {
    const on = s !== 'stopped'
    this.host.setSpeaking(s === 'playing' || s === 'loading')
    this.bar.toggle(on)
    this.host.root.toggleClass('octavo-tts-on', on)
    setIcon(this.playBtn, s === 'paused' ? 'play' : 'pause')
    this.playBtn.setAttribute('aria-label', s === 'paused' ? 'Resume' : 'Pause')
    this.playBtn.toggleClass('is-loading', s === 'loading')
    window.clearInterval(this.infoTimer)
    if (on) { this.showInfo(); this.infoTimer = window.setInterval(() => this.showInfo(), 15_000) }
  }

  private showInfo() {
    const c = this.ctl
    if (!c) return
    const sl = c.sleep
    const parts = [c.page ? `p. ${c.page}` : '']
    if (sl && 'until' in sl) parts.push(`sleep ${Math.max(1, Math.ceil((sl.until - Date.now()) / 60_000))}m`)
    else if (sl) parts.push('sleep: end of chapter')
    this.info.setText(parts.filter(Boolean).join(' · '))
    this.sleepBtn.toggleClass('is-active', !!sl)
  }

  private showRate() { this.rateBtn.setText(`${this.ctl?.rate ?? this.plugin.settings.tts.rate}×`) }

  private rateMenu(e: MouseEvent) {
    const m = new Menu()
    const cur = this.ctl?.rate ?? this.plugin.settings.tts.rate
    for (const r of RATES) m.addItem(i => i.setTitle(`${r}×`).setChecked(r === cur).onClick(async () => {
      this.ctl?.setRate(r)
      this.plugin.settings.tts.rate = r
      await this.plugin.saveSettings()
      this.showRate()
    }))
    m.showAtMouseEvent(e)
  }

  private sleepMenu(e: MouseEvent) {
    const m = new Menu()
    const set = (s: Parameters<PdfReadAloud['setSleep']>[0]) => { this.ctl?.setSleep(s); this.showInfo() }
    m.addItem(i => i.setTitle('No sleep timer').setChecked(!this.ctl?.sleep).onClick(() => set(null)))
    for (const min of [5, 15, 30, 60]) m.addItem(i => i.setTitle(`${min} minutes`).onClick(() => set({ minutes: min })))
    if (this.host.sections().length) m.addItem(i => i.setTitle('End of chapter').onClick(() => set({ section: true })))
    m.showAtMouseEvent(e)
  }

  private clearHighlight() {
    for (const s of this.lit) s.removeClass(CURRENT)
    this.lit = []
    this.ranges = []
  }

  private highlight(page: number, ranges: ItemRange[], follow: boolean) {
    for (const s of this.lit) s.removeClass(CURRENT)
    this.lit = []
    this.ranges = ranges
    this.showInfo()
    for (const r of ranges) {
      const span = this.host.spans(r.page)?.[r.item]
      if (span) { span.addClass(CURRENT); this.lit.push(span) }
    }
    if (!follow) return
    const first = this.lit[0]
    if (!first) { if (this.host.currentPage() !== page) this.host.goToPage(page); return }
    const box = first.getBoundingClientRect(), view = this.host.root.getBoundingClientRect()
    if (box.top < view.top + 60 || box.bottom > view.bottom - 90) first.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}
