# Setsuna Project Context

Last updated: 2026-04-26

Setsuna is a desktop app for learning Japanese. The current target is a polished beta release: fix the known bugs, finish the setup flow, add English localization, and prepare the app for public distribution.

## Current Codebase Snapshot

- Frontend: React 19, Vite, TypeScript.
- Desktop shell: Tauri 2.
- Existing integrations/features visible from project materials: Yomitan-style lookup, Yomitan dictionary import, Anki integration, one-click card creation, reading statistics, Google Drive AppData sync.
- Public repo: https://github.com/Lilislv/Setsuna
- Website: https://www.setsunalookup.ru

## Beta Priorities

1. Fix high-impact bugs.
2. Add English localization.
3. Finish and polish the setup wizard.
4. Make design/theme settings reliable.
5. Improve Japanese text statistics.
6. Prepare a styled installer and update flow.

## Known Bugs

- Browser experience is currently rough and needs cleanup.
- Reading statistics are only reliable for character counts.
- Word and sentence statistics are currently inconsistent or effectively random.

## Recently Fixed In Working Tree

- Color theme switching now applies theme CSS variables from settings.
- Base page/root/scrollbar colors now use theme variables instead of hardcoded dark colors.
- Setup wizard now has compatibility aliases for the app theme variables.
- Browser tab/window management is safer: active browser tabs now clamp invalid saved indices, resize sync is debounced with `requestAnimationFrame`, and showing/navigating a browser tab hides other native browser windows.
- Browser sizing now uses the real `native-browser-container` rect with extra delayed syncs after transitions/resizing.
- Browser tab title/favicon parsing is supported from `tab_*` native windows through Tauri capabilities and a stronger page metadata injection script.
- A small i18n layer now exists for Russian/English UI strings, with the top bar and browser panel wired to it.
- Setup wizard now has a design step for language, theme, text font, font size, stats panel position, and furigana mode.
- Setup wizard copy is wired through the Russian/English i18n layer.
- Browser native webviews no longer auto-show on main-window resize, and the frontend now sends `hide_all` when the browser panel is closed/backgrounded. This targets the Alt+Tab overlap bug where hidden browser tabs could reappear over the app.
- Anki screenshot capture now supports multiple selected processes and prefers the foreground matching process/window when possible.

## Setup Wizard Work

Add design and reading preferences to onboarding:

- Font selection.
- Font size.
- Color theme.
- Stats panel position: top or bottom.
- Furigana preferences.

These settings should use the same underlying state/storage path as the main settings screen, so onboarding and settings never drift apart.

## Localization

Add English localization for the app UI.

Progress:

- A shared `src/utils/i18n.ts` translator exists with Russian and English dictionaries.
- First-run/setup wizard, top bar, browser panel, import/export/confirm modals, stats panel, main text controls, and the visible Settings text/source/filter panels are wired to the app language setting.
- Lookup/Anki action alerts and tooltips now use localization keys.
- Nested settings panels for Lookup, Anki, and Cloud sync have been rewritten with clean Russian/English UI text and switch by `settings.appLanguage`.

Recommended direction:

- Extract visible UI strings from components.
- Add a small i18n layer before the app grows further.
- Keep Russian as an available language.
- Make English complete enough for the beta.

## Japanese Text Analysis

Current issue:

- Character stats are correct.
- Word and sentence stats need a real parsing/counting pass.

Future furigana goal:

- Implement smarter contextual furigana.
- First pass implemented: if a full compound is missing from the dictionary, furigana can now split a known left-hand word plus a common contextual suffix. Example: `shisetsunai` (`U+65BD U+8A2D U+5185`) can become `施設(しせつ) + 内(ない)` instead of falling back to isolated `内(うち)`.
- A regression test covers the `施設内` fallback when the database only contains `施設`.
- Furigana requests now include a small context window from surrounding hooked lines. Backend annotates the combined context, then slices tokens back to the visible line, so split fragments like the tail of `制御室` can avoid being read as isolated `御室`.
- Kanpyo is now wired in as the morphological analyzer. It uses a local MeCab IPADIC binary dictionary at `src-tauri/morph-cache/mecab-ipadic.dict`, so builds do not depend on downloading a dictionary during `cargo build`.
- Furigana generation now tries context-aware Kanpyo token boundaries first, prefers exact Yomitan dictionary readings when available, and falls back to the analyzer reading when the Setsuna dictionary has no exact entry.
- Long-term polish: add a project-owned user dictionary layer for VN names/engine-specific terms and expose analyzer diagnostics for debugging bad splits.

## Anki Screenshot Import

Planned feature:

- Import/create an Anki card with a screenshot.
- The feature should work like a small OBS-style capture flow.
- It should connect to an Anki process/window and capture the relevant screen region for the card.

Progress:

