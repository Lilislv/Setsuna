# Work Log — `gemini-4-neon` (`seri` / `Lilislv` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `gemini-4-neon`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers should **read** this log for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-23 — Sasayaki-Style Full-Book Audiobook Sync Engine, Auto-Pause & Anki Audio Mining

- **Rust full-book alignment engine (`src-tauri/src/epub_audio.rs`, registered in both `main.rs` & `lib.rs`):**
  - Commands: `epub_audio_allow_file` (grants `asset_protocol_scope().allow_file` + auto-detects sibling `.srt`/`.vtt` and `.cue`), `epub_audio_align`, `epub_audio_align_text`, `epub_audio_load_alignment`, `epub_audio_clear_alignment`.
  - Flattens all EPUB chapters into normalized character stream with trigram/bigram anchor indexing + bounded edit-tolerant monotonic alignment + gap interpolation + CUE sheet parser (supports minutes > 60).
  - Benchmarked on real Japanese light novel *Slayers Vol. 1* (`1.epub` + `Slayers01.srt` + `.cue`): **69,152 / 69,600 chars (99.4%)**, 3,628 / 3,632 cues, 3,096 paragraphs, 10 chapters in 0.74s (debug).
  - Disk cache under `app_data_dir/epub-audio/align_<hash>.json`.
- **Frontend Sasayaki-style UI & sync (`src/features/epub/EpubAudioBar.tsx`, `src/features/epub/epubAudioStorage.ts`, `src/features/epub/EpubReader.tsx`):**
  - Persistent per-book audio/SRT/CUE linking + resume timestamp in `localStorage["setsuna-epub-audio-links-v1"]`.
  - Three sub-tabs: **Resources** (link `.m4b`/`.mp3`, auto-detect sibling `.srt`/`.cue`, **Match** button with exact char `%` & **Export SRT**), **Chapters** (`.cue` / aligned ToC timestamps), **Settings** (auto-follow across pages & chapters, auto-pause on dictionary lookup, skip interval).
  - Unobtrusive bottom-left mini playback bar (`« ▶ » · time · ⌖`) while reading; **Alt+Click** any paragraph or click `⌖` to seek audio to text.
  - **Live Anki audiobook clip mining:** binds aligned `.text-line` paragraphs into `subtitleScenes` (`src/features/player/mining.ts`, `audioOnly: true`) so clicking `+` in the dictionary automatically cuts the narrator's spoken sentence from `.m4b`/`.mp3` via FFmpeg into Anki.

---

## 2026-11-23 — Desktop Anime Player Workspace, Dual Subtitles, Scene Mining & HLS (authored with ChatGPT on `seri`'s side, verified & pushed)

- **New module:** `src/features/player/*` (`PlayerWorkspace.tsx`, `PlayerCardEditor.tsx`, `SubtitleTracks.tsx`, `model.ts`, `mining.ts`, `usePlayerSource.ts`, `useCompatibleVideo.ts`, `webMedia.ts`, `player.css`) replacing legacy `src/components/PlayerSkeleton.tsx`; docs in `docs/anime-player.md`.
- **Capabilities:**
  - Enabled on desktop (`ANIME_PLAYER_AVAILABLE = !isMobilePlatform()` in `src/utils/featureFlags.ts`); supports local video files/queues (natural episode sort, position resume), direct HTTPS URLs, HLS VOD (`hls.js`), and HTML `<video>` pages.
  - Dual subtitle tracks (SRT, VTT, ASS, SSA, embedded FFprobe text tracks), lookup integration via `Lookuper.tsx` / `TextContainer.tsx`, study modes (cue pause, skip/speed pauses, A–B loop, repeat).
  - Scene Anki mining (`src/utils/anki.ts`, `PlayerCardEditor.tsx`): exports 5s lead-in MP4/MP3 clip + frame via FFmpeg and cleans up temp clips after AnkiConnect responds.
- **Rust & Config changes:**
  - `src-tauri/Cargo.toml`: enabled `protocol-asset` feature on `tauri`; `src-tauri/tauri.conf.json`: enabled `assetProtocol`.
  - `src-tauri/src/player_media.rs` & `src-tauri/src/main.rs`: registered desktop Tauri commands `discard_player_clip`, `player_subtitle_tracks`, `player_subtitle_text`, `player_scene_frame`, `player_web_text`, `prepare_player_video`, `release_player_video`.
- **Tests:** Added `tests/player.test.mjs` — all **41 / 41** tests pass, `npm run build`, `verify-public-build.mjs`, and `cargo check --no-default-features` all green.

---

## 2026-11-23 — Discord Push/PR Notifications for `dev` & Per-Model Dev Logs (`67254ee`, `090f797`)

