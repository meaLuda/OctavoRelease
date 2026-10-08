/**
 * PDF read-aloud: reading order, sentence segmentation and a playback
 * controller. Pure logic (no pdf.js, no DOM) apart from the two engines at the
 * bottom, so the ordering rules can be unit-tested with synthetic text items.
 *
 * Pipeline per page: text items → lines (keeping item indices) → drop running
 * headers/footers and page numbers (lines repeated at the same page edge on
 * neighbouring pages) → column bands (left column top-to-bottom, then right;
 * full-width lines split bands) → paragraphs (hyphenated line ends rejoined)
 * → sentences, each mapped back to the item/char ranges it came from so the
 * view can highlight the spans being read. A paragraph cut by a page break
 * (reflow.continues) is joined with the next page, and the sentence that
 * straddles the break belongs to the page it starts on.
 */
import { continues } from './reflow'

export interface TextItem { str: string; transform: number[]; width: number; height?: number; hasEOL?: boolean; fontName?: string }
export interface PageInput { items: TextItem[]; height?: number }
/** Characters [start, end) of text item `item` on `page`. */
export interface ItemRange { page: number; item: number; start: number; end: number }
export interface Utterance { page: number; index: number; text: string; ranges: ItemRange[]; heading: boolean }

// ───────────────────────── lines ─────────────────────────

interface Frag { item: number; start: number; end: number }
export interface Line { y: number; x0: number; x1: number; size: number; pieces: Array<Frag | null>; text: string; parts?: Line[] }

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]!
}

/**
 * Text items → visual lines, like reflow.toLines but keeping which item each
 * piece came from. A horizontal gap wider than pdf.js's in-flow space (~0.6em) starts a
 * new line fragment so neighbouring columns never merge into one line. `null` pieces are inserted spaces.
 */
export function itemLines(items: TextItem[]): Line[] {
  const lines: Line[] = []
  let cur: Line | null = null
  items.forEach((it, i) => {
    const str = it.str ?? ''
    if (str.trim()) {
      const [a = 10, b = 0, , , x = 0, y = 0] = it.transform
      const size = Math.hypot(a, b) || it.height || 10
      if (cur && Math.abs(cur.y - y) < Math.min(size, cur.size) * 0.5 && x >= cur.x0 - size && x - cur.x1 < size * 0.8) {
        if (x - cur.x1 > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(str)) { cur.pieces.push(null); cur.text += ' ' }
        cur.pieces.push({ item: i, start: 0, end: str.length })
        cur.text += str
        cur.x1 = Math.max(cur.x1, x + it.width)
      } else {
        cur = { y, x0: x, x1: x + it.width, size, pieces: [{ item: i, start: 0, end: str.length }], text: str }
        lines.push(cur)
      }
    }
    if (it.hasEOL) cur = null
  })
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim()
  return lines
}

/** Rows of lines (same baseline), top of the page first. */
function rows(lines: Line[]): Line[][] {
  const out: Line[][] = []
  for (const l of [...lines].sort((a, b) => b.y - a.y)) {
    const r = out[out.length - 1]
    if (r && Math.abs(r[0]!.y - l.y) < Math.max(2, l.size * 0.5)) r.push(l)
    else out.push([l])
  }
  return out
}

/**
 * Same-row fragments → one line each, left to right. OCR text layers put every
 * word in its own item with jittery baselines and sizes; this evens that out.
 */
export function mergeRows(lines: Line[]): Line[] {
  return rows(lines).map(r => {
    if (r.length === 1) return r[0]!
    r.sort((a, b) => a.x0 - b.x0)
    const chars = r.flatMap(l => Array(Math.max(1, l.text.length)).fill(l.size) as number[])
    return {
      y: median(r.map(l => l.y)), x0: r[0]!.x0, x1: Math.max(...r.map(l => l.x1)), size: median(chars),
      pieces: r.flatMap((l, i) => i ? [null, ...l.pieces] : l.pieces), text: r.map(l => l.text).join(' '), parts: r,
    }
  })
}

const PAGE_NO = /^[-–—(\[]?\s*(page\s*)?(\d{1,4}|[ivxlc]{1,6})(\s*(\/|of)\s*\d{1,4})?\s*[-–—)\]]?$/i
const normRunning = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

