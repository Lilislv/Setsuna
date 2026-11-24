//! System-wide Windows text capture & live hover-scan watcher for Setsuna.
//!
//! Architecture highlights:
//! - Uses `COINIT_MULTITHREADED` (MTA) on the dedicated watcher thread as required by
//!   Microsoft for cross-process `IUIAutomation` clients without a Win32 message pump.
//! - Automatically wakes lazy Chromium/Electron (`Vivaldi`, `Chrome`, `Edge`, `Discord`,
//!   `VS Code`, `Obsidian`) accessibility trees via `WM_GETOBJECT(OBJID_CLIENT)`.
//! - Runs `scan_cursor_in_db` AND shows/moves `lookup_external` (via `window.show()` +
//!   `WS_EX_NOACTIVATE` so WebView2's `ICoreWebView2Controller::IsVisible` becomes TRUE
//!   without stealing focus!) directly in Rust, completely bypassing hidden-WebView2
//!   JS throttling.

#![cfg(target_os = "windows")]

use std::collections::HashSet;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use winapi::shared::minwindef::{DWORD, HGLOBAL, LPVOID};
use winapi::shared::windef::{HWND, POINT, RECT};
use winapi::um::handleapi::CloseHandle;
use winapi::um::memoryapi::ReadProcessMemory;
use winapi::um::processthreadsapi::{GetCurrentProcessId, OpenProcess};
use winapi::um::psapi::GetModuleBaseNameW;
use winapi::um::winbase::{GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use winapi::um::winnt::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
use winapi::um::winuser::{
    CloseClipboard, EmptyClipboard, EnumChildWindows, GetAncestor, GetAsyncKeyState,
    GetClassNameW, GetClipboardData, GetClipboardSequenceNumber, GetCursorPos, GetForegroundWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsClipboardFormatAvailable, IsWindowVisible, OpenClipboard, ScreenToClient, SendInput,
    SendMessageTimeoutW, SendMessageW, SetClipboardData, SetForegroundWindow, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, WindowFromPoint, CF_UNICODETEXT, GA_ROOT, GWL_EXSTYLE, HWND_TOPMOST,
    INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SMTO_ABORTIFHUNG, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, VK_BACK, VK_CONTROL,
    VK_ESCAPE, VK_LBUTTON, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MBUTTON, VK_MENU, VK_RBUTTON,
    VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT, VK_SHIFT, VK_SPACE, WM_GETOBJECT,
    WS_EX_NOACTIVATE,
};
use windows::Win32::Foundation::POINT as UiaPoint;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
    SafeArrayUnaccessData,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextChildPattern,
    IUIAutomationTextPattern, IUIAutomationTextRange, IUIAutomationValuePattern,
    TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    UIA_TextChildPatternId, UIA_TextPattern2Id, UIA_TextPatternId, UIA_ValuePatternId,
};

use crate::dictionary_engine::{lookup_word_in_db, scan_cursor_in_db, DictEntry};

const MOD_SHIFT: u32 = 1 << 0;
const MOD_CTRL: u32 = 1 << 1;
const MOD_ALT: u32 = 1 << 2;
/// Default system-wide live scan shortcut: `Shift+Z` (physical VK_Z = 0x5A, layout-independent).
const DEFAULT_LIVE_SCAN_COMBO: u32 = MOD_SHIFT | ((b'Z' as u32) << 8);

static LAST_EXTERNAL_HWND: AtomicIsize = AtomicIsize::new(0);
static LIVE_SCAN_ENABLED: AtomicBool = AtomicBool::new(true);
/// Packed combo: bits 0..3 = modifiers (Shift=1, Ctrl=2, Alt=4), bits 8..16 = optional Win32 VK code.
static LIVE_SCAN_COMBO: AtomicU32 = AtomicU32::new(DEFAULT_LIVE_SCAN_COMBO);
static LIVE_POPUP_WIDTH: AtomicU8 = AtomicU8::new(44); // in units of 10px -> 440px default
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct GlobalLookupCapture {
    pub x: i32,
    pub y: i32,
    pub text: Option<String>,
    pub context: Option<String>,
    pub cursor: Option<usize>,
    pub source: String,
    pub foreground_pid: Option<u32>,
    pub foreground_title: Option<String>,
    pub foreground_process: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct LiveLookupReadyPayload {
    pub x: i32,
    pub y: i32,
    pub word: String,
    pub sentence: String,
    pub match_start: usize,
    pub match_len: usize,
    pub entries: Vec<DictEntry>,
    pub source: String,
    pub foreground_pid: Option<u32>,
    pub foreground_title: Option<String>,
    pub foreground_process: Option<String>,
}

fn latest_live_slot() -> &'static Mutex<Option<LiveLookupReadyPayload>> {
    static SLOT: OnceLock<Mutex<Option<LiveLookupReadyPayload>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub fn get_latest_live_lookup() -> Option<LiveLookupReadyPayload> {
    latest_live_slot().lock().ok().and_then(|g| g.clone())
}

pub fn clear_latest_live_lookup() {
    if let Ok(mut slot) = latest_live_slot().lock() {
        *slot = None;
    }
}

fn parse_live_scan_combo(raw: &str) -> u32 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return DEFAULT_LIVE_SCAN_COMBO;
    }
    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "off" | "none" | "disabled") {
        return 0;
    }
    // Migrate legacy single-modifier defaults ("Shift" / "Alt") to conflict-free `Shift+Z`.
    if matches!(lower.as_str(), "shift" | "alt") {
        return DEFAULT_LIVE_SCAN_COMBO;
    }

    let mut mods: u32 = 0;
    let mut vk: u32 = 0;
    for part in trimmed.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let pl = p.to_ascii_lowercase();
        match pl.as_str() {
            "shift" | "shiftleft" | "shiftright" => mods |= MOD_SHIFT,
            "ctrl" | "control" | "controlleft" | "controlright" => mods |= MOD_CTRL,
            "alt" | "altleft" | "altright" => mods |= MOD_ALT,
            "space" => vk = 0x20,
            "tab" => vk = 0x09,
            "backquote" | "`" => vk = 0xC0,
            "minus" | "-" => vk = 0xBD,
            "equal" | "=" => vk = 0xBB,
            "bracketleft" | "[" => vk = 0xDB,
            "bracketright" | "]" => vk = 0xDD,
            "semicolon" | ";" => vk = 0xBA,
            "quote" | "'" => vk = 0xDE,
            "comma" | "," => vk = 0xBC,
            "period" | "." => vk = 0xBE,
            "slash" | "/" => vk = 0xBF,
            "backslash" | "\\" => vk = 0xDC,
            _ => {
                if let Some(rest) = pl.strip_prefix("key") {
                    if rest.len() == 1 {
                        let b = rest.as_bytes()[0].to_ascii_uppercase();
                        if b.is_ascii_uppercase() {
                            vk = b as u32;
                        }
                    }
                } else if let Some(rest) = pl.strip_prefix("digit") {
                    if rest.len() == 1 {
                        let b = rest.as_bytes()[0];
                        if b.is_ascii_digit() {
                            vk = b as u32;
                        }
                    }
                } else if let Some(rest) = pl.strip_prefix('f') {
                    if let Ok(n) = rest.parse::<u32>() {
                        if (1..=12).contains(&n) {
                            vk = 0x70 + (n - 1);
                        }
                    }
                } else if pl.len() == 1 {
                    let b = pl.as_bytes()[0].to_ascii_uppercase();
                    if b.is_ascii_uppercase() || b.is_ascii_digit() {
                        vk = b as u32;
                    }
                }
            }
        }
    }

    if mods == 0 && vk == 0 {
        DEFAULT_LIVE_SCAN_COMBO
    } else {
        mods | (vk << 8)
    }
}

