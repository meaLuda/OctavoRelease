import { describe, expect, it } from 'vitest'
import { parseTags, normalizeTag, tagSuggestions, applySuggestion, collectTags, filterByTags } from '../src/reader/tags'

describe('tag parsing', () => {
  it('splits on commas and spaces, strips #, dedupes case-insensitively', () => {
    expect(parseTags('#idea, to-read  ch/3,Idea,,')).toEqual(['idea', 'to-read', 'ch/3'])
  })
  it('normalises characters Obsidian rejects and drops numeric-only tags', () => {
    expect(normalizeTag('what?!now')).toBe('what-now')
    expect(normalizeTag('2024')).toBeNull()
    expect(normalizeTag('#café')).toBe('café')
    expect(normalizeTag('##')).toBeNull()
  })
})

describe('tag autocomplete', () => {
  const known = ['#idea', '#ideas/big', '#review', '#to-read', '#Physics']
  it('suggests prefix matches first, then substring matches', () => {
    expect(tagSuggestions('id', known)).toEqual(['idea', 'ideas/big'])
    expect(tagSuggestions('re', known)).toEqual(['review', 'to-read'])
  })
  it('works on the last token and skips tags already entered', () => {
    expect(tagSuggestions('idea, ', known)).not.toContain('idea')
    expect(tagSuggestions('review phy', known)).toEqual(['Physics'])
  })
  it('replaces the token being typed', () => {
    expect(applySuggestion('review, phy', 'Physics')).toBe('review, Physics, ')
  })
})

describe('tag filter', () => {
  const hs = [{ id: 1, tags: ['idea', 'ch1'] }, { id: 2, tags: ['Idea'] }, { id: 3 }]
  it('collects tags with counts, most used first', () => {
    expect(collectTags(hs)).toEqual([{ tag: 'idea', count: 2 }, { tag: 'ch1', count: 1 }])
  })
  it('keeps highlights with every selected tag', () => {
    expect(filterByTags(hs, []).map(h => h.id)).toEqual([1, 2, 3])
    expect(filterByTags(hs, ['idea']).map(h => h.id)).toEqual([1, 2])
    expect(filterByTags(hs, ['idea', 'ch1']).map(h => h.id)).toEqual([1])
  })
})
