# Work Log — `claude-opus-5-5` (`seri` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `claude-opus-5-5`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers read it for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-27 (later) — Back to the last text tab, not the first
- Opening a book makes the book's tab active; `openTextHookerWorkspace`, "remove book" and "remove selected books" then picked the *first* text tab (the user's «I/O»). `App.tsx` now remembers the last open text tab (`lastTextTabIdRef`, localStorage `setsuna-last-text-tab`) and `preferredTextTab(list)` falls back to the first only if that tab is gone/archived.
- `tests/browser-mobile.html` can preload a workspace: `sessionStorage.mockWorkspace` (not enough on its own yet: tab histories still override it).

---

## 2026-11-27 — Mobile (Android) overhaul from `docs/session-handoff-2026-11-26.md`
- **Drive token on Android:** `resolveGoogleRefreshToken(fallback)` in `src/utils/gdrive.ts`; `DictionaryShare` takes `refreshToken` (SettingsLookup passes `settings.gdriveRefreshToken`) so «Мои раздачи» works on Android. `lib.rs` now registers `store/load/delete_google_refresh_token` (load → None, store → Err on purpose so the desktop-style migration in SettingsCloud never wipes the settings copy).
- **Mobile settings layout:** root cause was `min-height: 0` on `.m-section` / `.m-page .mobile-settings-section` grid items (auto rows shrank to the scroller height → sections overlapped, stray checkbox ✓ peeking through) plus grids without `minmax(0,1fr)` (pages wider than the screen). Fixed in `MobileShell.css`; the 500 legacy `.mobile-settings-*` lines in `App.css` were deleted (MobileShell has `.m-page` versions of all; the two unique ones moved there).
- **Shared reading:** honest badge (`src/components/sharedLiveBadge.ts`, used by the mobile island dot, mobile tab list and desktop viewer tabs): LIVE only when host is live / viewer hears the host. Protocol: viewer buffers messages from a peer before its `hello` and replays them, asks `hello-req` (new peer after 1.5 s, room every 3 s while hostless), host re-greets on `hello-req` (also admits peers whose onPeerJoin it missed; locked → kicked), host `ping` every 8 s, viewer marks host away after 25 s silence. `action.send` failures are logged, not swallowed. Ended modal also for 0 lines (own variant). Tests: `tests/shared-reading-transport.test.mjs` (fake trystero via esbuild plugin). Cross-network (CGNAT) may still need TURN — none configured.
- **Phone text sources:** `src/components/MobileSources.tsx` + `src/utils/mobileSources.ts` — the whole `settings.websockets` list (add/edit/remove/switch each/★ main). Android: the main source runs in the native `TextCaptureService` (background), other switched-on sources via the in-app socket; an effect turns off the in-app socket for the address the service holds (no duplicate lines). Auto-find can add one/all without touching others. Old `mobile-ws` entry is just a normal source now. Tests: `tests/mobile-sources.test.mjs`.
- **Drive dictionaries on phone:** `src/components/MobileDictionarySync.tsx` — cloud → phone tiles, one main “Download to phone” with a confirm (sizes, free space), steps Preparing → Downloading → Checking & installing → Done (`MobileDriveTransfer.phase`), upload behind a disclosure.
- **Vertical lookup on phone:** `Lookuper` `isSideSheet` (mobile + verticalContext + sentence card): sheet from the left, sentence column on the right (`--m-vctx-w`), swipe left to close; CSS at the end of `MobileShell.css`.
- **Phone video library:** Android SAF folders. New Kotlin `MediaLibrary.kt` (tree scan → directories/episodes/subtitles), `MediaServer.kt` (127.0.0.1 HTTP with random token, Range/206, CORS), bridge methods in `MobileFileBridge.kt` (`selectVideoFolder`, `scanVideoFolder`, `forgetVideoFolder`, `videoFolders`, `mediaUrl`, `readDocumentBase64`), `REQUEST_VIDEO_TREE = 8124` + persistable permission in `MainActivity`. TS `src/features/player/androidFolders.ts` (virtual paths `android-folder://<enc tree>/<names…>` so titles/labels/subtitle matching/progress work like desktop paths); `usePlayerLibrary`, `usePlayerSource` (crossOrigin for the local server), `SubtitleTracks`, `mining.ts`, `mobileClip.ts`, `PlayerWorkspace` (no `player_allow_library_media` for android paths). `MobilePlayerHome` embeds the desktop `PlayerLibrary`, and recent files can be removed / cleared. Tests: `tests/android-folders.test.mjs`. **Not tested on a device yet** (no phone on ADB).
- **Phone onboarding:** `src/features/onboarding/mobileGuides.ts` (phone intros without Shift; tips for island, source, dock, tabs sheet, settings home/source/drive, player home); `modeGuide`/`modeTips` route by `isMobilePlatform()`; App.tsx `OnboardingLayer … tips` (was `tips={!isMobileLayout}`); `data-coach="m-…"` targets in AppLayout; "?" in island row, tabs sheet and settings headers.
- **Browser harness:** `tests/browser-mobile.html` renders the real app at phone size with a Tauri stub (`?noanim`, `?drive`, `?folders`; `__open('Словари')`).
- Another agent was editing `src/features/epub/EpubReader.tsx` in the same tree during this session; I did not touch it.

