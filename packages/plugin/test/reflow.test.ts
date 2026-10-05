import { describe, expect, it } from 'vitest'
import { reflow, type RawItem } from '../src/pdf/reflow'

// helper: one text item per line, PDF coordinates (y grows upward)
const line = (str: string, y: number, x = 72, size = 10, width = str.length * size * 0.5): RawItem =>
  ({ str, transform: [size, 0, 0, size, x, y], width, hasEOL: true })

describe('reflow', () => {
  it('joins lines into paragraphs, splits on bigger gaps, rejoins hyphenation', () => {
    const blocks = reflow([
      line('Chapter One', 740, 72, 18),
      line('The first paragraph starts here and it con-', 700),
      line('tinues on the next line of the page.', 688),
      line('A second paragraph after a gap.', 660),
      line('12', 40),
    ])
    expect(blocks.map(({ type, text, size }) => ({ type, text, size }))).toEqual([
      { type: 'h', text: 'Chapter One', size: 18 },
      { type: 'p', text: 'The first paragraph starts here and it continues on the next line of the page.', size: 10 },
      { type: 'p', text: 'A second paragraph after a gap.', size: 10 },
    ])
  })
  it('starts a paragraph on an indented line after a short sentence-ending line', () => {
    const blocks = reflow([
      line('A long line that fills the measure of the column nicely ok.', 700, 72, 10, 300),
      line('Short end.', 688, 72, 10, 50),
      line('Indented new paragraph begins here and runs on and on.', 676, 90, 10, 282),
      line('and keeps going to the right edge of the column again ok', 664, 72, 10, 300),
    ])
    expect(blocks.map(b => b.text)).toEqual([
      'A long line that fills the measure of the column nicely ok. Short end.',
      'Indented new paragraph begins here and runs on and on. and keeps going to the right edge of the column again ok',
    ])
  })
  it('merges items on the same line with sensible spacing', () => {
    const items: RawItem[] = [
      { str: 'Hello', transform: [10, 0, 0, 10, 72, 700], width: 25 },
      { str: 'world', transform: [10, 0, 0, 10, 100, 700], width: 25, hasEOL: true },
    ]
    expect(reflow(items).map(({ type, text, size }) => ({ type, text, size }))).toEqual([{ type: 'p', text: 'Hello world', size: 10 }])
  })
})

describe('reflow headings without size change', () => {
  const L = (str: string, y: number, x: number, w: number, font = 'Body') => ({ str, transform: [10, 0, 0, 10, x, y], width: w, hasEOL: true, fontName: font })
  it('detects short lines in a different (bold/italic) font as headings', () => {
    const blocks = reflow([
      L('Body text line that fills the column width nicely here.', 700, 72, 400),
      L('Squaring', 680, 240, 60, 'BoldItalic'),
      L('Lines at right angles are marked with the try-square.', 668, 72, 400),
    ])
    expect(blocks.map(b => [b.type, b.text])).toEqual([
      ['p', 'Body text line that fills the column width nicely here.'],
      ['h', 'Squaring'],
      ['p', 'Lines at right angles are marked with the try-square.'],
    ])
  })
  it('does not treat numbered list items as headings', () => {
    const blocks = reflow([L('Intro sentence that fills the column width nicely ok.', 700, 72, 400), L('1. Make a true face.', 680, 72, 120, 'Other')])
    expect(blocks.every(b => b.type === 'p')).toBe(true)
  })
})

import { figureBands, continues } from '../src/pdf/reflow'
describe('figure bands and page-break joins', () => {
  it('finds tall text-free bands between and around blocks', () => {
    const bands = figureBands([{ type: 'p', text: 'a', size: 10, top: 700, bottom: 650 }, { type: 'p', text: 'b', size: 10, top: 400, bottom: 360 }], 792, 40)
    expect(bands).toEqual([{ top: 792, bottom: 700 }, { top: 648, bottom: 400 }, { top: 358, bottom: 0 }])
  })
  it('detects paragraphs cut by a page break', () => {
    expect(continues('In the middle of the stroke the down', 'pressure is equal by both hands.')).toBe(true)
    expect(continues('The end of a sentence.', 'next paragraph starts')).toBe(false)
    expect(continues('A clause', 'Capitalised start')).toBe(false)
  })
})

describe('drop caps', () => {
  it('does not turn a drop-cap first line into a heading', () => {
    const blocks = reflow([
      { str: 'O', transform: [36, 0, 0, 36, 72, 700], width: 24 },
      { str: 'ne cannot overemphasize the importance of good plane management here.', transform: [10, 0, 0, 10, 100, 700], width: 330, hasEOL: true },
      { str: 'It was the plane which made possible the development of joinery.', transform: [10, 0, 0, 10, 72, 688], width: 330, hasEOL: true },
    ])
    expect(blocks.every(b => b.type === 'p')).toBe(true)
  })
})
