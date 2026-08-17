#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime as StdSystemTime, UNIX_EPOCH};
use sysinfo::{Disks, System};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::Color;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_window_state::StateFlags;

// Windows-only helpers for icons and foreground/window tracking.
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use winapi::shared::windef::POINT;
#[cfg(target_os = "windows")]
use winapi::um::handleapi::CloseHandle;
#[cfg(target_os = "windows")]
use winapi::um::memoryapi::ReadProcessMemory;
#[cfg(target_os = "windows")]
use winapi::um::processthreadsapi::OpenProcess;
#[cfg(target_os = "windows")]
use winapi::um::processthreadsapi::{GetCurrentProcess, GetCurrentProcessId};
#[cfg(target_os = "windows")]
use winapi::um::psapi::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
#[cfg(target_os = "windows")]
use winapi::um::shellapi::ExtractIconExW;
#[cfg(target_os = "windows")]
use winapi::um::wingdi::{GetDIBits, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
#[cfg(target_os = "windows")]
use winapi::um::winnt::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
#[cfg(target_os = "windows")]
use winapi::um::winuser::{
    DestroyIcon, GetClassNameW, GetCursorPos, GetDC, GetForegroundWindow, GetIconInfo,
    GetWindowThreadProcessId, ReleaseDC, ScreenToClient, SendMessageW, WindowFromPoint,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::POINT as UiaPoint;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    TextUnit_Word, UIA_TextPatternId,
};

mod dictionary_import;
mod epub_import;
#[cfg(target_os = "linux")]
mod hover_lookup;
mod player_media;
use dictionary_import::{import_dictionaries, import_dictionary};
use epub_import::import_epub;
use player_media::{extract_player_clip, get_ffmpeg_status};

static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub struct BrowserState {
    pub tabs: Mutex<HashMap<String, tauri::WebviewWindow>>,
}

pub struct ForegroundHistory {
    pub hwnds: Mutex<VecDeque<u64>>,
}

pub struct CaptureAgentState {
    pub runtime: Mutex<Option<CaptureAgentRuntime>>,
}

pub struct TextSyncState {
    pub runtime: Mutex<Option<TextSyncRuntime>>,
    pub lines: Arc<Mutex<VecDeque<TextSyncLine>>>,
    pub seq: Arc<Mutex<u64>>,
}

pub struct DiscordPresenceState {
    pub runtime: Arc<Mutex<Option<DiscordPresenceRuntime>>>,
}

static OAUTH_SERVER_PORT: OnceLock<Mutex<Option<u16>>> = OnceLock::new();

#[derive(serde::Serialize)]
struct OAuthServerStart {
    port: u16,
    redirect_uri: String,
    reused: bool,
}

#[derive(serde::Serialize)]
struct GlobalLookupCopyResult {
    x: i32,
    y: i32,
    text: Option<String>,
    context: Option<String>,
    cursor: Option<usize>,
}

#[tauri::command]
fn launch_anki() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Ok(path) = env::var("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(&path);
            candidates.push(
                local_app_data
                    .join("AnkiProgramFiles")
                    .join(".venv")
                    .join("Scripts")
                    .join("anki.exe"),
            );
            candidates.push(
                local_app_data
                    .join("Programs")
                    .join("Anki")
                    .join("anki.exe"),
            );
        }
        if let Ok(path) = env::var("ProgramFiles") {
            candidates.push(PathBuf::from(path).join("Anki").join("anki.exe"));
        }
        if let Ok(path) = env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(path).join("Anki").join("anki.exe"));
        }

        for executable in candidates {
            if executable.is_file() {
                Command::new(&executable).spawn().map_err(|error| {
                    format!("Failed to start {}: {}", executable.display(), error)
                })?;
                return Ok(());
            }
        }

        Command::new("anki.exe")
            .spawn()
            .map(|_| ())
            .map_err(|_| "Anki не найден. Установите Anki или откройте его вручную.".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Anki"])
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to start Anki: {}", error))
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("anki")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to start Anki: {}", error))
    }
}

#[tauri::command]
async fn anki_request(action: String, params: Value) -> Result<Value, String> {
    let mut payload = serde_json::json!({
        "action": action,
        "version": 6,
        "params": params,
    });
    if let Some(api_key) = read_ankiconnect_api_key() {
        payload["key"] = Value::String(api_key);
    }

    // AnkiConnect is strictly local. Bypassing system/VPN proxies avoids sending
    // 127.0.0.1 traffic through a proxy which can reply with an unrelated 403.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Could not create AnkiConnect client: {error}"))?;
    let response = client
        .post("http://127.0.0.1:8765")
        .header(reqwest::header::ORIGIN, "http://localhost")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("AnkiConnect is unavailable: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("AnkiConnect response could not be read: {error}"))?;
    if !status.is_success() {
        return Err(format!("AnkiConnect HTTP {status}: {body}"));
    }

    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid AnkiConnect response: {error}"))?;
    if let Some(error) = payload.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    Ok(payload.get("result").cloned().unwrap_or(Value::Null))
}

const SETSUNA_ANKI_ORIGINS: [&str; 5] = [
    "http://localhost",
    "http://tauri.localhost",
    "tauri://localhost",
    "http://127.0.0.1:1420",
    "http://localhost:1420",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnkiConnectConfigResult {
    path: String,
    changed: bool,
    requires_anki_restart: bool,
    origins: Vec<String>,
}

fn ankiconnect_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = env::var_os("APPDATA").map(PathBuf::from).map(|path| path.join("Anki2"));

    #[cfg(target_os = "macos")]
    let base = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support").join("Anki2"));

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from).map(|path| path.join(".local").join("share")))
        .map(|path| path.join("Anki2"));

    base.map(|path| path.join("addons21").join("2055492159").join("config.json"))
}

fn read_ankiconnect_config() -> Option<(PathBuf, Value)> {
    let path = ankiconnect_config_path()?;
    let contents = fs::read_to_string(&path).ok()?;
    let config = serde_json::from_str(&contents).ok()?;
    Some((path, config))
}

fn read_ankiconnect_api_key() -> Option<String> {
    let (_, config) = read_ankiconnect_config()?;
    config
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

#[tauri::command]
fn configure_ankiconnect() -> Result<AnkiConnectConfigResult, String> {
    let path = ankiconnect_config_path().ok_or_else(|| {
        "Could not locate the Anki data directory on this computer.".to_string()
    })?;
    if !path.is_file() {
        return Err(format!(
            "AnkiConnect config was not found at {}. Install add-on 2055492159 and restart Anki first.",
            path.display()
        ));
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut config: Value = serde_json::from_str(&contents)
        .map_err(|error| format!("AnkiConnect config is not valid JSON: {error}"))?;
    let original_config = config.clone();
    let object = config
        .as_object_mut()
        .ok_or_else(|| "AnkiConnect config must be a JSON object.".to_string())?;

    let mut origins = object
        .get("webCorsOriginList")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    origins.retain(|value| value.as_str() != Some("*"));
    for origin in SETSUNA_ANKI_ORIGINS {
        if !origins.iter().any(|value| value.as_str() == Some(origin)) {
            origins.push(Value::String(origin.to_string()));
        }
    }
    object.insert("webCorsOriginList".to_string(), Value::Array(origins));
    object
        .entry("webBindAddress".to_string())
        .or_insert_with(|| Value::String("127.0.0.1".to_string()));
    object
        .entry("webBindPort".to_string())
        .or_insert_with(|| Value::Number(8765.into()));

    if let Some(ignored) = object.get_mut("ignoreOriginList").and_then(Value::as_array_mut) {
        ignored.retain(|value| {
            value
                .as_str()
                .map(|origin| !SETSUNA_ANKI_ORIGINS.contains(&origin))
                .unwrap_or(true)
        });
    } else {
        object.insert("ignoreOriginList".to_string(), Value::Array(Vec::new()));
    }

    let updated = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize AnkiConnect config: {error}"))?;
    let changed = config != original_config;
    if changed {
        let backup_path = path.with_extension("json.setsuna-backup");
        if !backup_path.exists() {
            fs::copy(&path, &backup_path).map_err(|error| {
                format!("Could not back up AnkiConnect config: {error}")
            })?;
        }
        fs::write(&path, format!("{updated}\n"))
            .map_err(|error| format!("Could not write AnkiConnect config: {error}"))?;
    }

    Ok(AnkiConnectConfigResult {
        path: path.display().to_string(),
        changed,
        requires_anki_restart: changed,
        origins: SETSUNA_ANKI_ORIGINS.iter().map(|origin| origin.to_string()).collect(),
    })
}

fn oauth_server_port_state() -> &'static Mutex<Option<u16>> {
    OAUTH_SERVER_PORT.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn clean_uia_lookup_text(text: &str) -> Option<String> {
    let cleaned = text
        .replace('\r', "")
        .replace('\n', "")
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
    if cleaned.is_empty() || cleaned.chars().count() > 80 {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(target_os = "windows")]
fn uia_text_under_cursor(point: POINT) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Option<String> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let pattern = uia_text_pattern_from_point(&automation, point)?;
            let range = pattern
                .RangeFromPoint(UiaPoint {
                    x: point.x,
                    y: point.y,
                })
                .ok()?;
            range.ExpandToEnclosingUnit(TextUnit_Word).ok()?;
            let _ = range.Select();
            let text = range.GetText(80).ok()?.to_string();
            clean_uia_lookup_text(&text)
        })();
        CoUninitialize();
        result
    }
}

#[cfg(target_os = "windows")]
unsafe fn uia_text_pattern_from_element(
    element: &IUIAutomationElement,
) -> Option<IUIAutomationTextPattern> {
    element.GetCurrentPatternAs(UIA_TextPatternId).ok()
}

#[cfg(target_os = "windows")]
unsafe fn uia_text_pattern_from_point(
    automation: &IUIAutomation,
    point: POINT,
) -> Option<IUIAutomationTextPattern> {
    let mut element = automation
        .ElementFromPoint(UiaPoint {
            x: point.x,
            y: point.y,
        })
        .ok()?;

    for _ in 0..8 {
        if let Some(pattern) = uia_text_pattern_from_element(&element) {
            return Some(pattern);
        }

        let walker = automation
            .RawViewWalker()
            .or_else(|_| automation.ControlViewWalker())
            .ok()?;
        element = walker.GetParentElement(&element).ok()?;
    }

    None
}

#[cfg(target_os = "windows")]
unsafe fn uia_name_from_point(automation: &IUIAutomation, point: POINT) -> Option<String> {
    let mut element = automation
        .ElementFromPoint(UiaPoint {
            x: point.x,
            y: point.y,
        })
        .ok()?;

    for _ in 0..8 {
        if let Ok(name) = element.CurrentName() {
            let text = name.to_string();
            if let Some(cleaned) = clean_uia_lookup_text(&text) {
                return Some(cleaned);
            }
            let context = normalize_uia_context(&text);
            if !context.trim().is_empty() && context.chars().count() <= 220 {
                return Some(context);
            }
        }

        let walker = automation
            .RawViewWalker()
            .or_else(|_| automation.ControlViewWalker())
            .ok()?;
        element = walker.GetParentElement(&element).ok()?;
    }

    None
}

#[cfg(target_os = "windows")]
fn normalize_uia_context(text: &str) -> String {
    text.replace('\r', "")
        .replace('\n', "")
        .chars()
        .collect::<String>()
}

#[cfg(target_os = "windows")]
fn uia_context_under_cursor(point: POINT) -> Option<(String, usize)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Option<(String, usize)> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let pattern = uia_text_pattern_from_point(&automation, point)?;
            let caret = pattern
                .RangeFromPoint(UiaPoint {
                    x: point.x,
                    y: point.y,
                })
                .ok()?;

            let left = caret.Clone().ok()?;
            let right = caret.Clone().ok()?;
            let context = caret.Clone().ok()?;

            let _ =
                left.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -48);
            let _ = left.MoveEndpointByRange(
                TextPatternRangeEndpoint_End,
                &caret,
                TextPatternRangeEndpoint_Start,
            );

            let _ = right.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 48);
            let _ = right.MoveEndpointByRange(
                TextPatternRangeEndpoint_Start,
                &caret,
                TextPatternRangeEndpoint_End,
            );

            let _ =
                context.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -48);
            let _ =
                context.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 48);

            let left_text = normalize_uia_context(&left.GetText(96).ok()?.to_string());
            let context_text = normalize_uia_context(&context.GetText(160).ok()?.to_string());
            let cursor = left_text.chars().count().min(context_text.chars().count());
            if context_text.trim().is_empty() {
                None
            } else {
                Some((context_text, cursor))
            }
        })();
        CoUninitialize();
        result
    }
}

#[cfg(target_os = "windows")]
fn scintilla_word_under_cursor(point: POINT) -> Option<String> {
    const SCI_POSITIONFROMPOINTCLOSE: u32 = 2023;
    const SCI_SETSEL: u32 = 2160;
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
        ) as isize;
        if position < 0 {
            return None;
        }
        let start = SendMessageW(hwnd, SCI_WORDSTARTPOSITION, position as usize, 1) as isize;
        let end = SendMessageW(hwnd, SCI_WORDENDPOSITION, position as usize, 1) as isize;
        let length = end.saturating_sub(start) as usize;
        if start < 0 || length == 0 || length > 160 {
            return None;
        }
        let remote_pointer =
            SendMessageW(hwnd, SCI_GETRANGEPOINTER, start as usize, length as isize)
                as *const winapi::ctypes::c_void;
        if remote_pointer.is_null() {
            return None;
        }

        let mut pid = 0_u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
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
        let text = clean_uia_lookup_text(&text)?;
        SendMessageW(hwnd, SCI_SETSEL, start as usize, end as isize);
        Some(text)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn select_hovered_lookup_range(
    x: i32,
    y: i32,
    match_start: usize,
    match_len: usize,
) -> Result<(), String> {
    if match_len == 0 {
        return Ok(());
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Result<(), String> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .map_err(|error| error.to_string())?;
            let pattern = uia_text_pattern_from_point(&automation, POINT { x, y })
                .ok_or_else(|| "Text selection is not available here".to_string())?;
            let caret = pattern
                .RangeFromPoint(UiaPoint { x, y })
                .map_err(|error| error.to_string())?;
            let context = caret.Clone().map_err(|error| error.to_string())?;
            let _ =
                context.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -48);
            let selection = context.Clone().map_err(|error| error.to_string())?;
            selection
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &context,
                    TextPatternRangeEndpoint_Start,
                )
                .map_err(|error| error.to_string())?;
            let _ = selection.MoveEndpointByUnit(
                TextPatternRangeEndpoint_Start,
                TextUnit_Character,
                match_start.min(i32::MAX as usize) as i32,
            );
            let _ = selection.MoveEndpointByUnit(
                TextPatternRangeEndpoint_End,
                TextUnit_Character,
                match_start.saturating_add(match_len).min(i32::MAX as usize) as i32,
            );
            selection.Select().map_err(|error| error.to_string())?;
            Ok(())
        })();
        CoUninitialize();
        result
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn select_hovered_lookup_range(
    _x: i32,
    _y: i32,
    _match_start: usize,
    _match_len: usize,
) -> Result<(), String> {
    Err(global_lookup_unavailable_reason("selection"))
}

pub struct DiagnosticsState {
    pub frontend: Mutex<Option<Value>>,
}

pub struct JlModeState {
    pub last_line: Mutex<String>,
}

pub struct JlLookupState {
    pub payload: Mutex<Option<Value>>,
}

pub struct FlowTimerState {
    pub paused: AtomicBool,
}

pub struct DiscordPresenceRuntime {
    pub client_id: String,
    pub client: DiscordIpcClient,
}

pub struct CaptureAgentRuntime {
    pub stop: Arc<AtomicBool>,
    pub port: u16,
    pub token: String,
}

pub struct TextSyncRuntime {
    pub stop: Arc<AtomicBool>,
    pub port: u16,
    pub token: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextSyncLine {
    seq: u64,
    text: String,
    at_ms: u64,
    #[serde(default = "default_text_sync_kind")]
    kind: String,
    #[serde(default)]
    payload: Option<Value>,
}

fn default_text_sync_kind() -> String {
    "line".to_string()
}

#[derive(serde::Serialize, Clone)]
pub struct TextSyncStartResult {
    url: String,
    port: u16,
    token: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSyncEventsResponse {
    ok: bool,
    seq: u64,
    lines: Vec<TextSyncLine>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextSyncRelayState {
    version: u8,
    device_id: String,
    updated_at_ms: u64,
    state_key: String,
    payload: Value,
}

#[derive(serde::Deserialize)]
struct TextSyncPushRequest {
    kind: String,
    payload: Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountAuthRequest {
    email: String,
    password: String,
    device_id: String,
    device_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountDeviceRequest {
    device_id: String,
    device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_agent_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_agent_token: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ProcessInfo {
    name: String,
    path: String,
    pid: u32,
    icon: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CaptureWindowInfo {
    id: u64,
    title: String,
    app_name: String,
    process_name: String,
    path: String,
    pid: u32,
    width: u32,
    height: u32,
    is_focused: bool,
    is_recent: bool,
    icon: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct CaptureAgentStartResult {
    url: String,
    port: u16,
    token: String,
}

#[derive(serde::Deserialize)]
struct RemoteSourcesResponse {
    sources: Vec<CaptureWindowInfo>,
}

#[derive(serde::Deserialize)]
struct RemoteCaptureResponse {
    image: String,
}

#[derive(Clone, Debug)]
struct ScreenshotTarget {
    name: String,
    path: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DeinflectReason {
    rule: Value,
    desc: Value,
    #[serde(default)]
    in_suffix: String,
    #[serde(default)]
    out_suffix: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FrequencyData {
    dict_name: String,
    display_value: String,
    value: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PitchData {
    dict_name: String,
    reading: String,
    position: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PronunciationData {
    dict_name: String,
    reading: String,
    ipa: String,
    tags: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DictEntry {
    term: String,
    reading: String,
    definition: String,
    dict_name: String,
    tags: String,
    deinflection_reasons: Vec<DeinflectReason>,
    frequencies: Vec<FrequencyData>,
    pitches: Vec<PitchData>,
    pronunciations: Vec<PronunciationData>,
    source_length: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryUpdateStatus {
    dict_name: String,
    current_revision: String,
    latest_revision: String,
    update_available: bool,
    error: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CambridgeApiConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    dictionary_code: String,
    #[serde(default)]
    base_url: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CambridgeCacheRecord {
    saved_at_ms: u64,
    expires_at_ms: u64,
    entries: Vec<DictEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscordPresencePayload {
    enabled: bool,
    client_id: String,
    details: String,
    state: String,
    activity_type: String,
    start_timestamp_ms: Option<i64>,
    large_image: Option<String>,
    large_text: Option<String>,
    small_image: Option<String>,
    small_text: Option<String>,
    button_label: Option<String>,
    button_url: Option<String>,
    second_button_label: Option<String>,
    second_button_url: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct TextToken {
    text: String,
    reading: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CursorLookupResult {
    entries: Vec<DictEntry>,
    match_start: usize,
    match_len: usize,
    word: String,
}

static DB_INDEXES_READY: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static DIAGNOSTICS_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const DIAGNOSTICS_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const LOOKUP_NO_MATCH: &str = "\u{0000}SETSUNA_NO_MATCH";
const LOOKUP_MAX_SCAN_CHARS: usize = 12;
const LOOKUP_SCAN_DEINFLECT_DEPTH: usize = 3;
const LOOKUP_DIRECT_DEINFLECT_DEPTH: usize = 3;
const CAMBRIDGE_CACHE_FILE: &str = "cambridge-api-cache.json";
const CAMBRIDGE_CACHE_TTL_MS: u64 = 180 * 24 * 60 * 60 * 1000;
const CAMBRIDGE_NEGATIVE_CACHE_TTL_MS: u64 = 14 * 24 * 60 * 60 * 1000;
const CAMBRIDGE_CACHE_MAX_RECORDS: usize = 2000;
const CAMBRIDGE_CACHE_MAX_ENTRY_BYTES: usize = 160 * 1024;

fn unix_time_ms() -> u128 {
    StdSystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn diagnostics_log_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_path(app, "setsuna-diagnostics.log").unwrap_or_else(|_| {
        env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("setsuna-diagnostics.log")))
            .unwrap_or_else(|| PathBuf::from("setsuna-diagnostics.log"))
    })
}

fn append_diagnostics_line(app: &tauri::AppHandle, payload: Value) {
    let Ok(_guard) = DIAGNOSTICS_LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let path = diagnostics_log_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let should_truncate = std::fs::metadata(&path)
        .map(|metadata| metadata.len() >= DIAGNOSTICS_LOG_MAX_BYTES)
        .unwrap_or(false);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!should_truncate)
        .truncate(should_truncate)
        .open(path)
    {
        let _ = writeln!(file, "{}", payload);
    }
}

fn collect_setsuna_processes() -> Vec<Value> {
    vec![current_process_memory_snapshot()]
}

#[cfg(target_os = "windows")]
fn current_process_memory_snapshot() -> Value {
    unsafe {
        let process = GetCurrentProcess();
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let ok = GetProcessMemoryInfo(
            process,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );

        if ok != 0 {
            return serde_json::json!({
                "pid": std::process::id().to_string(),
                "name": "Setsuna.exe",
                "role": "main",
                "memoryRaw": counters.WorkingSetSize,
                "privateRaw": counters.PagefileUsage,
                "peakMemoryRaw": counters.PeakWorkingSetSize,
                "source": "GetProcessMemoryInfo",
            });
        }
    }

    serde_json::json!({
        "pid": std::process::id().to_string(),
        "name": "Setsuna.exe",
        "role": "main",
        "memoryRaw": 0,
        "source": "GetProcessMemoryInfoFailed",
    })
}

#[cfg(target_os = "linux")]
fn current_process_memory_snapshot() -> Value {
    // /proc/self/status reports these in kB. VmRSS is the closest analogue to
    // the Windows working set, VmHWM to the peak working set, and RssAnon to
    // the private (non file-backed) resident pages.
    fn read_kib(status: &str, key: &str) -> Option<u64> {
        status.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?.strip_prefix(':')?;
            rest.split_whitespace().next()?.parse::<u64>().ok()
        })
    }

    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        if let Some(rss_kib) = read_kib(&status, "VmRSS") {
            let mut snapshot = serde_json::json!({
                "pid": std::process::id().to_string(),
                "name": "Setsuna",
                "role": "main",
                "memoryRaw": rss_kib * 1024,
                "source": "/proc/self/status",
            });
            if let Some(peak_kib) = read_kib(&status, "VmHWM") {
                snapshot["peakMemoryRaw"] = (peak_kib * 1024).into();
            }
            if let Some(private_kib) = read_kib(&status, "RssAnon") {
                snapshot["privateRaw"] = (private_kib * 1024).into();
            }
            return snapshot;
        }
    }

    serde_json::json!({
        "pid": std::process::id().to_string(),
        "name": "Setsuna",
        "role": "main",
        "memoryRaw": 0,
        "source": "procStatusUnavailable",
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn current_process_memory_snapshot() -> Value {
    serde_json::json!({
        "pid": std::process::id().to_string(),
        "name": "Setsuna",
        "role": "main",
        "memoryRaw": 0,
        "source": "unsupported",
    })
}

fn start_diagnostics_logger(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let dictionary_path = get_dictionary_db_path(&app).ok();
        let dictionary_bytes = dictionary_path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        append_diagnostics_line(
            &app,
            serde_json::json!({
                "ts": unix_time_ms(),
                "kind": "startup_snapshot",
                "dictionaryPath": dictionary_path.map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
                "dictionaryBytes": dictionary_bytes,
                "processes": collect_setsuna_processes(),
            }),
        );
    });
}

fn ensure_db_indexes(db_path: &Path, db: &Connection) {
    let ready = DB_INDEXES_READY.get_or_init(|| Mutex::new(HashSet::new()));
    if ready
        .lock()
        .map(|paths| paths.contains(db_path))
        .unwrap_or(false)
    {
        return;
    }

    db.execute("CREATE INDEX IF NOT EXISTS idx_term ON entries(term)", [])
        .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_reading ON entries(reading)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_freq_term ON frequencies(term)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_freq_reading ON frequencies(reading)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_pitch_term ON pitches(term)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_pitch_reading ON pitches(reading)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_pron_term ON pronunciations(term)",
        [],
    )
    .ok();
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_pron_reading ON pronunciations(reading)",
        [],
    )
    .ok();

    if let Ok(mut paths) = ready.lock() {
        paths.insert(db_path.to_path_buf());
    }
}

fn get_data_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let data_dir = exe_dir.join("data");
            if exe_dir.join("portable.txt").exists() || data_dir.exists() {
                if !data_dir.exists() {
                    std::fs::create_dir_all(&data_dir).ok();
                }
                return Ok(data_dir.join(filename));
            }
        }
    }
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to access AppData".to_string())?;
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }
    Ok(app_dir.join(filename))
}

fn dictionary_entry_count(path: &Path) -> Option<i64> {
    if !path.exists() || path.metadata().ok()?.len() == 0 {
        return None;
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
        .ok()
}

fn is_usable_dictionary(path: &Path) -> bool {
    dictionary_entry_count(path).unwrap_or(0) > 0
}

fn push_dictionary_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.exists() && !candidates.iter().any(|existing| existing == &path) {
        candidates.push(path);
    }
}

fn get_dictionary_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let primary = get_data_path(app, "dictionary.db")?;
    if is_usable_dictionary(&primary) {
        return Ok(primary);
    }

    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        for dir in cwd.ancestors() {
            push_dictionary_candidate(&mut candidates, dir.join("dictionary.db"));
            push_dictionary_candidate(&mut candidates, dir.join("target").join("dictionary.db"));
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for dir in exe_dir.ancestors() {
                push_dictionary_candidate(&mut candidates, dir.join("dictionary.db"));
                push_dictionary_candidate(
                    &mut candidates,
                    dir.join("target").join("dictionary.db"),
                );
            }
        }
    }

    candidates.sort_by_key(|path| {
        std::cmp::Reverse(path.metadata().map(|m| m.modified().ok()).ok().flatten())
    });

    for candidate in candidates {
        if is_usable_dictionary(&candidate) {
            return Ok(candidate);
        }
    }

    Ok(primary)
}

fn install_panic_logger() {
    std::panic::set_hook(Box::new(|info| {
        let message = if let Some(location) = info.location() {
            format!(
                "panic at {}:{}: {}\n",
                location.file(),
                location.line(),
                info
            )
        } else {
            format!("panic: {}\n", info)
        };
        let log_path = env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("setsuna-crash.log")))
            .unwrap_or_else(|| PathBuf::from("setsuna-crash.log"));
        let _ = std::fs::write(log_path, message);
    }));
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = get_dictionary_db_path(app)?;
    let db = if db_path.exists() {
        Connection::open(&db_path).map_err(|e| e.to_string())?
    } else {
        Connection::open(&db_path).map_err(|e| e.to_string())?
    };
    db.execute("PRAGMA journal_mode = WAL;", []).ok();
    db.execute("PRAGMA synchronous = NORMAL;", []).ok();
    db.execute("PRAGMA busy_timeout = 15000;", []).ok();
    db.execute("PRAGMA cache_size = -4096;", []).ok();
    db.execute("PRAGMA temp_store = DEFAULT;", []).ok();
    db.execute("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, definition TEXT NOT NULL, dict_name TEXT DEFAULT 'Unknown', tags TEXT DEFAULT '')", []).map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS frequencies (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, value INTEGER, display_value TEXT, dict_name TEXT)", []).map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS pitches (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, position INTEGER, dict_name TEXT)", []).map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS pronunciations (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, ipa TEXT NOT NULL, tags TEXT DEFAULT '', dict_name TEXT)", []).map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS dictionary_meta (title TEXT PRIMARY KEY, revision TEXT DEFAULT '', format INTEGER DEFAULT 0, index_url TEXT DEFAULT '', download_url TEXT DEFAULT '', is_updatable INTEGER DEFAULT 0, imported_at_ms INTEGER DEFAULT 0)", []).map_err(|e| e.to_string())?;
    ensure_db_indexes(&db_path, &db);
    Ok(db)
}

#[tauri::command]
fn get_diagnostics_log_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(diagnostics_log_path(&app).to_string_lossy().to_string())
}

