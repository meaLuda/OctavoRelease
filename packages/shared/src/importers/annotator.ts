import { importId, mapColor, toIso, type ImportedBook } from './types'

/**
 * obsidian-annotator notes: frontmatter `annotation-target: <path>` and one
 * callout per annotation containing a ```annotation-json block (hypothes.is
 * format) followed by `^<id>`. We keep the TextQuoteSelector; CFIs are
 * recomputed by re-anchoring the quote when the book is opened.
 */
export function importAnnotator(markdown: string): ImportedBook | null {
  const target = /^annotation-target:\s*(.+)$/m.exec(markdown)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const blocks: ImportedBook['highlights'] = []
  const content = markdown.split('\n').map(l => (l.startsWith('>') ? l.replace(/^> ?/, '') : l)).join('\n')
  const re = /```annotation-json\n([\s\S]*?)\n```/g
  for (let m; (m = re.exec(content)); ) {
    let a: any
    try { a = JSON.parse(m[1]!) } catch { continue }
    const sel = (a.target?.[0]?.selector ?? []).find((s: any) => s.type === 'TextQuoteSelector')
    if (!sel?.exact) continue
    // comment follows %%COMMENT%% in the callout, tags after %%TAGS%%
    const after = content.slice(re.lastIndex, re.lastIndex + 4000)
    const comment = /%%COMMENT%%\n([\s\S]*?)\n(?:%%TAGS%%|\^[a-zA-Z0-9]+|$)/.exec(after)?.[1]?.trim()
    const tags: string[] = Array.isArray(a.tags) ? a.tags.filter((t: unknown) => typeof t === 'string') : []
    blocks.push({
      id: importId('a'),
      color: mapColor(tags.find(t => /yellow|green|blue|pink|red|purple/i.test(t)) ?? 'yellow'),
      style: 'highlight',
      note: comment || (typeof a.text === 'string' && a.text ? a.text : undefined),
      tags: tags.length ? tags : undefined,
      created: toIso(a.created),
      anchor: { quote: { exact: sel.exact, prefix: sel.prefix ?? '', suffix: sel.suffix ?? '' } },
    })
  }
  if (!target && !blocks.length) return null
  return { bookPath: target, highlights: blocks }
}
