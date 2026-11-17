import { DEFAULT_TYPOGRAPHY, type OctavoSettings, type ThemeId, type Typography, type FontChoice, type LineWidth, type RulerStyle } from '../settings'
import { THEMES, type ResolvedLook, nightLightFactor } from './themes'
import { el } from './ui'
import type { ResolvedLayout } from '../pdf/layout'

/** The open PDF's per-book layout (fit / crop / scroll / zoom). */
export interface PdfLayoutControl { get(): ResolvedLayout; set(patch: Partial<ResolvedLayout>): void }

export function resolveLook(s: OctavoSettings, obsidianDark: boolean): ResolvedLook {
  const preset = THEMES[s.theme] ?? THEMES.original
  const dark = s.theme === 'black' || (s.appearance === 'auto' ? obsidianDark : s.appearance === 'dark')
  const typo = themeTypography(s)
  let colors = { ...(dark ? preset.dark : preset.light) }
  // dark themes: softer text on request (bright text on a dark page glows, worst with astigmatism)
  if (dark && s.darkContrast < 100) colors = { ...colors, fg: mix(colors.fg, colors.bg, Math.max(60, s.darkContrast) / 100) }
  if (s.nightLight) {
    const k = nightLightFactor()
    // warm the theme's own colour (less blue, a little less green) so themes stay distinct at night;
    // in dark themes the text is what gives light, so it is warmed there
    if (k > 0) colors = dark ? { ...colors, fg: warm(colors.fg, k * 1.6) } : { ...colors, bg: warm(colors.bg, k) }
  }
  return { colors, typo, dark }
}

/** `a` blended towards `b`: k = 1 keeps `a`, k = 0 gives `b`. */
export function mix(a: string, b: string, k: number): string {
  const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round(v * k + y[i] * (1 - k)).toString(16).padStart(2, '0')).join('')
}

/** What each ruler style does (shown under the style picker). */
const RULER_NOTES: Record<RulerStyle, string> = {
  lightbox: 'Clears the line you are on and dims the rest of the page.',
  shade: 'Dims only what you have already read, above the line.',
  bar: 'Tints the line you are on and leaves the page as it is.',
  underline: 'Draws a line under the one you are on.',
}

/** Characters per line for each line width; `full` uses the whole page. */
export const LINE_CHARS: Record<LineWidth, number> = { narrow: 55, medium: 66, wide: 80, full: 0 }

/** The page's longest line in px for foliate's max-inline-size: about LINE_CHARS characters at this text size. */
export function lineWidthPx(width: LineWidth, fontSize: number): number {
  const chars = LINE_CHARS[width] ?? LINE_CHARS.medium
  // a book face averages about half an em per character, spaces included; the page base is 16px
  return chars ? Math.round(chars * 0.5 * 16 * (fontSize / 100)) : 4000
}

/** The theme's typography; its overrides only while "Customize" is on (Apple Books behaviour). Text size is the same in every theme. */
export function themeTypography(s: OctavoSettings): Typography {
  const preset = THEMES[s.theme] ?? THEMES.original
  const o = s.overrides[s.theme] ?? {}
  return { ...DEFAULT_TYPOGRAPHY, ...preset.typography, ...(s.customize ? o : {}), fontSize: s.textSize || 100 }
}

/**
 * The settings as one book sees them: its own theme once a theme was chosen inside it, else the default theme.
 * Choosing a theme in a book's Appearance panel is remembered for that book only.
 */
export function forBook(s: OctavoSettings, bookId: string): OctavoSettings {
  if (!bookId) return s
  return new Proxy(s, {
    get: (t, k): unknown => {
      if (k === 'theme') return t.bookThemes[bookId] ?? t.theme
      // a text size kept for this book only (see "This book only" in Appearance)
      if (k === 'textSize') return t.bookTextSizes[bookId] ?? t.textSize
      return Reflect.get(t, k)
    },
    set: (t, k, v) => {
      if (k === 'theme') t.bookThemes[bookId] = v as ThemeId
      else if (k === 'textSize' && bookId in t.bookTextSizes) t.bookTextSizes[bookId] = v as number
      else Reflect.set(t, k, v)
      return true
    },
  })
}