#[tauri::command]
fn log_frontend_diagnostics(
    app: tauri::AppHandle,
    payload: Value,
    state: tauri::State<DiagnosticsState>,
) -> Result<(), String> {
    if let Ok(mut frontend) = state.frontend.lock() {
        *frontend = Some(payload.clone());
    }

    append_diagnostics_line(
        &app,
        serde_json::json!({
            "ts": unix_time_ms(),
            "kind": "frontend",
            "frontend": payload,
        }),
    );

    Ok(())
}

fn kata_to_hira(s: &str) -> String {
    s.chars()
        .map(|c| {
            let u = c as u32;
            if (0x30A1..=0x30F6).contains(&u) {
                std::char::from_u32(u - 0x0060).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}
fn hira_to_kata(s: &str) -> String {
    s.chars()
        .map(|c| {
            let u = c as u32;
            if (0x3041..=0x3096).contains(&u) {
                std::char::from_u32(u + 0x0060).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn push_english_base_forms(values: &mut Vec<String>, lower: &str) {
    if !is_english_lookup_word(lower) {
        return;
    }

    if lower.ends_with("ies") && lower.len() > 4 {
        let mut stem = lower[..lower.len() - 3].to_string();
        stem.push('y');
        push_unique_string(values, stem);
    }

    if lower.ends_with("ing") && lower.len() > 5 {
        let stem = &lower[..lower.len() - 3];
        push_unique_string(values, stem.to_string());
        let mut with_e = stem.to_string();
        with_e.push('e');
        push_unique_string(values, with_e);

        let stem_chars: Vec<char> = stem.chars().collect();
        if stem_chars.len() >= 2
            && stem_chars[stem_chars.len() - 1] == stem_chars[stem_chars.len() - 2]
        {
            push_unique_string(values, stem_chars[..stem_chars.len() - 1].iter().collect());
        }
    }

    if lower.ends_with("ed") && lower.len() > 4 {
        let stem = &lower[..lower.len() - 2];
        push_unique_string(values, stem.to_string());
        let mut with_e = stem.to_string();
        with_e.push('e');
        push_unique_string(values, with_e);

        let stem_chars: Vec<char> = stem.chars().collect();
        if stem_chars.len() >= 2
            && stem_chars[stem_chars.len() - 1] == stem_chars[stem_chars.len() - 2]
        {
            push_unique_string(values, stem_chars[..stem_chars.len() - 1].iter().collect());
        }
    }

    if lower.ends_with("es") && lower.len() > 3 {
        push_unique_string(values, lower[..lower.len() - 2].to_string());
    }

    if lower.ends_with('s') && lower.len() > 3 && !lower.ends_with("ss") {
        push_unique_string(values, lower[..lower.len() - 1].to_string());
    }
}

fn lookup_forms(term: &str) -> Vec<String> {
    let mut forms = Vec::new();
    push_unique_string(&mut forms, term.to_string());
    if term.chars().any(|c| c.is_ascii_alphabetic()) {
        let lower = term.to_lowercase();
        push_unique_string(&mut forms, lower.clone());
        push_english_base_forms(&mut forms, &lower);
        push_unique_string(&mut forms, term.to_uppercase());
        let mut chars = term.chars();
        if let Some(first) = chars.next() {
            let mut title = first.to_uppercase().collect::<String>();
            title.push_str(&chars.as_str().to_lowercase());
            push_unique_string(&mut forms, title);
        }
    }
    push_unique_string(&mut forms, kata_to_hira(term));
    push_unique_string(&mut forms, hira_to_kata(term));

    for (from, to) in [
        ("\u{308A}", "\u{308B}"),
        ("\u{3044}", "\u{3046}"),
        ("\u{304D}", "\u{304F}"),
        ("\u{304E}", "\u{3050}"),
        ("\u{3057}", "\u{3059}"),
        ("\u{3061}", "\u{3064}"),
        ("\u{306B}", "\u{306C}"),
        ("\u{3073}", "\u{3076}"),
        ("\u{307F}", "\u{3080}"),
        ("\u{3058}", "\u{305A}"),
    ] {
        if term.ends_with(from) && term.chars().count() > 1 {
            let mut stem = term[..term.len() - from.len()].to_string();
            stem.push_str(to);
            push_unique_string(&mut forms, stem.clone());
            push_unique_string(&mut forms, kata_to_hira(&stem));
            push_unique_string(&mut forms, hira_to_kata(&stem));
        }
    }

    while forms.len() < 8 {
        forms.push(LOOKUP_NO_MATCH.to_string());
    }
    forms.truncate(8);
    forms
}

fn lookup_entry_rank(entry: &DictEntry, forms: &[String]) -> i32 {
    if entry.term == forms[0] {
        return 0;
    }
    if entry.reading == forms[0] {
        return 1;
    }
    if forms
        .iter()
        .skip(1)
        .any(|form| !form.is_empty() && entry.term == *form)
    {
        return 2;
    }
    if forms
        .iter()
        .skip(1)
        .any(|form| !form.is_empty() && entry.reading == *form)
    {
        return 3;
    }
    4
}

fn best_frequency_value(entry: &DictEntry) -> i64 {
    entry
        .frequencies
        .iter()
        .map(|freq| freq.value)
        .filter(|value| *value > 0)
        .min()
        .unwrap_or(i64::MAX)
}

fn load_rules() -> Vec<(Value, Value, String, String)> {
    let rules_str = include_str!("deinflect.json");
    let clean_rules_str = rules_str.trim_start_matches('\u{feff}');
    let mut rules = Vec::new();
    let mut unique_pairs = HashSet::new();
    if let Ok(json_rules) = serde_json::from_str::<Value>(clean_rules_str) {
        if let Some(arr) = json_rules.as_array() {
            for item in arr {
                let in_s = item
                    .get("in")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let out_s = item
                    .get("out")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if in_s.is_empty() {
                    continue;
                }
                if unique_pairs.insert((in_s.clone(), out_s.clone())) {
                    let reason = item
                        .get("reason")
                        .cloned()
                        .unwrap_or(Value::String("".to_string()));
                    let desc = item
                        .get("desc")
                        .cloned()
                        .unwrap_or(Value::String("".to_string()));
                    rules.push((reason, desc, in_s, out_s));
                }
            }
        }
    }
    rules
}

#[tauri::command]
async fn get_installed_dicts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut db = open_db(&app)?;
    // Older builds could leave one row per dated revision. Clean those rows
    // before exposing dictionary names to the frontend.
    dictionary_import::cleanup_stale_dictionary_revisions(&mut db)?;
    let mut names = HashSet::new();
    for table in ["entries", "frequencies", "pitches", "pronunciations"] {
        let sql = format!(
            "SELECT DISTINCT dict_name FROM {} WHERE dict_name IS NOT NULL AND dict_name != ''",
            table
        );
        let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for name in rows.flatten() {
            names.insert(name);
        }
    }
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
async fn check_dictionary_updates(
    app: tauri::AppHandle,
) -> Result<Vec<DictionaryUpdateStatus>, String> {
    let dictionaries = {
        let db = open_db(&app)?;
        let mut stmt = db
            .prepare(
                "SELECT title, revision, index_url FROM dictionary_meta
                 WHERE is_updatable = 1 AND index_url != '' ORDER BY title",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.flatten().collect::<Vec<_>>()
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut statuses = Vec::with_capacity(dictionaries.len());
    for (dict_name, current_revision, index_url) in dictionaries {
        let result = async {
            let response = client
                .get(&index_url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            let index = response.json::<Value>().await.map_err(|e| e.to_string())?;
            Ok::<String, String>(
                index
                    .get("revision")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        }
        .await;

        match result {
            Ok(latest_revision) => statuses.push(DictionaryUpdateStatus {
                dict_name,
                update_available: !latest_revision.is_empty()
                    && latest_revision != current_revision,
                current_revision,
                latest_revision,
                error: String::new(),
            }),
            Err(error) => statuses.push(DictionaryUpdateStatus {
                dict_name,
                current_revision,
                latest_revision: String::new(),
                update_available: false,
                error,
            }),
        }
    }
    Ok(statuses)
}

#[tauri::command]
async fn update_dictionary_from_source(
    app: tauri::AppHandle,
    dict_name: String,
) -> Result<usize, String> {
    let download_url = {
        let db = open_db(&app)?;
        db.query_row(
            "SELECT download_url FROM dictionary_meta WHERE title = ?1 AND is_updatable = 1",
            params![&dict_name],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("Dictionary '{}' has no update source", dict_name))?
    };
    if !(download_url.starts_with("https://") || download_url.starts_with("http://")) {
        return Err("Dictionary update URL is invalid".to_string());
    }

    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Dictionary download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Dictionary download failed: HTTP {}",
            response.status()
        ));
    }
    if response.content_length().unwrap_or(0) > 64 * 1024 * 1024 * 1024 {
        return Err("Dictionary archive is larger than 64 GB".to_string());
    }

    let temp_path = std::env::temp_dir().join(format!(
        "setsuna-dictionary-update-{}-{}.zip",
        std::process::id(),
        unix_time_ms()
    ));
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create update file: {}", e))?;
    let mut response = response;
    let mut downloaded = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to download dictionary: {}", e))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > 64 * 1024 * 1024 * 1024 {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err("Dictionary archive is larger than 64 GB".to_string());
        }
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("Failed to save dictionary update: {}", e))?;
    }
    drop(file);

    let result =
        dictionary_import::import_dictionary(app, temp_path.to_string_lossy().into_owned()).await;
    let _ = tokio::fs::remove_file(&temp_path).await;
    result
}

fn available_space_for_path(path: &Path) -> Option<u64> {
    let base = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    let resolved = base.canonicalize().unwrap_or(base);
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| resolved.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
}

fn emit_drive_progress(app: &tauri::AppHandle, operation: &str, transferred: u64, total: u64) {
    let percent = if total == 0 {
        0
    } else {
        ((transferred.saturating_mul(100) / total).min(100)) as u8
    };
    let _ = app.emit(
        "drive_dictionary_progress",
        DriveTransferProgress {
            operation: operation.to_string(),
            transferred,
            total,
            percent,
        },
    );
}

fn resumable_next_offset(range: Option<&str>) -> u64 {
    range
        .and_then(|value| value.rsplit('-').next())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|last| last.saturating_add(1))
        .unwrap_or(0)
}

async fn query_resumable_upload_offset(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    file_len: u64,
) -> Result<u64, String> {
    let response = client
        .put(url)
        .bearer_auth(token)
        .header("Content-Length", "0")
        .header("Content-Range", format!("bytes */{}", file_len))
        .body(Vec::<u8>::new())
        .send()
        .await
        .map_err(|error| format!("Failed to query dictionary upload state: {}", error))?;

    if response.status().is_success() {
        return Ok(file_len);
    }
    if response.status().as_u16() == 308 {
        return Ok(resumable_next_offset(
            response
                .headers()
                .get("range")
                .and_then(|value| value.to_str().ok()),
        )
        .min(file_len));
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Google Drive upload session expired. Start the upload again.".to_string());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Failed to query dictionary upload state: {} - {}",
        status, body
    ))
}

#[tauri::command]
fn get_dictionary_storage_info(app: tauri::AppHandle) -> Result<DictionaryStorageInfo, String> {
    let path = get_dictionary_db_path(&app)?;
    let size = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(DictionaryStorageInfo {
        path: path.to_string_lossy().into_owned(),
        size,
        available_bytes: available_space_for_path(&path),
    })
}

#[tauri::command]
fn store_google_refresh_token(refresh_token: String) -> Result<(), String> {
    if refresh_token.trim().is_empty() {
        return Err("Google refresh token is empty".to_string());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new("com.serichka.setsuna", "google-drive")
            .map_err(|e| format!("Credential storage is unavailable: {}", e))?;
        return entry
            .set_password(refresh_token.trim())
            .map_err(|e| format!("Failed to protect Google credentials: {}", e));
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Err("Secure Google credential storage is not available on mobile yet".to_string())
    }
}

#[tauri::command]
fn load_google_refresh_token() -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new("com.serichka.setsuna", "google-drive")
            .map_err(|e| format!("Credential storage is unavailable: {}", e))?;
        return match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("Failed to read Google credentials: {}", error)),
        };
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn delete_google_refresh_token() -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = keyring::Entry::new("com.serichka.setsuna", "google-drive")
            .map_err(|e| format!("Credential storage is unavailable: {}", e))?;
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Failed to remove Google credentials: {}", error)),
        };
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(())
    }
}

#[tauri::command]
async fn upload_db_to_drive(
    app: tauri::AppHandle,
    url: String,
    token: String,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let db_path = get_dictionary_db_path(&app)?;
    let mut file = tokio::fs::File::open(&db_path)
        .await
        .map_err(|e| format!("Failed to open dictionary database: {}", e))?;
    let file_len = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to inspect dictionary database: {}", e))?
        .len();
    let client = reqwest::Client::new();
    emit_drive_progress(&app, "upload", 0, file_len);

    if !url.contains("uploadType=resumable") && !url.contains("upload_id=") {
        let stream = tokio_util::io::ReaderStream::new(file);
        let body = reqwest::Body::wrap_stream(stream);
        let res = client
            .patch(&url)
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", file_len.to_string())
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Failed to upload dictionary database: {}", e))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Dictionary database upload failed: {} - {}", status, body));
        }
        emit_drive_progress(&app, "upload", file_len, file_len);
        return Ok(());
    }

    const CHUNK_SIZE: usize = 8 * 1024 * 1024;
    let mut offset = 0_u64;
    while offset < file_len {
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Failed to seek dictionary database: {}", e))?;
        let amount = ((file_len - offset) as usize).min(CHUNK_SIZE);
        let mut chunk = vec![0_u8; amount];
        file.read_exact(&mut chunk)
            .await
            .map_err(|e| format!("Failed to read dictionary database: {}", e))?;
        let end = offset + amount as u64 - 1;
        let mut attempts = 0_u8;
        loop {
            attempts += 1;
            let result = client
                .put(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", amount.to_string())
                .header("Content-Range", format!("bytes {}-{}/{}", offset, end, file_len))
                .body(chunk.clone())
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {
                    offset = file_len;
                    break;
                }
                Ok(response) if response.status().as_u16() == 308 => {
                    let confirmed = resumable_next_offset(
                        response
                            .headers()
                            .get("range")
                            .and_then(|value| value.to_str().ok()),
                    )
                    .min(file_len);
                    if confirmed > offset {
                        offset = confirmed;
                        break;
                    }
                    if attempts >= 4 {
                        return Err(
                            "Google Drive did not accept the current dictionary chunk."
                                .to_string(),
                        );
                    }
                }
                Ok(response) => {
                    let status = response.status();
                    let retryable = status.is_server_error() || status.as_u16() == 429;
                    let body = response.text().await.unwrap_or_default();
                    if retryable && attempts < 4 {
                        tokio::time::sleep(Duration::from_millis(500 * attempts as u64)).await;
                        if let Ok(confirmed) =
                            query_resumable_upload_offset(&client, &url, &token, file_len).await
                        {
                            if confirmed > offset {
                                offset = confirmed;
                                break;
                            }
                        }
                        continue;
                    }
                    return Err(format!("Dictionary database upload failed: {} - {}", status, body));
                }
                Err(error) if attempts < 4 => {
                    let _ = error;
                    tokio::time::sleep(Duration::from_millis(500 * attempts as u64)).await;
                    if let Ok(confirmed) =
                        query_resumable_upload_offset(&client, &url, &token, file_len).await
                    {
                        if confirmed > offset {
                            offset = confirmed;
                            break;
                        }
                    }
                }
                Err(error) => return Err(format!("Failed to upload dictionary database: {}", error)),
            }
        }
        emit_drive_progress(&app, "upload", offset, file_len);
    }
    Ok(())
}

#[tauri::command]
async fn download_db_from_drive(
    app: tauri::AppHandle,
    url: String,
    token: String,
    expected_size: Option<u64>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let db_path = get_data_path(&app, "dictionary.db")?;
    let temp_path = db_path.with_extension("db.drive-download");
    let rollback_path = db_path.with_extension("db.before-drive-restore");
    let client = reqwest::Client::new();
    let mut res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Failed to download dictionary database: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Dictionary database download failed: {}", res.status()));
    }
    let total = expected_size.or_else(|| res.content_length()).unwrap_or(0);
    if total > 0 {
        if let Some(available) = available_space_for_path(&db_path) {
            let margin = (total / 50).max(32 * 1024 * 1024);
            if available < total.saturating_add(margin) {
                return Err(format!(
                    "Not enough local disk space. Need at least {} bytes, available {} bytes.",
                    total.saturating_add(margin),
                    available
                ));
            }
        }
    }

    let _ = tokio::fs::remove_file(&temp_path).await;
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temporary dictionary database: {}", e))?;
    let mut downloaded = 0_u64;
    emit_drive_progress(&app, "download", 0, total);
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Failed to read downloaded dictionary database: {}", e))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to save dictionary database: {}", e))?;
        downloaded += chunk.len() as u64;
        emit_drive_progress(&app, "download", downloaded, total.max(downloaded));
    }
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to flush dictionary database: {}", e))?;
    drop(file);

    if let Some(expected) = expected_size {
        if downloaded != expected {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!(
                "Downloaded dictionary size mismatch: expected {}, received {} bytes.",
                expected, downloaded
            ));
        }
    }

    let _ = tokio::fs::remove_file(&rollback_path).await;
    if tokio::fs::try_exists(&db_path).await.unwrap_or(false) {
        tokio::fs::rename(&db_path, &rollback_path)
            .await
            .map_err(|e| format!("Failed to prepare dictionary replacement: {}", e))?;
    }
    if let Err(error) = tokio::fs::rename(&temp_path, &db_path).await {
        if tokio::fs::try_exists(&rollback_path).await.unwrap_or(false) {
            let _ = tokio::fs::rename(&rollback_path, &db_path).await;
        }
        return Err(format!("Failed to apply downloaded dictionary: {}", error));
    }
    emit_drive_progress(&app, "download", downloaded, downloaded);
    Ok(())
}

#[tauri::command]
async fn start_oauth_server(app: tauri::AppHandle) -> Result<OAuthServerStart, String> {
    {
        let guard = oauth_server_port_state()
            .lock()
            .map_err(|e| format!("OAuth server state is locked: {}", e))?;
        if let Some(port) = *guard {
            return Ok(OAuthServerStart {
                port,
                redirect_uri: format!("http://127.0.0.1:{}", port),
                reused: true,
            });
        }
    }

    let listener = TcpListener::bind("127.0.0.1:1337")
        .or_else(|err| {
            if err.kind() == std::io::ErrorKind::AddrInUse {
                TcpListener::bind("127.0.0.1:0")
            } else {
                Err(err)
            }
        })
        .map_err(|e| format!("Failed to start local OAuth callback server: {}", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure local OAuth callback server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local OAuth callback address: {}", e))?
        .port();
    {
        let mut guard = oauth_server_port_state()
            .lock()
            .map_err(|e| format!("OAuth server state is locked: {}", e))?;
        *guard = Some(port);
    }

    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0; 4096];
                    if let Ok(size) = stream.read(&mut buffer) {
                        let request = String::from_utf8_lossy(&buffer[..size]);
                        if request.starts_with("GET ") {
                            let first_line = request.lines().next().unwrap_or("");
                            let parts: Vec<&str> = first_line.split_whitespace().collect();
                            if parts.len() > 1 {
                                let path = parts[1];
                                if let Some(query) = path.split('?').nth(1) {
                                    let mut has_code_or_error = false;
                                    for pair in query.split('&') {
                                        let mut kv = pair.split('=');
                                        if matches!(kv.next(), Some("code") | Some("error")) {
                                            has_code_or_error = true;
                                            break;
                                        }
                                    }
                                    if has_code_or_error {
                                        let callback_url =
                                            format!("http://127.0.0.1:{}{}", port, path);
                                        let _ = app.emit("oauth_code", callback_url);
                                        let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Authorization complete</title></head><body style=\"background:#1a1a1a;color:#fff;text-align:center;padding:50px;font-family:sans-serif;\"><h1>Authorization complete</h1><p>Setsuna received the authorization code. You can close this tab.</p><script>window.close();</script></body></html>";
                                        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", html.len(), html).as_bytes());
                                        break;
                                    }
                                }
                            }
                        }
                        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        if let Ok(mut guard) = oauth_server_port_state().lock() {
            if *guard == Some(port) {
                *guard = None;
            }
        }
    });
    Ok(OAuthServerStart {
        port,
        redirect_uri: format!("http://127.0.0.1:{}", port),
        reused: false,
    })
}