pub fn set_live_scan_config(enabled: bool, modifier: &str, lookup_width: Option<u32>) {
    LIVE_SCAN_ENABLED.store(enabled, Ordering::SeqCst);
    LIVE_SCAN_COMBO.store(parse_live_scan_combo(modifier), Ordering::SeqCst);
    if let Some(w) = lookup_width {
        let clamped = (w.saturating_add(40)).clamp(360, 760);
        LIVE_POPUP_WIDTH.store((clamped / 10) as u8, Ordering::SeqCst);
    }
}

pub fn record_external_foreground(hwnd: HWND) {
    if !hwnd.is_null() {
        LAST_EXTERNAL_HWND.store(hwnd as isize, Ordering::SeqCst);
    }
}

pub fn restore_external_foreground() {
    let raw = LAST_EXTERNAL_HWND.swap(0, Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = SetForegroundWindow(raw as HWND);
        }
    }
}

pub fn is_cursor_inside_hwnd(hwnd: HWND) -> bool {
    if hwnd.is_null() {
        return false;
    }
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return false;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return false;
        }
        pt.x >= rect.left && pt.x <= rect.right && pt.y >= rect.top && pt.y <= rect.bottom
    }
}

/// Enable or disable `WS_EX_NOACTIVATE` on a window so `window.show()` wakes WebView2's
/// `ICoreWebView2Controller::IsVisible` WITHOUT stealing focus from the user's browser/app.
pub fn set_hwnd_no_activate(hwnd: HWND, no_activate: bool) {
    if hwnd.is_null() {
        return;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flag = WS_EX_NOACTIVATE as isize;
        let next = if no_activate { ex | flag } else { ex & !flag };
        if next != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

pub fn show_hwnd_topmost_no_activate(hwnd: HWND) {
    if hwnd.is_null() {
        return;
    }
    unsafe {
        set_hwnd_no_activate(hwnd, true);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

pub fn hide_hwnd_no_activate(hwnd: HWND) {
    if hwnd.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

fn hwnd_class_name(hwnd: HWND) -> String {
    if hwnd.is_null() {
        return String::new();
    }
    unsafe {
        let mut buf = [0u16; 128];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

/// Wake Chromium / Vivaldi / Edge / Electron Blink accessibility (`TextPattern`) on demand
/// by sending `WM_GETOBJECT(OBJID_CLIENT)` to `Chrome_RenderWidgetHostHWND` and its root.
unsafe fn wake_chromium_accessibility_if_needed(hwnd: HWND, woken: &mut HashSet<isize>) -> bool {
    if hwnd.is_null() {
        return false;
    }
    const OBJID_CLIENT_LP: isize = -4isize;

    let root = GetAncestor(hwnd, GA_ROOT);
    let target = if !root.is_null() { root } else { hwnd };

    let class = hwnd_class_name(hwnd);
    let root_class = if target != hwnd {
        hwnd_class_name(target)
    } else {
        class.clone()
    };

    let is_chromium = class.starts_with("Chrome_")
        || class.contains("RenderWidgetHostHWND")
        || root_class.starts_with("Chrome_")
        || root_class.contains("RenderWidgetHostHWND");
    if !is_chromium {
        return false;
    }

    let key = target as isize;
    if !woken.insert(key) {
        return false;
    }

    for candidate in [hwnd, target] {
        if !candidate.is_null() {
            let mut result: usize = 0;
            let _ = SendMessageTimeoutW(
                candidate,
                WM_GETOBJECT,
                0,
                OBJID_CLIENT_LP,
                SMTO_ABORTIFHUNG,
                45,
                &mut result,
            );
        }
    }

    // Also poke any `Chrome_RenderWidgetHostHWND` child of a top-level `Chrome_WidgetWin_*`
    unsafe extern "system" fn poke_child(child: HWND, _lparam: isize) -> i32 {
        let mut buf = [0u16; 96];
        let len = GetClassNameW(child, buf.as_mut_ptr(), buf.len() as i32);
        if len > 0 {
            let cname = String::from_utf16_lossy(&buf[..len as usize]);
            if cname.contains("RenderWidgetHostHWND") || cname.starts_with("Chrome_") {
                let mut res: usize = 0;
                let _ = SendMessageTimeoutW(
                    child,
                    WM_GETOBJECT,
                    0,
                    -4isize,
                    SMTO_ABORTIFHUNG,
                    35,
                    &mut res,
                );
            }
        }
        1
    }
    EnumChildWindows(target, Some(poke_child), 0);
    true
}

fn foreground_window_info(hwnd: HWND) -> (Option<u32>, Option<String>, Option<String>) {
    if hwnd.is_null() {
        return (None, None, None);
    }
    unsafe {
        let mut pid: DWORD = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == GetCurrentProcessId() {
            return (None, None, None);
        }

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        let title = if title_len > 0 {
            let s = String::from_utf16_lossy(&title_buf[..title_len as usize])
                .trim()
                .to_string();
            if s.is_empty() { None } else { Some(s) }
        } else {
            None
        };

        let mut proc_name: Option<String> = None;
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if !handle.is_null() {
            let mut name_buf = [0u16; 260];
            let name_len = GetModuleBaseNameW(
                handle,
                ptr::null_mut(),
                name_buf.as_mut_ptr(),
                name_buf.len() as DWORD,
            );
            CloseHandle(handle);
            if name_len > 0 {
                let s = String::from_utf16_lossy(&name_buf[..name_len as usize])
                    .trim()
                    .to_string();
                if !s.is_empty() {
                    proc_name = Some(s);
                }
            }
        }

        (Some(pid), title, proc_name)
    }
}

fn clean_lookup_token(text: &str) -> Option<String> {
    let cleaned = text
        .replace('\r', " ")
        .replace('\n', " ")
        .trim()
        .trim_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '「' | '」'
                        | '『'
                        | '』'
                        | '（'
                        | '）'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '"'
                        | '\''
                        | '、'
                        | '。'
                        | '，'
                        | '．'
                        | '.'
                        | ','
                        | '!'
                        | '?'
                        | '！'
                        | '？'
                        | ':'
                        | ';'
                        | '：'
                        | '；'
                )
        })
        .to_string();
    if cleaned.is_empty() || cleaned.chars().count() > 160 {
        None
    } else {
        Some(cleaned)
    }
}

fn normalize_context(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = false;
    for ch in text.chars() {
        let mapped = match ch {
            '\r' | '\n' | '\t' => ' ',
            _ => ch,
        };
        if mapped == ' ' {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(mapped);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

fn clip_sentence_around_cursor(raw: &str, cursor: usize) -> (String, usize) {
    let chars: Vec<char> = raw.chars().collect();
    if chars.is_empty() {
        return (String::new(), 0);
    }
    let pos = cursor.min(chars.len().saturating_sub(1));
    const MAX_HALF: usize = 90;

    let mut start = pos;
    let min_start = pos.saturating_sub(MAX_HALF);
    while start > min_start {
        let prev = chars[start - 1];
        if matches!(prev, '。' | '！' | '？' | '\n' | '\r') {
            break;
        }
        start -= 1;
    }

    let mut end = pos + 1;
    let max_end = (pos + MAX_HALF).min(chars.len());
    while end < max_end {
        let cur = chars[end];
        if matches!(cur, '\n' | '\r') {
            break;
        }
        end += 1;
        if matches!(cur, '。' | '！' | '？') {
            break;
        }
    }

    let slice: String = chars[start..end].iter().collect();
    let leading_ws = slice.chars().take_while(|c| c.is_whitespace()).count();
    let trimmed = slice.trim().to_string();
    let new_cursor = pos
        .saturating_sub(start)
        .saturating_sub(leading_ws)
        .min(trimmed.chars().count());
    (trimmed, new_cursor)
}

unsafe fn text_pattern_from_element(
    element: &IUIAutomationElement,
) -> Option<IUIAutomationTextPattern> {
    if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
        return Some(p);
    }
    if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPattern2Id) {
        return Some(p);
    }
    if let Ok(child) =
        element.GetCurrentPatternAs::<IUIAutomationTextChildPattern>(UIA_TextChildPatternId)
    {
        if let Ok(container) = child.TextContainer() {
            if let Ok(p) =
                container.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                return Some(p);
            }
        }
    }
    None
}

unsafe fn range_contains_point(range: &IUIAutomationTextRange, point: POINT) -> bool {
    let sa_ptr = match range.GetBoundingRectangles() {
        Ok(sa) if !sa.is_null() => sa,
        _ => return false,
    };

    let mut hit = false;
    if let (Ok(lb), Ok(ub)) = (SafeArrayGetLBound(sa_ptr, 1), SafeArrayGetUBound(sa_ptr, 1)) {
        let count = (ub as i64 - lb as i64 + 1).max(0) as usize;
        if count >= 4 {
            let mut data: *mut std::ffi::c_void = ptr::null_mut();
            if SafeArrayAccessData(sa_ptr, &mut data).is_ok() && !data.is_null() {
                let coords = std::slice::from_raw_parts(data as *const f64, count);
                let px = point.x as f64;
                let py = point.y as f64;
                for chunk in coords.chunks_exact(4) {
                    let (left, top, width, height) = (chunk[0], chunk[1], chunk[2], chunk[3]);
                    // Strict horizontal `[left, left + width)` prevents adjacent kanji bleed!
                    if width > 0.0
                        && height > 0.0
                        && px >= left
                        && px < left + width
                        && py >= top - 4.0
                        && py <= top + height + 4.0
                    {
                        hit = true;
                        break;
                    }
                }
                let _ = SafeArrayUnaccessData(sa_ptr);
            }
        }
    }
    let _ = SafeArrayDestroy(sa_ptr);
    hit
}

unsafe fn extract_range_context(
    range: &IUIAutomationTextRange,
    hit_point: Option<POINT>,
) -> Option<(String, usize)> {
    let effective = range.Clone().ok()?;
    if let Some(pt) = hit_point {
        let mut on_next = false;
        if let Ok(next_char) = effective.Clone() {
            let moved = next_char
                .MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 1)
                .unwrap_or(0);
            if moved > 0 {
                on_next = range_contains_point(&next_char, pt);
            }
        }
        if !on_next {
            if let Ok(prev_char) = effective.Clone() {
                let moved = prev_char
                    .MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1)
                    .unwrap_or(0);
                if moved < 0 && range_contains_point(&prev_char, pt) {
                    let _ = effective.MoveEndpointByUnit(
                        TextPatternRangeEndpoint_Start,
                        TextUnit_Character,
                        -1,
                    );
                    let _ = effective.MoveEndpointByRange(
                        TextPatternRangeEndpoint_End,
                        &effective,
                        TextPatternRangeEndpoint_Start,
                    );
                }
            }
        }
    }

    let left = effective.Clone().ok()?;
    let context = effective.Clone().ok()?;

    let _ = left.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -72);
    let _ = left.MoveEndpointByRange(
        TextPatternRangeEndpoint_End,
        &effective,
        TextPatternRangeEndpoint_Start,
    );

    let _ = context.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -72);
    let _ = context.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 88);

    let left_raw = left.GetText(120).ok()?.to_string();
    let context_raw = context.GetText(220).ok()?.to_string();
    if context_raw.trim().is_empty() {
        return None;
    }
    let raw_cursor = left_raw.chars().count().min(context_raw.chars().count());
    let (sentence, cursor) = clip_sentence_around_cursor(&context_raw, raw_cursor);
    if sentence.is_empty() {
        None
    } else {
        Some((sentence, cursor))
    }
}