/** Lines in the top two and bottom two rows of a page (where running heads, feet and folios live). */
function edgeLines(lines: Line[]): Line[] {
  const r = rows(lines)
  if (r.length <= 2) return r.flat()
  return [...r.slice(0, 2), ...r.slice(-2)].flat()
}

/**
 * Running headers/footers: an edge line whose text (digits ignored) recurs at
 * about the same height on a nearby page, or a bare page number at an edge.
 */
export function runningLines(lines: Line[], neighbours: Line[][]): Set<Line> {
  const out = new Set<Line>()
  const r = rows(lines)
  const edges = edgeLines(lines)
  const outer = new Set([...(r[0] ?? []), ...(r[r.length - 1] ?? [])])
  const others = neighbours.map(edgeLines)
  for (const l of edges) {
    if (PAGE_NO.test(l.text) && (outer.has(l) || l.text.length <= 4)) { out.add(l); continue }
    const key = normRunning(l.text)
    if (!key) continue
    const tol = Math.max(4, l.size * 1.5)
    if (others.some(ls => ls.some(o => normRunning(o.text) === key && Math.abs(o.y - l.y) < tol))) out.add(l)
  }
  return out
}

/**
 * Reading order of body lines as column runs: full-width lines split the page
 * into bands; inside a two-column band the left column is read top to bottom,
 * then the right. Returns runs (a paragraph may continue across runs).
 */
export function columnRuns(lines: Line[], depth = 0): Line[][] {
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.x0 - b.x0)
  const gutter = depth < 3 ? findGutter(lines) : null
  if (gutter === null) return sorted.length ? [sorted] : []
  const runs: Line[][] = []
  let left: Line[] = [], right: Line[] = []
  // each side may itself hold columns (three-column layouts)
  const flush = () => { if (left.length) runs.push(...columnRuns(left, depth + 1)); if (right.length) runs.push(...columnRuns(right, depth + 1)); left = []; right = [] }
  for (const l of sorted) {
    if (l.x1 <= gutter + 1) left.push(l)
    else if (l.x0 >= gutter - 1) right.push(l)
    else { const spanning = !left.length && !right.length && runs.length && runs[runs.length - 1]!.every(x => x.x0 < gutter - 1 && x.x1 > gutter + 1); flush(); if (spanning) runs[runs.length - 1]!.push(l); else runs.push([l]) }
  }
  flush()
  return runs
}

/**
 * Horizontal cuts (the "Y" of XY-cut): a heading with blank space across the
 * whole page width above it starts a new band, so a multi-column page made of
 * sections reads section by section rather than column by column.
 */
export function sectionBands(lines: Line[], bodySize: number): Line[][] {
  const sorted = [...lines].sort((a, b) => b.y - a.y)
  const gaps = sorted.slice(1).map((l, i) => sorted[i]!.y - l.y).filter(g => g > bodySize * 0.5 && g < bodySize * 4)
  const lineGap = median(gaps) || bodySize * 1.3
  const bands: Line[][] = []
  sorted.forEach((l, i) => {
    const gap = i ? sorted[i - 1]!.y - l.y : Infinity
    if (!bands.length || (gap >= lineGap * 1.8 && l.size >= bodySize * 1.15)) bands.push([l])
    else bands[bands.length - 1]!.push(l)
  })
  return bands
}

/** x of a vertical gutter that splits the lines into two real columns, or null for single-column text. */
export function findGutter(lines: Line[]): number | null {
  if (lines.length < 6) return null
  const minX = Math.min(...lines.map(l => l.x0)), maxX = Math.max(...lines.map(l => l.x1))
  const span = maxX - minX
  if (span <= 0) return null
  const steps = 200
  const xs = Array.from({ length: steps + 1 }, (_, s) => minX + span * (0.3 + 0.4 * s / steps))
  const cross = xs.map(x => lines.filter(l => l.x0 < x - 1 && l.x1 > x + 1).length)
  const best = Math.min(...cross)
  // centre of the widest run of least-crossed positions = the middle of the gutter
  let run: [number, number] = [0, -1], start = -1
  cross.forEach((c, i) => {
    if (c === best) { if (start < 0) start = i; if (i - start > run[1] - run[0]) run = [start, i] }
    else start = -1
  })
  const x = xs[Math.round((run[0] + run[1]) / 2)]!
  const left = lines.filter(l => l.x1 <= x + 1), right = lines.filter(l => l.x0 >= x - 1)
  const n = lines.length
  if (best > Math.max(2, n * 0.2) || left.length < 3 || right.length < 3 || left.length < n * 0.15 || right.length < n * 0.15) return null
  // the right column must have an aligned left edge (not just ragged/centred short lines)
  const size = median(lines.map(l => l.size))
  const edge = median(right.map(l => l.x0))
  if (right.filter(l => Math.abs(l.x0 - edge) < size * 3).length < right.length * 0.5) return null
  return x
}

