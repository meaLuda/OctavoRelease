/** Content-Security-Policy injected into every book section: no scripts, no network. */
export const BOOK_CSP = "default-src 'none'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline' blob: data:; script-src 'none'; frame-src 'none'; object-src 'none'"

/** Make (X)HTML section markup safe: strip scripts / inline handlers and add a CSP meta tag. */
export function sanitizeSection(markup: string): string {
  let s = markup
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${BOOK_CSP}"/>`
  if (/<head\b[^>]*>/i.test(s)) s = s.replace(/<head\b[^>]*>/i, m => `${m}${meta}`)
  else if (/<html\b[^>]*>/i.test(s)) s = s.replace(/<html\b[^>]*>/i, m => `${m}<head>${meta}</head>`)
  return s
}

/** Concatenated text of a document plus a map back to text nodes. */
export interface TextIndex { text: string; nodes: Text[]; starts: number[] }

export function indexText(root: Node): TextIndex {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('script,style,rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const nodes: Text[] = [], starts: number[] = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text); starts.push(text.length); text += (n as Text).data
  }
  return { text, nodes, starts }
}

function locate(idx: TextIndex, offset: number): [Text, number] | null {
  let lo = 0, hi = idx.starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.starts[mid] <= offset) lo = mid; else hi = mid - 1 }
  const node = idx.nodes[lo]
  if (!node) return null
  return [node, Math.min(offset - idx.starts[lo], node.data.length)]
}

export function rangeFromOffsets(idx: TextIndex, start: number, end: number): Range | null {
  const a = locate(idx, start), b = locate(idx, Math.max(start, end - 1))
  if (!a || !b) return null
  const r = a[0].ownerDocument.createRange()
  r.setStart(a[0], a[1])
  r.setEnd(b[0], Math.min(b[1] + 1, b[0].data.length))
  return r
}

/** Character offset of a range start within the index. */
export function offsetOf(idx: TextIndex, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = idx.nodes.indexOf(node as Text)
    if (i >= 0) return idx.starts[i] + offset
  }
  // element container: find first text node at/after the child offset
  const r = node.ownerDocument!.createRange()
  r.setStart(node, offset)
  for (let i = 0; i < idx.nodes.length; i++) {
    if (r.comparePoint(idx.nodes[i], 0) >= 0) return idx.starts[i]
  }
  return idx.text.length
}

/** Rect of a range inside an iframe, translated to the coordinates of the host window. */
export function rangeRectInHost(range: Range): DOMRect {
  const rect = range.getBoundingClientRect()
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null
  if (!frame) return rect
  const fr = frame.getBoundingClientRect()
  return new DOMRect(rect.left + fr.left, rect.top + fr.top, rect.width, rect.height)
}

export const hasSelection = (doc: Document) => {
  const s = doc.getSelection()
  return !!s && s.rangeCount > 0 && !s.isCollapsed && s.toString().trim().length > 0
}

/** Two taps close in time (350 ms) and place (30 px) make a double tap. */
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, next: { t: number; x: number; y: number }): boolean {
  return !!prev && next.t - prev.t < 350 && Math.hypot(next.x - prev.x, next.y - prev.y) < 30
}

/** Word characters: letters, marks and digits in any script, plus inner apostrophes and hyphens. */
const WORD = /[\p{L}\p{M}\p{N}]/u

/** The word in `text` around `offset`, as [start, end), or null when `offset` is not on a word. */
export function wordBounds(text: string, offset: number): [number, number] | null {
  const isW = (i: number) => i >= 0 && i < text.length && (WORD.test(text[i]) || (/['’-]/.test(text[i]) && WORD.test(text[i - 1] ?? '') && WORD.test(text[i + 1] ?? '')))
  let i = offset
  if (!isW(i) && isW(i - 1)) i--
  if (!isW(i)) return null
  let a = i, b = i + 1
  while (isW(a - 1)) a--
  while (isW(b)) b++
  return [a, b]
}

/** The word under a point in a book section (client coordinates of that document). */
export function wordAt(doc: Document, x: number, y: number): { word: string; range: Range } | null {
  type CaretDoc = Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  const pos = (doc as CaretDoc).caretPositionFromPoint?.(x, y)
  const r = pos ? null : doc.caretRangeFromPoint?.(x, y)
  const node = pos?.offsetNode ?? r?.startContainer, offset = pos?.offset ?? r?.startOffset ?? 0
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const text = (node as Text).data
  const b = wordBounds(text, offset)
  if (!b) return null
  const range = doc.createRange()
  range.setStart(node, b[0]); range.setEnd(node, b[1])
  return { word: text.slice(b[0], b[1]), range }
}

/**
 * Keys that turn a page `back` or `forward`: arrows (up and down only on paged layouts), Page Up and Down,
 * and on phones the media track keys some Bluetooth page turners send. Space is handled by each reader.
 */
export function isPageTurnKey(key: string, dir: 'back' | 'forward', paged: boolean, mobile = false): boolean {
  const back = key === 'ArrowLeft' || key === 'PageUp' || (paged && key === 'ArrowUp') || (mobile && key === 'MediaTrackPrevious')
  const fwd = key === 'ArrowRight' || key === 'PageDown' || (paged && key === 'ArrowDown') || (mobile && key === 'MediaTrackNext')
  return dir === 'back' ? back : fwd
}

/** The match at `i` (length `n`) in `text` starts and ends at word boundaries (any script). */
export function wholeWordAt(text: string, i: number, n: number): boolean {
  return !WORD.test(text[i - 1] ?? '') && !WORD.test(text[i + n] ?? '')
}
