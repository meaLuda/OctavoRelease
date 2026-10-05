# Octavo

**Read EPUB and PDF books in Obsidian, with highlights that live in your vault as linked Markdown.**

Octavo is a calm, full-featured book reader for Obsidian on desktop, iPhone, iPad and Android.

- **EPUB, PDF, MOBI, AZW3, FB2 and CBZ**: themes, fonts and spacing, page turns, two-page spreads, and a full-screen focus mode.
- **Highlights are notes.** One tap saves a highlight to the book's note as Markdown, with a deep link back to the exact passage.
- **Your notes in the margins.** Any note that links into a book shows up in the text. Hover over it to preview.
- **PDF++ links keep working.** Importers bring in highlights from Annotator, Weave, Elton, Kindle, KOReader, Readest and others.
- **A real library**: covers, Continue Reading, shelves and collections, built on your notes so they work with Bases and search.
- **Read-aloud** with your system voices, plus optional AI (your own API key or a local model through Ollama).
- **Goals and streaks** if you want them, logged to your daily note. Nothing leaves your device.

Website: https://octavo.devformat.tools

## Install

In Obsidian, go to **Settings → Community plugins → Browse**, search for **Octavo**, then select **Install** and **Enable**.

## Octavo Cloud (optional)

The reader is free and works fully offline. **Octavo Cloud** is an optional paid subscription for hosted services that cost money to run:

- a cloud library that keeps books outside your vault
- Send-to-Octavo email inbox
- OCR for scanned PDFs
- natural neural voices
- KOReader progress sync
- hosted AI, on the Cloud + AI plan

Plans and prices are on the website. No free feature will ever be moved behind the paywall.

## Disclosures

- **Closed source.** This plugin is closed source. This repository contains only the released files. Obsidian's reviewers have read access to the source.
- **Payments.** Octavo Cloud features require a paid subscription. All reader features are free.
- **Account.** Octavo Cloud features need an Octavo account (email sign-in code, no password). The reader needs no account.
- **Network use.** Octavo makes network requests only when you use these features:
  - **Octavo Cloud** (`octavo.devformat.tools`): signing in, checking your plan, uploading and downloading cloud-library books, OCR and natural-voice jobs, and checkout.
  - **AI providers you configure yourself**: Anthropic, OpenAI or a local Ollama server, with your own key.

  Nothing is sent in the background.
- **No telemetry, no ads.** Octavo collects no usage data and shows no advertising.
- **Local storage.** Covers, tables of contents and book caches are kept in Obsidian's per-device browser storage (IndexedDB) and are never synced. Your highlights, notes and progress are plain files in your vault.
- **Files outside the vault.** Octavo does not read or write files outside your vault.

Privacy policy: https://octavo.devformat.tools/privacy.html · Terms: https://octavo.devformat.tools/terms.html

## Support

Email **eliud@munyala.pro** or open an issue in this repository.

## Licence

Free to use. Copyright © 2026 Munyala Eliud (MEA Tech). See [LICENSE](LICENSE). Third-party components and their licences are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
