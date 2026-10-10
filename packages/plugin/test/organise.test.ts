import { describe, expect, it } from 'vitest'
import {
  cloudLabelsKey, collectionEdit, describeFilter, emptyFilter, facetValues, folderChain, groupByCollection, isEmptyFilter, labelsKey,
  makeSmartCollection, matchesFilter, mergeCloudLabels, normalizeFilter, noteLabels, renameCollectionInSmart, renameLabel,
  seriesOf, tagsOf, toggleFacet, type FilterableBook,
} from '../src/library/organise'

const book = (p: Partial<FilterableBook> & { path: string }): FilterableBook => ({ format: 'epub', tags: [], collections: [], status: 'reading', ...p })
const books: FilterableBook[] = [
  book({ path: 'Library/Sci-fi/Dune.epub', author: 'Frank Herbert', series: 'Dune', tags: ['book', 'classic'], collections: ['Favourites'] }),
  book({ path: 'Library/Sci-fi/Old/Foundation.epub', author: 'Isaac Asimov', series: 'Foundation', tags: ['classic'] }),
  book({ path: 'Library/Papers/Attention.pdf', format: 'pdf', author: 'Vaswani', tags: ['ml'], status: 'finished' }),
  book({ path: 'Root.pdf', format: 'pdf' }),
]

