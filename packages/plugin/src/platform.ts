import { Platform, requireApiVersion, type App, type ButtonComponent, type WorkspaceLeaf } from 'obsidian'

/** Pop-out windows only exist on desktop; Obsidian throws if a plugin opens one on mobile. */
export const canPopout = (): boolean => !Platform.isMobile

/**
 * Where to show something "beside" the current view (a book's note, say). Phones have room for one
 * leaf, so it opens in place (the back button returns); desktop and tablets split.
 */
export const besideLeaf = (app: App): WorkspaceLeaf => app.workspace.getLeaf(Platform.isPhone ? false : 'split')

/** Red "destructive" button: setDestructive() from 1.13, the older warning style before it. */
export function destructive<B extends ButtonComponent>(b: B): B {
  if (requireApiVersion('1.13.0')) b.setDestructive()
  else b.buttonEl.addClass('mod-warning')
  return b
}