- **Per-model dev logs (`AGENTS.md`, `dev-logs/`):** Switched from a single `DEV_LOG.md` to per-model/developer logs (`dev-logs/<model-name>-<developer>-side.md`) so parallel work never causes log merge conflicts.
- **Discord notifications (`.github/workflows/notify-dev-discord.yml`):**
  - Triggers on `push` to `dev` and `pull_request` (`opened` / `ready_for_review`) targeting `dev`.
  - Posts a rich embed via `secrets.DISCORD_DEV_WEBHOOK` listing commits, compare link, any updated `dev-logs/*.md` files, and `git fetch origin && git merge origin/dev`.
  - Optionally pings the *other* developer when `DISCORD_USER_ID_SERI` / `DISCORD_USER_ID_LAMBDAWESTA` secrets are configured. Skips cleanly if `DISCORD_DEV_WEBHOOK` is not yet set.

---

## 2026-11-23 — JLReq Japanese Typography, Folder Import, E-Ink, Volume Paging, Shelves, JSON Backup & TTS/Audiobook (`0a41b69`)

- **JLReq / EBPAJ Japanese Typography & Spread:**
  - Added `lang="ja"/"en"` to `.epub-reader-surface` & `.epub-page-measurer` (`src/features/epub/EpubReader.tsx`).
  - Added `ruby-align: center`, non-selectable `rt`/`rp`, `line-break: strict`, `hanging-punctuation: allow-end`, `word-break: normal` for `[lang="ja"]` (`src/features/epub/epub.css`).
  - Sanitizer (`src-tauri/src/epub_import.rs` → `build_sanitized_tag`) safely maps inline `text-emphasis` → `data-epub-emphasis` (bouten / 傍点) and `text-combine-upright` → `data-epub-tcy` (tate-chu-yoko / 縦中横).
  - Separate Japanese default paragraph gap `epubParagraphSpacingJa` (default `2px`; EN stays `14px`), widened 2-page spread (`spreadContainerMaxWidth`, `SPREAD_GAP = 81`), and subtle bottom-right char progress readout (`current / total · %`) + Goal Progress Light dot.
- **Recursive Folder Import:**
  - New Rust command `epub_scan_folder(dir)` in `src-tauri/src/epub_import.rs` (registered in **both** `main.rs` and `lib.rs`), TS wrapper `scanEpubFolder` in `src/features/epub/epubApi.ts`.
  - Walks subdirectories (max 500 books, depth 8, skips `.` hidden dirs/symlinks), uses immediate subfolder name as default `series`, skips duplicate titles. Wired to "Папка / Folder" button in `EpubLibrary.tsx` and folder drag-and-drop in `App.tsx`.
- **Android Volume-Key Page Turning & E-Ink Mode:**
  - Intercepted `KEYCODE_VOLUME_UP` / `KEYCODE_VOLUME_DOWN` in `MainActivity.kt` when `volumePagingEnabled` is active, exposed `setVolumePagingEnabled` via `MobileFileBridge.kt` and `src/utils/mobileFiles.ts`, wired to `EpubReader.tsx` (`epubVolumeKeyPaging`, default `true`).
  - Added high-contrast `epubEinkMode` (`data-epub-eink="true"`): `#000` on `#fff`, disables all animations/transitions/blur/shadows, renders highlights as crisp black underlines.
- **Custom Shelves & Portable Local JSON Backup:**
  - Added `shelves?: string[]` to `EpubBookData` (`constants.ts`), `EpubSyncBookEntry` (`epubSyncModel.ts`), and `RetainedBookRecord` (`epubLibraryModel.ts`, stored in `localStorage["setsuna-epub-custom-shelves"]`). Filter chips, create/delete, single-book & bulk assignment in `EpubLibrary.tsx`.
  - New pure module `src/features/epub/epubBackup.ts`: path-independent JSON backup export/import (progress, bookmarks, highlights, notes, shelves, series/tags, daily goals, and `dailyStats` via `exportDailyStatsSnapshot` / `mergeDailyStatsSnapshot` in `src/utils/dailyStats.ts`). Unmatched books are stored in retained data and auto-restored once the `.epub` is later added.
- **Built-in TTS Read-Along & Audiobook Player:**
  - New pure subtitle parser `src/features/epub/epubSubtitles.ts` (`.srt` & `.vtt`, binary search `findActiveCueIndex`, fuzzy JP/EN `matchCueToParagraphIndex`).
  - New dock component `src/features/epub/EpubAudioBar.tsx` wired into `EpubReader.tsx`: Web Speech API TTS (`ja`/`en` auto-voice, speed, active paragraph `.is-tts-active` highlight, auto page turn & chapter advance) + local audio player (`.mp3`/`.m4a`/`.m4b`/`.ogg`/`.wav`) with clickable synced subtitles.
- **Tests:** 37/37 unit tests passing in `tests/epub-model.test.mjs` (+tests for `epubSubtitles.ts` and `epubBackup.ts`).

---

## 2026-11-23 — Automatic Google Drive EPUB Sync (`f2dc413`)

