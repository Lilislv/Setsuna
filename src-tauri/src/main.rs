#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};
use zip::ZipArchive;
use std::net::TcpListener; 
use std::env;
use std::path::PathBuf;
use sysinfo::System;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::time::Duration;

// --- ДЛЯ ИКОНОК И УПРАВЛЕНИЯ ОКНАМИ WINDOWS ---
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use winapi::um::shellapi::ExtractIconExW;
#[cfg(target_os = "windows")]
use winapi::um::winuser::{DestroyIcon, GetIconInfo, GetDC, ReleaseDC, SetForegroundWindow, ShowWindow, SW_RESTORE, IsIconic};
#[cfg(target_os = "windows")]
use winapi::um::wingdi::{GetDIBits, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};

pub struct BrowserState {
    pub tabs: Mutex<HashMap<String, tauri::WebviewWindow>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ProcessInfo {
    name: String,
    path: String,
    icon: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct DeinflectReason { rule: Value, desc: Value }

#[derive(serde::Serialize, Clone)]
pub struct FrequencyData { dict_name: String, display_value: String, value: i64 }

#[derive(serde::Serialize, Clone)]
pub struct PitchData { dict_name: String, reading: String, position: i64 }

#[derive(serde::Serialize)]
pub struct DictEntry {
    term: String, reading: String, definition: String, dict_name: String,
    tags: String, deinflection_reasons: Vec<DeinflectReason>,
    frequencies: Vec<FrequencyData>, pitches: Vec<PitchData>, source_length: usize,
}

#[derive(serde::Serialize, Clone)]
struct ImportProgress { dict_name: String, total_dicts: usize, current_file: usize, total_files: usize, words_added: usize, status: String }

#[derive(serde::Serialize)]
pub struct TextToken { text: String, reading: Option<String> }

#[derive(serde::Serialize)]
pub struct CursorLookupResult { entries: Vec<DictEntry>, match_start: usize, match_len: usize, word: String }

fn get_data_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let data_dir = exe_dir.join("data");
            if exe_dir.join("portable.txt").exists() || data_dir.exists() {
                if !data_dir.exists() { std::fs::create_dir_all(&data_dir).ok(); }
                return Ok(data_dir.join(filename));
            }
        }
    }
    let app_dir = app.path().app_data_dir().map_err(|_| "Ошибка доступа к AppData".to_string())?;
    if !app_dir.exists() { std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?; }
    Ok(app_dir.join(filename))
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = get_data_path(app, "dictionary.db")?;
    let db = Connection::open(&db_path).map_err(|e| e.to_string())?;
    db.execute("PRAGMA journal_mode = WAL;", []).ok();
    db.execute("PRAGMA synchronous = NORMAL;", []).ok();
    db.execute("PRAGMA busy_timeout = 15000;", []).ok();
    db.execute("PRAGMA cache_size = -64000;", []).ok();
    db.execute("PRAGMA temp_store = MEMORY;", []).ok();
    Ok(db)
}

fn kata_to_hira(s: &str) -> String { s.chars().map(|c| { let u = c as u32; if (0x30A1..=0x30F6).contains(&u) { std::char::from_u32(u - 0x0060).unwrap_or(c) } else { c } }).collect() }
fn hira_to_kata(s: &str) -> String { s.chars().map(|c| { let u = c as u32; if (0x3041..=0x3096).contains(&u) { std::char::from_u32(u + 0x0060).unwrap_or(c) } else { c } }).collect() }

fn load_rules() -> Vec<(Value, Value, String, String)> {
    let rules_str = include_str!("deinflect.json");
    let clean_rules_str = rules_str.trim_start_matches('\u{feff}');
    let mut rules = Vec::new(); let mut unique_pairs = HashSet::new();
    if let Ok(json_rules) = serde_json::from_str::<Value>(clean_rules_str) {
        if let Some(arr) = json_rules.as_array() {
            for item in arr {
                let in_s = item.get("in").and_then(|v| v.as_str()).unwrap_or("").to_string(); let out_s = item.get("out").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if in_s.is_empty() { continue; }
                if unique_pairs.insert((in_s.clone(), out_s.clone())) {
                    let reason = item.get("reason").cloned().unwrap_or(Value::String("".to_string())); let desc = item.get("desc").cloned().unwrap_or(Value::String("".to_string()));
                    rules.push((reason, desc, in_s, out_s));
                }
            }
        }
    }
    rules
}

#[tauri::command]
async fn get_installed_dicts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let db = open_db(&app)?;
    let mut stmt = db.prepare("SELECT DISTINCT dict_name FROM entries UNION SELECT DISTINCT dict_name FROM frequencies UNION SELECT DISTINCT dict_name FROM pitches").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
async fn upload_db_to_drive(app: tauri::AppHandle, url: String, token: String) -> Result<(), String> {
    let db_path = get_data_path(&app, "dictionary.db")?; let file_bytes = tokio::fs::read(&db_path).await.map_err(|e| format!("Ошибка: {}", e))?;
    let client = reqwest::Client::new();
    let res = client.patch(&url).bearer_auth(token).header("Content-Type", "application/octet-stream").body(file_bytes).send().await.map_err(|e| format!("Ошибка сети: {}", e))?;
    if !res.status().is_success() { return Err(format!("Ошибка сервера: {}", res.status())); } Ok(())
}

