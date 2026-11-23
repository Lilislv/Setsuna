# Setsuna — Agent & Team Collaboration Guide

This repository is actively developed in parallel by two people (often with AI coding agents: Claude Code, Antigravity, Codex, Cursor, etc.). Follow these rules so both sides can pick up each other's new features on the fly without breaking builds or losing work.

> Note: `PROJECT_CONTEXT.md` may lag behind `dev`. When docs and code disagree, trust the code.

---

## 1. Branching & Sync Model

- **`main`** — **stable public releases only.** Never commit WIP directly to `main`, and never merge `dev` into `main` unless the repo owner explicitly asks to prepare a release.
- **`dev`** — **shared integration branch.** All active features from both developers meet here.
- **Feature branches** (e.g. `feature/epub`, `feature/ai`, `feature/shared-reading`) — branch off `dev`, keep them short-lived or sync them with `dev` frequently, and merge back into `dev` once working.

### Sync Routine & Per-Model Work Logs (for agents & humans)

Each AI model keeps **its own** markdown work log inside `dev-logs/` so parallel work never causes log merge conflicts:

- **Filename format:** `dev-logs/<model-name>-<developer>-side.md` (lowercase kebab-case)
  - Examples: `dev-logs/gemini-4-neon-seri-side.md`, `dev-logs/claude-opus-4-lambdawesta-side.md`, `dev-logs/gpt-5-codex-lambdawesta-side.md`
- **Ownership rule:** Only append to **your own** `<model-name>-<developer>-side.md` file (create it if it doesn't exist yet). **Never edit** another model's or developer's log file.

**Before starting a new task or large edit:**
1. Fetch and merge latest `dev`:
```bash
git fetch origin
# If working in a fork, fetch upstream instead:
# git fetch upstream
```
If `origin/dev` (or `upstream/dev`) has new commits, merge them into your current branch **before** editing shared files:
```bash
git merge origin/dev
```
2. Check `dev-logs/*.md` and read the top entries of the **other** developer's / models' logs to see what was recently added or changed on `dev`.

**After finishing a working milestone:**
1. Run the verification checks (Section 4).
2. Add a concise entry at the **top** of **your own** `dev-logs/<model-name>-<developer>-side.md` (newest first: date, commit/feature summary, touched modules, new Tauri commands/settings/storage keys, and any gotchas for other agents).
3. Commit with a clear conventional message (`feat:`, `fix:`, `refactor:`, `docs:`).
4. Push to `dev` (if collaborator) or to your feature branch and open/update a PR into `dev`.

### Hard Git Safety Rules
- **NEVER** force-push (`git push --force` / `--force-with-lease`) to `main` or `dev`.
- **NEVER** `git reset --hard` or rewrite commits that have already been pushed to a shared branch.
- **NEVER** commit untracked personal/scratch files, build artifacts, `dictionary.db*`, `.env`, or Android signing files (`src-tauri/gen/android/key.properties`, `*.jks`, `*.keystore`).

---

## 2. Module Ownership & Conflict Prevention

Keep new features **isolated in their own folders/modules** so parallel work rarely touches the same lines:

| Area | Primary Location |
| --- | --- |
| EPUB / TXT / HTMLZ reader | `src/features/epub/*`, `src-tauri/src/epub_import.rs`, `tests/epub-model.test.mjs`, Android EPUB hooks in `MobileFileBridge.kt` / `MainActivity.kt` |
| Shared reading (P2P / Trystero) | `src/utils/sharedReading.ts`, `src/utils/useSharedReading.ts`, `src/components/SharedReadingDialog.*` |
| Local AI assistant (Gemma / llama.cpp) | `src-tauri/src/ai_assistant.rs`, `src/utils/aiAssistant.ts`, `src/components/AiPanel.*`, `src/components/Settings/SettingsAI.tsx` |
| Dictionary sharing (Google Drive) | `src-tauri/src/dictionary_share.rs`, `src/components/Settings/DictionaryShare.*` |
| Anki templates & deck picker | `src/utils/anki.ts`, `src/utils/ankiCardTemplate.ts`, `src/components/DeckPicker.*`, `src/utils/captureRequest.ts` |

### Hot Shared Files — Edit Surgically
Both developers occasionally need to wire features into these files:
- `src/App.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/AppLayout.tsx`, `src/components/AppMenu.tsx`, `src/components/AppMenu.css`
- `src/utils/constants.ts`, `src/utils/i18n.ts`
- `src-tauri/src/main.rs` (desktop Tauri commands)
- `src-tauri/src/lib.rs` (Android/mobile Tauri commands)

**Rules for hot files:**
1. Make minimal, surgical additions — delegate logic to your own module/hook instead of adding hundreds of lines inside `App.tsx` or `main.rs`.
2. **Do not reformat, reorder imports, or refactor untouched sections** of hot files.
3. Keep both Russian and English strings when editing `src/utils/i18n.ts` or UI components.
4. Remember desktop and Android register Tauri commands separately (`main.rs` vs `lib.rs`). If a command is used on both platforms, register it in both.

---

## 3. Protected Areas (Do Not Touch Without Explicit Request)

- **Private reader (Yatsu):** `src/components/YatsuWorkspace.*`, `src/yatsu-lookup.*`, `yatsu-lookup.html`, `src-tauri/src/yatsu.rs`, `src-tauri/src/yatsu-reader.js`, `private-reader` Cargo feature. Do not copy code or names from them into public modules.
- **Cancelled accounts backend:** `server/` and `account_*` commands are cancelled; do not build new features on top of them.
- **Release metadata:** version bumps in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/release-info.json`, `CHANGELOG.md`, and `.github/workflows/release.yml` belong to the maintainer.

---

## 4. Mandatory Checks Before Pushing to `dev`

Run these before every push/merge into `dev`:

```bash
# 1. Strict TypeScript check + production frontend bundle
npm run build

# 2. Verify no private-reader strings leaked into public dist/
node scripts/verify-public-build.mjs

# 3. Frontend unit tests
node --test tests/*.test.mjs

# 4. Rust compilation check (required whenever src-tauri/ is touched)
cargo check --no-default-features --manifest-path src-tauri/Cargo.toml
```

---

## 5. Resolving Merge Conflicts Safely

When merging `dev` ↔ feature branch:
1. **Never blindly accept "ours" or "theirs"** in shared files (`App.tsx`, `SettingsModal.tsx`, `lib.rs`, `main.rs`, `i18n.ts`, `constants.ts`).
2. Read both sides of every conflict hunk and **preserve both features** (for example, keeping both newly registered Tauri commands in `lib.rs`, or combining `resolvedWorkspace === "texthooker" || resolvedWorkspace === "epub"`).
3. After resolving all conflicts, **always run all 4 checks in Section 4** before committing the merge.

---

## 6. Windows Git Note

On machines with devkitPro/MSYS2 in `PATH`, plain `git` may resolve to MSYS2 git and fail inside sandboxed shells. If that happens, invoke native Windows Git explicitly:
```powershell
& "C:\Program Files\Git\cmd\git.exe" <args>
```
