import type { HighlightColor } from '../anchor'
import { importId, mapColor, type ImportedBook } from './types'

/**
 * Zotero annotations in literature notes made by Zotero Integration (or similar templates, e.g.
 * ZotLit). Each annotation carries a `zotero://open-pdf/…?page=N` link and is written either as
 * a callout:
 *
 *   > [!quote|#ffd400] Highlight
 *   > The highlighted text.
 *   > [Page 3](zotero://open-pdf/library/items/ABCD1234?page=3&annotation=XYZ98765)
 *   >
 *   > A comment.
 *
 * or as a marked line:
 *
 *   ==The highlighted text== ([p. 3](zotero://open-pdf/library/items/ABCD1234?page=3&annotation=XYZ98765))
 *   A comment.
 *
 * The PDF is found by its attachment file name (a `file://` or `[[…pdf]]` link) or by title. Text
 * becomes a quote-only highlight; Octavo locates it on the page the first time the PDF is opened.
 */

const OPEN_PDF = /zotero:\/\/open-pdf\/[^\s)\]>]+/
const MD_LINK = /\[[^\]]*\]\((?:zotero|file|https?):\/\/[^)]*\)/g

/** Zotero's annotation palette, by hex and by name. */
const ZOTERO: Record<string, HighlightColor> = {
  ffd400: 'yellow', ff6666: 'pink', '5fb236': 'green', '2ea8e5': 'blue', a28ae5: 'purple',
  e56eee: 'pink', f19837: 'yellow', aaaaaa: 'blue',
  yellow: 'yellow', red: 'pink', green: 'green', blue: 'blue', purple: 'purple', magenta: 'pink', orange: 'yellow', gray: 'blue', grey: 'blue',
}

function colorIn(s: string): HighlightColor | undefined {
  const hex = /#([0-9a-f]{6})\b/i.exec(s)?.[1]?.toLowerCase()
  if (hex) return ZOTERO[hex] ?? mapColor(`#${hex}`)
  const cls = /hltr-([a-z]+)/i.exec(s)?.[1]?.toLowerCase()
  if (cls && ZOTERO[cls]) return ZOTERO[cls]
  const word = /\b(yellow|red|green|blue|purple|magenta|orange|gr[ae]y)\b/i.exec(s)?.[1]?.toLowerCase()
  return word ? ZOTERO[word] : undefined
}

function pageOf(url: string): string | undefined {
  return /[?&]page=([^&\s)]+)/.exec(url)?.[1]
}

/** `==text==` or `<mark …>text</mark>`, if present. */
function marked(s: string): string | undefined {
  const m = /==([\s\S]+?)==/.exec(s) ?? /<mark\b[^>]*>([\s\S]*?)<\/mark>/i.exec(s)
  return m?.[1]?.trim()
}

const tidy = (s: string) => s
  .replace(MD_LINK, '')
  .replace(/<\/?mark\b[^>]*>/gi, '')
  .replace(/==/g, '')
  .replace(/\(\s*\)/g, '')
  .replace(/^\s*["“]|["”]\s*$/g, '')
  .replace(/[ \t]+$/gm, '')
  .trim()

const stripComment = (s: string) => s.replace(/^(?:\*\*)?(?:comment|note)s?:?(?:\*\*)?:?\s*/i, '').trim()

function frontmatter(md: string): Record<string, string> {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1]
  const out: Record<string, string> = {}
  if (!fm) return out
  for (const line of fm.split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m && m[2]) out[m[1]!] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function attachment(md: string, fm: Record<string, string>): string | undefined {
  const fromFm = ['pdf', 'attachment', 'file'].map(k => fm[k]).find(v => v && /\.pdf/i.test(v))
  const file = /\]\((file:\/\/[^)]+?\.pdf)\)/i.exec(md)?.[1] ?? /\[\[([^\]|#]+?\.pdf)(?:[#|][^\]]*)?\]\]/i.exec(md)?.[1] ?? fromFm
  if (!file) return undefined
  const clean = file.replace(/^\[\[|\]\]$/g, '').replace(/^file:\/\//, '')
  let name = clean.split(/[\\/]/).pop() ?? clean
  try { name = decodeURIComponent(name) } catch { /* keep as is */ }
  return name
}

export function isZoteroNote(markdown: string): boolean {
  return OPEN_PDF.test(markdown)
}

export function importZotero(markdown: string, now = new Date().toISOString()): ImportedBook | null {
  if (!isZoteroNote(markdown)) return null
  const fm = frontmatter(markdown)
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const highlights: ImportedBook['highlights'] = []
  const add = (text: string, url: string, color: HighlightColor | undefined, note: string | undefined) => {
    const exact = tidy(text)
    if (!exact) return
    const page = pageOf(url)
    highlights.push({
      id: importId('z'),
      color: color ?? 'yellow',
      style: 'highlight',
      label: page ? `p. ${page}` : undefined,
      note: note ? tidy(note) || undefined : undefined,
      created: now,
      anchor: { quote: { exact, prefix: '', suffix: '' } },
    })
  }

  // skip the frontmatter
  let i = 0
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++ }

  let pending: HighlightColor | undefined
  for (; i < lines.length; i++) {
    const line = lines[i]!
    const head = /^>\s*\[!([\w-]+)(\|[^\]]*)?\]\s*(.*)$/.exec(line)
    if (head) {
      let j = i + 1
      while (j < lines.length && lines[j]!.startsWith('>')) j++
      const body = lines.slice(i + 1, j).map(l => l.replace(/^>\s?/, ''))
      const all = [head[3] ?? '', ...body].join('\n')
      const url = OPEN_PDF.exec(all)?.[0]
      i = j - 1
      if (!url) continue
      const color = colorIn(head[2] ?? '') ?? colorIn(all)
      const mk = marked(all)
      let text: string, note: string
      if (mk) {
        text = mk
        const rest = all.slice(all.indexOf(mk) + mk.length).split('\n').slice(1)
        note = rest.map(l => stripComment(l)).filter(l => l && !OPEN_PDF.test(l)).join('\n')
      } else {
        // first paragraph = the passage; following paragraphs = the comment; link-only lines dropped
        const content = body.filter(l => !(OPEN_PDF.test(l) && !tidy(l)))
        const blank = content.findIndex((l, k) => k > 0 && !l.trim())
        const para = (blank < 0 ? content : content.slice(0, blank)).map(l => l.trim()).join(' ')
        text = para
        note = blank < 0 ? '' : content.slice(blank + 1).map(stripComment).filter(Boolean).join('\n')
      }
      add(text, url, color, note)
      pending = undefined
      continue
    }
    const url = OPEN_PDF.exec(line)?.[0]
    // a colour label on its own line (e.g. `<mark style="background-color: #2ea8e5">Highlight</mark>`) applies to the next annotation
    if (!url) { if (line.trim()) pending = colorIn(line); continue }
    const mk = marked(line)
    if (mk) {
      const note: string[] = []
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() && !/^(>|#|==|<mark|[-*] ==)/.test(lines[j]!.trim()) && !OPEN_PDF.test(lines[j]!)) {
        note.push(stripComment(lines[j]!.replace(/^[-*]\s+/, '')))
        j++
      }
      add(mk, url, colorIn(line) ?? pending, note.filter(Boolean).join('\n'))
      i = j - 1
    }
    pending = undefined
  }

  const title = fm.title || /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
  const author = fm.author || fm.authors || undefined
  const citekey = fm.citekey || fm.citationKey || fm['zotero-key'] || undefined
  if (!highlights.length) return null
  return { title: title ? tidy(title) : undefined, author, bookPath: attachment(markdown, fm), citekey, highlights }
}