#[tauri::command]
async fn delete_dictionary(app: tauri::AppHandle, dict_name: String) -> Result<(), String> {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM entries WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM frequencies WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM pitches WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM pronunciations WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM dictionary_meta WHERE title = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_dictionaries(app: tauri::AppHandle, dict_names: Vec<String>) -> Result<(), String> {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for dict_name in dict_names {
        tx.execute(
            "DELETE FROM entries WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM frequencies WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM pitches WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM pronunciations WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM dictionary_meta WHERE title = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn clear_database(app: tauri::AppHandle) -> Result<(), String> {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM entries", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM frequencies", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pitches", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pronunciations", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM dictionary_meta", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn manage_browser(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    action: String,
    id: String,
    url: String,
    x_offset: f64,
    y_offset: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut tabs = state.tabs.lock().unwrap_or_else(|e| e.into_inner());

    let main_win = app
        .get_webview_window("main")
        .ok_or("Main window was not found".to_string())?;

    let main_pos = main_win
        .inner_position()
        .or_else(|_| main_win.outer_position())
        .unwrap_or(tauri::PhysicalPosition::new(0, 0));

    let mut target_x = main_pos.x + x_offset.round() as i32;
    let mut target_y = main_pos.y + y_offset.round() as i32;
    let mut target_w = width.round() as u32;
    let mut target_h = height.round() as u32;

    if target_w < 280 {
        target_w = 280;
    }
    if target_h < 200 {
        target_h = 200;
    }

    if let Ok(Some(monitor)) = main_win.current_monitor() {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();

        let mon_x = mon_pos.x;
        let mon_y = mon_pos.y;
        let mon_w = mon_size.width as i32;
        let mon_h = mon_size.height as i32;

        let max_x = mon_x + mon_w - target_w as i32 - 8;
        let max_y = mon_y + mon_h - target_h as i32 - 8;

        if target_x < mon_x {
            target_x = mon_x;
        }
        if target_y < mon_y {
            target_y = mon_y;
        }
        if target_x > max_x {
            target_x = max_x;
        }
        if target_y > max_y {
            target_y = max_y;
        }
    } else {
        if target_x < 0 {
            target_x = 0;
        }
        if target_y < 0 {
            target_y = 0;
        }
    }

    let pos = tauri::PhysicalPosition::new(target_x, target_y);
    let size = tauri::PhysicalSize::new(target_w, target_h);

    let init_script = format!(
        r#"
    (() => {{
        const emitMeta = () => {{
            try {{
                let favicon = "";

                const iconEl = Array.from(document.querySelectorAll("link[rel]"))
                    .find((el) => /\b(icon|apple-touch-icon|shortcut icon)\b/i.test(el.getAttribute("rel") || ""));

                if (iconEl) {{
                    const href = iconEl.getAttribute("href");
                    if (href) {{
                        try {{
                            favicon = new URL(href, window.location.href).href;
                        }} catch (e) {{}}
                    }}
                }}

                if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {{
                    window.__TAURI__.core.invoke('emit_browser_meta', {{
                        id: '{}',
                        url: window.location.href,
                        title: (document.title || "").trim(),
                        favicon: favicon || (window.location.origin + '/favicon.ico')
                    }});
                }}
            }} catch (e) {{}}
        }};

        const emitSelection = () => {{
            try {{
                const sel = window.getSelection();
                const text = sel ? sel.toString().trim() : '';

                if (text && window.__TAURI__ && window.__TAURI__.event) {{
                    const rect = sel.getRangeAt(0).getBoundingClientRect();
                    window.__TAURI__.event.emit('browser_selection', {{
                        id: '{}',
                        text: text,
                        x: rect.right,
                        y: rect.bottom
                    }});
                }} else if (window.__TAURI__ && window.__TAURI__.event) {{
                    window.__TAURI__.event.emit('browser_selection_clear', {{
                        id: '{}'
                    }});
                }}
            }} catch (e) {{}}
        }};

        const wrapHistoryMethod = (name) => {{
            const original = history[name];
            history[name] = function (...args) {{
                const result = original.apply(this, args);
                setTimeout(emitMeta, 50);
                setTimeout(emitMeta, 300);
                return result;
            }};
        }};

        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');

        window.addEventListener('popstate', () => {{
            setTimeout(emitMeta, 50);
            setTimeout(emitMeta, 300);
        }});

        window.addEventListener('hashchange', () => {{
            setTimeout(emitMeta, 50);
            setTimeout(emitMeta, 300);
        }});

        window.addEventListener('DOMContentLoaded', () => {{
            setTimeout(emitMeta, 20);
            setTimeout(emitMeta, 200);
        }});

        window.addEventListener('load', () => {{
            setTimeout(emitMeta, 50);
            setTimeout(emitMeta, 300);
            setTimeout(emitMeta, 1000);
        }});

        const titleObserver = new MutationObserver(() => {{
            emitMeta();
        }});

        const observeHead = () => {{
            const titleEl = document.querySelector('title');
            if (titleEl) {{
                titleObserver.observe(titleEl, {{
                    childList: true,
                    subtree: true
                }});
            }}

            if (document.head) {{
                titleObserver.observe(document.head, {{
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['href', 'rel']
                }});
            }}
        }};

        observeHead();

        if (!document.head) {{
            document.addEventListener('DOMContentLoaded', observeHead, {{ once: true }});
        }}

        if (document.body) {{
            titleObserver.observe(document.body, {{
                childList: true,
                subtree: false
            }});
        }}

        document.addEventListener('mouseup', emitSelection);

        setInterval(emitMeta, 1500);
        setTimeout(emitMeta, 50);
        setTimeout(emitMeta, 300);
        setTimeout(emitMeta, 1000);
    }})();
    "#,
        id, id, id
    );

    match action.as_str() {
        "show" => {
            for (other_id, other_window) in tabs.iter() {
                if other_id != &id {
                    let _ = other_window.hide();
                }
            }

            if let Some(window) = tabs.get(&id) {
                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
            } else {
                let final_url = if url.trim().is_empty() {
                    "https://duckduckgo.com/".to_string()
                } else {
                    url.clone()
                };

                let webview_url = match final_url.parse() {
                    Ok(u) => WebviewUrl::External(u),
                    Err(_) => return Err(format!("Invalid URL: {}", final_url)),
                };

                let mut browser_builder = tauri::WebviewWindowBuilder::new(&app, &id, webview_url)
                    .title("txthk Browser")
                    .visible(false)
                    .focused(false)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .initialization_script(&init_script);

                if let Some(main_window) = app.get_webview_window("main") {
                    browser_builder = browser_builder
                        .parent(&main_window)
                        .map_err(|e| format!("Failed to attach browser window: {}", e))?;
                }

                let window = browser_builder
                    .build()
                    .map_err(|e| format!("Failed to create browser window: {}", e))?;

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();

                tabs.insert(id.clone(), window);
            }
        }

        "navigate" => {
            for (other_id, other_window) in tabs.iter() {
                if other_id != &id {
                    let _ = other_window.hide();
                }
            }

            if let Some(window) = tabs.get(&id) {
                if !url.is_empty() {
                    let safe_url = url.replace("\\", "\\\\").replace("'", "\\'");
                    let _ = window.eval(&format!("window.location.href = '{}';", safe_url));
                }

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
            } else {
                let final_url = if url.trim().is_empty() {
                    "https://duckduckgo.com/".to_string()
                } else {
                    url.clone()
                };

                let webview_url = match final_url.parse() {
                    Ok(u) => WebviewUrl::External(u),
                    Err(_) => return Err(format!("Invalid URL: {}", final_url)),
                };

                let mut browser_builder = tauri::WebviewWindowBuilder::new(&app, &id, webview_url)
                    .title("txthk Browser")
                    .visible(false)
                    .focused(false)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .initialization_script(&init_script);

                if let Some(main_window) = app.get_webview_window("main") {
                    browser_builder = browser_builder
                        .parent(&main_window)
                        .map_err(|e| format!("Failed to attach browser window: {}", e))?;
                }

                let window = browser_builder
                    .build()
                    .map_err(|e| format!("Failed to create browser window: {}", e))?;

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();

                tabs.insert(id.clone(), window);
            }
        }

        "resize" => {
            if let Some(window) = tabs.get(&id) {
                let _ = window.set_position(pos);
                let _ = window.set_size(size);
            }
        }

        "hide_all" => {
            for window in tabs.values() {
                let _ = window.hide();
            }
        }

        "hide" => {
            if let Some(window) = tabs.get(&id) {
                let _ = window.eval(
                    r#"
                    try {
                        document.querySelectorAll('video').forEach(v => {
                            try { v.pause(); } catch (e) {}
                        });
                        document.querySelectorAll('audio').forEach(a => {
                            try { a.pause(); } catch (e) {}
                        });
                    } catch (e) {}
                    "#,
                );
                let _ = window.hide();
            }
        }

        "close" => {
            if let Some(window) = tabs.remove(&id) {
                let _ = window.close();
            }
        }

        _ => return Err(format!("Unknown action: {}", action)),
    }

    Ok(())
}

#[tauri::command]
fn emit_browser_meta(app: AppHandle, id: String, url: String, title: String, favicon: String) {
    let _ = app.emit(
        "browser_meta",
        serde_json::json!({
            "id": id,
            "url": url,
            "title": title,
            "favicon": favicon
        }),
    );
}

#[tauri::command]
async fn get_browser_info(
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<(String, String)>, String> {
    let tabs = state.tabs.lock().unwrap_or_else(|e| e.into_inner());
    let mut info = Vec::new();

    for (id, window) in tabs.iter() {
        info.push((
            id.clone(),
            window.url().map(|u| u.to_string()).unwrap_or_default(),
        ));
    }

    Ok(info)
}

#[tauri::command]
async fn save_sync_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_sync_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_workspace_state(app: AppHandle, content: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("Invalid workspace state: {error}"))?;
    let path = get_data_path(&app, "workspace-state.json")?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");

    tokio::fs::write(&temporary, content)
        .await
        .map_err(|error| format!("Failed to write workspace state: {error}"))?;
    if path.exists() {
        let _ = tokio::fs::copy(&path, &backup).await;
        tokio::fs::remove_file(&path)
            .await
            .map_err(|error| format!("Failed to replace workspace state: {error}"))?;
    }
    if let Err(error) = tokio::fs::rename(&temporary, &path).await {
        if backup.exists() && !path.exists() {
            let _ = tokio::fs::copy(&backup, &path).await;
        }
        return Err(format!("Failed to save workspace state: {error}"));
    }
    Ok(())
}

#[tauri::command]
async fn load_workspace_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = get_data_path(&app, "workspace-state.json")?;
    let backup = path.with_extension("json.bak");
    for candidate in [path, backup] {
        let Ok(content) = tokio::fs::read_to_string(&candidate).await else {
            continue;
        };
        if serde_json::from_str::<Value>(&content).is_ok() {
            return Ok(Some(content));
        }
    }
    Ok(None)
}

fn emit_jl_mode_line(app: AppHandle, text: String) {
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    if app.get_webview_window("jl_mode").is_none() {
        return;
    }

    std::thread::spawn(move || {
        for delay in [30_u64, 120, 320, 700, 1400] {
            std::thread::sleep(Duration::from_millis(delay));
            if let Some(window) = app.get_webview_window("jl_mode") {
                let _ = window.emit("jl_mode_line", text.clone());
            } else {
                break;
            }
        }
    });
}

#[tauri::command]
fn set_jl_mode_line(
    app: AppHandle,
    state: State<'_, JlModeState>,
    text: String,
) -> Result<(), String> {
    let normalized = text.trim().to_string();
    {
        let mut last_line = state.last_line.lock().unwrap_or_else(|e| e.into_inner());
        *last_line = normalized.clone();
    }
    emit_jl_mode_line(app, normalized);
    Ok(())
}

#[tauri::command]
fn get_jl_mode_line(state: State<'_, JlModeState>) -> String {
    state
        .last_line
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
fn open_jl_mode_window(
    app: AppHandle,
    state: State<'_, JlModeState>,
    initial_text: Option<String>,
) -> Result<(), String> {
    const LABEL: &str = "jl_mode";
    let text_to_send = initial_text
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| {
            state
                .last_line
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        });

    if !text_to_send.trim().is_empty() {
        let mut last_line = state.last_line.lock().unwrap_or_else(|e| e.into_inner());
        *last_line = text_to_send.clone();
    }

    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if !text_to_send.trim().is_empty() {
            let _ = window.emit("jl_mode_line", text_to_send);
        }
        return Ok(());
    }

    append_diagnostics_line(
        &app,
        serde_json::json!({
            "ts": unix_time_ms(),
            "kind": "jl_backend",
            "event": "create_requested",
            "has_text": !text_to_send.trim().is_empty(),
            "text_len": text_to_send.chars().count(),
        }),
    );

    let app_for_load = app.clone();
    let text_for_load = text_to_send.clone();
    let window =
        tauri::WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("jl-window.html".into()))
            .title("Setsuna Flow")
            .visible(true)
            .focused(true)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .shadow(false)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(false)
            .inner_size(900.0, 190.0)
            .min_inner_size(180.0, 70.0)
            .on_page_load(move |window, payload| {
                append_diagnostics_line(
                    &app_for_load,
                    serde_json::json!({
                        "ts": unix_time_ms(),
                        "kind": "jl_backend",
                        "event": "page_load",
                        "url": window.url().map(|url| url.to_string()).unwrap_or_default(),
                        "payload": format!("{:?}", payload),
                    }),
                );
                let text = text_for_load.trim();
                if !text.is_empty() {
                    let _ = window.emit("jl_mode_line", text.to_string());
                }
            })
            .build()
            .map_err(|e| format!("Failed to create Setsuna Flow window: {}", e))?;

    let _ = window.set_always_on_top(true);
    append_diagnostics_line(
        &app,
        serde_json::json!({
            "ts": unix_time_ms(),
            "kind": "jl_backend",
            "event": "created",
            "url": window.url().map(|url| url.to_string()).unwrap_or_default(),
        }),
    );
    emit_jl_mode_line(app, text_to_send);
    Ok(())
}

#[tauri::command]
fn close_jl_mode_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("jl_mode") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("jl_lookup") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_jl_lookup_window(
    app: AppHandle,
    state: State<'_, JlLookupState>,
    payload: serde_json::Value,
    x: f64,
    y: f64,
) -> Result<(), String> {
    const LABEL: &str = "jl_lookup";
    let position = tauri::LogicalPosition::new(x.max(0.0), y.max(0.0));
    *state
        .payload
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(payload.clone());

    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_position(position);
        let _ = window.set_always_on_top(true);
        let _ = window.unminimize();
        let _ = window.show();
        window
            .emit("jl_lookup_result", payload)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let payload_for_load = payload.clone();
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("jl-popup.html".into()))
            .title("Setsuna Flow Lookup")
            .visible(true)
            .focused(false)
            .decorations(false)
            .transparent(false)
            .background_color(Color(24, 24, 24, 255))
            .shadow(true)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .position(position.x, position.y)
            .inner_size(520.0, 620.0)
            .min_inner_size(360.0, 260.0)
            .on_page_load(move |window, _| {
                let _ = window.emit("jl_lookup_result", payload_for_load.clone());
            });

    if let Some(owner) = app.get_webview_window("jl_mode") {
        builder = builder
            .parent(&owner)
            .map_err(|error| format!("Failed to attach Setsuna Flow lookup window: {error}"))?;
    }

    let window = builder
        .build()
        .map_err(|error| format!("Failed to create Setsuna Flow lookup window: {error}"))?;

    let _ = window.set_always_on_top(true);
    Ok(())
}

#[tauri::command]
fn get_jl_lookup_payload(state: State<'_, JlLookupState>) -> Option<Value> {
    state
        .payload
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

#[tauri::command]
fn hide_jl_lookup_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("jl_lookup") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn get_flow_timer_state(state: State<'_, FlowTimerState>) -> bool {
    state.paused.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_flow_timer_state(state: State<'_, FlowTimerState>, paused: bool) -> bool {
    state.paused.store(paused, Ordering::SeqCst);
    paused
}

#[tauri::command]
fn toggle_flow_timer(state: State<'_, FlowTimerState>) -> bool {
    !state.paused.fetch_xor(true, Ordering::SeqCst)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn prepare_jl_windows(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("jl_mode").is_none() {
        tauri::WebviewWindowBuilder::new(app, "jl_mode", WebviewUrl::App("jl-window.html".into()))
            .title("Setsuna Flow")
            .visible(false)
            .focused(false)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .shadow(false)
            .resizable(true)
            .always_on_top(true)
            .skip_taskbar(false)
            .inner_size(900.0, 190.0)
            .min_inner_size(180.0, 70.0)
            .build()
            .map_err(|error| format!("Failed to prepare Setsuna Flow window: {error}"))?;
    }

    if app.get_webview_window("jl_lookup").is_none() {
        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            "jl_lookup",
            WebviewUrl::App("jl-popup.html".into()),
        )
        .title("Setsuna Flow Lookup")
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(false)
        .background_color(Color(24, 24, 24, 255))
        .shadow(true)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(520.0, 620.0)
        .min_inner_size(360.0, 260.0);

        if let Some(owner) = app.get_webview_window("jl_mode") {
            builder = builder
                .parent(&owner)
                .map_err(|error| format!("Failed to attach Setsuna Flow lookup window: {error}"))?;
        }

        builder
            .build()
            .map_err(|error| format!("Failed to prepare Setsuna Flow lookup window: {error}"))?;
    }

    Ok(())
}

fn sanitize_main_window_size(main_win: &tauri::WebviewWindow) {
    const MIN_WIDTH: f64 = 480.0;
    const MIN_HEIGHT: f64 = 400.0;
    const FALLBACK_WIDTH: f64 = 1280.0;
    const FALLBACK_HEIGHT: f64 = 800.0;

    let _ = main_win.set_min_size(Some(tauri::LogicalSize::new(MIN_WIDTH, MIN_HEIGHT)));
    let monitors = main_win.available_monitors().unwrap_or_default();
    let monitor = main_win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());
    let scale = monitor.as_ref().map(|item| item.scale_factor()).unwrap_or(1.0);
    let physical_size = match main_win.inner_size() {
        Ok(size) => size,
        Err(_) => return,
    };
    let logical_size = physical_size.to_logical::<f64>(scale);
    let monitor_logical = monitor
        .as_ref()
        .map(|item| item.size().to_logical::<f64>(item.scale_factor()));
    let max_width = monitor_logical
        .map(|size| (size.width - 32.0).max(MIN_WIDTH))
        .unwrap_or(3840.0);
    let max_height = monitor_logical
        .map(|size| (size.height - 48.0).max(MIN_HEIGHT))
        .unwrap_or(2160.0);

    let width = if logical_size.width < 100.0 {
        FALLBACK_WIDTH.min(max_width)
    } else {
        logical_size.width.clamp(MIN_WIDTH, max_width)
    };
    let height = if logical_size.height < 100.0 {
        FALLBACK_HEIGHT.min(max_height)
    } else {
        logical_size.height.clamp(MIN_HEIGHT, max_height)
    };
    if (width - logical_size.width).abs() > 0.5 || (height - logical_size.height).abs() > 0.5 {
        let _ = main_win.set_size(tauri::LogicalSize::new(width, height));
    }

    let is_visible = match (main_win.outer_position(), main_win.outer_size()) {
        (Ok(position), Ok(size)) => monitors.iter().any(|item| {
            let monitor_position = item.position();
            let monitor_size = item.size();
            let left = i64::from(position.x).max(i64::from(monitor_position.x));
            let top = i64::from(position.y).max(i64::from(monitor_position.y));
            let right = (i64::from(position.x) + i64::from(size.width))
                .min(i64::from(monitor_position.x) + i64::from(monitor_size.width));
            let bottom = (i64::from(position.y) + i64::from(size.height))
                .min(i64::from(monitor_position.y) + i64::from(monitor_size.height));
            right - left >= 80 && bottom - top >= 60
        }),
        _ => true,
    };
    if !is_visible {
        let _ = main_win.center();
    }
}

#[tauri::command]
async fn get_data_file_path(app: AppHandle, filename: String) -> Result<String, String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid data filename".to_string());
    }
    if filename == "dictionary.db" {
        return get_dictionary_db_path(&app).map(|path| path.to_string_lossy().to_string());
    }
    get_data_path(&app, &filename).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| e.to_string())
}

fn presence_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

fn close_discord_runtime(runtime: &mut Option<DiscordPresenceRuntime>) {
    if let Some(mut old) = runtime.take() {
        let _ = old.client.close();
    }
}

fn clear_discord_runtime_mutex(
    runtime: &Mutex<Option<DiscordPresenceRuntime>>,
) -> Result<(), String> {
    let mut runtime = runtime.lock().map_err(|e| e.to_string())?;
    close_discord_runtime(&mut runtime);
    Ok(())
}

fn clear_discord_runtime(state: &DiscordPresenceState) -> Result<(), String> {
    clear_discord_runtime_mutex(&state.runtime)
}

#[tauri::command]
async fn clear_discord_presence(
    state: tauri::State<'_, DiscordPresenceState>,
) -> Result<(), String> {
    let runtime = Arc::clone(&state.runtime);
    tauri::async_runtime::spawn_blocking(move || clear_discord_runtime_mutex(&runtime))
        .await
        .map_err(|e| format!("Discord RPC task failed: {}", e))?
}

fn update_discord_presence_blocking(
    payload: DiscordPresencePayload,
    runtime: &Mutex<Option<DiscordPresenceRuntime>>,
) -> Result<(), String> {
    let client_id = payload.client_id.trim().to_string();
    let mut runtime = runtime.lock().map_err(|e| e.to_string())?;

    if !payload.enabled || client_id.is_empty() {
        close_discord_runtime(&mut runtime);
        return Ok(());
    }

    let needs_connect = runtime
        .as_ref()
        .map(|current| current.client_id != client_id)
        .unwrap_or(true);

    if needs_connect {
        close_discord_runtime(&mut runtime);
        let mut client = DiscordIpcClient::new(&client_id);
        client
            .connect()
            .map_err(|e| format!("Discord RPC connect failed: {}", e))?;
        *runtime = Some(DiscordPresenceRuntime {
            client_id: client_id.clone(),
            client,
        });
    }

    let activity_type = match payload.activity_type.as_str() {
        "watching" => activity::ActivityType::Watching,
        "listening" => activity::ActivityType::Listening,
        "competing" => activity::ActivityType::Competing,
        _ => activity::ActivityType::Playing,
    };

    let mut presence = activity::Activity::new()
        .activity_type(activity_type)
        .details(presence_text(&payload.details, 128))
        .state(presence_text(&payload.state, 128));

    if let Some(start) = payload.start_timestamp_ms {
        presence = presence.timestamps(activity::Timestamps::new().start(start));
    }

    let large_image = payload.large_image.unwrap_or_default();
    let small_image = payload.small_image.unwrap_or_default();
    if !large_image.trim().is_empty() || !small_image.trim().is_empty() {
        let mut assets = activity::Assets::new();
        if !large_image.trim().is_empty() {
            assets = assets
                .large_image(presence_text(&large_image, 256))
                .large_text(presence_text(
                    payload.large_text.as_deref().unwrap_or("Setsuna"),
                    128,
                ));
        }
        if !small_image.trim().is_empty() {
            assets = assets
                .small_image(presence_text(&small_image, 256))
                .small_text(presence_text(
                    payload.small_text.as_deref().unwrap_or("Reading"),
                    128,
                ));
        }
        presence = presence.assets(assets);
    }

    let mut buttons = Vec::new();
    if let (Some(label), Some(url)) = (payload.button_label, payload.button_url) {
        if !label.trim().is_empty() && !url.trim().is_empty() {
            buttons.push(activity::Button::new(
                presence_text(&label, 32),
                presence_text(&url, 512),
            ));
        }
    }
    if let (Some(label), Some(url)) = (payload.second_button_label, payload.second_button_url) {
        if !label.trim().is_empty() && !url.trim().is_empty() {
            buttons.push(activity::Button::new(
                presence_text(&label, 32),
                presence_text(&url, 512),
            ));
        }
    }
    if !buttons.is_empty() {
        presence = presence.buttons(buttons);
    }

    let Some(current) = runtime.as_mut() else {
        return Err("Discord RPC client is not connected".to_string());
    };
    if let Err(e) = current.client.set_activity(presence) {
        close_discord_runtime(&mut runtime);
        return Err(format!("Discord RPC update failed: {}", e));
    }

    Ok(())
}

fn is_kanji(c: &char) -> bool {
    (*c >= '\u{4e00}' && *c <= '\u{9faf}') || (*c >= '\u{3400}' && *c <= '\u{4dbf}')
}

fn is_valid_chunk(chars: &[char]) -> bool {
    let mut seen_kana = false;

    for &c in chars {
        let kana = (c >= '\u{3040}' && c <= '\u{309f}') || (c >= '\u{30a0}' && c <= '\u{30ff}');

        if kana {
            seen_kana = true;
        } else if is_kanji(&c) && seen_kana {
            return false;
        }
    }

    true
}

fn split_furigana(term: &str, reading: &str) -> Vec<TextToken> {
    let term_chars: Vec<char> = term.chars().collect();
    let read_chars: Vec<char> = reading.chars().collect();
    let mut pre = 0;
    while pre < term_chars.len() && pre < read_chars.len() && term_chars[pre] == read_chars[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < term_chars.len() - pre
        && suf < read_chars.len() - pre
        && term_chars[term_chars.len() - 1 - suf] == read_chars[read_chars.len() - 1 - suf]
    {
        suf += 1;
    }
    let mut res = Vec::new();
    if pre > 0 {
        res.push(TextToken {
            text: term_chars[..pre].iter().collect(),
            reading: None,
        });
    }
    let stem_term: String = term_chars[pre..term_chars.len() - suf].iter().collect();
    let stem_read: String = read_chars[pre..read_chars.len() - suf].iter().collect();
    if !stem_term.is_empty() {
        if stem_term == stem_read {
            res.push(TextToken {
                text: stem_term,
                reading: None,
            });
        } else {
            res.push(TextToken {
                text: stem_term,
                reading: Some(stem_read),
            });
        }
    }
    if suf > 0 {
        res.push(TextToken {
            text: term_chars[term_chars.len() - suf..].iter().collect(),
            reading: None,
        });
    }
    res
}

fn contextual_suffix_reading(suffix: &str) -> Option<&'static str> {
    match suffix {
        "\u{5185}" => Some("\u{306A}\u{3044}"),
        "\u{5916}" => Some("\u{304C}\u{3044}"),
        "\u{4E2D}" => Some("\u{3061}\u{3085}\u{3046}"),
        "\u{9593}" => Some("\u{304B}\u{3093}"),
        "\u{524D}" => Some("\u{307E}\u{3048}"),
        "\u{5F8C}" => Some("\u{3054}"),
        "\u{4E0A}" => Some("\u{3058}\u{3087}\u{3046}"),
        "\u{4E0B}" => Some("\u{304B}"),
        "\u{7684}" => Some("\u{3066}\u{304D}"),
        "\u{5316}" => Some("\u{304B}"),
        "\u{6027}" => Some("\u{305B}\u{3044}"),
        "\u{7528}" => Some("\u{3088}\u{3046}"),
        "\u{8005}" => Some("\u{3057}\u{3083}"),
        "\u{529B}" => Some("\u{308A}\u{3087}\u{304F}"),
        "\u{7387}" => Some("\u{308A}\u{3064}"),
        "\u{5074}" => Some("\u{304C}\u{308F}"),
        "\u{6BCE}" => Some("\u{3054}\u{3068}"),
        "\u{5225}" => Some("\u{3079}\u{3064}"),
        "\u{7D1A}" => Some("\u{304D}\u{3085}\u{3046}"),
        "\u{5F0F}" => Some("\u{3057}\u{304D}"),
        "\u{7248}" => Some("\u{3070}\u{3093}"),
        "\u{88FD}" => Some("\u{305B}\u{3044}"),
        "\u{6E08}" => Some("\u{305A}\u{307F}"),
        "\u{540C}\u{58EB}" => Some("\u{3069}\u{3046}\u{3057}"),
        "\u{8FBC}\u{307F}" => Some("\u{3053}\u{307F}"),
        "\u{4ED8}\u{304D}" => Some("\u{3064}\u{304D}"),
        "\u{5411}\u{3051}" => Some("\u{3080}\u{3051}"),
        "\u{5BA4}" => Some("\u{3057}\u{3064}"),
        _ => None,
    }
}

