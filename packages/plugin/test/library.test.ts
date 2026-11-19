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

  it('reuses a just-created note the metadata cache has not indexed yet (no "X 2.md")', async () => {
    const { BookLibrary } = await import('../src/library/BookLibrary')
    const { TFile } = await import('obsidian')
    const mk = (path: string, body: string) => Object.assign(new TFile(), { path, body, extension: 'md' })
    const files = new Map<string, any>([['Books/B.md', mk('Books/B.md', '---\noctavo-id: x\nbook: "[[b.epub]]"\n---\n')]])
    let creates = 0
    const app: any = {
      vault: {
        getAbstractFileByPath: (p: string) => files.get(p) ?? (p === 'Books' ? { path: p } : null),
        getMarkdownFiles: () => [...files.values()].filter(f => f.extension === 'md'),
        cachedRead: async (f: any) => f.body,
        createFolder: async () => {},
        create: async (p: string) => { creates++; const f = mk(p, ''); files.set(p, f); return f },
      },
      fileManager: { generateMarkdownLink: () => '[[b.epub]]' },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    }
    const lib = new BookLibrary(app, () => ({ booksFolder: 'Books' } as any))
    const book: any = { path: 'Library/b.epub', basename: 'b', extension: 'epub' }
    const note = await lib.ensureNote(book, { id: 'x', title: 'B', format: 'epub' })
    expect(note.path).toBe('Books/B.md')
    expect(creates).toBe(0)
    expect(lib.noteFor(book)?.path).toBe('Books/B.md')
  })
  it('an imported note is adopted by the same title, not by a title that only contains it ("Dune" vs "Dune Messiah")', async () => {
    const { BookLibrary } = await import('../src/library/BookLibrary')
    const { TFile } = await import('obsidian')
    const mk = (path: string, title: string) => Object.assign(new TFile(), { path, extension: 'md', title })
    const notes = [mk('Books/Dune Messiah.md', 'Dune Messiah'), mk('Books/The Great Gatsby A Novel.md', 'The Great Gatsby: A Novel')]
    const adopted: string[] = []
    const app: any = {
      vault: {
        getAbstractFileByPath: (p: string) => (p === 'Books' ? { path: p } : null),
        getMarkdownFiles: () => notes,
        createFolder: async () => {},
        create: async (p: string) => mk(p, ''),
      },
      fileManager: { generateMarkdownLink: () => '[[x]]', processFrontMatter: async (f: any) => { adopted.push(f.path) } },
      metadataCache: { getFileCache: (f: any) => ({ frontmatter: { title: f.title } }), getFirstLinkpathDest: () => null },
    }
    const lib = new BookLibrary(app, () => ({ booksFolder: 'Books', stats: { finishedByYear: {} } } as any))
    const dune = await lib.ensureNote({ path: 'L/Dune.epub', basename: 'Dune', extension: 'epub' } as any, { id: 'd', title: 'Dune', format: 'epub' })
    expect(dune.path).toBe('Books/Dune.md')
    const gatsby = await lib.ensureNote({ path: 'L/gatsby.epub', basename: 'gatsby', extension: 'epub' } as any, { id: 'g', title: 'The Great Gatsby', format: 'epub' })
    expect(gatsby.path).toBe('Books/The Great Gatsby A Novel.md')
    expect(adopted).toEqual(['Books/The Great Gatsby A Novel.md'])
  })
})
