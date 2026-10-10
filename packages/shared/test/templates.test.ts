import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  renderTemplate, DEFAULT_COPY_TEMPLATES, citekeyFrom, formatCitation, pageFromLabel,
  buildLiteratureNote, refreshLiteratureNote, renderHighlightsBlock, literatureNotePath, resolveLiteratureNotePath, EXPORT_BOOK_ID, sectionOf, sortForExport, yamlScalar,
  EXPORT_START, EXPORT_END, importZotero, isZoteroNote, parseHighlights, type Highlight, type LiteratureInput,
} from '../src'

describe('renderTemplate', () => {
  it('substitutes variables, missing ones become empty', () => {
    expect(renderTemplate('{{text}} ({{page}}) {{nope}}|{{ book }}', { text: 'Hi', book: 'B' })).toBe('Hi () |B')
    expect(renderTemplate('{{page}}', { page: 12 })).toBe('12')
    expect(renderTemplate('{{page}}', { page: null })).toBe('')
  })
  it('continues multi-line values inside callouts with "> "', () => {
    const out = renderTemplate('> [!quote] {{book}}\n> {{text}}\n> {{link}}', { book: 'B', text: 'one\ntwo\n\nthree', link: 'L' })
    expect(out).toBe('> [!quote] B\n> one\n> two\n>\n> three\n> L')
  })
  it('keeps nested quote prefixes', () => {
    expect(renderTemplate('>> {{text}}', { text: 'a\nb' })).toBe('>> a\n>> b')
  })
  it('leaves newlines alone outside quotes', () => {
    expect(renderTemplate('{{text}}', { text: 'a\nb' })).toBe('a\nb')
  })
  it('drops lines left empty when asked', () => {
    expect(renderTemplate('> {{text}}\n> {{note}}\n> {{link}}', { text: 't', link: 'l' }, { dropEmptyLines: true })).toBe('> t\n> l')
    expect(renderTemplate('> {{text}}\n> {{note}}', { text: 't' })).toBe('> t\n> ')
  })
  it('defaults reproduce today\'s output', () => {
    const v = { text: 'The passage', link: '[[b.pdf#page=3&selection=1,0,1,5|The passage]]', color: 'yellow', label: 'p. 3' }
    expect(renderTemplate(DEFAULT_COPY_TEMPLATES.link, v)).toBe(v.link)
    expect(renderTemplate(DEFAULT_COPY_TEMPLATES.quote, v)).toBe(`> The passage\n> ${v.link}`)
    expect(renderTemplate(DEFAULT_COPY_TEMPLATES.callout, v)).toBe(`> [!octavo-yellow] p. 3\n> The passage\n>\n> ${v.link}`)
  })
})

describe('citations', () => {
  it('reads citekey from frontmatter variants', () => {
    expect(citekeyFrom({ citekey: 'smith2020' })).toBe('smith2020')
    expect(citekeyFrom({ citationKey: '@doe2019' })).toBe('doe2019')
    expect(citekeyFrom({ 'zotero-key': 'X' })).toBe('X')
    expect(citekeyFrom({ title: 'x' })).toBeUndefined()
    expect(citekeyFrom(null)).toBeUndefined()
  })
  it('formats pandoc citations', () => {
    expect(formatCitation('k', { page: 12 })).toBe('[@k, p. 12]')
    expect(formatCitation('k', { label: 'Chapter 3' })).toBe('[@k, Chapter 3]')
    expect(formatCitation('k', { label: 'Chapter 3 · p. 9' })).toBe('[@k, Chapter 3]')
    expect(formatCitation('k')).toBe('[@k]')
  })
  it('reads the page from labels', () => {
    expect(pageFromLabel('Intro · p. 42')).toBe('42')
    expect(pageFromLabel('p. xii')).toBe('xii')
    expect(pageFromLabel('Chapter 3')).toBeUndefined()
  })
})

const hl = (id: string, over: Partial<Highlight>): Highlight => ({
  id, color: 'yellow', style: 'highlight', created: '2026-10-01T10:00:00.000Z',
  anchor: { quote: { exact: `text ${id}`, prefix: '', suffix: '' } }, ...over,
})

