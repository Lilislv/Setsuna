# Setsuna Project Context

Last updated: 2026-11-18 (version 0.2.0, derived from the code; see `CHANGELOG.md` for release notes)

Setsuna is a desktop and Android app for learning languages through reading — primarily Japanese (visual novels, books, subtitles), with English lookup support as well.

- Public repo: https://github.com/Lilislv/Setsuna
- Website: https://www.setsunalookup.ru (sources in `docs/`)

When this file and the code disagree, trust the code.

## Stack

- Frontend: React 19, Vite 7, TypeScript. Entry points: `index.html` (main app), plus separate windows `lookup-window.html`, `jl-window.html` / `jl-popup.html` (Setsuna Flow), `capture-region.html`, `yatsu-lookup.html`.
- Desktop shell: Tauri 2 (Windows primary, Linux + Arch package in `packaging/arch/`).
- Android: Tauri mobile + native Kotlin in `src-tauri/gen/android/app/src/main/java/com/serichka/setsuna/`.
- Backend: Rust in `src-tauri/src/`. Most Tauri commands are registered in `main.rs` (desktop) and `lib.rs` (mobile entry).
- Storage: SQLite (`rusqlite`) `dictionary.db`, shared schema for desktop and Android (`core/database.rs`).
- Server: `server/` holds a Cloudflare Worker for accounts/devices — the accounts direction is cancelled (see below).

## App Modes (Home Screen)

| Mode | Status | Notes |
| --- | --- | --- |
| TextHooker | Released | Main reader: tabs, history, archive, stats, lookup, Anki. |
| EPUB reader (Yatsu) | Private / dev only | `epub_import.rs`, `yatsu.rs`, `yatsu-reader.js`. Enabled with `VITE_PRIVATE_READER=1` or dev build (`src/utils/featureFlags.ts`). |
| Anime player | Dev only | `PlayerSkeleton.tsx`, `player_media.rs` (ffmpeg clip extraction). |

The old in-app browser panel has been removed; legacy browser settings are stripped on load in `App.tsx`.

## Implemented Features

### Text input (TextHooker)
- Multiple WebSocket sources with auto-connect and a primary source.
- Clipboard monitoring and paste; garbage tag cleanup (`textCleaner.ts`).
- Tabs with per-tab stats, virtualized history (`@tanstack/react-virtual`), archive of finished/paused sessions.
- Fonts, custom font import (`customFonts.ts`), themes, furigana mode, stats panel position.

### Lookup and dictionaries
- Yomitan dictionary import (single/batch), revision updates from source, delete/clear, duplicate cleanup (`dictionary_import.rs`, `dictionary_engine.rs`).
- Japanese: Lindera with embedded IPADIC (`japanese_tokenizer.rs`), Jidoujisho-style morpheme grouping, Yomitan-compatible deinflection (`japanese_deinflector.rs`, `deinflect.json`), furigana (`get_furigana`).
- English: multi-word entries, phrasal verbs (including separable ones), idioms with possessive patterns, form normalization (`lookup_normalization.rs`).
- Kanji lookup.
- Audio: local audio database + online sources with configurable priority (`local_audio.rs`, `dictionaryAudio.ts`).
- Global hover lookup outside the app: Windows UIA/Scintilla, Linux X11 accessibility (`hover_lookup.rs`, `hoverScan.ts`); region-capture lookup with a configurable shortcut.

### Setsuna Flow
- Compact always-on-top window showing the latest line with interactive lookup and a reading timer (`flow_timer.rs`, `jl-window.tsx`, `jl-popup.tsx`).
- Android version is a native overlay service with move/resize/font/color/opacity settings.

### Anki
- AnkiConnect: auto-launch Anki, auto-configure allowed origins (with config backup).
- Default deck/model "Setsuna" / "Setsuna Japanese"; field mapping recommendations; works with and without the Lapis note type.
- Word status highlighting against existing cards, browse cards for a word.
- Screenshots: per-process/window capture with foreground history, per-tab screenshot source binding.
- AnkiDroid bridge on Android (deck/model selection, notes, screenshot).

### Sync and remote devices
- Setsuna Sync: LAN text-sync server, remote polling/push, cloud text-sync rooms (`textSyncCloudUrl` / `create_text_sync_cloud_room`).
- Remote capture agent: token-protected HTTP server listing windows and returning screenshots; client can connect by URL + token.
- Google Drive (AppData) backups: archive, selective restore/delete, quota check, chunked resumable upload/download of large `dictionary.db`, cross-platform backup format compatibility.

### Other
- Discord Rich Presence with preview.
- Tray icon, signed optional auto-updates via GitHub Releases (`plugin-updater`, `docs/release-updates.md`).
- Setup wizard (language, theme, font, size, stats position, furigana, Yomitan dictionary steps).
- RU/EN localization (`src/utils/i18n.ts` + inline `isEn` strings in some components).
- Diagnostics logging (memory snapshots, frontend log forwarding, `scripts/analyze-diagnostics.ps1`).
- Feedback form in settings.

### Android
- Phone UI with text, manual input, dictionaries and settings sections.
- Text intake: WebSocket, Android Share, `PROCESS_TEXT`, clipboard, manual input; foreground capture service.
- Bundled starter dictionaries (`src-tauri/resources/mobile-starter-dictionaries.zip`), local Yomitan import, native dictionary lookup (`NativeDictionary.kt`, `android_lookup.rs`).
- See `docs/mobile-*.md` for the mobile spec and roadmap.

## Known Gaps / Next Candidates

- Japanese word and sentence stats are still heuristic (`calculateStats` in `src/utils/helpers.ts` splits on punctuation/whitespace); they do not use the Lindera tokenizer yet. Character stats are correct.
- EPUB reader and anime player are not enabled in public builds.
- Remote capture: no pairing UI (QR/short code), trusted device list or encrypted session yet; remote sources are not yet selectable in the main Anki flow — verify against `SettingsModal.tsx` before working on it.
- Localization is split between `i18n.ts` keys and inline `isEn ? ... : ...` strings.
- Large files worth splitting when touched: `main.rs` (~5.9k lines), `App.tsx` (~3.4k), `dictionary_import.rs`, `AppLayout.tsx`, `dictionary_engine.rs`.

## Cancelled

- Setsuna accounts and everything tied to them (register/login, device registration/listing, account-based relay/discovery) are fully cancelled. Leftover code still exists and is a removal candidate: `account_*` commands in `main.rs`/`lib.rs`, the `account_register_device` call in `App.tsx`, and `server/` (Worker, `schema.sql`, `wrangler.example.toml`). Do not build new features on top of it. Google Drive sync/backups are NOT affected and stay as the cloud sync mechanism (they use Google OAuth, not Setsuna accounts).

## Planned (not started)

- Co-reading rooms (maybe, later): one user creates a room, others join and see the same hooked text live and can look it up themselves. No accounts — room code/link based. Existing text-sync (LAN server and cloud rooms) is the likely starting point.
- VN guide parser/browser for `seiya-saiga.com` archives (sample archives in `C:\Users\Serichka\Downloads\`): parse routes/choices/endings, offline assets, per-VN progress memory, EUC-JP/UTF-8 detection.
- Project-owned user dictionary for VN names / engine-specific terms; analyzer diagnostics for bad splits.
- English–Russian dictionaries for learning English.
- Styled installer.