unsafe fn uia_focused_selection(automation: &IUIAutomation) -> Option<(String, String, usize)> {
    let mut element = automation.GetFocusedElement().ok()?;
    let walker = automation
        .RawViewWalker()
        .or_else(|_| automation.ControlViewWalker())
        .ok();

    for _ in 0..5 {
        if let Some(pattern) = text_pattern_from_element(&element) {
            if let Ok(ranges) = pattern.GetSelection() {
                let count = ranges.Length().unwrap_or(0);
                if count > 0 {
                    if let Ok(range) = ranges.GetElement(0) {
                        if let Ok(sel_bstr) = range.GetText(240) {
                            let sel_raw = sel_bstr.to_string();
                            if let Some(selected) = clean_lookup_token(&sel_raw) {
                                let (context, cursor) = extract_range_context(&range, None)
                                    .unwrap_or_else(|| (selected.clone(), 0));
                                return Some((selected, context, cursor));
                            }
                        }
                    }
                }
            }
            break;
        }
        if let Some(ref w) = walker {
            match w.GetParentElement(&element) {
                Ok(parent) => element = parent,
                Err(_) => break,
            }
        } else {
            break;
        }
    }
    None
}

unsafe fn uia_at_point(
    automation: &IUIAutomation,
    point: POINT,
    prefer_selection: bool,
) -> Option<(Option<String>, String, usize, &'static str)> {
    let mut element = automation
        .ElementFromPoint(UiaPoint {
            x: point.x,
            y: point.y,
        })
        .ok()?;

    let walker = automation
        .RawViewWalker()
        .or_else(|_| automation.ControlViewWalker())
        .ok();

    let mut probe = element.clone();
    for _ in 0..10 {
        if let Some(pattern) = text_pattern_from_element(&probe) {
            if prefer_selection {
                if let Ok(ranges) = pattern.GetSelection() {
                    if ranges.Length().unwrap_or(0) > 0 {
                        if let Ok(range) = ranges.GetElement(0) {
                            if let Ok(sel_bstr) = range.GetText(240) {
                                if let Some(selected) = clean_lookup_token(&sel_bstr.to_string()) {
                                    let (context, cursor) = extract_range_context(&range, None)
                                        .unwrap_or_else(|| (selected.clone(), 0));
                                    return Some((Some(selected), context, cursor, "selection"));
                                }
                            }
                        }
                    }
                }
            }
            if let Ok(caret) = pattern.RangeFromPoint(UiaPoint {
                x: point.x,
                y: point.y,
            }) {
                if let Some((context, cursor)) = extract_range_context(&caret, Some(point)) {
                    return Some((None, context, cursor, "uia"));
                }
            }
        }
        if let Some(ref w) = walker {
            match w.GetParentElement(&probe) {
                Ok(parent) => probe = parent,
                Err(_) => break,
            }
        } else {
            break;
        }
    }

    for _ in 0..8 {
        let mut candidate: Option<String> = None;

        if let Ok(val_pattern) =
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            if let Ok(val) = val_pattern.CurrentValue() {
                let s = normalize_context(&val.to_string());
                if !s.is_empty() && s.chars().count() <= 400 {
                    candidate = Some(s);
                }
            }
        }

        if candidate.is_none() {
            if let Ok(name) = element.CurrentName() {
                let s = normalize_context(&name.to_string());
                if !s.is_empty() && s.chars().count() <= 400 {
                    candidate = Some(s);
                }
            }
        }

        if let Some(raw_text) = candidate {
            let char_count = raw_text.chars().count();
            let estimated_cursor = match element.CurrentBoundingRectangle() {
                Ok(rect) if (rect.right as f64) > (rect.left as f64) && char_count > 1 => {
                    let left = rect.left as f64;
                    let top = rect.top as f64;
                    let width = (rect.right as f64 - left).max(1.0);
                    let height = (rect.bottom as f64 - top).max(1.0);
                    let rel_x = ((point.x as f64 - left) / width).clamp(0.0, 0.99);
                    let approx_lines = (height / 24.0).round().max(1.0);
                    let ratio = if approx_lines >= 2.0 && char_count > 35 {
                        let rel_y = ((point.y as f64 - top) / height).clamp(0.0, 0.99);
                        let line_idx = (rel_y * approx_lines).floor().min(approx_lines - 1.0);
                        ((line_idx + rel_x) / approx_lines).clamp(0.0, 0.99)
                    } else {
                        rel_x
                    };
                    ((ratio * char_count as f64).floor() as usize).min(char_count.saturating_sub(1))
                }
                _ => 0,
            };

            let (context, cursor) = clip_sentence_around_cursor(&raw_text, estimated_cursor);
            if !context.is_empty() {
                let short_token = if context.chars().count() <= 32 {
                    clean_lookup_token(&context)
                } else {
                    None
                };
                return Some((short_token, context, cursor, "uia_name"));
            }
        }

        if let Some(ref w) = walker {
            match w.GetParentElement(&element) {
                Ok(parent) => element = parent,
                Err(_) => break,
            }
        } else {
            break;
        }
    }

    None
}

