import { Platform, getIconIds, loadPdfJs, type App } from 'obsidian'

/**
 * "Copy mobile diagnostics": what Octavo can and cannot reach on this device. Owners paste the report
 * into a bug report. Nothing is sent anywhere.
 */
export async function collectDiagnostics(app: App, version: string): Promise<string> {
  const lines: string[] = [`Octavo ${version} diagnostics, ${new Date().toISOString()}`]
  const add = (k: string, v: unknown) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  add('platform', {
    isMobile: Platform.isMobile, isMobileApp: Platform.isMobileApp, isPhone: Platform.isPhone, isTablet: Platform.isTablet,
    isIosApp: Platform.isIosApp, isAndroidApp: Platform.isAndroidApp, isDesktopApp: Platform.isDesktopApp,
  })
  add('origin', window.location.origin)
  add('resourcePathPrefix', (Platform as unknown as { resourcePathPrefix?: string }).resourcePathPrefix ?? 'n/a')
  add('userAgent', navigator.userAgent)
  add('viewport', { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })

  const probe = document.body.createDiv()
  probe.addClass('octavo-safe-area-probe')
  const cs = getComputedStyle(probe)
  add('safeArea', { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft })
  probe.remove()

  add('icon.octavo.registered', getIconIds().includes('octavo'))
  add('ribbon.octavo.present', !!document.querySelector('[aria-label="Octavo library"]'))

  try { await loadPdfJs(); add('pdfjs.core', 'ok') } catch (e) { add('pdfjs.core', `failed: ${(e as Error).message}`) }
  add('pdfjs.viewerGlobal', !!(window as unknown as { pdfjsViewer?: unknown }).pdfjsViewer)
  for (const path of ['/lib/pdfjs/pdf.viewer.min.mjs', '/lib/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap', '/lib/pdfjs/standard_fonts/FoxitSans.pfb']) {
    try {
      const res = await fetch(path, { method: 'GET', cache: 'no-store' })
      add(`fetch ${path}`, res.status)
    } catch (e) { add(`fetch ${path}`, `failed: ${(e as Error).message}`) }
  }

  add('iframe.srcdoc', await new Promise<string>(resolve => {
    const f = document.body.createEl('iframe')
    f.addClass('octavo-hidden-probe')
    const done = (v: string) => { f.remove(); resolve(v) }
    window.setTimeout(() => done('timeout'), 3000)
    f.onload = () => done(f.contentDocument?.body?.textContent === 'ok' ? 'ok' : 'loaded but not readable')
    f.srcdoc = '<p>ok</p>'
  }))

  const open = app.workspace.getLeavesOfType('octavo-epub').length + app.workspace.getLeavesOfType('octavo-pdf').length
  add('openBooks', open)
  return lines.join('\n')
}
