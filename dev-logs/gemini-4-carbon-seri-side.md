# Gemini 4 Carbon — Seri Side Work Log

## 2026-11-24 — Live System-Wide `Shift`-Hover Lookup Fixes (Windows)

- **Summary:** Fixed crash and focus/visibility bugs in the background Windows live `Shift`-hover lookup watcher so holding `Shift` and gliding the cursor over text in Vivaldi/Chromium, Discord, PDF viewers, and editors pops up and updates `lookup_external` in real time without stealing focus.
- **Root Causes Fixed:**
  1. **Debug-mode integer overflow panic (`setsuna-crash.log`):** `last_scan_pt` / `last_anchor_pt` were initialized to `i32::MIN`, causing `(pt.x - last_scan_pt.x)` to panic with `attempt to subtract with overflow` on the very first `Shift` press in `tauri dev` (`debug_assertions`), killing the `setsuna-global-live-hover` thread. Replaced with `Option<POINT>` and `i32::abs_diff` across coordinate math.
  2. **Non-activating UI-thread window show (`SW_SHOWNOACTIVATE`):** Switched `show_lookup_agent_window_internal(..., focus = false)` to run on the main thread (`app.run_on_main_thread`) and show `lookup_external` via `ShowWindow(hwnd, SW_SHOWNOACTIVATE)` + `SetWindowPos(HWND_TOPMOST, ..., SWP_NOACTIVATE | SWP_SHOWWINDOW)` instead of `window.show()` (`SW_SHOW`), preventing focus theft and false `Focused(false)` (`lookup_agent_blur`) auto-close triggers.
  3. **Chromium/Vivaldi child `HWND` wakeup & stationary `Shift` retries:** `wake_chromium_accessibility_if_needed` now resolves `GetAncestor(hwnd, GA_ROOT)` so child `Intermediate D3D Window` surfaces still wake `Chrome_RenderWidgetHostHWND` via `WM_GETOBJECT(OBJID_CLIENT)`, with short stationary retries while Blink builds its accessibility tree.
  4. **Exact character hit-testing:** Tightened `range_contains_point` horizontal check to `[left, left + width)` so hovering the right half of a character (`記` in `記憶の片隅`) never bleeds into the next character (`憶`).
- **Touched Modules:**
  - `src-tauri/src/global_lookup.rs`
  - `src-tauri/src/main.rs` (`hide_external_lookup_window`, `show_lookup_agent_window_internal`)
  - `src/lookup-window.tsx`
- **Verification:** `cargo check --no-default-features`, `npm run build`, `node scripts/verify-public-build.mjs`, `node --test tests/*.test.mjs` (47/47 pass).