pub fn read_clipboard_text() -> Option<String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            return None;
        }
        if OpenClipboard(ptr::null_mut()) == 0 {
            return None;
        }
        let result = (|| -> Option<String> {
            let handle = GetClipboardData(CF_UNICODETEXT) as HGLOBAL;
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *ptr.add(len) != 0 && len < 65536 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            let text = String::from_utf16_lossy(slice);
            GlobalUnlock(handle);
            Some(text)
        })();
        CloseClipboard();
        result
    }
}

fn write_clipboard_text(text: &str) -> bool {
    unsafe {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return false;
        }
        let ok = (|| -> bool {
            if EmptyClipboard() == 0 {
                return false;
            }
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let byte_len = wide.len() * std::mem::size_of::<u16>();
            let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if hmem.is_null() {
                return false;
            }
            let dst = GlobalLock(hmem) as *mut u16;
            if dst.is_null() {
                GlobalFree(hmem);
                return false;
            }
            ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
            GlobalUnlock(hmem);
            if SetClipboardData(CF_UNICODETEXT, hmem as LPVOID).is_null() {
                GlobalFree(hmem);
                return false;
            }
            true
        })();
        CloseClipboard();
        ok
    }
}

fn make_key_input(vk: u16, key_up: bool) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.type_ = INPUT_KEYBOARD;
    unsafe {
        *input.u.ki_mut() = KEYBDINPUT {
            wVk: vk,
            wScan: 0,
            dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
            time: 0,
            dwExtraInfo: 0,
        };
    }
    input
}

