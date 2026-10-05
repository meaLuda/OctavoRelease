import { describe, expect, it } from 'vitest'

describe('BookLibrary.ensureNote', () => {
  it('creates exactly one note when the same book is opened twice at once', async () => {
    const { BookLibrary } = await import('../src/library/BookLibrary')
    const files = new Map<string, any>()
    let creates = 0
    const app: any = {
      vault: {
        getAbstractFileByPath: (p: string) => files.get(p) ?? null,
        getMarkdownFiles: () => [],
        createFolder: async (p: string) => { files.set(p, { path: p }) },
        create: async (p: string) => { creates++; await new Promise(r => setTimeout(r, 10)); const f = { path: p }; files.set(p, f); return f },
      },
      fileManager: { generateMarkdownLink: () => '[[b.epub]]' },
      metadataCache: { getFileCache: () => null },
    }
    const lib = new BookLibrary(app, () => ({ booksFolder: 'Books' } as any))
    const book: any = { path: 'Library/b.epub', basename: 'b', extension: 'epub' }
    const meta = { id: 'x', title: 'B', format: 'epub' }
    const [a, b] = await Promise.all([lib.ensureNote(book, meta), lib.ensureNote(book, meta)])
    expect(a).toBe(b)
    expect(creates).toBe(1)
  })
})