---

## 2026-11-26 (later 12) — LAN WebSocket scan also probes 9003–9005 and 8080
- Reviewed gemini-4-neon's uncommitted batch (LAN discovery, Anki order, connection-aware Anki/Drive tips, feedback redesign, Esc grid, shared reading v2, mobile parity); all four checks pass, 113 tests.
- `src-tauri/src/ws_discover.rs`: `LAN_PORTS` skipped 9003, so the user's real `ws://192.168.0.40:9003` source was never found unless already saved. Added 9003, 9004, 9005, 8080 (now 11 ports × 254 hosts, 160 ms connect, 96 workers ≈ 5 s worst case). `cargo check` + `cargo test --lib ws_discover` (3/3) pass.
- Do not commit the untracked `NUL`, `docs/yatsu-desktop-preview.md` (private reader) or `scripts/extract-rose-guns-days.mjs` (personal Steam paths).

---

## 2026-11-25 (night) — Interrupted dictionary import is repaired at startup, visibly

- A friend's two diagnostics logs: the DB grew 1.5 → 3.2 GB over two restarts and lookups were silent for minutes after each; a clean reinstall fixed it. Cause: closing the app while an import was "Building lookup indexes..." left indexes missing, and the first lookup rebuilt them silently (`main.rs` `open_db` → `ensure_canonical_schema` → `rebuild_indexes`).
- `core/database.rs`: `schema_is_current` is pub; the body of `ensure_canonical_schema` moved to pub `apply_canonical_schema(conn, progress)`, which builds the 8 lookup indexes one at a time with 0–100 progress (`LOOKUP_INDEX_DEFS`).
- New command `repair_dictionary_database` (`dictionary_import.rs`, registered in `main.rs` and `lib.rs`): skips if an import holds `DICTIONARY_IMPORT_LOCK`, sets `IMPORT_ACTIVE` before `open_db` (so lookups and `open_db` skip maintenance meanwhile), repairs and emits `import_progress` with `operation: "repair"` and status `Rebuilding dictionary indexes...` / `Done`. A fresh, empty DB gets its schema silently. `App.tsx` calls it once after load and refreshes the dictionary list when it repaired something.
- `ImportProgressModal`: "Восстановление" pill + card text asking to keep Setsuna open; the normal import card also says to keep the app open until the import finishes.
- Tests: `startup_repair_rebuilds_indexes_an_interrupted_import_left_out`, `startup_repair_of_an_empty_database_is_silent` (`cargo test --bin Setsuna startup_repair`).

## 2026-11-26 (later 11) — No-dictionary card, tip Back button, floating stats only (partial batch)

- `Lookuper.tsx`: Shift-scan with no dictionary installed shows a small card "Словари не загружены" with a link that fires `setsuna:open-settings` (`OPEN_SETTINGS_EVENT`, detail `lookup-dicts`); `App.tsx` listens and opens settings there; `SettingsModal` `initialSection` now handles `lookup-*`. CSS in `App.css` (`.dict-no-dictionaries`).
- Tips: "Назад" button (and ←) in `Coachmarks`; Esc menu "?" grouped with the close button (`.app-menu-heading-actions`).
- Source texts now start with: every popular hooker sends text both via clipboard and WebSocket.
- Stats: the docked bottom bar is gone from desktop — `App.tsx` always passes `top-right`, the position select was removed, defaults are `top-right` (mobile `AppLayout` untouched).
- NOT done yet (usage limit): WebSocket auto-search over the LAN listing all results; Anki settings order (cards before audio); Anki/Drive tips that depend on connection state and a fuller Drive explanation; bug report redesign.

