import type { FontChoice, ThemeId, Typography } from '../settings'

export interface ThemePreset {
  name: string
  light: { bg: string; fg: string; link: string }
  dark: { bg: string; fg: string; link: string }
  typography: Partial<Typography>
}

/** Apple-Books-style presets: each bundles colours, font and spacing. */
export const THEMES: Record<ThemeId, ThemePreset> = {
  original: { name: 'Original', light: { bg: '#ffffff', fg: '#1d1d1f', link: '#0a66c2' }, dark: { bg: '#1c1c1e', fg: '#e5e5e7', link: '#6cb4ff' }, typography: { font: 'publisher' } },
  quiet: { name: 'Quiet', light: { bg: '#ececec', fg: '#4a4a4c', link: '#4a6b8a' }, dark: { bg: '#3a3a3c', fg: '#b8b8bd', link: '#9bb7d4' }, typography: { font: 'sans', lineHeight: 1.6 } },
  paper: { name: 'Paper', light: { bg: '#f7f3ea', fg: '#2a2723', link: '#7a4a1e' }, dark: { bg: '#23211d', fg: '#d9d3c5', link: '#d9a66b' }, typography: { font: 'charter', lineHeight: 1.55 } },
  bold: { name: 'Bold', light: { bg: '#ffffff', fg: '#000000', link: '#0040a0' }, dark: { bg: '#000000', fg: '#ffffff', link: '#8cc4ff' }, typography: { font: 'sans', bold: true, lineHeight: 1.5 } },
  calm: { name: 'Calm', light: { bg: '#f4e8cf', fg: '#4b3b28', link: '#8a5a2b' }, dark: { bg: '#2b251c', fg: '#d8c8a8', link: '#e0b27a' }, typography: { font: 'iowan', lineHeight: 1.6 } },
  focus: { name: 'Focus', light: { bg: '#fbf8f2', fg: '#222222', link: '#2f5d8a' }, dark: { bg: '#1b1b1b', fg: '#dcdcdc', link: '#8fb8e0' }, typography: { font: 'georgia', lineHeight: 1.45, margin: 64 } },
  black: { name: 'True Black', light: { bg: '#000000', fg: '#c9c9c9', link: '#7fb2ff' }, dark: { bg: '#000000', fg: '#c9c9c9', link: '#7fb2ff' }, typography: { font: 'serif' } },
}

const FONT_STACKS: Record<Exclude<FontChoice, 'publisher' | 'obsidian' | 'custom'>, string> = {
  serif: `'Literata', 'Charter', 'Iowan Old Style', Georgia, 'Noto Serif', serif`,
  sans: `-apple-system, 'Seravek', 'Atkinson Hyperlegible', 'Segoe UI', Roboto, 'Noto Sans', sans-serif`,
  charter: `'Charter', 'Bitstream Charter', 'Iowan Old Style', Georgia, serif`,
  georgia: `Georgia, 'Noto Serif', serif`,
  iowan: `'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif`,
  palatino: `'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif`,
}

export function fontStack(font: FontChoice, obsidianFont: string): string | null {
  if (font === 'publisher') return null
  if (font === 'obsidian') return obsidianFont || 'inherit'
  if (font === 'custom') return `'OctavoCustom', ${FONT_STACKS.serif}`
  return FONT_STACKS[font]
}

/** Night light: warm the page after sunset (simple local-time window). */
export function nightLightFactor(now = new Date()): number {
  const h = now.getHours() + now.getMinutes() / 60
  if (h >= 21 || h < 6) return 1
  if (h >= 19) return (h - 19) / 2
  if (h < 7) return 1 - (h - 6)
  return 0
}

export interface ResolvedLook {
  colors: { bg: string; fg: string; link: string }
  typo: Typography
  dark: boolean
}

/** CSS injected into every book section (foliate renderer.setStyles). */
export function bookCss(look: ResolvedLook, obsidianFont: string, customFontUrl?: string): string {
  const { colors, typo } = look
  const stack = fontStack(typo.font, obsidianFont)
  const fontFace = typo.font === 'custom' && customFontUrl
    ? `@font-face { font-family: 'OctavoCustom'; src: url("${customFontUrl}"); font-display: swap; }` : ''
  return `${fontFace}
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${look.dark ? 'dark' : 'light'};
      color: ${colors.fg} !important;
      background: ${colors.bg} !important;
      font-size: ${typo.fontSize}% !important;
      ${typo.hyphenate ? 'hyphens: auto; -webkit-hyphens: auto;' : 'hyphens: manual;'}
      hanging-punctuation: allow-end last;
      widows: 2; orphans: 2;
    }
    body { background: ${colors.bg} !important; color: inherit !important; }
    a:any-link { color: ${colors.link} !important; }
    p, li, blockquote, dd, div, span {
      line-height: ${typo.lineHeight} !important;
      ${stack ? `font-family: ${stack} !important;` : ''}
      ${typo.letterSpacing ? `letter-spacing: ${typo.letterSpacing}em !important;` : ''}
      ${typo.wordSpacing ? `word-spacing: ${typo.wordSpacing}em !important;` : ''}
      ${typo.bold ? 'font-weight: 600 !important;' : ''}
    }
    p, li, blockquote, dd { ${typo.justify ? 'text-align: justify;' : 'text-align: start !important;'} }
    h1, h2, h3, h4, h5, h6 { ${stack ? `font-family: ${stack} !important;` : ''} color: inherit !important; }
    pre, code, kbd, samp, tt { font-family: var(--octavo-mono, ui-monospace, Menlo, monospace) !important; hyphens: none; }
    pre { white-space: pre-wrap !important; }
    img, svg, video { max-width: 100% !important; height: auto; object-fit: contain; }
    ${look.dark ? `img:not([src$=".svg"]) { filter: brightness(0.92); } svg, img[src$=".svg"] { filter: invert(0.88) hue-rotate(180deg); }` : ''}
    table { border-collapse: collapse; }
    td, th { border-color: currentColor; }
    ::selection { background: rgba(255, 196, 0, 0.35); }
  `
}