const pdfInput = (): LiteratureInput => ({
  book: 'Deep Work: Rules', author: 'Cal Newport', citekey: 'newport2016', source: '[[Deep Work.pdf]]', date: '2026-10-10',
  highlights: [
    { highlight: hl('b', { label: 'Two · p. 40', color: 'green', note: 'Remember this\nfor the essay', tags: ['focus', 'exam'], anchor: { pdf: { page: 40, beginIndex: 2, beginOffset: 0, endIndex: 2, endOffset: 4 }, quote: { exact: 'second', prefix: '', suffix: '' } } }), link: '[[Deep Work.pdf#page=40&selection=2,0,2,4&color=green|↗]]' },
    { highlight: hl('a', { label: 'One · p. 3', anchor: { pdf: { page: 3, beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 5 }, quote: { exact: 'first', prefix: '', suffix: '' } } }), link: '[[Deep Work.pdf#page=3&selection=0,0,0,5&color=yellow|↗]]' },
    { highlight: hl('c', { label: 'p. 41', anchor: { pdf: { page: 41, beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 5 }, quote: { exact: 'third', prefix: '', suffix: '' } } }), link: 'L3' },
  ],
})

describe('literature note export', () => {
  it('sorts by position and groups by chapter, then page', () => {
    const block = renderHighlightsBlock(pdfInput())
    expect(block.startsWith(EXPORT_START)).toBe(true)
    expect(block.endsWith(EXPORT_END)).toBe(true)
    const heads = block.split('\n').filter(l => l.startsWith('## '))
    expect(heads).toEqual(['## One', '## Two', '## Page 41'])
    expect(block).toContain('> [!octavo-green] Two · p. 40\n> second\n>\n> Remember this\n> for the essay\n> #focus #exam\n> [[Deep Work.pdf#page=40&selection=2,0,2,4&color=green|↗]]')
    // empty note/tags lines are dropped
    expect(block).toContain('> [!octavo-yellow] One · p. 3\n> first\n>\n> [[Deep Work.pdf#page=3')
  })
  it('orders EPUB highlights by CFI', () => {
    const items = [
      { highlight: hl('x', { anchor: { cfi: 'epubcfi(/6/10!/4/2,/1:0,/1:5)', quote: { exact: 'late', prefix: '', suffix: '' } } }), link: '' },
      { highlight: hl('y', { anchor: { cfi: 'epubcfi(/6/4[ch1]!/4/12,/1:3,/1:9)', quote: { exact: 'early', prefix: '', suffix: '' } } }), link: '' },
      { highlight: hl('z', {}), link: '' },
    ]
    expect(sortForExport(items).map(i => i.highlight.id)).toEqual(['y', 'x', 'z'])
    expect(sectionOf(hl('q', { label: 'Chapter 2 · p. 5' }))).toBe('Chapter 2')
    expect(sectionOf(hl('q', {}))).toBe('Highlights')
  })
  it('builds a note with YAML-safe frontmatter', () => {
    const md = buildLiteratureNote(pdfInput())
    expect(md).toMatch(/^---\ntitle: "Deep Work: Rules"\nauthor: Cal Newport\ncitekey: newport2016\nsource: "\[\[Deep Work.pdf\]\]"\noctavo-export: true\n/)
    expect(md).toContain('# Deep Work: Rules\n\n%% octavo:start %%')
    expect(md.trimEnd().endsWith(EXPORT_END)).toBe(true)
    // never parsed back as book-note highlights
    expect(parseHighlights(md)).toEqual([])
  })
  it('appends the block when the template has no {{highlights}}', () => {
    const md = buildLiteratureNote({ ...pdfInput(), noteTemplate: '# {{book}} by {{author}}' })
    expect(md.startsWith('# Deep Work: Rules by Cal Newport\n\n%% octavo:start %%')).toBe(true)
  })
  it('refresh regenerates only between the markers and is idempotent', () => {
    const input = pdfInput()
    const first = buildLiteratureNote(input)
    const edited = first.replace('# Deep Work: Rules\n', '# Deep Work: Rules\n\nMy summary above.\n') + '\n## My thoughts\nKeep me.\n'
    const more = { ...input, highlights: [...input.highlights, { highlight: hl('d', { label: 'p. 99', anchor: { pdf: { page: 99, beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 1 }, quote: { exact: 'fourth', prefix: '', suffix: '' } } }), link: 'L4' }] }
    const once = refreshLiteratureNote(edited, more)
    expect(once).toContain('My summary above.')
    expect(once).toContain('## My thoughts\nKeep me.')
    expect(once).toContain('## Page 99')
    expect(refreshLiteratureNote(once, more)).toBe(once)
    expect(once.split(EXPORT_START).length).toBe(2)
  })
  it('refresh without markers appends instead of overwriting', () => {
    const out = refreshLiteratureNote('# Mine\n\nnotes', pdfInput())
    expect(out.startsWith('# Mine\n\nnotes\n\n%% octavo:start %%')).toBe(true)
  })
  it('handles an empty book and safe paths', () => {
    expect(renderHighlightsBlock({ ...pdfInput(), highlights: [] })).toContain('*No highlights yet.*')
    expect(literatureNotePath('Books/', 'A/B: C?')).toBe('Books/A B C highlights.md')
    expect(literatureNotePath('', 'X')).toBe('X highlights.md')
    expect(yamlScalar('plain title')).toBe('plain title')
    expect(yamlScalar('true')).toBe('"true"')
    expect(yamlScalar('')).toBe('')
  })
})

