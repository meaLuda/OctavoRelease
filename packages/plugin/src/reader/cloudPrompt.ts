import { Notice, setIcon, type TFile } from 'obsidian'
import { hasCloud } from '@octavo/shared'
import type OctavoPlugin from '../main'
import { markPrompted, promptCopy, shouldPrompt, type PromptContext, type PromptKind } from '../cloud/prompts'

export const SITE_PRICING_URL = 'https://octavo.devformat.tools/#pricing'
const inFlight = new Set<string>()

/**
 * A slim, dismissible Octavo Cloud hint at the top of the reader. Never a modal; each kind shows at most
 * once per book and can be turned off in settings ("Cloud tips in the reader").
 */
export async function maybeCloudPrompt(plugin: OctavoPlugin, root: HTMLElement, kind: PromptKind, file: TFile, bookId: string, ctx: PromptContext = {}): Promise<void> {
  const s = plugin.settings
  if (!shouldPrompt(s, kind, bookId, ctx)) return
  const cloud = plugin.cloud
  const key = `${kind}:${bookId}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  // Only signed-in users ever reach the server here, and only once a hint is due.
  try { if (cloud.signedIn && !cloud.ent) await cloud.refresh().catch(() => null) } finally { inFlight.delete(key) }
  if (!root.isConnected || !shouldPrompt(s, kind, bookId, ctx) || root.querySelector('.octavo-cloud-banner')) return
  const onCloud = hasCloud(cloud.ent?.tier)
  s.promptsSeen = markPrompted(s.promptsSeen, kind, bookId)
  void plugin.saveSettings()

  const copy = promptCopy(kind, onCloud, ctx.isStub)
  const bar = root.createDiv({ cls: 'octavo-cloud-banner', attr: { role: 'status' } })
  bar.addEventListener('pointerdown', e => e.stopPropagation())
  bar.addEventListener('click', e => e.stopPropagation())
  setIcon(bar.createSpan({ cls: 'octavo-cloud-banner-icon' }), 'cloud')
  bar.createSpan({ cls: 'octavo-cloud-banner-text', text: copy.text })
  const action = bar.createEl('button', { cls: 'mod-cta', text: copy.action })
  const dismiss = bar.createEl('button', { cls: 'clickable-icon octavo-cloud-banner-close', attr: { 'aria-label': 'Dismiss' } })
  setIcon(dismiss, 'x')
  const close = () => bar.remove()
  dismiss.addEventListener('click', close)
  // a hint, not a nag: fade out after 20 s unless the pointer is on it
  let hovered = false
  bar.addEventListener('pointerenter', () => { hovered = true; bar.removeClass('is-fading') })
  bar.addEventListener('pointerleave', () => { hovered = false })
  const fade = () => {
    if (!bar.isConnected) return
    if (hovered) { window.setTimeout(fade, 5000); return }
    bar.addClass('is-fading'); window.setTimeout(() => { if (!hovered) close() }, 450)
  }
  window.setTimeout(fade, 20000)
  action.addEventListener('click', () => {
    close()
    if (!onCloud) { window.open(SITE_PRICING_URL); return }
    if (kind === 'big') void cloud.uploadBook(file)
    else if (kind === 'scan') void (ctx.isStub ? cloud.requestOcr(file) : cloud.uploadBook(file))
    else {
      s.tts.engine = 'cloud'
      void plugin.saveSettings()
      new Notice('Natural voices are on. Start read-aloud again to hear them.')
    }
  })
}
