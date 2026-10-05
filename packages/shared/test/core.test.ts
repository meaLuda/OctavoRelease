import { describe, expect, it } from 'vitest'
import {
  findQuote, makeQuote, parseSubpath, formatCfiSubpath, formatPdfSubpath,
  renderHighlight, parseHighlights, upsertHighlight, removeHighlight, newHighlightId,
  bookIdFromBytes, Pace, formatDuration, computeStreak, signToken, verifyToken, GRACE_SECONDS,
  type Highlight,
} from '../src'

const text = 'The cat sat on the mat. The cat sat on the hat. The dog sat on the mat.'

describe('anchor', () => {
  it('disambiguates repeated quotes using prefix/suffix context', () => {
    const start = text.indexOf('cat sat', 20)
    const q = makeQuote(text, start, start + 7, 10)
    const m = findQuote(text, q)!
    expect(m.start).toBe(start)
  })
  it('falls back to whitespace/case-insensitive matching', () => {
    const m = findQuote('Hello   WORLD\nagain', { exact: 'hello world again', prefix: '', suffix: '' })!
    expect(m).toMatchObject({ start: 0, end: 19 })
  })
  it('returns null when absent', () => {
    expect(findQuote(text, { exact: 'zebra', prefix: '', suffix: '' })).toBeNull()
  })
})

describe('links', () => {
  it('round-trips CFI subpaths with wikilink-hostile characters', () => {
    const cfi = 'epubcfi(/6/4[chap01]!/4/2,/1:0,/1:20)'
    const sp = formatCfiSubpath(cfi, 'green')
    expect(sp).not.toMatch(/[\[\]|^]/)
    expect(parseSubpath(sp)).toEqual({ type: 'cfi', cfi, color: 'green' })
  })
  it('parses PDF++ links unchanged', () => {
    expect(parseSubpath('#page=12&selection=3,0,5,17&color=yellow')).toEqual({
      type: 'selection', color: 'yellow',
      selection: { page: 12, beginIndex: 3, beginOffset: 0, endIndex: 5, endOffset: 17 },
    })
    expect(parseSubpath('#page=3&annotation=123R')).toMatchObject({ type: 'annotation', page: 3, annotation: '123R' })
    expect(parseSubpath('#page=7&rect=1,2,3,4')).toMatchObject({ type: 'rect', rect: [1, 2, 3, 4] })
    expect(parseSubpath('#page=2')).toEqual({ type: 'page', page: 2, color: undefined })
    expect(parseSubpath('#page=x')).toBeNull()
    expect(parseSubpath('#page=1&selection=1,2,3')).toBeNull()
    expect(parseSubpath('#Some heading')).toBeNull()
  })
  it('formats PDF selections in PDF++ grammar', () => {
    expect(formatPdfSubpath({ page: 4, beginIndex: 1, beginOffset: 2, endIndex: 3, endOffset: 4 }, 'blue'))
      .toBe('#page=4&selection=1,2,3,4&color=blue')
  })
})

const hl = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'abc123', color: 'yellow', style: 'highlight', label: 'Ch. 1 · p. 3', created: '2026-10-05T10:00:00.000Z',
  anchor: { cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:5)', quote: { exact: 'Hello\nworld', prefix: 'say: ', suffix: ' %% end' } },
  ...over,
})

describe('book note blocks', () => {
  it('round-trips a highlight with note and tags', () => {
    const h = hl({ note: 'My thought\nsecond line', tags: ['idea', 'ch/1'] })
    const md = upsertHighlight('# Book\n', h, '[[b.epub#cfi=x|↗]]')
    const [p] = parseHighlights(md)
    expect(p).toMatchObject({ id: h.id, color: 'yellow', note: h.note, tags: h.tags, label: h.label, anchor: h.anchor })
  })
  it('appends new highlights inside the Highlights section, before the next heading', () => {
    let md = '# Book\n\n## Highlights\n\n## My notes\nkeep me\n'
    md = upsertHighlight(md, hl({ id: 'one' }), 'L1')
    md = upsertHighlight(md, hl({ id: 'two', color: 'pink' }), 'L2')
    const parsed = parseHighlights(md)
    expect(parsed.map(p => p.id)).toEqual(['one', 'two'])
    expect(md.indexOf('^oct-two')).toBeLessThan(md.indexOf('## My notes'))
    expect(md).toContain('keep me')
  })
  it('replaces in place and removes cleanly', () => {
    let md = upsertHighlight('', hl({ id: 'a' }), 'L')
    md = upsertHighlight(md, hl({ id: 'b' }), 'L')
    md = upsertHighlight(md, hl({ id: 'a', color: 'blue', note: 'n' }), 'L')
    expect(parseHighlights(md).map(p => [p.id, p.color])).toEqual([['a', 'blue'], ['b', 'yellow']])
    md = removeHighlight(md, 'a')
    expect(parseHighlights(md).map(p => p.id)).toEqual(['b'])
  })
  it('survives a user editing the visible text and note', () => {
    let md = upsertHighlight('', hl({ note: 'old' }), 'L')
    md = md.replace('> old', '> new note')
    expect(parseHighlights(md)[0]!.note).toBe('new note')
  })
  it('keeps PDF anchors', () => {
    const pdf = { page: 9, beginIndex: 1, beginOffset: 0, endIndex: 2, endOffset: 4 }
    const md = renderHighlight(hl({ anchor: { pdf, quote: { exact: 'x', prefix: '', suffix: '' } } }), 'L')
    expect(parseHighlights(md)[0]!.anchor.pdf).toEqual(pdf)
  })
  it('generates short unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, newHighlightId))
    expect(ids.size).toBe(200)
  })
})

