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
/** Longest line: about 55, 66 or 80 characters, or the whole width. */
export type RulerStyle = 'lightbox' | 'shade' | 'bar' | 'underline'
export type LineWidth = 'narrow' | 'medium' | 'wide' | 'full'

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
  /** One-time repair of duplicate book notes (same octavo-id or book) has run. */
  duplicatesRepaired?: boolean
  /** Mobile first-run guidance shown (see welcomeOnMobile). */
  mobileWelcomed?: boolean
  booksFolder: string
  coversFolder: string
  theme: ThemeId
  appearance: Appearance
  customize: boolean
  /** per-theme overrides of the theme's typography (text size is not one: it stays when the theme changes) */
  overrides: Partial<Record<ThemeId, Partial<Typography>>>
  /** text size in percent, for every theme */
  textSize: number
  /** themes chosen inside a book, by book id; other books use `theme` */
  bookThemes: Record<string, ThemeId>
  /** text sizes kept for one book only, by book id; other books use `textSize` */
  bookTextSizes: Record<string, number>
  lineWidth: LineWidth
  /** Black layer over the page, 0 (off) to 0.7: dimmer than the screen's lowest brightness. */
  dim: number
  /** Text strength in dark themes, 60 to 100 (%): lower is softer, less glow for astigmatism. */
  darkContrast: number
  /** Keep the screen on while a book is open and being read (released after 10 idle minutes). */
  keepAwake: boolean
  /** A band that marks the line being read. */
  ruler: boolean
  /** Ruler look (CHI 2023 reading-ruler study): Lightbox dims all but the line; Shade dims what you have read; Bar tints the line; Underline. */
  rulerStyle: RulerStyle
  /** Lines inside the ruler: one, or three with the current one in the middle. */
  rulerLines: 1 | 3
  /** How dark the shading (or the bar tint) is, 0.1–0.6. */
  rulerDarkness: number
  /** EPUB footnotes and endnotes open in a pop-up instead of jumping away. */
  footnotePopups: boolean
  /** Phones and tablets: double-tap a word to define it. */
  doubleTapDefine: boolean
  /** Translate selection into this language; empty = the device language. */
  translateTo: string
  /** Offer a "Story so far" recap when a book is reopened after this many days; 0 = never. */
  recapAfterDays: number
  /** A few highlights from your books in the daily note once a day. `shown`: highlight id → day last shown. */
  dailyHighlights: { enabled: boolean; count: number; lastDay?: string; shown: Record<string, string> }
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
  /** minutesByBook: by book id (octavo-id), from 1.1.1 on */
  stats: { minutesByDay: Record<string, number>; finishedByYear: Record<string, number>; minutesByBook: Record<string, number> }
  pace: unknown
  tts: { voice: string; rate: number; engine: 'system' | 'cloud'; cloudVoice: string }
  /**
   * provider 'octavo' = Octavo AI (Cloud + AI, no key). allowFallback lets Octavo AI use DeepSeek when Gemini is down.
   * octavoDefaulted: Octavo AI was made the default once for a Cloud + AI account (a later choice is kept).
   */
  /** apiKey, model and baseUrl belong to the current provider; `saved` keeps each other provider's own, so a key never goes to a different provider. */
  ai: { provider: 'none' | 'octavo' | 'openai' | 'anthropic' | 'ollama'; apiKey: string; model: string; baseUrl: string; allowFallback: boolean; octavoDefaulted?: boolean; saved?: Partial<Record<'openai' | 'anthropic' | 'ollama', { apiKey: string; model: string; baseUrl: string }>> }
  /** labels: last collections/tags sent to the Cloud per cloud book id (so only real changes are synced).
   *  ocrPending: cloud book ids sent for OCR whose searchable copy has not been fetched yet (the device copy is the old scan). */
  cloud: { apiBase: string; email: string; token: string; labels?: Record<string, string>; ocrPending?: string[] }
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
    /** "Where are your books?" was shown once (first library open); never asked again. */
    foldersAsked?: boolean
    hidden: string[] // book paths hidden from the library
    minPdfMB: number // PDFs smaller than this are treated as documents unless they have a book note
    mode: 'grid' | 'list'
    size: number // card width px
    sort: 'recent' | 'title' | 'author' | 'progress' | 'added'
    /** Saved filters shown as chips. */
    smart: SmartCollection[]
    /** Continue reading cards dismissed with ×: book path → lastRead at dismissal (reading again brings it back) */
    continueDismissed?: Record<string, number>
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
  textSize: 100,
  bookThemes: {},
  bookTextSizes: {},
  lineWidth: 'medium',
  dim: 0,
  darkContrast: 100,
  keepAwake: true,
  ruler: false,
  rulerStyle: 'lightbox',
  rulerLines: 1,
  rulerDarkness: 0.25,
  footnotePopups: true,
  doubleTapDefine: true,
  translateTo: '',
  recapAfterDays: 3,
  dailyHighlights: { enabled: false, count: 3, shown: {} },
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
  stats: { minutesByDay: {}, finishedByYear: {}, minutesByBook: {} },
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

/**
 * Settings saved by another device (Obsidian Sync) meet this device's copy: their choices win, but reading stats are
 * merged per key (the larger count), so neither device's minutes or finished books are lost to the other's last save.
 */
export function mergeSyncedStats(mine: OctavoSettings['stats'], theirs: Partial<OctavoSettings['stats']> | undefined): OctavoSettings['stats'] {
  const max = (a: Record<string, number> = {}, b: Record<string, number> = {}) => {
    const out: Record<string, number> = { ...a }
    for (const [k, v] of Object.entries(b)) if (Number.isFinite(v) && !(Number(out[k]) >= v)) out[k] = v
    return out
  }
  return {
    minutesByDay: max(mine.minutesByDay, theirs?.minutesByDay),
    finishedByYear: max(mine.finishedByYear, theirs?.finishedByYear),
    minutesByBook: max(mine.minutesByBook, theirs?.minutesByBook),
  }
}