- Settings already allow choosing multiple hook processes.
- Screenshot capture now accepts multiple selected processes, picks the active foreground match when available, then a recently active selected window, and falls back to the largest matching visible window.
- Screenshot process selection now stores process path/PID metadata and displays full paths in settings, so engines like SiglusEngine can be distinguished per VN install.
- Window matching now uses the captured window PID and the selected process path/name before falling back to title/app-name text matching. This targets engines whose visible window title does not match the `.exe` name.
- Screenshot settings now list real visible capture windows with title, PID, size, active/recent status, and provide a test screenshot preview before adding Anki cards.
- Text tabs can store their own screenshot source binding. If a tab such as `Anemoi` is bound to `SiglusEngine.exe`, Anki screenshot capture uses that source first; otherwise it falls back to the global active sources from Anki settings.
- Capture uses direct window capture instead of full-monitor capture plus cropping, avoids forced focus/window hiding, runs off the UI thread, and downsizes large images before JPEG encoding.
- A lightweight Windows foreground-window history runs every 200 ms and stores only HWND values, so clicking Setsuna does not make it forget which selected process was active a moment ago.
- Captured image data is passed to Anki through the configured screenshot/image field.
- The Anki screenshot button now requires at least one active screenshot process instead of silently creating a card without an image.

Open implementation questions:

- Whether we need a screenshot preview/test button in settings for beta QA.
- Whether minimized windows should be restored or intentionally rejected to avoid black/slow captures.

Remote capture scenario:

- User often runs the VN and hooker on another device, such as Steam Deck, while Setsuna runs on a work PC.
- Need a remote screenshot/source bridge so Anki screenshots can come from another device over LAN or, later, through an authenticated account/cloud relay.
- Chosen MVP direction: two running programs on two devices. Main Setsuna runs on the reading/work PC; a lightweight Setsuna Capture Agent runs on the VN device.
- The capture agent exposes selected windows/processes/screens and captures screenshots locally, while Setsuna connects to it from the PC.
- LAN mode should support pairing by QR code or short code, device naming, remembered trusted devices, and manual IP/port fallback.
- Remote screenshot flow should reuse the existing Anki screenshot button: choose a local process or a remote device/source; when adding a card, Setsuna requests a screenshot from the active selected remote source.
- Steam Deck/Linux support likely needs screen/window capture through platform APIs/tools available there; if process/window capture is unreliable, start with monitor/region capture plus manual crop.
- Future hosted mode can use the user's Setsuna domain/account system for discovery, auth, and encrypted relay, but LAN direct mode should work without an account.
- Security requirements: local pairing token, no unauthenticated LAN capture, HTTPS/WSS or an encrypted session when possible, explicit trusted-device list, and a visible remote-capture status.
- Agent API draft: list sources, capture selected source, heartbeat/status, and optional current active source. Prefer WebSocket for control/status and HTTP endpoint for one-shot screenshot payloads, unless Tauri IPC/shared protocol makes a cleaner packaged agent.
- First LAN agent backend exists in the Tauri/Rust layer: `start_capture_agent_server` starts a token-protected HTTP server, `/sources` lists visible capture windows, and `/capture?pid=...` returns a JPEG screenshot. Client-side commands `list_remote_capture_sources` and `take_remote_capture_screenshot` can connect to another Setsuna instance by URL/token.
- Screenshot settings include a basic manual agent start/stop block that shows LAN URL and token. Pairing UI and selecting remote sources in the Anki flow are still TODO.

## VN Guide Parser

New planned feature:

- Build a parser/importer for VN walkthrough guides from `seiya-saiga.com` / `galge.seiya-saiga.com`.
- Example archives provided by the user:
  - `C:\Users\Serichka\Downloads\galge.seiya-saiga.com.zip`
  - `C:\Users\Serichka\Downloads\seiya-saiga.com.zip`
  - `C:\Users\Serichka\Downloads\seiya-saiga.com(1).zip`
- Archive scan on 2026-04-27 found 38 HTML guide pages across the first two archives plus one Root Double guide in the third archive; archives also include shared UI images and route/map JPG assets.

Desired product behavior:

- Add a beautiful in-app guide browser, not just raw HTML rendering.
- Import guide data from downloaded site archives first; later possibly support fetching/parsing a live URL.
- Parse title, VN name, route sections, choice steps, endings/flags, notes, links, and guide images/maps when present.
- Preserve local/offline copies of parsed guides and referenced images.
- Add "memory" for guide usage: current guide, current route/section, last viewed step, checked/completed choices, bookmarks, notes, and maybe per-VN progress.
- Make guide content searchable and easy to jump through while reading/hooking text.
- Keep UI in the Setsuna visual style and localize it RU/EN.

Technical notes from sample archives:

- Source pages are old static HTML from Homepage Builder, heavily table-based, with inline styles and image navigation.
- Some pages declare `charset=EUC-JP`, others `charset=UTF-8`; sample reads showed mojibake risk, so parser should detect encoding from meta tags and have a fallback/recovery path.
- Need a real HTML parser and sanitizer/normalizer rather than regex-only parsing.
- Images can be relative paths in nested folders, so import should remap them into Setsuna's local guide asset storage.
- Parser should keep the original HTML/source snapshot for debugging and future reparse.

## Installer And Updates

Installer:

- Build a polished installer.
- Installer visual style should match the Setsuna app style.

Updates:

- Implement an update system through GitHub releases.
- The project is already on GitHub.

Auth/platform status:

- Google auth client verification is in progress.

## Future Roadmap

- Android version.
- English-Russian dictionaries for learning English.
- Anime player with subtitles.
- EPUB reader.