fn has_kanji(text: &str) -> bool {
    text.chars().any(|c| is_kanji(&c))
}

fn is_english_word_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
}

fn is_english_word_connector(c: char) -> bool {
    matches!(
        c,
        '\'' | '\u{2019}' | '-' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}'
    )
}

fn is_english_word_inner(c: char) -> bool {
    is_english_word_letter(c) || is_english_word_connector(c)
}

fn is_english_lookup_word(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || !chars.iter().any(|c| is_english_word_letter(*c)) {
        return false;
    }
    for (index, c) in chars.iter().enumerate() {
        if is_english_word_letter(*c) {
            continue;
        }
        if is_english_word_connector(*c)
            && index > 0
            && index + 1 < chars.len()
            && is_english_word_letter(chars[index - 1])
            && is_english_word_letter(chars[index + 1])
        {
            continue;
        }
        return false;
    }
    true
}

fn english_token_bounds(chars: &[char], cursor: usize) -> Option<(usize, usize)> {
    if chars.is_empty() {
        return None;
    }
    let cursor = std::cmp::min(cursor, chars.len().saturating_sub(1));
    if !is_english_word_inner(chars[cursor]) {
        return None;
    }

    let mut start = cursor;
    while start > 0 && is_english_word_inner(chars[start - 1]) {
        start -= 1;
    }

    let mut end = cursor + 1;
    while end < chars.len() && is_english_word_inner(chars[end]) {
        end += 1;
    }

    while start < end && !is_english_word_letter(chars[start]) {
        start += 1;
    }
    while end > start && !is_english_word_letter(chars[end - 1]) {
        end -= 1;
    }

    if start >= end {
        return None;
    }
    let word: String = chars[start..end].iter().collect();
    if is_english_lookup_word(&word) {
        Some((start, end - start))
    } else {
        None
    }
}

fn english_token_near_cursor(text: &str, cursor: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let cursor = cursor.min(chars.len().saturating_sub(1));
    let max_distance = std::cmp::min(24, chars.len().saturating_sub(1));

    for distance in 0..=max_distance {
        let probes = if distance == 0 {
            vec![cursor]
        } else {
            let mut values = Vec::with_capacity(2);
            if cursor >= distance {
                values.push(cursor - distance);
            }
            if cursor + distance < chars.len() {
                values.push(cursor + distance);
            }
            values
        };

        for probe in probes {
            if let Some((start, len)) = english_token_bounds(&chars, probe) {
                return Some(chars[start..start + len].iter().collect());
            }
        }
    }
    None
}

fn is_lookup_punctuation(c: char) -> bool {
    matches!(
        c,
        ' ' | '\n'
            | '\r'
            | '\t'
            | '\u{3000}'
            | '\u{3002}'
            | '\u{3001}'
            | '\u{FF0C}'
            | '\u{FF0E}'
            | '\u{FF01}'
            | '\u{FF1F}'
            | '\u{300C}'
            | '\u{300D}'
            | '\u{300E}'
            | '\u{300F}'
            | '\u{FF08}'
            | '\u{FF09}'
            | '('
            | ')'
            | '['
            | ']'
            | '\u{300A}'
            | '\u{300B}'
    )
}

fn is_japanese_lookup_char(c: char) -> bool {
    is_kanji(&c)
        || ('\u{3040}'..='\u{309f}').contains(&c)
        || ('\u{30a0}'..='\u{30ff}').contains(&c)
        || matches!(c, '\u{3005}' | '\u{30fc}' | '\u{30fd}' | '\u{30fe}')
}

fn is_hiragana_char(c: char) -> bool {
    ('\u{3040}'..='\u{309f}').contains(&c)
}

fn is_kana_lookup_char(c: char) -> bool {
    is_hiragana_char(c) || is_katakana_char(c) || c == '\u{30fc}'
}

fn is_kana_only_lookup(text: &str) -> bool {
    let mut has_kana = false;
    for c in text.chars() {
        if is_kana_lookup_char(c) {
            has_kana = true;
            continue;
        }
        return false;
    }
    has_kana
}

fn common_prefix_char_count(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(left, right)| left == right)
        .count()
}

fn entry_tags_allow_deinflection(tags: &str) -> bool {
    if tags.trim().is_empty() {
        return true;
    }

    tags.to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '|')
        .any(|tag| {
            tag.starts_with("v1")
                || tag.starts_with("v5")
                || matches!(
                    tag,
                    "vk" | "vn"
                        | "vr"
                        | "vs"
                        | "vs-i"
                        | "vs-s"
                        | "vz"
                        | "vi"
                        | "vt"
                        | "aux-v"
                        | "adj-i"
                        | "adj-ix"
                        | "aux-adj"
                        | "cop"
                )
        })
}

fn split_entry_tags(tags: &str) -> Vec<String> {
    tags.to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '|')
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.to_string())
        .collect()
}

fn tags_contain_prefix(tags: &[String], prefix: &str) -> bool {
    tags.iter().any(|tag| {
        tag == prefix
            || tag
                .strip_prefix(prefix)
                .map(|rest| {
                    rest.starts_with('-')
                        || rest
                            .chars()
                            .next()
                            .map(|c| c.is_ascii_digit())
                            .unwrap_or(false)
                })
                .unwrap_or(false)
            || (prefix == "v5" && tag.starts_with("v5"))
    })
}

fn required_tags_for_deinflection_step(in_s: &str, out_s: &str) -> Vec<&'static str> {
    if out_s.is_empty() || out_s == "ます" || out_s == "ない" || out_s == "て" || out_s == "で"
    {
        return Vec::new();
    }

    if out_s.ends_with("する") || out_s.ends_with("為る") {
        return vec!["vs"];
    }
    if out_s.ends_with("ずる") {
        return vec!["vz"];
    }
    if out_s.ends_with("くる") || out_s.ends_with("来る") || out_s.ends_with("來る") {
        return vec!["vk"];
    }

    match out_s {
        "う" => vec!["v5u"],
        "く" => vec!["v5k"],
        "ぐ" => vec!["v5g"],
        "す" => vec!["v5s"],
        "つ" => vec!["v5t"],
        "ぬ" => vec!["v5n"],
        "ぶ" => vec!["v5b"],
        "む" => vec!["v5m"],
        "る" => {
            if matches!(in_s, "った" | "って" | "らない" | "ります" | "れ" | "ろう") {
                vec!["v5r"]
            } else if matches!(in_s, "た" | "て" | "ない" | "ます" | "ません" | "ました")
            {
                vec!["v1"]
            } else {
                vec!["v1", "v5r", "vk", "vs", "vz"]
            }
        }
        "い" => vec!["adj-i", "adj-ix", "aux-adj"],
        _ => Vec::new(),
    }
}

fn deinflection_reasons_match_tags(reasons: &[DeinflectReason], tags: &str) -> bool {
    let tags = split_entry_tags(tags);
    if tags.is_empty() {
        return true;
    }

    for reason in reasons {
        let required = required_tags_for_deinflection_step(&reason.in_suffix, &reason.out_suffix);
        if required.is_empty() {
            continue;
        }
        if !required
            .iter()
            .any(|required_tag| tags_contain_prefix(&tags, required_tag))
        {
            return false;
        }
    }

    true
}

fn deinflected_kana_match_is_plausible(surface: &str, term: &str, reading: &str) -> bool {
    if !is_kana_only_lookup(surface) {
        return true;
    }

    let surface_kana = kata_to_hira(surface);
    let candidate = if reading.trim().is_empty() {
        term
    } else {
        reading
    };
    let candidate_kana = kata_to_hira(candidate);
    let surface_len = surface_kana.chars().count();
    let candidate_len = candidate_kana.chars().count();
    let common_prefix = common_prefix_char_count(&surface_kana, &candidate_kana);

    if surface_len >= 4 && candidate_len <= 2 && common_prefix < 2 {
        return false;
    }

    true
}

fn deinflected_surface_rank(entry: &DictEntry, surface: &str) -> i32 {
    if entry.deinflection_reasons.is_empty() {
        return 0;
    }

    let candidate = if entry.reading.trim().is_empty() {
        &entry.term
    } else {
        &entry.reading
    };
    let surface_kana = kata_to_hira(surface);
    let candidate_kana = kata_to_hira(candidate);
    let common_prefix = common_prefix_char_count(&surface_kana, &candidate_kana);
    let candidate_len = candidate_kana.chars().count();
    let surface_len = surface_kana.chars().count();
    let near_full_prefix =
        candidate_len > 0 && common_prefix + 1 >= std::cmp::min(surface_len, candidate_len);

    let similarity_rank = if near_full_prefix {
        1
    } else if common_prefix >= 2 {
        2
    } else if common_prefix == 1 {
        4
    } else {
        6
    };

    similarity_rank + entry.deinflection_reasons.len() as i32
}

fn is_lookup_digit(c: char) -> bool {
    c.is_ascii_digit() || ('\u{ff10}'..='\u{ff19}').contains(&c)
}

fn numeric_prefix_len(chars: &[char]) -> usize {
    let mut len = 0;
    while len < chars.len() && is_lookup_digit(chars[len]) {
        len += 1;
    }

    if len > 0 && len < chars.len() && is_japanese_lookup_char(chars[len]) {
        len
    } else {
        0
    }
}

fn is_common_japanese_particle(c: char) -> bool {
    matches!(
        c,
        '\u{3092}' // を
            | '\u{304C}' // が
            | '\u{306F}' // は
            | '\u{306B}' // に
            | '\u{3078}' // へ
            | '\u{3067}' // で
            | '\u{3068}' // と
            | '\u{306E}' // の
            | '\u{3082}' // も
    )
}

fn scan_start_candidates(chars: &[char], cursor: usize) -> Vec<usize> {
    let cursor_char = chars.get(cursor).copied().unwrap_or('\0');
    let mut starts = vec![cursor];
    if is_lookup_punctuation(cursor_char) {
        return starts;
    }

    let cursor_is_japanese = is_japanese_lookup_char(cursor_char);
    for offset in 1..LOOKUP_MAX_SCAN_CHARS {
        let Some(start) = cursor.checked_sub(offset) else {
            break;
        };

        let between = &chars[start + 1..=cursor];
        if between.iter().any(|c| is_lookup_punctuation(*c)) {
            break;
        }

        if cursor_is_japanese && is_common_japanese_particle(chars[start]) {
            break;
        }

        starts.push(start);
    }
    starts
}

fn scan_start_boundary_penalty(chars: &[char], start: usize, cursor: usize) -> u8 {
    if start >= cursor || cursor == 0 {
        return 0;
    }

    let cursor_char = chars.get(cursor).copied().unwrap_or('\0');
    let prev_char = chars.get(cursor - 1).copied().unwrap_or('\0');
    if is_kanji(&cursor_char) && (is_hiragana_char(prev_char) || is_katakana_char(prev_char)) {
        return 1;
    }

    let mut saw_kanji_before_kana = false;
    for idx in start..=cursor {
        let c = chars[idx];
        if is_kanji(&c) {
            if idx > start && saw_kanji_before_kana && chars[idx - 1] == '\u{3044}' {
                return 1;
            }
            saw_kanji_before_kana = true;
        }
    }

    0
}

fn scan_end_boundary_penalty(chars: &[char], start: usize, len: usize, cursor: usize) -> u8 {
    if len == 0 {
        return 3;
    }
    let end = start + len;
    if end <= cursor {
        return 3;
    }
    if end < chars.len() {
        let tail: String = chars[end..std::cmp::min(chars.len(), end + 8)]
            .iter()
            .collect();
        if [
            "\u{307E}\u{3059}",
            "\u{307E}\u{3057}\u{305F}",
            "\u{307E}\u{305B}\u{3093}",
            "\u{307E}\u{3057}\u{3087}\u{3046}",
        ]
        .iter()
        .any(|suffix| tail.starts_with(suffix))
        {
            return 2;
        }

        let next = chars[end];
        if is_common_japanese_particle(next) {
            return 0;
        }
        if is_hiragana_char(next) && chars[start..end].iter().any(|c| is_kanji(c)) {
            return 1;
        }
    }
    let last = chars.get(end - 1).copied().unwrap_or('\0');
    if end - 1 > cursor && is_common_japanese_particle(last) {
        return 3;
    }
    if end - 1 > cursor
        && is_hiragana_char(last)
        && chars[start..end - 1].iter().any(|c| is_kanji(c))
        && !matches!(
            last,
            '\u{3044}'
                | '\u{3046}'
                | '\u{304F}'
                | '\u{3059}'
                | '\u{305F}'
                | '\u{3060}'
                | '\u{3066}'
                | '\u{306A}'
                | '\u{308B}'
        )
    {
        return 1;
    }
    0
}

fn scan_entry_morphology_cost(entry: &DictEntry, surface: &str) -> usize {
    if !entry.deinflection_reasons.is_empty() {
        return entry.deinflection_reasons.len();
    }

    let normalized_surface = kata_to_hira(surface);
    let literal_term = kata_to_hira(&entry.term) == normalized_surface;
    let literal_reading =
        !entry.reading.trim().is_empty() && kata_to_hira(&entry.reading) == normalized_surface;
    if literal_term || literal_reading {
        0
    } else {
        // lookup_forms also creates stem/base variants (for example 行い -> 行う).
        // Treat that implicit conversion like one deinflection step during scanning.
        1
    }
}

fn is_katakana_char(c: char) -> bool {
    ('\u{30a0}'..='\u{30ff}').contains(&c) || c == '\u{30fc}'
}

fn is_plain_katakana_lookup(text: &str) -> bool {
    let mut has_katakana = false;
    for c in text.chars() {
        if is_katakana_char(c) {
            has_katakana = true;
            continue;
        }
        return false;
    }
    has_katakana
}

fn keep_literal_kana_entries(entries: Vec<DictEntry>, query: &str) -> Vec<DictEntry> {
    let normalized_query = kata_to_hira(query);
    let mut literal_surface_entries = Vec::new();
    let mut fallback_entries = Vec::new();

    for entry in entries {
        if is_kana_only_lookup(&entry.term) && kata_to_hira(&entry.term) == normalized_query {
            literal_surface_entries.push(entry);
        } else {
            fallback_entries.push(entry);
        }
    }

    if literal_surface_entries.is_empty() {
        fallback_entries
    } else {
        literal_surface_entries
    }
}

fn lookup_numeric_prefix_fallback<'a>(
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    chars: &[char],
    rules: &Vec<(Value, Value, String, String)>,
    source_len: usize,
    max_depth: usize,
) -> Vec<DictEntry> {
    let prefix_len = numeric_prefix_len(chars);
    if prefix_len == 0 {
        return Vec::new();
    }

    let suffix_chars = &chars[prefix_len..];
    if suffix_chars.len() < 2 && !suffix_chars.iter().any(is_kanji) {
        return Vec::new();
    }

    let suffix: String = suffix_chars.iter().collect();
    internal_lookup(
        freq_stmt,
        pitch_stmt,
        pronunciation_stmt,
        stmt,
        &suffix,
        rules,
        source_len,
        max_depth,
    )
}

fn lookup_furigana_reading_candidates(
    stmt: &mut rusqlite::Statement<'_>,
    term: &str,
) -> Vec<String> {
    let Ok(rows) = stmt.query_map(params![term], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten()
        .filter(|reading| !reading.is_empty())
        .collect()
}

fn lookup_furigana_reading(stmt: &mut rusqlite::Statement<'_>, term: &str) -> Option<String> {
    lookup_furigana_reading_candidates(stmt, term)
        .into_iter()
        .next()
}

#[cfg(test)]
fn lookup_furigana_reading_prefer(
    stmt: &mut rusqlite::Statement<'_>,
    term: &str,
    preferred: Option<&str>,
) -> Option<String> {
    let candidates = lookup_furigana_reading_candidates(stmt, term);
    if let Some(preferred) = preferred.filter(|value| !value.is_empty()) {
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.as_str() == preferred)
        {
            return Some(candidate.clone());
        }
    }
    candidates.into_iter().next()
}

fn lookup_deinflected_furigana(
    stmt: &mut rusqlite::Statement<'_>,
    deinflect_rules: &[(String, String)],
    term: &str,
) -> Option<String> {
    for (in_s, out_s) in deinflect_rules {
        if term.ends_with(in_s) {
            let mut new_term = term[..term.len() - in_s.len()].to_string();
            new_term.push_str(out_s);

            if let Some(base_read) = lookup_furigana_reading(stmt, &new_term) {
                if base_read.ends_with(out_s) {
                    let mut conj_read = base_read[..base_read.len() - out_s.len()].to_string();
                    conj_read.push_str(in_s);
                    return Some(conj_read);
                }
            }
        }
    }

    None
}

fn contextual_furigana_tokens(
    stmt: &mut rusqlite::Statement<'_>,
    deinflect_rules: &[(String, String)],
    chars: &[char],
) -> Option<Vec<TextToken>> {
    if chars.len() < 2 {
        return None;
    }

    let max_suffix_len = std::cmp::min(3, chars.len() - 1);
    for suffix_len in (1..=max_suffix_len).rev() {
        let prefix_chars = &chars[..chars.len() - suffix_len];
        let suffix: String = chars[chars.len() - suffix_len..].iter().collect();
        let Some(suffix_reading) = contextual_suffix_reading(&suffix) else {
            continue;
        };

        let prefix: String = prefix_chars.iter().collect();
        if prefix_chars.len() < 2 || !has_kanji(&prefix) || !is_valid_chunk(prefix_chars) {
            continue;
        }

        let prefix_reading = lookup_furigana_reading(stmt, &prefix)
            .or_else(|| lookup_deinflected_furigana(stmt, deinflect_rules, &prefix));

        if let Some(prefix_reading) = prefix_reading {
            if prefix_reading.is_empty() {
                continue;
            }

            let mut tokens = split_furigana(&prefix, &prefix_reading);
            tokens.push(TextToken {
                text: suffix,
                reading: Some(suffix_reading.to_string()),
            });
            return Some(tokens);
        }
    }

    None
}

#[tauri::command]
async fn get_furigana(
    app: tauri::AppHandle,
    text: String,
    context_before: Option<String>,
    context_after: Option<String>,
) -> Result<Vec<TextToken>, String> {
    let db = open_db(&app)?;
    let before = context_before.unwrap_or_default();
    let after = context_after.unwrap_or_default();

    if before.is_empty() && after.is_empty() {
        return build_furigana_tokens(&db, &text);
    }

    let before_tail: String = before
        .chars()
        .rev()
        .take(48)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let after_head: String = after.chars().take(48).collect();
    let combined = format!("{}{}{}", before_tail, text, after_head);
    let start = before_tail.chars().count();
    let len = text.chars().count();
    let combined_tokens = build_furigana_tokens(&db, &combined)?;

    Ok(slice_furigana_tokens(&combined_tokens, start, len))
}

fn build_furigana_tokens(db: &Connection, text: &str) -> Result<Vec<TextToken>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let rules = load_rules();
    let mut deinflect_rules = Vec::new();
    for (_, _, in_s, out_s) in rules {
        deinflect_rules.push((in_s, out_s));
    }
    let mut stmt = db.prepare("SELECT reading FROM entries WHERE term = ?1 AND reading != term AND reading NOT LIKE '% %' AND reading NOT LIKE '%.%' AND dict_name NOT LIKE '%kanji%' COLLATE NOCASE ORDER BY (SELECT value FROM frequencies WHERE frequencies.term = entries.term AND (frequencies.reading = entries.reading OR frequencies.reading = '') LIMIT 1) ASC NULLS LAST LIMIT 8").map_err(|e| e.to_string())?;

    while i < chars.len() {
        if !is_kanji(&chars[i]) {
            let mut j = i;
            while j < chars.len() && !is_kanji(&chars[j]) {
                j += 1;
            }
            tokens.push(TextToken {
                text: chars[i..j].iter().collect(),
                reading: None,
            });
            i = j;
            continue;
        }
        let mut found = false;
        for len in (1..=std::cmp::min(8, chars.len() - i)).rev() {
            let sub_chars = &chars[i..i + len];
            if !is_valid_chunk(sub_chars) {
                continue;
            }
            let sub: String = sub_chars.iter().collect();

            if let Some(reading) = lookup_furigana_reading(&mut stmt, &sub)
                .or_else(|| lookup_deinflected_furigana(&mut stmt, &deinflect_rules, &sub))
            {
                if !reading.is_empty() {
                    let mut split_toks = split_furigana(&sub, &reading);
                    tokens.append(&mut split_toks);
                    i += len;
                    found = true;
                    break;
                }
            }

            if let Some(mut contextual_tokens) =
                contextual_furigana_tokens(&mut stmt, &deinflect_rules, sub_chars)
            {
                tokens.append(&mut contextual_tokens);
                i += len;
                found = true;
                break;
            }
        }
        if !found {
            tokens.push(TextToken {
                text: chars[i].to_string(),
                reading: None,
            });
            i += 1;
        }
    }
    Ok(tokens)
}

fn slice_furigana_tokens(tokens: &[TextToken], start: usize, len: usize) -> Vec<TextToken> {
    let end = start + len;
    let mut pos = 0;
    let mut sliced = Vec::new();

    for token in tokens {
        let token_len = token.text.chars().count();
        let token_start = pos;
        let token_end = pos + token_len;
        pos = token_end;

        if token_end <= start || token_start >= end {
            continue;
        }

        let local_start = start.saturating_sub(token_start);
        let local_end = std::cmp::min(token_len, end.saturating_sub(token_start));
        let text: String = token
            .text
            .chars()
            .skip(local_start)
            .take(local_end.saturating_sub(local_start))
            .collect();

        if !text.is_empty() {
            sliced.push(TextToken {
                text,
                reading: token.reading.clone(),
            });
        }
    }

    sliced
}

fn internal_lookup<'a>(
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    word: &str,
    rules: &Vec<(Value, Value, String, String)>,
    source_len: usize,
    max_depth: usize,
) -> Vec<DictEntry> {
    let mut all_results = Vec::new();
    let mut terms_found = HashSet::new();
    let mut queue: VecDeque<(String, Vec<DeinflectReason>, usize)> = VecDeque::new();
    queue.push_back((word.to_string(), vec![], 0));
    let mut visited = HashSet::new();
    let mut expanded = 0usize;

    while let Some((current_term, current_reasons, depth)) = queue.pop_front() {
        if visited.contains(&current_term) {
            continue;
        }
        visited.insert(current_term.clone());
        expanded += 1;
        if expanded > 48 {
            break;
        }
        let forms = lookup_forms(&current_term);

        let mut raw_entries: Vec<(String, String, String, String, String)> = Vec::new();
        if let Ok(rows) = stmt.query_map(
            params![
                &forms[0], &forms[1], &forms[2], &forms[3], &forms[4], &forms[5], &forms[6],
                &forms[7]
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                    row.get::<_, String>(4).unwrap_or_default(),
                ))
            },
        ) {
            for row in rows.flatten() {
                raw_entries.push(row);
            }
        }

        if !raw_entries.is_empty() {
            for (term, reading, definition, dict_name, tags) in raw_entries {
                if !current_reasons.is_empty() && !entry_tags_allow_deinflection(&tags) {
                    continue;
                }
                if !current_reasons.is_empty()
                    && !deinflection_reasons_match_tags(&current_reasons, &tags)
                {
                    continue;
                }
                if !current_reasons.is_empty()
                    && !deinflected_kana_match_is_plausible(word, &term, &reading)
                {
                    continue;
                }

                let mut valid_freqs = Vec::new();
                if let Ok(f_rows) = freq_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, i64>(2).unwrap_or_default(),
                    ))
                }) {
                    for f in f_rows.flatten() {
                        valid_freqs.push(FrequencyData {
                            dict_name: f.0,
                            display_value: f.1,
                            value: f.2,
                        });
                    }
                }

                let mut valid_pitches = Vec::new();
                if let Ok(p_rows) = pitch_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, i64>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                    ))
                }) {
                    for p in p_rows.flatten() {
                        valid_pitches.push(PitchData {
                            dict_name: p.0,
                            reading: p.2,
                            position: p.1,
                        });
                    }
                }

                let mut valid_pronunciations = Vec::new();
                if let Ok(rows) = pronunciation_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                        row.get::<_, String>(3).unwrap_or_default(),
                    ))
                }) {
                    for pronunciation in rows.flatten() {
                        valid_pronunciations.push(PronunciationData {
                            dict_name: pronunciation.0,
                            reading: pronunciation.1,
                            ipa: pronunciation.2,
                            tags: pronunciation.3,
                        });
                    }
                }

                let entry = DictEntry {
                    term,
                    reading,
                    definition,
                    dict_name,
                    tags,
                    deinflection_reasons: current_reasons.clone(),
                    frequencies: valid_freqs,
                    pitches: valid_pitches,
                    pronunciations: valid_pronunciations,
                    source_length: source_len,
                };
                let uniq_key = format!(
                    "{}|{}|{}|{}|{}",
                    entry.term, entry.reading, entry.dict_name, entry.tags, entry.definition
                );
                if !terms_found.contains(&uniq_key) {
                    terms_found.insert(uniq_key);
                    all_results.push(entry);
                }
            }
        } else {
            let mut frequencies = Vec::new();
            if let Ok(rows) = freq_stmt.query_map(params![&current_term, ""], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, i64>(2).unwrap_or_default(),
                ))
            }) {
                for row in rows.flatten() {
                    frequencies.push(FrequencyData {
                        dict_name: row.0,
                        display_value: row.1,
                        value: row.2,
                    });
                }
            }

            let mut pronunciations = Vec::new();
            if let Ok(rows) = pronunciation_stmt.query_map(params![&current_term, ""], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                ))
            }) {
                for row in rows.flatten() {
                    pronunciations.push(PronunciationData {
                        dict_name: row.0,
                        reading: row.1,
                        ipa: row.2,
                        tags: row.3,
                    });
                }
            }

            if !frequencies.is_empty() || !pronunciations.is_empty() {
                let dict_name = pronunciations
                    .first()
                    .map(|value| value.dict_name.clone())
                    .or_else(|| frequencies.first().map(|value| value.dict_name.clone()))
                    .unwrap_or_else(|| "Metadata".to_string());
                let reading = pronunciations
                    .first()
                    .map(|value| value.reading.clone())
                    .unwrap_or_default();
                all_results.push(DictEntry {
                    term: current_term.clone(),
                    reading,
                    definition: String::new(),
                    dict_name,
                    tags: String::new(),
                    deinflection_reasons: current_reasons.clone(),
                    frequencies,
                    pitches: Vec::new(),
                    pronunciations,
                    source_length: source_len,
                });
            }
        }
        if depth >= max_depth || all_results.len() >= 120 {
            continue;
        }
        for (reason, desc, in_s, out_s) in rules {
            if in_s.is_empty() {
                continue;
            }
            if current_term.ends_with(in_s) {
                if in_s.is_empty() && current_reasons.iter().any(|r| r.rule == *reason) {
                    continue;
                }
                let mut new_term = current_term[..current_term.len() - in_s.len()].to_string();
                new_term.push_str(out_s);
                if new_term.chars().count() > 24 || new_term.chars().count() < 2 {
                    continue;
                }
                let mut new_reasons = current_reasons.clone();
                new_reasons.insert(
                    0,
                    DeinflectReason {
                        rule: reason.clone(),
                        desc: desc.clone(),
                        in_suffix: in_s.clone(),
                        out_suffix: out_s.clone(),
                    },
                );
                queue.push_back((new_term, new_reasons, depth + 1));
                if queue.len() > 64 {
                    break;
                }
            }
        }
    }
    let query_forms = lookup_forms(word);
    all_results.sort_by(|a, b| {
        deinflected_surface_rank(a, word)
            .cmp(&deinflected_surface_rank(b, word))
            .then_with(|| {
                lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
            })
            .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            .then_with(|| b.source_length.cmp(&a.source_length))
    });
    all_results
}

