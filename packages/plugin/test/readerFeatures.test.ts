import { describe, expect, it } from 'vitest'
import { heatmap, heatLevel, hoursMinutes, totals } from '../src/library/stats'
import { dailySection, pickHighlights, recordShown, RESHOW_AFTER_DAYS } from '../src/library/resurface'
import { DICT_MAX, dictKey, fromVocabulary, remember } from '../src/reader/dictionary'
import { cardText, wrapLines } from '../src/reader/quoteCard'
import { isDoubleTap, isPageTurnKey, wholeWordAt, wordBounds } from '../src/reader/dom'
import { LINE_CHARS, lineWidthPx } from '../src/reader/appearance'
import { BYO_PROMPTS, hostedRequest, recapParts, savedSummaries } from '../src/ai/hosted'

const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length] }

describe('reading stats', () => {
  it('heatmap ends with the week of today, Monday first, future days marked', () => {
    const today = new Date(2026, 10, 18) // Wednesday 18 Nov 2026
    const cells = heatmap({ '2026-11-18': 45, '2026-11-16': 5 }, today, 2)
    expect(cells).toHaveLength(14)
    expect(cells[7].day).toBe('2026-11-16') // Monday of this week
    expect(cells[7].level).toBe(1)
    expect(cells[9]).toMatchObject({ day: '2026-11-18', minutes: 45, level: 3, future: false })
    expect(cells[10].future).toBe(true)
  })
  it('levels and totals', () => {
    expect([0, 10, 20, 50, 200].map(heatLevel)).toEqual([0, 1, 2, 3, 4])
    const t = totals({ '2026-11-17': 30, '2026-11-02': 20, '2026-01-05': 10, '2025-12-31': 5, '2026-12-01': 99 }, new Date(2026, 10, 18))
    expect(t).toEqual({ week: 30, month: 50, year: 60, all: 65, days: 4 })
    expect(hoursMinutes(95)).toBe('1 h 35 min')
    expect(hoursMinutes(40)).toBe('40 min')
    expect(hoursMinutes(120)).toBe('2 h')
  })
})

describe('daily highlights', () => {
  const all = [
    { id: 'a1', book: 'A' }, { id: 'a2', book: 'A' }, { id: 'b1', book: 'B' }, { id: 'c1', book: 'C' },
  ]
  it('one per book first, never more than asked', () => {
    const p = pickHighlights(all, {}, 3, '2026-11-17', seq(0.1, 0.5, 0.9))
    expect(p).toHaveLength(3)
    expect(new Set(p.map(x => x.book)).size).toBe(3)
  })
  it('skips highlights shown lately while others are left', () => {
    const shown = { a1: '2026-11-10', a2: '2026-11-10', b1: '2026-11-10' }
    expect(pickHighlights(all, shown, 2, '2026-11-17', seq(0.5)).map(x => x.id)).toEqual(['c1'])
  })
  it('starts over once everything was shown lately', () => {
    const shown = Object.fromEntries(all.map(a => [a.id, '2026-11-16']))
    expect(pickHighlights(all, shown, 2, '2026-11-17', seq(0.3))).toHaveLength(2)
  })
  it('records what was shown and forgets after a year', () => {
    expect(recordShown({ old: '2025-01-01', recent: '2026-11-01' }, ['x'], '2026-11-17')).toEqual({ recent: '2026-11-01', x: '2026-11-17' })
    expect(RESHOW_AFTER_DAYS).toBe(30)
    expect(dailySection('From my books', ['![[A#^oct-1]]', '![[B#^oct-2]]'])).toBe('## From my books\n\n![[A#^oct-1]]\n\n![[B#^oct-2]]')
  })
})

