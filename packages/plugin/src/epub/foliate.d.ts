// Types for the vendored foliate-js modules (packages/foliate). Only what Octavo uses.

interface HTMLElementTagNameMap {
  [name: `foliate-view${string}`]: import('@octavo/foliate/view.js').View
}

declare module '@octavo/foliate/tags.js' {
  /** Custom-element name with the per-build suffix. */
  export function tag<N extends string>(name: N): `${N}${string}`
  export function define(name: string, cls: CustomElementConstructor): void
}

declare module '@octavo/foliate/overlayer.js' {
  export interface OverlayRect { left: number; top: number; right: number; bottom: number }
  export interface DrawOptions { color?: string; width?: number; padding?: number; radius?: number; [k: string]: unknown }
  export type DrawFn = (rects: DOMRectList | OverlayRect[], options?: DrawOptions) => SVGElement
  export type HitTestResult = [] | [string, Range, OverlayRect]
  export class Overlayer {
    constructor(doc: Document)
    get element(): SVGSVGElement
    add(key: string, range: Range | ((root: Node) => Range), draw: DrawFn, options?: DrawOptions): void
    remove(key: string): void
    redraw(): void
    hitTest(point: { x: number; y: number }): HitTestResult
    static underline: DrawFn
    static strikethrough: DrawFn
    static squiggly: DrawFn
    static highlight: DrawFn
    static outline: DrawFn
    static bubble: DrawFn
  }
}

declare module '@octavo/foliate/epubcfi.js' {
  export const isCFI: RegExp
  export function joinIndir(...xs: string[]): string
  export function parse(cfi: string): unknown
  export function toString(parsed: unknown): string
  export function collapse(cfi: string, toEnd?: boolean): string
  export function buildRange(from: string, to: string): string
  export function compare(a: string, b: string): number
  export function fromRange(range: Range, filter?: (node: Node) => number): string
  export function toRange(doc: Document, parts: unknown, filter?: (node: Node) => number): Range
  export const fake: { fromIndex(index: number): string; toIndex(part: unknown): number }
}

declare module '@octavo/foliate/view.js' {
  import type { Overlayer, DrawFn, DrawOptions, OverlayRect } from '@octavo/foliate/overlayer.js'

  export type LangMap = string | Record<string, string>
  export interface Contributor { name?: LangMap; [k: string]: unknown }
  export interface BookMetadata {
    title?: LangMap
    author?: string | Contributor | Array<string | Contributor>
    language?: string | string[]
    [k: string]: unknown
  }
  export interface TocItem { label?: string; href?: string; subitems?: TocItem[] | null }
  export interface Section {
    id: string | number
    size?: number
    linear?: string
    cfi?: string
    createDocument?: () => Promise<Document>
    resolveHref?: (href: string) => string
  }
  export interface Resolved { index: number; anchor?: (doc: Document) => Range | Element }
  export interface TransformDetail { type: string; name?: string; data: string | Promise<string> }
  export interface Book {
    metadata?: BookMetadata
    toc?: TocItem[] | null
    pageList?: TocItem[] | null
    sections: Section[]
    dir?: string
    rendition?: { layout?: string }
    transformTarget?: EventTarget & {
      addEventListener(type: 'data', listener: (e: CustomEvent<TransformDetail>) => void): void
    }
    getCover?: () => Promise<Blob | null>
    resolveHref(href: string): Resolved | null
    resolveCFI?: (cfi: string) => Resolved
    isExternal?: (href: string) => boolean
  }
  export function makeBook(file: File | string): Promise<Book>
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}

  export interface SectionContents { index: number; doc: Document; overlayer?: Overlayer }
  /** The paginator / fixed-layout element. */
  export interface Renderer extends HTMLElement {
    readonly page: number
    readonly pages: number
    readonly primaryIndex: number
    readonly scrolled?: boolean
    getContents(): SectionContents[]
    setStyles?(styles: string | [string, string]): void
    render?(): void
    scrollBy?(dx: number, dy: number): void
    scrollToAnchor?(anchor: Range | Element, select?: boolean, smooth?: boolean): Promise<void>
    nextSection?(): Promise<void>
    prevSection?(): Promise<void>
    goTo(target: Resolved): Promise<void>
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    destroy(): void
  }

  export interface ProgressItem { label?: string; href?: string }
  export interface RelocateDetail {
    cfi: string
    fraction: number
    range?: Range
    tocItem?: ProgressItem | null
    pageItem?: ProgressItem | null
    section?: { current: number; total: number }
    location?: { current: number; next: number; total: number }
    time?: { section: number; total: number }
  }
  export interface Annotation { value: string; color?: string; style?: string; id?: string; kind?: string }
  export interface SearchExcerpt { pre: string; match: string; post: string }
  export interface SearchMatch { cfi: string; cfis?: string[]; excerpt: SearchExcerpt }
  export type SearchResult =
    | 'done'
    | { progress: number; subitems?: undefined }
    | { index: number; label: string; subitems: SearchMatch[] }
    | (SearchMatch & { subitems?: undefined })

  export interface TTS {
    doc: Document
    start(): string | undefined
    resume(): string | undefined
    next(paused?: boolean): string | undefined
    prev(paused?: boolean): string | undefined
    from(range: Range): string | undefined
    setMark(mark: string): Range | undefined
    getLastRange(): Range | undefined
  }

  export interface ViewEventMap {
    relocate: CustomEvent<RelocateDetail>
    load: CustomEvent<{ doc: Document; index: number }>
    'create-overlay': CustomEvent<{ index: number }>
    'draw-annotation': CustomEvent<{ draw: (fn: DrawFn, opts?: DrawOptions) => void; annotation: Annotation; doc?: Document; range: Range }>
    'show-annotation': CustomEvent<{ value: string; index: number; range: Range; rect?: OverlayRect }>
    'external-link': CustomEvent<{ a: HTMLAnchorElement; href: string }>
    link: CustomEvent<{ a: HTMLAnchorElement; href: string }>
  }

  export class View extends HTMLElement {
    book: Book
    renderer: Renderer
    isFixedLayout: boolean
    lastLocation: RelocateDetail | null
    tts: TTS | null
    addEventListener<K extends keyof ViewEventMap>(type: K, listener: (this: View, ev: ViewEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
    open(book: Book | File | string): Promise<void>
    close(): void
    init(opts: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>
    goTo(target: string | number): Promise<Resolved | undefined>
    goToFraction(frac: number): Promise<void>
    goLeft(): Promise<void>
    goRight(): Promise<void>
    prev(distance?: number): Promise<void>
    next(distance?: number): Promise<void>
    addAnnotation(annotation: Annotation, remove?: boolean): Promise<{ index: number; label: string } | undefined>
    deleteAnnotation(annotation: Annotation): Promise<{ index: number; label: string } | undefined>
    getCFI(index: number, range?: Range): string
    resolveCFI(cfi: string): Resolved
    resolveNavigation(target: string | number | { fraction: number }): Resolved | undefined
    getSectionFractions(): number[]
    search(opts: { query: string; index?: number; [k: string]: unknown }): AsyncGenerator<SearchResult, void, undefined>
    clearSearch(): void
    initTTS(granularity?: 'word' | 'sentence', nodeFilter?: (node: Node) => number, highlighter?: (range: Range) => void): Promise<void>
  }
}
