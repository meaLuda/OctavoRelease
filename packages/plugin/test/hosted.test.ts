import { describe, expect, it } from 'vitest'
import { BYO_PROMPTS, cardLine, cardsFileHeader, cardsPath, hostedFooter, hostedRequest, newCardLines, parseCards } from '../src/ai/hosted'
import { usageLine, usageMeters } from '../src/cloud/account'

const body = (r: { body: string }) => JSON.parse(r.body)

describe('Octavo AI request shaping', () => {
  it('posts each feature to /v1/ai/:feature with the fallback choice', () => {
    const r = hostedRequest('explain', { text: 'ephemeral', context: 'An ephemeral joy.', bookTitle: 'Dune' }, true)
    expect(r).toMatchObject({ path: '/v1/ai/explain', method: 'POST' })
    expect(body(r)).toEqual({ text: 'ephemeral', context: 'An ephemeral joy.', bookTitle: 'Dune', allowFallback: true })
    expect(body(hostedRequest('summarise', { text: 'x' }, false))).toEqual({ text: 'x', allowFallback: false })
    expect(body(hostedRequest('chapter', { text: 'x', title: 'One' }, true))).toEqual({ text: 'x', title: 'One', allowFallback: true })
    expect(body(hostedRequest('ask', { question: 'Who?', passages: ['a', 'b'], position: 0.4, bookTitle: 'B' }, true)))
      .toEqual({ question: 'Who?', passages: ['a', 'b'], position: 0.4, bookTitle: 'B', allowFallback: true })
  })
  it('applies the server caps before sending (explain 4k incl. context, ask 16k, flashcards 8k)', () => {
    const e = body(hostedRequest('explain', { text: 'x'.repeat(3_000), context: 'y'.repeat(5_000) }, true))
    expect(e.text.length + e.context.length).toBe(4_000)
    const a = body(hostedRequest('ask', { question: 'q', passages: ['p'.repeat(10_000), 'p'.repeat(10_000), 'p'.repeat(10)] }, true))
    expect(a.passages.map((p: string) => p.length)).toEqual([10_000, 6_000])
    const f = body(hostedRequest('flashcards', { highlights: [{ text: 'h'.repeat(5_000), note: ' mine ' }, 'h'.repeat(5_000), ' '] }, true))
    expect(f.highlights).toEqual([{ text: 'h'.repeat(5_000), note: 'mine' }, { text: 'h'.repeat(3_000) }])
    expect(body(hostedRequest('summarise', { text: 's'.repeat(30_000) }, true)).text).toHaveLength(20_000)
  })
  it('footer shows credits left, cache and fallback use', () => {
    expect(hostedFooter({ provider: 'gemini', cached: false, creditsLeft: 1498 })).toBe('*Octavo AI · 1498 credits left this month*')
    expect(hostedFooter({ provider: 'deepseek', cached: true, creditsLeft: 1, truncated: true }))
      .toBe('*Octavo AI · 1 credit left this month · saved answer, no credits used · answered by the DeepSeek fallback · long text was shortened*')
  })
  it('own-key prompts keep the no-spoilers rule and the reader position', () => {
    expect(BYO_PROMPTS.ask({ question: 'Who dies?', passages: ['p'], position: 0.3, bookTitle: 'B' })).toMatch(/30% of the way through the book.*Never reveal or hint at events beyond/s)
    expect(BYO_PROMPTS.flashcards({ highlights: [{ text: 'H', note: 'n' }] })).toContain("1. H\n(Reader's note: n)")
  })
})

describe('flashcards', () => {
  it('parses and repairs model output', () => {
    expect(parseCards('```json\n{"cards":[{"q":"A?","a":"B"},]}\n```')).toEqual([{ q: 'A?', a: 'B' }])
    expect(parseCards('[{"q":"A?","a":"B"},{"q":"C?","a":"cut')).toEqual([{ q: 'A?', a: 'B' }])
    expect(parseCards('Q: One?\nA: Two')).toEqual([{ q: 'One?', a: 'Two' }])
    expect(parseCards('- X? :: Y')).toEqual([{ q: 'X?', a: 'Y' }])
  })
  it('writes Spaced Repetition lines into Books/<Title> cards.md, skipping questions already there', () => {
    expect(cardsPath('Books', 'Dune: Part 1?')).toBe('Books/Dune Part 1 cards.md')
    expect(cardsPath('', '')).toBe('Books/Book cards.md')
    expect(cardsFileHeader('Dune')).toBe('---\ntags:\n  - flashcards\n---\n# Dune cards\n\n')
    expect(cardLine({ q: 'What is\na::b?', a: 'It is  c' })).toBe('What is a:b?::It is c')
    const existing = `${cardsFileHeader('Dune')}Who is Paul?::A boy\n`
    expect(newCardLines([{ q: 'who is paul?', a: 'dup' }, { q: 'Where?', a: 'Arrakis' }, { q: 'Where?', a: 'again' }], existing)).toEqual(['Where?::Arrakis'])
  })
})

describe('AI credits meter', () => {
  it('shows AI credits only when the plan has them', () => {
    expect(usageMeters({ usage: { aiCredits: 300 }, quota: { ai: 1500 } }).map(m => [m.key, m.used, m.limit])).toEqual([['ai', '300', '1500']])
    expect(usageLine({ usage: { aiCredits: 3 }, quota: { ocr: 500, ai: 1500 } })).toBe('OCR 0/500 pages · AI 3/1500 credits')
    expect(usageMeters({ quota: { ai: 0 } })).toEqual([])
  })
})
