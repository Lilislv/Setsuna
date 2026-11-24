# Work Log — `gemini-4-neon` (`lambdawesta` side)

> **Owner:** `lambdawesta` · **Model:** `gemini-4-neon`
> **Rule:** Only this model on `lambdawesta`'s side appends to this file (newest entries at the top). Other agents/developers should **read** this log for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-24 — Multi-Format Reader Support: FB2/FB2.ZIP, HTML, Markdown, Aozora TXT, DOCX, MOBI/AZW3 & PDF Reader (`feature/book-formats`)

- **Isolated Rust format parsers (`src-tauri/src/book_formats/`, wired cleanly via `src-tauri/src/epub_import.rs`):**
  - `book_formats/mod.rs`: shared `ParsedBook` / `ParsedSection` pipeline, automatic text & XML encoding detection (`encoding_rs` + `chardetng`), heading-based chapter & ToC splitting, full-text search, gallery image extraction, and safe relative local image inlining.
  - `book_formats/txt_aozora.rs`: upgraded `.txt` reader with automatic UTF-8 / Shift-JIS / EUC-JP / Windows-1251 / UTF-16 decoding and Aozora Bunko markup (`｜漢字《かんじ》` & `漢字《かんじ》` -> `<ruby>`, `［＃「...」に傍点］` -> `data-epub-emphasis`, Aozora header title/author extraction).
  - `book_formats/fb2.rs`: `.fb2` and `.fb2.zip` FictionBook 2.0 parser (`roxmltree` + bare-`&` fallback, `<description>/<title-info>` metadata including `sequence`/series, `<binary>` cover & illustrations, recursive `<section>` chapters + ToC, epigraphs/poems/cites, `<body name="notes">`).
  - `book_formats/html_md.rs`: standalone `.html`/`.htm`/`.xhtml` and `.md`/`.markdown` (`pulldown-cmark` with tables/strikethrough/footnotes/tasklists + optional YAML frontmatter + heading-based ToC).
  - `book_formats/docx.rs`: `.docx` OpenXML parser (`docProps/core.xml` metadata, headings/lists/tables, embedded `word/media/` images, and Japanese `<w:ruby>` furigana).
  - `book_formats/mobi.rs`: pure-Rust DRM-free `.mobi` / `.azw3` / `.prc` parser (PalmDB + MOBI/KF8 combo header + EXTH metadata + PalmDOC LZ77 & HUFF/CDIC decompression + cover + `<img recindex>` images + explicit DRM rejection error).
  - Added `epub_read_binary` Tauri command (`src-tauri/src/epub_import.rs`, registered in both `src-tauri/src/main.rs` and `src-tauri/src/lib.rs`) returning raw `tauri::ipc::Response` bytes for binary formats (`.pdf`), and expanded storage/pruning/folder-scan/Google Drive download extension whitelists (handling compound `.fb2.zip`).
- **Interactive PDF Reader (`src/features/epub/PdfReader.tsx`, `src/features/epub/pdfModel.ts`, `src/features/epub/pdf.css`, lazy-loaded from `EpubWorkspace.tsx`):**
  - Powered by `pdfjs-dist` with local Vite-bundled `pdf.worker.min.mjs` (offline Desktop + Android).
  - **Page View:** HiDPI `<canvas>` + aligned interactive text overlay where clicking/tapping (or desktop Shift-hover) looks up words directly in `Lookuper` + Anki; zoom (`Fit` / steps), night color-invert filter, keyboard & touch-swipe paging.
  - **Text / Reflow View:** 1-tap toggle rendering grouped page lines through Setsuna's `TokenizedLine` component.
  - Outline/ToC drawer, full-document PDF search drawer, page jump input, auto-generated Page-1 cover cached in `epubCoverCache`, reading progress persistence, and monotonic reading stats.
- **Frontend, Sync & Android Wiring:**
  - Expanded `SUPPORTED_BOOK_EXTENSIONS` / `BookFileExt` (`src/features/epub/epubModel.ts`, `src/utils/constants.ts`, `src/features/epub/epubSyncModel.ts`), desktop picker & drag-and-drop (`src/App.tsx`, preventing `.fb2.zip` from being hijacked by dictionary `.zip` drop handler), RU/EN strings (`src/utils/i18n.ts`), and Android picker (`MainActivity.kt`, `MobileFileBridge.kt`).
- **Verification:**
  - `npm run build` (`tsc && vite build`), `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (**48 / 48** pass), `cargo check --no-default-features`, and all 6 new Rust format tests in `epub_import` pass (note: pre-existing `extracts_cover_from_first_chapter_fallback` expects `image/jpeg` on PNG fixture from earlier commit `51f18ab`).
