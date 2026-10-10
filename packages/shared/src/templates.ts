/**
 * Copy templates and citations. Pure functions: no Obsidian, no DOM.
 *
 * A template is plain text with `{{name}}` placeholders. Unknown or missing variables render as
 * empty text. When a placeholder sits on a quoted line (`> …`, e.g. a callout), each newline in
 * its value is continued with that line's quote prefix, so a multi-line passage stays inside the
 * callout.
 */

export const TEMPLATE_VARS = ['text', 'page', 'label', 'link', 'color', 'book', 'author', 'note', 'date', 'citekey'] as const
export type TemplateVar = typeof TEMPLATE_VARS[number]
export type TemplateVars = Partial<Record<string, string | number | undefined | null>>

export type CopyFormat = 'quote' | 'link' | 'callout'
export const COPY_FORMATS: readonly CopyFormat[] = ['quote', 'link', 'callout']
export const COPY_FORMAT_NAMES: Record<CopyFormat, string> = { quote: 'Quote', link: 'Link', callout: 'Callout' }

/** Defaults reproduce the copy behaviour before templates existed: "Copy link" copies the link alone. */
export const DEFAULT_COPY_TEMPLATES: Record<CopyFormat, string> = {
  quote: '> {{text}}\n> {{link}}',
  link: '{{link}}',
  callout: '> [!octavo-{{color}}] {{label}}\n> {{text}}\n>\n> {{link}}',
}

export interface RenderOptions {
  /** Transform every substituted value (e.g. YAML quoting inside frontmatter). */
  escape?: (value: string, name: string) => string
  /** Drop lines whose placeholders were all empty and that are left with nothing but a quote prefix. */
  dropEmptyLines?: boolean
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g
const QUOTE_PREFIX = /^(\s*>[> ]*)/

export function renderTemplate(template: string, vars: TemplateVars, opts: RenderOptions = {}): string {
  const out: string[] = []
  for (const line of template.split('\n')) {
    const prefix = QUOTE_PREFIX.exec(line)?.[1] ?? ''
    let used = 0, filled = 0
    const rendered = line.replace(PLACEHOLDER, (_m, name: string) => {
      used++
      const raw = vars[name]
      let v = raw === undefined || raw === null ? '' : String(raw)
      if (opts.escape) v = opts.escape(v, name)
      if (v) filled++
      if (!prefix || !v.includes('\n')) return v
      // continue the quote on every following line; blank lines keep the bare marker (">")
      return v.split('\n').map((l, i) => (i === 0 ? l : l ? `${prefix}${l}` : prefix.trimEnd())).join('\n')
    })
    if (opts.dropEmptyLines && used && !filled && /^[\s>]*$/.test(rendered.replace(PLACEHOLDER, ''))) continue
    out.push(rendered)
  }
  return out.join('\n')
}

/** Zotero/Better BibTeX citekey from a note's frontmatter (`citekey`, `citationKey` or `zotero-key`). */
export function citekeyFrom(frontmatter: Record<string, unknown> | null | undefined): string | undefined {
  if (!frontmatter) return undefined
  for (const k of ['citekey', 'citationKey', 'citation-key', 'zotero-key']) {
    const v = frontmatter[k]
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/^@/, '')
  }
  return undefined
}

/**
 * Pandoc citation: `[@key, p. 12]`. Without a page (reflowable EPUB) the chapter label is used
 * (`[@key, Chapter 3]`); with neither, `[@key]`.
 */
export function formatCitation(citekey: string, where: { page?: string | number | null; label?: string | null } = {}): string {
  const page = where.page === undefined || where.page === null ? '' : String(where.page).trim()
  if (page) return `[@${citekey}, p. ${page}]`
  const chapter = (where.label ?? '').split(' · ').map(s => s.trim()).find(s => s && !/^p\.\s/.test(s))
  return chapter ? `[@${citekey}, ${chapter.replace(/[\]\[;]/g, ' ').trim()}]` : `[@${citekey}]`
}

/** Page number from a highlight label like "Chapter 3 · p. 42". */
export function pageFromLabel(label: string | undefined | null): string | undefined {
  return /(?:^|·)\s*p\.\s*([^\s·]+)/.exec(label ?? '')?.[1]
}
