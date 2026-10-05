import { describe, expect, it } from 'vitest'
import { importElton, importAnnotator, importWeave, importKindle, importKoreaderSidecar, importKoreaderJson, importReadest, parseLuaTable, mapColor } from '../src'

describe('elton', () => {
  it('imports highlights and progress per book path', () => {
    const hl = JSON.stringify({ 'Lib/a.epub': [{ id: 'x', color: 'pink', text: 'quote', pre: 'pre ', post: ' post', created: 1790275369051, block: 3 }] })
    const pr = JSON.stringify({ 'Lib/a.epub': { pct: 0.42, lastRead: 1790275369051 }, 'Lib/b.pdf': { pct: 1 } })
    const books = importElton(hl, pr)
    const a = books.find(b => b.bookPath === 'Lib/a.epub')!
    expect(a.highlights[0]).toMatchObject({ color: 'pink', anchor: { quote: { exact: 'quote', prefix: 'pre ', suffix: ' post' } } })
    expect(a.position).toEqual({ fraction: 0.42 })
    expect(books.find(b => b.bookPath === 'Lib/b.pdf')!.status).toBe('finished')
  })
})

describe('annotator', () => {
  it('reads annotation-json callouts', () => {
    const md = `---
annotation-target: Books/x.epub
---

>%%
>\`\`\`annotation-json
>{"created":"2023-01-02T03:04:05.000Z","text":"","tags":["idea"],"target":[{"selector":[{"type":"TextQuoteSelector","exact":"the exact","prefix":"before ","suffix":" after"}]}]}
>\`\`\`
>%%
>*%%PREFIX%%before%%HIGHLIGHT%% ==the exact== %%POSTFIX%% after*
>%%LINK%%[[#^abc|show annotation]]
>%%COMMENT%%
>my comment
>%%TAGS%%
>#idea
^abc
`
    const b = importAnnotator(md)!
    expect(b.bookPath).toBe('Books/x.epub')
    expect(b.highlights[0]).toMatchObject({ note: 'my comment', tags: ['idea'], anchor: { quote: { exact: 'the exact', prefix: 'before ', suffix: ' after' } } })
  })
})

describe('weave', () => {
  it('reads position from the machine block', () => {
    const md = '---\nstatus: reading\n---\n```weave-epub-state\nformat: "weave-epub-bookmarks/v5"\nbookPath: "Lib/D.epub"\nbookTitle: "D"\nbookAuthor: "A;B;"\nreadingState:\n  currentPosition:\n    chapterIndex: 0\n    cfi: "epubcfi(/6/2!/4/2,,/2)"\n    percent: 30\n  readingStats:\n    lastReadTime: 1789412221705\n```\n'
    expect(importWeave(md)).toMatchObject({ bookPath: 'Lib/D.epub', author: 'A, B', status: 'reading', position: { cfi: 'epubcfi(/6/2!/4/2,,/2)', fraction: 0.3 } })
  })
})

describe('kindle', () => {
  it('parses highlights, attaches notes, skips bookmarks', () => {
    const txt = `﻿Deep Work (Cal Newport)
- Your Highlight on page 12 | Location 180-182 | Added on Monday, 1 January 2024 10:00:00

Focus is a skill.
==========
Deep Work (Cal Newport)
- Your Note on page 12 | Location 182 | Added on Monday, 1 January 2024 10:01:00

agree
==========
Deep Work (Cal Newport)
- Your Bookmark on page 20 | Location 300 | Added on Monday, 1 January 2024 10:02:00


==========
Other Book (Someone)
- Your Highlight at location 50-51 | Added on Tuesday, 2 January 2024 09:00:00

Second quote
==========
`
    const books = importKindle(txt)
    expect(books).toHaveLength(2)
    expect(books[0]).toMatchObject({ title: 'Deep Work', author: 'Cal Newport' })
    expect(books[0]!.highlights).toHaveLength(1)
    expect(books[0]!.highlights[0]).toMatchObject({ label: 'p. 12', anchor: { quote: { exact: 'Focus is a skill.' } } })
    expect(books[1]!.highlights[0]!.label).toBe('loc. 50')
  })
})

describe('koreader', () => {
  it('parses Lua tables including escapes and nested arrays', () => {
    expect(parseLuaTable('return { ["a"] = 1, b = "x\\"y", [1] = true, c = { "p", "q" }, d = [[long\nstr]] }'))
      .toEqual({ a: 1, b: 'x"y', 1: true, c: ['p', 'q'], d: 'long\nstr' })
  })
  it('imports the modern annotations list', () => {
    const lua = `-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "Chapter 1",
            ["color"] = "green",
            ["datetime"] = "2025-02-03 10:11:12",
            ["drawer"] = "lighten",
            ["note"] = "nice",
            ["pos0"] = "/body/DocFragment[3]/body/p[2]/text().0",
            ["text"] = "caf\\195\\169 time",
        },
    },
    ["doc_props"] = { ["authors"] = "Ann\\nBob", ["title"] = "T" },
    ["percent_finished"] = 0.5,
    ["summary"] = { ["status"] = "reading" },
}`
    const b = importKoreaderSidecar(lua, 'x.epub')
    expect(b).toMatchObject({ title: 'T', author: 'Ann, Bob', position: { fraction: 0.5 }, status: 'reading' })
    expect(b.highlights[0]).toMatchObject({ color: 'green', note: 'nice', label: 'Chapter 1', anchor: { quote: { exact: 'café time' } } })
  })
  it('imports exporter JSON', () => {
    const j = JSON.stringify({ title: 'T', author: 'A', entries: [{ text: 'q', note: 'n', page: 4, time: 1700000000, chapter: 'C', drawer: 'underscore' }] })
    expect(importKoreaderJson(j)[0]!.highlights[0]).toMatchObject({ style: 'underline', note: 'n', label: 'C' })
  })
})

describe('readest', () => {
  it('keeps CFIs and skips deleted notes and bookmarks', () => {
    const c = JSON.stringify({ location: 'epubcfi(/6/8!/4/2/1:0)', progress: [50, 200], booknotes: [
      { type: 'annotation', cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:9)', text: 'some text', color: 'blue', style: 'highlight', note: '', createdAt: 1700000000000 },
      { type: 'annotation', cfi: 'x', text: 'gone', deletedAt: 1 },
      { type: 'bookmark', cfi: 'y', text: 'bm' },
    ] })
    const b = importReadest(c)
    expect(b.highlights).toHaveLength(1)
    expect(b.highlights[0]!.anchor.cfi).toBe('epubcfi(/6/8!/4/2,/1:0,/1:9)')
    expect(b.position).toEqual({ cfi: 'epubcfi(/6/8!/4/2/1:0)', fraction: 0.25 })
  })
})

describe('colors', () => {
  it('maps names and hex values', () => {
    expect(mapColor('red')).toBe('pink')
    expect(mapColor('#ffff00')).toBe('yellow')
    expect(mapColor('#00aa00')).toBe('green')
    expect(mapColor(undefined)).toBe('yellow')
  })
})