const fx = (n: string) => readFileSync(new URL(`./fixtures/zotero/${n}`, import.meta.url), 'utf8')

describe('zotero importer', () => {
  it('reads Zotero Integration callouts', () => {
    const md = fx('zotero-integration-callouts.md')
    expect(isZoteroNote(md)).toBe(true)
    const b = importZotero(md, '2026-10-10T00:00:00.000Z')!
    expect(b.title).toBe('Attention Is All You Need')
    expect(b.citekey).toBe('vaswaniAttentionAllYou2017')
    expect(b.bookPath).toBe('Vaswani et al. - 2017 - Attention Is All You Need.pdf')
    expect(b.highlights).toHaveLength(3)
    expect(b.highlights[0]).toMatchObject({ color: 'yellow', label: 'p. 1', note: undefined, created: '2026-10-10T00:00:00.000Z',
      anchor: { quote: { exact: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.' } } })
    expect(b.highlights[1]).toMatchObject({ color: 'green', label: 'p. 1', note: 'Key claim of the paper. Compare with ConvS2S.' })
    expect(b.highlights[1]!.anchor.quote.exact).toBe('We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.')
    expect(b.highlights[2]).toMatchObject({ color: 'pink', label: 'p. 3', note: 'definition for the exam' })
    expect(b.highlights.every(h => !h.anchor.pdf && !h.anchor.cfi)).toBe(true)
  })
  it('reads ==marked== lines and <mark> highlights', () => {
    const b = importZotero(fx('zotero-marked-lines.md'))!
    expect(b.title).toBe('Thinking, Fast and Slow')
    expect(b.author).toBe('Daniel Kahneman')
    expect(b.citekey).toBe('kahneman2011thinking')
    expect(b.bookPath).toBe('Kahneman - 2011 - Thinking, Fast and Slow.pdf')
    expect(b.highlights.map(h => [h.color, h.label, h.note])).toEqual([
      ['blue', 'p. 62', 'Illusion of truth.'],
      ['yellow', 'p. 20', undefined],
      ['purple', 'p. 402', undefined],
    ])
    expect(b.highlights[0]!.anchor.quote.exact).toBe('A reliable way to make people believe in falsehoods is frequent repetition, because familiarity is not easily distinguished from truth.')
    expect(b.highlights[2]!.anchor.quote.exact).toBe('Nothing in life is as important as you think it is, while you are thinking about it.')
  })
  it('ignores notes without Zotero PDF links', () => {
    expect(importZotero('# Plain\n\n> [!quote] Hi\n> text')).toBeNull()
    expect(isZoteroNote('zotero://select/library/items/X')).toBe(false)
  })

  it('refresh with a deleted end marker never eats user text, even refreshed twice', () => {
    const input = pdfInput()
    const built = buildLiteratureNote(input).replace('# Deep Work: Rules\n', '# Deep Work: Rules\n\nMy summary.\n') + '\n## Thoughts\nKeep me.\n'
    const broken = built.replace(EXPORT_END, '')
    const once = refreshLiteratureNote(broken, input)
    const twice = refreshLiteratureNote(once, input)
    for (const out of [once, twice]) {
      expect(out).toContain('My summary.')
      expect(out).toContain('## Thoughts\nKeep me.')
      expect(out.split(EXPORT_START).length).toBe(2)
      expect(out.split(EXPORT_END).length).toBe(2)
    }
    expect(twice).toBe(once)
    // a stray end marker before the block is dropped, the text around it kept
    const strayEnd = refreshLiteratureNote(`Intro\n${EXPORT_END}\nMore\n\n${renderHighlightsBlock(input)}\nOutro\n`, input)
    expect(strayEnd).toContain('Intro\nMore')
    expect(strayEnd).toContain('Outro')
    expect(strayEnd.split(EXPORT_END).length).toBe(2)
    // a deleted start marker: old content stays as the reader's text, a new block is appended
    const noStart = refreshLiteratureNote(built.replace(EXPORT_START, ''), input)
    expect(noStart).toContain('## Thoughts\nKeep me.')
    expect(noStart.split(EXPORT_START).length).toBe(2)
    expect(refreshLiteratureNote(noStart, input)).toBe(noStart)
  })
  it('inserts highlight text with $ patterns literally', () => {
    const input = { ...pdfInput(), highlights: [{ highlight: hl('m', { anchor: { quote: { exact: "math $$x^2$$ and $' and $& and $1", prefix: '', suffix: '' } } }), link: '' }] }
    const md = buildLiteratureNote(input)
    expect(md).toContain("> math $$x^2$$ and $' and $& and $1")
    expect(refreshLiteratureNote(md, input)).toBe(md)
  })
  it('stores the book id and disambiguates same-title books', () => {
    const md = buildLiteratureNote({ ...pdfInput(), bookId: 'abc123' })
    expect(md).toMatch(/\noctavo-export: true\n/)
    expect(md).toContain(`\n${EXPORT_BOOK_ID}: "abc123"\n---\n`)
    expect(buildLiteratureNote({ ...pdfInput(), noteTemplate: '# {{book}}', bookId: 'x' }).startsWith(`---\n${EXPORT_BOOK_ID}: "x"\n---\n# Deep Work`)).toBe(true)
    const notes = new Map<string, string | null>([['Books/Dune highlights.md', 'book-a']])
    const owner = (p: string) => notes.get(p)
    expect(resolveLiteratureNotePath('Books', 'Dune', 'book-a', owner)).toBe('Books/Dune highlights.md')
    expect(resolveLiteratureNotePath('Books', 'Dune', 'book-b', owner, 'herbert1965')).toBe('Books/Dune (herbert1965) highlights.md')
    expect(resolveLiteratureNotePath('Books', 'Dune', '0123456789abcdef', owner)).toBe('Books/Dune (0123456789ab) highlights.md')
    notes.set('Books/Dune (herbert1965) highlights.md', 'book-b')
    expect(resolveLiteratureNotePath('Books', 'Dune', 'book-b', owner, 'herbert1965')).toBe('Books/Dune (herbert1965) highlights.md')
    expect(resolveLiteratureNotePath('Books', 'Dune', 'book-c', owner, 'herbert1965')).toBe('Books/Dune (book-c) highlights.md')
    // refreshing an older export adds the id once, and stays idempotent
    const legacy = buildLiteratureNote(pdfInput())
    const stamped = refreshLiteratureNote(legacy, { ...pdfInput(), bookId: 'abc123' })
    expect(stamped.split(EXPORT_BOOK_ID).length).toBe(2)
    expect(stamped).toMatch(/\noctavo-export: true\ntags:\n  - literature-note\noctavo-book-id: "abc123"\n---\n/)
    expect(refreshLiteratureNote(stamped, { ...pdfInput(), bookId: 'abc123' })).toBe(stamped)
    // an older export without an id is still this book's
    expect(resolveLiteratureNotePath('Books', 'Old', 'book-a', () => null)).toBe('Books/Old highlights.md')
    expect(resolveLiteratureNotePath('Books', 'New', 'book-a', () => undefined)).toBe('Books/New highlights.md')
  })
})
