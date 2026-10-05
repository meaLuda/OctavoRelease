import { describe, expect, it } from 'vitest'
import { cleanBookName, normalizeAuthors, personName, tidyTitle } from '../src'

describe('cleanBookName', () => {
  it.each([
    ['Patterns of Distributed Systems -- Unmesh Josh.epub', 'Patterns of Distributed Systems', 'Unmesh Josh'],
    ['The Essential Woodworker_ Skills, Tools, And Methods -- Robert Wearing -- revised edition with more than 500 illustrations, Covington, -- Lost Art -- isbn13 9780578060446 -- dd36fa3449bbe7da61ac32f9e62ce132 -- Anna’s Archive.pdf', 'The Essential Woodworker: Skills, Tools, And Methods', 'Robert Wearing'],
    ['Taiichi Ohno, Norman Bodek - Toyota Production System_ Beyond Large-Scale Production (1988, Productivity Press) - libgen.li.epub', 'Toyota Production System: Beyond Large-Scale Production', 'Taiichi Ohno, Norman Bodek'],
    ['The Great Game of Business, Jack Stack & Bo Burlingham.epub', 'The Great Game of Business', 'Jack Stack & Bo Burlingham'],
    ['Buy then build _ Walker Deibel.pdf', 'Buy then build', 'Walker Deibel'],
    ['A Philosophy of Software Design, 2nd Edition_JohnK_ Ousterhout.epub', 'A Philosophy of Software Design, 2nd Edition JohnK: Ousterhout', undefined],
    ['Designing Data-Intensive Applications.epub', 'Designing Data-Intensive Applications', undefined],
  ])('%s', (input, title, author) => {
    const r = cleanBookName(input)
    expect(r.title).toBe(title)
    expect(r.author).toBe(author)
  })
})

import { isJunkTitle } from '../src'
describe('isJunkTitle', () => {
  it('flags tool/file names, keeps real titles', () => {
    for (const j of ['document1', 'PDF77.tmp', 'Microsoft Word - draft.doc', 'untitled', 'x', '3f2a9c0e1b2d4e5f6a7b']) expect(isJunkTitle(j)).toBe(true)
    for (const ok of ['Building with Bamboo', 'Buy Then Build: How Acquisition Entrepreneurs Outsmart the Startup Game']) expect(isJunkTitle(ok)).toBe(false)
  })
})

import { normalizeAuthors } from '../src'
describe('normalizeAuthors', () => {
  it('splits, trims and dedupes', () => {
    expect(normalizeAuthors('Taiichi Ohno;Norman Bodek;Norman Bodek')).toBe('Taiichi Ohno, Norman Bodek')
    expect(normalizeAuthors(['A', 'a', 'B;'])).toBe('A, B')
    expect(normalizeAuthors('')).toBeUndefined()
  })
})

describe('catalogue metadata', () => {
  it('turns catalogue names into people', () => {
    expect(personName('Strunk, William, 1869-1946')).toBe('William Strunk')
    expect(personName('Austen, Jane, 1775-1817.')).toBe('Jane Austen')
    expect(personName('Jane Austen')).toBe('Jane Austen')
    expect(personName('King, Martin Luther, Jr.')).toBe('King, Martin Luther, Jr.')
    expect(personName('Tolkien, J. R. R.')).toBe('J. R. R. Tolkien')
    expect(normalizeAuthors('Strunk, William, 1869-1946; White, E. B.')).toBe('William Strunk, E. B. White')
  })
  it('title-cases sentence-case titles only', () => {
    expect(tidyTitle('The elements of style')).toBe('The Elements of Style')
    expect(tidyTitle('A Philosophy of Software Design')).toBe('A Philosophy of Software Design')
    expect(tidyTitle('iOS programming')).toBe('iOS programming')
    expect(tidyTitle('Dune')).toBe('Dune')
  })
})
