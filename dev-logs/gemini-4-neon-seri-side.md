# Work Log — `gemini-4-neon` (`seri` / `Lilislv` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `gemini-4-neon`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers should **read** this log for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-26 (late night) — EPUB Sentence Splitting & Selection Dock Polish (PC + Mobile)
- Fixed ruby/furigana sentence fragmentation and Japanese/English sentence boundaries in `src/features/epub/epubSentences.ts`:
  - Rewrote `wrapParagraphHtmlSentences` to classify balanced inline tags (`<ruby>…</ruby>`, `<em>`, emphasis `<span>`, etc.) and keep them **inside** a single contiguous `<span class="epub-sentence" data-sentence-key="P:S" data-sentence-parity="0|1">` instead of wrapping inside `<ruby>` and breaking highlights at every furigana word.
  - Upgraded `splitTextIntoSentenceRanges` to keep Japanese inline quotes (`「待って！」と彼女は叫んだ。`), double-bracket thoughts (`『痛み？』と思った。`), parentheticals (`（本当に！？）`), and English dialogue tags (`"Wait!" she shouted.`) intact, and to split `<br/>` line breaks cleanly.
  - Expanded `tests/epub-sentences.test.mjs` covering contiguous `<ruby>` wrapping, `<br/>` splitting, JA inline quotes/thoughts/parens, and EN dialogue attribution.
- Redesigned sentence & bubble selection UI in `src/features/epub/EpubReader.tsx`, `src/features/epub/epub.css`, `src/features/manga/MangaReader.tsx`, and `src/features/manga/manga.css`:
  - Docked `.epub-sentence-bar` and `.manga-select-bar` cleanly at **bottom center** (hiding `bottomChromeVisible` and `.epub-corner-status` while selecting) so the bar never covers vertical or horizontal book text.
  - Replaced noisy dotted underlines with clean alternating sentence tints (`data-sentence-parity="0"` / `"1"`), imperative unified `.is-hovered` highlighting across all fragments of a `data-sentence-key`, crisp `.is-selected` borders, and a prominent primary blue `Скопировать (N)` / `Copy (N)` CTA.
  - Added `Ctrl+C` and `Enter` copy shortcuts and fixed stale `Escape` closure dependencies in both `EpubReader` and `MangaReader`.

---

## 2026-11-26 (late night) — Visible EPUB Sentence & Manga Bubble Copy (PC + Mobile)
- Updated `src/features/epub/epubSentences.ts` (`EpubSentenceItem.html` + balanced inline tag slicing `buildPerSentenceHtml`) so each split JA/EN sentence keeps its own `<ruby>`/`<rt>`/`<mark>` HTML while `.text` stays clean without furigana; expanded `tests/epub-sentences.test.mjs`.
- Updated `src/features/epub/EpubReader.tsx` and `src/features/epub/epub.css`:
  - Moved the sentence selection toggle (`data-coach="epub-sentences"`) to the front of `.epub-glass-pill-tools` with a visible `"Предложения"` / `"Sentences"` label on PC.
  - Preserved `<ruby>` via `EpubSentenceHtmlSpan` in mobile selection mode and wrapped mobile lookup paragraphs by individual sentences (`paraSentenceEntry.sentences`) so tapping a word passes only its sentence to lookup/Anki.
  - Added PC right-click context menu (`.epub-sentence-ctx`: `"Copy sentence"` / `"Select multiple sentences…"`) and toast feedback, plus mobile responsive `.epub-sentence-bar`.
- Updated `src/features/manga/MangaReader.tsx` and `src/features/manga/manga.css`:
  - Moved the multi-bubble toggle (`data-coach="manga-bubbles"`) to the front of `.epub-glass-pill-tools` with a visible `"Баблы"` / `"Bubbles"` label on PC.
  - Added PC right-click menu on bubbles (`Copy bubble`, `Select multiple bubbles…`, `Fix OCR text`), moved `.manga-bubble-actions` inside the corner (`bottom: 2px; left: 2px`) with larger touch targets, activated the bubble on mobile lookup tap, and adapted `.manga-select-bar` for mobile.
