import { describe, expect, it } from 'vitest'
import { formatRectSubpath, parseSubpath, splitLinktext } from '../src/links'

describe('PDF++ region links', () => {
  // as written by PDF++ "Copy link to selected area" (embed): rect = left,bottom,right,top in PDF points
  const pdfpp = '![[Buy then build.pdf#page=14&rect=72,431,540,702|Buy then build, p.14]]'

  it('parses a real PDF++ rect embed', () => {
    const target = pdfpp.slice(3, pdfpp.indexOf('|'))
    const { path, subpath } = splitLinktext(target)
    expect(path).toBe('Buy then build.pdf')
    expect(parseSubpath(subpath)).toEqual({ type: 'rect', page: 14, rect: [72, 431, 540, 702], color: undefined })
  })

  it('formats exactly the PDF++ string and round-trips', () => {
    expect(formatRectSubpath(14, [72, 431, 540, 702])).toBe('#page=14&rect=72,431,540,702')
    expect(parseSubpath(formatRectSubpath(14, [72, 431, 540, 702]))).toMatchObject({ type: 'rect', page: 14, rect: [72, 431, 540, 702] })
  })

  it('normalises corner order and rounds to whole points', () => {
    expect(formatRectSubpath(2, [540.4, 702.6, 71.6, 430.5], 'yellow')).toBe('#page=2&rect=72,431,540,703&color=yellow')
  })

  it('splits a linktext without a subpath', () => {
    expect(splitLinktext('Folder/Book.pdf')).toEqual({ path: 'Folder/Book.pdf', subpath: '' })
  })
})
