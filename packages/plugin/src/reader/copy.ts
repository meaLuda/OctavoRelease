import { Menu, Notice, moment, type TFile } from 'obsidian'
import {
  COPY_FORMATS, COPY_FORMAT_NAMES, citekeyFrom, formatCitation, renderTemplate,
  type CopyFormat, type HighlightColor, type TemplateVars,
} from '@octavo/shared'
import type OctavoPlugin from '../main'
import { propText } from '../library/dedupe'

/** What a reader view hands over for "Copy as…" and "Copy citation": a selection or a highlight. */
export interface CopySource {
  book: TFile
  note: TFile | null
  title: string
  text: string
  /** deep-link subpath into the book (`#cfi=…` or `#page=…&selection=…`) */
  subpath: string
  page?: string | number
  label?: string
  color?: HighlightColor
  /** the reader's note on a highlight */
  comment?: string
}

export const NO_CITEKEY_HINT = 'Octavo: this book has no citekey. Add "citekey: yourKey" to the book note\'s properties, or create it with Zotero Integration / Better BibTeX (see Settings → Octavo → Copy formats).'

const shorten = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t }

export function copyVars(plugin: OctavoPlugin, src: CopySource): TemplateVars {
  const props = src.note ? plugin.library.getProps(src.note) : {}
  const author = Array.isArray(props.author) ? props.author.join(', ') : props.author
  const link = plugin.app.fileManager.generateMarkdownLink(src.book, src.note?.path ?? '', src.subpath, shorten(src.text)).replace(/^!/, '')
  return {
    text: src.text.trim(),
    page: src.page ?? '',
    label: src.label ?? '',
    link,
    color: src.color ?? plugin.settings.defaultColor,
    book: propText(props.title ?? src.title),
    author: author ? propText(author) : '',
    note: src.comment ?? '',
    date: moment().format('YYYY-MM-DD'),
    citekey: citekeyFrom(props) ?? '',
  }
}

async function write(text: string, message: string) {
  await navigator.clipboard.writeText(text)
  new Notice(message)
}

export async function copyAs(plugin: OctavoPlugin, format: CopyFormat, src: CopySource): Promise<string> {
  const out = renderTemplate(plugin.settings.copyTemplates[format], copyVars(plugin, src))
  await write(out, `Copied as ${COPY_FORMAT_NAMES[format].toLowerCase()}`)
  return out
}

/** `[@citekey, p. N]` (EPUB without page numbers: the chapter). Null, with a hint, when the book has no citekey. */
export async function copyCitation(plugin: OctavoPlugin, src: CopySource): Promise<string | null> {
  const key = src.note ? citekeyFrom(plugin.library.getProps(src.note)) : undefined
  if (!key) { new Notice(NO_CITEKEY_HINT, 10000); return null }
  const out = formatCitation(key, { page: src.page, label: src.label })
  await write(out, 'Citation copied')
  return out
}

/** The "Copy as…" submenu: every copy format, then "Copy citation". */
export function showCopyMenu(plugin: OctavoPlugin, e: MouseEvent, source: () => Promise<CopySource | null>, done?: () => void) {
  const m = new Menu()
  const run = (fn: (src: CopySource) => Promise<unknown>) => async () => {
    const src = await source()
    done?.()
    if (src) await fn(src)
  }
  for (const f of COPY_FORMATS) m.addItem(i => i.setTitle(`Copy as ${COPY_FORMAT_NAMES[f].toLowerCase()}`).setIcon(f === 'link' ? 'link' : f === 'callout' ? 'message-square-quote' : 'quote').onClick(run(src => copyAs(plugin, f, src))))
  m.addSeparator()
  m.addItem(i => i.setTitle('Copy citation').setIcon('graduation-cap').onClick(run(src => copyCitation(plugin, src))))
  m.showAtMouseEvent(e)
}
