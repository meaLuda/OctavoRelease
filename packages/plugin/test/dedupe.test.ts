import { describe, expect, it } from 'vitest'
import { parseHighlights, upsertHighlight, HIGHLIGHTS_HEADING, type Highlight } from '@octavo/shared'
import { groupDuplicates, mergeHighlightBlocks, mergeProps } from '../src/library/dedupe'

const hl = (id: string, exact: string): Highlight => ({
  id, color: 'yellow', style: 'highlight', created: '2026-10-01',
  anchor: { cfi: `epubcfi(/6/4!/4/2/${id})`, quote: { exact, prefix: '', suffix: '' } },
})
const note = (...hs: Highlight[]) => hs.reduce((md, h) => upsertHighlight(md, h, '[[b.epub|↗]]'), `---\noctavo-id: x\n---\n\n# Book\n\n${HIGHLIGHTS_HEADING}\n`)

describe('groupDuplicates', () => {
  it('groups by octavo-id or book link and keeps the oldest', () => {
    const g = groupDuplicates([
      { path: 'Books/X 2.md', id: 'a', ctime: 20 },
      { path: 'Books/X.md', id: 'a', book: 'L/x.epub', ctime: 10 },
      { path: 'Books/X 3.md', id: 'lib-9', book: 'L/x.epub', ctime: 30 },
      { path: 'Books/Y.md', id: 'b', book: 'L/y.epub', ctime: 5 },
    ])
    expect(g).toHaveLength(1)
    expect(g[0]!.keep.path).toBe('Books/X.md')
    expect(g[0]!.dups.map(d => d.path)).toEqual(['Books/X 2.md', 'Books/X 3.md'])
  })
  it('breaks ctime ties by the shorter path', () => {
    const g = groupDuplicates([{ path: 'B/X 2.md', id: 'a', ctime: 1 }, { path: 'B/X.md', id: 'a', ctime: 1 }])
    expect(g[0]!.keep.path).toBe('B/X.md')
  })
})

describe('mergeHighlightBlocks', () => {
  it('adds the duplicates\' highlights once, deduped by id', () => {
    const keep = note(hl('h1', 'one'), hl('h2', 'two'))
    const dup = note(hl('h2', 'two'), hl('h3', 'three'))
    const dup2 = note(hl('h3', 'three'), hl('h4', 'four'))
    const r = mergeHighlightBlocks(keep, [dup, dup2])
    expect(r.added).toBe(2)
    expect(parseHighlights(r.md).map(h => h.id)).toEqual(['h1', 'h2', 'h3', 'h4'])
    expect(parseHighlights(r.md).find(h => h.id === 'h4')!.anchor.quote.exact).toBe('four')
  })
  it('keeps text after the Highlights section in place', () => {
    const keep = note(hl('h1', 'one')) + '\n## My thoughts\n\nGood book.\n'
    const r = mergeHighlightBlocks(keep, [note(hl('h9', 'nine'))])
    expect(r.md.indexOf('nine')).toBeLessThan(r.md.indexOf('## My thoughts'))
    expect(r.md).toContain('Good book.')
    expect(parseHighlights(r.md)).toHaveLength(2)
  })
  it('is a no-op when nothing is new', () => {
    const keep = note(hl('h1', 'one'))
    expect(mergeHighlightBlocks(keep, [note(hl('h1', 'one'))])).toEqual({ md: keep, added: 0 })
  })
})

describe('mergeProps', () => {
  it('takes the furthest progress with its position, latest last-read, earliest started', () => {
    const out = mergeProps(
      { progress: 0.2, position: 'a', 'last-read': '2026-10-01T10:00', started: '2026-09-01', status: 'reading' },
      [{ progress: 0.6, position: 'b', 'last-read': '2026-10-03T09:00', started: '2026-09-05', status: 'reading', collections: ['Shelf'] }],
    )
    expect(out).toEqual({ progress: 0.6, position: 'b', 'last-read': '2026-10-03T09:00', collections: ['Shelf'] })
  })
  it('keeps the kept note\'s values when they are already furthest', () => {
    expect(mergeProps({ progress: 0.9, 'last-read': '2026-10-05', status: 'finished' }, [{ progress: 0.1, 'last-read': '2026-10-01', status: 'reading' }])).toEqual({})
  })
})
