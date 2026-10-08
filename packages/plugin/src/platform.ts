import { Platform, type App, type WorkspaceLeaf } from 'obsidian'

/** Pop-out windows only exist on desktop; Obsidian throws if a plugin opens one on mobile. */
export const canPopout = (): boolean => !Platform.isMobile

/**
 * Where to show something "beside" the current view (a book's note, say). Phones have room for one
 * leaf, so it opens in place (the back button returns); desktop and tablets split.
 */
export const besideLeaf = (app: App): WorkspaceLeaf => app.workspace.getLeaf(Platform.isPhone ? false : 'split')
