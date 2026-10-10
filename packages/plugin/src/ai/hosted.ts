/**
 * Octavo AI (hosted, Cloud + AI) request shaping, the prompts used with your own key for the same features,
 * flashcard parsing and the Spaced Repetition cards writer. Pure: no Obsidian imports, unit-tested.
 */

export type AiFeature = 'explain' | 'summarise' | 'chapter' | 'ask' | 'flashcards'
export interface Card { q: string; a: string }

export interface ExplainInput { text: string; context?: string; bookTitle?: string }
export interface SummariseInput { text: string }
export interface ChapterInput { text: string; title?: string }
export interface AskInput { question: string; passages: string[]; position?: number | string; bookTitle?: string }
export interface FlashcardsInput { highlights: Array<string | { text: string; note?: string }>; bookTitle?: string }
export type AiInput = ExplainInput | SummariseInput | ChapterInput | AskInput | FlashcardsInput

/** Server reply for POST /v1/ai/:feature. */
export interface HostedReply { text?: string; cards?: Card[]; provider: string; cached: boolean; creditsLeft: number; truncated?: boolean }

/** Input caps (characters), matching the server's, so we never send more than it will read. */
export const INPUT_CAPS: Record<AiFeature, number> = { explain: 4_000, summarise: 20_000, chapter: 120_000, ask: 16_000, flashcards: 8_000 }

/** The request for Octavo AI. `allowFallback: false` keeps DeepSeek (servers in China) out of the route entirely. */
export function hostedRequest(feature: AiFeature, input: AiInput, allowFallback: boolean): { path: string; method: 'POST'; body: string } {
  const cap = INPUT_CAPS[feature]
  const clip = (s: string | undefined, n = cap) => (s ?? '').slice(0, n)
  let body: Record<string, unknown>
  switch (feature) {
    case 'explain': { const i = input as ExplainInput; const text = clip(i.text); body = { text, context: clip(i.context, Math.max(0, cap - text.length)), bookTitle: i.bookTitle }; break }
    case 'summarise': body = { text: clip((input as SummariseInput).text) }; break
    case 'chapter': { const i = input as ChapterInput; body = { text: clip(i.text), title: i.title }; break }
    case 'ask': { const i = input as AskInput; body = { question: clip(i.question, 1_000), passages: budget(i.passages, cap), position: i.position, bookTitle: i.bookTitle }; break }
    case 'flashcards': { const i = input as FlashcardsInput; body = { highlights: budgetHighlights(i.highlights, cap), bookTitle: i.bookTitle }; break }
  }
  return { path: `/v1/ai/${feature}`, method: 'POST', body: JSON.stringify({ ...body, allowFallback }) }
}

function budget(list: string[], cap: number): string[] {
  const out: string[] = []
  let left = cap
  for (const s of list) { if (left <= 0 || !s) continue; const t = s.slice(0, left); out.push(t); left -= t.length }
  return out
}
function budgetHighlights(list: FlashcardsInput['highlights'], cap: number): Array<{ text: string; note?: string }> {
  const out: Array<{ text: string; note?: string }> = []
  let left = cap
  for (const h of list.slice(0, 60)) {
    const text = (typeof h === 'string' ? h : h.text).trim(), note = typeof h === 'string' ? undefined : h.note?.trim() || undefined
    if (!text || left <= 0) continue
    const t = text.slice(0, left)
    out.push(note ? { text: t, note: note.slice(0, 300) } : { text: t })
    left -= t.length
  }
  return out
}

/** One line under a hosted answer: credits left, and when the fallback or the cache answered. */
export function hostedFooter(r: Pick<HostedReply, 'provider' | 'cached' | 'creditsLeft' | 'truncated'>): string {
  const parts = [`Octavo AI · ${r.creditsLeft} credit${r.creditsLeft === 1 ? '' : 's'} left this month`]
  if (r.cached) parts.push('saved answer, no credits used')
  if (r.provider?.includes('deepseek')) parts.push('answered by the DeepSeek fallback')
  if (r.truncated) parts.push('long text was shortened')
  return `*${parts.join(' · ')}*`
}

// ───────────── prompts for your own key (same features, one user message) ─────────────

const pct = (p: number | string | undefined) => (typeof p === 'number' ? `${Math.round(p * 100)}% of the way through the book` : p || 'partway through the book')

