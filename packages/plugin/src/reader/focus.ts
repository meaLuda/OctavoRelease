import { Platform } from 'obsidian'

/**
 * Focus mode. Desktop: the whole Obsidian window goes native full-screen (Electron) and
 * CSS hides the ribbon, sidebars, tab bar and status bar — menus, modals, notices and
 * hover previews keep working because nothing is moved out of the document (the
 * element Fullscreen API would hide them). Mobile: hides Obsidian's bars (iOS can't
 * full-screen non-video elements reliably, and web content can't hide the status bar).
 */
export class FocusMode {
  private wasFullScreen = false
  active = false
  constructor(private doc: () => Document) {}

  private win(): any { return (this.doc().defaultView as any)?.electronWindow }

  enter() {
    if (this.active) return
    this.active = true
    const d = this.doc()
    d.body.addClass('octavo-focus')
    if (Platform.isDesktopApp) {
      const w = this.win()
      try { this.wasFullScreen = !!w?.isFullScreen?.(); if (!this.wasFullScreen) w?.setFullScreen?.(true) } catch { /* window API unavailable */ }
    }
  }

  exit() {
    if (!this.active) return
    this.active = false
    this.doc().body.removeClass('octavo-focus')
    if (Platform.isDesktopApp && !this.wasFullScreen) { try { this.win()?.setFullScreen?.(false) } catch { /* ignore */ } }
  }

  toggle() { this.active ? this.exit() : this.enter() }
}