#[tauri::command]
async fn lookup_word(app: tauri::AppHandle, word: String) -> Result<Vec<DictEntry>, String> {
    let db = open_db(&app)?;
    let rules = load_rules();
    let clean_word = word.trim();
    let chars: Vec<char> = clean_word.chars().collect();
    let mut all_entries = Vec::new();
    let mut found_terms = HashSet::new();
    let max_len = std::cmp::min(20, chars.len());
    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 32").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 16").map_err(|e| e.to_string())?;
    let mut pronunciation_stmt = db.prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32").map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term != '' AND (e.term IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) OR (e.reading != '' AND e.reading IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))) ORDER BY CASE WHEN e.term = ?1 THEN 0 WHEN e.reading = ?1 THEN 1 WHEN e.term IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 2 WHEN e.reading IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 3 ELSE 4 END, e.id ASC LIMIT 80").map_err(|e| e.to_string())?;

    for len in (1..=max_len).rev() {
        let sub: String = chars[0..len].iter().collect();
        if len < 2 && !has_kanji(&sub) && !is_english_lookup_word(&sub) {
            continue;
        }
        let mut entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            &sub,
            &rules,
            len,
            LOOKUP_DIRECT_DEINFLECT_DEPTH,
        );
        if entries.is_empty() {
            entries = lookup_numeric_prefix_fallback(
                &mut freq_stmt,
                &mut pitch_stmt,
                &mut pronunciation_stmt,
                &mut stmt,
                &chars[0..len],
                &rules,
                len,
                LOOKUP_DIRECT_DEINFLECT_DEPTH,
            );
        }
        if is_plain_katakana_lookup(&sub) {
            entries = keep_literal_kana_entries(entries, &sub);
        }
        let mut added_for_len = false;
        for entry in entries {
            let key = format!(
                "{}|{}|{}|{}",
                entry.term, entry.reading, entry.dict_name, entry.source_length
            );
            if !found_terms.contains(&key) {
                found_terms.insert(key);
                all_entries.push(entry);
                added_for_len = true;
            }
        }
        if added_for_len {
            break;
        }
    }
    let query_forms = lookup_forms(clean_word);
    all_entries.sort_by(|a, b| {
        b.source_length
            .cmp(&a.source_length)
            .then_with(|| {
                lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
            })
            .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
    });
    Ok(all_entries)
}

fn decode_basic_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn strip_html_to_lookup_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len().min(16_384));
    let mut tag = String::new();
    let mut in_tag = false;

    for ch in html.chars() {
        if in_tag {
            if ch == '>' {
                let lower = tag.trim().to_ascii_lowercase();
                let block = lower.starts_with("br")
                    || lower.starts_with("li")
                    || lower.starts_with("/li")
                    || lower.starts_with("p")
                    || lower.starts_with("/p")
                    || lower.starts_with("div")
                    || lower.starts_with("/div")
                    || lower.starts_with("section")
                    || lower.starts_with("/section")
                    || lower.starts_with("article")
                    || lower.starts_with("/article")
                    || lower.starts_with("h1")
                    || lower.starts_with("/h1")
                    || lower.starts_with("h2")
                    || lower.starts_with("/h2")
                    || lower.starts_with("h3")
                    || lower.starts_with("/h3")
                    || lower.starts_with("ol")
                    || lower.starts_with("/ol")
                    || lower.starts_with("ul")
                    || lower.starts_with("/ul");
                if block && !text.ends_with('\n') {
                    text.push('\n');
                }
                tag.clear();
                in_tag = false;
            } else if tag.len() < 256 {
                tag.push(ch);
            }
            continue;
        }

        if ch == '<' {
            in_tag = true;
            tag.clear();
        } else {
            text.push(ch);
        }
    }

    let decoded = decode_basic_html_entities(&text);
    let mut out = String::new();
    let mut last_blank = false;
    for line in decoded.lines() {
        let clean = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if clean.is_empty() {
            if !last_blank && !out.is_empty() {
                out.push('\n');
                last_blank = true;
            }
        } else {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&clean);
            last_blank = false;
        }
    }
    out.trim().to_string()
}

fn collect_cambridge_definition(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for key in [
                "entryContent",
                "definition",
                "html",
                "content",
                "text",
                "guideWord",
            ] {
                if let Some(Value::String(text)) = map.get(key) {
                    let cleaned = if text.contains('<') && text.contains('>') {
                        strip_html_to_lookup_text(text)
                    } else {
                        text.trim().to_string()
                    };
                    if !cleaned.is_empty() {
                        output.push(cleaned);
                    }
                }
            }
            for child in map.values() {
                collect_cambridge_definition(child, output);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_cambridge_definition(child, output);
            }
        }
        _ => {}
    }
}

fn cambridge_response_to_definition(body: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        let mut chunks = Vec::new();
        collect_cambridge_definition(&json, &mut chunks);
        chunks.dedup();
        if !chunks.is_empty() {
            return chunks.join("\n\n");
        }
        return serde_json::to_string_pretty(&json).unwrap_or_else(|_| body.to_string());
    }

    if body.contains('<') && body.contains('>') {
        strip_html_to_lookup_text(body)
    } else {
        body.trim().to_string()
    }
}

fn encode_query_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn cambridge_cache_now_ms() -> u64 {
    unix_time_ms().min(u64::MAX as u128) as u64
}

fn cambridge_cache_key(base_url: &str, dictionary_code: &str, word: &str) -> String {
    format!(
        "{}|{}|{}",
        base_url.trim_end_matches('/').to_ascii_lowercase(),
        dictionary_code.to_ascii_lowercase(),
        word.to_ascii_lowercase()
    )
}

fn read_cambridge_cache_file(app: &tauri::AppHandle) -> HashMap<String, CambridgeCacheRecord> {
    let path = match get_data_path(app, CAMBRIDGE_CACHE_FILE) {
        Ok(path) => path,
        Err(_) => return HashMap::new(),
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn get_cambridge_cached_entries(
    app: &tauri::AppHandle,
    cache_key: &str,
    now_ms: u64,
) -> Option<Vec<DictEntry>> {
    let cache = read_cambridge_cache_file(app);
    cache.get(cache_key).and_then(|record| {
        if record.expires_at_ms >= now_ms {
            Some(record.entries.clone())
        } else {
            None
        }
    })
}

fn write_cambridge_cache_entries(
    app: &tauri::AppHandle,
    cache_key: String,
    entries: Vec<DictEntry>,
    ttl_ms: u64,
) {
    let estimated_entry_size: usize = entries
        .iter()
        .map(|entry| {
            entry.term.len()
                + entry.reading.len()
                + entry.definition.len()
                + entry.dict_name.len()
                + entry.tags.len()
        })
        .sum();
    if estimated_entry_size > CAMBRIDGE_CACHE_MAX_ENTRY_BYTES {
        return;
    }

    let path = match get_data_path(app, CAMBRIDGE_CACHE_FILE) {
        Ok(path) => path,
        Err(_) => return,
    };
    let now_ms = cambridge_cache_now_ms();
    let mut cache = read_cambridge_cache_file(app);
    cache.retain(|_, record| record.expires_at_ms >= now_ms);
    cache.insert(
        cache_key,
        CambridgeCacheRecord {
            saved_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(ttl_ms),
            entries,
        },
    );

    if cache.len() > CAMBRIDGE_CACHE_MAX_RECORDS {
        let mut keys_by_age: Vec<(String, u64)> = cache
            .iter()
            .map(|(key, record)| (key.clone(), record.saved_at_ms))
            .collect();
        keys_by_age.sort_by_key(|(_, saved_at)| *saved_at);
        let remove_count = cache.len().saturating_sub(CAMBRIDGE_CACHE_MAX_RECORDS);
        for (key, _) in keys_by_age.into_iter().take(remove_count) {
            cache.remove(&key);
        }
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::write(path, text);
    }
}

#[tauri::command]
async fn lookup_cambridge_api(
    app: tauri::AppHandle,
    word: String,
    config: CambridgeApiConfig,
) -> Result<Vec<DictEntry>, String> {
    if !config.enabled {
        return Ok(Vec::new());
    }

    let clean_word = word.trim();
    if clean_word.is_empty() {
        return Ok(Vec::new());
    }

    let dictionary_code = config.dictionary_code.trim();
    if dictionary_code.is_empty()
        || !dictionary_code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Cambridge dictionary code is invalid".into());
    }

    let base_url = config
        .base_url
        .as_deref()
        .unwrap_or("https://dictionary.cambridge.org/api/v1")
        .trim()
        .trim_end_matches('/')
        .to_string();
    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("Cambridge API base URL must start with http:// or https://".into());
    }

    let cache_key = cambridge_cache_key(&base_url, dictionary_code, clean_word);
    if let Some(entries) = get_cambridge_cached_entries(&app, &cache_key, cambridge_cache_now_ms())
    {
        return Ok(entries);
    }

    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("Cambridge API key is empty".into());
    }

    let url = format!(
        "{base_url}/dictionaries/{dictionary_code}/search/first?q={}&format=html",
        encode_query_component(clean_word)
    );
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("accessKey", api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Cambridge API request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Cambridge API response read failed: {e}"))?;
    if !status.is_success() {
        if status.as_u16() == 404 || status.as_u16() == 204 {
            write_cambridge_cache_entries(
                &app,
                cache_key,
                Vec::new(),
                CAMBRIDGE_NEGATIVE_CACHE_TTL_MS,
            );
            return Ok(Vec::new());
        }

        let message = cambridge_response_to_definition(&body);
        return Err(format!(
            "Cambridge API returned {}{}",
            status.as_u16(),
            if message.is_empty() {
                String::new()
            } else {
                format!(": {}", message.chars().take(220).collect::<String>())
            }
        ));
    }
    if body.len() > 768 * 1024 {
        return Err("Cambridge API response is too large".into());
    }

    let definition = cambridge_response_to_definition(&body);
    if definition.trim().is_empty() {
        write_cambridge_cache_entries(&app, cache_key, Vec::new(), CAMBRIDGE_NEGATIVE_CACHE_TTL_MS);
        return Ok(Vec::new());
    }

    let entries = vec![DictEntry {
        term: clean_word.to_string(),
        reading: String::new(),
        definition,
        dict_name: format!("Cambridge API ({dictionary_code})"),
        tags: "en cambridge online".into(),
        deinflection_reasons: Vec::new(),
        frequencies: Vec::new(),
        pitches: Vec::new(),
        pronunciations: Vec::new(),
        source_length: clean_word.chars().count(),
    }];
    write_cambridge_cache_entries(&app, cache_key, entries.clone(), CAMBRIDGE_CACHE_TTL_MS);
    Ok(entries)
}

#[tauri::command]
async fn scan_cursor(
    app: tauri::AppHandle,
    sentence: String,
    cursor: usize,
) -> Result<CursorLookupResult, String> {
    let db = open_db(&app)?;
    scan_cursor_in_db(&db, &sentence, cursor)
}

fn scan_cursor_in_db(
    db: &Connection,
    sentence: &str,
    cursor: usize,
) -> Result<CursorLookupResult, String> {
    let rules = load_rules();
    let chars: Vec<char> = sentence.chars().collect();
    if chars.is_empty() {
        return Err("Empty sentence".into());
    }
    let cursor = std::cmp::min(cursor, chars.len().saturating_sub(1));
    let mut best_start = cursor;
    let mut best_score: Option<(u8, u8, usize, u8, usize, std::cmp::Reverse<usize>)> = None;
    let mut best_entries = Vec::new();
    let starts = scan_start_candidates(&chars, cursor);

    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 32").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 16").map_err(|e| e.to_string())?;
    let mut pronunciation_stmt = db.prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32").map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term != '' AND (e.term IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) OR (e.reading != '' AND e.reading IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))) ORDER BY CASE WHEN e.term = ?1 THEN 0 WHEN e.reading = ?1 THEN 1 WHEN e.term IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 2 WHEN e.reading IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 3 ELSE 4 END, e.id ASC LIMIT 80").map_err(|e| e.to_string())?;

    if let Some((start, len)) = english_token_bounds(&chars, cursor) {
        let word: String = chars[start..start + len].iter().collect();
        let mut entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            &word,
            &rules,
            len,
            0,
        );
        if entries.is_empty() {
            let lower = word.to_lowercase();
            if lower != word {
                entries = internal_lookup(
                    &mut freq_stmt,
                    &mut pitch_stmt,
                    &mut pronunciation_stmt,
                    &mut stmt,
                    &lower,
                    &rules,
                    len,
                    0,
                );
            }
        }
        if !entries.is_empty() {
            let query_forms = lookup_forms(&word);
            entries.sort_by(|a, b| {
                b.source_length
                    .cmp(&a.source_length)
                    .then_with(|| {
                        lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
                    })
                    .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            });
            return Ok(CursorLookupResult {
                entries,
                match_start: start,
                match_len: len,
                word,
            });
        }
    }

    for start in starts {
        let max_len = std::cmp::min(12, chars.len() - start);
        let mut current_start_entries = Vec::new();
        let mut current_len = 0;
        let mut current_score: Option<(u8, u8, usize, u8, usize, std::cmp::Reverse<usize>)> = None;
        for len in 1..=max_len {
            if start + len <= cursor {
                continue;
            }
            let sub_chars = &chars[start..start + len];
            if sub_chars.iter().any(|c| is_lookup_punctuation(*c)) {
                continue;
            }
            let sub: String = sub_chars.iter().collect();
            if len < 2 && !has_kanji(&sub) {
                continue;
            }
            let mut entries = internal_lookup(
                &mut freq_stmt,
                &mut pitch_stmt,
                &mut pronunciation_stmt,
                &mut stmt,
                &sub,
                &rules,
                len,
                LOOKUP_SCAN_DEINFLECT_DEPTH,
            );
            if entries.is_empty() {
                entries = lookup_numeric_prefix_fallback(
                    &mut freq_stmt,
                    &mut pitch_stmt,
                    &mut pronunciation_stmt,
                    &mut stmt,
                    sub_chars,
                    &rules,
                    len,
                    LOOKUP_SCAN_DEINFLECT_DEPTH,
                );
            }
            if is_plain_katakana_lookup(&sub) {
                entries = keep_literal_kana_entries(entries, &sub);
            }
            if !entries.is_empty() {
                let distance = cursor.saturating_sub(start);
                let single_kanji_penalty = if len == 1 && has_kanji(&sub) { 2 } else { 0 };
                let deinflection_depth = entries
                    .iter()
                    .map(|entry| scan_entry_morphology_cost(entry, &sub))
                    .min()
                    .unwrap_or(usize::MAX);
                let score = (
                    single_kanji_penalty,
                    scan_end_boundary_penalty(&chars, start, len, cursor),
                    deinflection_depth,
                    scan_start_boundary_penalty(&chars, start, cursor),
                    distance,
                    std::cmp::Reverse(len),
                );
                if current_score.map(|best| score < best).unwrap_or(true) {
                    current_score = Some(score);
                    current_len = len;
                    current_start_entries = entries;
                }
            }
        }
        if current_len > 0 {
            let score = current_score.unwrap_or((
                3,
                3,
                usize::MAX,
                scan_start_boundary_penalty(&chars, start, cursor),
                cursor.saturating_sub(start),
                std::cmp::Reverse(current_len),
            ));
            if best_score.map(|best| score < best).unwrap_or(true) {
                best_score = Some(score);
                best_start = start;
                best_entries = current_start_entries;
            }
        }
    }
    if let Some((_, _, _, _, _, std::cmp::Reverse(best_len))) = best_score {
        let best_word: String = chars[best_start..best_start + best_len].iter().collect();
        let query_forms = lookup_forms(&best_word);
        best_entries.sort_by(|a, b| {
            b.source_length
                .cmp(&a.source_length)
                .then_with(|| {
                    lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
                })
                .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
        });
        Ok(CursorLookupResult {
            entries: best_entries,
            match_start: best_start,
            match_len: best_len,
            word: chars[best_start..best_start + best_len].iter().collect(),
        })
    } else {
        Err("No match".into())
    }
}

#[cfg(target_os = "windows")]
fn get_icon_as_base64(path: &str) -> Option<String> {
    let wide_path: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut h_icon_large = std::ptr::null_mut();
    unsafe {
        if ExtractIconExW(
            wide_path.as_ptr(),
            0,
            &mut h_icon_large,
            std::ptr::null_mut(),
            1,
        ) > 0
            && !h_icon_large.is_null()
        {
            let mut icon_info = std::mem::zeroed();
            if GetIconInfo(h_icon_large, &mut icon_info) != 0 {
                let hdc = GetDC(std::ptr::null_mut());
                let mut bi: BITMAPINFOHEADER = std::mem::zeroed();
                bi.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                bi.biWidth = 32;
                bi.biHeight = -32;
                bi.biPlanes = 1;
                bi.biBitCount = 32;
                bi.biCompression = BI_RGB;
                let mut buffer: Vec<u8> = vec![0; (32 * 32 * 4) as usize];
                let res = GetDIBits(
                    hdc,
                    icon_info.hbmColor,
                    0,
                    32,
                    buffer.as_mut_ptr() as *mut _,
                    &mut bi as *mut _ as *mut _,
                    DIB_RGB_COLORS,
                );
                ReleaseDC(std::ptr::null_mut(), hdc);
                DestroyIcon(h_icon_large);
                if !icon_info.hbmColor.is_null() {
                    winapi::um::wingdi::DeleteObject(icon_info.hbmColor as *mut _);
                }
                if !icon_info.hbmMask.is_null() {
                    winapi::um::wingdi::DeleteObject(icon_info.hbmMask as *mut _);
                }
                if res != 0 {
                    for chunk in buffer.chunks_exact_mut(4) {
                        let b = chunk[0];
                        let r = chunk[2];
                        chunk[0] = r;
                        chunk[2] = b;
                    }
                    if let Some(img) = screenshots::image::RgbaImage::from_raw(32, 32, buffer) {
                        let dyn_img = screenshots::image::DynamicImage::ImageRgba8(img);
                        let mut cursor = std::io::Cursor::new(Vec::new());
                        if dyn_img
                            .write_to(&mut cursor, screenshots::image::ImageFormat::Png)
                            .is_ok()
                        {
                            return Some(STANDARD.encode(cursor.into_inner()));
                        }
                    }
                }
            } else {
                DestroyIcon(h_icon_large);
            }
        }
    }
    None
}

/// Directories that hold XDG data, most specific first.
#[cfg(target_os = "linux")]
fn xdg_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(home));
    } else if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share"));
    }
    let system = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    dirs.extend(system.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    dirs
}

/// Maps an executable's file name to the `Icon=` value of the desktop entry
/// that launches it. Built once — scanning every applications directory per
/// process would be far too slow for `get_running_processes`.
#[cfg(target_os = "linux")]
fn desktop_entry_icons() -> &'static HashMap<String, String> {
    static INDEX: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = HashMap::new();
        for dir in xdg_data_dirs() {
            let entries = match std::fs::read_dir(dir.join("applications")) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                    continue;
                }
                let contents = match std::fs::read_to_string(&path) {
                    Ok(contents) => contents,
                    Err(_) => continue,
                };

                let mut icon = None;
                let mut executables = Vec::new();
                for line in contents.lines() {
                    let line = line.trim();
                    if let Some(value) = line.strip_prefix("Icon=") {
                        if icon.is_none() {
                            icon = Some(value.trim().to_string());
                        }
                    } else if let Some(value) =
                        line.strip_prefix("Exec=").or_else(|| line.strip_prefix("TryExec="))
                    {
                        // Exec may carry a full command line and %-field codes.
                        if let Some(program) = value.split_whitespace().next() {
                            if let Some(name) = Path::new(program).file_name() {
                                executables.push(name.to_string_lossy().to_string());
                            }
                        }
                    }
                }

                if let Some(icon) = icon {
                    if let Some(stem) = path.file_stem() {
                        executables.push(stem.to_string_lossy().to_string());
                    }
                    for executable in executables {
                        // Earlier directories win, matching XDG precedence.
                        index.entry(executable).or_insert_with(|| icon.clone());
                    }
                }
            }
        }
        index
    })
}

/// Icon themes to consult, best first. Themes disagree on directory order
/// (hicolor uses <size>/apps, Breeze uses apps/<size>) and icons referenced by
/// desktop entries are not always under `apps` — plenty are status, device or
/// action icons — so the index below searches every category instead.
#[cfg(target_os = "linux")]
fn icon_theme_search_order() -> Vec<String> {
    let mut themes: Vec<String> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let settings = PathBuf::from(home).join(".config/gtk-3.0/settings.ini");
        if let Ok(contents) = std::fs::read_to_string(settings) {
            for line in contents.lines() {
                if let Some(value) = line.trim().strip_prefix("gtk-icon-theme-name=") {
                    themes.push(value.trim().to_string());
                }
            }
        }
    }
    for fallback in ["breeze", "hicolor", "Adwaita"] {
        if !themes.iter().any(|t| t == fallback) {
            themes.push(fallback.to_string());
        }
    }
    themes
}

/// Ranks two files for the same icon: scalable art beats bitmaps, and among
/// bitmaps the largest wins, since the caller downscales to 32px.
#[cfg(target_os = "linux")]
fn icon_candidate_quality(path: &Path) -> u32 {
    if path.extension().and_then(|e| e.to_str()) == Some("svg") {
        return u32::MAX;
    }
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .filter_map(|name| {
            let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
        .max()
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn collect_icon_files(
    dir: &Path,
    depth: usize,
    wanted: &HashSet<String>,
    theme_rank: usize,
    best: &mut HashMap<String, (usize, u32, PathBuf)>,
) {
    if depth > 3 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_icon_files(&path, depth + 1, wanted, theme_rank, best);
            continue;
        }
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if extension != "svg" && extension != "png" {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(stem) if wanted.contains(stem) => stem.to_string(),
            _ => continue,
        };
        let quality = icon_candidate_quality(&path);
        match best.get(&stem) {
            // A theme earlier in the search order always wins; within one
            // theme, the better rendition wins.
            Some((rank, existing, _)) if *rank < theme_rank || *existing >= quality => {}
            _ => {
                best.insert(stem, (theme_rank, quality, path));
            }
        }
    }
}

/// Resolves every icon named by a desktop entry to a file, in a single pass.
/// Walking the themes per lookup would be far too slow — Breeze alone holds
/// thousands of files.
#[cfg(target_os = "linux")]
fn icon_file_index() -> &'static HashMap<String, PathBuf> {
    static INDEX: std::sync::OnceLock<HashMap<String, PathBuf>> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let wanted: HashSet<String> = desktop_entry_icons().values().cloned().collect();
        let mut best: HashMap<String, (usize, u32, PathBuf)> = HashMap::new();
        let themes = icon_theme_search_order();

        for base in xdg_data_dirs() {
            let icons_root = base.join("icons");
            for (rank, theme) in themes.iter().enumerate() {
                collect_icon_files(&icons_root.join(theme), 0, &wanted, rank, &mut best);
            }
            collect_icon_files(&base.join("pixmaps"), 3, &wanted, themes.len(), &mut best);
        }

        best.into_iter()
            .map(|(name, (_, _, path))| (name, path))
            .collect()
    })
}

#[cfg(target_os = "linux")]
fn resolve_icon_file(icon: &str) -> Option<PathBuf> {
    let direct = Path::new(icon);
    if direct.is_absolute() && direct.is_file() {
        return Some(direct.to_path_buf());
    }
    icon_file_index().get(icon).cloned()
}