export const BYO_PROMPTS = {
  summarise: (text: string) =>
    `Summarise the text below in a few short bullet points, at most 150 words. Keep names and key terms. No preamble.\n\nText:\n"""${text.slice(0, INPUT_CAPS.summarise)}"""`,
  chapter: (title: string, text: string) =>
    `Summarise this chapter${title ? ` ("${title}")` : ''}: a two-sentence overview, then 4 to 8 bullet points with the key events, arguments, names and terms. At most 300 words. No preamble.\n\nChapter text:\n"""${text.slice(0, 60_000)}"""`,
  ask: (i: AskInput) =>
    `You are a reading companion for the book "${i.bookTitle ?? ''}". The reader is ${pct(i.position)}. Answer the question using only the passages below, in at most 150 words. Never reveal or hint at events beyond the reader's position (no spoilers). If the passages don't contain the answer, say so.\n\n` +
    `${budget(i.passages, INPUT_CAPS.ask).map((p, n) => `Passage ${n + 1}:\n"""${p}"""`).join('\n\n')}\n\nQuestion: ${i.question}`,
  flashcards: (i: FlashcardsInput) =>
    `Make study flashcards from these highlights${i.bookTitle ? ` from "${i.bookTitle}"` : ''}. Return JSON only, in this shape: {"cards":[{"q":"question","a":"answer"}]}. One to three cards per highlight, at most 40 cards; answers under 25 words.\n\n` +
    budgetHighlights(i.highlights, INPUT_CAPS.flashcards).map((h, n) => `${n + 1}. ${h.text}${h.note ? `\n(Reader's note: ${h.note})` : ''}`).join('\n\n'),
}

// ───────────── flashcards ─────────────

/** Parses cards from a model answer: JSON (fenced, wrapped, trailing commas, cut off) or `q::a` / `Q: A:` lines. */
export function parseCards(raw: string): Card[] {
  const text = raw.replace(/```(?:json)?/gi, '').trim()
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) } catch { return undefined } } }
  const fromValue = (v: any): Card[] | null => {
    const list = Array.isArray(v) ? v : Array.isArray(v?.cards) ? v.cards : null
    return list ? cleanCards(list.map((c: any) => ({ q: c?.q ?? c?.question, a: c?.a ?? c?.answer }))) : null
  }
  const start = text.search(/[[{]/)
  if (start >= 0) {
    const body = text.slice(start)
    const whole = fromValue(tryParse(body)) ?? fromValue(tryParse(body.slice(0, Math.max(body.lastIndexOf(']'), body.lastIndexOf('}')) + 1)))
    if (whole?.length) return whole
    const arr = body.indexOf('['), lastObj = body.lastIndexOf('}')
    if (arr >= 0 && lastObj > arr) { const r = fromValue(tryParse(`${body.slice(arr, lastObj + 1)}]`)); if (r?.length) return r }
  }
  const out: Array<{ q: string; a: string }> = []
  let q = ''
  for (const line of text.split('\n')) {
    const qa = /^\s*(?:[-*\d.)]+\s*)?(.+?)\s*::\s*(.+)$/.exec(line)
    if (qa) { out.push({ q: qa[1]!, a: qa[2]! }); continue }
    const qm = /^\s*(?:[-*\d.)]+\s*)?(?:Q|Question)\s*[:.]\s*(.+)$/i.exec(line), am = /^\s*(?:A|Answer)\s*[:.]\s*(.+)$/i.exec(line)
    if (qm) q = qm[1]!
    else if (am && q) { out.push({ q, a: am[1]! }); q = '' }
  }
  return cleanCards(out)
}

function cleanCards(list: Array<{ q: unknown; a: unknown }>): Card[] {
  const seen = new Set<string>(), out: Card[] = []
  for (const c of list) {
    const q = typeof c.q === 'string' ? c.q.replace(/\s+/g, ' ').trim() : '', a = typeof c.a === 'string' ? c.a.replace(/\s+/g, ' ').trim() : ''
    if (!q || !a || seen.has(q.toLowerCase())) continue
    seen.add(q.toLowerCase())
    out.push({ q, a })
  }
  return out.slice(0, 40)
}

/** `Books/<Title> cards.md`, with characters Obsidian rejects in file names removed. */
export function cardsPath(booksFolder: string, title: string): string {
  const safe = title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Book'
  return `${(booksFolder || 'Books').replace(/\/+$/, '')}/${safe} cards.md`
}

/** A new cards file: tagged for the Spaced Repetition plugin, like Vocabulary.md. */
export const cardsFileHeader = (title: string) => `---\ntags:\n  - flashcards\n---\n# ${title} cards\n\n`

/** One Spaced Repetition single-line card. `::` inside a side would split the card, so it becomes `:`. */
export const cardLine = (c: Card) => `${c.q.replace(/\s+/g, ' ').replace(/::+/g, ':').trim()}::${c.a.replace(/\s+/g, ' ').replace(/::+/g, ':').trim()}`

/** Lines to append for cards whose question isn't already in the file. */
export function newCardLines(cards: Card[], existing: string): string[] {
  const have = new Set(existing.split('\n').map(l => l.split('::')[0]!.trim().toLowerCase()).filter(Boolean))
  const out: string[] = []
  for (const c of cards) {
    const line = cardLine(c)
    const q = line.split('::')[0]!.toLowerCase()
    if (have.has(q)) continue
    have.add(q)
    out.push(line)
  }
  return out
}
