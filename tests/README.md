Lookup and memory regressions
=============================

Run `node tests/platform-layout.browser.cjs` with `PLAYWRIGHT_MODULE` pointing to
Playwright when it is not installed locally. It mounts the real App and Lookuper
with mocked native commands and checks that resizing from 1280 to 480 pixels
keeps the desktop toolbar/floating lookup on Windows and the mobile shell/sheet
on Android, including a wide landscape viewport. No user settings are modified.

Run `node --test tests/hover-scan.test.mjs` for character changes, bounded pending
lookups and stale-reply cancellation. Start `npm run dev -- --port 1432` and open
`http://127.0.0.1:1432/tests/browser-hover-scan.html` for the real DOM/React regression:
moving inside a selected word, held hotkeys across renders, slow replies, vertical
text, ruby, UTF-16 offsets and whitespace hit-testing. Native lookups are mocked.

Scanner behavior was compared with the supplied Yomitan checkout's
`ext/js/language/text-scanner.js` (`_search`, `_onMousePointerMove`),
`ext/js/dom/text-source-range.js` (`hasSameStart`),
`ext/js/dom/text-source-generator.js` (`_isPointInRange`), and
`ext/js/language/translator.js` (`_sortTermDictionaryEntries`).
Identical meanings also require identical dictionaries: the installed legacy
JMdict Extra has the crack entry under `罅`, whereas the screenshot's newer
Jitendex has a literal `ヒビ` headword. The scanner does not rewrite dictionary data.

Run `node --test tests/runtime-memory.test.mjs` (Node 22.18+ or 24) for snapshot
backpressure, workspace fingerprints and enabled-dictionary source selection.
Run `cargo test --offline --no-default-features --manifest-path src-tauri/Cargo.toml`
for dictionary import/migration, lookup, sync compaction and the 1,406 vendored
Yomitan Japanese grammar cases. Regenerate those cases and rules with
`node scripts/generate-yomitan-japanese.mjs` when updating the supplied upstream checkout.

For the rendering regression, start `npm run dev` and open
`http://127.0.0.1:1420/tests/browser-memory.html`. The isolated fixture automatically
checks 20,000 history lines in both orientations, a distant search target, and
pagination over 2,000 dictionary results. PASS/FAIL results appear above the text.
It does not require Tauri, alter the user's workspace, or reproduce a native
WebView process crash; it checks that DOM growth stays bounded and navigation works.

Feedback and local audio
------------------------
Run `node --test tests/feedback-audio.test.mjs` for GitHub URL/clipboard handling,
local/online audio selection, media transfer to Anki, failure handling and blob cleanup.
The Rust suite also tests read-only SQLite audio lookup, reading/source matching,
kana normalization and recording size limits. To check a real audio database in
PowerShell: `$env:SETSUNA_AUDIO_DB='C:\path\android.db'`, then
`cargo test --offline --no-default-features --manifest-path src-tauri/Cargo.toml -j 1 local_audio::tests::real_audio_database -- --ignored`.
The supplied database stays read-only; only matching audio blobs are loaded.

For UI checks, run `npm run dev -- --port 1432` and open
`http://127.0.0.1:1432/tests/browser-feedback-audio.html` on that isolated test origin.
It mocks native boundaries, seeds a synthetic report, intercepts GitHub/clipboard
actions, and offers a silent WAV for checking the audio controls. It never submits
an issue or creates an Anki card. Local database selection currently targets desktop;
Android document-provider URIs need a separate storage integration.

Android dictionaries and Flow
-----------------------------
The Rust library suite now checks streamed Drive recovery (HTTP Range/restart),
empty downloads, bounded retries, SQLite rollback, standard Yomitan term metadata,
and a monotonic Flow timer which excludes pauses. Tests use local HTTP fixtures
and temporary databases; they never access the user's Google account or dictionaries.
See `docs/mobile-dictionaries-and-flow.md` for mobile format support and device checks.

Run `node --test tests/gdrive.test.mjs` for the production Drive metadata client:
pagination, choosing a ready database over unfinished uploads, surfaced authorization
errors and native resumable-upload headers. HTTP is mocked; no account is accessed.

Mobile tap regressions
----------------------
Open `/tests/browser-mobile-lookup.html` in the local Vite test server. Tap 猫, 犬,
鳥, then 猫 again, and move focus outside the line. All five word buttons must
remain and the log must read `猫:0|犬:2|鳥:4|猫:0`. This exercises the real React
TextContainer; only native IPC is mocked. `?layout` shows the real mobile timer
control, and `?layout&settings` opens shared dictionary management at phone width.
Use an isolated browser origin/profile, as with the other browser fixtures.

Audio settings
--------------
Run `node tests/audio-settings.browser.cjs` (with Playwright available) to check the
source menu, database connection status, online-first fallback and disconnection.
Native boundaries and playback are mocked; the real component is rendered.
`node scripts/verify-public-build.mjs` checks public frontend assets after a build.