fn capture_selection_via_ctrl_c(restore_clipboard: bool) -> Option<String> {
    unsafe {
        let prev_clipboard = if restore_clipboard {
            read_clipboard_text()
        } else {
            None
        };
        let seq_before = GetClipboardSequenceNumber();

        let mut release: Vec<INPUT> = Vec::new();
        for vk in [
            VK_LMENU, VK_RMENU, VK_MENU, VK_LSHIFT, VK_RSHIFT, VK_SHIFT, VK_LCONTROL, VK_RCONTROL,
            VK_CONTROL,
        ] {
            if (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 {
                release.push(make_key_input(vk as u16, true));
            }
        }
        if !release.is_empty() {
            SendInput(
                release.len() as u32,
                release.as_mut_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
            thread::sleep(Duration::from_millis(12));
        }

        let mut copy_seq = [
            make_key_input(VK_CONTROL as u16, false),
            make_key_input(b'C' as u16, false),
            make_key_input(b'C' as u16, true),
            make_key_input(VK_CONTROL as u16, true),
        ];
        SendInput(
            copy_seq.len() as u32,
            copy_seq.as_mut_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );

        let deadline = Instant::now() + Duration::from_millis(130);
        let mut changed = false;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(12));
            if GetClipboardSequenceNumber() != seq_before {
                changed = true;
                break;
            }
        }

        if !changed {
            return None;
        }

        let captured = read_clipboard_text();
        if let Some(prev) = prev_clipboard {
            let _ = write_clipboard_text(&prev);
        }

        let raw = captured?;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 360 {
            return None;
        }
        Some(trimmed.to_string())
    }
}

