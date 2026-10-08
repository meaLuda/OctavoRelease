import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pageParas, pageUtterances, sentences, PdfReadAloud, CloudEngine, findGutter, itemLines,
  type TextItem, type PageInput, type SpeechEngine, type AudioLike,
} from '../src/pdf/readAloud'

// one item per line, PDF coordinates (y up)
const L = (str: string, y: number, x = 72, size = 10, width = str.length * size * 0.5): TextItem =>
  ({ str, transform: [size, 0, 0, size, x, y], width, hasEOL: true })

const page = (items: TextItem[]): PageInput => ({ items, height: 792 })
const texts = (p: number, paras: ReturnType<typeof pageParas>) => pageUtterances(p, paras).map(u => u.text)

describe('reading order', () => {
  it('drops running headers, footers and page numbers repeated across pages', () => {
    const mk = (n: number, body: string) => page([
      L('Journal of Testing, Vol. 3', 760), L(`${n}`, 760, 500),
      L(body, 700),
      L('Draft — do not cite', 40), L(`Page ${n} of 9`, 28),
    ])
    const p1 = mk(1, 'Alpha sentence one.'), p2 = mk(2, 'Beta sentence two.'), p3 = mk(3, 'Gamma sentence three.')
    expect(texts(2, pageParas(2, p2, [p1, p3]))).toEqual(['Beta sentence two.'])
  })

  it('keeps a first line that merely looks like a header when no neighbour repeats it', () => {
    const p = page([L('Introduction', 760, 72, 16), L('Body text here.', 700)])
    expect(texts(1, pageParas(1, p, [page([L('Other page text.', 700)])]))).toEqual(['Introduction', 'Body text here.'])
  })

  it('reads two columns left top-to-bottom, then right; full-width title first', () => {
    const items: TextItem[] = [L('A Paper Title Spanning Both Columns Of The Page', 740, 72, 16, 460)]
    // row-major content order (worst case): left and right line on each row
    for (let i = 0; i < 6; i++) {
      items.push({ ...L(`Left ${i + 1} words in the left column`, 700 - i * 12, 72, 10, 220), hasEOL: false })
      items.push(L(`Right ${i + 1} words in the right column`, 700 - i * 12, 320, 10, 220))
    }
    expect(findGutter(itemLines(items).slice(1))).not.toBeNull()
    const u = texts(1, pageParas(1, page(items)))
    const joined = u.join(' ')
    expect(u[0]).toBe('A Paper Title Spanning Both Columns Of The Page')
    expect(joined.indexOf('Left 6')).toBeLessThan(joined.indexOf('Right 1'))
    expect(joined.indexOf('Left 1')).toBeLessThan(joined.indexOf('Left 2'))
    expect(joined.indexOf('Right 1')).toBeLessThan(joined.indexOf('Right 6'))
  })

  it('does not split a single column of ragged lines into columns', () => {
    const items = Array.from({ length: 10 }, (_, i) => L(i % 3 ? 'A full line of body text that crosses the middle ok' : 'Short.', 700 - i * 12, 72, 10, i % 3 ? 400 : 30))
    expect(findGutter(itemLines(items))).toBeNull()
  })

  it('joins hyphenated line ends and lines within a paragraph', () => {
    const p = page([L('The experiment con-', 700, 72, 10, 400), L('tinued for three weeks and then', 688, 72, 10, 400), L('ended. A second sentence.', 676, 72, 10, 200)])
    expect(texts(1, pageParas(1, p))).toEqual(['The experiment continued for three weeks and then ended.', 'A second sentence.'])
  })

  it('joins a sentence cut by a page break; it belongs to the page where it starts', () => {
    const p1 = page([L('First page sentence. The cut sentence runs on', 700, 72, 10, 400)])
    const p2 = page([L('into the next page. Then another one.', 700, 72, 10, 400)])
    const a = pageParas(1, p1), b = pageParas(2, p2)
    const u1 = pageUtterances(1, a, [], b), u2 = pageUtterances(2, b, a, [])
    expect(u1.map(u => u.text)).toEqual(['First page sentence.', 'The cut sentence runs on into the next page.'])
    expect(u2.map(u => u.text)).toEqual(['Then another one.'])
    // the straddling sentence maps to items on both pages
    expect(u1[1]!.ranges.map(r => r.page)).toEqual([1, 2])
    expect(u1[1]!.ranges[1]).toEqual({ page: 2, item: 0, start: 0, end: 'into the next page.'.length })
  })

  it('maps sentences back to item/char ranges', () => {
    const items: TextItem[] = [
      { str: 'Hello there. Second', transform: [10, 0, 0, 10, 72, 700], width: 150 },
      { str: 'part ends. Third.', transform: [10, 0, 0, 10, 225, 700], width: 120, hasEOL: true },
    ]
    const u = pageUtterances(1, pageParas(1, page(items)))
    expect(u.map(x => x.text)).toEqual(['Hello there.', 'Second part ends.', 'Third.'])
    expect(u[0]!.ranges).toEqual([{ page: 1, item: 0, start: 0, end: 12 }])
    expect(u[1]!.ranges).toEqual([{ page: 1, item: 0, start: 13, end: 19 }, { page: 1, item: 1, start: 0, end: 10 }])
    expect(u[2]!.ranges).toEqual([{ page: 1, item: 1, start: 11, end: 17 }])
  })
})