/// Rasterises an SVG icon to a square RGBA image.
#[cfg(target_os = "linux")]
fn render_svg_icon(data: &[u8], size: u32) -> Option<image::RgbaImage> {
    let tree = resvg::usvg::Tree::from_data(data, &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)?;

    let tree_size = tree.size();
    let scale = (size as f32 / tree_size.width()).min(size as f32 / tree_size.height());
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );

    // tiny-skia stores premultiplied alpha; PNG expects straight alpha.
    let mut rgba = image::RgbaImage::new(size, size);
    for (source, target) in pixmap.pixels().iter().zip(rgba.pixels_mut()) {
        let color = source.demultiply();
        *target = image::Rgba([color.red(), color.green(), color.blue(), color.alpha()]);
    }
    Some(rgba)
}

#[cfg(target_os = "linux")]
fn get_icon_as_base64(path: &str) -> Option<String> {
    let executable = Path::new(path).file_name()?.to_string_lossy().to_string();
    let icon = desktop_entry_icons().get(&executable)?;
    let icon_file = resolve_icon_file(icon)?;

    // Match the 32x32 RGBA PNG the Windows path produces.
    let resized = if icon_file.extension().and_then(|e| e.to_str()) == Some("svg") {
        image::DynamicImage::ImageRgba8(render_svg_icon(&std::fs::read(&icon_file).ok()?, 32)?)
    } else {
        image::open(&icon_file)
            .ok()?
            .resize_exact(32, 32, image::imageops::FilterType::Lanczos3)
    };

    let mut encoded = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut encoded, image::ImageFormat::Png)
        .ok()?;
    Some(STANDARD.encode(encoded.into_inner()))
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn get_icon_as_base64(_path: &str) -> Option<String> {
    None
}

#[tauri::command]
fn get_running_processes() -> Result<Vec<ProcessInfo>, String> {
    let mut sys = System::new_all();
    sys.refresh_all();
    let mut proc_list = Vec::new();
    let mut seen = HashSet::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_string();
        let path = process
            .exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() || name.to_lowercase().starts_with("svchost") {
            continue;
        }
        let seen_key = if path.is_empty() {
            format!("{}:{}", name.to_lowercase(), process.pid().as_u32())
        } else {
            path.to_lowercase()
        };
        if seen.insert(seen_key) {
            let icon = if path.is_empty() {
                None
            } else {
                get_icon_as_base64(&path)
            };
            proc_list.push(ProcessInfo {
                name,
                path,
                pid: process.pid().as_u32(),
                icon,
            });
        }
    }
    proc_list.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    Ok(proc_list)
}

fn running_process_map() -> HashMap<u32, (String, String)> {
    let mut sys = System::new_all();
    sys.refresh_all();
    let mut process_map = HashMap::new();

    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_string();
        let path = process
            .exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        process_map.insert(process.pid().as_u32(), (name, path));
    }

    process_map
}

fn collect_capture_windows(recent_hwnds: &[u64]) -> Result<Vec<CaptureWindowInfo>, String> {
    let process_map = running_process_map();
    let mut seen_icons = HashMap::<String, Option<String>>::new();
    let mut windows = Vec::new();

    for window in xcap::Window::all().map_err(|e| format!("Window lookup failed: {}", e))? {
        let width = window.width().unwrap_or(0);
        let height = window.height().unwrap_or(0);

        if width < 80 || height < 80 || window.is_minimized().unwrap_or(false) {
            continue;
        }

        let pid = window.pid().unwrap_or(0);
        let title = window.title().unwrap_or_default();
        let app_name = window.app_name().unwrap_or_default();
        let (mut process_name, path) = process_map
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new()));

        if process_name.is_empty() {
            process_name = if !app_name.is_empty() {
                app_name.clone()
            } else {
                title.clone()
            };
        }

        if process_name.is_empty() && path.is_empty() && title.is_empty() && app_name.is_empty() {
            continue;
        }

        let icon = if path.is_empty() {
            None
        } else if let Some(icon) = seen_icons.get(&path) {
            icon.clone()
        } else {
            let icon = get_icon_as_base64(&path);
            seen_icons.insert(path.clone(), icon.clone());
            icon
        };

        let id = window.id().unwrap_or(0) as u64;
        windows.push(CaptureWindowInfo {
            id,
            title,
            app_name,
            process_name,
            path,
            pid,
            width,
            height,
            is_focused: window.is_focused().unwrap_or(false),
            is_recent: recent_hwnds.iter().any(|hwnd| *hwnd == id),
            icon,
        });
    }

    windows.sort_by(|a, b| {
        b.is_focused
            .cmp(&a.is_focused)
            .then_with(|| b.is_recent.cmp(&a.is_recent))
            .then_with(|| {
                (b.width as u64 * b.height as u64).cmp(&(a.width as u64 * a.height as u64))
            })
            .then_with(|| {
                a.process_name
                    .to_lowercase()
                    .cmp(&b.process_name.to_lowercase())
            })
    });

    Ok(windows)
}

#[tauri::command]
fn get_capture_windows(
    history: tauri::State<'_, ForegroundHistory>,
) -> Result<Vec<CaptureWindowInfo>, String> {
    let recent_hwnds: Vec<u64> = history
        .hwnds
        .lock()
        .map(|hwnds| hwnds.iter().copied().collect())
        .unwrap_or_default();
    collect_capture_windows(&recent_hwnds)
}

#[cfg(target_os = "windows")]
fn start_foreground_tracker(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let hwnd = unsafe { GetForegroundWindow() as u64 };
            if hwnd == 0 {
                continue;
            }

            let history = app.state::<ForegroundHistory>();
            if let Ok(mut hwnds) = history.hwnds.lock() {
                if hwnds.front().copied() == Some(hwnd) {
                    continue;
                }

                hwnds.push_front(hwnd);
                while hwnds.len() > 24 {
                    hwnds.pop_back();
                }
            };
        }
    });
}

fn normalize_process_name(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .trim_end_matches(".exe")
        .to_string()
}

fn parse_screenshot_targets(processes: Vec<serde_json::Value>) -> Vec<ScreenshotTarget> {
    processes
        .into_iter()
        .filter_map(|value| {
            if let Some(name) = value.as_str() {
                let name = name.trim();
                if name.is_empty() {
                    return None;
                }

                return Some(ScreenshotTarget {
                    name: name.to_string(),
                    path: String::new(),
                });
            }

            let obj = value.as_object()?;
            let name = obj
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let path = obj
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            if name.is_empty() && path.is_empty() {
                None
            } else {
                Some(ScreenshotTarget {
                    name: name.to_string(),
                    path: path.to_string(),
                })
            }
        })
        .collect()
}

fn process_target_aliases(target: &ScreenshotTarget) -> Vec<String> {
    let mut aliases = Vec::new();

    if !target.name.trim().is_empty() {
        aliases.push(normalize_process_name(&target.name));
    }

    if !target.path.trim().is_empty() {
        let path = std::path::Path::new(&target.path);

        if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
            aliases.push(normalize_process_name(file_name));
        }

        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            aliases.push(normalize_process_name(stem));
        }

        if let Some(parent_name) = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
        {
            aliases.push(normalize_process_name(parent_name));
        }
    }

    aliases.sort();
    aliases.dedup();
    aliases.into_iter().filter(|s| !s.is_empty()).collect()
}

fn encode_window_jpeg(window: xcap::Window) -> Result<String, String> {
    let rgba_image = window
        .capture_image()
        .map_err(|e| format!("Window capture failed: {}", e))?;
    let mut dyn_img = image::DynamicImage::ImageRgba8(rgba_image);

    let max_side = 1600_u32;
    let width = dyn_img.width();
    let height = dyn_img.height();
    let longest_side = width.max(height);
    if longest_side > max_side {
        let scale = max_side as f32 / longest_side as f32;
        let next_width = ((width as f32 * scale).round() as u32).max(1);
        let next_height = ((height as f32 * scale).round() as u32).max(1);
        dyn_img = dyn_img.resize(
            next_width,
            next_height,
            image::imageops::FilterType::Triangle,
        );
    }

    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 82);
    encoder
        .encode_image(&dyn_img)
        .map_err(|e| format!("JPEG encode failed: {}", e))?;

    Ok(STANDARD.encode(cursor.into_inner()))
}

#[tauri::command]
async fn take_external_lookup_screenshot(x: i32, y: i32) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let windows = xcap::Window::all().map_err(|e| format!("Window lookup failed: {}", e))?;

        #[cfg(target_os = "windows")]
        let foreground_id = unsafe { GetForegroundWindow() as u64 };
        #[cfg(not(target_os = "windows"))]
        let foreground_id = 0_u64;

        let mut best_window = None;
        let mut best_score = 0_u64;

        for window in windows {
            let width = window.width().unwrap_or(0);
            let height = window.height().unwrap_or(0);

            if width < 80 || height < 80 || window.is_minimized().unwrap_or(false) {
                continue;
            }

            let left = window.x().unwrap_or(0);
            let top = window.y().unwrap_or(0);
            let right = left.saturating_add(width as i32);
            let bottom = top.saturating_add(height as i32);
            let contains_point = x >= left && x <= right && y >= top && y <= bottom;
            let window_id = window.id().unwrap_or(0) as u64;
            let area = (width as u64).saturating_mul(height as u64);

            let score = if contains_point {
                20_000_000_000_u64.saturating_add(area)
            } else if foreground_id != 0 && window_id == foreground_id {
                10_000_000_000_u64.saturating_add(area)
            } else {
                0
            };

            if score > best_score {
                best_score = score;
                best_window = Some(window);
            }
        }

        match best_window {
            Some(window) => Ok(Some(encode_window_jpeg(window)?)),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("Screenshot worker failed: {}", e))?
}

#[tauri::command]
fn hide_external_lookup_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("lookup_external") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn prepare_lookup_agent_windows(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("lookup_external").is_none() {
        tauri::WebviewWindowBuilder::new(
            app,
            "lookup_external",
            WebviewUrl::App("lookup-window.html".into()),
        )
        .title("Setsuna Lookup")
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(520.0, 620.0)
        .build()
        .map_err(|error| format!("Failed to create lookup agent window: {error}"))?;
    }

    if app.get_webview_window("lookup_capture_region").is_none() {
        tauri::WebviewWindowBuilder::new(
            app,
            "lookup_capture_region",
            WebviewUrl::App("capture-region.html".into()),
        )
        .title("Setsuna Capture")
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(800.0, 600.0)
        .build()
        .map_err(|error| format!("Failed to create capture overlay: {error}"))?;
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn lookup_shortcut_from_label(label: &str) -> Option<Shortcut> {
    label.trim().parse::<Shortcut>().ok()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn register_lookup_agent_shortcut(app: &AppHandle, label: &str) -> Result<(), String> {
    let shortcut = lookup_shortcut_from_label(label)
        .ok_or_else(|| format!("Unsupported lookup shortcut: {label}"))?;
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|error| error.to_string())?;
    manager
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                #[cfg(target_os = "windows")]
                unsafe {
                    let foreground = GetForegroundWindow();
                    let mut foreground_pid = 0_u32;
                    if !foreground.is_null() {
                        GetWindowThreadProcessId(foreground, &mut foreground_pid);
                    }
                    if foreground_pid == GetCurrentProcessId() {
                        return;
                    }
                }
                let _ = app.emit_to("lookup_external", "lookup_agent_activate", ());
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn update_lookup_agent_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    match register_lookup_agent_shortcut(&app, &shortcut) {
        Ok(()) => Ok(shortcut),
        Err(error) => {
            let fallback = "Alt+Q";
            let fallback_result = register_lookup_agent_shortcut(&app, fallback);
            match fallback_result {
                Ok(()) => Err(format!("{error}. Restored {fallback}.")),
                Err(fallback_error) => Err(format!(
                    "{error}. Could not restore {fallback}: {fallback_error}"
                )),
            }
        }
    }
}

#[tauri::command]
fn show_lookup_agent_window(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let window = app
        .get_webview_window("lookup_external")
        .ok_or_else(|| "Lookup agent window is not ready".to_string())?;
    let width = 520_i32;
    let height = 620_i32;
    let monitor = app
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            x >= pos.x
                && y >= pos.y
                && x < pos.x.saturating_add(size.width as i32)
                && y < pos.y.saturating_add(size.height as i32)
        })
        .or_else(|| app.primary_monitor().ok().flatten());

    let (left, top) = if let Some(monitor) = monitor {
        let pos = monitor.position();
        let size = monitor.size();
        let min_left = pos.x.saturating_add(8);
        let min_top = pos.y.saturating_add(8);
        let max_left = pos
            .x
            .saturating_add(size.width as i32)
            .saturating_sub(width)
            .saturating_sub(8)
            .max(min_left);
        let max_top = pos
            .y
            .saturating_add(size.height as i32)
            .saturating_sub(height)
            .saturating_sub(8)
            .max(min_top);
        (
            x.saturating_add(18).clamp(min_left, max_left),
            y.saturating_add(18).clamp(min_top, max_top),
        )
    } else {
        (x.saturating_add(18).max(8), y.saturating_add(18).max(8))
    };

    window
        .set_position(tauri::PhysicalPosition::new(left, top))
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn begin_lookup_region_capture(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let cursor = {
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            if GetCursorPos(&mut point) == 0 {
                return Err("Could not read cursor position".to_string());
            }
        }
        (point.x, point.y)
    };
    #[cfg(not(target_os = "windows"))]
    let cursor = (0, 0);

    let monitor = app
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            cursor.0 >= pos.x
                && cursor.1 >= pos.y
                && cursor.0 < pos.x.saturating_add(size.width as i32)
                && cursor.1 < pos.y.saturating_add(size.height as i32)
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available for area capture".to_string())?;
    let window = app
        .get_webview_window("lookup_capture_region")
        .ok_or_else(|| "Capture overlay is not ready".to_string())?;
    let _ = app
        .get_webview_window("lookup_external")
        .map(|lookup| lookup.hide());
    window
        .set_position(tauri::PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            monitor.size().width,
            monitor.size().height,
        ))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    Ok(())
}

fn restore_lookup_after_region_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("lookup_external") {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn cancel_lookup_region_capture(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("lookup_capture_region") {
        window.hide().map_err(|error| error.to_string())?;
    }
    restore_lookup_after_region_capture(&app);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn finish_lookup_region_capture(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    if width < 8 || height < 8 {
        return Err("Selected area is too small".to_string());
    }
    if let Some(window) = app.get_webview_window("lookup_capture_region") {
        let _ = window.hide();
    }
    tokio::time::sleep(Duration::from_millis(120)).await;
    let capture = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let screen = screenshots::Screen::from_point(x, y)
            .map_err(|error| format!("Could not find screen: {error}"))?;
        let relative_x = x.saturating_sub(screen.display_info.x);
        let relative_y = y.saturating_sub(screen.display_info.y);
        let raw = screen
            .capture_area(relative_x, relative_y, width, height)
            .map_err(|error| format!("Area capture failed: {error}"))?;
        let raw_width = raw.width();
        let raw_height = raw.height();
        let rgba = image::RgbaImage::from_raw(raw_width, raw_height, raw.into_raw())
            .ok_or_else(|| "Could not convert captured area".to_string())?;
        let mut image = image::DynamicImage::ImageRgba8(rgba);
        let longest_side = image.width().max(image.height());
        if longest_side > 1600 {
            let scale = 1600.0 / longest_side as f32;
            image = image.resize(
                ((image.width() as f32 * scale).round() as u32).max(1),
                ((image.height() as f32 * scale).round() as u32).max(1),
                image::imageops::FilterType::Triangle,
            );
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 86)
            .encode_image(&image)
            .map_err(|error| format!("JPEG encode failed: {error}"))?;
        Ok(STANDARD.encode(bytes.into_inner()))
    })
    .await
    .map_err(|error| format!("Area capture worker failed: {error}"))?;
    restore_lookup_after_region_capture(&app);
    capture
}

#[tauri::command]
fn open_external_lookup_window(app: AppHandle, key: String, x: i32, y: i32) -> Result<(), String> {
    const LABEL: &str = "lookup_external";

    append_diagnostics_line(
        &app,
        serde_json::json!({
            "ts": unix_time_ms(),
            "kind": "global_lookup",
            "event": "external_window_open_start",
            "x": x,
            "y": y,
        }),
    );

    let url = format!("lookup-window.html?key={}", key);
    let width = 460.0;
    let height = 500.0;
    let mut min_left = 8_i32;
    let mut min_top = 8_i32;
    let mut max_left = 1920_i32.saturating_sub(width as i32).saturating_sub(8);
    let mut max_top = 1080_i32.saturating_sub(height as i32).saturating_sub(8);
    if let Ok(monitors) = app.available_monitors() {
        if let Some(monitor) = monitors
            .into_iter()
            .find(|monitor| {
                let pos = monitor.position();
                let size = monitor.size();
                x >= pos.x
                    && y >= pos.y
                    && x <= pos.x.saturating_add(size.width as i32)
                    && y <= pos.y.saturating_add(size.height as i32)
            })
            .or_else(|| app.primary_monitor().ok().flatten())
        {
            let pos = monitor.position();
            let size = monitor.size();
            min_left = pos.x.saturating_add(8);
            min_top = pos.y.saturating_add(8);
            max_left = pos
                .x
                .saturating_add(size.width as i32)
                .saturating_sub(width as i32)
                .saturating_sub(8);
            max_top = pos
                .y
                .saturating_add(size.height as i32)
                .saturating_sub(height as i32)
                .saturating_sub(8);
        }
    }
    let preferred_left = x.saturating_add(18);
    let preferred_top = y.saturating_add(18);
    let left = preferred_left.clamp(min_left, max_left.max(min_left));
    let top = preferred_top.clamp(min_top, max_top.max(min_top));
    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        append_diagnostics_line(
            &app,
            serde_json::json!({
                "ts": unix_time_ms(),
                "kind": "global_lookup",
                "event": "external_window_missing",
            }),
        );
        "Lookup window is not prepared yet".to_string()
    })?;

    let script = format!("window.location.href = {:?};", url);
    let _ = window.eval(&script);
    let _ = window.set_position(tauri::PhysicalPosition::new(left, top));
    let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    append_diagnostics_line(
        &app,
        serde_json::json!({
            "ts": unix_time_ms(),
            "kind": "global_lookup",
            "event": "external_window_reused",
            "left": left,
            "top": top,
            "width": width,
            "height": height,
        }),
    );
    Ok(())
}

fn capture_window_by_pid(pid: u32) -> Result<String, String> {
    let window = xcap::Window::all()
        .map_err(|e| format!("Window lookup failed: {}", e))?
        .into_iter()
        .filter(|window| window.pid().unwrap_or(0) == pid)
        .filter(|window| window.width().unwrap_or(0) >= 80 && window.height().unwrap_or(0) >= 80)
        .filter(|window| !window.is_minimized().unwrap_or(false))
        .max_by_key(|window| {
            let width = window.width().unwrap_or(0) as u64;
            let height = window.height().unwrap_or(0) as u64;
            width.saturating_mul(height)
        })
        .ok_or_else(|| format!("No visible window found for pid {}", pid))?;

    encode_window_jpeg(window)
}

fn http_json(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
        status,
        body.as_bytes().len(),
        body
    )
}

fn local_lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            let _ = socket.connect("8.8.8.8:80");
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(key) {
            return parts.next().map(|value| value.replace("%20", " "));
        }
    }
    None
}

fn request_has_token(request: &str, path: &str, token: &str) -> bool {
    if token.is_empty() {
        return true;
    }

    if query_param(path, "token").as_deref() == Some(token) {
        return true;
    }

    let bearer = format!("authorization: bearer {}", token.to_lowercase());
    request.lines().any(|line| line.to_lowercase() == bearer)
}

fn handle_capture_agent_request(request: &str, token: &str) -> String {
    let first_line = request.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let path = parts.get(1).copied().unwrap_or("/");

    if !request_has_token(request, path, token) {
        return http_json("401 Unauthorized", r#"{"error":"unauthorized"}"#);
    }

    if path.starts_with("/health") {
        return http_json("200 OK", r#"{"ok":true}"#);
    }

    if path.starts_with("/sources") {
        return match collect_capture_windows(&[]) {
            Ok(sources) => {
                match serde_json::to_string(&serde_json::json!({ "sources": sources })) {
                    Ok(body) => http_json("200 OK", &body),
                    Err(e) => http_json(
                        "500 Internal Server Error",
                        &serde_json::json!({ "error": e.to_string() }).to_string(),
                    ),
                }
            }
            Err(e) => http_json(
                "500 Internal Server Error",
                &serde_json::json!({ "error": e }).to_string(),
            ),
        };
    }

    if path.starts_with("/capture") {
        let Some(pid) = query_param(path, "pid").and_then(|pid| pid.parse::<u32>().ok()) else {
            return http_json("400 Bad Request", r#"{"error":"missing pid"}"#);
        };

        return match capture_window_by_pid(pid) {
            Ok(image) => http_json(
                "200 OK",
                &serde_json::json!({ "image": image, "format": "jpeg" }).to_string(),
            ),
            Err(e) => http_json(
                "500 Internal Server Error",
                &serde_json::json!({ "error": e }).to_string(),
            ),
        };
    }

    http_json("404 Not Found", r#"{"error":"not found"}"#)
}

fn publish_text_sync_line_to_state(state: &TextSyncState, text: String) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Empty text sync line".to_string());
    }

    let mut seq_guard = state
        .seq
        .lock()
        .map_err(|_| "Text sync seq lock failed".to_string())?;
    *seq_guard = seq_guard.saturating_add(1);
    let seq = *seq_guard;
    drop(seq_guard);

    let line = TextSyncLine {
        seq,
        text,
        at_ms: unix_time_ms() as u64,
        kind: "line".to_string(),
        payload: None,
    };

    let mut lines = state
        .lines
        .lock()
        .map_err(|_| "Text sync buffer lock failed".to_string())?;
    lines.push_back(line);
    while lines.len() > 500 {
        lines.pop_front();
    }

    Ok(seq)
}

fn publish_text_sync_event_to_state(
    state: &TextSyncState,
    kind: String,
    payload: Value,
) -> Result<TextSyncLine, String> {
    publish_text_sync_event_to_shared(&state.lines, &state.seq, kind, payload)
}

fn publish_text_sync_event_to_shared(
    lines_state: &Arc<Mutex<VecDeque<TextSyncLine>>>,
    seq_state: &Arc<Mutex<u64>>,
    kind: String,
    payload: Value,
) -> Result<TextSyncLine, String> {
    let kind = kind.trim().to_string();
    if kind.is_empty() {
        return Err("Empty text sync event kind".to_string());
    }

    let mut seq_guard = seq_state
        .lock()
        .map_err(|_| "Text sync seq lock failed".to_string())?;
    *seq_guard = seq_guard.saturating_add(1);
    let seq = *seq_guard;
    drop(seq_guard);

    let line = TextSyncLine {
        seq,
        text: String::new(),
        at_ms: unix_time_ms() as u64,
        kind,
        payload: Some(payload),
    };

    let mut lines = lines_state
        .lock()
        .map_err(|_| "Text sync buffer lock failed".to_string())?;
    lines.push_back(line.clone());
    while lines.len() > 500 {
        lines.pop_front();
    }

    Ok(line)
}

fn handle_text_sync_request(
    request: &str,
    token: &str,
    lines_state: &Arc<Mutex<VecDeque<TextSyncLine>>>,
    seq_state: &Arc<Mutex<u64>>,
    app_handle: &AppHandle,
) -> String {
    let first_line = request.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.get(0).copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("/");

    if method.eq_ignore_ascii_case("OPTIONS") {
        return http_json("200 OK", r#"{"ok":true}"#);
    }

    if !request_has_token(request, path, token) {
        return http_json("401 Unauthorized", r#"{"error":"unauthorized"}"#);
    }

    if path.starts_with("/health") {
        let seq = seq_state.lock().map(|guard| *guard).unwrap_or(0);
        return http_json(
            "200 OK",
            &serde_json::json!({ "ok": true, "seq": seq, "service": "setsuna-text-sync" })
                .to_string(),
        );
    }

    if path.starts_with("/events") {
        let since = query_param(path, "since")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let seq = seq_state.lock().map(|guard| *guard).unwrap_or(0);
        let lines = lines_state
            .lock()
            .map(|guard| {
                guard
                    .iter()
                    .filter(|line| line.seq > since)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        return match serde_json::to_string(&TextSyncEventsResponse {
            ok: true,
            seq,
            lines,
        }) {
            Ok(body) => http_json("200 OK", &body),
            Err(e) => http_json(
                "500 Internal Server Error",
                &serde_json::json!({ "error": e.to_string() }).to_string(),
            ),
        };
    }

    if method.eq_ignore_ascii_case("POST") && path.starts_with("/push") {
        let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
        let push = match serde_json::from_str::<TextSyncPushRequest>(body) {
            Ok(push) => push,
            Err(e) => {
                return http_json(
                    "400 Bad Request",
                    &serde_json::json!({ "error": format!("invalid push body: {}", e) })
                        .to_string(),
                )
            }
        };

        return match publish_text_sync_event_to_shared(
            lines_state,
            seq_state,
            push.kind,
            push.payload,
        ) {
            Ok(event) => {
                let _ = app_handle.emit("text_sync_remote_event", event.clone());
                http_json(
                    "200 OK",
                    &serde_json::json!({ "ok": true, "seq": event.seq }).to_string(),
                )
            }
            Err(e) => http_json(
                "500 Internal Server Error",
                &serde_json::json!({ "error": e }).to_string(),
            ),
        };
    }

    http_json("404 Not Found", r#"{"error":"not found"}"#)
}

fn read_http_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    loop {
        let size = stream.read(&mut chunk)?;
        if size == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..size]);

        let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n");
        if let Some(header_end) = header_end {
            let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_lowercase();
            let content_length = header_text
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buffer.len() >= header_end + 4 + content_length {
                break;
            }
        } else if buffer.len() > 128 * 1024 {
            break;
        }
    }

    Ok(String::from_utf8_lossy(&buffer).to_string())
}

#[tauri::command]
fn publish_text_sync_line(
    text: String,
    state: tauri::State<'_, TextSyncState>,
) -> Result<u64, String> {
    publish_text_sync_line_to_state(state.inner(), text)
}

#[tauri::command]
fn publish_text_sync_event(
    kind: String,
    payload: Value,
    state: tauri::State<'_, TextSyncState>,
) -> Result<u64, String> {
    publish_text_sync_event_to_state(state.inner(), kind, payload).map(|event| event.seq)
}

#[tauri::command]
fn start_text_sync_server(
    port: Option<u16>,
    token: Option<String>,
    state: tauri::State<'_, TextSyncState>,
    app: AppHandle,
) -> Result<TextSyncStartResult, String> {
    let token = token
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{:x}",
                StdSystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    let bind_port = port.unwrap_or(48732);
    if let Ok(runtime) = state.runtime.lock() {
        if let Some(existing) = runtime.as_ref() {
            if existing.port == bind_port && existing.token == token {
                return Ok(TextSyncStartResult {
                    url: format!("http://{}:{}", local_lan_ip(), existing.port),
                    port: existing.port,
                    token,
                });
            }
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", bind_port))
        .map_err(|e| format!("Text sync bind failed: {}", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Text sync setup failed: {}", e))?;
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));

    if let Ok(mut runtime) = state.runtime.lock() {
        if let Some(old) = runtime.take() {
            old.stop.store(true, Ordering::Relaxed);
        }

        *runtime = Some(TextSyncRuntime {
            stop: stop.clone(),
            port: actual_port,
            token: token.clone(),
        });
    }

    let server_token = token.clone();
    let lines_for_thread = state.lines.clone();
    let seq_for_thread = state.seq.clone();
    let app_for_thread = app.clone();

    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    if let Ok(request) = read_http_request(&mut stream) {
                        let response = handle_text_sync_request(
                            &request,
                            &server_token,
                            &lines_for_thread,
                            &seq_for_thread,
                            &app_for_thread,
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    });

    Ok(TextSyncStartResult {
        url: format!("http://{}:{}", local_lan_ip(), actual_port),
        port: actual_port,
        token,
    })
}

#[tauri::command]
fn stop_text_sync_server(state: tauri::State<'_, TextSyncState>) -> Result<(), String> {
    if let Ok(mut runtime) = state.runtime.lock() {
        if let Some(old) = runtime.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    Ok(())
}

#[tauri::command]
async fn poll_remote_text_sync(
    url: String,
    token: String,
    since: Option<u64>,
) -> Result<TextSyncEventsResponse, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/events?since={}",
            normalize_agent_url(&url),
            since.unwrap_or(0)
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Remote text sync request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Remote text sync request failed: {}",
            response.status()
        ));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Remote text sync read failed: {}", e))?;

    serde_json::from_str::<TextSyncEventsResponse>(&text)
        .map_err(|e| format!("Remote text sync parse failed: {}", e))
}

#[tauri::command]
async fn push_remote_text_sync_event(
    url: String,
    token: String,
    kind: String,
    payload: Value,
) -> Result<u64, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/push", normalize_agent_url(&url)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "kind": kind, "payload": payload }))
        .send()
        .await
        .map_err(|e| format!("Remote text sync push failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Remote text sync push failed: {}",
            response.status()
        ));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Remote text sync push read failed: {}", e))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Remote text sync push parse failed: {}", e))?;
    Ok(value.get("seq").and_then(|seq| seq.as_u64()).unwrap_or(0))
}

#[tauri::command]
async fn create_text_sync_cloud_room() -> Result<String, String> {
    let client = reqwest::Client::new();
    let initial = TextSyncRelayState {
        version: 1,
        device_id: String::new(),
        updated_at_ms: unix_time_ms() as u64,
        state_key: String::new(),
        payload: serde_json::json!({ "version": 1, "activeTabId": 1, "isPaused": true, "tabs": [] }),
    };
    let response = client
        .post("https://jsonblob.com/api/jsonBlob")
        .json(&initial)
        .send()
        .await
        .map_err(|e| format!("Cloud room create failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Cloud room create failed: {}", response.status()));
    }

    response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
        .ok_or_else(|| "Cloud room create failed: missing Location header".to_string())
}

