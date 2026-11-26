# Work Log — `claude-opus-5-5` (`seri` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `claude-opus-5-5`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers read it for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-25 (night) — Interrupted dictionary import is repaired at startup, visibly

- A friend's two diagnostics logs: the DB grew 1.5 → 3.2 GB over two restarts and lookups were silent for minutes after each; a clean reinstall fixed it. Cause: closing the app while an import was "Building lookup indexes..." left indexes missing, and the first lookup rebuilt them silently (`main.rs` `open_db` → `ensure_canonical_schema` → `rebuild_indexes`).
- `core/database.rs`: `schema_is_current` is pub; the body of `ensure_canonical_schema` moved to pub `apply_canonical_schema(conn, progress)`, which builds the 8 lookup indexes one at a time with 0–100 progress (`LOOKUP_INDEX_DEFS`).
- New command `repair_dictionary_database` (`dictionary_import.rs`, registered in `main.rs` and `lib.rs`): skips if an import holds `DICTIONARY_IMPORT_LOCK`, sets `IMPORT_ACTIVE` before `open_db` (so lookups and `open_db` skip maintenance meanwhile), repairs and emits `import_progress` with `operation: "repair"` and status `Rebuilding dictionary indexes...` / `Done`. A fresh, empty DB gets its schema silently. `App.tsx` calls it once after load and refreshes the dictionary list when it repaired something.
- `ImportProgressModal`: "Восстановление" pill + card text asking to keep Setsuna open; the normal import card also says to keep the app open until the import finishes.
- Tests: `startup_repair_rebuilds_indexes_an_interrupted_import_left_out`, `startup_repair_of_an_empty_database_is_silent` (`cargo test --bin Setsuna startup_repair`).

## 2026-11-26 — Card went to the wrong deck (tab deck binding)

- Report: a CARTAGRA card landed in "Kanji Radical". Cause found in `workspace-state.json`: the texthooker tab "Окно 37" (capture `カルタグラ FHD.exe`, created 2026-11-25 23:54) had `ankiDeck: "Kanji Radical"`; the main window's lookup uses the tab deck over `settings.ankiDeck` (`App.tsx`, `ankiDeck=` prop of `Lookuper`). How the binding got set is not known (no Anki entries in the diagnostics log; writers are the tab context-menu `<select>`, `DeckPicker` and the mobile "Это окно" select).
- `Lookuper.tsx`: the add / add-with-screenshot buttons' tooltips now end with `→ <deck>`, so the target deck is visible before adding.
- Root cause (user picked a test deck in the Esc menu "Колода" and got "Kanji Radical"): `DeckPicker`'s open effect depended on `onClose`, which `ReaderChrome` passes inline. While the reading timer runs, `App` re-renders every second (`setTimerDisplayOffset`), so the picker reset to "Loading…", cleared the search, refetched decks and refocused each tick; rows moved under the cursor and a neighbouring deck was bound. Fixed: `onClose`/`loadDecks` held in refs, effect depends on `open` only, stale loads ignored.

## 2026-11-25 (night, later) — One-click Mokuro install on Windows

- New `src-tauri/src/mokuro_setup.rs` (declared in `main.rs` and `lib.rs`, command `manga_install_mokuro` registered in both; mobile returns an error). Steps, streamed to the `manga_mokuro_install` event `{ stage, line }`:
  1. Find Python 3.10–3.12: `py -3.x`, then absolute installs (`%LOCALAPPDATA%\Programs\Python\Python3xx`, `Program Files`) because a Python installed while Setsuna runs is not on the process PATH. Newer Pythons are skipped on purpose (no PyTorch wheels; e.g. a default `python` 3.15).
  2. If none: `winget install --id Python.Python.3.12 --scope user --silent`, fallback to the python.org 3.12.10 installer via `curl.exe` (`/quiet InstallAllUsers=0 PrependPath=1`), no admin.
  3. `pip install --upgrade pip`; if torch is missing and `nvidia-smi` reports a GPU: `torch torchvision` from `whl/cu128` for compute capability ≥ 7.5 (Turing…Blackwell, RTX 50 needs it) or `whl/cu126` for older cards; CPU-only machines get the PyPI build through mokuro.
  4. `pip install --upgrade mokuro`.
- `python_candidates()` is now shared by `detect_mokuro_runner` (`manga_import.rs`) and `detect_manga_ocr_python` (`manga_ocr_server.rs`).
- UI: the Mokuro dialog shows "Установить автоматически" on Windows when mokuro is missing, a 3-step progress with the live pip/winget line, and cannot be closed while installing (`mangaApi.installMokuro`, `MokuroInstallProgress`).
- Checked by hand: the winget id, the python.org URL (200), `nvidia-smi` compute_cap, the cu128 index wheels for cp312, pip resolving mokuro. Rust tests for the wheel choice and candidate order. The full install was not run end to end (this PC already has everything).

## 2026-11-25 (night) — Mokuro run that "just closes the dialog"

