import { Modal, Notice, Platform, moment, type App } from 'obsidian'

export interface QuoteCardInput { text: string; title: string; author?: string }

export type CardStyle = 'paper' | 'night' | 'ink'
const STYLES: Record<CardStyle, { bg: string; fg: string; sub: string; rule: string }> = {
  paper: { bg: '#f7f3ea', fg: '#2a2723', sub: '#7a6f60', rule: '#c9bba3' },
  night: { bg: '#1f1d1a', fg: '#e9e2d4', sub: '#a39a8a', rule: '#4a453d' },
  ink: { bg: '#24305e', fg: '#f4f1ea', sub: '#c3c7da', rule: '#4b5a92' },
}

const W = 1080, H = 1350, PAD = 110
const SERIF = `'Iowan Old Style', 'Charter', Georgia, 'Noto Serif', serif`

/** Lines of `text` that fit `width` at the context's current font (words longer than a line are cut). */
export function wrapLines(measure: (s: string) => number, text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (measure(next) <= width || !line) { line = next; continue }
      out.push(line)
      line = word
    }
    if (line) out.push(line)
  }
  return out
}

/** Clean up a selection for a card: one paragraph per block, at most `max` characters (cut at a word). */
export function cardText(raw: string, max = 520): string {
  const t = raw.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trim()}…`
}

/** Draws the card: the quote as large as fits, then "— title, author". */
export function drawCard(canvas: HTMLCanvasElement, q: QuoteCardInput, style: CardStyle): void {
  const c = STYLES[style]
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, W, H)
  const text = `“${cardText(q.text)}”`
  const boxW = W - PAD * 2, boxH = H - PAD * 2 - 220
  let size = 76, lines: string[] = []
  for (; size >= 30; size -= 2) {
    ctx.font = `${size}px ${SERIF}`
    lines = wrapLines(s => ctx.measureText(s).width, text, boxW)
    if (lines.length * size * 1.38 <= boxH) break
  }
  const lh = size * 1.38
  const top = PAD + Math.max(0, (boxH - lines.length * lh) / 2) + size
  ctx.fillStyle = c.fg
  ctx.textBaseline = 'alphabetic'
  lines.forEach((l, i) => ctx.fillText(l, PAD, top + i * lh))
  const y = H - PAD - 120
  ctx.fillStyle = c.rule
  ctx.fillRect(PAD, y, 90, 3)
  ctx.fillStyle = c.fg
  ctx.font = `600 38px ${SERIF}`
  ctx.fillText(fit(ctx, q.title, boxW), PAD, y + 62)
  if (q.author) {
    ctx.fillStyle = c.sub
    ctx.font = `italic 32px ${SERIF}`
    ctx.fillText(fit(ctx, q.author, boxW), PAD, y + 108)
  }
  ctx.fillStyle = c.sub
  ctx.font = `24px ${SERIF}`
  ctx.textAlign = 'right'
  ctx.fillText('Octavo', W - PAD, H - 56)
  ctx.textAlign = 'left'
}

function fit(ctx: CanvasRenderingContext2D, s: string, width: number): string {
  if (ctx.measureText(s).width <= width) return s
  let t = s
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the card'))), 'image/png'))

/** Preview with a style choice; copy the image or save it next to your attachments. */
export class QuoteCardModal extends Modal {
  private style: CardStyle = 'paper'
  private canvas!: HTMLCanvasElement
  constructor(app: App, private q: QuoteCardInput, private saveFolderFor: (name: string) => Promise<string>) { super(app) }

  onOpen(): void {
    this.titleEl.setText('Quote card')
    this.modalEl.addClass('octavo-quote-modal')
    const styles = this.contentEl.createDiv({ cls: 'octavo-seg octavo-quote-styles' })
    for (const [id, label] of [['paper', 'Paper'], ['night', 'Night'], ['ink', 'Ink']] as Array<[CardStyle, string]>) {
      const b = styles.createEl('button', { text: label, cls: id === this.style ? 'is-active' : '' })
      b.onclick = () => { this.style = id; styles.querySelectorAll('button').forEach(x => x.removeClass('is-active')); b.addClass('is-active'); this.draw() }
    }
    this.canvas = this.contentEl.createEl('canvas', { cls: 'octavo-quote-canvas' })
    this.draw()
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' })
    if (!Platform.isMobile) row.createEl('button', { text: 'Copy image' }).onclick = () => void this.copy()
    row.createEl('button', { text: 'Save to vault', cls: 'mod-cta' }).onclick = () => void this.save()
  }

  private draw(): void { drawCard(this.canvas, this.q, this.style) }

  private async copy(): Promise<void> {
    try {
      const blob = await toBlob(this.canvas)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      new Notice('Quote card copied')
    } catch { new Notice('Could not copy the image here. Save it to the vault instead.') }
  }

  private async save(): Promise<void> {
    try {
      const blob = await toBlob(this.canvas)
      const slug = this.q.title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Quote'
      const path = await this.saveFolderFor(`${slug} quote ${moment().format('YYYY-MM-DD HHmmss')}.png`)
      const f = await this.app.vault.createBinary(path, await blob.arrayBuffer())
      new Notice(`Saved ${f.path}`)
      this.close()
    } catch (e) { new Notice(`Could not save the card: ${(e as Error).message}`) }
  }

  onClose(): void { this.contentEl.empty() }
}
