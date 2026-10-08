import type { HighlightColor } from '@octavo/shared'

export type ThemeId = 'original' | 'quiet' | 'paper' | 'bold' | 'calm' | 'focus' | 'black'
export type Appearance = 'auto' | 'light' | 'dark'
export type PageEffect = 'slide' | 'none' | 'curl'
export type FontChoice = 'publisher' | 'obsidian' | 'serif' | 'sans' | 'charter' | 'georgia' | 'iowan' | 'palatino' | 'custom'
export type TapAction = 'prev' | 'next' | 'menu' | 'bookmark' | 'toc' | 'search' | 'none'
export type FooterStyle = 'chapter' | 'book' | 'time' | 'off'
export type PdfDark = 'invert-except-images' | 'sepia' | 'none'

export interface Typography {
  font: FontChoice
  fontSize: number // percent
  lineHeight: number
  letterSpacing: number // em
  wordSpacing: number // em
  margin: number // px, horizontal
  justify: boolean
  hyphenate: boolean
  bold: boolean
  maxColumns: number // 1 or 2 (width decides)
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  font: 'publisher', fontSize: 100, lineHeight: 1.5, letterSpacing: 0, wordSpacing: 0,
  margin: 48, justify: true, hyphenate: true, bold: false, maxColumns: 2,
}

export interface OctavoSettings {
  /** Mobile first-run guidance shown (see welcomeOnMobile). */
  mobileWelcomed?: boolean
  booksFolder: string
  coversFolder: string
  theme: ThemeId
  appearance: Appearance
  customize: boolean
  /** per-theme overrides of the theme's typography */
  overrides: Partial<Record<ThemeId, Partial<Typography>>>
  customFontPath: string
  pageEffect: PageEffect
  flow: 'paginated' | 'scrolled'
  footer: FooterStyle
  autoHideMs: number
  nightLight: boolean
  tapZones: TapAction[] // 3×3, row-major
  leftHanded: boolean
  defaultColor: HighlightColor
  autoPaste: boolean
  openPdfInOctavo: boolean
  pdfDark: PdfDark
  pdfCrop: boolean
  pdfMode: 'pages' | 'text'
  dailyNoteLog: boolean
  goals: { enabled: boolean; dailyMinutes: number; yearlyBooks: number; restDaysPerWeek: number }
  stats: { minutesByDay: Record<string, number>; finishedByYear: Record<string, number> }
  pace: unknown
  tts: { voice: string; rate: number; engine: 'system' | 'cloud'; cloudVoice: string }
  ai: { provider: 'none' | 'openai' | 'anthropic' | 'ollama'; apiKey: string; model: string; baseUrl: string }
  cloud: { apiBase: string; email: string; token: string }
  autoScrollSpeed: number
  library: {
    folders: string[] // empty = whole vault
    hidden: string[] // book paths hidden from the library
    minPdfMB: number // PDFs smaller than this are treated as documents unless they have a book note
    mode: 'grid' | 'list'
    size: number // card width px
    sort: 'recent' | 'title' | 'author' | 'progress' | 'added'
  }
}

export const DEFAULT_SETTINGS: OctavoSettings = {
  booksFolder: 'Books',
  coversFolder: 'Books/covers',
  theme: 'original',
  appearance: 'auto',
  customize: false,
  overrides: {},
  customFontPath: '',
  pageEffect: 'slide',
  flow: 'paginated',
  footer: 'chapter',
  autoHideMs: 2000,
  nightLight: false,
  tapZones: [
    'prev', 'menu', 'next',
    'prev', 'menu', 'next',
    'prev', 'menu', 'next',
  ],
  leftHanded: false,
  defaultColor: 'yellow',
  autoPaste: false,
  openPdfInOctavo: true,
  pdfDark: 'invert-except-images',
  pdfCrop: false,
  pdfMode: 'pages',
  dailyNoteLog: false,
  goals: { enabled: false, dailyMinutes: 15, yearlyBooks: 12, restDaysPerWeek: 1 },
  stats: { minutesByDay: {}, finishedByYear: {} },
  pace: null,
  tts: { voice: '', rate: 1, engine: 'system', cloudVoice: 'af_heart' },
  ai: { provider: 'none', apiKey: '', model: '', baseUrl: '' },
  cloud: { apiBase: 'https://octavo.devformat.tools', email: '', token: '' },
  autoScrollSpeed: 40,
  library: { folders: [], hidden: [], minPdfMB: 2, mode: 'grid', size: 150, sort: 'recent' },
}
