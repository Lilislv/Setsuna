# Setsuna Mobile Roadmap

This document tracks the first mobile architecture pass. The goal is not a reduced companion app: mobile Setsuna should receive text, look up words with the same Yomitan dictionaries, create Anki cards, and share Google Drive sync data with desktop Setsuna.

## Target Scope

- Android first. Android has AnkiDroid and a third-party app API for adding notes.
- iOS later. iOS can share text/files and use Google Drive, but AnkiMobile does not expose the same local add-note API as AnkiDroid, so iOS card creation needs a queue/export flow unless a better native path is found.
- Desktop stays the source of Windows-only features: texthook process capture, window screenshot capture, Discord Rich Presence, JL floating window, and local LAN relay.

## Shared Core

These parts should be platform-neutral and reused by desktop and mobile:

- Yomitan dictionary import into `dictionary.db`.
- Lookup, deinflection, frequency, pitch, furigana formatting, and duplicate-status logic.
- Anki note payload creation: fields, screenshots, audio refs, sentence, dictionary name, frequency, pitch.
- Google Drive appDataFolder access for shared state and dictionary database sync.
- Text/tab/archive data model.

## Platform Adapters

### Desktop

- Anki: AnkiConnect at `http://127.0.0.1:8765`.
- Text input: texthook, clipboard, manual paste, LAN/cloud relay.
- Screenshots: local Windows windows/processes and remote Setsuna capture agents.
- File import: desktop file picker.

### Android

- Anki: native Tauri Android plugin that wraps AnkiDroid API.
- Text input:
  - Android share target for selected/shared text.
  - Manual paste/input.
  - Google Drive text queue from desktop.
- Dictionaries:
  - Android file picker for Yomitan ZIP/JSON.
  - Import through the same Rust importer into app data `dictionary.db`.
  - Restore/upload shared `dictionary.db` via Google Drive.
- Screenshots:
  - Account device list remains useful for remote screenshot devices.
  - Android itself should not pretend it can capture arbitrary PC windows.

### iOS

- Text input through share sheet/manual paste/GDrive queue.
- Dictionaries through file picker and shared importer if Tauri iOS file access is sufficient.
- Anki fallback:
  - Queue notes in Google Drive for desktop Setsuna to add through AnkiConnect.
  - Optional `.apkg` export later.

## Google Drive Sync Shape

Current Drive sync is a manual backup plus separate `dictionary.db`. Mobile needs small named files in appDataFolder:

- `setsuna_state.json`: tabs, active tab, archive metadata, timer state, updatedAt/deviceId.
- `setsuna_text_queue.jsonl`: append-only incoming text events for mobile/desktop relay.
- `setsuna_anki_queue.jsonl`: mobile/iOS fallback notes waiting for desktop AnkiConnect.
- `dictionary.db`: shared imported dictionary database.
- `devices.json`: last-seen device metadata for Drive-only sync, separate from account screenshot devices.

Conflict rule for the first pass: last writer wins per entity, using `updatedAtMs` and stable IDs. Text queue entries are append-only and deduplicated by event ID.

## Anki Mobile Design

The frontend should call one Setsuna Anki facade:

```ts
addNote(settings, noteData)
getDecks()
getModels()
getModelFields(modelName)
checkWordsStatusMulti(...)
```

Under the facade:

- Desktop backend uses AnkiConnect.
- Android backend calls a native command implemented by a Tauri mobile plugin.
- iOS/fallback backend writes to `setsuna_anki_queue.jsonl` in Google Drive and shows that the note is queued.

The note builder should stay in TypeScript so desktop and Android produce identical fields. Only the final delivery differs.

## First Implementation Steps

1. Keep `main.rs` desktop plugin setup mobile-safe.
2. Extract an Anki backend interface from `src/utils/anki.ts`.
3. Add an Android Tauri plugin command:
   - `anki_android_is_available`
   - `anki_android_add_note`
   - `anki_android_get_decks`
   - `anki_android_get_models`
   - `anki_android_get_model_fields`
4. Add Google Drive live files for text queue and note queue.
5. Add a mobile layout route with three primary screens:
   - Text
   - Lookup
   - Mine
6. Add Android share target plumbing for incoming text.

## Open Risks

- AnkiDroid media insertion has stricter Android file/URI permission rules than AnkiConnect. Screenshots/audio should be written to app cache and passed through content URIs.
- Very large `dictionary.db` sync may need resumable Drive upload/download instead of single request.
- Desktop `main.rs` still contains many Windows-only commands. Android should either compile with stubs for those commands or split command modules by platform.
