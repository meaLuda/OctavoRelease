import { DEFAULT_TYPOGRAPHY, type OctavoSettings, type ThemeId, type Typography, type FontChoice } from '../settings'
import { THEMES, type ResolvedLook, nightLightFactor } from './themes'
import { el } from './ui'

export function resolveLook(s: OctavoSettings, obsidianDark: boolean): ResolvedLook {
  const preset = THEMES[s.theme] ?? THEMES.original
  const dark = s.theme === 'black' || (s.appearance === 'auto' ? obsidianDark : s.appearance === 'dark')
  const typo = themeTypography(s)
  let colors = { ...(dark ? preset.dark : preset.light) }
  if (s.nightLight && !dark) {
    const k = nightLightFactor()
    if (k > 0) colors = { ...colors, bg: mix(colors.bg, '#f3d9a8', 0.45 * k) }
  }
  return { colors, typo, dark }
}

/** Text size always applies; the other overrides only while "Customize" is on (Apple Books behaviour). */
export function themeTypography(s: OctavoSettings): Typography {
  const preset = THEMES[s.theme] ?? THEMES.original
  const o = s.overrides[s.theme] ?? {}
  return { ...DEFAULT_TYPOGRAPHY, ...preset.typography, ...(s.customize ? o : {}), ...(o.fontSize ? { fontSize: o.fontSize } : {}) }
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}

const FONT_LABELS: Array<[FontChoice, string]> = [
  ['publisher', 'Original'], ['obsidian', 'Obsidian text font'], ['serif', 'Serif'], ['sans', 'Sans'],
  ['charter', 'Charter'], ['georgia', 'Georgia'], ['iowan', 'Iowan'], ['palatino', 'Palatino'], ['custom', 'Custom font (vault file)'],
]

/** Renders the Appearance panel. The page itself is the preview: every change applies live. */
export function renderAppearance(body: HTMLElement, s: OctavoSettings, obsidianDark: boolean, apply: () => void, opts: { pdf?: boolean } = {}): void {
  const save = () => { apply() }
  const section = (title: string) => { const d = el('div', 'octavo-ap-section', body); el('div', 'octavo-ap-title', d, title); return d }

  const themes = el('div', 'octavo-theme-grid', section('Theme'))
  for (const id of Object.keys(THEMES) as ThemeId[]) {
    const t = THEMES[id]
    const dark = id === 'black' || (s.appearance === 'auto' ? obsidianDark : s.appearance === 'dark')
    const c = dark ? t.dark : t.light
    const b = el('button', 'octavo-theme-swatch', themes)
    b.style.setProperty('--sw-bg', c.bg)
    b.style.setProperty('--sw-fg', c.fg)
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
    minus.onclick = () => { setTypo({ fontSize: Math.max(60, t.fontSize - 10) }); save(); rerender() }
    plus.onclick = () => { setTypo({ fontSize: Math.min(250, t.fontSize + 10) }); save(); rerender() }
    if (!opts.pdf) {
      seg(row(general, 'Layout'), [['paginated', 'Pages'], ['scrolled', 'Scroll']], s.flow, v => (s.flow = v))
      seg(row(general, 'Page turn'), [['slide', 'Slide'], ['none', 'None'], ['curl', 'Curl']], s.pageEffect, v => (s.pageEffect = v))
    }
  }
  if (opts.pdf) {
    seg(row(general, 'View'), [['pages', 'Pages'], ['text', 'Text']] as Array<['pages' | 'text', string]>, s.pdfMode, v => (s.pdfMode = v))
    seg(row(general, 'Dark mode'), [['invert-except-images', 'Smart invert'], ['sepia', 'Sepia'], ['none', 'Original']], s.pdfDark, v => (s.pdfDark = v))
  }
  seg(row(general, 'Footer'), [['chapter', 'Chapter'], ['book', 'Book'], ['time', 'Time left'], ['off', 'Off']], s.footer, v => (s.footer = v))
  const nl = row(general, 'Night light')
  const nlToggle = el('div', `checkbox-container${s.nightLight ? ' is-enabled' : ''}`, nl)
  nlToggle.onclick = () => { s.nightLight = !s.nightLight; save(); rerender() }

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
      const input = el('input', 'slider', c) as HTMLInputElement
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step)
      input.value = String(t[key])
      const v = el('span', 'octavo-ap-value', c, fmt(Number(t[key])))
      input.oninput = () => { v.textContent = fmt(Number(input.value)); setTypo({ [key]: Number(input.value) } as Partial<Typography>); save() }
    }
    slider('Line spacing', 'lineHeight', 1.1, 2.2, 0.05, v => v.toFixed(2))
    slider('Character spacing', 'letterSpacing', -0.05, 0.2, 0.01, v => `${v.toFixed(2)} em`)
    slider('Word spacing', 'wordSpacing', -0.1, 0.5, 0.02, v => `${v.toFixed(2)} em`)
    slider('Margins', 'margin', 0, 160, 4, v => `${v}px`)
    const toggles: Array<[keyof Typography, string]> = [['justify', 'Justify text'], ['hyphenate', 'Hyphenation'], ['bold', 'Bold text']]
    for (const [key, label] of toggles) {
      const c = row(custom, label)
      const tg = el('div', `checkbox-container${t[key] ? ' is-enabled' : ''}`, c)
      tg.onclick = () => { setTypo({ [key]: !t[key] } as Partial<Typography>); save(); rerender() }
    }
    seg(row(custom, 'Columns'), [['1', 'One'], ['2', 'Two when wide']] as Array<['1' | '2', string]>, String(t.maxColumns) as '1' | '2', v => setTypo({ maxColumns: Number(v) }))
    const reset = el('button', 'mod-warning octavo-ap-reset', custom, 'Reset theme')
    reset.onclick = () => { delete s.overrides[s.theme]; save(); rerender() }
  }

  function rerender() { body.empty(); renderAppearance(body, s, obsidianDark, apply, opts) }
}