fn scintilla_at_cursor(point: POINT) -> Option<(String, String, usize)> {
    const SCI_POSITIONFROMPOINTCLOSE: u32 = 2023;
    const SCI_WORDSTARTPOSITION: u32 = 2266;
    const SCI_WORDENDPOSITION: u32 = 2267;
    const SCI_GETRANGEPOINTER: u32 = 2643;

    unsafe {
        let hwnd = WindowFromPoint(point);
        if hwnd.is_null() {
            return None;
        }
        let mut class_name = [0_u16; 96];
        let class_len = GetClassNameW(hwnd, class_name.as_mut_ptr(), class_name.len() as i32);
        if class_len <= 0 {
            return None;
        }
        let class_name = String::from_utf16_lossy(&class_name[..class_len as usize]);
        if !class_name.to_ascii_lowercase().contains("scintilla") {
            return None;
        }

        let mut client_point = point;
        if ScreenToClient(hwnd, &mut client_point) == 0 {
            return None;
        }
        let position = SendMessageW(
            hwnd,
            SCI_POSITIONFROMPOINTCLOSE,
            client_point.x as usize,
            client_point.y as isize,
        );
        if position < 0 {
            return None;
        }
        let start = SendMessageW(hwnd, SCI_WORDSTARTPOSITION, position as usize, 1);
        let end = SendMessageW(hwnd, SCI_WORDENDPOSITION, position as usize, 1);
        if start < 0 || end <= start || end.saturating_sub(start) > 160 {
            return None;
        }

        let mut pid = 0_u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let length = (end - start) as usize;
        let remote_pointer = SendMessageW(hwnd, SCI_GETRANGEPOINTER, start as usize, length as isize)
            as *const winapi::ctypes::c_void;
        if remote_pointer.is_null() {
            return None;
        }
        let process = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut bytes = vec![0_u8; length];
        let mut bytes_read = 0_usize;
        let read_ok = ReadProcessMemory(
            process,
            remote_pointer,
            bytes.as_mut_ptr() as *mut winapi::ctypes::c_void,
            length,
            &mut bytes_read,
        );
        CloseHandle(process);
        if read_ok == 0 || bytes_read == 0 {
            return None;
        }
        bytes.truncate(bytes_read);
        let text = String::from_utf8(bytes).ok()?;
        let cleaned = clean_lookup_token(&text)?;
        Some((cleaned.clone(), cleaned, 0))
    }
}

pub fn capture_at_cursor(
    allow_ctrl_c_selection: bool,
    restore_clipboard: bool,
) -> Result<GlobalLookupCapture, String> {
    let mut point = POINT { x: 0, y: 0 };
    let fg_hwnd: HWND;
    let cursor_hwnd: HWND;
    unsafe {
        if GetCursorPos(&mut point) == 0 {
            return Err("Could not read cursor position.".to_string());
        }
        fg_hwnd = GetForegroundWindow();
        cursor_hwnd = WindowFromPoint(point);
    }

    let (fg_pid, fg_title, fg_process) = foreground_window_info(fg_hwnd);
    let (cur_pid, cur_title, cur_process) = foreground_window_info(cursor_hwnd);

    let (bound_pid, bound_title, bound_process) = if cur_pid.is_some() {
        (cur_pid, cur_title, cur_process)
    } else {
        (fg_pid, fg_title, fg_process)
    };

    if fg_pid.is_some() {
        record_external_foreground(fg_hwnd);
    }

    let base = |text: Option<String>,
                context: Option<String>,
                cursor: Option<usize>,
                source: &str| GlobalLookupCapture {
        x: point.x,
        y: point.y,
        text,
        context,
        cursor,
        source: source.to_string(),
        foreground_pid: bound_pid,
        foreground_title: bound_title.clone(),
        foreground_process: bound_process.clone(),
    };

    let uia_result = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let mut woken = HashSet::new();
        let res = (|| -> Option<(Option<String>, String, usize, &'static str)> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;

            if fg_pid.is_some() {
                if let Some((selected, context, cursor)) = uia_focused_selection(&automation) {
                    return Some((Some(selected), context, cursor, "selection"));
                }
            }

            if let Some((word, context, cursor)) = scintilla_at_cursor(point) {
                return Some((Some(word), context, cursor, "scintilla"));
            }

            let mut hit = uia_at_point(&automation, point, true);
            if !matches!(hit, Some((_, _, _, "selection" | "uia"))) {
                if wake_chromium_accessibility_if_needed(cursor_hwnd, &mut woken)
                    || wake_chromium_accessibility_if_needed(fg_hwnd, &mut woken)
                {
                    thread::sleep(Duration::from_millis(35));
                    if let Some(retry) = uia_at_point(&automation, point, true) {
                        hit = Some(retry);
                    }
                }
            }
            hit
        })();
        CoUninitialize();
        res
    };

    if let Some((text, context, cursor, source @ ("selection" | "uia" | "scintilla"))) = uia_result
    {
        return Ok(base(text, Some(context), Some(cursor), source));
    }

    if allow_ctrl_c_selection && fg_pid.is_some() {
        if let Some(selected_raw) = capture_selection_via_ctrl_c(restore_clipboard) {
            let context = normalize_context(&selected_raw);
            let token = clean_lookup_token(&context);
            return Ok(base(token, Some(context), Some(0), "selection"));
        }
    }

    if let Some((text, context, cursor, source)) = uia_result {
        return Ok(base(text, Some(context), Some(cursor), source));
    }

    Ok(base(None, None, None, "none"))
}