- **What:** Automatic cross-device (PC ↔ Android) sync for EPUB reading position, bookmarks, highlights, notes, reading points, custom metadata/shelves, reading stats, and optional `.epub`/`.txt`/`.htmlz` book file backup via Google Drive AppData (`setsuna_epub_sync.json`).
- **Key files:**
  - `src/features/epub/epubSyncModel.ts` — conflict-free merge (`mergeEpubBookEntries`, `mergeManifestWithLocalTabs`, `buildEpubSyncFingerprint`). Note: keep free of runtime imports of other `.ts` files so `node --test` can import it directly.
  - `src/features/epub/useEpubSync.ts` — auto-sync hook (startup pull, focus pull, debounced push on progress/annotation changes, 1-click download for `cloudOnly` books).
  - `src-tauri/src/epub_import.rs` — new commands `epub_drive_upload` and `epub_drive_download` (registered in `main.rs` and `lib.rs`; uses `crate::http_client::builder()` which exists in both targets).
  - Settings: `epubAutoSync` (default `true`), `epubSyncUploadFiles` (default `true`) in `constants.ts` & `SettingsModal.tsx`.

---

## 2026-11-23 — Instant Cover Cache & Home → EPUB Resume Modal (`51f18ab`, `b985e49`)

- **Instant covers (`0ms`):** `src/features/epub/epubCoverCache.ts` downscales covers via `<canvas>` to WebP/JPEG thumbnails and caches them synchronously in `localStorage` so library covers appear immediately on open; removed slow CPU image re-encoding from debug Rust (`epub_import.rs`).
- **Resume modal:** Entering EPUB from Home when a book was previously read opens a modal ("Continue reading «Title»" vs "Go to library") (`EpubWorkspace.tsx`, `App.tsx`).
- **Page-turn animation:** Smoothed horizontal page-turn keyframes to `380ms` (`epub.css`).

---

## 2026-11-23 — Real EPUB Table of Contents & Library Card Fix (`1bbc09d`)

- **Real ToC:** `src-tauri/src/epub_import.rs` now parses EPUB 3 `nav.xhtml` (`epub:type="toc"`) and EPUB 2 `toc.ncx` into `bookMeta.toc: EpubTocItem[]` with `title`, `chapterIndex`, `fragment`, and `startChar`. `EpubReader.tsx` displays clean chapter cards with start char offset & per-section progress % instead of raw spine filenames.
- **Library card CSS:** Restored `.epub-book-card-body` / `.epub-progress-track` / `.epub-book-card-meta` layout in `EpubLibrary.tsx` & `epub.css`.

---

## 2026-11-23 — Full EPUB Reader & Library Feature Suite (`12859a6` .. `27fa463`)

- **Multi-import & UX:** Multi-file picker + multi-file drag-and-drop without auto-opening; removed desktop `WorkspaceShell` top bar in `EpubWorkspace.tsx`.
- **Metadata & Gallery:** OPF `series`/`seriesPosition` (EPUB 3 + Calibre), per-chapter `charCount` & `totalChars`, `epub_gallery` Rust command (`main.rs` + `lib.rs`).
- **Library (`EpubLibrary.tsx`, `epubLibraryModel.ts`):** Status shelves (`All/Reading/Unread/Completed`), Series/Author grouping with aggregate %, 7 book sorts + 4 group sorts + ↑/↓ directions, natural sorting (Arabic, JP kanji `第一巻..`, Roman numerals `I..XXX`, `上中下`, `NFKC`), Card Display popover, `Select Mode` + floating bulk action bar, single-book metadata editor, retained metadata/progress on delete (`setsuna-epub-retained-data`).
- **Reader (`EpubReader.tsx`, `epubHighlightDom.ts`, `epubQuoteCard.ts`, `EpubQuoteModal.tsx`, `EpubGalleryModal.tsx`, `epubTracker.ts`, `EpubStatsModal.tsx`):**
  - Furigana modes (`show`/`hover`/`hide`), smart spoiler image blur (`off`/`after-toc`/`all`), text indent/justify/pretty-wrap/vertical-grid.
  - Continuous-scroll autoscroll (`S`/`A`/`D`), Reading Point (`T`/`O`/`R`), Position Freeze (`E`), Tracking Pause (`P`), Zen Mode (`Z`), Bookmarks (`B`/`Shift+B`).
  - Illustration Gallery modal, inline 4-color Text Highlights + Book Notes drawer, Quote Card PNG generator.
  - Smart reading tracker (skip threshold, lookup-aware idle auto-pause), daily char/time goals, Goal Progress Light, and 365-day Stats & Heatmap modal wired to `src/utils/dailyStats.ts`.
  - *(Note: VN mode was intentionally excluded per user request.)*

---

## 2026-11-23 — Branch Setup & Parallel Merge (`b9c937f`, `07f9580`, `ec033fc`)

- Created shared integration branch `dev` (keeping `main` stable at `0.5.0 beta`).
- Merged `feature/epub` (EPUB/TXT/HTMLZ workspace & mobile reader) with local `0.5.1` WIP (shared reading P2P, Anki templates/deck picker, Google Drive dictionary share, local AI assistant panel, archive UX).
- Added `AGENTS.md` and `CLAUDE.md` collaboration rules.