describe('offline dictionary', () => {
  it('keys ignore case and punctuation', () => {
    expect(dictKey(' “Ephemeral,” ')).toBe('ephemeral')
  })
  it('remembers and trims the oldest', () => {
    let e = remember({}, 'Word', 'a definition', 1)
    expect(e.word.d).toBe('a definition')
    expect(remember(e, 'x', '   ')).toBe(e)
    for (let i = 0; i < DICT_MAX + 5; i++) e = remember(e, `w${i}`, 'd', 10 + i)
    expect(Object.keys(e)).toHaveLength(DICT_MAX)
    expect(e.word).toBeUndefined()
  })
  it('reads the Vocabulary note', () => {
    const md = '# Vocabulary\n\nephemeral:: lasting a very short time\nsonder:: '
    expect(fromVocabulary(md, 'Ephemeral')).toBe('lasting a very short time')
    expect(fromVocabulary(md, 'sonder')).toBeNull()
    expect(fromVocabulary(md, 'missing')).toBeNull()
  })
})

describe('quote cards', () => {
  it('wraps to the width, a long word gets its own line', () => {
    const m = (s: string) => s.length
    expect(wrapLines(m, 'one two three four', 9)).toEqual(['one two', 'three', 'four'])
    expect(wrapLines(m, 'extraordinarily x', 5)).toEqual(['extraordinarily', 'x'])
    expect(wrapLines(m, 'a\nb', 10)).toEqual(['a', 'b'])
  })
  it('tidies and shortens the text at a word', () => {
    expect(cardText('  a   b \n  c ')).toBe('a b\nc')
    const t = cardText('word '.repeat(200), 50)
    expect(t.length).toBeLessThanOrEqual(51)
    expect(t.endsWith('word…')).toBe(true)
  })
})

describe('words, taps and keys', () => {
  it('finds the word around an offset, any script', () => {
    const s = "Don't stop—naïve café 東京"
    expect(wordBounds(s, 2)).toEqual([0, 5])
    expect(s.slice(...wordBounds(s, 13)!)).toBe('naïve')
    expect(s.slice(...wordBounds(s, 23)!)).toBe('東京')
    expect(wordBounds(s, 5)).toEqual([0, 5]) // just after a word
    expect(wordBounds('a  b', 2)).toBeNull()
  })
  it('double taps are close in time and place', () => {
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false)
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 200, x: 20, y: 15 })).toBe(true)
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 500, x: 10, y: 10 })).toBe(false)
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 100, x: 90, y: 10 })).toBe(false)
  })
  it('page-turner keys', () => {
    expect(isPageTurnKey('PageDown', 'forward', false)).toBe(true)
    expect(isPageTurnKey('ArrowDown', 'forward', false)).toBe(false) // scrolled: arrows scroll
    expect(isPageTurnKey('ArrowDown', 'forward', true)).toBe(true)
    expect(isPageTurnKey('ArrowUp', 'back', true)).toBe(true)
    expect(isPageTurnKey('MediaTrackNext', 'forward', true)).toBe(false)
    expect(isPageTurnKey('MediaTrackNext', 'forward', true, true)).toBe(true)
    expect(isPageTurnKey('MediaTrackPrevious', 'back', false, true)).toBe(true)
  })
  it('whole-word matches', () => {
    expect(wholeWordAt('the cat sat', 4, 3)).toBe(true)
    expect(wholeWordAt('concatenate', 3, 3)).toBe(false)
    expect(wholeWordAt('cat.', 0, 3)).toBe(true)
  })
})

describe('line width', () => {
  it('is about the chosen characters a line at the text size', () => {
    expect(lineWidthPx('medium', 100)).toBe(LINE_CHARS.medium * 8)
    expect(lineWidthPx('narrow', 150)).toBeGreaterThan(lineWidthPx('narrow', 100))
    expect(lineWidthPx('wide', 100)).toBeGreaterThan(lineWidthPx('medium', 100))
    expect(lineWidthPx('full', 100)).toBeGreaterThanOrEqual(4000)
  })
})