#[tauri::command]
async fn push_text_sync_cloud_state(
    url: String,
    device_id: String,
    state_key: String,
    payload: Value,
) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("Cloud room URL is empty".to_string());
    }

    let body = TextSyncRelayState {
        version: 1,
        device_id,
        updated_at_ms: unix_time_ms() as u64,
        state_key,
        payload,
    };

    let response = reqwest::Client::new()
        .put(normalize_agent_url(&url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloud state push failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Cloud state push failed: {}", response.status()));
    }

    Ok(())
}

#[tauri::command]
async fn pull_text_sync_cloud_state(url: String) -> Result<Value, String> {
    if url.trim().is_empty() {
        return Err("Cloud room URL is empty".to_string());
    }

    let response = reqwest::Client::new()
        .get(normalize_agent_url(&url))
        .send()
        .await
        .map_err(|e| format!("Cloud state pull failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Cloud state pull failed: {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Cloud state parse failed: {}", e))
}

fn normalize_api_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

async fn read_account_json_response(
    response: reqwest::Response,
    action: &str,
) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("{} read failed: {}", action, e))?;
    let value: Value = serde_json::from_str(&body).map_err(|e| {
        let preview: String = body
            .chars()
            .take(220)
            .collect::<String>()
            .replace('\n', " ")
            .replace('\r', " ");
        if preview.is_empty() {
            format!(
                "{} parse failed: {}. Server returned an empty response ({})",
                action, e, status
            )
        } else {
            format!(
                "{} parse failed: {}. Server returned {}: {}",
                action, e, status, preview
            )
        }
    })?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(action)
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
fn get_windows_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Setsuna PC".to_string())
}

#[tauri::command]
async fn account_register(
    api_base_url: String,
    email: String,
    password: String,
    device_id: String,
    device_name: String,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/auth/register",
            normalize_api_base_url(&api_base_url)
        ))
        .json(&AccountAuthRequest {
            email,
            password,
            device_id,
            device_name,
        })
        .send()
        .await
        .map_err(|e| format!("Account register failed: {}", e))?;
    read_account_json_response(response, "Account register").await
}

#[tauri::command]
async fn account_login(
    api_base_url: String,
    email: String,
    password: String,
    device_id: String,
    device_name: String,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/auth/login",
            normalize_api_base_url(&api_base_url)
        ))
        .json(&AccountAuthRequest {
            email,
            password,
            device_id,
            device_name,
        })
        .send()
        .await
        .map_err(|e| format!("Account login failed: {}", e))?;
    read_account_json_response(response, "Account login").await
}

#[tauri::command]
async fn account_register_device(
    api_base_url: String,
    token: String,
    device_id: String,
    device_name: String,
    capture_agent_url: Option<String>,
    capture_agent_token: Option<String>,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/devices", normalize_api_base_url(&api_base_url)))
        .bearer_auth(token)
        .json(&AccountDeviceRequest {
            device_id,
            device_name,
            capture_agent_url,
            capture_agent_token,
        })
        .send()
        .await
        .map_err(|e| format!("Device register failed: {}", e))?;
    read_account_json_response(response, "Device register").await
}

#[tauri::command]
async fn account_list_devices(api_base_url: String, token: String) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/devices", normalize_api_base_url(&api_base_url)))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Device list failed: {}", e))?;
    read_account_json_response(response, "Device list").await
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn copy_hovered_text_to_clipboard() -> Result<GlobalLookupCopyResult, String> {
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point) == 0 {
            return Err("Could not read cursor position.".to_string());
        }
    }

    if let Some(text) = scintilla_word_under_cursor(point) {
        return Ok(GlobalLookupCopyResult {
            x: point.x,
            y: point.y,
            text: Some(text.clone()),
            context: Some(text),
            cursor: Some(0),
        });
    }

    if let Some((context, cursor)) = uia_context_under_cursor(point) {
        let text =
            uia_text_under_cursor(point).or_else(|| english_token_near_cursor(&context, cursor));
        return Ok(GlobalLookupCopyResult {
            x: point.x,
            y: point.y,
            text,
            context: Some(context),
            cursor: Some(cursor),
        });
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let fallback = (|| -> Option<String> {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            uia_name_from_point(&automation, point)
        })();
        CoUninitialize();

        if let Some(context) = fallback {
            let cursor = context.chars().count() / 2;
            let text = clean_uia_lookup_text(&context).or_else(|| Some(context.clone()));
            return Ok(GlobalLookupCopyResult {
                x: point.x,
                y: point.y,
                text,
                context: Some(context),
                cursor: Some(cursor),
            });
        }
    }

    Ok(GlobalLookupCopyResult {
        x: point.x,
        y: point.y,
        text: None,
        context: None,
        cursor: None,
    })
}

/// Names the reason point-based lookup cannot run. Returns an i18n key rather
/// than prose so the lookup window can render it in the selected language;
/// Wayland is a hard blocker rather than merely unfinished work, and the two
/// cases are separate keys so translations can say so.
#[cfg(not(target_os = "windows"))]
fn global_lookup_unavailable_reason(feature: &str) -> String {
    #[cfg(target_os = "linux")]
    let on_wayland = hover_lookup::is_wayland_session();
    #[cfg(not(target_os = "linux"))]
    let on_wayland = false;

    if on_wayland {
        format!("lookup.error.{feature}Wayland")
    } else {
        format!("lookup.error.{feature}Unsupported")
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn copy_hovered_text_to_clipboard() -> Result<GlobalLookupCopyResult, String> {
    if hover_lookup::is_wayland_session() {
        return Err(global_lookup_unavailable_reason("hover"));
    }

    let (x, y) = hover_lookup::pointer_position()?;
    let hovered = hover_lookup::text_at_point(x, y).await?;

    Ok(GlobalLookupCopyResult {
        x,
        y,
        text: hovered.text,
        context: hovered.context,
        cursor: hovered.cursor,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
#[tauri::command]
fn copy_hovered_text_to_clipboard() -> Result<GlobalLookupCopyResult, String> {
    Err(global_lookup_unavailable_reason("hover"))
}

#[tauri::command]
fn start_capture_agent_server(
    port: Option<u16>,
    token: Option<String>,
    state: tauri::State<'_, CaptureAgentState>,
) -> Result<CaptureAgentStartResult, String> {
    let token = token
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    let bind_port = port.unwrap_or(48731);
    let listener = TcpListener::bind(("0.0.0.0", bind_port))
        .map_err(|e| format!("Capture agent bind failed: {}", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Capture agent setup failed: {}", e))?;
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));

    if let Ok(mut runtime) = state.runtime.lock() {
        if let Some(old) = runtime.take() {
            old.stop.store(true, Ordering::Relaxed);
        }

        *runtime = Some(CaptureAgentRuntime {
            stop: stop.clone(),
            port: actual_port,
            token: token.clone(),
        });
    }

    let server_token = token.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    let mut buffer = [0_u8; 8192];
                    if let Ok(size) = stream.read(&mut buffer) {
                        let request = String::from_utf8_lossy(&buffer[..size]).to_string();
                        let response = handle_capture_agent_request(&request, &server_token);
                        let _ = stream.write_all(response.as_bytes());
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    });

    Ok(CaptureAgentStartResult {
        url: format!("http://{}:{}", local_lan_ip(), actual_port),
        port: actual_port,
        token,
    })
}

#[tauri::command]
fn stop_capture_agent_server(state: tauri::State<'_, CaptureAgentState>) -> Result<(), String> {
    if let Ok(mut runtime) = state.runtime.lock() {
        if let Some(old) = runtime.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    Ok(())
}

fn normalize_agent_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

#[tauri::command]
async fn list_remote_capture_sources(
    url: String,
    token: String,
) -> Result<Vec<CaptureWindowInfo>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/sources", normalize_agent_url(&url)))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Remote capture source request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Remote capture source request failed: {}",
            response.status()
        ));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Remote capture source read failed: {}", e))?;

    serde_json::from_str::<RemoteSourcesResponse>(&text)
        .map(|body| body.sources)
        .map_err(|e| format!("Remote capture source parse failed: {}", e))
}

#[tauri::command]
async fn take_remote_capture_screenshot(
    url: String,
    token: String,
    pid: u32,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/capture?pid={}", normalize_agent_url(&url), pid))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Remote screenshot request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Remote screenshot request failed: {}",
            response.status()
        ));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Remote screenshot read failed: {}", e))?;

    serde_json::from_str::<RemoteCaptureResponse>(&text)
        .map(|body| Some(body.image))
        .map_err(|e| format!("Remote screenshot parse failed: {}", e))
}