#[inline]
unsafe fn key_down(vk: i32) -> bool {
    (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
}

unsafe fn is_live_combo_held(combo: u32) -> bool {
    if combo == 0 {
        return false;
    }
    let need_shift = (combo & MOD_SHIFT) != 0;
    let need_ctrl = (combo & MOD_CTRL) != 0;
    let need_alt = (combo & MOD_ALT) != 0;
    let vk = ((combo >> 8) & 0xFF) as i32;

    let shift = key_down(VK_SHIFT) || key_down(VK_LSHIFT) || key_down(VK_RSHIFT);
    let ctrl = key_down(VK_CONTROL) || key_down(VK_LCONTROL) || key_down(VK_RCONTROL);
    let alt = key_down(VK_MENU) || key_down(VK_LMENU) || key_down(VK_RMENU);

    shift == need_shift && ctrl == need_ctrl && alt == need_alt && (vk == 0 || key_down(vk))
}

unsafe fn is_any_other_typing_key_down(excluded_vk: i32) -> bool {
    for vk in b'A'..=b'Z' {
        let code = vk as i32;
        if code != excluded_vk && key_down(code) {
            return true;
        }
    }
    for vk in b'0'..=b'9' {
        let code = vk as i32;
        if code != excluded_vk && key_down(code) {
            return true;
        }
    }
    (excluded_vk != VK_SPACE && key_down(VK_SPACE))
        || (excluded_vk != VK_RETURN && key_down(VK_RETURN))
        || (excluded_vk != VK_BACK && key_down(VK_BACK))
}

/// Start the background live hover-scan watcher:
/// - MTA COM initialization (`COINIT_MULTITHREADED`)
/// - Automatic Chromium/Vivaldi `WM_GETOBJECT` wakeup
/// - Direct Rust-side SQLite `scan_cursor_in_db` + `show_lookup_agent_window_internal`
///   so WebView2 wakes and renders immediately with zero background-tab throttling!
pub fn start_live_hover_watcher(app: AppHandle) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::Builder::new()
        .name("setsuna-global-live-hover".to_string())
        .spawn(move || unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let mut automation: Option<IUIAutomation> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok();
            let my_pid = GetCurrentProcessId();

            crate::append_diagnostics_line(
                &app,
                serde_json::json!({
                    "ts": crate::unix_time_ms(),
                    "kind": "live_lookup",
                    "event": "watcher_started",
                    "com_hr": format!("{:?}", hr),
                    "uia_ready": automation.is_some(),
                }),
            );

            let mut woken_hwnds: HashSet<isize> = HashSet::new();
            let mut was_modifier_held = false;
            let mut typing_suppressed = false;
            let mut last_scan_pt: Option<POINT> = None;
            let mut stationary_miss_retries: u8 = 0;
            let mut last_anchor_pt: Option<POINT> = None;
            let mut last_live_key = String::new();
            let mut was_mouse_down = false;
            let mut was_esc_down = false;
            let mut db_conn = crate::open_db(&app).ok();
            let mut last_diag_at = Instant::now()
                .checked_sub(Duration::from_secs(5))
                .unwrap_or_else(Instant::now);

            loop {
                thread::sleep(Duration::from_millis(40));

                if automation.is_none() {
                    automation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok();
                }

                let lookup_hwnd: HWND = app
                    .get_webview_window("lookup_external")
                    .and_then(|w| w.hwnd().ok())
                    .map(|h| h.0 as HWND)
                    .unwrap_or(ptr::null_mut());
                let lookup_visible = !lookup_hwnd.is_null() && IsWindowVisible(lookup_hwnd) != 0;
                if !lookup_visible {
                    last_live_key.clear();
                    last_anchor_pt = None;
                }

                let mouse_down =
                    key_down(VK_LBUTTON) || key_down(VK_RBUTTON) || key_down(VK_MBUTTON);
                let esc_down = key_down(VK_ESCAPE);

                if lookup_visible {
                    if mouse_down && !was_mouse_down {
                        if is_cursor_inside_hwnd(lookup_hwnd) {
                            // User clicked inside the popup (e.g. search input or button):
                            // temporarily allow activation so keyboard input works!
                            set_hwnd_no_activate(lookup_hwnd, false);
                            let _ = SetForegroundWindow(lookup_hwnd);
                        } else {
                            let _ = app.emit_to("lookup_external", "lookup_agent_outside_click", ());
                        }
                    }
                    if esc_down && !was_esc_down {
                        let _ = app.emit_to("lookup_external", "lookup_agent_escape", ());
                    }
                }
                was_mouse_down = mouse_down;
                was_esc_down = esc_down;

                if !LIVE_SCAN_ENABLED.load(Ordering::Relaxed) {
                    was_modifier_held = false;
                    stationary_miss_retries = 0;
                    continue;
                }
                let combo = LIVE_SCAN_COMBO.load(Ordering::Relaxed);
                if combo == 0 {
                    was_modifier_held = false;
                    stationary_miss_retries = 0;
                    continue;
                }

                let held = is_live_combo_held(combo);
                if !held {
                    was_modifier_held = false;
                    typing_suppressed = false;
                    stationary_miss_retries = 0;
                    continue;
                }

                let combo_vk = ((combo >> 8) & 0xFF) as i32;
                if is_any_other_typing_key_down(combo_vk) {
                    typing_suppressed = true;
                    continue;
                }
                if mouse_down || typing_suppressed {
                    continue;
                }

                let mut pt = POINT { x: 0, y: 0 };
                if GetCursorPos(&mut pt) == 0 {
                    continue;
                }

                let cursor_hwnd = WindowFromPoint(pt);
                if !cursor_hwnd.is_null() {
                    let mut cur_pid: DWORD = 0;
                    GetWindowThreadProcessId(cursor_hwnd, &mut cur_pid);
                    if cur_pid == my_pid {
                        continue;
                    }
                }
                if lookup_visible && is_cursor_inside_hwnd(lookup_hwnd) {
                    continue;
                }

                let moved = match last_scan_pt {
                    Some(prev) => pt.x.abs_diff(prev.x) >= 3 || pt.y.abs_diff(prev.y) >= 3,
                    None => true,
                };
                if was_modifier_held && !moved && stationary_miss_retries == 0 {
                    continue;
                }
                was_modifier_held = true;
                if moved {
                    stationary_miss_retries = 0;
                }

                let fg_hwnd = GetForegroundWindow();
                let cursor_root = if !cursor_hwnd.is_null() {
                    let r = GetAncestor(cursor_hwnd, GA_ROOT);
                    if !r.is_null() { r } else { cursor_hwnd }
                } else {
                    ptr::null_mut()
                };

                let (bound_pid, bound_title, bound_process) = {
                    let cur = foreground_window_info(cursor_root);
                    if cur.0.is_some() {
                        cur
                    } else {
                        foreground_window_info(fg_hwnd)
                    }
                };
                if bound_pid.is_some() {
                    let ext_hwnd = if foreground_window_info(fg_hwnd).0.is_some() {
                        fg_hwnd
                    } else {
                        cursor_root
                    };
                    if !ext_hwnd.is_null() {
                        record_external_foreground(ext_hwnd);
                    }
                }

                let mut probe = if let Some((word, context, cursor)) = scintilla_at_cursor(pt) {
                    Some((Some(word), context, cursor, "scintilla"))
                } else if let Some(ref auto) = automation {
                    uia_at_point(auto, pt, false)
                } else {
                    None
                };

                // If Chromium/Vivaldi hasn't woken its DOM TextPattern tree yet, poke WM_GETOBJECT and retry!
                if !matches!(probe, Some((_, _, _, "uia" | "scintilla"))) {
                    if wake_chromium_accessibility_if_needed(cursor_hwnd, &mut woken_hwnds)
                        || wake_chromium_accessibility_if_needed(fg_hwnd, &mut woken_hwnds)
                    {
                        thread::sleep(Duration::from_millis(35));
                        if let Some(ref auto) = automation {
                            if let Some(retry) = uia_at_point(auto, pt, false) {
                                probe = Some(retry);
                            }
                        }
                    }
                }

                let Some((hovered_token, context, mut cursor, source)) = probe else {
                    // Allow up to 4 quick retries (~160ms) if user pressed Shift on a stationary point
                    // while Chromium was still building its accessibility tree.
                    if last_scan_pt.map_or(true, |prev| pt.x.abs_diff(prev.x) >= 3 || pt.y.abs_diff(prev.y) >= 3) {
                        last_scan_pt = Some(pt);
                        stationary_miss_retries = 4;
                    } else if stationary_miss_retries > 0 {
                        stationary_miss_retries -= 1;
                    }
                    if last_diag_at.elapsed() >= Duration::from_millis(900) {
                        last_diag_at = Instant::now();
                        crate::append_diagnostics_line(
                            &app,
                            serde_json::json!({
                                "ts": crate::unix_time_ms(),
                                "kind": "live_lookup",
                                "event": "probe_miss",
                                "x": pt.x,
                                "y": pt.y,
                                "hwnd_class": hwnd_class_name(cursor_hwnd),
                                "root_class": hwnd_class_name(cursor_root),
                                "process": bound_process,
                            }),
                        );
                    }
                    continue;
                };

                last_scan_pt = Some(pt);
                stationary_miss_retries = 0;

                // Snap bounding-box cursor estimates to start of enclosing Japanese word
                if source == "uia_name" {
                    if let Ok(tokens) = crate::japanese_tokenizer::segment_text(&context) {
                        if let Some(hit) =
                            tokens.iter().find(|tk| cursor >= tk.start && cursor < tk.end)
                        {
                            cursor = hit.start;
                        }
                    }
                }

                let live_key = format!("{}|{}", context, cursor);
                if lookup_visible && last_live_key == live_key {
                    continue;
                }

                if db_conn.is_none() {
                    db_conn = crate::open_db(&app).ok();
                }
                let Some(ref db) = db_conn else {
                    continue;
                };

                // Query dictionary directly in Rust (<1ms, zero WebView2 throttling!)
                let mut lookup_res = scan_cursor_in_db(db, &context, cursor)
                    .ok()
                    .filter(|r| !r.entries.is_empty());

                if lookup_res.is_none() {
                    if let Some(ref tok) = hovered_token {
                        let q = if tok
                            .chars()
                            .all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-')
                        {
                            tok.to_ascii_lowercase()
                        } else {
                            tok.clone()
                        };
                        if let Ok(entries) = lookup_word_in_db(db, &q) {
                            if !entries.is_empty() {
                                lookup_res = Some(crate::dictionary_engine::CursorLookupResult {
                                    word: q,
                                    match_start: 0,
                                    match_len: tok.chars().count().max(1),
                                    entries,
                                });
                            }
                        }
                    }
                }

                let Some(found) = lookup_res else {
                    continue;
                };

                last_live_key = live_key;

                // Smooth anchor: keep popup steady for minor moves along the same line
                let anchor_pt = match last_anchor_pt {
                    Some(prev)
                        if lookup_visible
                            && pt.x.abs_diff(prev.x) < 110
                            && pt.y.abs_diff(prev.y) < 34 =>
                    {
                        prev
                    }
                    _ => {
                        last_anchor_pt = Some(pt);
                        pt
                    }
                };

                let entries_count = found.entries.len();
                let log_word = found.word.clone();
                let ready = LiveLookupReadyPayload {
                    x: pt.x,
                    y: pt.y,
                    word: found.word,
                    sentence: context,
                    match_start: found.match_start,
                    match_len: found.match_len.max(1),
                    entries: found.entries,
                    source: source.to_string(),
                    foreground_pid: bound_pid,
                    foreground_title: bound_title,
                    foreground_process: bound_process.clone(),
                };

                if let Ok(mut slot) = latest_live_slot().lock() {
                    *slot = Some(ready.clone());
                }

                let logical_w =
                    (LIVE_POPUP_WIDTH.load(Ordering::Relaxed) as u32).saturating_mul(10);
                let show_res = crate::show_lookup_agent_window_internal(
                    &app,
                    anchor_pt.x,
                    anchor_pt.y,
                    Some(logical_w),
                    Some(520),
                    false,
                );
                let _ = app.emit_to("lookup_external", "lookup_agent_ready", ready);

                if last_diag_at.elapsed() >= Duration::from_millis(500) {
                    last_diag_at = Instant::now();
                    crate::append_diagnostics_line(
                        &app,
                        serde_json::json!({
                            "ts": crate::unix_time_ms(),
                            "kind": "live_lookup",
                            "event": "hit",
                            "word": log_word,
                            "entries": entries_count,
                            "source": source,
                            "process": bound_process,
                            "show_ok": show_res.is_ok(),
                        }),
                    );
                }
            }
        })
        .ok();
}