describe('translate and story so far', () => {
  const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>
  it('shapes the requests', () => {
    expect(hostedRequest('translate', { text: 'Bonjour', to: 'English' }, true))
      .toMatchObject({ path: '/v1/ai/translate', method: 'POST' })
    expect(body(hostedRequest('translate', { text: 'x'.repeat(9000), to: 'Kiswahili' }, false)))
      .toEqual({ text: 'x'.repeat(6000), to: 'Kiswahili', allowFallback: false })
    const r = body(hostedRequest('recap', { recent: 'r', summaries: ['s'], highlights: ['h'], bookTitle: 'B', position: 0.4 }, true))
    expect(r).toEqual({ recent: 'r', summaries: ['s'], highlights: ['h'], bookTitle: 'B', position: 0.4, allowFallback: true })
  })
  it('recap keeps the end of the recent text, where the reader stopped', () => {
    const p = recapParts({ recent: `${'a'.repeat(20_000)}END`, highlights: Array.from({ length: 60 }, (_, i) => `h${i}`) })
    expect(p.recent.endsWith('END')).toBe(true)
    expect(p.recent.length).toBe(12_000)
    expect(p.highlights).toHaveLength(40)
    expect(p.highlights[39]).toBe('h59')
  })
  it('prompts for your own AI', () => {
    expect(BYO_PROMPTS.translate({ text: 'Hola', to: 'English' })).toContain('English')
    expect(BYO_PROMPTS.recap({ recent: 'the duke fell', bookTitle: 'Dune' })).toContain('the duke fell')
  })
  it('reads saved chapter summaries from a book note', () => {
    const md = '---\na: 1\n---\n## Highlights\n\nx\n\n## Chapter summaries\n\n### One\nHe arrives.\n\n### Two\nShe leaves.\n\n## Ask\n\nq'
    expect(savedSummaries(md)).toEqual(['One He arrives.', 'Two She leaves.'])
    expect(savedSummaries('no summaries')).toEqual([])
  })
})

describe('reading ruler lines', () => {
  it('merges words into lines, side-by-side columns share a line, partial lines at the edges are left out', async () => {
    const { mergeTextLines } = await import('../src/reader/comfort')
    const rects = [
      { top: 100, bottom: 120 }, { top: 101, bottom: 119 }, // two words, one line
      { top: 128, bottom: 148 }, { top: 130, bottom: 150 }, // left and right column, slightly offset
      { top: 156, bottom: 176 },
      { top: 90, bottom: 99.5 }, // a sliver of a line cut off at the top edge... still inside, kept
      { top: 590, bottom: 612 }, // below the view
      { top: 300, bottom: 301 }, // too thin (a rule)
    ]
    const lines = mergeTextLines(rects, 80, 600)
    expect(lines).toEqual([{ top: 90, bottom: 99.5 }, { top: 100, bottom: 120 }, { top: 128, bottom: 150 }, { top: 156, bottom: 176 }])
  })
  it('finds the nearest line and makes a band over one or three lines', async () => {
    const { nearestLine, bandOver } = await import('../src/reader/comfort')
    const lines = [{ top: 100, bottom: 120 }, { top: 128, bottom: 148 }, { top: 156, bottom: 176 }]
    expect(nearestLine(lines, 110)).toBe(0)
    expect(nearestLine(lines, 125)).toBe(1) // in the gap, nearer the second line
    expect(nearestLine(lines, 999)).toBe(2)
    expect(nearestLine([], 10)).toBe(-1)
    const one = bandOver(lines, 1, 1)
    expect(one.top).toBeLessThan(128); expect(one.bottom).toBeGreaterThan(148); expect(one.bottom).toBeLessThan(156)
    const three = bandOver(lines, 1, 3)
    expect(three.top).toBeLessThan(100); expect(three.bottom).toBeGreaterThan(176)
    expect(bandOver(lines, 0, 3).top).toBeLessThan(100) // at the first line, three lines start there
  })
})