## 2026-11-26 (later 10) — TextHooker bar no longer slides away during tips

- `ReaderChrome.tsx`: the coach event set `islandHoverRef`, but moving the mouse to the tip fired the island's `pointerleave` (and the >120 px pointermove rule), which reset it and hid the bar from under the tip. A separate `coachActiveRef` now blocks `hideIslandLater` and its timer for the whole tour; the bar hides normally 600 ms after the tour ends.

## 2026-11-26 (later 9) — "?" on every screen replays its tips

- `CoachTour` takes `surface`; `replayTips(surface)` (event `setsuna:coach-replay`) shows every tip of that surface whose element is on screen, seen or not.
- `TourHelpButton.tsx`: "?" button. Inline in the TextHooker top bar (`ReaderChrome`, surface `mode:texthooker`, styled as `reader-island-flow`), the Esc menu header (`AppMenu`, `menu`, next to close) and the settings top bar (`SettingsModal`, `settings`, tips of the open section). Floating in the bottom-left corner for the reader/library (`mode:epub`) and the player (`mode:player`), lifted above `.sp-transport`; mounted by `OnboardingLayer`, z-index 50 so menus cover it.
- Checked in the harness: with every tip seen nothing starts; "?" opens "1 из 7" again.

## 2026-11-26 (later 8) — Tour fixes from real use, full player tips, library popover