// ───────────────────────── mapped text ─────────────────────────

/** Text whose every character remembers its source (page, item, offset); item -1 = inserted. */
export class Mapped {
  text = ''
  page: number[] = []
  item: number[] = []
  off: number[] = []
  push(ch: string, page: number, item: number, off: number) {
    if (/\s/.test(ch)) { if (!this.text || this.text.endsWith(' ')) return; ch = ' ' }
    this.text += ch; this.page.push(page); this.item.push(item); this.off.push(off)
  }
  trimEnd() { while (this.text.endsWith(' ')) this.pop() }
  pop() { this.text = this.text.slice(0, -1); this.page.pop(); this.item.pop(); this.off.pop() }
  /** Append `b`, rejoining a word hyphenated at the break ("con-" + "tinues"). */
  join(b: Mapped) {
    this.trimEnd()
    if (this.text && b.text) {
      if (/[A-Za-z] ?[-\u00AD]$/.test(this.text) && /^[a-z]/.test(b.text)) { this.pop(); this.trimEnd() }
      else this.push(' ', -1, -1, -1)
    }
    for (let i = 0; i < b.text.length; i++) this.push(b.text[i]!, b.page[i]!, b.item[i]!, b.off[i]!)
  }
  /** Source ranges of characters [s, e), one per item, in reading order. */
  ranges(s: number, e: number): ItemRange[] {
    const out: ItemRange[] = []
    for (let i = s; i < e; i++) {
      const item = this.item[i]!
      if (item < 0) continue
      const page = this.page[i]!, off = this.off[i]!
      const r = out.find(x => x.page === page && x.item === item)
      if (r) { r.start = Math.min(r.start, off); r.end = Math.max(r.end, off + 1) }
      else out.push({ page, item, start: off, end: off + 1 })
    }
    return out
  }
}

function lineText(l: Line, items: TextItem[], page: number): Mapped {
  const m = new Mapped()
  for (const p of l.pieces) {
    if (!p) { m.push(' ', -1, -1, -1); continue }
    const s = items[p.item]!.str
    for (let k = p.start; k < p.end; k++) m.push(s[k]!, page, p.item, k)
  }
  m.trimEnd()
  return m
}

// ───────────────────────── paragraphs ─────────────────────────

export interface Para { heading: boolean; text: Mapped }

