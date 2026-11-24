# Work Log — `gemini-4-neon` (`seri` / `Lilislv` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `gemini-4-neon`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers should **read** this log for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-24 — Mobile Manga OCR Suite (ONNX INT8 + ML Kit, LAN PC GPU Server, .cbz Pack Export; local unpushed)

- **Desktop `manga_import.rs`:** added `manga_export_mobile_cbz` packing volume images + embedded `.mokuro` (applying saved OCR typo overrides) into a single portable `.cbz` (+ Pack .cbz for Phone in `MangaReader.tsx`).
- **PC GPU OCR & LAN Wi-Fi Server (`src-tauri/src/manga_ocr_server.rs`, registered in `main.rs` & `lib.rs`):** persistent Python `manga-ocr` worker (CUDA RTX / CPU) + LAN HTTP server (`GET /health`, `POST /ocr`, default port `47123`, optional Bearer token) + cross-platform `manga_ocr_remote_health` & `manga_ocr_remote_recognize` HTTP client commands.
- **Android ONNX Runtime + ML Kit (`MangaOcrBridge.kt`, `MainActivity.kt`, `build.gradle.kts`, `manga-ocr.pro`):**
  - Added `com.microsoft.onnxruntime:onnxruntime-android:1.20.0` and `com.google.mlkit:text-recognition-japanese:16.0.1`.
  - `SetsunaMangaOcr` JS bridge: on-demand downloader (~117 MB INT8 `kimchireader/manga-ocr-onnx-q8` weights + `vocab.txt` -> `filesDir/models/manga-ocr` with progress events), local Vision-Encoder-Decoder ONNX inference, ML Kit single-crop OCR + full-page bubble block detector.
- **Reader & Settings UI (`mangaOcr.ts`, `SettingsMangaOcr.tsx`, `SettingsModal.tsx`, `MangaReader.tsx`, `manga.css`):**
  - Added `✂ OCR` interactive drag-to-crop selector (hotkey `S`), live result bar with `TokenizedLine` dictionary lookup + Anki panel crop + `+ Бабл` session pin, mobile ML Kit page scan with optional ONNX/PC refinement, and `Settings → EPUB → Манга и OCR` panel.

## 2026-11-24 — Manga bubble overlay polish (local unpushed)

- `mangaModel.ts`: new `computeFittedBubbleFontPx(block)` (unit-tested) — font fitted to OCR box + line count, so text never clips.
- `MangaReader.tsx`: active bubble cleared on mouseleave / when the lookup popup closes / on stage click (overlay no longer sticks until page turn).
- `manga.css`: removed `overflow: hidden` clipping, `text-orientation: mixed`, gothic JP font, ✎ button moved to bottom-left & smaller.

## 2026-11-24 — Native Mokuro Manga Reader Inside Books Library (Desktop + Android, local unpushed)

- **Rust manga backend (`src-tauri/src/manga_import.rs`, registered in both `main.rs` & `lib.rs`):**
  - Supports image folders, `.cbz`/`.zip` archives, `.mokuro` / `.mokuro.gz` v0.2+ overlays (sibling, embedded inside `.cbz`, or attached sidecar under `app_data_dir/manga-mokuro/`), and legacy v0.1 `_ocr/*.json`.
  - Commands: `manga_open`, `manga_cover`, `manga_page`, `manga_store`, `manga_attach_mokuro`, `manga_load_overrides`, `manga_save_override`, `manga_scan_folder`, `manga_mokuro_status`, `manga_run_mokuro`.
  - Desktop `mokuro` CLI integration detects `mokuro` / `python -m mokuro`, runs OCR in background with `manga_mokuro_progress` events, and auto-reloads the generated `.mokuro` layer onto the open volume.
- **Manga Reader UI (`src/features/manga/MangaReader.tsx`, `manga.css`, `mangaModel.ts`, `mangaApi.ts`):**
  - Single page / 2-page RTL spread with cover offset (`C`) / vertical strip (`D`), fit-height/width/1:1, `Ctrl+Wheel` zoom, keyboard & touch swipe + Android hardware volume-key paging.
  - Three OCR overlay modes (`O`): art-first `Hover` (invisible until hovered/tapped), `Outline`, and `Readable` text — rendered through Setsuna's `TokenizedLine` for native dictionary lookup (`Shift` hover on PC, tap on Android) plus inline OCR typo editor (`✎`) persisted per volume.
  - Offscreen `<canvas>` Anki panel cropping (`bubble` smart panel crop vs `full` page) wired directly into `LookupSurface`'s `screenshotSource` for 1-click Anki picture cards.
  - Monotonic high-water page tracking feeds `.mokuro` character counts into daily reading stats.