- `manga_run_mokuro` (`manga_import.rs`) treated a mokuro exit code 0 as success even when no `.mokuro` was produced, so the reader dialog closed with no OCR and no message (reported on the 0.6.0 release build). It now returns an error with the expected output path and the last mokuro output line when the reopened volume has no OCR layer; a failed copy into the sidecar store is an error too. The run itself is unchanged: `py -3.12 -m mokuro <dir> --disable_confirmation` on this PC writes `<parent>/<vol>.mokuro` as the code expects (checked on two pages). Root cause of the release-only failure not found yet; the new message should show it.

## 2026-11-25 (evening) — Shift+click selection in readers, import pill flicker

- `Lookuper.tsx`: a mousedown while the lookup hotkey is held (default Shift) over scannable text now runs the lookup and `preventDefault`s — before, Chromium's Shift+click extended a native selection from the top of the page (seen in EPUB for a friend, likely touchpad taps). Inputs, buttons and links are untouched.
- `ImportProgressModal` (`AppModals.tsx`) renders through a portal on `<body>`; `.import-pill`/`.import-pill-card` lost their `backdrop-filter` and the wrap got its own layer (`isolation`, `will-change`). Under the blurred settings overlay WebView2 dropped and re-showed the pill while pages scrolled/switched.
- In-app lookups were not written to `setsuna-diagnostics.log`. Now the periodic `frontend` snapshot carries `lookup` counters (`src/utils/lookupStats.ts`: scans, found, failed, slow >1.5 s, inFlight, lastMs, maxMs, lastError), timed around `scan_cursor` in `Lookuper`.
- `createHoverScanQueue` (`hoverScan.ts`) gained a stall timeout (default 4 s): a `scan_cursor` that never answers no longer blocks every later hover lookup (suspected "lookup dead after a big import" on a friend's PC; their log had no lookup data to confirm). Test added in `tests/hover-scan.test.mjs`.

## 2026-11-25 (later) — Phone: manga OCR placement, cloud covers, video player + Anki clips

- **Manga OCR bubbles:** `placeBubbleLines` (`mangaModel.ts`, tested) puts every OCR column at its Mokuro `linesCoords` box instead of re-flowing and centring the text in the block box (columns drifted and a second column could vanish when active). Bubbles with coordinates get `.is-placed`; older files / edited line counts / crop OCR fall back to the old flow. The blue "scale" marks were the global `.lookup-word` inset `box-shadow` underline; `manga.css` now resets `box-shadow`/`border-radius` inside bubbles.
- **Covers of cloud-only books:** the PC still ran the 0.6.0 release, so 16 of 17 books had no `coverThumb` in the manifest. New `src/features/epub/zipCover.ts` reads a cover from a zip-based book through byte ranges only (EOCD → central directory → one entry; EPUB via `container.xml` → OPF cover; CBZ via `.setsuna-cover.*` or the first page in natural order). `driveCover.ts` does this against Drive (`Range` requests, Tauri HTTP). `useEpubSync` runs it for `cloudOnly` books without a thumbnail (6 h back-off on failure) and the thumbnail is published back to the manifest. Tests: `tests/zip-cover.test.mjs`; also checked on the real library files.
- **Video player on phones:** picked files get virtual paths `mobile-file://<n>/<name>` (`mobileMedia.ts`) that keep real names, so subtitle matching, titles and episode labels work like desktop; the picker is multi-select (episodes + subtitles together). `MobilePlayerHome.tsx` (continue card, open/URL/deck, recently watched with progress). Session: `mobile.css` portrait layout (16:9 video, controls under it, transcript below) and landscape side panel; tap shows/hides controls, double tap left/right steps back/forward (seconds or lines per `playerArrowSeekMode`), centre controls, fullscreen locks landscape, `+ Anki` quick button.
- **Anki clips on phones:** `mobileClip.ts` records the scene (subtitle ± `playerClipPadStart/End`, default 0.5 s) from a hidden `<video>` with `MediaRecorder` (WebM VP9/VP8+Opus, sizes from the desktop quality presets; audio routed only to the recorder, so it plays silently). `addPlayerNote` sends it as `clipBase64/clipFilename/clipMediaType`; `addNote` stores it via AnkiConnect `storeMediaFile {data}` or, on AnkiDroid, new bridge fields `clipField/clipBase64/clipFilename/clipKind` (`AnkiDroidBridge.kt` stores it and inserts the same `<video>` HTML as desktop). "Update last card" stays desktop-only (AnkiDroid API cannot edit notes).
- Browser harness: `tests/browser-mobile-player.html` (mobile viewport; fixtures are generated locally, see the file header).

## 2026-11-25 — Finished Gemini 4 Neon's mobile `0.6.0-beta` hotfix tracker

- The tracker in `gemini-4-neon-seri-side.md` still lists items as TODO, but the code for items 1–6 is complete (verified in the working tree, not committed yet):
  1. APK version: `tauri.android.conf.json` → `0.6.0-beta` (`tauri.properties`: versionName `0.6.0-beta`, versionCode `6000`).
  2. Manga bubbles on phones: `fitMangaPage` (`mangaModel.ts`, unit-tested) sizes `.manga-page-frame` from the measured viewport; `.manga-page-img` is `object-fit: fill`, so `.manga-overlay-layer` matches the image exactly.
  3. Cloud book opens the right book: `EpubWorkspace` keeps the library while a `cloudOnly` book downloads (`pendingCloudOpenIdRef`) and opens the reader only once that book is local; `useEpubSync` backfills `coverThumb` for older books (thumbs capped at 42k chars).
  4. Faster Drive sync: `gdrive.ts` caches appData file ids per token (`withAppDataFile`, retries on 404), the access token promise is reused, the manifest syncs first and book uploads run in a background queue with back-off (`failedUploadsRef`). Tests: `tests/epub-sync.test.mjs`, `tests/gdrive.test.mjs`.
  5. Video player on Android: `ANIME_PLAYER_AVAILABLE = true`; desktop-only `player_*` commands are skipped on mobile; files open through `<input type="file">` as blob URLs.
  6. Remote Mokuro: `POST /mokuro/request`, `GET /mokuro/status` on the PC OCR server (token required), commands `manga_ocr_set_remote_mokuro_state`, `manga_ocr_remote_mokuro_request`, `manga_ocr_remote_mokuro_status` (both `main.rs` and `lib.rs`), PC side `useRemoteMokuroHost`, phone side `RemoteMokuroControls`.
- Fixed in my own module: `src/components/AiPanel.css` had three orphan declarations left from removing the old history drawer. CSS error recovery swallowed the next selector, so `.aip-icon-btn` (history, memory, close buttons) had no styles. Also removes the two `css-syntax-error` build warnings.
- Item 7: rebuilt the signed `app-universal-release.apk` (`npm run tauri android build -- --apk --target aarch64`). Nothing pushed or uploaded.
- Checks: `npm run build` (no warnings), `verify-public-build`, `node --test tests/*.test.mjs` (74/74), `cargo check --no-default-features`.

## 2026-11-24 — Review of the manga OCR / player work, player label test fix, push

- Reviewed the local (unpushed) Gemini manga OCR suite and the GPT player poster/transport pass before pushing them to `dev`. All four AGENTS.md checks pass: `npm run build`, `verify-public-build`, `node --test tests/*.test.mjs` (60/60), `cargo check --no-default-features`.
- Fixed `episodeLabel` (`src/features/player/localMedia.ts`): files with a season now get the compact `S02E11` label that `tests/player.test.mjs` already expected (the test had been updated without the function). Used by the library list and the episode picker.
- Not committed on purpose: `NUL` (stray empty file from a shell redirect), `docs/yatsu-desktop-preview.md` and `scripts/extract-rose-guns-days.mjs` (private, keep out of the repo).

## 2026-11-23 — Shared reading, Anki QoL, AI panel (landed in `b9c937f`)

- **Shared reading** (`src/utils/sharedReading.ts`, `src/utils/useSharedReading.ts`, `src/components/SharedReadingDialog.*`): peer to peer over WebRTC via Trystero (`trystero@0.26.0`, Nostr strategy). Signaling uses 12 public Nostr relays that are not behind Cloudflare (PeerJS / `0.peerjs.com` was blocked for a friend in RU, error `network`). Room code `XXX-XXX` = room id + SDP password. Host serves a chunked snapshot to each joining viewer, then broadcasts `append/set/insert/remove/title` ops from a line diff; viewers accept messages only from the peer that sent `hello`. Tab field `shared?: { code, role, ended? }`; `isTabLocked(tab)` in `constants.ts` makes viewer tabs read-only and keeps hooked text out of them. `shared` is stripped from cloud backups. Error codes shown in the dialog: `[relays]` (no relay reachable), `[webrtc]` (direct connection failed). Test page: `tests/browser-shared-reading.html?side=host|viewer` (one client per tab; Trystero has one peer id per page). The Worker room code under `server/` was removed again (backend cancelled).
- **Anki:** `src/utils/ankiCardTemplate.ts` is a full "Setsuna Japanese" note type (pitch graph, furigana, picture, sentence highlight, night mode). It is created on a profile without Lapis and upgraded in place when its template marker is older (`upgradeSetsunaModel`). The first-run wizard no longer overrides an existing note type (`ensureSetsunaNoteType(current)` prefers it, then Lapis). Per-tab deck: `DeckPicker` + menu tile; `tab.ankiDeck` is used in any deck mode. `captureRequest.ts`: adding a screenshot card without a capture process opens the process picker and binds the choice to the tab.
- **AI panel:** per-tab chats + one general chat (history v2 in `ai/history.json`), prompt settings `aiExplainLanguage/aiSourceLanguage/aiDetail/aiCustomPrompt`, tab memory of names (`Chat.memory`, auto extraction after each explanation), custom models folder (`ai_set_models_dir`, `ai/config.json`).
- **Gotcha:** never rewrite `src/App.tsx` while `vite`/`tauri dev` is running with a half-applied edit — a reload in between left the window on the static `#setsuna-boot` placeholder.