const ENDS_SENTENCE = /[.!?:"”’)\]]$/

/**
 * One page → paragraphs in reading order. `neighbours` are the nearby pages'
 * items (used only to recognise running headers/footers).
 */
export function pageParas(page: number, input: PageInput, neighbours: PageInput[] = []): Para[] {
  const frags = itemLines(input.items)
  const rowsOf = (ls: Line[]) => mergeRows(ls)
  const running = runningLines(rowsOf(frags), neighbours.map(n => rowsOf(itemLines(n.items))))
  const dropped = new Set([...running].flatMap(r => r.parts ?? [r]))
  const body = frags.filter(l => !dropped.has(l))
  if (!body.length) return []
  const bodySize = median(rowsOf(body).map(l => l.size))
  // columns are found on fragments; each column's fragments are then merged back into rows
  const runs = sectionBands(body, bodySize).flatMap(b => columnRuns(b)).map(mergeRows)
  const gaps: number[] = []
  for (const r of runs) for (let i = 1; i < r.length; i++) { const g = r[i - 1]!.y - r[i]!.y; if (g > bodySize * 0.3 && g < bodySize * 4) gaps.push(g) }
  const lineGap = median(gaps) || bodySize * 1.3
  const paras: Para[] = []
  let cur: { heading: boolean; lines: Line[] } | null = null
  const out: Array<{ heading: boolean; lines: Line[] }> = []
  for (const run of runs) {
    const left = Math.min(...run.map(l => l.x0)), right = Math.max(...run.map(l => l.x1))
    run.forEach((l, i) => {
      const heading = l.size >= bodySize * 1.2 && l.text.length < 140
      const prev = i > 0 ? run[i - 1]! : null
      let brk = !cur || heading !== cur.heading
      if (!brk && cur) {
        const last = cur.lines[cur.lines.length - 1]!
        if (heading) brk = Math.abs(last.size - l.size) > 0.5 || last.y - l.y > l.size * 1.8
        else if (!prev) brk = !continues(last.text, l.text) // column/band change
        else {
          const gap = prev.y - l.y
          const sameRow = Math.abs(gap) < l.size * 0.5
          const ended = ENDS_SENTENCE.test(prev.text)
          const indented = l.x0 > left + bodySize * 1.2
          const shortPrev = prev.x1 < right - bodySize * 4
          // a line that doesn't end a sentence followed by a lowercase start is the same paragraph, whatever the spacing
          brk = !sameRow && !continues(prev.text, l.text) && (gap > lineGap * 1.5 || Math.abs(l.size - prev.size) > bodySize * 0.2 || (ended && (indented || shortPrev)))
        }
      }
      if (brk) { cur = { heading, lines: [] }; out.push(cur) }
      cur!.lines.push(l)
    })
  }
  for (const p of out) {
    const m = new Mapped()
    for (const l of p.lines) m.join(lineText(l, input.items, page))
    if (m.text.trim()) paras.push({ heading: p.heading, text: m })
  }
  return paras
}

// ───────────────────────── sentences ─────────────────────────

const ABBREV = /(\b(Mr|Mrs|Ms|Dr|Prof|p|Sr|Jr|St|vs|cf|Fig|Figs|Eq|Eqs|No|Nos|Vol|pp|al|Sec|Ch|approx|ca|resp|Ref|Refs)|\be\.g|\bi\.e|\b[A-Z])\.$/
const MAX_LEN = 320

/** Sentence spans [start, end) over `text`, trimmed, abbreviations and stray numbering merged, long ones split. */
export function sentences(text: string, locale?: string): Array<[number, number]> {
  const raw: Array<[number, number]> = []
  const Seg = (Intl as any).Segmenter
  if (Seg) {
    for (const s of new Seg(locale, { granularity: 'sentence' }).segment(text) as Iterable<{ index: number; segment: string }>) raw.push([s.index, s.index + s.segment.length])
  } else {
    const re = /[.!?…]+["'”’)\]]*\s+(?=["“‘(\[]?[A-Z0-9])/g
    let last = 0
    for (let m = re.exec(text); m; m = re.exec(text)) { raw.push([last, m.index + m[0].length]); last = m.index + m[0].length }
    if (last < text.length) raw.push([last, text.length])
  }
  // merge after abbreviations / initials / bare numbering ("1.")
  const merged: Array<[number, number]> = []
  for (const r of raw) {
    const prev = merged[merged.length - 1]
    if (prev) {
      const t = text.slice(prev[0], prev[1]).trim()
      if (ABBREV.test(t) || t.length < 4) { prev[1] = r[1]; continue }
    }
    merged.push([r[0], r[1]])
  }
  const out: Array<[number, number]> = []
  for (let [s, e] of merged) {
    while (s < e && /\s/.test(text[s]!)) s++
    while (e > s && /\s/.test(text[e - 1]!)) e--
    while (e - s > MAX_LEN) {
      const chunk = text.slice(s, s + MAX_LEN)
      const cut = Math.max(chunk.lastIndexOf('; '), chunk.lastIndexOf(', '), chunk.lastIndexOf(' — '))
      const at = cut > MAX_LEN * 0.4 ? cut + 1 : (chunk.lastIndexOf(' ') > MAX_LEN * 0.4 ? chunk.lastIndexOf(' ') : MAX_LEN)
      out.push([s, s + at])
      s += at
      while (s < e && /\s/.test(text[s]!)) s++
    }
    if (e > s) out.push([s, e])
  }
  return out
}

/**
 * Utterances of one page. `prev`/`next` are the neighbouring pages' paragraphs:
 * a paragraph that continues across a page break is segmented together with its
 * other half, and each sentence belongs to the page where it starts.
 */
export function pageUtterances(page: number, paras: Para[], prev: Para[] = [], next: Para[] = [], locale?: string): Utterance[] {
  const out: Utterance[] = []
  const prevLast = prev[prev.length - 1], nextFirst = next[0]
  paras.forEach((p, i) => {
    const m = new Mapped()
    if (i === 0 && prevLast && !prevLast.heading && !p.heading && continues(prevLast.text.text, p.text.text)) m.join(prevLast.text)
    m.join(p.text)
    const to = m.text.length
    const from = to - p.text.text.length
    if (i === paras.length - 1 && nextFirst && !p.heading && !nextFirst.heading && continues(p.text.text, nextFirst.text.text)) m.join(nextFirst.text)
    for (const [s, e] of sentences(m.text, locale)) {
      if (s < from || s >= to) continue
      const ranges = m.ranges(s, e)
      if (!ranges.length) continue
      out.push({ page, index: out.length, text: m.text.slice(s, e), ranges, heading: p.heading })
    }
  })
  return out
}

// ───────────────────────── engines ─────────────────────────

export interface SpeechEngine {
  /** True when pause() keeps the position inside the current utterance. */
  readonly canPause: boolean
  speak(text: string, rate: number, onEnd: () => void, onError: (e: Error) => void): void
  cancel(): void
  pause?(): void
  resume?(): void
  prefetch?(text: string): void
  setRate?(rate: number): void
  dispose?(): void
}

/** Web Speech: one utterance per sentence. pause = cancel (resume restarts the sentence), which works on every platform. */
export class SystemEngine implements SpeechEngine {
  readonly canPause = false
  private u: SpeechSynthesisUtterance | null = null
  constructor(private voice: () => SpeechSynthesisVoice | undefined, private volume = 1) {}
  speak(text: string, rate: number, onEnd: () => void, onError: (e: Error) => void) {
    this.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = rate
    u.volume = this.volume
    const v = this.voice()
    if (v) u.voice = v
    u.onend = () => { if (this.u === u) { this.u = null; onEnd() } }
    u.onerror = e => {
      if (this.u !== u) return
      this.u = null
      if (e.error === 'interrupted' || e.error === 'canceled') return
      onError(new Error(`Speech failed: ${e.error}`))
    }
    this.u = u // keep a reference: Chrome drops events of garbage-collected utterances
    speechSynthesis.speak(u)
  }
  cancel() { this.u = null; speechSynthesis.cancel() }
  dispose() { this.cancel() }
}

export interface AudioLike {
  src: string
  playbackRate: number
  play(): Promise<void>
  pause(): void
  removeAttribute(name: string): void
  onended: ((this: any, ev: Event) => any) | null
  onerror: ((this: any, ev: Event | string) => any) | null
}

/** Octavo Cloud voices: fetch an audio URL per sentence, prefetching the next one while this one plays. */
export class CloudEngine implements SpeechEngine {
  readonly canPause = true
  private cache = new Map<string, Promise<string>>()
  private signal = { cancelled: false }
  private token = 0
  private loaded = -1
  private paused = false
  private rate = 1
  constructor(private fetchUrl: (text: string, signal: { cancelled: boolean }) => Promise<string>, private audio: AudioLike = new Audio()) {}

  private url(text: string): Promise<string> {
    let p = this.cache.get(text)
    if (!p) {
      p = this.fetchUrl(text, this.signal)
      p.catch(() => this.cache.delete(text))
      this.cache.set(text, p)
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
    }
    return p
  }
  prefetch(text: string) { void this.url(text).catch(() => {}) }
  speak(text: string, rate: number, onEnd: () => void, onError: (e: Error) => void) {
    const t = ++this.token
    this.rate = rate
    this.paused = false
    this.audio.pause()
    this.url(text).then(async src => {
      if (t !== this.token) return
      if (!src) return onEnd()
      this.audio.src = src
      this.audio.playbackRate = this.rate
      this.audio.onended = () => { if (t === this.token) onEnd() }
      this.audio.onerror = () => { if (t === this.token) onError(new Error('Audio playback failed')) }
      this.loaded = t
      if (!this.paused) await this.audio.play()
    }).catch(e => { if (t === this.token) onError(e as Error) })
  }
  pause() { this.paused = true; this.audio.pause() }
  resume() { this.paused = false; if (this.loaded === this.token) void this.audio.play().catch(() => {}) }
  cancel() { this.token++; this.audio.pause() }
  setRate(r: number) { this.rate = r; this.audio.playbackRate = r }
  dispose() { this.cancel(); this.signal.cancelled = true; this.audio.removeAttribute('src') }
}

// ───────────────────────── controller ─────────────────────────

export type ReadState = 'stopped' | 'loading' | 'playing' | 'paused'
export type EndReason = 'done' | 'stopped' | 'sleep' | 'notext' | 'error'
export type Sleep = { minutes: number } | { section: true } | null

export interface ReadAloudOptions {
  engine: SpeechEngine
  pageCount: number
  rate?: number
  locale?: string
  /** Load a page's text items (pdf.js getTextContent, filtered to items with `str`). null = unavailable. */
  onPageNeeded(page: number): Promise<PageInput | null>
  onSentence?(page: number, ranges: ItemRange[], u: Utterance): void
  onState?(state: ReadState): void
  /** A page without a text layer (a scan). Reading skips it; three in a row end the session. */
  onNoText?(page: number): void
  onEnd?(reason: EndReason): void
  onError?(e: Error): void
  /** First pages of outline sections, for "sleep at end of chapter". */
  sections?: number[]
}

const MAX_EMPTY_RUN = 3

export class PdfReadAloud {
  state: ReadState = 'stopped'
  page = 0
  index = 0
  rate: number
  private gen = 0
  private inputs = new Map<number, Promise<PageInput | null>>()
  private paras = new Map<number, Promise<Para[]>>()
  private utts = new Map<number, Promise<Utterance[]>>()
  private sleepTimer: ReturnType<typeof setTimeout> | null = null
  private sleepDue = false
  private sleepUntil = 0
  private sectionEnd = 0 // first page of the next section, 0 = none
  private resumable = false // engine paused mid-utterance

  constructor(private o: ReadAloudOptions) { this.rate = o.rate ?? 1 }

  get active() { return this.state !== 'stopped' }
  get current(): Promise<Utterance | null> { return this.utterances(this.page).then(u => u[this.index] ?? null) }
  /** Sleep timer status for the UI. */
  get sleep(): { until: number } | { section: number } | null {
    return this.sleepTimer ? { until: this.sleepUntil } : this.sectionEnd ? { section: this.sectionEnd } : null
  }

  // ── text model ──
  private input(n: number): Promise<PageInput | null> {
    if (n < 1 || n > this.o.pageCount) return Promise.resolve(null)
    let p = this.inputs.get(n)
    if (!p) { p = this.o.onPageNeeded(n).catch(() => null); this.inputs.set(n, p) }
    return p
  }
  private pageParasOf(n: number): Promise<Para[]> {
    let p = this.paras.get(n)
    if (!p) {
      p = (async () => {
        const me = await this.input(n)
        if (!me?.items.length) return []
        const nb = (await Promise.all([n - 2, n - 1, n + 1, n + 2].map(k => this.input(k)))).filter((x): x is PageInput => !!x)
        return pageParas(n, me, nb)
      })()
      this.paras.set(n, p)
    }
    return p
  }
  /** Sentences of page n in reading order (cached). */
  utterances(n: number): Promise<Utterance[]> {
    if (n < 1 || n > this.o.pageCount) return Promise.resolve([])
    let p = this.utts.get(n)
    if (!p) {
      p = (async () => {
        const [prev, me, next] = await Promise.all([n > 1 ? this.pageParasOf(n - 1) : [], this.pageParasOf(n), n < this.o.pageCount ? this.pageParasOf(n + 1) : []])
        return pageUtterances(n, me, prev, next, this.o.locale)
      })()
      this.utts.set(n, p)
    }
    return p
  }

  // ── transport ──
  /** Start reading at `page` (optionally at the sentence containing item/char `item`/`offset`, e.g. a selection start). */
  async play(page: number, item?: number, offset = 0): Promise<void> {
    this.halt()
    const g = this.gen
    this.setState('loading')
    const list = await this.utterances(page)
    if (g !== this.gen) return
    let idx = 0
    if (item !== undefined && list.length) {
      idx = list.findIndex(u => u.ranges.some(r => r.page === page && r.item === item && r.end > offset))
      if (idx < 0) idx = list.findIndex(u => u.ranges.some(r => r.page === page && r.item >= item))
      if (idx < 0) idx = 0
    }
    await this.speakAt(page, idx, g, 1)
  }
  pause() {
    if (this.state !== 'playing' && this.state !== 'loading') return
    if (this.o.engine.canPause && this.o.engine.pause) { this.o.engine.pause(); this.resumable = true }
    else { this.gen++; this.o.engine.cancel(); this.resumable = false }
    this.setState('paused')
  }
  resume() {
    if (this.state !== 'paused') return
    if (this.sleepDue) return this.finish('sleep')
    if (this.resumable && this.o.engine.resume) { this.resumable = false; this.o.engine.resume(); this.setState('playing'); return }
    this.halt()
    void this.speakAt(this.page, this.index, this.gen, 1)
  }
  toggle() { if (this.state === 'paused') this.resume(); else this.pause() }
  // the index moves synchronously so rapid taps each advance one sentence
  next() { if (!this.active) return; this.halt(); void this.speakAt(this.page, ++this.index, this.gen, 1) }
  prev() { if (!this.active) return; this.halt(); void this.speakAt(this.page, --this.index, this.gen, -1) }
  stop() { if (this.active) this.finish('stopped') }
  setRate(r: number) {
    this.rate = r
    if (this.o.engine.setRate) this.o.engine.setRate(r)
    else if (this.state === 'playing') { this.halt(); void this.speakAt(this.page, this.index, this.gen, 1) }
  }
  /** Sleep after N minutes (finishes the sentence being read) or at the end of the current outline section. */
  setSleep(s: Sleep) {
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    this.sleepDue = false
    this.sectionEnd = 0
    if (!s) return
    if ('minutes' in s) {
      this.sleepUntil = Date.now() + s.minutes * 60_000
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null
        this.sleepDue = true
        if (this.state === 'paused') this.finish('sleep')
      }, s.minutes * 60_000)
    } else {
      this.sectionEnd = (this.o.sections ?? []).filter(p => p > Math.max(1, this.page)).sort((a, b) => a - b)[0] ?? 0
    }
  }
  dispose() { this.stop(); this.o.engine.dispose?.() }

  // ── internals ──
  private halt() { this.gen++; this.resumable = false; this.o.engine.cancel() }
  private setState(s: ReadState) { if (this.state !== s) { this.state = s; this.o.onState?.(s) } }
  private finish(reason: EndReason) {
    this.gen++
    this.o.engine.cancel()
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    this.sleepDue = false
    this.sectionEnd = 0
    this.resumable = false
    this.setState('stopped')
    this.o.onEnd?.(reason)
  }

  /** Speak sentence `idx` of `page`, walking to neighbouring pages when idx falls off either end. */
  private async speakAt(page: number, idx: number, g: number, dir: 1 | -1): Promise<void> {
    let list = await this.utterances(page)
    if (g !== this.gen) return
    let empty = 0
    while (idx < 0 || idx >= list.length) {
      if (!list.length && dir > 0) {
        const inp = await this.input(page)
        if (g !== this.gen) return
        if (!inp?.items.some(i => i.str.trim())) { this.o.onNoText?.(page); if (++empty >= MAX_EMPTY_RUN) return this.finish('notext') }
      }
      if (dir > 0) { page++; idx = 0 } else { page--; idx = Number.MAX_SAFE_INTEGER }
      if (page > this.o.pageCount) return this.finish('done')
      if (page < 1) { page = 1; idx = 0; dir = 1 }
      if (this.sectionEnd && page >= this.sectionEnd && dir > 0) return this.finish('sleep')
      list = await this.utterances(page)
      if (g !== this.gen) return
      if (idx === Number.MAX_SAFE_INTEGER) idx = list.length ? list.length - 1 : -1
    }
    if (this.sleepDue) return this.finish('sleep')
    const u = list[idx]!
    this.page = page
    this.index = idx
    this.o.onSentence?.(page, u.ranges, u)
    this.setState('playing')
    this.o.engine.speak(u.text, this.rate,
      () => { if (g === this.gen) void this.speakAt(page, idx + 1, g, 1) },
      e => { if (g === this.gen) { this.o.onError?.(e); this.finish('error') } })
    if (this.o.engine.prefetch) {
      let nxt = list[idx + 1]
      for (let k = 1; !nxt && k <= MAX_EMPTY_RUN && page + k <= this.o.pageCount; k++) nxt = (await this.utterances(page + k))[0]
      if (nxt && g === this.gen) this.o.engine.prefetch(nxt.text)
    }
  }
}
