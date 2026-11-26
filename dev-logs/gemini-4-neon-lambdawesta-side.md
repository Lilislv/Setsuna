# Work Log — `gemini-4-neon` (`lambdawesta` side)

> **Owner:** `lambdawesta` · **Model:** `gemini-4-neon`
> **Rule:** Only this model on `lambdawesta`'s side appends to this file (newest entries at the top). Other agents/developers should **read** this log for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-26 — Telegram-Style Scroll Chapter Switching, Full-Featured PDF Reader & Android/Reader Tests (`feature/reader-scroll-pdf-polish`)

- **Telegram-style elastic overscroll chapter switching in EPUB scroll mode (`src/features/epub/epubScrollBoundary.ts`, `src/features/epub/EpubReader.tsx`, `src/features/epub/epub.css`):**
  - Pure boundary state machine (`detectScrollEdges`, `computeRubberBandPx`, `advanceWheelOverscroll`, `computeTouchPullState`) supporting both `horizontal-tb` vertical scroll and `vertical-rl` RTL scroll on Desktop & Android.
  - **Automatic & smooth:** Desktop wheel/trackpad overscroll fills a Telegram-style SVG progress ring (`WHEEL_TRIGGER_PX = 260`) and switches chapters automatically with a 700ms cooldown; Android touch pull applies damped rubber-band stretch (`<= 46px`), flips the arrow & vibrates at `88px` (release-to-switch), and auto-triggers at `136px` without lifting the finger; continuous autoscroll now advances smoothly across chapter boundaries instead of stopping at chapter end; subtle clickable chapter-end footer added for both normal & virtualized scroll.
  - Added spring slide-in enter animations (`epub-scroll-enter-next` / `epub-scroll-enter-prev`, disabled in `data-epub-eink="true"`).
- **Full-featured PDF reader upgrade (`src/features/epub/pdfModel.ts`, `src/features/epub/PdfReader.tsx`, `src/features/epub/pdf.css`, `src/features/epub/EpubWorkspace.tsx`):**
  - **Layouts & Reflow:** Page / Spread (2-up desktop) / Continuous Scroll (`IntersectionObserver` lazy canvas lifecycle to stay light on Android RAM) + Text/Reflow toggle (`TokenizedLine`) with horizontal and `vertical-rl` support; automatic vertical Japanese PDF column detection (`groupPdfTextItemsIntoLines` right-to-left column ordering).
  - **`Aa` Appearance & Gestures:** Fit Width / Fit Page / custom zoom (`Ctrl+Wheel` + Android 2-finger pinch-to-zoom via `computePinchScale`), 90° page rotation, 4 PDF color themes (`original`, `sepia`, `dark`, `eink`), `ResizeObserver` refit, auto-hiding LiquidGlass chrome, Zen Mode (`Z`), Android hardware volume-key paging, and complete `useMobileBackHandler` overlay stack.
  - **4-Tab Drawer & Annotations:** Outline/ToC, lazy Page Thumbnails grid, Bookmarks (`B`, synced via Drive), Notes (synced via Drive), Reading Point (`⌖` / `O` / `R`), floating selection pill (`Lookup` / `Copy` / `+ Note`), interactive bottom page scrubber, and daily stats integration.
- **Tests & Beta Diagnostics Review (`tests/epub-reader-mobile.test.mjs`, analyzed `setsuna-diagnostics.log`):**
  - Added unit tests covering EPUB scroll-edge detection (horizontal-tb + vertical-rl), wheel & Android touch pull state machines, vertical JP PDF column grouping, fit/pinch math, and Android Back stack peeling for PDF overlays.
  - Reviewed tester's Windows `setsuna-diagnostics.log`: EPUB reading itself was healthy (`12–33 MB` JS heap, 0 errors); the real issue (`dictionary.db` growing `0 -> 1.48 GB -> 3.24 GB` with silent lookups after interrupted dictionary import) was already resolved on `dev` in `fbc9463` (`repair_dictionary_database`, `hoverScan.ts` 4s timeout, `Lookuper.tsx` Shift+click guard).
- **Verification:** `npm.cmd run build` (0 TS errors), `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (**86 / 86 pass**), and `cargo check --no-default-features --manifest-path src-tauri/Cargo.toml` all green.

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