- Added a 1-tap Copy button (`.dict-mobile-context-copy`) inside `.dict-mobile-context` in `src/components/Lookuper.tsx` + `src/components/MobileShell.css`.
- Added `epub.sentences` and `manga.bubbles` onboarding steps/details in `src/features/onboarding/readerTips.ts` and `src/features/onboarding/tipDetails.ts`, and updated `docs/session-handoff-2026-11-26.md`.
- Verified: `npm run build` (252 modules), `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (**119 / 119** passed).

---

## 2026-11-26 (late night) — Mobile Feature Parity Port (Shared Reading, Mobile Settings, Tab Controls)
- Created `src/components/MobileSettingsSections.tsx` with modular RU/EN mobile UI sections:
  - `MobileWsDiscoveryBlock`: LAN WebSocket auto-discovery via `discover_websocket_sources` (already in `src-tauri/src/lib.rs`) with 1-tap Connect.
  - `MobileAppearanceAndTextSettings`: theme (`dark`/`light`/`amoled`), language, font size, furigana, text direction (`horizontal`/`vertical`), autoscroll offset, speed metrics/timeframe, auto-pause on idle, text filters, and compact replacement rules editor.
  - `MobileLookupAppearanceSettings`: lookup font size, tag size, tags/audio toggles, auto-play audio.
  - `MobileAnkiExtendedSettings`: deck mode (`shared`/`contextual`), remaining AnkiDroid fields (`reading`, `sentenceFurigana`, `dict`, `audio`, `pitch`, `freq`), button visibility, duplicate policies, and card status colors.
  - `MobileReaderSettings`: EPUB reader settings + embedded `SettingsMangaOcr` (`isMobile={true}`) so Android users can download/manage ONNX Manga-OCR and configure PC Wi-Fi OCR.
  - `MobilePlayerSettings`: Android-supported Video Player settings (Anki deck, clip format/quality, padding, subtitle visibility/blur/regex/offset/font/backdrop, auto-pause resume mode).
  - `MobileUpdatesSettings`: current version display, startup auto-check toggle, and manual update check trigger.
- Adapted `src/components/SharedReadingDialog.tsx`, `src/components/SharedReadingBar.css`, `src/components/SharedReadingDialog.css`, and `src/components/MobileShell.css` for touch screens (responsive widths, Tauri clipboard fallback, hiding PC-only game-window screenshot host toggle on Android while keeping guest screenshot reception).
- Updated `src/components/AppLayout.tsx` (`MobileLayout` + `SearchBar`) and `src/App.tsx`:
  - Wired Shared Reading into `MobileLayout`: `<SharedReadingBar>`, island live dot, empty-state/tabs-sheet «Read together», spotlight line highlight/jump, manual timer sync break, and Android Back handlers (`endedPromptTabId`, `sharedDialogTabId`, `isSearchOpen`).
  - Added mobile tab status cycling, inline rename, archiving + collapsible Archive list, Search button, TXT/JSON import, tab export (clipboard + JSON download), Player launcher, and `EpubWorkspace` / `PlayerWorkspace` mobile settings return navigation (`mobileSettingsReturnRef` widened to `'hub' | 'epub' | 'player' | null`).
- Verified cleanly: `npm run build` (251 modules), `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (113 passed, 0 failed). No `src-tauri/` changes required.

---