#[tauri::command]
async fn download_db_from_drive(app: tauri::AppHandle, url: String, token: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let res = client.get(&url).bearer_auth(token).send().await.map_err(|e| format!("Ошибка сети: {}", e))?;
    if !res.status().is_success() { return Err(format!("Ошибка сервера: {}", res.status())); }
    let bytes = res.bytes().await.map_err(|e| format!("Ошибка: {}", e))?;
    let db_path = get_data_path(&app, "dictionary.db")?; tokio::fs::write(&db_path, bytes).await.map_err(|e| format!("Ошибка сохранения: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn start_oauth_server(app: tauri::AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:1337") { Ok(l) => l, Err(_) => return };
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let mut buffer = [0; 4096];
                if let Ok(size) = stream.read(&mut buffer) {
                    let request = String::from_utf8_lossy(&buffer[..size]);
                    if request.starts_with("GET ") {
                        let first_line = request.lines().next().unwrap_or(""); let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() > 1 {
                            let path = parts[1];
                            if let Some(query) = path.split('?').nth(1) {
                                let mut code = None;
                                for pair in query.split('&') { let mut kv = pair.split('='); if kv.next() == Some("code") { code = kv.next().map(|s| s.to_string()); } }
                                if let Some(c) = code {
                                    let _ = app.emit("oauth_code", c);
                                    let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Авторизация успешна</title></head><body style=\"background:#1a1a1a;color:#fff;text-align:center;padding:50px;font-family:sans-serif;\"><h1>Успешно! 🎉</h1><p>txthk получил доступ. Эту вкладку можно закрыть.</p><script>window.close();</script></body></html>";
                                    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", html.len(), html).as_bytes());
                                    break; 
                                }
                            }
                        }
                    }
                    let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                }
            }
        }
    }); Ok(())
}

#[tauri::command]
async fn delete_dictionary(app: tauri::AppHandle, dict_name: String) -> Result<(), String> {
    let mut db = open_db(&app)?; let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM entries WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM frequencies WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pitches WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?; Ok(())
}

