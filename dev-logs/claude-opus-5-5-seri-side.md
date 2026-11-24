# Work Log — `claude-opus-5-5` (`seri` side)

> **Owner:** `seri` (`Lilislv`) · **Model:** `claude-opus-5-5`
> **Rule:** Only this model on `seri`'s side appends to this file (newest entries at the top). Other agents/developers read it for context and write to their own `dev-logs/<model-name>-<developer>-side.md`.

---

## 2026-11-24 — Review of the manga OCR / player work, player label test fix, push

- Reviewed the local (unpushed) Gemini manga OCR suite and the GPT player poster/transport pass before pushing them to `dev`. All four AGENTS.md checks pass: `npm run build`, `verify-public-build`, `node --test tests/*.test.mjs` (60/60), `cargo check --no-default-features`.
- Fixed `episodeLabel` (`src/features/player/localMedia.ts`): files with a season now get the compact `S02E11` label that `tests/player.test.mjs` already expected (the test had been updated without the function). Used by the library list and the episode picker.
- Not committed on purpose: `NUL` (stray empty file from a shell redirect), `docs/yatsu-desktop-preview.md` and `scripts/extract-rose-guns-days.mjs` (private, keep out of the repo).

## 2026-11-23 — Shared reading, Anki QoL, AI panel (landed in `b9c937f`)

- **Shared reading** (`src/utils/sharedReading.ts`, `src/utils/useSharedReading.ts`, `src/components/SharedReadingDialog.*`): peer to peer over WebRTC via Trystero (`trystero@0.26.0`, Nostr strategy). Signaling uses 12 public Nostr relays that are not behind Cloudflare (PeerJS / `0.peerjs.com` was blocked for a friend in RU, error `network`). Room code `XXX-XXX` = room id + SDP password. Host serves a chunked snapshot to each joining viewer, then broadcasts `append/set/insert/remove/title` ops from a line diff; viewers accept messages only from the peer that sent `hello`. Tab field `shared?: { code, role, ended? }`; `isTabLocked(tab)` in `constants.ts` makes viewer tabs read-only and keeps hooked text out of them. `shared` is stripped from cloud backups. Error codes shown in the dialog: `[relays]` (no relay reachable), `[webrtc]` (direct connection failed). Test page: `tests/browser-shared-reading.html?side=host|viewer` (one client per tab; Trystero has one peer id per page). The Worker room code under `server/` was removed again (backend cancelled).
- **Anki:** `src/utils/ankiCardTemplate.ts` is a full "Setsuna Japanese" note type (pitch graph, furigana, picture, sentence highlight, night mode). It is created on a profile without Lapis and upgraded in place when its template marker is older (`upgradeSetsunaModel`). The first-run wizard no longer overrides an existing note type (`ensureSetsunaNoteType(current)` prefers it, then Lapis). Per-tab deck: `DeckPicker` + menu tile; `tab.ankiDeck` is used in any deck mode. `captureRequest.ts`: adding a screenshot card without a capture process opens the process picker and binds the choice to the tab.
- **AI panel:** per-tab chats + one general chat (history v2 in `ai/history.json`), prompt settings `aiExplainLanguage/aiSourceLanguage/aiDetail/aiCustomPrompt`, tab memory of names (`Chat.memory`, auto extraction after each explanation), custom models folder (`ai_set_models_dir`, `ai/config.json`).
- **Gotcha:** never rewrite `src/App.tsx` while `vite`/`tauri dev` is running with a half-applied edit — a reload in between left the window on the static `#setsuna-boot` placeholder.