describe('filters', () => {
  it('matches folders including nested ones', () => {
    const f = { ...emptyFilter(), folders: ['Library/Sci-fi'] }
    expect(books.filter(b => matchesFilter(b, f)).map(b => b.path)).toEqual(['Library/Sci-fi/Dune.epub', 'Library/Sci-fi/Old/Foundation.epub'])
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), folders: ['Library/Sci'] }))).toHaveLength(0) // prefix, not a folder
  })
  it('ORs within a facet and ANDs across facets, case-insensitively', () => {
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), tags: ['Classic', 'ml'] }))).toHaveLength(3)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), tags: ['classic'], formats: ['PDF'] }))).toHaveLength(0)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), formats: ['PDF'] }))).toHaveLength(2)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), authors: ['isaac asimov'] }))).toHaveLength(1)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), series: ['Dune'] }))).toHaveLength(1)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), status: 'finished' }))).toHaveLength(1)
    expect(books.filter(b => matchesFilter(b, { ...emptyFilter(), collections: ['favourites'] }))).toHaveLength(1)
    expect(books.filter(b => matchesFilter(b, emptyFilter()))).toHaveLength(4)
  })
  it('lists facet values with counts; folders as a tree, the "book" tag hidden', () => {
    expect(facetValues(books, 'folders')).toEqual([
      { value: 'Library', count: 3, depth: 0 },
      { value: 'Library/Papers', count: 1, depth: 1 },
      { value: 'Library/Sci-fi', count: 2, depth: 1 },
      { value: 'Library/Sci-fi/Old', count: 1, depth: 2 },
    ])
    expect(facetValues(books, 'tags').map(v => v.value)).toEqual(['classic', 'ml'])
    expect(facetValues(books, 'formats')).toEqual([{ value: 'EPUB', count: 2, depth: 0 }, { value: 'PDF', count: 2, depth: 0 }])
    expect(facetValues(books, 'series').map(v => v.value)).toEqual(['Dune', 'Foundation'])
  })
  it('toggles values and describes filters', () => {
    let f = toggleFacet(emptyFilter(), 'tags', 'classic')
    f = toggleFacet(f, 'formats', 'EPUB')
    expect(describeFilter(f)).toBe('Tag: classic · Format: EPUB')
    f = toggleFacet(f, 'tags', 'Classic')
    expect(f.tags).toEqual([])
    expect(isEmptyFilter(emptyFilter())).toBe(true)
    expect(isEmptyFilter({ ...emptyFilter(), status: 'want' })).toBe(false)
  })
  it('parses frontmatter tags, series and folder chains', () => {
    expect(tagsOf(['#a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(tagsOf('x, #y z')).toEqual(['x', 'y', 'z'])
    expect(tagsOf(undefined)).toEqual([])
    expect(seriesOf('The Expanse #3')).toBe('The Expanse')
    expect(seriesOf(['[[Discworld]]'])).toBe('Discworld')
    expect(seriesOf(42)).toBe('42')
    expect(seriesOf(null)).toBeUndefined()
    expect(folderChain('a/b/c.epub')).toEqual(['a', 'a/b'])
    expect(folderChain('c.epub')).toEqual([])
  })
  it('normalizes stored filters', () => {
    expect(normalizeFilter({ tags: ['a', 'a', 3], status: '', collections: [] })).toEqual({ ...emptyFilter(), tags: ['a'] })
    expect(normalizeFilter(null)).toEqual(emptyFilter())
  })
})

describe('smart collections', () => {
  it('saves the current shelf and facets', () => {
    const facets = { ...emptyFilter(), tags: ['classic'] }
    const s = makeSmartCollection(' Classics to read ', facets, 'want', [], 1000)
    expect(s).toEqual({ id: 'sc-rs', name: 'Classics to read', filter: { ...facets, status: 'want' } })
    const c = makeSmartCollection('Fav PDFs', { ...emptyFilter(), formats: ['PDF'] }, 'c:Favourites', [s], 1000)
    expect(c.id).toBe('sc-rs-2')
    expect(c.filter.collections).toEqual(['Favourites'])
    expect(makeSmartCollection('x', emptyFilter(), 'all', []).filter.status).toBeUndefined()
  })
  it('follows a collection rename or delete', () => {
    const s = [{ id: '1', name: 'A', filter: { ...emptyFilter(), collections: ['Fav'] } }, { id: '2', name: 'B', filter: emptyFilter() }]
    expect(renameCollectionInSmart(s, 'fav', 'Best')[0]!.filter.collections).toEqual(['Best'])
    expect(renameCollectionInSmart(s, 'Fav', null)[0]!.filter.collections).toBeUndefined()
    expect(renameCollectionInSmart(s, 'Fav', 'Best')[1]).toBe(s[1])
  })
})

describe('collection rename across notes', () => {
  it('renames, merges duplicates and deletes', () => {
    expect(renameLabel(['A', 'Fav', 'B'], 'fav', 'Best')).toEqual(['A', 'Best', 'B'])
    expect(renameLabel(['Best', 'Fav'], 'Fav', 'best')).toEqual(['Best'])
    expect(collectionEdit(['Fav', 'X'], 'Fav', 'Best')).toEqual({ collections: ['Best', 'X'] })
    expect(collectionEdit('Fav', 'Fav', null)).toEqual({ collections: undefined })
    expect(collectionEdit(['X'], 'Fav', 'Best')).toBeUndefined()
    expect(collectionEdit(undefined, 'Fav', null)).toBeUndefined()
  })
})

describe('cloud labels', () => {
  it('reads note labels without the default book tag', () => {
    const l = noteLabels({ collections: ['Fav', 'Fav', ' '], tags: ['book', 'classic'] })
    expect(l).toEqual({ collections: ['Fav'], tags: ['classic'] })
    expect(labelsKey(l)).toBe('[["Fav"],["classic"]]')
    expect(noteLabels({}).collections).toEqual([])
  })
  it('merges cloud labels into a note', () => {
    expect(mergeCloudLabels({ tags: ['book'] }, { collections: ['Fav'], tags: ['classic'] })).toEqual({ collections: ['Fav'], tags: ['book', 'classic'] })
    expect(mergeCloudLabels({}, {})).toEqual({ tags: ['book'] })
    expect(mergeCloudLabels({ collections: 'Fav', tags: ['x'] }, { collections: ['fav', 'New'], tags: ['X'] })).toEqual({ collections: ['Fav', 'New'], tags: ['x'] })
  })
  it('groups the cloud library by collection', () => {
    const g = groupByCollection([
      { title: 'B', collections: ['Sci-fi', 'Fav'] }, { title: 'A', collections: ['Sci-fi'] }, { title: 'C' }, { title: 'D', collections: [] },
    ])
    expect(g.map(x => [x.name, x.books.map(b => b.title)])).toEqual([['Fav', ['B']], ['Sci-fi', ['A', 'B']], ['Not in a collection', ['C', 'D']]])
  })
})

describe('cloud labels last-sent key', () => {
  it('records what the Cloud holds, so local-only labels are sent up after a merge', () => {
    const cloud = { collections: ['Fav'], tags: ['classic'] }
    // a note with nothing local: merged == cloud, nothing to send
    expect(labelsKey(noteLabels(mergeCloudLabels({ tags: ['book'] }, cloud)))).toBe(cloudLabelsKey(cloud))
    // a note with a local-only collection and tag: differs, so the change event PATCHes the union
    const merged = mergeCloudLabels({ collections: ['Mine'], tags: ['book', 'local'] }, cloud)
    expect(labelsKey(noteLabels(merged))).not.toBe(cloudLabelsKey(cloud))
    expect(noteLabels(merged)).toEqual({ collections: ['Mine', 'Fav'], tags: ['local', 'classic'] })
    expect(cloudLabelsKey({})).toBe(labelsKey({ collections: [], tags: [] }))
  })
})
