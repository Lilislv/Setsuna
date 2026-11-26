# Work Log — `gpt-6-2-sol` (`seri` side)

## 2026-11-25 — Gemini Android hotfix handoff (local)

- Synced dev at e0a1244 and reviewed the Gemini 4 Neon Seri hotfix tracker. Retained the Android platform version override 0.6.0-beta. Work stays local.
- Player on Android uses a persistent file input and a short-lived Blob URL, plus independent file pickers for original and translated subtitles. Reopening the same file uses its name, size and modification date in setsuna.player.positions to restore the viewing position. Direct HTTPS playback and desktop cinema controls stay shared. Android Anki cards send text via AnkiDroid. FFmpeg clips remain desktop-only. Desktop Anki 25.9.4 on Windows decoded WebM VP9/Opus inside a disposable card, including audio, and Check Media accepted the attachment. Default padding is 0.5 s before and after a cue.
- EPUB selection in App.tsx now invalidates pending cloud opens when a different selection wins or the reader closes. The desktop remote Mokuro host is mounted once from App.tsx and resolves paths through the PC library.
- Verification and remaining steps are being recorded here as the checks finish. No phone was connected to ADB at the start.

## 2026-11-24 — Poster library and themed playback controls

- Baseline `4576f61` includes the video poster grid and `player_search_posters`. Titles are inferred from folder and release filenames. Poster choices persist in `setsuna.player.posters`. AniList, Jikan, TVmaze and Commons use keyless search. TMDB uses an optional session token or `SETSUNA_TMDB_TOKEN`.
- `PlayerTransport.tsx` and `player.css` replace the system overlay with Setsuna playback controls, including seek, mute, persistent volume, fullscreen and expandable transcript. F toggles fullscreen and T toggles the transcript panel. `setsuna.player.audio` stores the global player volume and mute state. Narrow layouts keep Anki actions visible.
- `localPoster.ts` stores reduced JPEG copies of user-supplied JPG, PNG or WebP covers in IndexedDB `setsuna.player.local-posters`, store `images`. The library retains its established display title. Replacement or reset removes old local blobs after the metadata is saved.
- Passed production build, public-bundle check, 57 frontend tests and Cargo check. Four Rust poster parser tests passed. Live AniList returned the exact Watashi title with a working poster. TVmaze and Commons returned live images. Jikan timed out from this machine and authenticated TMDB remained unverified. The Edge harness tested real H.264/AAC playback, seeking, volume, mute, fullscreen, narrow layout, and local-cover reload/reset with mocked Tauri catalog and folder calls.

## 2026-11-24 — Desktop video library and ASS karaoke cleanup

- `PlayerLibrary.tsx`, `usePlayerLibrary.ts` and `libraryModel.ts` add folder selection, recursive indexing, groups by containing directory, numeric episode order, search, rescanning and removal from the list. Playback records completed episodes and restores the exact position when reopening from the library.
- Frontend roots use `setsuna.player.libraryFolders`. Existing `setsuna.player.positions` entries remain compatible and now include duration, last played time and completion. `player-library.sqlite3` stores authorised folder roots in app data. Desktop commands are `player_scan_folder`, `player_allow_library_media`, `player_forget_library_folder` and `player_read_local_subtitle`.
- `localMedia.ts` matches sidecars in `sub` and similar folders even across differing release tags. `SubtitleTracks.tsx` prefers an embedded translation in the interface language when the original track is Japanese. Large ASS files use binary IPC. The parser drops ASS drawing sections and deduplicates identical text with identical timing.
- Verified the user's 13 MKVs against all 13 actual ASS files. Episode 1 at 01:10 has one lyric and no drawing coordinates. Edge smoke tests exercised library navigation and real H.264/AAC playback with mocked Tauri calls, including a run with an embedded translation. Production build, public bundle check, 47 frontend tests, Cargo check and the native folder grouping test passed.

## 2026-11-24 — Desktop player subtitle import, scene export and playback fixes

- Baseline is `b2e4a11` on `dev`, followed by the parallel EPUB work in `0b26a5c`. This pass remains local.
- `src/features/player/` accepts Tauri file drops, sorts episode batches, matches subtitle filenames and prefers Japanese for the primary track. Subtitle and translation offsets are independent. `setsuna.player.positions` now stores `{ time, offset, translationOffset }` per local file and still reads legacy numeric positions.
- Previous/next navigation seeks to neighboring cues. Pause at cue end keeps the last line available for lookup and mining. The compact layout gives more room to the transcript. Nested dictionary lookups retain the source scene and subtitle text.
- `playerAnkiDeck` sets an optional player-specific deck, shared by sentence mining and word lookup. Both use the existing AnkiConnect flow and default to a still frame plus a playable clip with 5 seconds before the line. Commands are unchanged in this pass.
- `src-tauri/src/player_media.rs` keeps audio tracks and their dispositions during compatible MP4 conversion, validates explicit audio selection, protects conversion cleanup against late cancellation and tests clip contents as well as duration. Web-only integrations still use direct HTTPS media or HTML video sources.
- Passed production build, public bundle validation, all 44 frontend tests and desktop Cargo check. Both native player tests passed with FFmpeg/FFprobe. Edge played an H.264/AAC fixture and verified dual subtitle display, navigation and saved offsets. The browser harness simulated Tauri file drops and file reads. AnkiConnect requests are covered by mocked tests.