describe('book id', () => {
  it('is stable and size-sensitive', async () => {
    const a = new TextEncoder().encode('x'.repeat(5000))
    expect(await bookIdFromBytes(a, 5000)).toBe(await bookIdFromBytes(a, 5000))
    expect(await bookIdFromBytes(a, 5000)).not.toBe(await bookIdFromBytes(a, 5001))
    expect(await bookIdFromBytes(a, 5000)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('pace', () => {
  it('learns from samples and ignores outliers', () => {
    const p = new Pace()
    for (let i = 0; i < 10; i++) p.record(60, 1500) // 0.04 s/char
    p.record(1, 1500); p.record(3000, 1500)
    expect(p.secPerChar).toBeCloseTo(0.04, 3)
    expect(p.estimate(15000)).toBe(600)
    expect(Pace.fromJSON(JSON.parse(JSON.stringify(p))).secPerChar).toBeCloseTo(0.04, 3)
  })
  it('formats durations', () => {
    expect(formatDuration(30)).toBe('< 1 min')
    expect(formatDuration(600)).toBe('10 min')
    expect(formatDuration(3900)).toBe('1 h 5 min')
  })
})

describe('streak', () => {
  const d = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y!, m! - 1, dd!) }
  it('counts consecutive days and tolerates one rest day per week', () => {
    const mins = { '2026-10-01': 10, '2026-10-02': 10, '2026-10-04': 10, '2026-10-05': 10 }
    expect(computeStreak(mins, 5, d('2026-10-05'))).toMatchObject({ current: 4, metToday: true })
  })
  it('breaks after two misses in a week', () => {
    const mins = { '2026-10-01': 10, '2026-10-04': 10, '2026-10-05': 10 }
    expect(computeStreak(mins, 5, d('2026-10-05')).current).toBe(2)
  })
  it('does not break just because today is not done yet', () => {
    const mins = { '2026-10-03': 10, '2026-10-04': 10 }
    expect(computeStreak(mins, 5, d('2026-10-05'))).toMatchObject({ current: 2, metToday: false })
  })
})

describe('entitlement tokens', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey)
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const now = 1_800_000_000
  const ent = { sub: 'acc_1', tier: 'cloud' as const, iat: now, exp: now + 3600 }
  it('verifies, honours grace, rejects tampering and unknown keys', async () => {
    const t = await signToken(ent, priv, 'k1')
    expect(await verifyToken(t, { k1: pub }, now)).toMatchObject({ ok: true, expired: false })
    expect(await verifyToken(t, { k1: pub }, now + 7200)).toMatchObject({ ok: true, expired: true })
    expect(await verifyToken(t, { k1: pub }, now + 3600 + GRACE_SECONDS + 1)).toEqual({ ok: false, reason: 'expired' })
    expect(await verifyToken(t, { k2: pub }, now)).toEqual({ ok: false, reason: 'unknown-key' })
    const [h, , s] = t.split('.')
    const forged = `${h}.${btoa(JSON.stringify({ ...ent, tier: 'cloud_ai' })).replace(/=+$/, '')}.${s}`
    expect(await verifyToken(forged, { k1: pub }, now)).toMatchObject({ ok: false })
    expect(await verifyToken('nope', { k1: pub }, now)).toEqual({ ok: false, reason: 'malformed' })
  })
})
