/**
 * "Where are your books?" (one-time folder picker): pure folder counting and preselection.
 */

export interface FolderCount {
  folder: string
  count: number
}

const IGNORED = /(^|\/)\.trash(\/|$)/
const ATTACHMENTS = /(^|\/)(attachments?|assets|_resources|files)(\/|$)/i

/** Book files grouped by their folder, cut to the top two levels. Books at the vault root are left out (use "Whole vault"). */
export function folderCounts(bookPaths: string[]): FolderCount[] {
  const counts = new Map<string, number>()
  for (const p of bookPaths) {
    if (IGNORED.test(p) || p.startsWith('.')) continue
    const parts = p.split('/').slice(0, -1)
    if (!parts.length) continue
    const folder = parts.slice(0, 2).join('/')
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  return [...counts].map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
}

/** Folders ticked up front: the books folder (or one inside it) and any folder with at least `min` books; never attachment folders. */
export function preselectFolders(counts: FolderCount[], booksFolder: string, min = 3): string[] {
  const bf = booksFolder.replace(/^\/+|\/+$/g, '')
  const picked = counts.filter(c => !ATTACHMENTS.test(c.folder) &&
    (c.count >= min || (bf && (c.folder === bf || c.folder.startsWith(bf + '/') || bf.startsWith(c.folder + '/')))))
  // nothing qualifies → the single folder with the most books
  if (!picked.length) {
    const top = counts.find(c => !ATTACHMENTS.test(c.folder))
    return top ? [top.folder] : []
  }
  return picked.map(c => c.folder)
}

/** Drop folders already covered by a selected parent; keep the given order. */
export function foldersToSave(selected: string[]): string[] {
  const uniq = [...new Set(selected.filter(Boolean))]
  return uniq.filter(f => !uniq.some(o => o !== f && f.startsWith(o + '/')))
}