#[tauri::command]
async fn take_smart_screenshot(
    processes: Vec<serde_json::Value>,
    history: tauri::State<'_, ForegroundHistory>,
) -> Result<Option<String>, String> {
    let targets = parse_screenshot_targets(processes);

    if targets.is_empty() {
        return Ok(None);
    }

    let recent_hwnds: Vec<u64> = history
        .hwnds
        .lock()
        .map(|hwnds| hwnds.iter().copied().collect())
        .unwrap_or_default();

    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let process_map = running_process_map();

        let windows = xcap::Window::all().map_err(|e| format!("Window lookup failed: {}", e))?;
        let mut best_window = None;
        let mut best_score = 0_u64;
        let mut visible_windows = Vec::new();

        #[cfg(target_os = "windows")]
        let foreground_id = unsafe { GetForegroundWindow() as u64 };
        #[cfg(not(target_os = "windows"))]
        let foreground_id = 0_u64;

        for window in windows {
            let width = window.width().unwrap_or(0);
            let height = window.height().unwrap_or(0);

            if width < 80 || height < 80 || window.is_minimized().unwrap_or(false) {
                continue;
            }

            let app_name = window.app_name().unwrap_or_default().to_lowercase();
            let title = window.title().unwrap_or_default().to_lowercase();
            let pid = window.pid().unwrap_or(0);
            let (proc_name, proc_path) = process_map
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| (String::new(), String::new()));
            let proc_name_lc = normalize_process_name(&proc_name);
            let proc_path_lc = proc_path.to_lowercase();
            let mut matched_by_pid = false;
            let mut matched_by_text = false;

            for target in &targets {
                let target_path_lc = target.path.to_lowercase();
                let target_name_lc = normalize_process_name(&target.name);

                if !target_path_lc.is_empty() && !proc_path_lc.is_empty() && proc_path_lc == target_path_lc {
                    matched_by_pid = true;
                    break;
                }

                if !target_name_lc.is_empty() && proc_name_lc == target_name_lc {
                    matched_by_pid = true;
                    break;
                }

                for alias in process_target_aliases(target) {
                    if app_name.contains(&alias) || title.contains(&alias) {
                        matched_by_text = true;
                    }
                }
            }

            visible_windows.push(format!(
                "{} | {} | {} | {}x{}",
                proc_name,
                window.title().unwrap_or_default(),
                proc_path,
                width,
                height
            ));

            let is_target = matched_by_pid || matched_by_text;

            if !is_target {
                continue;
            }

            let window_id = window.id().unwrap_or(0) as u64;
            let area = (width as u64).saturating_mul(height as u64);
            let foreground_bonus = if foreground_id != 0 && window_id == foreground_id {
                10_000_000_000_u64
            } else {
                0
            };
            let focused_bonus = if window.is_focused().unwrap_or(false) {
                5_000_000_000_u64
            } else {
                0
            };
            let recent_bonus = recent_hwnds
                .iter()
                .position(|hwnd| *hwnd == window_id)
                .map(|idx| 4_000_000_000_u64.saturating_sub((idx as u64).saturating_mul(100_000_000)))
                .unwrap_or(0);
            let score = foreground_bonus
                .saturating_add(focused_bonus)
                .saturating_add(recent_bonus)
                .saturating_add(if matched_by_pid { 2_000_000_000_u64 } else { 0 })
                .saturating_add(area);

            if score > best_score {
                best_score = score;
                best_window = Some(window);
            }
        }

        let window = best_window.ok_or_else(|| {
            let selected = targets
                .iter()
                .map(|target| if target.path.is_empty() { target.name.clone() } else { format!("{} ({})", target.name, target.path) })
                .collect::<Vec<_>>()
                .join(", ");
            let examples = visible_windows.into_iter().take(8).collect::<Vec<_>>().join("\n");
            format!(
                "No visible window was found for the selected screenshot processes: {}.\nVisible windows:\n{}",
                selected,
                examples
            )
        })?;

        Ok(Some(encode_window_jpeg(window)?))
    })
    .await
    .map_err(|e| format!("Screenshot worker failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE entries (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, definition TEXT NOT NULL, dict_name TEXT DEFAULT 'Unknown', tags TEXT DEFAULT '')",
            [],
        )
        .unwrap();
        db.execute(
            "CREATE TABLE frequencies (term TEXT NOT NULL, reading TEXT, value INTEGER, display_value TEXT, dict_name TEXT)",
            [],
        )
        .unwrap();
        db.execute(
            "CREATE TABLE pitches (term TEXT NOT NULL, reading TEXT, position INTEGER, dict_name TEXT)",
            [],
        )
        .unwrap();
        db.execute(
            "CREATE TABLE pronunciations (term TEXT NOT NULL, reading TEXT, ipa TEXT NOT NULL, tags TEXT, dict_name TEXT)",
            [],
        )
        .unwrap();
        db
    }

    fn lookup_in_test_db(
        db: &Connection,
        word: &str,
        source_len: usize,
        max_depth: usize,
    ) -> Vec<DictEntry> {
        let rules = load_rules();
        let mut freq_stmt = db
            .prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 16")
            .unwrap();
        let mut pitch_stmt = db
            .prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '') LIMIT 16")
            .unwrap();
        let mut pronunciation_stmt = db
            .prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32")
            .unwrap();
        let mut stmt = db
            .prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term != '' AND (e.term IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) OR (e.reading != '' AND e.reading IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))) ORDER BY CASE WHEN e.term = ?1 THEN 0 WHEN e.reading = ?1 THEN 1 WHEN e.term IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 2 WHEN e.reading IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 3 ELSE 4 END, e.id ASC LIMIT 80")
            .unwrap();

        internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            word,
            &rules,
            source_len,
            max_depth,
        )
    }

    #[test]
    fn lookup_deinflects_passive_ongoing_ku_verb() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params!["敷く", "しく", "to spread"],
        )
        .unwrap();

        let entries = lookup_in_test_db(&db, "敷かれている", 6, LOOKUP_SCAN_DEINFLECT_DEPTH);

        assert!(entries
            .iter()
            .any(|entry| entry.term == "敷く" && entry.source_length == 6));
    }

    #[test]
    fn metadata_only_english_dictionaries_are_returned_by_lookup() {
        let db = test_db();
        db.execute(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["abandon", "", 3, "B1", "English CEFR Labels"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO pronunciations (term, reading, ipa, tags, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["abandon", "abandon", "/əˈbændən/", "UK", "seth-oald-ipa"],
        )
        .unwrap();

        let entries = lookup_in_test_db(&db, "abandon", 7, 0);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].frequencies[0].display_value, "B1");
        assert_eq!(entries[0].pronunciations[0].ipa, "/əˈbændən/");
    }

    #[test]
    fn lookup_deinflects_polite_passive_ru_verb() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params!["謀る", "はかる", "to plot"],
        )
        .unwrap();

        let entries = lookup_in_test_db(&db, "謀られました", 6, LOOKUP_SCAN_DEINFLECT_DEPTH);

        assert!(entries
            .iter()
            .any(|entry| entry.term == "謀る" && entry.source_length == 6));
    }

    #[test]
    fn lookup_deinflects_formal_ongoing_mu_verb() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params!["営む", "いとなむ", "to run a business"],
        )
        .unwrap();

        let entries = lookup_in_test_db(&db, "営まれております", 8, LOOKUP_SCAN_DEINFLECT_DEPTH);

        assert!(entries
            .iter()
            .any(|entry| entry.term == "営む" && entry.source_length == 8));
    }

    #[test]
    fn contextual_furigana_handles_compound_suffix_nai() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, '[]', 'test', '')",
            params!["\u{65BD}\u{8A2D}", "\u{3057}\u{305B}\u{3064}"],
        )
        .unwrap();

        let mut stmt = db
            .prepare("SELECT reading FROM entries WHERE term = ?1 AND reading != term AND reading NOT LIKE '% %' AND reading NOT LIKE '%.%' AND dict_name NOT LIKE '%kanji%' COLLATE NOCASE ORDER BY (SELECT value FROM frequencies WHERE frequencies.term = entries.term AND (frequencies.reading = entries.reading OR frequencies.reading = '') LIMIT 1) ASC NULLS LAST LIMIT 8")
            .unwrap();
        let chars: Vec<char> = "\u{65BD}\u{8A2D}\u{5185}".chars().collect();
        let tokens = contextual_furigana_tokens(&mut stmt, &[], &chars).unwrap();

        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].text, "\u{65BD}\u{8A2D}");
        assert_eq!(
            tokens[0].reading.as_deref(),
            Some("\u{3057}\u{305B}\u{3064}")
        );
        assert_eq!(tokens[1].text, "\u{5185}");
        assert_eq!(tokens[1].reading.as_deref(), Some("\u{306A}\u{3044}"));
    }

    #[test]
    fn furigana_slice_keeps_reading_from_context_token() {
        let tokens = vec![TextToken {
            text: "\u{5236}\u{5FA1}\u{5BA4}".to_string(),
            reading: Some("\u{305B}\u{3044}\u{304E}\u{3087}\u{3057}\u{3064}".to_string()),
        }];

        let sliced = slice_furigana_tokens(&tokens, 1, 2);

        assert_eq!(sliced.len(), 1);
        assert_eq!(sliced[0].text, "\u{5FA1}\u{5BA4}");
        assert_eq!(
            sliced[0].reading.as_deref(),
            Some("\u{305B}\u{3044}\u{304E}\u{3087}\u{3057}\u{3064}")
        );
    }

    #[test]
    fn furigana_lookup_prefers_contextual_morph_reading() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, '[]', 'test', '')",
            params!["\u{5165}\u{308B}", "\u{3044}\u{308B}"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, '[]', 'test', '')",
            params!["\u{5165}\u{308B}", "\u{306F}\u{3044}\u{308B}"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, 1, '1', 'freq')",
            params!["\u{5165}\u{308B}", "\u{3044}\u{308B}"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, 100, '100', 'freq')",
            params!["\u{5165}\u{308B}", "\u{306F}\u{3044}\u{308B}"],
        )
        .unwrap();

        let mut stmt = db
            .prepare("SELECT reading FROM entries WHERE term = ?1 AND reading != term AND reading NOT LIKE '% %' AND reading NOT LIKE '%.%' AND dict_name NOT LIKE '%kanji%' COLLATE NOCASE ORDER BY (SELECT value FROM frequencies WHERE frequencies.term = entries.term AND (frequencies.reading = entries.reading OR frequencies.reading = '') LIMIT 1) ASC NULLS LAST LIMIT 8")
            .unwrap();

        assert_eq!(
            lookup_furigana_reading_prefer(
                &mut stmt,
                "\u{5165}\u{308B}",
                Some("\u{306F}\u{3044}\u{308B}")
            )
            .as_deref(),
            Some("\u{306F}\u{3044}\u{308B}")
        );
    }

    #[test]
    fn lookup_kana_stem_finds_kanji_dictionary_entry_by_reading() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params!["\u{8DE8}\u{304C}\u{308B}", "\u{307E}\u{305F}\u{304C}\u{308B}", "to extend over"],
        )
        .unwrap();

        let rules = load_rules();
        let mut freq_stmt = db
            .prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 16")
            .unwrap();
        let mut pitch_stmt = db
            .prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '') LIMIT 16")
            .unwrap();
        let mut pronunciation_stmt = db
            .prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32")
            .unwrap();
        let mut stmt = db
            .prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term != '' AND (e.term IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) OR (e.reading != '' AND e.reading IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))) ORDER BY CASE WHEN e.term = ?1 THEN 0 WHEN e.reading = ?1 THEN 1 WHEN e.term IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 2 WHEN e.reading IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 3 ELSE 4 END, e.id ASC LIMIT 80")
            .unwrap();

        let entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            "\u{307E}\u{305F}\u{304C}\u{308A}",
            &rules,
            4,
            1,
        );
        assert!(entries
            .iter()
            .any(|entry| entry.term == "\u{8DE8}\u{304C}\u{308B}"
                && entry.reading == "\u{307E}\u{305F}\u{304C}\u{308B}"));
    }

    #[test]
    fn plain_katakana_lookup_does_not_promote_kanji_homophones() {
        let entries = vec![
            DictEntry {
                term: "\u{5C3A}\u{86FE}".to_string(),
                reading: "\u{30B7}\u{30E3}\u{30AF}\u{30AC}".to_string(),
                definition: "geometer moth".to_string(),
                dict_name: "test".to_string(),
                tags: String::new(),
                deinflection_reasons: Vec::new(),
                frequencies: Vec::new(),
                pitches: Vec::new(),
                pronunciations: Vec::new(),
                source_length: 4,
            },
            DictEntry {
                term: "\u{30B7}\u{30E3}\u{30AF}\u{30AC}".to_string(),
                reading: "\u{30B7}\u{30E3}\u{30AF}\u{30AC}".to_string(),
                definition: "literal katakana".to_string(),
                dict_name: "test".to_string(),
                tags: String::new(),
                deinflection_reasons: Vec::new(),
                frequencies: Vec::new(),
                pitches: Vec::new(),
                pronunciations: Vec::new(),
                source_length: 4,
            },
        ];

        let filtered = keep_literal_kana_entries(entries, "\u{30B7}\u{30E3}\u{30AF}\u{30AC}");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].term, "\u{30B7}\u{30E3}\u{30AF}\u{30AC}");
    }

    #[test]
    fn plain_katakana_lookup_keeps_reading_matches_without_literal_surface() {
        let entries = vec![DictEntry {
            term: "\u{73C8}\u{7432}".to_string(),
            reading: "\u{30B3}\u{30FC}\u{30D2}\u{30FC}".to_string(),
            definition: "coffee".to_string(),
            dict_name: "test".to_string(),
            tags: String::new(),
            deinflection_reasons: Vec::new(),
            frequencies: Vec::new(),
            pitches: Vec::new(),
            pronunciations: Vec::new(),
            source_length: 4,
        }];

        let filtered = keep_literal_kana_entries(entries, "\u{30B3}\u{30FC}\u{30D2}\u{30FC}");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].term, "\u{73C8}\u{7432}");
    }

    #[test]
    fn lookup_deinflects_long_i_adjective_forms() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params![
                "\u{611F}\u{6168}\u{6DF1}\u{3044}",
                "\u{304B}\u{3093}\u{304C}\u{3044}\u{3076}\u{304B}\u{3044}",
                "deep emotion"
            ],
        )
        .unwrap();

        let rules = load_rules();
        let mut freq_stmt = db
            .prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 16")
            .unwrap();
        let mut pitch_stmt = db
            .prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '') LIMIT 16")
            .unwrap();
        let mut pronunciation_stmt = db
            .prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32")
            .unwrap();
        let mut stmt = db
            .prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term != '' AND (e.term IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) OR (e.reading != '' AND e.reading IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8))) ORDER BY CASE WHEN e.term = ?1 THEN 0 WHEN e.reading = ?1 THEN 1 WHEN e.term IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 2 WHEN e.reading IN (?2, ?3, ?4, ?5, ?6, ?7, ?8) THEN 3 ELSE 4 END, e.id ASC LIMIT 80")
            .unwrap();

        let entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            "\u{611F}\u{6168}\u{6DF1}\u{304F}",
            &rules,
            4,
            1,
        );

        assert!(entries.iter().any(|entry| {
            entry.term == "\u{611F}\u{6168}\u{6DF1}\u{3044}" && entry.source_length == 4
        }));
    }

    #[test]
    fn scan_cursor_does_not_cross_particle_before_cursor() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params![
                "\u{982C}\u{3092}\u{7D05}\u{6F6E}\u{3055}\u{305B}\u{308B}",
                "\u{307B}\u{304A}\u{3092}\u{3053}\u{3046}\u{3061}\u{3087}\u{3046}\u{3055}\u{305B}\u{308B}",
                "to make cheeks blush"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params![
                "\u{7D05}\u{6F6E}\u{3055}\u{305B}\u{308B}",
                "\u{3053}\u{3046}\u{3061}\u{3087}\u{3046}\u{3055}\u{305B}\u{308B}",
                "to flush"
            ],
        )
        .unwrap();

        let sentence = "\u{982C}\u{3092}\u{7D05}\u{6F6E}\u{3055}\u{305B}\u{3066}\u{3002}";
        let result = scan_cursor_in_db(&db, sentence, 6).unwrap();

        assert_eq!(result.match_start, 2);
        assert_eq!(result.match_len, 5);
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{7D05}\u{6F6E}\u{3055}\u{305B}\u{308B}"));
        assert!(!result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{982C}\u{3092}\u{7D05}\u{6F6E}\u{3055}\u{305B}\u{308B}"));
    }

    #[test]
    fn scan_cursor_handles_katakana_surface_word() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{30B3}\u{30F3}\u{30D3}\u{30CB}",
                "\u{30B3}\u{30F3}\u{30D3}\u{30CB}",
                "convenience store"
            ],
        )
        .unwrap();

        let sentence = "\u{30B3}\u{30F3}\u{30D3}\u{30CB}\u{3067}\u{8CB7}\u{3046}";
        let result = scan_cursor_in_db(&db, sentence, 2).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 4);
        assert_eq!(result.word, "\u{30B3}\u{30F3}\u{30D3}\u{30CB}");
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{30B3}\u{30F3}\u{30D3}\u{30CB}"));
    }

    #[test]
    fn scan_cursor_handles_katakana_reading_without_literal_surface() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{73C8}\u{7432}",
                "\u{30B3}\u{30FC}\u{30D2}\u{30FC}",
                "coffee"
            ],
        )
        .unwrap();

        let sentence = "\u{30B3}\u{30FC}\u{30D2}\u{30FC}\u{3092}\u{98F2}\u{3080}";
        let result = scan_cursor_in_db(&db, sentence, 2).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 4);
        assert_eq!(result.word, "\u{30B3}\u{30FC}\u{30D2}\u{30FC}");
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{73C8}\u{7432}"));
    }

    #[test]
    fn scan_cursor_prefers_compound_word_over_single_kanji_entry() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{5177}\u{5408}",
                "\u{3050}\u{3042}\u{3044}",
                "condition"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'kanjidic', '')",
            params!["\u{5408}", "\u{3042}", "fit"],
        )
        .unwrap();

        let sentence = "\u{826F}\u{3044}\u{5177}\u{5408}\u{306B}";
        let result = scan_cursor_in_db(&db, sentence, 3).unwrap();

        assert_eq!(result.match_start, 2);
        assert_eq!(result.match_len, 2);
        assert_eq!(result.word, "\u{5177}\u{5408}");
    }

    #[test]
    fn scan_cursor_prefers_word_before_trailing_particle() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'adj-na')",
            params![
                "\u{76DB}\u{5927}",
                "\u{305B}\u{3044}\u{3060}\u{3044}",
                "grand"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'exp')",
            params![
                "\u{76DB}\u{5927}\u{306B}",
                "\u{305B}\u{3044}\u{3060}\u{3044}\u{306B}",
                "grandly"
            ],
        )
        .unwrap();

        let sentence = "\u{76DB}\u{5927}\u{306B}\u{3063}";
        let result = scan_cursor_in_db(&db, sentence, 1).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 2);
        assert_eq!(result.word, "\u{76DB}\u{5927}");
    }

    #[test]
    fn scan_cursor_can_still_backtrack_inside_one_word() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params![
                "\u{611F}\u{6168}\u{6DF1}\u{3044}",
                "\u{304B}\u{3093}\u{304C}\u{3044}\u{3076}\u{304B}\u{3044}",
                "deep emotion"
            ],
        )
        .unwrap();

        let sentence = "\u{611F}\u{6168}\u{6DF1}\u{304F}";
        let result = scan_cursor_in_db(&db, sentence, 2).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 4);
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{611F}\u{6168}\u{6DF1}\u{3044}"));
    }

    #[test]
    fn scan_cursor_selects_complete_negative_verb_form() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v1 vt')",
            params![
                "\u{898B}\u{3048}\u{308B}",
                "\u{307F}\u{3048}\u{308B}",
                "to be visible"
            ],
        )
        .unwrap();

        let sentence = "\u{5F7C}\u{304C}\u{898B}\u{3048}\u{306A}\u{3044}\u{3093}\u{3060}\u{3051}\u{3069}\u{3002}";
        for cursor in 2..6 {
            let result = scan_cursor_in_db(&db, sentence, cursor).unwrap();
            assert_eq!(result.match_start, 2, "cursor={cursor}");
            assert_eq!(result.match_len, 4, "cursor={cursor}");
            assert_eq!(
                result.word, "\u{898B}\u{3048}\u{306A}\u{3044}",
                "cursor={cursor}"
            );
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.term == "\u{898B}\u{3048}\u{308B}"));
        }
    }

    #[test]
    fn scan_cursor_selects_complete_polite_u_verb_form() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v5u vt')",
            params![
                "\u{884C}\u{3046}",
                "\u{304A}\u{3053}\u{306A}\u{3046}",
                "to perform"
            ],
        )
        .unwrap();

        let sentence = "\u{4F5C}\u{696D}\u{3092}\u{884C}\u{3044}\u{307E}\u{3059}\u{3002}";
        for cursor in 3..7 {
            let result = scan_cursor_in_db(&db, sentence, cursor).unwrap();
            assert_eq!(result.match_start, 3, "cursor={cursor}");
            assert_eq!(result.match_len, 4, "cursor={cursor}");
            assert_eq!(
                result.word, "\u{884C}\u{3044}\u{307E}\u{3059}",
                "cursor={cursor}"
            );
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.term == "\u{884C}\u{3046}"));
        }
    }

    #[test]
    fn scan_cursor_keeps_masu_stem_noun_before_particle() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{53D7}\u{3051}\u{53D6}\u{308A}",
                "\u{3046}\u{3051}\u{3068}\u{308A}",
                "receipt"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v5r vt')",
            params![
                "\u{53D7}\u{3051}\u{53D6}\u{308B}",
                "\u{3046}\u{3051}\u{3068}\u{308B}",
                "to receive"
            ],
        )
        .unwrap();

        let sentence = "\u{53D7}\u{3051}\u{53D6}\u{308A}\u{3092}\u{884C}\u{3046}";
        for cursor in 0..4 {
            let result = scan_cursor_in_db(&db, sentence, cursor).unwrap();
            assert_eq!(result.match_start, 0, "cursor={cursor}");
            assert_eq!(result.match_len, 4, "cursor={cursor}");
            assert_eq!(
                result.word, "\u{53D7}\u{3051}\u{53D6}\u{308A}",
                "cursor={cursor}"
            );
            assert!(result.entries.iter().any(|entry| {
                entry.term == "\u{53D7}\u{3051}\u{53D6}\u{308A}"
                    && entry.deinflection_reasons.is_empty()
            }));
        }

        let polite_sentence = "\u{53D7}\u{3051}\u{53D6}\u{308A}\u{307E}\u{3059}\u{3002}";
        for cursor in 0..6 {
            let result = scan_cursor_in_db(&db, polite_sentence, cursor).unwrap();
            assert_eq!(result.match_start, 0, "cursor={cursor}");
            assert_eq!(result.match_len, 6, "cursor={cursor}");
            assert_eq!(
                result.word, "\u{53D7}\u{3051}\u{53D6}\u{308A}\u{307E}\u{3059}",
                "cursor={cursor}"
            );
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.term == "\u{53D7}\u{3051}\u{53D6}\u{308B}"));
        }
    }

    #[test]
    fn scan_cursor_prefers_full_renyoukei_before_no_particle() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{7A81}\u{3063}\u{5F35}",
                "\u{3064}\u{3063}\u{3071}\u{308A}",
                "short dictionary headword"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v5r vt')",
            params![
                "\u{7A81}\u{3063}\u{5F35}\u{308B}",
                "\u{3064}\u{3063}\u{3071}\u{308B}",
                "to brace"
            ],
        )
        .unwrap();

        let sentence = "\u{7A81}\u{3063}\u{5F35}\u{308A}\u{306E}\u{56DE}\u{8EE2}\u{901F}\u{5EA6}";
        for cursor in 0..4 {
            let result = scan_cursor_in_db(&db, sentence, cursor).unwrap();
            assert_eq!(result.match_start, 0, "cursor={cursor}");
            assert_eq!(result.match_len, 4, "cursor={cursor}");
            assert_eq!(result.word, "\u{7A81}\u{3063}\u{5F35}\u{308A}", "cursor={cursor}");
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.term == "\u{7A81}\u{3063}\u{5F35}\u{308B}"));
        }
    }

    #[test]
    fn scan_cursor_rejects_deinflected_noun_homophone() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params!["\u{5225}", "\u{3079}\u{3064}", "different"],
        )
        .unwrap();

        let sentence = "\u{3079}\u{3063}\u{305F}\u{308A}";
        let result = scan_cursor_in_db(&db, sentence, 0);

        assert!(result.is_err());
    }

    #[test]
    fn lookup_prefers_plausible_kana_deinflection() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v5r vi')",
            params![
                "\u{65E5}\u{548C}\u{308B}",
                "\u{3072}\u{3088}\u{308B}",
                "wait and see"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'v1 vi')",
            params![
                "\u{5E72}\u{308B}",
                "\u{3072}\u{308B}",
                "dry"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n vs vi')",
            params![
                "\u{98DB}\u{63DA}",
                "\u{3072}\u{3088}\u{3046}",
                "soaring"
            ],
        )
        .unwrap();

        let sentence = "\u{3072}\u{3088}\u{3063}\u{305F}\u{3002}";
        let result = scan_cursor_in_db(&db, sentence, 1).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 4);
        assert_eq!(result.entries[0].term, "\u{65E5}\u{548C}\u{308B}");
        assert!(!result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{5E72}\u{308B}"));
        assert!(!result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{98DB}\u{63DA}"));
    }

    #[test]
    fn scan_cursor_prefers_word_after_kana_boundary_over_expression() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'exp')",
            params![
                "\u{826F}\u{3044}\u{5177}\u{5408}\u{306B}",
                "\u{3088}\u{3044}\u{3050}\u{3042}\u{3044}\u{306B}",
                "nicely"
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', 'n')",
            params![
                "\u{5177}\u{5408}",
                "\u{3050}\u{3042}\u{3044}",
                "condition"
            ],
        )
        .unwrap();

        let sentence = "\u{826F}\u{3044}\u{5177}\u{5408}\u{306B}\u{4F55}\u{304B}";
        let result = scan_cursor_in_db(&db, sentence, 2).unwrap();
        let result_inside_noun = scan_cursor_in_db(&db, sentence, 3).unwrap();

        assert_eq!(result.match_start, 2);
        assert_eq!(result.match_len, 2);
        assert_eq!(result.word, "\u{5177}\u{5408}");
        assert_eq!(result_inside_noun.match_start, 2);
        assert_eq!(result_inside_noun.match_len, 2);
        assert_eq!(result_inside_noun.word, "\u{5177}\u{5408}");
    }

    #[test]
    fn scan_cursor_falls_back_from_numbered_japanese_expression() {
        let db = test_db();
        db.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, 'test', '')",
            params![
                "\u{65E5}\u{5F8C}",
                "\u{306B}\u{3061}\u{3054}",
                "days later"
            ],
        )
        .unwrap();

        let sentence = "\u{0034}\u{65E5}\u{5F8C}\u{2014}";
        let result = scan_cursor_in_db(&db, sentence, 0).unwrap();

        assert_eq!(result.match_start, 0);
        assert_eq!(result.match_len, 3);
        assert_eq!(result.word, "\u{0034}\u{65E5}\u{5F8C}");
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "\u{65E5}\u{5F8C}" && entry.source_length == 3));
    }

    #[test]
    fn english_token_bounds_handles_contractions_and_hyphens() {
        let chars: Vec<char> = "I don't want a half-baked fix.".chars().collect();

        assert_eq!(english_token_bounds(&chars, 3), Some((2, 5)));
        assert_eq!(english_token_bounds(&chars, 18), Some((15, 10)));
        assert_eq!(english_token_bounds(&chars, 0), Some((0, 1)));
        assert_eq!(english_token_bounds(&chars, 29), None);
    }

    #[test]
    fn english_token_near_cursor_extracts_the_whole_hovered_word() {
        let sentence = "Open the half-baked dictionary entry";
        let cursor = sentence.find("baked").unwrap() + 2;
        assert_eq!(
            english_token_near_cursor(sentence, cursor).as_deref(),
            Some("half-baked")
        );
        let after_word = sentence.find("dictionary").unwrap() + "dictionary".len();
        assert_eq!(
            english_token_near_cursor(sentence, after_word).as_deref(),
            Some("dictionary")
        );

        assert_eq!(
            english_token_near_cursor("      hover", 0).as_deref(),
            Some("hover")
        );
    }

    #[test]
    fn english_lookup_forms_include_case_variants() {
        let forms = lookup_forms("Running");

        assert!(forms.contains(&"Running".to_string()));
        assert!(forms.contains(&"running".to_string()));
        assert!(forms.contains(&"run".to_string()));
        assert!(forms.contains(&"RUNNING".to_string()));
    }

    #[test]
    fn english_lookup_forms_include_common_base_forms() {
        assert!(lookup_forms("studies").contains(&"study".to_string()));
        assert!(lookup_forms("liked").contains(&"like".to_string()));
        assert!(lookup_forms("dogs").contains(&"dog".to_string()));
    }

    #[test]
    fn resumable_upload_range_uses_only_confirmed_bytes() {
        assert_eq!(resumable_next_offset(Some("bytes=0-8388607")), 8_388_608);
        assert_eq!(resumable_next_offset(Some("0-42")), 43);
        assert_eq!(resumable_next_offset(None), 0);
        assert_eq!(resumable_next_offset(Some("invalid")), 0);
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn show_main_from_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit("setsuna://tray-state", false);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn hide_windows_to_tray(app: &AppHandle) {
    let discord_state = app.state::<DiscordPresenceState>();
    let _ = clear_discord_runtime(discord_state.inner());
    let _ = app.emit("setsuna://tray-state", true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("jl_mode") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("jl_lookup") {
        let _ = window.hide();
    }
    let state = app.state::<BrowserState>();
    if let Ok(tabs) = state.inner().tabs.try_lock() {
        for window in tabs.values() {
            let _ = window.hide();
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray_show", "Открыть Setsuna", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("setsuna-tray")
        .tooltip("Setsuna")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_from_tray(app),
            "tray_quit" => {
                APP_EXIT_REQUESTED.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_from_tray(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
async fn update_discord_presence(
    payload: DiscordPresencePayload,
    state: tauri::State<'_, DiscordPresenceState>,
) -> Result<(), String> {
    let runtime = Arc::clone(&state.runtime);
    tauri::async_runtime::spawn_blocking(move || {
        update_discord_presence_blocking(payload, &runtime)
    })
    .await
    .map_err(|e| format!("Discord RPC task failed: {}", e))?
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DriveTransferProgress {
    operation: String,
    transferred: u64,
    total: u64,
    percent: u8,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryStorageInfo {
    path: String,
    size: u64,
    available_bytes: Option<u64>,
}

// Inside an AppImage the bundled GTK and mesa libraries frequently disagree
// with the host GPU driver, and WebKitGTK's DMA-BUF renderer then leaves the
// webview blank after a resize. Falling back to the older renderer fixes the
// blank paint but costs real compositing performance, so it is scoped to the
// AppImage rather than applied to every Linux install. Native packages use the
// system libraries and do not need it. Set the variable yourself to force
// either behaviour anywhere.
#[cfg(target_os = "linux")]
fn configure_linux_webview_environment() {
    // WebKitGTK only composites on the GPU on demand, dropping back to CPU
    // painting for ordinary content. Forcing it on keeps scrolling and resizing
    // on the GPU, which matters most on HiDPI screens where the CPU path has to
    // push four times the pixels.
    if std::env::var_os("WEBKIT_FORCE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
    }

    let running_from_appimage = std::env::var_os("APPIMAGE").is_some();
    if running_from_appimage && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    // Must happen before any GTK or WebKit initialisation.
    #[cfg(target_os = "linux")]
    configure_linux_webview_environment();

    install_panic_logger();

    let browser_state = BrowserState {
        tabs: Mutex::new(HashMap::new()),
    };
    let foreground_history = ForegroundHistory {
        hwnds: Mutex::new(VecDeque::with_capacity(24)),
    };
    let capture_agent_state = CaptureAgentState {
        runtime: Mutex::new(None),
    };
    let text_sync_state = TextSyncState {
        runtime: Mutex::new(None),
        lines: Arc::new(Mutex::new(VecDeque::with_capacity(500))),
        seq: Arc::new(Mutex::new(0)),
    };
    let discord_presence_state = DiscordPresenceState {
        runtime: Arc::new(Mutex::new(None)),
    };
    let diagnostics_state = DiagnosticsState {
        frontend: Mutex::new(None),
    };
    let jl_mode_state = JlModeState {
        last_line: Mutex::new(String::new()),
    };
    let jl_lookup_state = JlLookupState {
        payload: Mutex::new(None),
    };
    let flow_timer_state = FlowTimerState {
        paused: AtomicBool::new(true),
    };

    let builder = tauri::Builder::default();

    // Register this first so a repeated launch exits before creating windows or a tray icon.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_from_tray(app);
    }));

    let builder = builder.plugin(tauri_plugin_opener::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_filename(".setsuna-main-window-state.json")
            .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
            .with_filter(|label| label == "main")
            .build(),
    );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(browser_state)
        .manage(foreground_history)
        .manage(capture_agent_state)
        .manage(text_sync_state)
        .manage(discord_presence_state)
        .manage(diagnostics_state)
        .manage(jl_mode_state)
        .manage(jl_lookup_state)
        .manage(flow_timer_state)
        .invoke_handler(tauri::generate_handler![
            import_dictionary,
            import_dictionaries,
            import_epub,
            get_diagnostics_log_path,
            log_frontend_diagnostics,
            lookup_word,
            lookup_cambridge_api,
            get_installed_dicts,
            check_dictionary_updates,
            update_dictionary_from_source,
            manage_browser,
            emit_browser_meta,
            get_browser_info,
            open_jl_mode_window,
            close_jl_mode_window,
            show_jl_lookup_window,
            get_jl_lookup_payload,
            hide_jl_lookup_window,
            get_flow_timer_state,
            set_flow_timer_state,
            toggle_flow_timer,
            set_jl_mode_line,
            get_jl_mode_line,
            save_sync_file,
            load_sync_file,
            save_workspace_state,
            load_workspace_state,
            get_data_file_path,
            read_file_bytes,
            write_file_bytes,
            update_discord_presence,
            clear_discord_presence,
            get_ffmpeg_status,
            launch_anki,
            anki_request,
            configure_ankiconnect,
            extract_player_clip,
            delete_dictionary,
            delete_dictionaries,
            clear_database,
            get_furigana,
            scan_cursor,
            start_oauth_server,
            store_google_refresh_token,
            load_google_refresh_token,
            delete_google_refresh_token,
            get_dictionary_storage_info,
            upload_db_to_drive,
            download_db_from_drive,
            get_running_processes,
            get_capture_windows,
            start_capture_agent_server,
            stop_capture_agent_server,
            list_remote_capture_sources,
            take_remote_capture_screenshot,
            start_text_sync_server,
            stop_text_sync_server,
            publish_text_sync_line,
            publish_text_sync_event,
            poll_remote_text_sync,
            push_remote_text_sync_event,
            create_text_sync_cloud_room,
            push_text_sync_cloud_state,
            pull_text_sync_cloud_state,
            account_register,
            account_login,
            account_register_device,
            account_list_devices,
            get_windows_device_name,
            take_smart_screenshot,
            take_external_lookup_screenshot,
            hide_external_lookup_window,
            open_external_lookup_window,
            copy_hovered_text_to_clipboard,
            select_hovered_lookup_range,
            show_lookup_agent_window,
            begin_lookup_region_capture,
            cancel_lookup_region_capture,
            finish_lookup_region_capture,
            update_lookup_agent_shortcut
        ])
        .setup(|app| {
            start_diagnostics_logger(app.handle().clone());

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                install_tray(app)?;
                prepare_lookup_agent_windows(app.handle())?;
                prepare_jl_windows(app.handle())?;
                if let Err(error) = register_lookup_agent_shortcut(app.handle(), "Alt+Q") {
                    append_diagnostics_line(
                        app.handle(),
                        serde_json::json!({
                            "ts": unix_time_ms(),
                            "kind": "lookup_agent",
                            "event": "shortcut_register_failed",
                            "shortcut": "Alt+Q",
                            "error": error.to_string(),
                        }),
                    );
                }
            }

            #[cfg(target_os = "windows")]
            start_foreground_tracker(app.handle().clone());

            if let Some(main_win) = app.get_webview_window("main") {
                sanitize_main_window_size(&main_win);

                let app_handle = app.handle().clone();
                let main_win_for_events = main_win.clone();

                main_win.on_window_event(move |event| {
                    let state = app_handle.state::<BrowserState>();

                    match event {
                        tauri::WindowEvent::Focused(focused) => {
                            if let Ok(tabs) = state.inner().tabs.try_lock() {
                                for window in tabs.values() {
                                    let _ = window.set_always_on_top(*focused);
                                }
                            }

                            if !focused && main_win_for_events.is_minimized().unwrap_or(false) {
                                if let Ok(tabs) = state.inner().tabs.try_lock() {
                                    for window in tabs.values() {
                                        let _ = window.hide();
                                    }
                                }
                            }
                        }

                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            if !APP_EXIT_REQUESTED.load(Ordering::SeqCst) {
                                api.prevent_close();
                                hide_windows_to_tray(&app_handle);
                            }
                        }

                        tauri::WindowEvent::Destroyed => {
                            if let Some(window) = app_handle.get_webview_window("jl_mode") {
                                let _ = window.close();
                            }
                            if let Ok(mut tabs) = state.inner().tabs.try_lock() {
                                let windows: Vec<_> = tabs.drain().map(|(_, w)| w).collect();
                                drop(tabs);
                                for window in windows {
                                    let _ = window.close();
                                }
                            }
                        }

                        tauri::WindowEvent::Resized(_) => {
                            let is_minimized = main_win_for_events.is_minimized().unwrap_or(false);

                            if is_minimized {
                                let _ = main_win_for_events.hide();
                                if let Ok(tabs) = state.inner().tabs.try_lock() {
                                    for window in tabs.values() {
                                        let _ = window.hide();
                                    }
                                }
                            }
                        }

                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