## 2026-11-26 (late night) — Shared Reading Persistent Tab Identity, End Prompt & Smart Update
- Added persistent `Tab.uid` and `Tab.sharedOriginUid` in `src/utils/constants.ts`, `TabShare.originUid` and `originUid` signaling in `src/utils/sharedReading.ts`, plus `createTabUid`, `mergeSharedLines` (longest suffix-prefix overlap deduplication + anchor fallback), and `findMatchingSavedTab` (survives tab renames on both host and guest, prefers active tabs over archived).
- Updated `src/utils/useSharedReading.ts`: host rooms publish stable `originUid`; `keepCopy` preserves `sharedOriginUid` for future streams; added `mergeViewerIntoTab` (preserves guest's custom tab name, adds reading time & speed sample, updates stats/history cleanly); triggers `onViewerStreamEnded` when a non-empty viewer broadcast finishes.
- Added `SharedStreamEndedModal` in `src/components/SharedReadingDialog.tsx` (+ `.css`), plus matching **Update «…» / Save as new** actions in both `SharedReadingDialog` and `SharedReadingBar`. Closing/dismissing the modal keeps the viewer tab as a temporary ended tab for later recovery.
- Wired `endedPromptTabId`, full-history tail hydration before merging (`handleMergeViewerIntoSaved`), and `uid: createTabUid()` on new tabs in `src/App.tsx`.
- Expanded `tests/shared-reading.test.mjs` and verified: `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (113 passed, 0 failed).

---

## 2026-11-26 (late night) — EPUB Orientation Menu Fix, Sentence Segmentation & Manga Bubble Copy
- Fixed EPUB orientation dropdown (`EpubGlassSelect`) hiding as the cursor moved down into options outside the 76px top hover zone: added `onOpenChange` prop to `src/features/epub/EpubGlassSelect.tsx`, tracked `orientationMenuOpen` in `src/features/epub/EpubReader.tsx` to keep `topChromeVisible` true and suppress edge hover hints while open, and treated pointer events over `.epub-floating-top, .epub-glass-select-menu` as inside the top zone.
- Created `src/features/epub/epubSentences.ts` with JA & EN sentence segmentation (`splitTextIntoSentenceRanges`, `wrapParagraphHtmlSentences`, `formatSelectedSentencesForCopy`) excluding `<rt>`/`<rp>` furigana readings and preserving `<ruby>` and `<mark>` tags cleanly.
- Added sentence selection & clipboard copy mode to `src/features/epub/EpubReader.tsx` + `src/features/epub/epub.css`: toolbar toggle, click / `Shift+click` range selection across paragraphs/pages, imperative `.is-selected` sync without disrupting DOM memoization, floating copy bar (`.epub-sentence-bar`), and one-click ruby-clean `Copy` button on `.epub-selection-pill`.
- Added single-bubble (`Copy` next to `✎`) and multi-bubble ordered selection/copy mode (`is-bubble-select`, `.manga-bubble-order-badge`, `.manga-select-bar`) to `src/features/manga/MangaReader.tsx` + `src/features/manga/manga.css`.
- Added `tests/epub-sentences.test.mjs` and verified: `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (110 passed, 0 failed).

---

## 2026-11-26 (night) — Shared Reading v2 (Presence, Wait/Ready, Spotlight, Timer Sync & Anki Screenshots)
- Upgraded P2P Shared Reading in `src/utils/sharedReading.ts`, `src/utils/useSharedReading.ts`, and `src/components/SharedReadingDialog.tsx`/`.css`:
  - Added participant profiles (nickname + color saved in `setsuna_shared_reading_profile_v1`), live roster list, auto `lookup` activity detection when dictionary is open, and `wait` / `ready` signals (`Alt+W` shortcut or floating bar toggle).
  - Added line spotlighting («Показать всем в комнате» button on lines in `TextContainer.tsx` + jump-to-line banner in `SharedReadingBar.tsx` + colored highlight badge).
  - Added host history scope (`new` / `recent` last 50 lines / `all`), room locking (`locked`), participant kick (`kickViewer`), relay health count (`Relays: open/total`), and Discord invite copy.
  - Added optional host-to-guest compressed JPEG game screenshot sharing over chunked WebRTC (`shot-req` / `shot-chunk` via `LookupScreenshotSource` `callback` mode in `Lookuper.tsx` and `App.tsx`).
  - Added collapsible `src/components/SharedReadingBar.tsx`/`.css` HUD inside `.reader-stage` and unread-lines `+N` badge on scroll-to-bottom in `TextContainer.tsx`.
  - Implemented synced host→guest reading timer with manual guest opt-out (`syncTimer`), auto-pause when host goes offline/ends broadcast, idle-activity tracking on dictionary lookup & incoming viewer lines, and `applyViewerStatsDelta` so initial snapshot history doesn't inflate reading speed.
  - Fixed viewer `title` op handling and replaced outdated PeerJS error text with Nostr/WebRTC messages.
- Verified: `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (105 passed, 0 failed, including 6 new tests in `tests/shared-reading.test.mjs`).

---

## 2026-11-26 (night) — Customizable Esc-Menu Action Tiles (All Modes)
- Added `src/utils/escMenuLayout.ts` (`localStorage` key `setsuna_esc_menu_layout_v1`, event `setsuna:esc-menu-layout-changed`) to persist per-menu action tile order and hidden IDs across `texthooker`, `epub`, and `player`, preserving slots of temporarily absent context tiles (e.g. `library` in Player library view) and newly added tiles.
- Created shared `src/components/EscActionGrid.tsx` using `@dnd-kit/core` + `@dnd-kit/sortable` (`rectSortingStrategy`) + `useJelly` for drag-and-drop reordering, an edit toggle (`✎` / `Done`) with per-tile `×` remove buttons, a restore tray for hidden chips (`+ <label>`), an empty-state restore banner, a right-click context menu (`Remove from menu`, `Customize buttons`, `Reset to default`), and `Escape`/outside-click dismissal.
- Integrated `EscActionGrid` into `src/components/AppMenu.tsx` (TextHooker), `src/features/epub/EpubWorkspace.tsx` (Reader), and `src/features/player/PlayerWorkspace.tsx` (Video Player), keeping all `data-coach` onboarding attributes intact. Added styling in `src/components/AppMenu.css` and unit tests in `tests/esc-menu-layout.test.mjs`.
- Verified: `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (99 passed, 0 failed).

---

## 2026-11-26 (evening) — Player Folders Modal Window
- Converted the Video Player's **Library folders («Папки видеотеки»)** strip in `src/features/player/PlayerLibrary.tsx` from an inline expandable block into a floating `<LibraryDialog>` modal overlay (`LibraryDialog` in `PosterPicker.tsx`), complete with folder count/unavailability badge, `+ Add folder` / `Refresh` actions, scrollable folder list (`Remove from library`), and empty state.
- Added outside-backdrop click dismissal (`onMouseDown` coordinate bounds check) and optional `showHelp` prop to `LibraryDialog` in `src/features/player/PosterPicker.tsx`.
- Added `PLAYER_FOLDERS` onboarding steps (`player.folders-refresh`, `player.folders-list`) in `src/features/onboarding/readerTips.ts` and updated `tipDetails.ts` (`player.folders`, `player.folders-refresh`, `player.folders-list`) in RU/EN.
- Verified: `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (93 passed, 0 failed).

---

## 2026-11-26 (later) — Onboarding Fixes (Esc, Layout, Order), EPUB/Player Tours & Deck Pill

- **Coachmarks & Esc Menu Races (`Coachmarks.tsx`, `CoachTour.tsx`, `TipDetail.tsx`, `ModeIntro.tsx`, `onboarding.css`, `ReaderChrome.tsx`, `EpubWorkspace.tsx`, `PlayerWorkspace.tsx`):**
  - Stopped `Escape` propagation (`stopImmediatePropagation`) in `Coachmarks` and `ModeIntro`, plus added `.onb-coach-layer, .onb-backdrop` guards to all three workspace Esc-menu handlers so closing a tip or mode intro with Esc never opens the Esc menu underneath.
  - Updated `isCovered` and `Coachmarks` loop to treat elements behind open modals/dialogs (`dialog[open]`, `.app-menu-backdrop.is-open`, etc.) as covered (even when `pointer-events: none`), closing background tours immediately instead of floating over an Esc menu or dialog.
  - Portaled `Coachmarks` and `TipDetail` into the active `dialog[open]` when targeting elements inside native top-layer `<dialog>` modals (such as Video Player PosterPicker, episode details, and playback settings).
  - Moved the step counter (`N из M`) into `.onb-coach-head` (`CARD_WIDTH = 324`, `white-space: nowrap`) beside the title so footer buttons never squeeze or wrap it onto two lines.
  - Replaced `Math.round(rect.top / 32)` sorting in `CoachTour.tsx` with center-Y greedy row clustering (28 px threshold) then strictly left-to-right sorting per row.
- **EPUB Library, Reader & Reader Esc Menu (`EpubLibrary.tsx`, `EpubReader.tsx`, `EpubWorkspace.tsx`, `readerTips.ts`, `surfaceTips.ts`, `tipDetails.ts`):**
  - Switched library/reader tips to exact `data-coach` targets (`lib-sync`, `lib-stats`, `lib-mokuro`, `lib-select`, `lib-display`, `lib-folder`, `lib-open`, `lib-shelves`, `lib-search`, `lib-filters`, `epub-lang`, `.epub-orientation-glass-select`, `epub-notes`, `epub-gallery`, `epub-point`, `epub-autoscroll`, `epub-return-point`, `epub-freeze`, `epub-tracking`) so `library.open` no longer hits the cloud button and all reader controls have tips & "More" details.
  - Added `<TourHelpButton surface="epub-menu" />` and `<CoachTour steps={epubMenuTips(...)} />` to the Reader Esc menu (`EpubWorkspace.tsx`).
- **Video Player Deck Button, Manual Card Removal & Player Esc Tour (`PlayerWorkspace.tsx`, `PlayerLibrary.tsx`, `PosterPicker.tsx`, `player.css`, `library.css`, `SettingsModal.tsx`):**
  - Redesigned both player Anki deck buttons (`sp-deck` and `sp-deck-pill`) with `DeckIcon` + `Колода: <name>` / `Колода Anki` styling.
  - Removed manual Anki card creation (`✎` button, `playerKeyMine` / `M` shortcut, `PlayerCardEditor` mount, `player.manual` tip/detail, and Settings keybind entry).
  - Added `<TourHelpButton surface="player-menu" />` + `playerMenuTips` to the Player Esc menu (and fixed subtitle `"Аниме-плеер"` → `"Видео-плеер"`), added `<TourHelpButton surface="mode:player" />` to `LibraryDialog` header, scoped `PLAYER_SCREEN` to `.sp-body`, and added `player.sort`, `player.side-steps`, `player.side-close`.
- **Verification:** `npm run build`, `node scripts/verify-public-build.mjs`, and `node --test tests/*.test.mjs` (**93 / 93** passed).

---

## 2026-11-26 — Completion of Remaining `claude-opus-5-5` Batch Items

- **WebSocket LAN Auto-Search (`src-tauri/src/ws_discover.rs`, `main.rs`, `lib.rs`, `SettingsModal.tsx`, `SettingsModal.css`):**
  - Added Rust command `discover_websocket_sources` (registered in both `main.rs` and `lib.rs`): probes `127.0.0.1`, own LAN IP, configured hosts, and the private `/24` LAN subnet using raw RFC 6455 HTTP/1.1 Upgrade handshakes across Agent/Textractor (`/`) and LunaTranslator (`/api/text/origin`) ports with a 96-thread pool and deduplication against `127.0.0.1`.
  - Updated `autoFindWebSocket` in `SettingsModal.tsx` to collect **all** discovered servers (with non-Tauri browser fallback) and render `.ws-discover-results` showing `Этот ПК` / `LAN` badges, names, URLs, «Добавить», «Добавить все», and «Добавлено» states.
- **Anki Settings Card Order (`src/components/Settings/SettingsAnki.tsx`):**
  - Moved `<SettingsAudio />` after `#anki-cards` (before `#anki-hooks`) when Anki is connected, matching the sidebar order (`Cards -> Audio -> Screenshots`). Added `#anki-connection` (`data-anki-state`) and `#anki-dupes`.
- **Connection-State-Aware Onboarding & Fuller Drive Guide (`SettingsCloud.tsx`, `SettingsModal.tsx`, `surfaceTips.ts`, `tipDetails.ts`, `tests/onboarding.test.mjs`):**
  - Added `#cloud-connection` (`data-drive-state`), `#cloud-quota`, `#cloud-backup`, `#cloud-archive`, `#cloud-dict` IDs and enabled `watch` on Settings `CoachTour` for `anki` and `cloud` so tours react immediately when Anki or Google Drive finishes loading or connects.
  - Replaced static tips with disconnected/connected tips for Anki and Google Drive (`settings.anki-connect`, `settings.anki-connected`, `settings.anki-dupes`, `settings.cloud-connect`, `settings.cloud-connected`, `settings.cloud-quota`, `settings.cloud-backup`, `settings.cloud-archive`, `settings.cloud-dict`), updated source Auto-find descriptions for LAN search, and expanded Google Drive "More" details (`appDataFolder` privacy, automatic Reader sync vs manual snapshots/`dictionary.db` transfer, PC+phone setup).
- **Bug Report Redesign (`src/components/Settings/SettingsFeedback.tsx`, `SettingsFeedback.css`):**
  - Redesigned the Feedback panel (`#feedback-main`) in the LiquidGlass Settings style with bug/feature selector cards, required-field indicators + live character counters, responsive 2-column repro/expected inputs, styled environment bar with version/OS pills and desktop `get_diagnostics_log_path` copy button, formatted report copy action, and clear-draft button while keeping `buildFeedback`/`DRAFT_KEY` tests intact.
- **Verification:** `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs`, `cargo check --no-default-features` (desktop bin & lib), and `cargo test --no-default-features --lib ws_discover` (3/3 Rust tests passed). No commits or pushes made.

---

## 2026-11-25 — Mobile `0.6.0-beta` Hotfix Tracker (Live Handoff Log for Claude / Next Agent)

> **Purpose:** Tracks fixes for the 5 bugs + 2 enhancements reported right after `v0.6.0` on Android. Any agent continuing this work should read the checklists below first.

### Checklist & Status
1. **[IN PROGRESS] Bug #1 — APK installs as `0.1.0-alpha` (`src-tauri/tauri.android.conf.json`)**
   - Root cause: `tauri.android.conf.json` still had `"version": "0.1.0-alpha"` which overrides `tauri.conf.json` when Tauri CLI runs `android build` and regenerates `src-tauri/gen/android/app/tauri.properties` (`tauri.android.versionName`).
   - Fix: Set `"version": "0.6.0-beta"` in `src-tauri/tauri.android.conf.json`.
2. **[TODO] Bug #5 — Manga OCR bubbles shifted/misaligned on phone (`src/features/manga/MangaReader.tsx`, `src/features/manga/manga.css`)**
   - Root cause: `.manga-page-frame.fit-height` used `height: calc(100vh - 24px); max-width: 100%;` which overrode `aspect-ratio` on narrow portrait phone viewports while `.manga-page-img` used `object-fit: contain`. That created black letterbox bars above/below the image, causing `.manga-overlay-layer` (`inset: 0`) to shift upward above the rendered manga page.
   - Plan: Measure `viewportRef` with `ResizeObserver` (`stageSize`), read `naturalWidth`/`naturalHeight` on `<img onLoad>` fallback, compute exact aspect-locked `width` & `height` inline on `.manga-page-frame`, and change `.manga-page-img` to `object-fit: fill`.
3. **[TODO] Bug #4 & Enhancement A — Clicking cloud book opens last-read book + missing synced covers (`EpubWorkspace.tsx`, `EpubLibrary.tsx`, `useEpubSync.ts`, `epubCoverCache.ts`, `App.tsx`, `AppLayout.tsx`)**
   - Root cause A (wrong book opens): `EpubWorkspace.handleSelectBook` immediately ran `setViewMode("reader")` on click before `epubSync.downloadCloudBook(target)` finished, so while downloading, `activeBookTab` stayed on the previously active book and opened THAT book instead!
   - Root cause B (no covers on synced books): Books imported on PC earlier or before `coverThumb` existed didn't backfill `coverThumb` into `epub-sync.json`, so Android saw `cloudOnly: true` books without thumbnails.
   - Plan: Keep `viewMode === "library"` while `cloudOnly` downloads (`pendingCloudOpenIdRef`), open reader only once `target` becomes local; backfill compressed `coverThumb` in `useEpubSync` from cache/covers before manifest upload.
4. **[TODO] Bug #2 — Slow EPUB/Manga Google Drive sync on PC & Android (`src/utils/gdrive.ts`, `src/features/epub/useEpubSync.ts`)**
   - Root cause: `useEpubSync` cleared `cachedToken` on every workspace entry, `gdrive.ts` listed all AppData files on pull & push, and `syncNow()` awaited up to 2 full `.epub`/`.cbz` file uploads BEFORE updating `lastSyncedAt`/`status = "synced"`.
   - Plan: Cache `appData` file IDs in `gdrive.ts`, keep valid OAuth token, complete manifest metadata sync (`epub-sync.json`) immediately, and move `.epub`/`.cbz` binary uploads to a non-blocking background queue (`failedUploadKeysRef` prevents repeated retries of broken/oversized files).
5. **[TODO] Bug #3 — Video Player doesn't open on Android (`featureFlags.ts`, `usePlayerLibrary.ts`, `PlayerWorkspace.tsx`, `App.tsx`)**
   - Root cause: `ANIME_PLAYER_AVAILABLE = !isMobilePlatform()` hid the Video Player tile completely on phone, and `usePlayerLibrary` / `PlayerWorkspace` called desktop-only `player_*` Tauri commands.
   - Plan: Enable `ANIME_PLAYER_AVAILABLE = true`, guard desktop-only `player_*` Rust commands on mobile, support HTML5 `<input type="file">` video/audio + subtitle files + URL playback + word lookup on Android.
6. **[TODO] Enhancement B — Remote Mokuro request from Phone to PC (`src-tauri/src/manga_ocr_server.rs`, `main.rs`, `lib.rs`, `App.tsx`, `MangaReader.tsx`, `EpubLibrary.tsx`)**
   - Plan: Add `POST /mokuro/request` and `GET /mokuro/status` on the existing PC LAN OCR HTTP server + Tauri commands so phone triggers Mokuro OCR + optional CBZ convert + Drive sync on PC over Wi-Fi.
7. **[PENDING] Android APK Rebuild & GitHub Upload:** After verifying all fixes (`npm run build`, `verify-public-build.mjs`, `node --test`, `cargo check`), rebuild `app-universal-release.apk` with `--target aarch64` so the installed Android app displays `0.6.0-beta` and includes all fixes.

---

## 2026-11-25 — Release `0.6.0 beta` Preparation (Pushed to `dev` & `main` + `v0.6.0`)

- **UI status labels across Desktop & Mobile (`HomeScreen.tsx`, `HomeScreen.css`, `EpubLibrary.tsx`, `epub.css`, `PlayerLibrary.tsx`, `library.css`, `SettingsModal.tsx`, `SettingsAI.tsx`, `AiPanel.tsx`, `AiPanel.css`, `SettingsLookup.tsx`, `AppLayout.tsx`, `appRuntime.ts`):**
  - Renamed player mode from `"Аниме-плеер"` / `"Anime Player"` to **`"Видео-плеер"` / `"Video Player"`** and marked both **Reader (`Читалка`)** and **Video Player (`Видео-плеер`)** as **Beta (`Бета`)** across HomeScreen cards, library headers, desktop/mobile settings, and nav badges.
  - Emphasized across Settings → AI and `AiPanel` that local **LLM / AI explanations** is a **Test (`Тест`)** feature that may not reach final release.
  - Added **Early Alpha (`Ранняя альфа`)** notices for **English as a target learning language** in Desktop Settings (`text` & `ai`), Desktop/Mobile Dictionaries (`SettingsLookup`), and Mobile Appearance settings (`AppLayout`).
- **Release metadata & changelog (`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src/release-info.json`, `CHANGELOG.md`):** bumped version to `0.6.0` (`buildNumber: 8`, `0.6.0 beta`) and added full RU + EN changelog.

## 2026-11-25 — Anime Player Immersion & Mining Suite (asbplayer-inspired; local unpushed)

- **Library Bulk Bar, Context Menu & Batch Mokuro OCR (`EpubLibrary.tsx`, `EpubWorkspace.tsx`, `epub.css`, `MangaBatchMokuroModal.tsx`, `mangaBatchMokuro.css`):**
  - Moved `.epub-bulk-bar` above the card grid (`position: sticky; top: 0`), refined its LiquidGlass styling and action pill styles (`is-accent`, `is-danger`), and added a `Clear` (`Снять`) button so selected bottom-row book cards are never overlapped.
  - Added multi-volume sequential Mokuro OCR runner (`MangaBatchMokuroModal`) accessible from the Library header (`Mokuro OCR`), the Select Mode bulk bar (`✨ Mokuro OCR (N)` alongside batch `📦 В CBZ (N)`), and the card context menu (which also honors multi-selection for both Mokuro OCR and CBZ conversion), with live per-volume & per-page `manga_mokuro_progress` progress bars, skip-existing toggle, optional post-OCR CBZ conversion + Google Drive sync, safe stop-after-current cancellation, and immediate `onUpdateMangaMeta` metadata updates.
  - Portaled `.epub-ctx-menu` into `document.body`, replaced `getBoundingClientRect()` with `offsetWidth`/`offsetHeight` clamping (fixed bottom edge clipping), kept internal scrolling alive, replaced emojis with uniform inline SVGs, and grouped actions into a compact 2-button footer row.
- **Manga Reader stuck page-loading fix (`MangaReader.tsx`, `manga_import.rs`):**
  - Eliminated stuck `"Загрузка стр. N…"` placeholders by tracking cache generations (`cacheGenerationRef` / `cacheEpoch`), serving visible pages first before `60ms` neighbor prefetch, keeping `pagesByIndex` synced with `pageCacheRef`, auto-retrying transient page load failures (`250ms`/`650ms`) with a manual `Повторить` fallback button, and self-healing if visible pages are missing while staying on the same page.
  - Converted `manga_page` Tauri command to `async` (`spawn_blocking`) with a thread-safe 1-entry cached volume index + `Arc<ParsedMokuro>` (invalidated on `manga_open`, `manga_attach_mokuro`, `manga_run_mokuro`, and `manga_convert_to_cbz`) so every page turn avoids re-scanning archives or re-parsing `.mokuro` JSON.
- **Pure helpers (`src/features/player/model.ts`, tested in `tests/player.test.mjs`):** added configurable `clipInterval(scene, padStart, padEnd)`, `replayOrPreviousCue`, `syncOffsetToCue` (1-key snap), `filterCuesByRegex`, and `autoPauseResumeDelayMs`.
- **Anki `Update Last Card` & custom clip padding (`src/utils/anki.ts`, `src/features/player/mining.ts`):** added `updateLastNoteWithScene` / `updateLastPlayerNote` (desktop AnkiConnect: attaches scene audio/video, frame, and empty sentence field to the latest note) + configurable `playerClipPadStart` / `playerClipPadEnd`.
- **Immersion modes & controls (`PlayerWorkspace.tsx`, `SettingsModal.tsx`, `constants.ts`, `player.css`):**
  - Hover pause over subtitles (`playerPauseOnHover`), listening practice visibility (`playerSubsVisibility`: `always` | `paused` | `repeat` unlocked via `R`), translation blur overlay until hover (`playerBlurTranslation`), smart auto-pause resume (`manual` | `fixed` | `dynamic` by subtitle length), min gap threshold for skip/fast-forward (`playerSkipMinGap`), subtitle regex cleanup filter (`playerSubtitleRegexFilter`), live subtitle appearance sliders (font size, bottom offset, backdrop opacity).
  - New hotkeys & UI controls: `R` replay/previous cue, `U` (and `↻` button) update last Anki card, `C` copy cue, `Shift+[` / `Shift+]` (plus buttons in tracks drawer) 1-key subtitle offset snap + `0` reset.
  - Removed blind `+ Anki` bottom HUD button and transcript row `+` button (word mining goes through Setsuna's dictionary lookup which attaches `subtitleScenes` automatically; `M` / `✎` now opens the manual editor).
  - Video Anki cards (`mining.ts`, `anki.ts`, `ankiCardTemplate.ts` v3, `player_media.rs`, `SettingsModal.tsx`): removed duplicate static screenshot capture when attaching a video clip, placed `<video>` into `ankiFieldScreenshot` (`DefinitionPicture` when mapped, else `sceneField`) and added `playerVideoQuality` presets (`tiny` 480p, `compact` 640p, `balanced` 720p default, `high` 960p).
  - Cue navigation fix (`model.ts`, `PlayerWorkspace.tsx`, `player.test.mjs`): added `navCueRef` rapid-step anchor + frame-rounding tolerance + same-start ASS skip in `nextCue` so fast repeated clicks on prev/next cue buttons advance reliably without looping.
  - Manga archive/mokuro title cleanup (`manga_import.rs`, `mangaModel.ts`, `App.tsx`, `manga-model.test.mjs`): stripped release site prefixes (`DLraw.net_`), archive hash suffixes, pack ranges (`vol 01-09`), and internal `setsuna-mokuro-<hash>` temp names during scan/open/mokuro run + auto-cleaned existing library cards on startup.
  - In-place Manga CBZ conversion & full Google Drive sync (`manga_import.rs`, `epub_import.rs`, `main.rs`, `lib.rs`, `mangaApi.ts`, `epubSyncModel.ts`, `useEpubSync.ts`, `epubCoverCache.ts`, `constants.ts`, `App.tsx`, `EpubWorkspace.tsx`, `EpubLibrary.tsx`, `MangaReader.tsx`, `tests/epub-model.test.mjs`): added `manga_convert_to_cbz` to pack pages + `.mokuro` overrides + embedded `.setsuna-cover.*` atomically into `books/book_<tabId>.cbz` and switch the PC tab immediately; enabled Google Drive `.cbz`/`.zip` upload/download (up to `250 MB`, `180s` read timeout) plus syncing `format`, `hasMokuro`, `fileRevision`, and compact `coverThumb` thumbnails so converted manga, OCR overlays, custom covers, and progress sync seamlessly from PC to Android.
  - Mobile Back gesture stack, deletion guard & phone UI parity (`MainActivity.kt`, `src/utils/mobileBack.ts`, `App.tsx`, `AppLayout.tsx`, `EpubWorkspace.tsx`, `EpubLibrary.tsx`, `EpubReader.tsx`, `PdfReader.tsx`, `MangaReader.tsx`, `CatalogPickerModal.tsx`, `PlayerWorkspace.tsx`, `epubLibraryModel.ts`, `catalogPicker.css`, `epub.css`, `tests/mobile-back.test.mjs`): replaced `history.pushState`/`popstate` + `WryActivity` `canGoBack()` with an Android `OnBackPressedCallback` bridge (`window.__setsunaHandleAndroidBack`) and a priority-ordered JS Back stack (`MOBILE_BACK_PRIORITY`: `POPUP > MODAL > READER_OVERLAY > SUBVIEW > WORKSPACE`) so every Back swipe/press closes strictly one UI layer without exiting the app or skipping menus; fixed `handleRemoveEpubBook`/`handleRemoveEpubBooks`, mobile manga import (`activate: false`), and `resolveEpubViewModeAfterChange` so deleting any book never opens a fallback book; enabled card `🔍` catalog search and `⋮` context menu button + responsive CSS on mobile.
  - Manga large-text bubble layout fix (`mangaModel.ts`, `MangaReader.tsx`, `manga.css`, `manga-model.test.mjs`): preserved per-line breaks via `<p class="manga-bubble-line">` while keeping `joinMokuroLines` code-point offsets (`prepareBubbleDisplayLines`), detected paragraph gaps via `linesCoords` (`detectBubbleParagraphGaps`), added proportional `computeBubbleLineHeight` + wrapped font-fit for long single-line blocks (`computeFittedBubbleFontPx`), widened `cqw` clamp (`0.35`–`12`), set opaque white card fill (`#ffffff` / transparent inner text) and hover expansion so large/multi-line blurbs render cleanly without clipping or ghosting.
  - Manga/Book catalog & cover lookup (`manga_catalog.rs`, `CatalogPickerModal.tsx`, `catalogPicker.css`, `mangaApi.ts`, `mangaModel.ts`, `EpubLibrary.tsx`, `EpubWorkspace.tsx`, `App.tsx`, `manga_import.rs`, registered in `main.rs` & `lib.rs`): added AniList, Shikimori, Kitsu, MangaUpdates, Jikan (MAL, 4s timeout), and direct Apple Books JP catalog search (`limit=100`, up to 60 displayed volumes, prefix filtering to exclude unrelated series, deduplicating `特装版`/`限定版` behind standard editions, plus automatic trailing-volume fallback e.g. `宝石の国2` -> `宝石の国` merging both series cards and direct per-volume covers right on Step 1) + 2-step Apple Books JP (primary) & MangaDex (fallback) per-volume cover/title picker (`manga_fetch_series_volumes` with `targetVolume` targeted volume lookup, `extractVolumeNumberFromBook`, `referrerPolicy="no-referrer"`, auto-hiding broken cover URLs via `onError`, and `inferBookCatalogQuery` stripping parenthesized `(9)` / `特装版` suffixes), fixed `file_stem()` truncating dotted folder names like `DLraw.net_Houseki no Kuni v02` to `DLraw`, stayed in library instead of auto-opening the reader when prompting for title/cover across both pickers and drag-and-drop, plus bulk per-volume cover & rename and local cover file picker.
  - Manga LiquidGlass reader redesign & `book_<id>` title fix (`MangaReader.tsx`, `manga.css`, `manga_import.rs`, `mangaModel.ts`, `EpubWorkspace.tsx`, `App.tsx`): replaced permanent top/bottom bars with EPUB-reader-parity auto-hiding LiquidGlass top islands & bottom capsule (interactive RTL-aware scrubber, inline page jump, edge chevrons, corner status + goal light, Pages/Bookmarks/Notes drawer, background theme swatches, freeze/pause toggles, wheel paging), stopped `book_<tabId>` stored filename from overwriting titles, and guarded cached manga covers on open.
  - Library card cover buttons hitbox & right-click context menu (`EpubLibrary.tsx`, `epub.css`, `constants.ts`, `epubLibraryModel.ts`, `epubSyncModel.ts`, `i18n.ts`): added `pointer-events: auto` to `.epub-cover-edit-btn` so `🔍` and `✎` buttons work properly, expanded `EpubManualStatus` with `planned`, `on-hold`, and `dropped` statuses, and added a right-click LiquidGlass card context menu for cover/title search, local cover file upload, metadata settings, cover blur, status selection, shelves, and removal.
  - EPUB/Manga library delete redirect fix (`EpubWorkspace.tsx`): keep `viewMode` in `"library"` when `activeTabId` switches because the previously active book was removed, instead of auto-opening a fallback book in the reader.
  - Manga bubble selection-ghost fix (`MangaReader.tsx`, `manga.css`): cleared stale `window.getSelection()` inside `.manga-overlay-layer` on hover leave, lookup close, stage click, and page/volume change, plus transparent `::selection` on non-active hidden bubbles.

## 2026-11-25 — Player Top-Bar Removal, Esc Menu & Arrow Seek Mode (local unpushed)

- **Removed `WorkspaceShell` top bar (`App.tsx`, `PlayerWorkspace.tsx`, `player.css`):** unwrapped `<PlayerWorkspace>` from `<WorkspaceShell>` so neither Video Library nor Watch view shows the redundant outer header.
- **Full-window Esc menu (`PlayerWorkspace.tsx`):** added `AppMenu`-style portal modal on `Esc` (episodes list when watching, scanned library shows when browsing, actions for Library / Back to video, Open file, Open URL, Anki deck picker, Player settings, and Home screen). Closes open dropdowns (`⋯`), URL dialog, or lookup popup before toggling the menu.
- **Arrow-key seek mode (`SettingsModal.tsx`, `constants.ts`, `PlayerWorkspace.tsx`):** added `playerArrowSeekMode?: "seconds" | "subtitle"` (default `"seconds"`), exposed in `Settings → Воспроизведение` and live inside the player's Playback Settings dialog (`Перемотка ← / →`: `Секунды` / `Субтитры` + step input). Falls back to `playerRewindSeconds` when no subtitles are loaded.

## 2026-11-24 — Minimalist Borderless Cinema Player & No Auto-Translation Subtitles (local unpushed)

- **Subtitles (`SubtitleTracks.tsx`):** removed auto-loading of embedded `rus`/`eng` translation tracks into slot 1 by default (translation dropdown defaults to `Выключено` / `Off` and can still be picked manually).
- **Minimalist Cinema HUD (`PlayerWorkspace.tsx`, `PlayerTransport.tsx`, `player.css`):**
  - Hid the redundant `WorkspaceShell` header while watching (`.workspace-shell-player:has(.sp-body) .workspace-shell-header`) and removed the separate static top bar (`.sp-source`) — replaced with one auto-hiding floating top gradient overlay inside the video (Back, Title, compact Episode switcher, Anki deck pill, `⋯` menu for Open File/URL).
  - Converted all video HUD and transcript controls to borderless ghost icons (circular white play button, compact `+ Anki` pill + `✎`, icon-only view controls, high-specificity timeline & volume slider styles overriding `design.css`'s giant blue thumb).
  - Made transcript drawer edge-to-edge flush with toggleable tracks/offset & search drawers (keeping `SubtitleTracks` mounted when hidden so primary subtitles auto-load).

## 2026-11-24 — Anime Player Cinema UI & Ergonomics Polish (local unpushed)

- **Watch screen (`PlayerTransport.tsx`, `PlayerWorkspace.tsx`, `player.css`):**
  - Added SVG controls, interactive hover seek timestamp tooltip, A–B loop track indicator, CC video subtitle toggle, and previous/next cue step buttons.
  - Added Prev/Next episode switcher + counter in top bar, double-click fullscreen, fullscreen auto-hide floating transport bar (2.4s idle), translucent HUD action flash (play/pause, seek, sub offset), quick speed preset pills in settings, transcript Auto-scroll pill + cue counter + search bar + hover + per-line Anki mine button, and frosted dark-glass cinema subtitle pills.
- **Video library (`PlayerLibrary.tsx`, `library.css`):**
  - Added **Continue Watching** hero banner with ambient blurred poster backdrop, episode/timestamp progress bar, and instant resume.
  - Added hover floating quick-play button + bottom cover progress bar on every library card, plus per-episode progress indicators in show details.

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