describe('sentences', () => {
  it('keeps abbreviations and initials inside a sentence', () => {
    const t = 'As shown in Fig. 3 by Dr. Smith, results improve. See J. R. Tolkien et al. for more.'
    expect(sentences(t).map(([s, e]) => t.slice(s, e))).toEqual(['As shown in Fig. 3 by Dr. Smith, results improve.', 'See J. R. Tolkien et al. for more.'])
  })
  it('works without Intl.Segmenter', () => {
    const Seg = (Intl as any).Segmenter
    ;(Intl as any).Segmenter = undefined
    try {
      const t = 'One here. Two there! Three?'
      expect(sentences(t).map(([s, e]) => t.slice(s, e))).toEqual(['One here.', 'Two there!', 'Three?'])
    } finally { (Intl as any).Segmenter = Seg }
  })
  it('splits very long sentences at clause boundaries', () => {
    const t = Array.from({ length: 30 }, (_, i) => `clause number ${i} goes here`).join(', ') + '.'
    const parts = sentences(t)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(([s, e]) => e - s <= 320)).toBe(true)
  })
})

// ───────────────────────── controller ─────────────────────────

class FakeEngine implements SpeechEngine {
  canPause = false
  spoken: string[] = []
  cancels = 0
  private end: (() => void) | null = null
  speak(text: string, _rate: number, onEnd: () => void) { this.spoken.push(text); this.end = onEnd }
  cancel() { this.cancels++; this.end = null }
  finish() { const e = this.end; this.end = null; e?.() }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 5; i++) await flush() }

const book: Record<number, PageInput> = {
  1: page([L('Page one first. Page one second.', 700, 72, 10, 300)]),
  2: page([]), // scanned
  3: page([L('Page three only.', 700, 72, 10, 300)]),
}
const make = (engine: SpeechEngine, extra: Partial<ConstructorParameters<typeof PdfReadAloud>[0]> = {}) => {
  const seen: string[] = []
  const noText: number[] = []
  const ends: string[] = []
  const c = new PdfReadAloud({
    engine, pageCount: 3, onPageNeeded: async n => book[n] ?? null,
    onSentence: (p, _r, u) => seen.push(`${p}:${u.text}`), onNoText: p => noText.push(p), onEnd: r => ends.push(r), ...extra,
  })
  return { c, seen, noText, ends }
}