- **Books library & Android integration (`EpubLibrary.tsx`, `EpubWorkspace.tsx`, `App.tsx`, `AppLayout.tsx`, `constants.ts`, `epubSyncModel.ts`, `useEpubSync.ts`, `MainActivity.kt`, `MobileFileBridge.kt`):**
  - Added `Все / Книги / Манга` filter pill (shown when manga exists), `MOKURO` / `МАНГА` badges, `.cbz`/`.zip`/`.mokuro` picker + folder/drag-and-drop auto-detection, and Android picker MIME/extension support.
- **Verification:** `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (55/55 pass, including `tests/manga-model.test.mjs`), `cargo check --no-default-features`.

---

## 2026-11-24 — Switch Windows System-Wide Live Scan to `Shift+Z` & Remove Legacy `Alt+Q` Mode (local, unpushed)

- **Unified live scan combo (`src-tauri/src/global_lookup.rs`):**
  - Replaced single-modifier polling (`Shift`) with packed `AtomicU32` shortcut bitmask (`mods | (vk << 8)`), defaulting to **`Shift+Z`** (physical `VK_Z = 0x5A`, works identically across EN / RU / JP keyboard layouts) and supporting any modifier+key or `F1–F12` combination recorded via `ShortcutRecorder`.
  - Excluded the active scan key from `is_any_other_typing_key_down` so holding `Shift+Z` never self-suppresses; automatically migrates legacy saved bare `"Shift"` / `"Alt"` settings to `Shift+KeyZ`.
- **Removed legacy `Alt+Q` mode across all builds (`src-tauri/src/main.rs`, `src/components/Settings/SettingsLookup.tsx`, `src/lookup-window.tsx`, `src/utils/constants.ts`):**
  - Removed `register_lookup_agent_shortcut`, `update_lookup_agent_shortcut`, `tauri_plugin_global_shortcut` plugin registration, and old `activateLookup`/`handleLiveHoverScan` handlers across all builds, leaving the unified **"Скан по всему Windows (удерживая)"** shortcut recorder defaulting to `Shift+Z`.
- **Verification:** `cargo check --no-default-features`, `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (47/47 pass).

---

## 2026-11-24 — System-Wide Windows Lookup Upgrade (Selection + UIA + Yomitan Popup) & Mobile Drive/Vertical Reader Fixes

