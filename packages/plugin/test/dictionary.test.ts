import { describe, expect, it } from 'vitest'
import { lookupForms, plainDefinition, wiktionaryDefinition } from '../src/reader/dictionary'

describe('Define without AI (Wiktionary)', () => {
  it('skips empty first definitions and language codes', () => {
    const book = { en: [
      { partOfSpeech: 'Noun', definitions: [{ definition: '' }, { definition: 'A collection of sheets of paper bound together.' }] },
      { partOfSpeech: 'Verb', definitions: [{ definition: '<span></span>' }, { definition: 'To reserve.' }] },
    ] }
    expect(wiktionaryDefinition(book)).toBe('*Noun* — A collection of sheets of paper bound together.\n\n*Verb* — To reserve.')
    const run = { en: [
      { partOfSpeech: 'Symbol', definitions: [{ definition: 'ISO 639-2 &amp;amp; ISO 639-3 language code for Kirundi.' }] },
      { partOfSpeech: 'Verb', definitions: [{ definition: 'To move swiftly.' }] },
    ] }
    expect(wiktionaryDefinition(run)).toBe('*Verb* — To move swiftly.')
    expect(wiktionaryDefinition({ en: [{ partOfSpeech: 'Noun', definitions: [{ definition: '' }] }] })).toBe('')
  })

  it('decodes entities, even doubly encoded ones', () => {
    expect(plainDefinition('Salt &amp;amp; pepper&nbsp;mix <i>(cooking)</i> &#8212; ok')).toBe('Salt & pepper mix (cooking) — ok')
  })

  it('looks a word up as written first, then in lower case, without punctuation', () => {
    expect(lookupForms('Monday,')).toEqual(['Monday', 'monday'])
    expect(lookupForms('“word.”')).toEqual(['word'])
  })
})