describe('PdfReadAloud', () => {
  afterEach(() => vi.useRealTimers())

  it('reads sentences in order across pages, reporting text-less pages', async () => {
    const e = new FakeEngine()
    const { c, seen, noText, ends } = make(e)
    await c.play(1)
    e.finish(); await settle()
    e.finish(); await settle()
    expect(seen).toEqual(['1:Page one first.', '1:Page one second.', '3:Page three only.'])
    expect(noText).toEqual([2])
    e.finish(); await settle()
    expect(ends).toEqual(['done'])
    expect(c.state).toBe('stopped')
  })

  it('next / prev / pause / resume / stop', async () => {
    const e = new FakeEngine()
    const { c, seen, ends } = make(e)
    await c.play(1)
    c.next(); await settle()
    expect(seen.at(-1)).toBe('1:Page one second.')
    c.next(); await settle()
    expect(seen.at(-1)).toBe('3:Page three only.')
    c.prev(); await settle()
    expect(seen.at(-1)).toBe('1:Page one second.')
    c.pause()
    expect(c.state).toBe('paused')
    e.finish(); await settle() // a late end event from the cancelled utterance is ignored
    expect(seen.at(-1)).toBe('1:Page one second.')
    c.resume(); await settle()
    expect(e.spoken.at(-1)).toBe('Page one second.') // restarts the sentence
    expect(c.state).toBe('playing')
    c.stop()
    expect(ends).toEqual(['stopped'])
    expect(c.active).toBe(false)
  })

  it('rapid next taps each advance one sentence', async () => {
    const e = new FakeEngine()
    const { c, seen } = make(e)
    await c.play(1)
    c.next(); c.next(); await settle()
    expect(seen.at(-1)).toBe('3:Page three only.')
  })

  it('starts from a given item (read from selection)', async () => {
    const e = new FakeEngine()
    const { c, seen } = make(e)
    await c.play(1, 0, 20) // offset inside "Page one second."
    expect(seen).toEqual(['1:Page one second.'])
  })

  it('sleep timer stops after the current sentence once time is up', async () => {
    vi.useFakeTimers()
    const e = new FakeEngine()
    const { c, seen, ends } = make(e)
    const p = c.play(1)
    await vi.runAllTimersAsync(); await p
    c.setSleep({ minutes: 5 })
    vi.advanceTimersByTime(5 * 60_000)
    expect(c.state).toBe('playing') // finishes the sentence
    e.finish(); await vi.runAllTimersAsync()
    expect(seen).toEqual(['1:Page one first.'])
    expect(ends).toEqual(['sleep'])
  })

  it('sleep at end of section stops before the next section starts', async () => {
    const e = new FakeEngine()
    const { c, seen, ends } = make(e, { sections: [1, 3] })
    await c.play(1)
    c.setSleep({ section: true })
    e.finish(); await settle()
    e.finish(); await settle()
    expect(seen).toEqual(['1:Page one first.', '1:Page one second.'])
    expect(ends).toEqual(['sleep'])
  })

  it('ends after three text-less pages in a row', async () => {
    const e = new FakeEngine()
    const noText: number[] = []
    const ends: string[] = []
    const c = new PdfReadAloud({ engine: e, pageCount: 5, onPageNeeded: async () => page([]), onNoText: p => noText.push(p), onEnd: r => ends.push(r) })
    await c.play(1)
    expect(noText).toEqual([1, 2, 3])
    expect(ends).toEqual(['notext'])
  })
})

class FakeAudio implements AudioLike {
  src = ''
  playbackRate = 1
  played: string[] = []
  onended: any = null
  onerror: any = null
  async play() { this.played.push(this.src) }
  pause() {}
  removeAttribute() { this.src = '' }
}

describe('CloudEngine', () => {
  it('prefetches the next sentence and reuses it when it is spoken', async () => {
    const fetched: string[] = []
    const audio = new FakeAudio()
    const engine = new CloudEngine(async text => { fetched.push(text); return `url:${text}` }, audio)
    const c = new PdfReadAloud({ engine, pageCount: 3, onPageNeeded: async n => book[n] ?? null })
    await c.play(1); await settle()
    expect(fetched).toEqual(['Page one first.', 'Page one second.'])
    expect(audio.played).toEqual(['url:Page one first.'])
    audio.onended(); await settle()
    expect(audio.played).toEqual(['url:Page one first.', 'url:Page one second.'])
    expect(fetched).toEqual(['Page one first.', 'Page one second.', 'Page three only.']) // no refetch, next one prefetched
    c.pause()
    expect(c.state).toBe('paused')
    c.resume()
    expect(audio.played.at(-1)).toBe('url:Page one second.')
    c.setRate(1.5)
    expect(audio.playbackRate).toBe(1.5)
  })
})

describe('three columns', () => {
  it('reads each of three columns top to bottom in turn', () => {
    const items: TextItem[] = []
    for (let i = 0; i < 6; i++) for (const [c, x] of [['A', 72], ['B', 250], ['C', 428]] as const)
      items.push({ ...L(`${c}${i + 1} column text goes here`, 700 - i * 12, x, 10, 160), hasEOL: c === 'C' })
    const order = pageUtterances(1, pageParas(1, page(items))).map(u => u.text).join(' ').match(/[ABC]\d/g)
    expect(order).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'])
  })
})