- **System-wide Windows lookup engine (`src-tauri/src/global_lookup.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`):**
  - New isolated Rust module `global_lookup.rs` with **live continuous hover-scan watcher** (TextHooker/Yomitan-style: hold `Shift`/`Alt`/`Ctrl+Shift`/`Ctrl+Alt` and glide mouse across any Windows app without stealing focus via `SetWindowPos(..., SWP_NOACTIVATE | SWP_SHOWWINDOW)`), persistent thread-local `IUIAutomation` COM session (~1–3 ms/probe), and **pixel-accurate character hit-testing** (`GetBoundingRectangles` via `Win32_System_Ole` to fix Windows UIA's right-half caret rounding off-by-one bug, e.g. hovering `記` in `記憶の片隅` now hits `記憶` instead of `憶`).
  - One-shot `Alt+Q` cascade combining: (1) non-intrusive UIA `TextPattern::GetSelection()`, (2) Scintilla word capture, (3) UIA `TextPattern` / `TextPattern2` / `TextChildPattern` exact cursor + clipped sentence, (4) safe clipboard-preserving `Ctrl+C` selection probe (releases held hotkey modifiers, checks `GetClipboardSequenceNumber()`, restores original clipboard text) for Telegram, Discord, Chrome/Vivaldi, PDF readers, and (5) `ValuePattern` / `CurrentName` fallback with bounding-box cursor estimate + Lindera enclosing-token snap.
  - Added `read_system_clipboard_text` & `update_global_live_scan_config` commands, DPI-aware Yomitan placement (flips above cursor near screen bottom) in `show_lookup_agent_window`, global outside-click & Escape dismissal for unfocused live popups, previous foreground `HWND` restoration on Esc, and repeat-hotkey support while `lookup_external` is open.
- **Yomitan-style external popup (`src/lookup-window.tsx`, `src/lookup-window.css`, `src/components/Settings/SettingsLookup.tsx`, `src/utils/constants.ts`, `src/components/SettingsModal.tsx`):**
  - Compact draggable header with live search input, `📋` clipboard lookup, `▣` region capture, `📌` pin toggle (auto-close on blur when unpinned), collapsible `⚙` Anki deck & auto-bound active-window screenshot drawer, and interactive `TokenizedLine` sentence strip so users can click any neighboring word without re-triggering the hotkey.
  - Added settings `globalLookupUseSelection` and `globalLookupAutoClose` (both default `true`).
- **Mobile EPUB & Google Drive fixes (`src/components/AppLayout.tsx`, `src/features/epub/useEpubSync.ts`, `src/features/epub/EpubWorkspace.tsx`, `src/features/epub/EpubReader.tsx`, `src/features/epub/EpubLibrary.tsx`, `src/features/epub/epub.css`, `src/components/MobileShell.css`, `src/components/TextContainer.tsx`, `src/App.tsx`):**
  - Fixed Android Google Drive `OAuth state mismatch` (clean up previous `oauth_code` listener + persist PKCE sessions in `sessionStorage`), wired `settings.gdriveRefreshToken` fallback into `useEpubSync`, opened Drive settings directly (`'drive'`), preserved Library vs Reader `viewMode` across Settings unmount, fixed `.m-page` safe-area scrolling under status bar, hid duplicate mobile shell bars in EPUB reader mode, switched mobile reader toolbar to a single 38px row with 1-tap `縦`/`横`, and added authentic EPUB `<ruby>` rendering (`furiganaMode="epub"`) inside `TokenizedLine`.

---

## 2026-11-23 — Discrete Vertical Pagination, Backward Section Nav, Vertical Mobile Lookup Context, Stats Tracker Fix & Full Mobile EPUB Parity

- **Discrete vertical-rl pagination (`src/features/epub/EpubReader.tsx`, `src/features/epub/epub.css`):**
  - Unified horizontal & vertical paged modes under `isDiscretePaged` using `.epub-page-measurer` (`writing-mode: vertical-rl` measuring paragraph widths) so vertical columns are NEVER sliced in half on Desktop or Android, with RTL page-turn animations and proper mobile top/bottom clearance (`66px`/`70px`).
- **Backward section navigation & last-page landing:**
  - Fixed 1-page sections (like `目次`) being trapped from navigating backward (`metrics.max <= 1` now satisfies both `atStart` and `atEnd`); turning back across a section boundary now lands cleanly on the **last page** of the previous section (`pendingStartAtEndRef`), and `«` always falls back to `chapterIndex - 1` if earlier content exists.
- **Section labels & weighted progress (`EpubReader.tsx`, `EpubWorkspace.tsx`, `EpubLibrary.tsx`, `i18n.ts`):**
  - Bottom bar now shows actual ToC section title + page + chars + %, replacing `"Глава X из Y"` with `"Раздел / Section"`; fixed `handleSelectChapter` to use `computeWeightedBookProgress` instead of naive spine file index (`17%` on `目次` -> `0%`).
- **Honest EPUB-only stats tracker (`EpubReader.tsx`, `EpubStatsModal.tsx`, `dailyStats.ts`):**
  - Replaced reversible `lastTrackedParaRef` with monotonic per-chapter `highWaterByChapterRef` + 1.2s minimum page dwell guard so back/forth page turning or rapid skimming never inflates char counts; filtered EPUB stats & heatmap to EPUB tabs only (`sumDayForTabs`) and added 1-click "Reset EPUB stats" (`resetDailyStatsForTabs`).
- **Vertical mobile lookup context & kinsoku (`Lookuper.tsx`, `MobileShell.css`, `TextContainer.tsx`, `App.tsx`):**
  - Added `verticalContext` prop to `Lookuper` so the mobile lookup sentence card renders in `writing-mode: vertical-rl` (and centers the tapped word) whenever the active reader is vertical; glued closing Japanese punctuation (`。、」』！？`) to preceding `.lookup-word` buttons in `TokenizedLine` to eliminate dangling punctuation.
- **Full Mobile EPUB Parity (`EpubReader.tsx`, `AppLayout.tsx`, `App.tsx`, `MainActivity.kt`, `MobileFileBridge.kt`):**
  - Compact wrapping mobile top bar showing `[←]` + `[ToC]` + all tools (Reading Point, Notes, Bookmarks, Gallery, Audio/Sasayaki, Search, Orientation, `Aa`), wired EPUB `Aa` furigana setting into mobile `TokenizedLine`, forwarded all desktop EPUB props to `MobileLayout`, and enabled `.txt`/`.htmlz` alongside `.epub` in Android's file picker.

---

## 2026-11-23 — Sasayaki-Style Full-Book Audiobook Sync Engine, Auto-Pause & Anki Audio Mining (`0b26a5c`)

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