#[tauri::command]
async fn delete_dictionaries(app: tauri::AppHandle, dict_names: Vec<String>) -> Result<(), String> {
    let mut db = open_db(&app)?; let tx = db.transaction().map_err(|e| e.to_string())?;
    for dict_name in dict_names {
        tx.execute("DELETE FROM entries WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM frequencies WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pitches WHERE dict_name = ?1", params![dict_name]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?; Ok(())
}

#[tauri::command]
async fn clear_database(app: tauri::AppHandle) -> Result<(), String> {
    let mut db = open_db(&app)?; let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM entries", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM frequencies", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pitches", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?; Ok(())
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
    .ok_or("Главное окно не найдено".to_string())?;

let main_pos = main_win
    .outer_position()
    .or_else(|_| main_win.inner_position())
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

                const iconEl =
                    document.querySelector("link[rel='icon']") ||
                    document.querySelector("link[rel='shortcut icon']") ||
                    document.querySelector("link[rel='apple-touch-icon']");

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
                        title: document.title,
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

        window.addEventListener('load', () => {{
            setTimeout(emitMeta, 50);
            setTimeout(emitMeta, 300);
            setTimeout(emitMeta, 1000);
        }});

        const titleObserver = new MutationObserver(() => {{
            emitMeta();
        }});

        if (document.querySelector('title')) {{
            titleObserver.observe(document.querySelector('title'), {{
                childList: true,
                subtree: true
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
            if let Some(window) = tabs.get(&id) {
                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
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

                let window = tauri::WebviewWindowBuilder::new(&app, &id, webview_url)
                    .title("txthk Browser")
                    .visible(true)
                    .focused(true)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .initialization_script(&init_script)
                    .build()
                    .map_err(|e| format!("Не удалось создать окно браузера: {}", e))?;

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();

                tabs.insert(id.clone(), window);
            }
        }

        "navigate" => {
            if let Some(window) = tabs.get(&id) {
                if !url.is_empty() {
                    let safe_url = url.replace("\\", "\\\\").replace("'", "\\'");
                    let _ = window.eval(&format!("window.location.href = '{}';", safe_url));
                }

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
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

                let window = tauri::WebviewWindowBuilder::new(&app, &id, webview_url)
                    .title("txthk Browser")
                    .visible(true)
                    .focused(true)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .initialization_script(&init_script)
                    .build()
                    .map_err(|e| format!("Не удалось создать окно браузера: {}", e))?;

                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();

                tabs.insert(id.clone(), window);
            }
        }

        "resize" => {
            if let Some(window) = tabs.get(&id) {
                let _ = window.set_position(pos);
                let _ = window.set_size(size);
                let _ = window.show();
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
                    "#
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
fn emit_browser_meta(
    app: AppHandle,
    id: String,
    url: String,
    title: String,
    favicon: String,
) {
    let _ = app.emit("browser_meta", serde_json::json!({
        "id": id,
        "url": url,
        "title": title,
        "favicon": favicon
    }));
}

#[tauri::command]
async fn get_browser_info(
    state: tauri::State<'_, BrowserState>
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

fn is_kanji(c: &char) -> bool {
    (*c >= '\u{4e00}' && *c <= '\u{9faf}')
        || (*c >= '\u{3400}' && *c <= '\u{4dbf}')
        || (*c == '々')
}

fn is_valid_chunk(chars: &[char]) -> bool {
    let mut seen_kana = false;

    for &c in chars {
        let kana =
            (c >= '\u{3040}' && c <= '\u{309f}')
            || (c >= '\u{30a0}' && c <= '\u{30ff}');

        if kana {
            seen_kana = true;
        } else if is_kanji(&c) && seen_kana {
            return false;
        }
    }

    true
}

fn split_furigana(term: &str, reading: &str) -> Vec<TextToken> {
    let term_chars: Vec<char> = term.chars().collect(); let read_chars: Vec<char> = reading.chars().collect();
    let mut pre = 0; while pre < term_chars.len() && pre < read_chars.len() && term_chars[pre] == read_chars[pre] { pre += 1; }
    let mut suf = 0; while suf < term_chars.len() - pre && suf < read_chars.len() - pre && term_chars[term_chars.len() - 1 - suf] == read_chars[read_chars.len() - 1 - suf] { suf += 1; }
    let mut res = Vec::new();
    if pre > 0 { res.push(TextToken { text: term_chars[..pre].iter().collect(), reading: None }); }
    let stem_term: String = term_chars[pre..term_chars.len() - suf].iter().collect();
    let stem_read: String = read_chars[pre..read_chars.len() - suf].iter().collect();
    if !stem_term.is_empty() { if stem_term == stem_read { res.push(TextToken { text: stem_term, reading: None }); } else { res.push(TextToken { text: stem_term, reading: Some(stem_read) }); } }
    if suf > 0 { res.push(TextToken { text: term_chars[term_chars.len() - suf..].iter().collect(), reading: None }); }
    res
}

#[tauri::command]
async fn get_furigana(app: tauri::AppHandle, text: String) -> Result<Vec<TextToken>, String> {
    let db = open_db(&app)?; let mut tokens = Vec::new(); let chars: Vec<char> = text.chars().collect(); let mut i = 0;
    let rules = load_rules(); let mut deinflect_rules = Vec::new(); for (_, _, in_s, out_s) in rules { deinflect_rules.push((in_s, out_s)); }
    let mut stmt = db.prepare("SELECT reading FROM entries WHERE term = ?1 AND reading != term AND reading NOT LIKE '% %' AND reading NOT LIKE '%.%' AND dict_name NOT LIKE '%kanji%' COLLATE NOCASE ORDER BY (SELECT value FROM frequencies WHERE frequencies.term = entries.term AND (frequencies.reading = entries.reading OR frequencies.reading = '') LIMIT 1) ASC NULLS LAST LIMIT 1").map_err(|e| e.to_string())?;

    while i < chars.len() {
        if !is_kanji(&chars[i]) {
            let mut j = i; while j < chars.len() && !is_kanji(&chars[j]) { j += 1; }
            tokens.push(TextToken { text: chars[i..j].iter().collect(), reading: None }); i = j; continue;
        }
        let mut found = false;
        for len in (1..=std::cmp::min(8, chars.len() - i)).rev() {
            let sub_chars = &chars[i..i + len]; if !is_valid_chunk(sub_chars) { continue; }
            let sub: String = sub_chars.iter().collect();
            let mut reading_opt = None;
            if let Ok(reading) = stmt.query_row(params![sub], |row| row.get::<_, String>(0)) { reading_opt = Some(reading); } 
            else {
                for (in_s, out_s) in &deinflect_rules {
                    if sub.ends_with(in_s) {
                        let mut new_sub = sub[..sub.len() - in_s.len()].to_string(); new_sub.push_str(out_s);
                        if let Ok(base_read) = stmt.query_row(params![new_sub], |row| row.get::<_, String>(0)) {
                            if base_read.ends_with(out_s) {
                                let mut conj_read = base_read[..base_read.len() - out_s.len()].to_string(); conj_read.push_str(in_s);
                                reading_opt = Some(conj_read); break;
                            }
                        }
                    }
                }
            }
            if let Some(reading) = reading_opt {
                if !reading.is_empty() { let mut split_toks = split_furigana(&sub, &reading); tokens.append(&mut split_toks); i += len; found = true; break; }
            }
        }
        if !found { tokens.push(TextToken { text: chars[i].to_string(), reading: None }); i += 1; }
    }
    Ok(tokens)
}

#[tauri::command]
async fn import_dictionary(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    app.emit("import_progress", ImportProgress { dict_name: "Запуск импорта...".to_string(), total_dicts: 1, current_file: 0, total_files: 1, words_added: 0, status: "Подключение к базе...".to_string() }).ok();
    let mut db = open_db(&app)?;
    db.execute("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, definition TEXT NOT NULL, dict_name TEXT DEFAULT 'Unknown', tags TEXT DEFAULT '')", []).ok();
    db.execute("CREATE TABLE IF NOT EXISTS frequencies (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, value INTEGER, display_value TEXT, dict_name TEXT)", []).ok();
    db.execute("CREATE TABLE IF NOT EXISTS pitches (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, position INTEGER, dict_name TEXT)", []).ok();
    db.execute("CREATE INDEX IF NOT EXISTS idx_term ON entries(term)", []).ok(); db.execute("CREATE INDEX IF NOT EXISTS idx_reading ON entries(reading)", []).ok();
    db.execute("CREATE INDEX IF NOT EXISTS idx_freq_term ON frequencies(term)", []).ok(); db.execute("CREATE INDEX IF NOT EXISTS idx_pitch_term ON pitches(term)", []).ok();

    let file = File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    if path.to_lowercase().ends_with(".json") {
        app.emit("import_progress", ImportProgress { dict_name: "Анализ файла...".to_string(), total_dicts: 1, current_file: 0, total_files: 1, words_added: 0, status: "Чтение файла в память (до 1-2 минут)...".to_string() }).ok();
        let mut json_str = String::new(); let mut reader = std::io::BufReader::new(file); reader.read_to_string(&mut json_str).map_err(|e| format!("Read Error: {}", e))?;
        let clean_json = json_str.trim_start_matches('\u{feff}');
        let json_data: Value = serde_json::from_str(clean_json).map_err(|e| format!("JSON Parse Error: {}", e))?;
        if json_data.get("formatName").and_then(|v| v.as_str()).unwrap_or("") != "dexie" { return Err("Файл не является экспортом базы данных Yomitan (Dexie)".to_string()); }

        let tables = json_data.get("data").and_then(|v| v.as_object()).and_then(|obj| obj.get("data")).and_then(|v| v.as_array());
        if let Some(tables_arr) = tables {
            let mut valid_dicts = HashSet::new();
            for table in tables_arr {
                if table.get("tableName").and_then(|v| v.as_str()) == Some("dictionaries") {
                    if let Some(rows) = table.get("rows").and_then(|v| v.as_array()) {
                        for row in rows {
                            let item = match row.get("$") { Some(Value::Array(arr)) if arr.len() == 2 => &arr[1], _ => row, };
                            if let Some(title) = item.get("title").and_then(|v| v.as_str()) { valid_dicts.insert(title.to_string()); }
                        }
                    }
                }
            }
            let total_dicts = if valid_dicts.is_empty() { 1 } else { valid_dicts.len() };
            let dict_names: Vec<String> = valid_dicts.iter().cloned().collect();
            let collection_name = if dict_names.is_empty() { "Yomitan Коллекция".to_string() } else if dict_names.len() <= 2 { dict_names.join(", ") } else { format!("{}, {} и еще {}", dict_names[0], dict_names[1], dict_names.len() - 2) };

            app.emit("import_progress", ImportProgress { dict_name: collection_name.clone(), total_dicts, current_file: 0, total_files: tables_arr.len(), words_added: 0, status: "Очистка от мусора и извлечение слов...".to_string() }).ok();
            let tx = db.transaction().map_err(|e| e.to_string())?;
            let mut words_added = 0; let mut current_table_idx = 0;

            for table in tables_arr {
                current_table_idx += 1;
                let table_name = table.get("tableName").and_then(|v| v.as_str()).unwrap_or("");
                let rows = table.get("rows").and_then(|v| v.as_array());
                if let Some(rows_arr) = rows {
                    let target_status = match table_name { "terms" => format!("Обработка слов ({})...", rows_arr.len()), "kanji" => format!("Обработка иероглифов ({})...", rows_arr.len()), _ => "Привязка частотности и питчей...".to_string(), };
                    app.emit("import_progress", ImportProgress { dict_name: collection_name.clone(), total_dicts, current_file: current_table_idx, total_files: tables_arr.len(), words_added, status: target_status.clone() }).ok();
                    if table_name == "terms" {
                        for row in rows_arr {
                            let item = match row.get("$") { Some(Value::Array(arr)) if arr.len() == 2 => &arr[1], _ => row, };
                            let dict_name = item.get("dictionary").and_then(|v| v.as_str()).unwrap_or("Unknown"); if !valid_dicts.contains(dict_name) { continue; }
                            let term = item.get("expression").and_then(|v| v.as_str()).unwrap_or(""); let reading = item.get("reading").and_then(|v| v.as_str()).unwrap_or("");
                            let term_tags = item.get("termTags").and_then(|v| v.as_str()).unwrap_or(""); let def_tags = item.get("definitionTags").and_then(|v| v.as_str()).unwrap_or("");
                            let tags = format!("{} {}", def_tags, term_tags).trim().to_string(); let glossary = item.get("glossary").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
                            tx.execute("INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, glossary, dict_name, tags]).ok();
                            words_added += 1;
                            if words_added % 15000 == 0 { app.emit("import_progress", ImportProgress { dict_name: collection_name.clone(), total_dicts, current_file: current_table_idx, total_files: tables_arr.len(), words_added, status: "Сохранение слов в базу...".to_string() }).ok(); }
                        }
                    } else if table_name == "kanji" {
                        for row in rows_arr {
                            let item = match row.get("$") { Some(Value::Array(arr)) if arr.len() == 2 => &arr[1], _ => row, };
                            let dict_name = item.get("dictionary").and_then(|v| v.as_str()).unwrap_or("Unknown"); if !valid_dicts.contains(dict_name) { continue; }
                            let term = item.get("character").and_then(|v| v.as_str()).unwrap_or(""); let onyomi = item.get("onyomi").and_then(|v| v.as_str()).unwrap_or("");
                            let kunyomi = item.get("kunyomi").and_then(|v| v.as_str()).unwrap_or(""); let tags = item.get("tags").and_then(|v| v.as_str()).unwrap_or("");
                            let glossary = item.get("glossary").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string()); let reading = format!("{} {}", onyomi, kunyomi).trim().to_string();
                            tx.execute("INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, glossary, dict_name, tags]).ok(); words_added += 1;
                        }
                    } else if table_name == "termMeta" || table_name == "kanjiMeta" {
                        for row in rows_arr {
                            let item = match row.get("$") { Some(Value::Array(arr)) if arr.len() == 2 => &arr[1], _ => row, };
                            let dict_name = item.get("dictionary").and_then(|v| v.as_str()).unwrap_or("Unknown"); if !valid_dicts.contains(dict_name) { continue; }
                            let term = item.get("expression").or_else(|| item.get("character")).and_then(|v| v.as_str()).unwrap_or("");
                            let mode = item.get("mode").and_then(|v| v.as_str()).unwrap_or(""); let data_obj = item.get("data");
                            if mode == "freq" {
                                let mut value = 0; let mut display_value = String::new(); let mut reading = "";
                                if let Some(obj) = data_obj.and_then(|v| v.as_object()) {
                                    reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
                                    if let Some(freq_obj) = obj.get("frequency").and_then(|v| v.as_object()) {
                                        value = freq_obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
                                        display_value = freq_obj.get("displayValue").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| { freq_obj.get("displayValue").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default() });
                                    } else if let Some(freq_val) = obj.get("frequency").and_then(|v| v.as_i64()) { value = freq_val; display_value = freq_val.to_string();
                                    } else if let Some(freq_str) = obj.get("frequency").and_then(|v| v.as_str()) { display_value = freq_str.to_string(); value = freq_str.parse().unwrap_or(0);
                                    } else {
                                        value = obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
                                        display_value = obj.get("displayValue").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| { obj.get("displayValue").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default() });
                                    }
                                } else if let Some(num) = data_obj.and_then(|v| v.as_i64()) { value = num; display_value = num.to_string();
                                } else if let Some(s) = data_obj.and_then(|v| v.as_str()) { display_value = s.to_string(); value = s.parse().unwrap_or(0); }
                                if display_value.is_empty() && value > 0 { display_value = value.to_string(); }
                                if !display_value.is_empty() { tx.execute("INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, value, display_value, dict_name]).ok(); words_added += 1; }
                            } else if mode == "pitch" {
                                if let Some(obj) = data_obj.and_then(|v| v.as_object()) {
                                    let reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
                                    if let Some(pitches_arr) = obj.get("pitches").and_then(|v| v.as_array()) {
                                        for p in pitches_arr {
                                            if let Some(pos) = p.get("position").and_then(|v| v.as_i64()) {
                                                tx.execute("INSERT INTO pitches (term, reading, position, dict_name) VALUES (?1, ?2, ?3, ?4)", params![term, reading, pos, dict_name]).ok();
                                                words_added += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            app.emit("import_progress", ImportProgress { dict_name: collection_name.clone(), total_dicts, current_file: tables_arr.len(), total_files: tables_arr.len(), words_added, status: "Завершение транзакции (запись на диск)...".to_string() }).ok();
            tx.commit().map_err(|e| e.to_string())?; return Ok(words_added);
        }
        return Err("Неверная структура Dexie JSON".to_string());
    }

    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP: {}", e))?;
    let mut dict_name = String::new();
    for i in 0..archive.len() {
        if let Ok(mut file) = archive.by_index(i) {
            let file_name = file.name().to_string();
            if file_name.ends_with("index.json") && !file_name.contains("__MACOSX") {
                let mut buffer = Vec::new();
                if file.read_to_end(&mut buffer).is_ok() {
                    let contents = String::from_utf8_lossy(&buffer);
                    if let Some(start) = contents.find('{') {
                        let clean_contents = &contents[start..];
                        if let Ok(json) = serde_json::from_str::<Value>(clean_contents) {
                            if let Some(title) = json.get("title").and_then(|v| v.as_str()) { dict_name = title.trim().to_string(); }
                        }
                    }
                }
                break;
            }
        }
    }

    if dict_name.is_empty() || dict_name == "Unknown Dictionary" {
        if let Some(s) = std::path::Path::new(&path).file_stem() { dict_name = s.to_string_lossy().into_owned(); } else { dict_name = "Imported Dictionary".to_string(); }
    }

    let tx = db.transaction().map_err(|e| format!("Transaction error: {}", e))?;
    let mut words_added = 0; let total_files = archive.len();

    for i in 0..total_files {
        app.emit("import_progress", ImportProgress { dict_name: dict_name.clone(), total_dicts: 1, current_file: i + 1, total_files, words_added, status: "Распаковка и чтение файла...".to_string() }).ok();
        let mut file = match archive.by_index(i) { Ok(f) => f, Err(_) => continue, };
        let file_name = file.name().to_string(); if file_name.contains("__MACOSX") { continue; }

        if file_name.ends_with(".json") && (file_name.contains("term_bank_") || file_name.contains("kanji_bank_") || file_name.contains("term_meta_bank_")) {
            let mut buffer = Vec::new(); if file.read_to_end(&mut buffer).is_err() { continue; }
            let contents = String::from_utf8_lossy(&buffer);

            if let Some(start) = contents.find('[') {
                let clean_contents = &contents[start..];
                if let Ok(json_data) = serde_json::from_str::<Value>(clean_contents) {
                    if let Some(entries) = json_data.as_array() {
                        for entry in entries {
                            if let Some(data_arr) = entry.as_array() {
                                if file_name.contains("term_bank_") {
                                    let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or(""); let reading = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
                                    let def_tags = data_arr.get(2).and_then(|v| v.as_str()).unwrap_or(""); let term_tags = data_arr.get(7).and_then(|v| v.as_str()).unwrap_or("");
                                    let tags = format!("{} {}", def_tags, term_tags).trim().to_string(); let definition = data_arr.get(5).map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
                                    tx.execute("INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, definition, dict_name, tags]).ok(); words_added += 1;
                                } else if file_name.contains("kanji_bank_") {
                                    let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or(""); let onyomi = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
                                    let kunyomi = data_arr.get(2).and_then(|v| v.as_str()).unwrap_or(""); let tags = data_arr.get(3).and_then(|v| v.as_str()).unwrap_or("");
                                    let definition = data_arr.get(4).map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string()); let reading = format!("{} {}", onyomi, kunyomi).trim().to_string();
                                    tx.execute("INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, definition, dict_name, tags]).ok(); words_added += 1;
                                } else if file_name.contains("term_meta_bank_") {
                                    let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or(""); let mode = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or(""); let data_obj = data_arr.get(2);
                                    if mode == "freq" {
                                        let mut value = 0; let mut display_value = String::new(); let mut reading = "";
                                        if let Some(obj) = data_obj.and_then(|v| v.as_object()) {
                                            reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
                                            if let Some(freq_obj) = obj.get("frequency").and_then(|v| v.as_object()) {
                                                value = freq_obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
                                                display_value = freq_obj.get("displayValue").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| { freq_obj.get("displayValue").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default() });
                                            } else if let Some(freq_val) = obj.get("frequency").and_then(|v| v.as_i64()) { value = freq_val; display_value = freq_val.to_string();
                                            } else if let Some(freq_str) = obj.get("frequency").and_then(|v| v.as_str()) { display_value = freq_str.to_string(); value = freq_str.parse().unwrap_or(0);
                                            } else {
                                                value = obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
                                                display_value = obj.get("displayValue").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| { obj.get("displayValue").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default() });
                                            }
                                        } else if let Some(num) = data_obj.and_then(|v| v.as_i64()) { value = num; display_value = num.to_string();
                                        } else if let Some(s) = data_obj.and_then(|v| v.as_str()) { display_value = s.to_string(); value = s.parse().unwrap_or(0); }
                                        if display_value.is_empty() && value > 0 { display_value = value.to_string(); }
                                        if !display_value.is_empty() { tx.execute("INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)", params![term, reading, value, display_value, dict_name]).ok(); words_added += 1; }
                                    } else if mode == "pitch" {
                                        if let Some(obj) = data_obj.and_then(|v| v.as_object()) {
                                            let reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
                                            if let Some(pitches_arr) = obj.get("pitches").and_then(|v| v.as_array()) {
                                                for p in pitches_arr {
                                                    if let Some(pos) = p.get("position").and_then(|v| v.as_i64()) {
                                                        tx.execute("INSERT INTO pitches (term, reading, position, dict_name) VALUES (?1, ?2, ?3, ?4)", params![term, reading, pos, dict_name]).ok();
                                                        words_added += 1;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    app.emit("import_progress", ImportProgress { dict_name: dict_name.clone(), total_dicts: 1, current_file: total_files, total_files, words_added, status: "Завершение транзакции (сохранение на диск)...".to_string() }).ok();
    tx.commit().map_err(|e| format!("DB save error: {}", e))?; Ok(words_added)
}

fn internal_lookup<'a>(freq_stmt: &mut rusqlite::Statement<'a>, pitch_stmt: &mut rusqlite::Statement<'a>, stmt: &mut rusqlite::Statement<'a>, word: &str, rules: &Vec<(Value, Value, String, String)>, source_len: usize) -> Vec<DictEntry> {
    let mut all_results = Vec::new(); let mut terms_found = HashSet::new();
    let mut queue: VecDeque<(String, Vec<DeinflectReason>, usize)> = VecDeque::new(); queue.push_back((word.to_string(), vec![], 0));
    let mut visited = HashSet::new();

    while let Some((current_term, current_reasons, depth)) = queue.pop_front() {
        if visited.contains(&current_term) { continue; } visited.insert(current_term.clone());
        let h_term = kata_to_hira(&current_term); let k_term = hira_to_kata(&current_term);

        let mut term_freqs: Vec<(String, String, i64, String)> = Vec::new();
        if let Ok(f_rows) = freq_stmt.query_map(params![&current_term, &h_term, &k_term], |row| { Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, String>(1).unwrap_or_default(), row.get::<_, i64>(2).unwrap_or_default(), row.get::<_, String>(3).unwrap_or_default())) }) { for f in f_rows.flatten() { term_freqs.push(f); } }

        let mut term_pitches: Vec<(String, i64, String)> = Vec::new();
        if let Ok(p_rows) = pitch_stmt.query_map(params![&current_term, &h_term, &k_term], |row| { Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, i64>(1).unwrap_or_default(), row.get::<_, String>(2).unwrap_or_default())) }) { for p in p_rows.flatten() { term_pitches.push(p); } }

        let rows = stmt.query_map(params![&current_term, &h_term, &k_term], |row| {
            let reading: String = row.get(1).unwrap_or_default(); let tags: String = row.get(4).unwrap_or_default();
            let mut valid_freqs = Vec::new(); for f in &term_freqs { if f.3.is_empty() || f.3 == reading { valid_freqs.push(FrequencyData { dict_name: f.0.clone(), display_value: f.1.clone(), value: f.2 }); } }
            let mut valid_pitches = Vec::new(); for p in &term_pitches { if p.2.is_empty() || p.2 == reading { valid_pitches.push(PitchData { dict_name: p.0.clone(), reading: p.2.clone(), position: p.1 }); } }
            Ok(DictEntry { term: row.get(0).unwrap_or_default(), reading, definition: row.get(2).unwrap_or_default(), dict_name: row.get(3).unwrap_or_default(), tags, deinflection_reasons: current_reasons.clone(), frequencies: valid_freqs, pitches: valid_pitches, source_length: source_len })
        });

        if let Ok(mapped_rows) = rows {
            for row in mapped_rows {
                if let Ok(entry) = row {
                    let uniq_key = format!("{}|{}|{}|{}|{}", entry.term, entry.reading, entry.dict_name, entry.tags, entry.definition);
                    if !terms_found.contains(&uniq_key) { terms_found.insert(uniq_key); all_results.push(entry); }
                }
            }
        }
        if depth >= 3 { continue; }
        for (reason, desc, in_s, out_s) in rules {
            if current_term.ends_with(in_s) {
                if in_s.is_empty() && current_reasons.iter().any(|r| r.rule == *reason) { continue; }
                let mut new_term = current_term[..current_term.len() - in_s.len()].to_string(); new_term.push_str(out_s);
                if new_term.chars().count() > 30 { continue; }
                let mut new_reasons = current_reasons.clone(); new_reasons.insert(0, DeinflectReason { rule: reason.clone(), desc: desc.clone() });
                queue.push_back((new_term, new_reasons, depth + 1));
            }
        }
    }
    all_results
}

#[tauri::command]
async fn lookup_word(app: tauri::AppHandle, word: String) -> Result<Vec<DictEntry>, String> {
    let db = open_db(&app)?; let rules = load_rules(); let clean_word = word.trim(); let chars: Vec<char> = clean_word.chars().collect();
    let mut all_entries = Vec::new(); let mut found_terms = HashSet::new(); let max_len = std::cmp::min(30, chars.len());
    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value, reading FROM frequencies WHERE term IN (?1, ?2, ?3)").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term IN (?1, ?2, ?3)").map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term IN (?1, ?2, ?3) OR e.reading IN (?1, ?2, ?3) ORDER BY e.id ASC LIMIT 100").map_err(|e| e.to_string())?;

    for len in (1..=max_len).rev() {
        let sub: String = chars[0..len].iter().collect();
        let entries = internal_lookup(&mut freq_stmt, &mut pitch_stmt, &mut stmt, &sub, &rules, len);
        for entry in entries {
            let key = format!("{}|{}|{}|{}", entry.term, entry.reading, entry.dict_name, entry.source_length);
            if !found_terms.contains(&key) { found_terms.insert(key); all_entries.push(entry); }
        }
    }
    all_entries.sort_by(|a, b| b.source_length.cmp(&a.source_length)); Ok(all_entries)
}

#[tauri::command]
async fn scan_cursor(app: tauri::AppHandle, sentence: String, cursor: usize) -> Result<CursorLookupResult, String> {
    let db = open_db(&app)?; let rules = load_rules(); let chars: Vec<char> = sentence.chars().collect();
    if cursor >= chars.len() { return Err("Out of bounds".into()); }
    let punctuation = [' ', '\n', '\r', '\t', '。', '、', '！', '？', '「', '」', '『', '』', '（', '）', '(', ')', '[', ']', '《', '》'];
    let mut best_start = cursor; let mut best_len = 0; let mut best_entries = Vec::new(); let start_bound = cursor.saturating_sub(12);

    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value, reading FROM frequencies WHERE term IN (?1, ?2, ?3)").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term IN (?1, ?2, ?3)").map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT e.term, e.reading, e.definition, e.dict_name, e.tags FROM entries e WHERE e.term IN (?1, ?2, ?3) OR e.reading IN (?1, ?2, ?3) ORDER BY e.id ASC LIMIT 100").map_err(|e| e.to_string())?;

    for start in start_bound..=cursor {
        let max_len = std::cmp::min(20, chars.len() - start);
        let mut current_start_entries = Vec::new(); let mut current_max_len = 0;
        for len in (1..=max_len).rev() {
            if start + len <= cursor { continue; }
            let sub_chars = &chars[start..start + len]; if sub_chars.iter().any(|c| punctuation.contains(c)) { continue; }
            let sub: String = sub_chars.iter().collect();
            let entries = internal_lookup(&mut freq_stmt, &mut pitch_stmt, &mut stmt, &sub, &rules, len);
            if !entries.is_empty() { if len > current_max_len { current_max_len = len; } current_start_entries.extend(entries); }
        }
        if current_max_len > best_len { best_len = current_max_len; best_start = start; best_entries = current_start_entries; }
    }
    if best_len > 0 {
        best_entries.sort_by(|a, b| b.source_length.cmp(&a.source_length));
        Ok(CursorLookupResult { entries: best_entries, match_start: best_start, match_len: best_len, word: chars[best_start..best_start + best_len].iter().collect() })
    } else { Err("No match".into()) }
}

#[cfg(target_os = "windows")]
fn get_icon_as_base64(path: &str) -> Option<String> {
    let wide_path: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect(); let mut h_icon_large = std::ptr::null_mut();
    unsafe {
        if ExtractIconExW(wide_path.as_ptr(), 0, &mut h_icon_large, std::ptr::null_mut(), 1) > 0 && !h_icon_large.is_null() {
            let mut icon_info = std::mem::zeroed();
            if GetIconInfo(h_icon_large, &mut icon_info) != 0 {
                let hdc = GetDC(std::ptr::null_mut()); let mut bi: BITMAPINFOHEADER = std::mem::zeroed();
                bi.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32; bi.biWidth = 32; bi.biHeight = -32; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = BI_RGB;
                let mut buffer: Vec<u8> = vec![0; (32 * 32 * 4) as usize];
                let res = GetDIBits(hdc, icon_info.hbmColor, 0, 32, buffer.as_mut_ptr() as *mut _, &mut bi as *mut _ as *mut _, DIB_RGB_COLORS);
                ReleaseDC(std::ptr::null_mut(), hdc); DestroyIcon(h_icon_large);
                if !icon_info.hbmColor.is_null() { winapi::um::wingdi::DeleteObject(icon_info.hbmColor as *mut _); } if !icon_info.hbmMask.is_null() { winapi::um::wingdi::DeleteObject(icon_info.hbmMask as *mut _); }
                if res != 0 {
                    for chunk in buffer.chunks_exact_mut(4) { let b = chunk[0]; let r = chunk[2]; chunk[0] = r; chunk[2] = b; }
                    if let Some(img) = screenshots::image::RgbaImage::from_raw(32, 32, buffer) {
                        let dyn_img = screenshots::image::DynamicImage::ImageRgba8(img); let mut cursor = std::io::Cursor::new(Vec::new());
                        if dyn_img.write_to(&mut cursor, screenshots::image::ImageFormat::Png).is_ok() { return Some(STANDARD.encode(cursor.into_inner())); }
                    }
                }
            } else { DestroyIcon(h_icon_large); }
        }
    } None
}

#[cfg(not(target_os = "windows"))]
fn get_icon_as_base64(_path: &str) -> Option<String> { None }

#[tauri::command]
fn get_running_processes() -> Result<Vec<ProcessInfo>, String> {
    let mut sys = System::new_all(); sys.refresh_all(); let mut proc_list = Vec::new(); let mut seen = HashSet::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_string(); let path = process.exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if name.ends_with(".exe") && !path.is_empty() && !name.starts_with("svchost") && seen.insert(name.clone()) {
            let icon = get_icon_as_base64(&path); proc_list.push(ProcessInfo { name, path, icon });
        }
    }
    proc_list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())); Ok(proc_list)
}

#[tauri::command]
async fn take_smart_screenshot(app: tauri::AppHandle, processes: String) -> Result<Option<String>, String> {
    if processes.trim().is_empty() { return Ok(None); }
    let target_procs: Vec<String> = processes.split(',').map(|s| s.trim().to_lowercase().trim_end_matches(".exe").to_string()).collect();

    let (win_x, win_y, win_w, win_h, win_id) = {
        let windows = xcap::Window::all().map_err(|e| format!("Ошибка поиска окон: {}", e))?;
        let mut best_window = None;
        let mut max_area = 0;

        for w in windows {
            let app_name = w.app_name().unwrap_or_default().to_lowercase();
            let title = w.title().unwrap_or_default().to_lowercase();
            let w_w = w.width().unwrap_or(0);
            let w_h = w.height().unwrap_or(0);

            if w_w > 50 && w_h > 50 && target_procs.iter().any(|p| app_name.contains(p) || title.contains(p)) {
                let area = w_w * w_h;
                if area > max_area {
                    max_area = area;
                    best_window = Some(w);
                }
            }
        }

        let win = match best_window {
            Some(w) => w,
            None => return Err("Окно игры не найдено. Разверните его!".to_string()),
        };

        (
            win.x().unwrap_or(0), 
            win.y().unwrap_or(0), 
            win.width().unwrap_or(0) as i32, 
            win.height().unwrap_or(0) as i32,
            win.id().unwrap_or(0)
        )
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    #[cfg(target_os = "windows")]
    {
        unsafe {
            let hwnd = win_id as usize as winapi::shared::windef::HWND;
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
    }

    tokio::time::sleep(Duration::from_millis(400)).await;

    let (m_x, m_y, m_w, m_h, rgba_image) = {
        let screens = screenshots::Screen::all().map_err(|e| format!("Ошибка поиска экранов: {}", e))?;
        let center_x = win_x + (win_w / 2);
        let center_y = win_y + (win_h / 2);
        
        let screen = screens.into_iter().find(|s| {
            let mx = s.display_info.x;
            let my = s.display_info.y;
            let mw = s.display_info.width as i32;
            let mh = s.display_info.height as i32;
            center_x >= mx && center_x <= mx + mw && center_y >= my && center_y <= my + mh
        }).unwrap_or_else(|| screenshots::Screen::all().unwrap().first().unwrap().clone());

        let mx = screen.display_info.x;
        let my = screen.display_info.y;
        let mw = screen.display_info.width as i32;
        let mh = screen.display_info.height as i32;

        let img = screen.capture().map_err(|e| format!("Ошибка захвата экрана: {}", e))?;
        (mx, my, mw, mh, img)
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    let b64 = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut dyn_img = screenshots::image::DynamicImage::ImageRgba8(rgba_image);
        
        let mut crop_x = win_x - m_x;
        let mut crop_y = win_y - m_y;
        let mut crop_w = win_w;
        let mut crop_h = win_h;

        if crop_x < 0 { crop_w += crop_x; crop_x = 0; }
        if crop_y < 0 { crop_h += crop_y; crop_y = 0; }
        if crop_x + crop_w > m_w { crop_w = m_w - crop_x; }
        if crop_y + crop_h > m_h { crop_h = m_h - crop_y; }

        if crop_w > 0 && crop_h > 0 {
            dyn_img = dyn_img.crop(crop_x as u32, crop_y as u32, crop_w as u32, crop_h as u32);
        }

        let mut cursor = std::io::Cursor::new(Vec::new());
        dyn_img.write_to(&mut cursor, screenshots::image::ImageFormat::Jpeg).map_err(|e| format!("Сжатие JPG: {}", e))?;
        
        Ok(STANDARD.encode(cursor.into_inner()))
    }).await.map_err(|e| format!("Ошибка потока: {}", e))??;

    Ok(Some(b64))
}

fn main() {
    let browser_state = BrowserState {
        tabs: Mutex::new(HashMap::new()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .manage(browser_state)
        .invoke_handler(tauri::generate_handler![
            import_dictionary,
            lookup_word,
            get_installed_dicts,
            manage_browser,
            emit_browser_meta,
            get_browser_info,
            save_sync_file,
            load_sync_file,
            delete_dictionary,
            delete_dictionaries,
            clear_database,
            get_furigana,
            scan_cursor,
            start_oauth_server,
            upload_db_to_drive,
            download_db_from_drive,
            get_running_processes,
            take_smart_screenshot
        ])
        .setup(|app| {
            if let Some(main_win) = app.get_webview_window("main") {
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
                        }

                        tauri::WindowEvent::CloseRequested { .. } => {
                            if let Ok(mut tabs) = state.inner().tabs.try_lock() {
                                let windows: Vec<_> = tabs.drain().map(|(_, w)| w).collect();
                                drop(tabs);
                                for window in windows {
                                    let _ = window.close();
                                }
                            }
                        }

                        tauri::WindowEvent::Destroyed => {
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

                            if let Ok(tabs) = state.inner().tabs.try_lock() {
                                for window in tabs.values() {
                                    if is_minimized {
                                        let _ = window.hide();
                                    } else {
                                        let _ = window.show();
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
