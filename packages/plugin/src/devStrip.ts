import { Platform } from 'obsidian'
import { QR } from './devStripQr'

/**
 * "More from the developer": three paper tickets at the bottom of the settings tab, each a link with its own QR code.
 * Everything is bundled (no network, no tracking), as Obsidian's developer policies require for in-plugin ads.
 */
interface Ticket { cls: string; href: string; no: string; label?: string; bolt?: boolean; title: (el: HTMLElement) => void; sub: string; url: string; qr: keyof typeof QR }

const TICKETS: Ticket[] = [
  { cls: 'cloud', href: 'https://octavo.devformat.tools/#pricing', no: 'No. 01', label: 'Octavo Cloud', qr: 'cloud',
    title: el => { el.setText('Your library, on every device') }, sub: 'Sync, OCR for scanned PDFs, natural voices.', url: 'octavo.devformat.tools' },
  { cls: 'lpdf', href: 'https://lightningpdf.dev', no: 'No. 02', label: 'LightningPDF', bolt: true, qr: 'lightningpdf',
    title: el => { el.createSpan({ cls: 'octavo-tix-hl', text: 'HTML to PDF' }); el.appendText(' in under 100 ms') },
    sub: 'A PDF API for developers. Free for 100 PDFs a month.', url: 'lightningpdf.dev' },
  { cls: 'btw', href: 'https://munyala.pro', no: 'No. 03', qr: 'site',
    title: el => { el.setText('Btw,') }, // CSS sets it lowercase
    sub: 'I build backends, data and AI. Hire me.', url: 'munyala.pro' },
]

export function renderDevStrip(parent: HTMLElement) {
  const box = parent.createEl('section', { cls: 'octavo-tix', attr: { 'aria-label': 'More from the developer' } })
  box.toggleClass('is-phone', Platform.isMobile)
  const row = box.createDiv({ cls: 'octavo-tix-row' })
  for (const t of TICKETS) {
    const a = row.createEl('a', { cls: `octavo-tix-stub octavo-tix-${t.cls}`, href: t.href })
    if (t.cls === 'btw') stamp(a)
    const text = a.createDiv({ cls: 'octavo-tix-text' })
    const no = text.createDiv({ cls: 'octavo-tix-no' })
    no.createEl('b', { text: t.no })
    if (t.bolt) bolt(no)
    if (t.label) no.appendText(t.label)
    t.title(text.createDiv({ cls: 'octavo-tix-t' }))
    text.createDiv({ cls: 'octavo-tix-s', text: t.sub })
    text.createDiv({ cls: 'octavo-tix-u', text: t.url })
    qr(a.createDiv({ cls: 'octavo-tix-qr' }), QR[t.qr])
  }
  box.createDiv({ cls: 'octavo-tix-foot', text: 'Octavo is free and made by one person. These keep it going.' })
}

function qr(parent: HTMLElement, code: { size: number; d: string }) {
  const svg = parent.createSvg('svg', { attr: { viewBox: `0 0 ${code.size} ${code.size}`, 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' } })
  svg.createSvg('path', { attr: { d: code.d, stroke: 'currentColor', fill: 'none' } })
}

function bolt(parent: HTMLElement) {
  const svg = parent.createSvg('svg', { cls: 'octavo-tix-bolt', attr: { viewBox: '0 0 24 24', 'aria-hidden': 'true' } })
  svg.createSvg('path', { attr: { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' } })
}

/** A round "Made in Nairobi" rubber stamp on the last ticket. */
function stamp(parent: HTMLElement) {
  const svg = parent.createSvg('svg', { cls: 'octavo-tix-stamp', attr: { viewBox: '0 0 100 100', 'aria-hidden': 'true' } })
  svg.createSvg('defs').createSvg('path', { attr: { id: 'octavo-tix-ring', d: 'M50 50 m-36 0 a36 36 0 1 1 72 0 a36 36 0 1 1 -72 0' } })
  svg.createSvg('circle', { attr: { cx: 50, cy: 50, r: 47, fill: 'none', stroke: 'currentColor', 'stroke-width': 3 } })
  svg.createSvg('circle', { attr: { cx: 50, cy: 50, r: 27, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 } })
  svg.createSvg('text', { cls: 'octavo-tix-stamp-ring' })
    .createSvg('textPath', { attr: { href: '#octavo-tix-ring', textLength: 224, lengthAdjust: 'spacing' } }).textContent = 'Made in nairobi · kenya ·' // shown in capitals (CSS)
  svg.createSvg('text', { cls: 'octavo-tix-stamp-em', attr: { x: 50, y: 57, 'text-anchor': 'middle' } }).textContent = 'EM'
}
