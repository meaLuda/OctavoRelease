import { describe, expect, it } from 'vitest'
import { forBook, resolveLook, themeTypography } from '../src/reader/appearance'
import { DEFAULT_SETTINGS, type OctavoSettings } from '../src/settings'

const settings = (p: Partial<OctavoSettings> = {}): OctavoSettings => ({ ...DEFAULT_SETTINGS, overrides: {}, bookThemes: {}, ...p })

describe('text size', () => {
  it('is the same in every theme', () => {
    const s = settings({ textSize: 180, theme: 'focus' })
    const sizes = (['original', 'quiet', 'paper', 'bold', 'calm', 'focus', 'black'] as const).map(theme => themeTypography({ ...s, theme }).fontSize)
    expect(new Set(sizes)).toEqual(new Set([180]))
  })
})

describe('theme per book', () => {
  it('a theme picked in a book stays with that book; other books keep the default', () => {
    const s = settings({ theme: 'focus' })
    const a = forBook(s, 'book-a'), b = forBook(s, 'book-b')
    a.theme = 'calm'
    expect(a.theme).toBe('calm')
    expect(b.theme).toBe('focus')
    expect(s.theme).toBe('focus')
    expect(s.bookThemes).toEqual({ 'book-a': 'calm' })
    expect(resolveLook(a, true).colors.bg).not.toBe(resolveLook(b, true).colors.bg)
  })

  it('other settings written through a book go to the shared settings', () => {
    const s = settings()
    const a = forBook(s, 'book-a')
    a.textSize = 140
    expect(s.textSize).toBe(140)
  })

  it('without a book id the default theme is used and changed', () => {
    const s = settings({ theme: 'paper' })
    forBook(s, '').theme = 'bold'
    expect(s.theme).toBe('bold')
  })
})
