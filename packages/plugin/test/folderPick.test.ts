import { describe, expect, it } from 'vitest'
import { folderCounts, foldersToSave, preselectFolders } from '../src/library/folderPick'

describe('folderCounts', () => {
  it('groups books by their top two folder levels, sorted by count', () => {
    const c = folderCounts([
      'Library/a.epub', 'Library/b.pdf', 'Library/Fiction/c.epub', 'Library/Fiction/Old/d.epub',
      'Papers/x.pdf', 'root.epub', '.trash/gone.epub', 'Notes/.trash/x.epub',
    ])
    expect(c).toEqual([
      { folder: 'Library', count: 2 },
      { folder: 'Library/Fiction', count: 2 },
      { folder: 'Papers', count: 1 },
    ])
  })
})

describe('preselectFolders', () => {
  const counts = [
    { folder: 'Library', count: 9 },
    { folder: 'Attachments', count: 5 },
    { folder: 'Books', count: 1 },
    { folder: 'Papers', count: 2 },
  ]
  it('ticks the books folder and folders with ≥3 books, never attachments', () => {
    expect(preselectFolders(counts, 'Books')).toEqual(['Library', 'Books'])
  })
  it('falls back to the biggest non-attachment folder', () => {
    expect(preselectFolders([{ folder: 'attachments', count: 2 }, { folder: 'Reading', count: 1 }], 'Books')).toEqual(['Reading'])
  })
  it('matches a books folder nested deeper than two levels', () => {
    expect(preselectFolders([{ folder: 'Media/Books', count: 1 }], 'Media/Books/Epubs')).toEqual(['Media/Books'])
  })
})

describe('foldersToSave', () => {
  it('drops folders covered by a selected parent and duplicates', () => {
    expect(foldersToSave(['Library/Fiction', 'Library', 'Papers', 'Papers'])).toEqual(['Library', 'Papers'])
  })
})
