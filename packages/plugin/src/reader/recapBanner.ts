import { moment } from 'obsidian'
import { el, iconButton } from './ui'

/**
 * Back after a break: a small banner offers "Story so far" when the book was last read at least `afterDays`
 * ago (0 = never), is partly read, and AI is set up. It goes away by itself after 30 seconds.
 */
export function offerRecap(root: HTMLElement, o: { afterDays: number; lastRead: string; progress: number; aiReady: boolean; run: () => void }): void {
  if (!o.afterDays || !o.aiReady || !o.lastRead || !Number.isFinite(o.progress) || o.progress < 0.02 || o.progress > 0.98) return
  const away = moment().diff(moment(o.lastRead), 'days')
  if (!Number.isFinite(away) || away < o.afterDays) return
  const bar = el('div', 'octavo-cloud-banner octavo-recap-banner', root)
  bar.addEventListener('click', e => e.stopPropagation())
  el('span', '', bar, `Welcome back. It has been ${away} ${away === 1 ? 'day' : 'days'}.`)
  const go = el('button', 'mod-cta', bar, 'Story so far')
  go.onclick = e => { e.stopPropagation(); bar.remove(); o.run() }
  iconButton(bar, 'x', 'Dismiss', () => bar.remove())
  window.setTimeout(() => bar.remove(), 30_000)
}