/** Night-light warmth: scale blue down by up to 18% and green by up to 5%, keeping each theme's character. */
export function warm(hex: string, k: number): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const out = [r, g * (1 - 0.05 * k), b * (1 - 0.18 * k)]
  return '#' + out.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}


const FONT_LABELS: Array<[FontChoice, string]> = [
  ['publisher', 'Original'], ['obsidian', 'Obsidian text font'], ['serif', 'Serif'], ['sans', 'Sans'],
  ['charter', 'Charter'], ['georgia', 'Georgia'], ['iowan', 'Iowan'], ['palatino', 'Palatino'], ['custom', 'Custom font (vault file)'],
]

/** Renders the Appearance panel. The page itself is the preview: every change applies live. */
export function renderAppearance(body: HTMLElement, s: OctavoSettings, obsidianDark: boolean, apply: () => void, opts: { pdf?: boolean; pdfLayout?: PdfLayoutControl; bookId?: string } = {}): void {
  const save = () => { apply() }
  const section = (title: string) => { const d = el('div', 'octavo-ap-section', body); el('div', 'octavo-ap-title', d, title); return d }

  const themes = el('div', 'octavo-theme-grid', section('Theme'))
  for (const id of Object.keys(THEMES) as ThemeId[]) {
    const t = THEMES[id]
    const dark = id === 'black' || (s.appearance === 'auto' ? obsidianDark : s.appearance === 'dark')
    const c = dark ? t.dark : t.light
    const b = el('button', 'octavo-theme-swatch', themes)
    b.setCssProps({ '--sw-bg': c.bg })
    b.setCssProps({ '--sw-fg': c.fg })
    el('span', 'octavo-theme-aa', b, 'Aa')
    el('span', 'octavo-theme-name', b, t.name)
    if (s.theme === id) b.addClass('is-active')
    b.setAttribute('aria-label', `${t.name} theme`)
    b.onclick = () => { s.theme = id; save(); rerender() }
  }

  const row = (parent: HTMLElement, label: string) => { const r = el('div', 'octavo-ap-row', parent); el('span', 'octavo-ap-label', r, label); return el('div', 'octavo-ap-control', r) }
  const seg = <T extends string>(parent: HTMLElement, options: Array<[T, string]>, value: T, set: (v: T) => void) => {
    const g = el('div', 'octavo-seg', parent)
    for (const [v, label] of options) {
      const b = el('button', v === value ? 'is-active' : '', g, label)
      b.onclick = () => { set(v); save(); rerender() }
    }
  }

  const general = section('Display')
  seg(row(general, 'Appearance'), [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], s.appearance, v => (s.appearance = v))
  const t = themeTypography(s)
  const setTypo = (patch: Partial<Typography>) => { s.overrides[s.theme] = { ...s.overrides[s.theme], ...patch } }
  if (!opts.pdf || s.pdfMode === 'text') {
    const size = row(general, 'Text size')
    const g = el('div', 'octavo-seg', size)
    const minus = el('button', '', g, 'A−'); minus.setAttribute('aria-label', 'Smaller text')
    el('span', 'octavo-ap-value', g, `${t.fontSize}%`)
    const plus = el('button', '', g, 'A+'); plus.setAttribute('aria-label', 'Larger text')
    minus.onclick = () => { s.textSize = Math.max(60, t.fontSize - 10); save(); rerender() }
    plus.onclick = () => { s.textSize = Math.min(250, t.fontSize + 10); save(); rerender() }
    const id = opts.bookId
    if (id) {
      // small-print PDFs or books set in large type: a size for this book only, the others keep theirs
      const own = row(general, 'Size for this book only')
      const ownToggle = el('div', `checkbox-container${id in s.bookTextSizes ? ' is-enabled' : ''}`, own)
      ownToggle.setAttribute('aria-label', 'Keep this text size for this book only')
      ownToggle.onclick = () => {
        if (id in s.bookTextSizes) delete s.bookTextSizes[id]
        else s.bookTextSizes[id] = t.fontSize
        save(); rerender()
      }
    }
    if (!opts.pdf) {
      seg(row(general, 'Layout'), [['paginated', 'Pages'], ['scrolled', 'Scroll']], s.flow, v => (s.flow = v))
      seg(row(general, 'Page turn'), [['slide', 'Slide'], ['none', 'None'], ['curl', 'Curl']], s.pageEffect, v => (s.pageEffect = v))
    }
  }
  if (opts.pdf) {
    const layout = section('Layout')
    seg(row(layout, 'View'), [['pages', 'Pages'], ['text', 'Text']] as Array<['pages' | 'text', string]>, s.pdfMode, v => (s.pdfMode = v))
    const pl = opts.pdfLayout
    if (pl && s.pdfMode !== 'text') {
      const L = pl.get()
      // per book: the page is the preview, and the choice is remembered for this book
      seg(row(layout, 'Fit'), [['auto', 'Auto'], ['width', 'Width'], ['page', 'Page']] as Array<[ResolvedLayout['fit'], string]>, L.fit, v => pl.set({ fit: v, zoom: 1 }))
      // two pages side by side is opt-in (whole pairs, margins trimmed, one pair per scroll); one page by default
      seg(row(layout, 'Pages'), [['one', 'One'], ['two', 'Two']] as Array<[ResolvedLayout['spread'], string]>, L.spread, v => { pl.set({ spread: v, zoom: 1 }); rerender() })
      const crop = row(layout, 'Crop margins')
      const cropToggle = el('div', `checkbox-container${L.crop ? ' is-enabled' : ''}`, crop)
      cropToggle.setAttribute('aria-label', 'Crop page margins')
      cropToggle.onclick = () => { pl.set({ crop: !pl.get().crop, zoom: 1 }); rerender() }
      seg(row(layout, 'Scroll'), [['vertical', 'Vertical'], ['paged', 'Paged']] as Array<[ResolvedLayout['scroll'], string]>, L.scroll, v => pl.set({ scroll: v }))
      if (L.scroll === 'paged') seg(row(layout, 'Direction'), [['ltr', 'Left to right'], ['rtl', 'Right to left']] as Array<[ResolvedLayout['dir'], string]>, L.dir, v => pl.set({ dir: v }))
      const lock = row(layout, 'Lock scroll direction')
      const lockToggle = el('div', `checkbox-container${s.pdfScrollLock ? ' is-enabled' : ''}`, lock)
      lockToggle.setAttribute('aria-label', 'Keep a drag or trackpad scroll on a zoomed page to one direction')
      lockToggle.onclick = () => { s.pdfScrollLock = !s.pdfScrollLock; save(); rerender() }
    }
    seg(row(layout, 'Dark mode'), [['invert-except-images', 'Smart invert'], ['sepia', 'Sepia'], ['none', 'Original']], s.pdfDark, v => (s.pdfDark = v))
  }
  seg(row(general, 'Footer'), [['chapter', 'Chapter'], ['book', 'Book'], ['time', 'Time left'], ['off', 'Off']], s.footer, v => (s.footer = v))
  const nl = row(general, 'Night light')
  const nlToggle = el('div', `checkbox-container${s.nightLight ? ' is-enabled' : ''}`, nl)
  nlToggle.onclick = () => { s.nightLight = !s.nightLight; save(); rerender() }
  if (s.nightLight && nightLightFactor() > 0) el('div', 'octavo-ap-note', general).setText('Warming the page now (evening hours). Themes keep their colours, just warmer.')

  const comfort = section('Comfort')
  const textLike = !opts.pdf || s.pdfMode === 'text'
  if (textLike) seg(row(comfort, 'Line width'), [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide'], ['full', 'Full']] as Array<[LineWidth, string]>, s.lineWidth, v => (s.lineWidth = v))
  const range = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void, aria: string) => {
    const c = row(comfort, label)
    const input = el('input', 'slider', c)
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value)
    input.setAttribute('aria-label', aria)
    const v = el('span', 'octavo-ap-value', c, fmt(value))
    input.oninput = () => { v.textContent = fmt(Number(input.value)); set(Number(input.value)); save() }
  }
  range('Dim', 0, 0.7, 0.05, s.dim, v => (v ? `${Math.round(v * 100)}%` : 'Off'), v => (s.dim = v), 'Dim the page below the lowest screen brightness')
  const darkNow = s.theme === 'black' || (s.appearance === 'auto' ? obsidianDark : s.appearance === 'dark')
  if (darkNow) range('Dark text', 60, 100, 5, s.darkContrast, v => `${v}%`, v => (s.darkContrast = v), 'Text strength in dark themes')
  const toggle = (label: string, on: boolean, flip: () => void, aria: string) => {
    const tg = el('div', `checkbox-container${on ? ' is-enabled' : ''}`, row(comfort, label))
    tg.setAttribute('aria-label', aria)
    tg.onclick = () => { flip(); save(); rerender() }
  }
  toggle('Reading ruler', s.ruler, () => (s.ruler = !s.ruler), 'A band that marks the line you are reading')
  if (s.ruler) {
    seg(row(comfort, 'Ruler style'), [['lightbox', 'Spotlight'], ['shade', 'Shade'], ['bar', 'Bar'], ['underline', 'Underline']] as Array<[RulerStyle, string]>, s.rulerStyle, v => (s.rulerStyle = v))
    el('div', 'octavo-ap-note', comfort).setText(RULER_NOTES[s.rulerStyle])
    seg(row(comfort, 'Ruler lines'), [['1', 'One'], ['3', 'Three']] as Array<['1' | '3', string]>, String(s.rulerLines) as '1' | '3', v => (s.rulerLines = v === '3' ? 3 : 1))
    if (s.rulerStyle !== 'underline') range('Ruler shade', 0.1, 0.6, 0.05, s.rulerDarkness, v => `${Math.round(v * 100)}%`, v => (s.rulerDarkness = v), 'How dark the reading ruler is')
  }
  toggle('Keep screen on', s.keepAwake, () => (s.keepAwake = !s.keepAwake), 'Keep the screen on while reading')

  if (opts.pdf && s.pdfMode !== 'text') return

  const custom = section('Customize')
  const ct = row(custom, 'Customize this theme')
  const ctToggle = el('div', `checkbox-container${s.customize ? ' is-enabled' : ''}`, ct)
  ctToggle.onclick = () => { s.customize = !s.customize; save(); rerender() }
  if (s.customize) {
    const fontSel = el('select', 'dropdown', row(custom, 'Font'))
    for (const [v, label] of FONT_LABELS) { const o = el('option', '', fontSel, label); o.value = v; if (v === t.font) o.selected = true }
    fontSel.onchange = () => { setTypo({ font: fontSel.value as FontChoice }); save() }
    const slider = (label: string, key: keyof Typography, min: number, max: number, step: number, fmt: (v: number) => string) => {
      const c = row(custom, label)
      const input = el('input', 'slider', c)
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step)
      input.value = String(t[key])
      const v = el('span', 'octavo-ap-value', c, fmt(Number(t[key])))
      input.oninput = () => { v.textContent = fmt(Number(input.value)); setTypo({ [key]: Number(input.value) }); save() }
    }
    slider('Line spacing', 'lineHeight', 1.1, 2.2, 0.05, v => v.toFixed(2))
    slider('Character spacing', 'letterSpacing', -0.05, 0.2, 0.01, v => `${v.toFixed(2)} em`)
    slider('Word spacing', 'wordSpacing', -0.1, 0.5, 0.02, v => `${v.toFixed(2)} em`)
    slider('Margins', 'margin', 0, 160, 4, v => `${v}px`)
    const toggles: Array<[keyof Typography, string]> = [['justify', 'Justify text'], ['hyphenate', 'Hyphenation'], ['bold', 'Bold text']]
    for (const [key, label] of toggles) {
      const c = row(custom, label)
      const tg = el('div', `checkbox-container${t[key] ? ' is-enabled' : ''}`, c)
      tg.onclick = () => { setTypo({ [key]: !t[key] }); save(); rerender() }
    }
    seg(row(custom, 'Columns'), [['1', 'One'], ['2', 'Two when wide']] as Array<['1' | '2', string]>, String(t.maxColumns) as '1' | '2', v => setTypo({ maxColumns: Number(v) }))
    const reset = el('button', 'mod-warning octavo-ap-reset', custom, 'Reset theme')
    reset.onclick = () => { delete s.overrides[s.theme]; save(); rerender() }
  }

  function rerender() { body.empty(); renderAppearance(body, s, obsidianDark, apply, opts) }
}
