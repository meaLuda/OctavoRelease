// Types for the pdf.js that Obsidian bundles (5.3.x, loaded at runtime from /lib/pdfjs). Type-only: nothing here is bundled.
import type * as PdfjsLib from 'pdfjs-dist'
import type * as PdfjsViewer from 'pdfjs-dist/web/pdf_viewer.mjs'
export type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist'
export type { TextContent, TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'
export type { PDFViewer, EventBus, PDFLinkService, PDFFindController, PDFPageView } from 'pdfjs-dist/web/pdf_viewer.mjs'

export type PdfjsLibModule = typeof PdfjsLib
export type PdfjsViewerModule = typeof PdfjsViewer

declare global {
  interface Window {
    pdfjsLib?: PdfjsLibModule
    pdfjsViewer?: PdfjsViewerModule
  }
}
