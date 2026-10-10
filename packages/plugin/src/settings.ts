import { DEFAULT_COPY_TEMPLATES, DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE, DEFAULT_EXPORT_NOTE_TEMPLATE, type CopyFormat, type HighlightColor } from '@octavo/shared'
import type { PdfBookLayout } from './pdf/layout'
import type { SmartCollection } from './library/organise'

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
  /** Per-book PDF fit/crop/scroll/direction/zoom, keyed `phone:<book id>` / `wide:<book id>`. In plugin data, not the note. */
  pdfLayouts: Record<string, PdfBookLayout>
  /** 2 = book-style paging default, 3 = Width fit default (older saved layouts upgraded once each) */
  pdfLayoutVersion?: number
  dailyNoteLog: boolean
  goals: { enabled: boolean; dailyMinutes: number; yearlyBooks: number; restDaysPerWeek: number }
  stats: { minutesByDay: Record<string, number>; finishedByYear: Record<string, number> }
  pace: unknown
  tts: { voice: string; rate: number; engine: 'system' | 'cloud'; cloudVoice: string }
  /**
   * provider 'octavo' = Octavo AI (Cloud + AI, no key). allowFallback lets Octavo AI use DeepSeek when Gemini is down.
   * octavoDefaulted: Octavo AI was made the default once for a Cloud + AI account (a later choice is kept).
   */
  ai: { provider: 'none' | 'octavo' | 'openai' | 'anthropic' | 'ollama'; apiKey: string; model: string; baseUrl: string; allowFallback: boolean; octavoDefaulted?: boolean }
  /** labels: last collections/tags sent to the Cloud per cloud book id (so only real changes are synced). */
  cloud: { apiBase: string; email: string; token: string; labels?: Record<string, string> }
  autoScrollSpeed: number
  /** PDF: a drag or trackpad scroll on a page wider than the view keeps to its first direction. */
  pdfScrollLock: boolean
  /** Small, dismissible Octavo Cloud hints in the reader (big book, scanned PDF, read-aloud). */
  cloudPrompts: boolean
  /** Hints already shown, as `kind:<book id>` (each shows at most once per book). */
  promptsSeen: string[]
  /** "Copy as…" templates ({{text}} {{page}} {{label}} {{link}} {{color}} {{book}} {{author}} {{note}} {{date}} {{citekey}}). */
  copyTemplates: Record<CopyFormat, string>
  /** "Export highlights to note": folder, note template (rendered once) and per-highlight template. */
  exportFolder: string
  exportNoteTemplate: string
  exportHighlightTemplate: string
  library: {
    folders: string[] // empty = whole vault
    hidden: string[] // book paths hidden from the library
    minPdfMB: number // PDFs smaller than this are treated as documents unless they have a book note
    mode: 'grid' | 'list'
    size: number // card width px
    sort: 'recent' | 'title' | 'author' | 'progress' | 'added'
    /** Saved filters shown as chips. */
    smart: SmartCollection[]
    /** Books dropped into the scanned folders appear without reopening the library. */
    watch: boolean
    /** Where downloaded Cloud books are placed. */
    cloudFolder: string
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
  pdfLayouts: {},
  dailyNoteLog: false,
  goals: { enabled: false, dailyMinutes: 15, yearlyBooks: 12, restDaysPerWeek: 1 },
  stats: { minutesByDay: {}, finishedByYear: {} },
  pace: null,
  tts: { voice: '', rate: 1, engine: 'system', cloudVoice: 'af_heart' },
  ai: { provider: 'none', apiKey: '', model: '', baseUrl: '', allowFallback: true },
  cloud: { apiBase: 'https://octavo.devformat.tools', email: '', token: '' },
  autoScrollSpeed: 40,
  pdfScrollLock: true,
  cloudPrompts: true,
  promptsSeen: [],
  copyTemplates: { ...DEFAULT_COPY_TEMPLATES },
  exportFolder: 'Books',
  exportNoteTemplate: DEFAULT_EXPORT_NOTE_TEMPLATE,
  exportHighlightTemplate: DEFAULT_EXPORT_HIGHLIGHT_TEMPLATE,
  library: { folders: [], hidden: [], minPdfMB: 2, mode: 'grid', size: 150, sort: 'recent', smart: [], watch: true, cloudFolder: 'Library' },
}