- Bottom reader capsule jumped sideways on hover: the tour CSS forced `transform: none` on `.epub-floating-bottom.is-hidden`, dropping its `translateX(-50%)` centring. Now it keeps the centring.
- Tips pointed at buttons hidden under another window ("Продолжить чтение?"): `resolveTarget` now skips covered elements (hit test via `elementsFromPoint`, ignoring onboarding layers; elements with `pointer-events: none`, i.e. auto-hidden chrome, can't be tested and count as visible).
- Tips jumped around the screen: `CoachTour` orders pending tips by position (rows of 32 px, then left to right).
- Settings: ring spilled over the settings window and the tip covered the next card. `visibleClip()` intersects the viewport with every scrolling/clipping parent; the ring is clipped to it, scrolling decisions use it, and wide tall panels (>45% height, >60% width of the clip) get the tip inside their top-right corner.
- Library "Вид" popover rendered under the filter row and cards (Vlad's `bc6ccf2` CSS): `.epub-library-head` gets `position: relative; z-index: 20` (filters are 12).
- Player tips rewritten by screen: library (open, URL, deck, folders, add folder, status filter, search+sort, continue hero, title card), episode dialog, poster picker, player (library, episodes, deck, more, timeline, play, line jump, sound, line to Anki, update last card U, manual card M, subtitles, settings, transcript, full screen, side panel, Auto, tracks & offset, line search), playback settings (`.sp-study`, study mode, A–B loop). Details for all, incl. every study mode. Selectors checked against the markup; in a browser only the empty library could be exercised (desktop opens files through Tauri, URL needs HTTPS).

## 2026-11-26 (later 7) — "Подробнее" for every tip

- New `TipDetail.tsx` (same glass card as `ModeIntro`, portal, Esc/Enter returns to the tip; `## ` subheadings and `• ` items) and `tipDetails.ts` (RU/EN long text for every tip id: TextHooker, Esc menu, settings shell + all cards, library/EPUB/manga/PDF, player). `Coachmarks` shows "Подробнее →" when a detail exists and hides the tip card while the detail is open.
- Text sources explained in depth (shared by `texthooker.source`, `menu.sources`, `settings.text-src`): what a hooker is; Agent, Textractor (needs the WebSocket or Copy to Clipboard extension), LunaTranslator/LunaHook; Auto-search; WebSocket vs clipboard; the dots. Fixed the earlier wrong wording that "ag" is the capture agent: it is just the user's name for a WebSocket source.
- Corrected facts against the code: stats are characters/words/sentences/time/speed; furigana is off/auto; stats position is top-right floating or bottom docked; clearing a tab asks for confirmation.
- Test: every tip id has a detail in both languages; the source detail mentions all three hookers.

## 2026-11-26 (later 6) — Tips for the reader (library, EPUB, manga, PDF) and the player

- Checked Vlad's work first: `friend/feature/epub` (`ec033fc`) is fully contained in `bc6ccf2`, already merged; `origin` has nothing newer.
- `src/features/onboarding/readerTips.ts`: buttons are found by their existing translated `title` / `aria-label` (via `getTranslator`), so no markup was added to Vlad's reader files. Scopes keep screens apart: `.epub-library` (add books, search, card, view, stats, batch Mokuro), `:is(.epub-reader-shell, .pdf-reader-shell)` (back, bookmarks, stats, Zen), `.epub-reader-shell` (toc, search, next chapter incl. scroll-past ring, appearance, auto-scroll, audio; manga: Mokuro badge, crop bubble, pages, reader settings), `.pdf-reader-shell` (library, 4-tab drawer, reading point O/R, Aa layout/fit/zoom/rotate/theme, reflow, search, page number). Player: open, library, deck, line panel (T), subtitles on video, line jump, playback settings, line to Anki.
- `modeTips("epub" | "player")` now return these; `OnboardingLayer` runs `CoachTour` with `watch` (re-checks every 1.5 s, so a book's tips appear when it is opened).
- `Coachmarks`: adds `body.onb-touring` while open; `onboarding.css` keeps `.epub-floating-top/bottom.is-hidden` and the player's `[data-idle="true"]` HUD/transport visible. A tip whose element disappears for ~0.75 s moves on or ends the tour without marking the rest seen.
- `tests/onboarding.test.mjs` now bundles the modules with esbuild (node can't resolve extensionless TS imports). Harness `window.checkSelectors()`: 192 selectors, all valid CSS. Not run against a real open book or video.

## 2026-11-26 (later 5) — Tips for the Esc menu and every settings section, sample lines

- `CoachTour.tsx`: reusable first-time tour for any surface (`steps`, `active`, `delayMs`); one tour at a time (module flag), restarts after `resetOnboarding()`. `OnboardingLayer` now uses it.
- `surfaceTips.ts`: Esc menu (11 tips: tabs, +, archive, sources, each action tile, footer) and settings (nav + top actions, then each card by its existing id: `#text-app`, `#text-stats`, `#text-src`, `#text-filters`, `#epub-*`, `#player-*`, `#jl-main`, `#lookup-*`, `#anki-cards|audio|hooks`, `#ai-main`, `#cloud-main`, `#discord-main`, `#updates-main`, `#feedback-main`). Mounted in `AppMenu.tsx` (adds `data-coach="menu-add"` and `data-coach="menu-<tile id>"`) and `SettingsModal.tsx` (tour per `activeTab`).
- `Coachmarks.tsx`: `pick: "last"` targets the last match on screen (the lookup tip now sticks to the newest line), scrolls off-screen targets into view, puts the card inside the top-right corner of big panels; layer z-index 12000 (settings are 10000, menu 9000/9500).
- Clean install (no `txthk-tabs`): the first tab starts with `ONBOARDING_SAMPLE_LINES` (Umineko EP4 line given by the user + "We'll be together for all eternity."). The English line is confirmed by fan transcriptions; the exact Japanese wording was not found online.
- Settings tour not exercised in a browser (needs Tauri); menu and reader tips checked in `tests/browser-onboarding.html` (`?mode=menu`).

## 2026-11-26 (later 4) — Contextual onboarding: mode intros and button tips

- Merged `origin/dev` (`bc6ccf2`, Vlad's EPUB scroll transitions + PDF reader) before this; no overlap with local work.
- New module `src/features/onboarding/`:
  - `onboardingStore.ts`: localStorage key `setsuna-onboarding` `{ intros: {mode: true}, tips: {id: true} }`, `resetOnboarding()` fires `setsuna:onboarding-reset`.
  - `guides.ts`: RU/EN texts. Intros for `texthooker`, `epub`, `player`; button tips (`CoachStep { id, target selector, title, body }`) for TextHooker only so far: `[data-coach="tab|source|flow|ai|menu|stats"]` and the first `[data-line-index]` (Shift lookup).
  - `ModeIntro.tsx` (LiquidGlass card, user's pick "B"), `Coachmarks.tsx` (ring + glass card with arrow, "N из M", Пропустить / Дальше / Готово, Enter/→/Esc; user's pick "A"), both portalled to `body`. `OnboardingLayer.tsx` runs the intro on a mode's first visit, then tips for buttons that are on screen and unseen; desktop only for tips.
- Wiring (surgical): `App.tsx` mounts `<OnboardingLayer>` when `resolvedWorkspace !== "hub"`; `ReaderChrome.tsx` adds `data-coach` attributes and keeps the auto-hiding island shown while `setsuna:coach-active` is true; `StatsPanel.tsx` adds `data-coach="stats"` to its three layouts; `HomeScreen.tsx` gets a "?" per mode (`.home-mode-slot` wrapper) that opens the intro; `SettingsModal.tsx` appearance card gets "Показать подсказки заново".
- To add tips for another mode: put `data-coach` on its buttons and add steps in `guides.ts` `modeTips`.
- Tests: `tests/onboarding.test.mjs`; browser harness `tests/browser-onboarding.html` (`?mode=texthooker`, `window.resetTips()`).

## 2026-11-26 (later 3) — Advanced field mapping, Discord "I Am Setsuna", duplicate audit

- `SettingsAnki.tsx`: "Открыть ручные настройки" is now "Для опытных" and shows a JL-style table: each field of the note type gets a source (Слово, Чтение, …). It writes the same `ankiField<Source>` settings (one source per field; picking a source for a field clears it elsewhere), so storage and the default auto-mapping are unchanged. `ANKI_FIELD_SOURCES` constant; lists sources that will not reach the card.
- Discord showing "I Am Setsuna / Not Sharing" with Rich Presence off is Discord's game auto-detection: the Steam game I Am Setsuna ships `Setsuna.exe`, same as our binary. Our RPC never connects while disabled and closes on tray/disable. Only fix on our side would be renaming the binary (`mainBinaryName`), not done: installer/updater/autostart impact, maintainer decision.
- Duplicate check audited: desktop logic (two `findNotes` by word field, same deck vs other decks, reading filter, 15 s cache cleared on add) is fine, left as is. AnkiDroid has no duplicate check at all (`checkWordsStatusMulti` returns green on the bridge); would need a Kotlin `findDuplicateNotes` method. Not done.

## 2026-11-26 (later 2) — Setsuna Japanese is the default note type

- `anki.ts`: `ensureSetsunaAnkiSetup` now always creates/upgrades "Setsuna Japanese" (desktop) and returns it as `defaultModel` (Lapis second; AnkiDroid cannot create, so Setsuna Japanese if present, else Lapis). `ensureSetsunaNoteType` keeps the user's current type, otherwise Setsuna Japanese. Users who already chose Lapis keep it (`settings.ankiModel` wins in `SettingsAnki`/`SetupWizard`).
- New helpers `recommendedNoteTypes`, `sortNoteTypes`, `noteTypeLabel`: Setsuna Japanese and Lapis (or the first Lapis copy if plain Lapis is missing) go first with "· рекомендуется" in the note type selects of `SettingsAnki`, `SetupWizard` and the mobile Anki panel in `AppLayout`. Hint text updated. Test in `tests/feedback-audio.test.mjs`.

## 2026-11-26 (later) — いそいそ scan, 々 furigana in Anki

- `japanese_tokenizer.rs` `split_reduplicated_kana` split every kana XYXY word, so mimetic adverbs (いそいそ, わくわく, そわそわ, ぺこぺこ) became いそ|いそ and `scan_word_limits` capped the scan at the first half. It now keeps a token whose IPADIC lemma equals its surface (adverbs are known whole); the misread いたいた (lemma いたい) is still split. Tests: `keeps_mimetic_adverbs_whole`, `scan_takes_the_whole_mimetic_adverb` (lib).
- `anki.ts` `isKanjiChar` (Anki furigana / Lapis ruby) now counts 々, 〆, ヵ, ヶ as kanji: 神々しさ was exported as 神[こうごうしさ]々しさ, now 神々[こうごう]しさ. Cases added to `tests/feedback-audio.test.mjs`. The popup's own splitter in `Lookuper.tsx` already handled 々.
- Note type dropdown in Anki settings is AnkiConnect `modelNames` (the user's own Anki note types; the Lapis+…+ copies come from Anki import renaming). Setsuna only ever creates "Setsuna Japanese". Not changed.

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
