# Octavo patches to foliate-js
- Removed vendor/pdfjs and pdf.js: Octavo renders PDF with Obsidian bundled pdf.js (loadPdfJs).
- tags.js: custom-element names get a per-build suffix (__FOLIATE_SUFFIX__) and define() is idempotent, so plugin reloads/updates never throw 'already defined'. Touches view.js, paginator.js, fixed-layout.js, footnotes.js, quote-image.js.
