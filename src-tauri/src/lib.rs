mod core;
mod japanese_tokenizer;

use japanese_tokenizer::{segment_text as segment_japanese_text, TextToken};
use rusqlite::{params, Connection, Transaction};
use serde::de::DeserializeSeed;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::Disks;
use tauri::{generate_context, generate_handler, Builder, Emitter, Manager, State};
use zip::ZipArchive;

#[derive(Serialize)]
pub struct DictResult {
    pub term: String,
    pub reading: String,
    pub meanings: Value,
}

#[derive(Serialize, Clone)]
pub struct DictEntry {
    pub term: String,
    pub reading: String,
    pub definitions: Vec<String>,
    pub dict_name: String,
    pub score: i64,
    pub tags: String,
    pub deinflection_reasons: Vec<Value>,
    pub frequencies: Vec<Value>,
    pub pitches: Vec<Value>,
    pub source_length: usize,
}

#[derive(Serialize)]
pub struct CursorLookupResult {
    pub word: String,
    pub start: usize,
    pub end: usize,
    pub entries: Vec<DictEntry>,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_path: PathBuf,
}

#[derive(Serialize)]
pub struct TextSyncServerStart {
    pub url: String,
    pub port: u16,
    pub token: String,
}

static MOBILE_DICTIONARY_IMPORT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static MOBILE_FLOW_TIMER_PAUSED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize)]
pub struct OAuthServerStart {
    pub port: u16,
    pub redirect_uri: String,
    pub reused: bool,
}

fn oauth_server_port_state() -> &'static Mutex<Option<u16>> {
    static STATE: OnceLock<Mutex<Option<u16>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// Runs the OAuth callback catcher on the phone's own loopback (shared device-wide on Android),
// so the browser's redirect to http://127.0.0.1:1337/?code=... is caught by this app and the
// code is emitted to the frontend — same seamless flow as desktop, no manual paste needed.
#[tauri::command]
async fn start_oauth_server(app: tauri::AppHandle) -> Result<OAuthServerStart, String> {
    {
        let guard = oauth_server_port_state()
            .lock()
            .map_err(|e| format!("OAuth server state is locked: {e}"))?;
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
        .map_err(|e| format!("Failed to start local OAuth callback server: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure OAuth callback server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    {
        let mut guard = oauth_server_port_state().lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
    }

    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0u8; 4096];
                    if let Ok(size) = stream.read(&mut buffer) {
                        let request = String::from_utf8_lossy(&buffer[..size]);
                        if request.starts_with("GET ") {
                            let first_line = request.lines().next().unwrap_or("");
                            let parts: Vec<&str> = first_line.split_whitespace().collect();
                            if parts.len() > 1 {
                                let path = parts[1];
                                if let Some(query) = path.split('?').nth(1) {
                                    let has_code_or_error = query.split('&').any(|pair| {
                                        let mut kv = pair.split('=');
                                        matches!(kv.next(), Some("code") | Some("error"))
                                    });
                                    if has_code_or_error {
                                        let callback_url = format!("http://127.0.0.1:{}{}", port, path);
                                        let _ = app.emit("oauth_code", callback_url);
                                        let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Setsuna</title></head><body style=\"background:#1a1a1a;color:#fff;text-align:center;padding:48px 24px;font-family:sans-serif;\"><h2>Готово ✓</h2><p>Setsuna получил доступ. Можно вернуться в приложение.</p></body></html>";
                                        let _ = stream.write_all(
                                            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", html.len(), html).as_bytes(),
                                        );
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
async fn import_dictionary(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    run_mobile_dictionary_import(vec![path], state.db_path.clone()).await
}

#[tauri::command]
async fn import_dictionaries(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Err("No dictionary files selected".to_string());
    }

    run_mobile_dictionary_import(paths, state.db_path.clone()).await
}

async fn run_mobile_dictionary_import(
    paths: Vec<String>,
    db_path: PathBuf,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MOBILE_DICTIONARY_IMPORT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Dictionary import lock is poisoned".to_string())?;
        let mut conn = Connection::open(&db_path)
            .map_err(|error| format!("Failed to open dictionary database: {error}"))?;
        core::database::configure_connection(&conn)?;
        init_mobile_db(&mut conn)?;

        let mut total = 0usize;
        for path in paths {
            total += import_mobile_dictionary_path(&mut conn, &path)
                .map_err(|error| format!("{}: {}", fallback_dict_name(&path), error))?;
        }
        Ok(total)
    })
    .await
    .map_err(|error| format!("Dictionary import worker failed: {error}"))?
}

fn import_mobile_dictionary_path(conn: &mut Connection, path: &str) -> Result<usize, String> {
    if path.to_lowercase().ends_with(".zip") {
        import_yomitan_zip(conn, path)
    } else if path.to_lowercase().ends_with(".json") {
        import_yomitan_json(conn, path)
    } else {
        Err(
            "Unsupported mobile dictionary format. Select a Yomitan ZIP or term_bank JSON file."
                .to_string(),
        )
    }
}

fn fallback_dict_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Imported dictionary")
        .to_string()
}

fn import_yomitan_json(conn: &mut Connection, path: &str) -> Result<usize, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let dict_name = fallback_dict_name(path);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    clear_mobile_dictionary_records(&tx, &dict_name)?;
    let count = stream_mobile_term_bank(reader, &tx, &dict_name)?;
    upsert_mobile_dictionary_meta(&tx, &dict_name, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

fn import_yomitan_zip(conn: &mut Connection, path: &str) -> Result<usize, String> {
    let file = File::open(path).map_err(|e| format!("Zip open error: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Zip read error: {}", e))?;
    let mut dict_name = fallback_dict_name(path);

    let mut index_meta: Option<Value> = None;
    if let Ok(mut index_file) = archive.by_name("index.json") {
        let mut index_text = String::new();
        index_file
            .read_to_string(&mut index_text)
            .map_err(|e| format!("index.json read error: {}", e))?;
        if let Ok(index_json) = serde_json::from_str::<Value>(&index_text) {
            if let Some(title) = index_json
                .get("title")
                .or_else(|| index_json.get("name"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                dict_name = title.to_string();
            }
            index_meta = Some(index_json);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    clear_mobile_dictionary_records(&tx, &dict_name)?;
    let mut total = 0usize;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| format!("Zip entry error: {}", e))?;
        let name = file.name().to_string();
        let lower = name.to_lowercase();
        if !lower.ends_with(".json") {
            continue;
        }

        let imported = if lower.contains("term_bank") {
            stream_mobile_term_bank(file, &tx, &dict_name)
        } else if lower.contains("frequency") || lower.contains("freq_bank") {
            stream_mobile_frequency_bank(file, &tx, &dict_name)
        } else if lower.contains("pitch") {
            stream_mobile_pitch_bank(file, &tx, &dict_name)
        } else if lower.contains("pronunciation") {
            stream_mobile_pronunciation_bank(file, &tx, &dict_name)
        } else {
            continue;
        };
        total += imported.map_err(|error| format!("{}: {}", name, error))?;
    }

    if total == 0 {
        return Err("No supported Yomitan bank files were found in this zip.".to_string());
    }

    upsert_mobile_dictionary_meta(&tx, &dict_name, index_meta.as_ref())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(total)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DriveTransferProgress {
    operation: String,
    transferred: u64,
    total: u64,
    percent: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DictionaryStorageInfo {
    path: String,
    size: u64,
    available_bytes: Option<u64>,
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn clear_mobile_dictionary_records(tx: &Transaction<'_>, dict_name: &str) -> Result<(), String> {
    for table in ["entries", "frequencies", "pitches", "pronunciations"] {
        let sql = format!("DELETE FROM {table} WHERE dict_name = ?1");
        tx.execute(&sql, params![dict_name])
            .map_err(|error| format!("Failed to replace existing dictionary: {error}"))?;
    }
    tx.execute("DELETE FROM dictionary_meta WHERE title = ?1", params![dict_name])
        .map_err(|error| format!("Failed to replace existing dictionary metadata: {error}"))?;
    Ok(())
}

fn upsert_mobile_dictionary_meta(
    tx: &Transaction<'_>,
    dict_name: &str,
    index_meta: Option<&Value>,
) -> Result<(), String> {
    let revision = index_meta
        .and_then(|value| value.get("revision"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let format = index_meta
        .and_then(|value| value.get("format"))
        .and_then(|value| value.as_i64())
        .unwrap_or_default();
    tx.execute(
        "INSERT OR REPLACE INTO dictionary_meta (title, revision, format, imported_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![dict_name, revision, format, unix_now_ms()],
    )
    .map_err(|error| format!("Failed to save dictionary metadata: {error}"))?;
    Ok(())
}

fn stream_mobile_term_bank<R: Read>(
    reader: R,
    tx: &Transaction<'_>,
    dict_name: &str,
) -> Result<usize, String> {
    stream_mobile_json_array(reader, |entry| {
        let Some(arr) = entry.as_array() else {
            return Ok(false);
        };
        let term = arr.first().and_then(|value| value.as_str()).unwrap_or("");
        if term.trim().is_empty() {
            return Ok(false);
        }
        let reading = arr.get(1).and_then(|value| value.as_str()).unwrap_or("");
        let meanings = arr.get(5).unwrap_or(&Value::Null);
        let meanings_str = serde_json::to_string(meanings).unwrap_or_else(|_| "[]".to_string());
        let definition_tags = arr.get(2).and_then(|value| value.as_str()).unwrap_or("");
        let term_tags = arr.get(7).and_then(|value| value.as_str()).unwrap_or("");
        let tags = format!("{definition_tags} {term_tags}").trim().to_string();
        tx.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![term, reading, meanings_str, dict_name, tags],
        )
        .map_err(|error| error.to_string())?;
        Ok(true)
    })
}

fn stream_mobile_json_array<R, F>(reader: R, mut on_value: F) -> Result<usize, String>
where
    R: Read,
    F: FnMut(Value) -> Result<bool, String>,
{
    struct ArraySeed<'a, F> {
        on_value: &'a mut F,
    }

    impl<'de, 'a, F> DeserializeSeed<'de> for ArraySeed<'a, F>
    where
        F: FnMut(Value) -> Result<bool, String>,
    {
        type Value = usize;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct ArrayVisitor<'a, F> {
                on_value: &'a mut F,
            }

            impl<'de, 'a, F> serde::de::Visitor<'de> for ArrayVisitor<'a, F>
            where
                F: FnMut(Value) -> Result<bool, String>,
            {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("a Yomitan term bank array")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: serde::de::SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while let Some(value) = seq.next_element::<Value>()? {
                        if (self.on_value)(value).map_err(serde::de::Error::custom)? {
                            count += 1;
                        }
                    }
                    Ok(count)
                }
            }

            deserializer.deserialize_seq(ArrayVisitor {
                on_value: self.on_value,
            })
        }
    }

    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let count = ArraySeed {
        on_value: &mut on_value,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| format!("JSON parse error: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("Invalid data after term bank: {error}"))?;
    Ok(count)
}

#[tauri::command]
async fn lookup_text(
    text: String,
    state: State<'_, AppState>,
) -> Result<Option<DictResult>, String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;

    let chars: Vec<char> = text.chars().collect();
    let max_len = std::cmp::min(15, chars.len());

    for i in (1..=max_len).rev() {
        let snippet: String = chars[0..i].iter().collect();

        let mut stmt = conn
            .prepare("SELECT term, reading, definition FROM entries WHERE term = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;

        let mut rows = stmt.query(params![snippet]).map_err(|e| e.to_string())?;

        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let term: String = row.get(0).map_err(|e| e.to_string())?;
            let reading: String = row.get(1).map_err(|e| e.to_string())?;
            let meanings_str: String = row.get(2).map_err(|e| e.to_string())?;

            let meanings: Value = serde_json::from_str(&meanings_str).unwrap_or(Value::Null);

            return Ok(Some(DictResult {
                term,
                reading,
                meanings,
            }));
        }
    }

    Ok(None)
}

#[tauri::command]
async fn get_installed_dicts(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    core::database::installed_dictionary_names(&conn)
}

fn stream_mobile_frequency_bank<R: Read>(
    reader: R,
    tx: &Transaction<'_>,
    dict_name: &str,
) -> Result<usize, String> {
    stream_mobile_json_array(reader, |entry| {
        let Some(arr) = entry.as_array() else { return Ok(false); };
        let term = arr.first().and_then(|value| value.as_str()).unwrap_or("");
        if term.trim().is_empty() { return Ok(false); }
        let reading = arr.get(1).and_then(|value| value.as_str()).unwrap_or("");
        let raw_value = arr.get(2).cloned().unwrap_or(Value::Null);
        let value = raw_value.as_i64().or_else(|| raw_value.get("value").and_then(|item| item.as_i64()));
        let display_value = raw_value
            .as_str()
            .map(str::to_string)
            .or_else(|| raw_value.get("displayValue").and_then(|item| item.as_str()).map(str::to_string))
            .or_else(|| raw_value.get("display_value").and_then(|item| item.as_str()).map(str::to_string));
        tx.execute(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![term, reading, value, display_value, dict_name],
        ).map_err(|error| error.to_string())?;
        Ok(true)
    })
}

fn stream_mobile_pitch_bank<R: Read>(
    reader: R,
    tx: &Transaction<'_>,
    dict_name: &str,
) -> Result<usize, String> {
    stream_mobile_json_array(reader, |entry| {
        let Some(arr) = entry.as_array() else { return Ok(false); };
        let term = arr.first().and_then(|value| value.as_str()).unwrap_or("");
        if term.trim().is_empty() { return Ok(false); }
        let reading = arr.get(1).and_then(|value| value.as_str()).unwrap_or("");
        let position = arr.get(2).and_then(|value| value.as_i64()).or_else(|| {
            arr.get(2).and_then(|value| value.get("position")).and_then(|value| value.as_i64())
        });
        let Some(position) = position else { return Ok(false); };
        tx.execute(
            "INSERT INTO pitches (term, reading, position, dict_name) VALUES (?1, ?2, ?3, ?4)",
            params![term, reading, position, dict_name],
        ).map_err(|error| error.to_string())?;
        Ok(true)
    })
}

fn stream_mobile_pronunciation_bank<R: Read>(
    reader: R,
    tx: &Transaction<'_>,
    dict_name: &str,
) -> Result<usize, String> {
    stream_mobile_json_array(reader, |entry| {
        let Some(arr) = entry.as_array() else { return Ok(false); };
        let term = arr.first().and_then(|value| value.as_str()).unwrap_or("");
        if term.trim().is_empty() { return Ok(false); }
        let reading = arr.get(1).and_then(|value| value.as_str()).unwrap_or("");
        let data = arr.get(2).cloned().unwrap_or(Value::Null);
        let ipa = data.as_str()
            .map(str::to_string)
            .or_else(|| data.get("ipa").and_then(|value| value.as_str()).map(str::to_string))
            .unwrap_or_default();
        if ipa.is_empty() { return Ok(false); }
        let tags = data.get("tags").map(|value| value.to_string()).unwrap_or_default();
        tx.execute(
            "INSERT INTO pronunciations (term, reading, ipa, tags, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![term, reading, ipa, tags, dict_name],
        ).map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
async fn clear_database(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    core::database::clear_dictionary_data(&conn)
}

#[tauri::command]
async fn delete_dictionaries(
    dict_names: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    core::database::delete_dictionaries(&conn, &dict_names)
}

fn meanings_to_definitions(value: Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text),
                Value::Array(parts) => Some(
                    parts
                        .into_iter()
                        .filter_map(|part| part.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                        .join("; "),
                ),
                Value::Object(obj) => obj
                    .get("content")
                    .or_else(|| obj.get("text"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                other => Some(other.to_string()),
            })
            .filter(|text| !text.trim().is_empty())
            .collect(),
        Value::String(text) => vec![text],
        Value::Null => Vec::new(),
        other => vec![other.to_string()],
    }
}

// Deinflection rules ported from the desktop engine (deinflect.json): each rule replaces
// a conjugated suffix `in` with the dictionary-form suffix `out`, carrying a localized reason.
fn deinflect_rules() -> &'static Vec<(String, String, Value, Value)> {
    static RULES: OnceLock<Vec<(String, String, Value, Value)>> = OnceLock::new();
    RULES.get_or_init(|| {
        let raw = include_str!("deinflect.json").trim_start_matches('\u{feff}');
        let mut out = Vec::new();
        let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(raw) {
            for item in arr {
                let in_s = item.get("in").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let out_s = item.get("out").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if in_s.is_empty() {
                    continue;
                }
                if seen.insert((in_s.clone(), out_s.clone())) {
                    let reason = item.get("reason").cloned().unwrap_or(Value::Null);
                    let desc = item.get("desc").cloned().unwrap_or(Value::Null);
                    out.push((in_s, out_s, reason, desc));
                }
            }
        }
        out
    })
}

fn is_kana(ch: char) -> bool {
    matches!(ch, '\u{3040}'..='\u{309f}' | '\u{30a0}'..='\u{30ff}')
}

// Only accept a deinflected match if the entry looks conjugatable (verb / i-adjective / aux),
// or has no POS tags at all — this blocks a conjugated surface from matching a random noun.
fn tags_allow_deinflection(tags: &str) -> bool {
    if tags.trim().is_empty() {
        return true;
    }
    ["v1", "v5", "v4", "v2", "vk", "vs", "vz", "vn", "vr", "adj-i", "adj-ix", "aux", "cop", "iku"]
        .iter()
        .any(|m| tags.contains(m))
}

// Exact term/reading query against the shared canonical schema, building entries for a given
// source_length and (optional) deinflection reason chain.
fn query_exact_forms(
    conn: &Connection,
    snippet: &str,
    source_length: usize,
    reasons: &[Value],
) -> Result<Vec<DictEntry>, String> {
    let mut entries = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT term, reading, definition, dict_name, tags FROM entries
             WHERE term = ?1 OR reading = ?1
             LIMIT 30",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![snippet], |row| {
            let term: String = row.get(0)?;
            let reading: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            let definition: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            let dict_name: String =
                row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "Unknown".to_string());
            let tags: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
            Ok(DictEntry {
                term,
                reading,
                definitions: meanings_to_definitions(
                    serde_json::from_str(&definition).unwrap_or(Value::String(definition)),
                ),
                dict_name,
                score: 0,
                tags,
                deinflection_reasons: reasons.to_vec(),
                frequencies: Vec::new(),
                pitches: Vec::new(),
                source_length,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    drop(stmt);
    for entry in &mut entries {
        entry.frequencies = query_mobile_frequencies(conn, &entry.term, &entry.reading)?;
        entry.pitches = query_mobile_pitches(conn, &entry.term, &entry.reading)?;
    }
    Ok(entries)
}

fn query_mobile_frequencies(conn: &Connection, term: &str, reading: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn.prepare(
        "SELECT value, display_value, dict_name FROM frequencies
         WHERE term = ?1 OR (?2 <> '' AND reading = ?2)
         ORDER BY CASE WHEN value IS NULL THEN 1 ELSE 0 END, value ASC LIMIT 16",
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![term, reading], |row| {
        Ok(serde_json::json!({
            "value": row.get::<_, Option<i64>>(0)?,
            "displayValue": row.get::<_, Option<String>>(1)?,
            "dictName": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        }))
    }).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

fn query_mobile_pitches(conn: &Connection, term: &str, reading: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn.prepare(
        "SELECT position, dict_name FROM pitches
         WHERE term = ?1 OR (?2 <> '' AND reading = ?2)
         ORDER BY position ASC LIMIT 16",
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![term, reading], |row| {
        Ok(serde_json::json!({
            "position": row.get::<_, i64>(0)?,
            "dictName": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        }))
    }).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

// BFS deinflection of a single surface form (bounded depth/expansion), returning dictionary-form
// entries whose POS tags permit the applied conjugation.
fn deinflect_forms(
    conn: &Connection,
    snippet: &str,
    source_length: usize,
) -> Result<Vec<DictEntry>, String> {
    let rules = deinflect_rules();
    let mut results: Vec<DictEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<(String, Vec<Value>, usize)> =
        std::collections::VecDeque::new();
    queue.push_back((snippet.to_string(), Vec::new(), 0));
    let mut expanded = 0usize;

    while let Some((form, reasons, depth)) = queue.pop_front() {
        if !visited.insert(form.clone()) {
            continue;
        }
        expanded += 1;
        if expanded > 40 {
            break;
        }

        if depth > 0 {
            for entry in query_exact_forms(conn, &form, source_length, &reasons)? {
                if !tags_allow_deinflection(&entry.tags) {
                    continue;
                }
                let key = format!("{}|{}|{}", entry.term, entry.reading, entry.dict_name);
                if seen.insert(key) {
                    results.push(entry);
                }
            }
        }

        if depth < 3 {
            let form_chars: Vec<char> = form.chars().collect();
            for (in_s, out_s, reason, desc) in rules.iter() {
                if !form.ends_with(in_s.as_str()) {
                    continue;
                }
                let in_len = in_s.chars().count();
                if form_chars.len() < in_len {
                    continue;
                }
                let base: String = form_chars[..form_chars.len() - in_len].iter().collect();
                let candidate = format!("{}{}", base, out_s);
                if candidate.is_empty() || visited.contains(&candidate) {
                    continue;
                }
                let mut next = reasons.clone();
                next.push(serde_json::json!({ "rule": reason.clone(), "desc": desc.clone() }));
                queue.push_back((candidate, next, depth + 1));
            }
        }
    }

    Ok(results)
}

// Longest-prefix lookup with deinflection fallback. Used by tap lookup (scan_cursor), manual
// lookup, and greedy segmentation (get_furigana) — so conjugated words resolve everywhere.
fn lookup_word_in_db(conn: &Connection, word: &str) -> Result<Vec<DictEntry>, String> {
    let clean = word.trim();
    if clean.is_empty() {
        return Ok(Vec::new());
    }

    let chars: Vec<char> = clean.chars().collect();
    let max_len = std::cmp::min(24, chars.len());

    for len in (1..=max_len).rev() {
        let snippet: String = chars[0..len].iter().collect();

        let exact = query_exact_forms(conn, &snippet, len, &[])?;
        if !exact.is_empty() {
            return Ok(exact);
        }

        // Deinflect only when the surface could be a conjugation (ends in kana, >=2 chars) —
        // this keeps segmentation fast and avoids spurious noun matches.
        if len >= 2 && chars.get(len - 1).copied().map(is_kana).unwrap_or(false) {
            let deinflected = deinflect_forms(conn, &snippet, len)?;
            if !deinflected.is_empty() {
                return Ok(deinflected);
            }
        }
    }

    Ok(Vec::new())
}

const STARTER_DICTIONARY_REVISION: &str = "2026-09-02.1";
const CORE_DICTIONARY_REVISION: &str = "2026-08-28.2";
const CORE_DICTIONARY_ARCHIVE: &[u8] =
    include_bytes!("../resources/mobile-starter-dictionaries.zip");

#[derive(Deserialize)]
struct EmbeddedStarterEntry {
    term: String,
    reading: String,
    definition: String,
    tags: String,
    #[serde(rename = "dictName")]
    dict_name: String,
    frequency: i64,
}

const STARTER_JP_RU: &[(&str, &str, &str, &str)] = &[
    ("米屋", "こめや", "рисовая лавка; магазин или продавец риса", "n"),
    ("日本", "にほん", "Япония", "n"),
    ("日本人", "にほんじん", "японец; японка", "n"),
    ("私", "わたし", "я; я сам", "pn"),
    ("人", "ひと", "человек", "n"),
    ("何", "なに", "что; какой", "pn"),
    ("今", "いま", "сейчас", "n adv"),
    ("今日", "きょう", "сегодня", "n adv"),
    ("明日", "あした", "завтра", "n adv"),
    ("昨日", "きのう", "вчера", "n adv"),
    ("時間", "じかん", "время; продолжительность", "n"),
    ("言葉", "ことば", "слово; язык", "n"),
    ("辞書", "じしょ", "словарь", "n"),
    ("画面", "がめん", "экран", "n"),
    ("検索", "けんさく", "поиск", "n vs"),
    ("勉強", "べんきょう", "учёба; изучение", "n vs"),
    ("読む", "よむ", "читать", "v5m vt"),
    ("見る", "みる", "смотреть; видеть", "v1 vt"),
    ("聞く", "きく", "слушать; спрашивать", "v5k vt"),
    ("話す", "はなす", "говорить; рассказывать", "v5s vt"),
    ("言う", "いう", "говорить; называть", "v5u vt"),
    ("思う", "おもう", "думать; полагать", "v5u vt"),
    ("知る", "しる", "знать; узнавать", "v5r vt"),
    ("分かる", "わかる", "понимать", "v5r vi"),
    ("食べる", "たべる", "есть; принимать пищу", "v1 vt"),
    ("行く", "いく", "идти; ехать", "v5k vi"),
    ("来る", "くる", "приходить; приезжать", "vk vi"),
    ("する", "する", "делать", "vs vt"),
    ("上げる", "あげる", "поднимать; повышать", "v1 vt"),
    ("外れる", "はずれる", "соскочить; промахнуться; оказаться неверным", "v1 vi"),
    ("薄い", "うすい", "тонкий; слабый; бледный", "adj-i"),
    ("変態", "へんたい", "извращенец; превращение; метаморфоз", "n"),
    ("突っ張り", "つっぱり", "распорка; толчок ладонями; упрямство", "n"),
    ("回転", "かいてん", "вращение; оборот", "n vs"),
    ("回転速度", "かいてんそくど", "скорость вращения", "n"),
    ("速度", "そくど", "скорость", "n"),
    ("大昔", "おおむかし", "давным-давно; глубокая древность", "n"),
    ("納得", "なっとく", "понимание; согласие; убеждённость", "n vs"),
    ("本", "ほん", "книга", "n"),
    ("猫", "ねこ", "кошка", "n"),
    ("友達", "ともだち", "друг; приятель", "n"),
];

const STARTER_JP_EN: &[(&str, &str, &str, &str)] = &[
    ("米屋", "こめや", "rice shop; rice dealer", "n"),
    ("日本", "にほん", "Japan", "n"),
    ("日本人", "にほんじん", "Japanese person", "n"),
    ("私", "わたし", "I; me", "pn"),
    ("人", "ひと", "person", "n"),
    ("言葉", "ことば", "word; language", "n"),
    ("辞書", "じしょ", "dictionary", "n"),
    ("読む", "よむ", "to read", "v5m vt"),
    ("見る", "みる", "to see; to watch", "v1 vt"),
    ("聞く", "きく", "to hear; to ask", "v5k vt"),
    ("思う", "おもう", "to think", "v5u vt"),
    ("分かる", "わかる", "to understand", "v5r vi"),
    ("食べる", "たべる", "to eat", "v1 vt"),
    ("行く", "いく", "to go", "v5k vi"),
    ("来る", "くる", "to come", "vk vi"),
    ("上げる", "あげる", "to raise; to increase", "v1 vt"),
    ("外れる", "はずれる", "to come off; to miss; to be wrong", "v1 vi"),
    ("薄い", "うすい", "thin; weak; pale", "adj-i"),
    ("変態", "へんたい", "transformation; pervert", "n"),
    ("突っ張り", "つっぱり", "thrust; brace; stubbornness", "n"),
    ("回転速度", "かいてんそくど", "rotational speed", "n"),
];

const STARTER_GRAMMAR: &[(&str, &str, &str, &str)] = &[
    ("ではない", "ではない", "не является; отрицательная связка", "exp"),
    ("なくてはいけない", "なくてはいけない", "нужно; необходимо сделать", "exp"),
    ("はず", "はず", "ожидание; должно быть; предположение", "n"),
    ("こと", "こと", "факт; дело; номинализатор действия", "n"),
    ("もの", "もの", "вещь; причина или пояснение", "n"),
    ("ため", "ため", "ради; из-за; для того чтобы", "n"),
    ("そうだ", "そうだ", "кажется; говорят, что", "exp"),
    ("らしい", "らしい", "похоже; типичный для", "aux-adj"),
    ("と思う", "とおもう", "думать, что…", "exp"),
    ("ても", "ても", "даже если; хотя", "prt"),
    ("だけ", "だけ", "только; настолько", "prt"),
    ("まで", "まで", "до; вплоть до", "prt"),
    ("から", "から", "из; от; потому что", "prt"),
    ("ので", "ので", "поскольку; потому что", "prt"),
];

const STARTER_EN_RU: &[(&str, &str, &str, &str)] = &[
    ("read", "read", "читать", "verb"),
    ("reading", "reading", "чтение", "noun"),
    ("word", "word", "слово", "noun"),
    ("sentence", "sentence", "предложение", "noun"),
    ("dictionary", "dictionary", "словарь", "noun"),
    ("lookup", "lookup", "поиск; просмотр значения", "noun"),
    ("book", "book", "книга", "noun"),
    ("screen", "screen", "экран", "noun"),
    ("learn", "learn", "учить; узнавать", "verb"),
    ("study", "study", "учиться; изучение", "verb noun"),
    ("think", "think", "думать", "verb"),
    ("know", "know", "знать", "verb"),
    ("understand", "understand", "понимать", "verb"),
    ("time", "time", "время", "noun"),
    ("friend", "friend", "друг", "noun"),
    ("today", "today", "сегодня", "adverb"),
    ("tomorrow", "tomorrow", "завтра", "adverb"),
    ("yesterday", "yesterday", "вчера", "adverb"),
    ("thin", "thin", "тонкий; редкий", "adjective"),
    ("speed", "speed", "скорость", "noun"),
];

fn seed_mobile_starter_dictionary(
    conn: &mut Connection,
    name: &str,
    rows: &[(&str, &str, &str, &str)],
) -> Result<(), String> {
    let current_revision = conn
        .query_row(
            "SELECT revision FROM dictionary_meta WHERE title = ?1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let row_count = conn
        .query_row(
            "SELECT COUNT(*) FROM entries WHERE dict_name = ?1",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or_default();
    if current_revision.as_deref() == Some(STARTER_DICTIONARY_REVISION) && row_count > 0 {
        return Ok(());
    }

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    clear_mobile_dictionary_records(&tx, name)?;
    for (term, reading, definition, tags) in rows {
        let definition = serde_json::to_string(&[*definition]).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![term, reading, definition, name, tags],
        )
        .map_err(|error| format!("Failed to seed {name}: {error}"))?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO dictionary_meta (title, revision, format, imported_at_ms)
         VALUES (?1, ?2, 3, ?3)",
        params![name, STARTER_DICTIONARY_REVISION, unix_now_ms()],
    )
    .map_err(|error| format!("Failed to save {name} metadata: {error}"))?;
    tx.commit().map_err(|error| error.to_string())
}

fn seed_mobile_starter_dictionaries(conn: &mut Connection) -> Result<(), String> {
    for (name, rows) in [
        ("Setsuna Starter JP-RU", STARTER_JP_RU),
        ("Setsuna Starter JP-EN", STARTER_JP_EN),
        ("Setsuna Starter Grammar", STARTER_GRAMMAR),
        ("Setsuna Starter EN-RU", STARTER_EN_RU),
    ] {
        seed_mobile_starter_dictionary(conn, name, rows)?;
    }
    Ok(())
}

fn seed_mobile_core_dictionaries(conn: &mut Connection) -> Result<(), String> {
    const DICTIONARIES: [&str; 2] = ["Setsuna Core JP-RU", "Setsuna Core JP-EN"];
    const FREQUENCY_DICTIONARY: &str = "Setsuna Core Freq";

    let already_seeded = DICTIONARIES.iter().all(|name| {
        let revision = conn
            .query_row(
                "SELECT revision FROM dictionary_meta WHERE title = ?1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .ok();
        let count = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name = ?1",
                params![name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or_default();
        revision.as_deref() == Some(CORE_DICTIONARY_REVISION) && count >= 1_000
    });
    if already_seeded {
        return Ok(());
    }

    let cursor = Cursor::new(CORE_DICTIONARY_ARCHIVE);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|error| format!("Failed to open embedded dictionaries: {error}"))?;
    let file = archive
        .by_name("mobile-starter-dictionaries.jsonl")
        .map_err(|error| format!("Embedded dictionary data is missing: {error}"))?;
    let reader = BufReader::new(file);

    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    for name in DICTIONARIES {
        clear_mobile_dictionary_records(&transaction, name)?;
    }
    transaction
        .execute(
            "DELETE FROM frequencies WHERE dict_name = ?1",
            params![FREQUENCY_DICTIONARY],
        )
        .map_err(|error| format!("Failed to refresh embedded frequencies: {error}"))?;

    let mut insert_entry = transaction
        .prepare(
            "INSERT INTO entries (term, reading, definition, dict_name, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|error| format!("Failed to prepare embedded dictionary import: {error}"))?;
    let mut insert_frequency = transaction
        .prepare(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|error| format!("Failed to prepare embedded frequencies: {error}"))?;
    let mut frequency_terms = std::collections::HashSet::new();
    let mut inserted = 0usize;

    for (line_index, line) in reader.lines().enumerate() {
        let line = line.map_err(|error| {
            format!("Failed to read embedded dictionary line {}: {error}", line_index + 1)
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: EmbeddedStarterEntry = serde_json::from_str(&line).map_err(|error| {
            format!("Failed to parse embedded dictionary line {}: {error}", line_index + 1)
        })?;
        if !DICTIONARIES.contains(&entry.dict_name.as_str()) {
            continue;
        }
        insert_entry
            .execute(params![
                &entry.term,
                &entry.reading,
                &entry.definition,
                &entry.dict_name,
                &entry.tags,
            ])
            .map_err(|error| format!("Failed to seed embedded dictionary: {error}"))?;
        inserted += 1;

        if frequency_terms.insert(entry.term.clone()) {
            insert_frequency
                .execute(params![
                    &entry.term,
                    &entry.reading,
                    entry.frequency,
                    entry.frequency.to_string(),
                    FREQUENCY_DICTIONARY,
                ])
                .map_err(|error| format!("Failed to seed embedded frequency: {error}"))?;
        }
    }

    if inserted < 1_000 {
        return Err(format!(
            "Embedded dictionary is unexpectedly small: {inserted} entries"
        ));
    }
    drop(insert_entry);
    drop(insert_frequency);

    for name in DICTIONARIES {
        transaction
            .execute(
                "INSERT OR REPLACE INTO dictionary_meta (title, revision, format, imported_at_ms)
                 VALUES (?1, ?2, 3, ?3)",
                params![name, CORE_DICTIONARY_REVISION, unix_now_ms()],
            )
            .map_err(|error| format!("Failed to save embedded dictionary metadata: {error}"))?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn init_mobile_db(conn: &mut Connection) -> Result<(), String> {
    core::database::configure_connection(conn)?;
    core::database::ensure_canonical_schema(conn)?;
    seed_mobile_starter_dictionaries(conn)?;
    seed_mobile_core_dictionaries(conn)?;
    Ok(())
}

fn get_mobile_db_path(app: &tauri::App) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to access app data dir: {e}"))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(app_dir.join("dictionary.db"))
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

#[tauri::command]
fn get_dictionary_storage_info(state: State<'_, AppState>) -> Result<DictionaryStorageInfo, String> {
    let path = state.db_path.clone();
    let size = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
    Ok(DictionaryStorageInfo {
        path: path.to_string_lossy().into_owned(),
        size,
        available_bytes: available_space_for_path(&path),
    })
}

#[tauri::command]
async fn upload_db_to_drive(
    app: tauri::AppHandle,
    url: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let db_path = state.db_path.clone();
    if !db_path.exists() {
        return Err("Dictionary database does not exist yet.".to_string());
    }
    {
        let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
    }

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
        let response = client
            .patch(&url)
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", file_len.to_string())
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|e| format!("Failed to upload dictionary database: {}", e))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
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
            let response = client
                .put(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", amount.to_string())
                .header("Content-Range", format!("bytes {}-{}/{}", offset, end, file_len))
                .body(chunk.clone())
                .send()
                .await
                .map_err(|error| format!("Failed to upload dictionary chunk: {}", error))?;
            if response.status().is_success() {
                offset = file_len;
                break;
            }
            if response.status().as_u16() == 308 {
                let confirmed = resumable_next_offset(
                    response.headers().get("range").and_then(|value| value.to_str().ok()),
                )
                .min(file_len);
                if confirmed > offset {
                    offset = confirmed;
                    break;
                }
                if attempts < 4 {
                    continue;
                }
            }
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Dictionary database upload failed: {} - {}", status, body));
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
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let db_path = state.db_path.clone();
    let temp_path = db_path.with_extension("db.drive-download");
    let rollback_path = db_path.with_extension("db.before-drive-restore");
    let mut response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Failed to download dictionary database: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Dictionary database download failed: {}", response.status()));
    }
    let total = expected_size.or_else(|| response.content_length()).unwrap_or(0);
    if total > 0 {
        if let Some(available) = available_space_for_path(&db_path) {
            let margin = (total / 50).max(32 * 1024 * 1024);
            if available < total.saturating_add(margin) {
                return Err(format!(
                    "Not enough local storage. Need {} bytes, available {} bytes.",
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
    while let Some(chunk) = response
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

    let mut validation = Connection::open(&temp_path)
        .map_err(|e| format!("Downloaded dictionary database is invalid: {}", e))?;
    init_mobile_db(&mut validation)?;
    validation
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Downloaded dictionary database check failed: {}", e))
        .and_then(|result| {
            if result == "ok" { Ok(()) } else { Err(format!("Downloaded dictionary database check failed: {}", result)) }
        })?;
    drop(validation);

    let mut conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    *conn = Connection::open_in_memory()
        .map_err(|e| format!("Failed to release old dictionary database: {}", e))?;
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(&rollback_path);
    if db_path.exists() {
        std::fs::rename(&db_path, &rollback_path)
            .map_err(|e| format!("Failed to prepare dictionary rollback copy: {}", e))?;
    }
    if let Err(error) = std::fs::rename(&temp_path, &db_path) {
        if rollback_path.exists() {
            let _ = std::fs::rename(&rollback_path, &db_path);
        }
        return Err(format!("Failed to apply downloaded dictionary database: {}", error));
    }
    let mut replacement = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open downloaded dictionary database: {}", e))?;
    init_mobile_db(&mut replacement)?;
    *conn = replacement;
    let _ = std::fs::remove_file(&rollback_path);
    emit_drive_progress(&app, "download", downloaded, downloaded);
    Ok(())
}

#[tauri::command]
async fn lookup_word(word: String, state: State<'_, AppState>) -> Result<Vec<DictEntry>, String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    lookup_word_in_db(&conn, &word)
}

#[tauri::command]
async fn scan_cursor(
    sentence: String,
    cursor: usize,
    state: State<'_, AppState>,
) -> Result<Option<CursorLookupResult>, String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    scan_cursor_in_db(&conn, &sentence, cursor)
}

fn scan_cursor_in_db(
    conn: &Connection,
    sentence: &str,
    cursor: usize,
) -> Result<Option<CursorLookupResult>, String> {
    let chars: Vec<char> = sentence.chars().collect();
    if chars.is_empty() {
        return Ok(None);
    }

    let cursor = cursor.min(chars.len().saturating_sub(1));

    if let Some((start, end)) = scan_latin_word_bounds(&chars, cursor) {
        if let Some(result) = scan_english_phrase_at_cursor(conn, &chars, cursor)? {
            return Ok(Some(result));
        }

        let word: String = chars[start..end].iter().collect();
        let mut entries = lookup_word_in_db(conn, &word)?;
        if entries.is_empty() {
            let lowercase = word.to_lowercase();
            if lowercase != word {
                entries = lookup_word_in_db(conn, &lowercase)?;
            }
        }
        return Ok((!entries.is_empty()).then_some(CursorLookupResult {
            word,
            start,
            end,
            entries,
        }));
    }

    if !is_japanese_word_char(chars[cursor]) {
        return Ok(None);
    }

    // Jidoujisho-style lookup: segment first, then search exactly the word block
    // under the cursor. This keeps visual blocks and dictionary selection in sync.
    if let Ok(tokens) = segment_japanese_text(sentence) {
        if let Some(token) = tokens
            .iter()
            .find(|token| token.lookup && token.start <= cursor && cursor < token.end)
        {
            let entries = lookup_segmented_token(conn, token)?;
            return Ok((!entries.is_empty()).then_some(CursorLookupResult {
                word: token.text.clone(),
                start: token.start,
                end: token.end,
                entries,
            }));
        }
        return Ok(None);
    }

    let mut start = cursor;
    while start > 0 && is_japanese_word_char(chars[start - 1]) {
        start -= 1;
    }

    let mut end = cursor;
    while end < chars.len() && is_japanese_word_char(chars[end]) {
        end += 1;
    }

    if start >= end {
        return Ok(None);
    }

    // Search around the tapped character, not from the beginning of the whole Japanese run.
    // A valid candidate must actually cover the cursor. Longer compounds beat a stray
    // one-kanji entry, while exact forms beat deinflected fallbacks of the same length.
    let earliest_start = start.max(cursor.saturating_sub(11));
    let mut best: Option<(
        (u8, u8, std::cmp::Reverse<usize>, usize),
        CursorLookupResult,
    )> = None;

    for candidate_start in earliest_start..=cursor {
        let probe: String = chars[candidate_start..end].iter().collect();
        let entries = lookup_word_in_db(conn, &probe)?;
        if entries.is_empty() {
            continue;
        }
        let match_len = entries
            .iter()
            .map(|entry| entry.source_length.max(1))
            .max()
            .unwrap_or(0)
            .min(end - candidate_start);
        if match_len == 0 || candidate_start + match_len <= cursor {
            continue;
        }

        let word: String = chars[candidate_start..candidate_start + match_len]
            .iter()
            .collect();
        let definition_penalty = if entries.iter().any(|entry| {
            entry.definitions.iter().any(|definition| !definition.trim().is_empty())
        }) { 0 } else { 1 };
        let single_kanji_penalty = if match_len == 1
            && chars
                .get(candidate_start)
                .copied()
                .map(|ch| matches!(ch, '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'))
                .unwrap_or(false)
        { 1 } else { 0 };
        let morphology_cost = entries
            .iter()
            .map(|entry| entry.deinflection_reasons.len())
            .min()
            .unwrap_or(usize::MAX);
        let score = (
            definition_penalty,
            single_kanji_penalty,
            std::cmp::Reverse(match_len),
            morphology_cost + cursor.saturating_sub(candidate_start),
        );
        let result = CursorLookupResult {
            word,
            start: candidate_start,
            end: candidate_start + match_len,
            entries,
        };
        if best.as_ref().map(|(best_score, _)| score < *best_score).unwrap_or(true) {
            best = Some((score, result));
        }
    }

    Ok(best.map(|(_, result)| result))
}

fn lookup_segmented_token(conn: &Connection, token: &TextToken) -> Result<Vec<DictEntry>, String> {
    let source_length = token.text.chars().count();
    let mut entries = query_exact_forms(conn, &token.text, source_length, &[])?;
    if !entries.is_empty() {
        return Ok(entries);
    }

    if source_length >= 2 && token.text.chars().last().is_some_and(is_kana) {
        entries = deinflect_forms(conn, &token.text, source_length)?;
        if !entries.is_empty() {
            return Ok(entries);
        }
    }

    if let Some(lemma) = token
        .lemma
        .as_deref()
        .filter(|lemma| !lemma.is_empty() && *lemma != token.text)
    {
        entries = query_exact_forms(conn, lemma, source_length, &[])?;
        if !entries.is_empty() {
            return Ok(entries);
        }
        if lemma.chars().count() >= 2 && lemma.chars().last().is_some_and(is_kana) {
            entries = deinflect_forms(conn, lemma, source_length)?;
            if !entries.is_empty() {
                return Ok(entries);
            }
        }
    }

    // The UI already selected this analyzer block. A shorter dictionary prefix
    // belongs to a different tap target and must not replace the whole block.
    Ok(lookup_word_in_db(conn, &token.text)?
        .into_iter()
        .filter(|entry| entry.source_length >= source_length)
        .collect())
}

fn is_japanese_word_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{3040}'..='\u{30ff}'
            | '\u{3400}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
            | '\u{ff66}'..='\u{ff9f}'
            | '々'
            | '〆'
    )
}

fn is_kanji_char(ch: char) -> bool {
    matches!(ch, '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}

fn is_hiragana_char(ch: char) -> bool {
    matches!(ch, '\u{3040}'..='\u{309f}')
}

fn is_katakana_char(ch: char) -> bool {
    matches!(ch, '\u{30a0}'..='\u{30ff}' | '\u{ff66}'..='\u{ff9f}')
}

fn is_single_hiragana_particle(ch: char) -> bool {
    matches!(
        ch,
        'は' | 'が' | 'を' | 'に' | 'へ' | 'で' | 'と' | 'の' | 'も' | 'や' | 'か' | 'ね'
            | 'よ' | 'ぞ' | 'さ'
    )
}

// Dictionary matching remains the primary tokenizer. This fallback only decides how far to
// advance after an unknown surface, so one missing word cannot swallow the rest of a sentence.
fn fallback_japanese_segment_len(chars: &[char], start: usize) -> usize {
    if start >= chars.len() {
        return 0;
    }

    let first = chars[start];
    if is_kanji_char(first) {
        let mut end = start;
        while end < chars.len() && is_kanji_char(chars[end]) && end - start < 4 {
            end += 1;
        }
        let kanji_end = end;
        while end < chars.len() && is_hiragana_char(chars[end]) && end - kanji_end < 4 {
            if end == kanji_end && is_single_hiragana_particle(chars[end]) {
                break;
            }
            end += 1;
        }
        return (end - start).max(1);
    }

    if is_katakana_char(first) {
        let mut end = start + 1;
        while end < chars.len() && is_katakana_char(chars[end]) && end - start < 12 {
            end += 1;
        }
        return end - start;
    }

    if is_hiragana_char(first) {
        if is_single_hiragana_particle(first) {
            return 1;
        }
        let mut end = start + 1;
        while end < chars.len() && is_hiragana_char(chars[end]) && end - start < 6 {
            if is_single_hiragana_particle(chars[end]) {
                break;
            }
            end += 1;
        }
        return end - start;
    }

    1
}

fn is_latin_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(ch, '\u{00c0}'..='\u{024f}' | '\u{1e00}'..='\u{1eff}')
}

fn is_latin_word_joiner(ch: char) -> bool {
    matches!(ch, '\'' | '\u{2019}' | '-')
}

fn scan_latin_word_bounds(chars: &[char], cursor: usize) -> Option<(usize, usize)> {
    if chars.is_empty() || cursor >= chars.len() || !is_latin_word_char(chars[cursor]) {
        return None;
    }
    let mut start = cursor;
    while start > 0 && (is_latin_word_char(chars[start - 1]) || is_latin_word_joiner(chars[start - 1])) {
        start -= 1;
    }
    while start < chars.len() && !is_latin_word_char(chars[start]) {
        start += 1;
    }
    let mut end = cursor + 1;
    while end < chars.len() && (is_latin_word_char(chars[end]) || is_latin_word_joiner(chars[end])) {
        end += 1;
    }
    while end > start && !is_latin_word_char(chars[end - 1]) {
        end -= 1;
    }
    (start < end).then_some((start, end))
}

#[derive(Debug, Clone)]
struct LatinWordSpan {
    start: usize,
    end: usize,
    text: String,
}

fn collect_latin_word_spans(chars: &[char]) -> Vec<LatinWordSpan> {
    let mut spans = Vec::new();
    let mut index = 0usize;

    while index < chars.len() {
        if !is_latin_word_char(chars[index]) {
            index += 1;
            continue;
        }

        let start = index;
        index += 1;
        while index < chars.len()
            && (is_latin_word_char(chars[index]) || is_latin_word_joiner(chars[index]))
        {
            index += 1;
        }

        let mut end = index;
        while end > start && !is_latin_word_char(chars[end - 1]) {
            end -= 1;
        }
        if start < end {
            spans.push(LatinWordSpan {
                start,
                end,
                text: chars[start..end].iter().collect(),
            });
        }
    }

    spans
}

fn is_english_phrase_gap(chars: &[char], start: usize, end: usize) -> bool {
    start <= end
        && chars[start..end].iter().all(|ch| {
            !matches!(ch, '\n' | '\r') && (ch.is_whitespace() || matches!(ch, ','))
        })
}

fn normalize_english_phrase_surface(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn push_unique_english_form(forms: &mut Vec<String>, value: impl Into<String>) {
    let value = normalize_english_phrase_surface(&value.into());
    if value.is_empty() {
        return;
    }
    let value = value.to_lowercase();
    if !forms.contains(&value) {
        forms.push(value.clone());
    }
    let ascii_apostrophe = value.replace('\u{2019}', "'");
    if ascii_apostrophe != value && !forms.contains(&ascii_apostrophe) {
        forms.push(ascii_apostrophe);
    }
}

fn english_base_form_candidates(word: &str) -> Vec<String> {
    let word = word.to_lowercase().replace('\u{2019}', "'");
    let mut forms = Vec::new();
    push_unique_english_form(&mut forms, word.clone());

    const IRREGULAR: &[(&str, &str)] = &[
        ("arose", "arise"),
        ("arisen", "arise"),
        ("ate", "eat"),
        ("eaten", "eat"),
        ("became", "become"),
        ("began", "begin"),
        ("begun", "begin"),
        ("bit", "bite"),
        ("bitten", "bite"),
        ("blew", "blow"),
        ("blown", "blow"),
        ("broke", "break"),
        ("broken", "break"),
        ("brought", "bring"),
        ("built", "build"),
        ("bought", "buy"),
        ("came", "come"),
        ("caught", "catch"),
        ("chose", "choose"),
        ("chosen", "choose"),
        ("dealt", "deal"),
        ("did", "do"),
        ("done", "do"),
        ("drew", "draw"),
        ("drawn", "draw"),
        ("drank", "drink"),
        ("drunk", "drink"),
        ("drove", "drive"),
        ("driven", "drive"),
        ("fell", "fall"),
        ("fallen", "fall"),
        ("felt", "feel"),
        ("fled", "flee"),
        ("flew", "fly"),
        ("flown", "fly"),
        ("forgot", "forget"),
        ("forgotten", "forget"),
        ("found", "find"),
        ("gave", "give"),
        ("given", "give"),
        ("got", "get"),
        ("gotten", "get"),
        ("grew", "grow"),
        ("grown", "grow"),
        ("had", "have"),
        ("heard", "hear"),
        ("held", "hold"),
        ("kept", "keep"),
        ("knew", "know"),
        ("known", "know"),
        ("laid", "lay"),
        ("led", "lead"),
        ("left", "leave"),
        ("lent", "lend"),
        ("lost", "lose"),
        ("made", "make"),
        ("met", "meet"),
        ("paid", "pay"),
        ("ran", "run"),
        ("rang", "ring"),
        ("rung", "ring"),
        ("rode", "ride"),
        ("ridden", "ride"),
        ("rose", "rise"),
        ("risen", "rise"),
        ("said", "say"),
        ("sang", "sing"),
        ("sung", "sing"),
        ("sat", "sit"),
        ("saw", "see"),
        ("seen", "see"),
        ("sent", "send"),
        ("shook", "shake"),
        ("shaken", "shake"),
        ("shot", "shoot"),
        ("slept", "sleep"),
        ("sold", "sell"),
        ("spoke", "speak"),
        ("spoken", "speak"),
        ("spent", "spend"),
        ("stood", "stand"),
        ("stole", "steal"),
        ("stolen", "steal"),
        ("swam", "swim"),
        ("swum", "swim"),
        ("taught", "teach"),
        ("thought", "think"),
        ("threw", "throw"),
        ("thrown", "throw"),
        ("told", "tell"),
        ("took", "take"),
        ("taken", "take"),
        ("understood", "understand"),
        ("went", "go"),
        ("gone", "go"),
        ("woke", "wake"),
        ("woken", "wake"),
        ("won", "win"),
        ("wore", "wear"),
        ("worn", "wear"),
        ("wrote", "write"),
        ("written", "write"),
        ("lying", "lie"),
    ];
    if let Some((_, base)) = IRREGULAR.iter().find(|(surface, _)| *surface == word) {
        push_unique_english_form(&mut forms, *base);
    }

    let is_double_consonant = |value: &str| {
        let bytes = value.as_bytes();
        bytes.len() >= 2
            && bytes[bytes.len() - 1] == bytes[bytes.len() - 2]
            && matches!(bytes[bytes.len() - 1] as char, 'b'..='d' | 'f'..='h' | 'j'..='n' | 'p'..='t' | 'v'..='z')
    };

    if let Some(stem) = word.strip_suffix("ies") {
        push_unique_english_form(&mut forms, format!("{stem}y"));
    }
    if let Some(stem) = word.strip_suffix("ied") {
        push_unique_english_form(&mut forms, format!("{stem}y"));
    }
    if let Some(stem) = word.strip_suffix("ing").filter(|stem| stem.len() >= 2) {
        push_unique_english_form(&mut forms, stem);
        push_unique_english_form(&mut forms, format!("{stem}e"));
        if is_double_consonant(stem) {
            push_unique_english_form(&mut forms, &stem[..stem.len() - 1]);
        }
    }
    if let Some(stem) = word.strip_suffix("ed").filter(|stem| stem.len() >= 2) {
        push_unique_english_form(&mut forms, stem);
        push_unique_english_form(&mut forms, format!("{stem}e"));
        if is_double_consonant(stem) {
            push_unique_english_form(&mut forms, &stem[..stem.len() - 1]);
        }
    }
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        push_unique_english_form(&mut forms, &word[..word.len() - 1]);
    }
    if let Some(stem) = word.strip_suffix("es").filter(|stem| stem.len() >= 2) {
        push_unique_english_form(&mut forms, stem);
    }

    forms
}

fn add_possessive_idiom_variants(forms: &mut Vec<String>) {
    let originals = forms.clone();
    for form in originals {
        let words = form.split_whitespace().collect::<Vec<_>>();
        if !words.iter().any(|word| {
            matches!(*word, "my" | "your" | "his" | "her" | "our" | "their" | "its")
        }) {
            continue;
        }
        for replacement in ["one's", "someone's"] {
            let replaced = words
                .iter()
                .map(|word| {
                    if matches!(*word, "my" | "your" | "his" | "her" | "our" | "their" | "its") {
                        replacement
                    } else {
                        *word
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            push_unique_english_form(forms, replaced);
        }
    }
}

fn english_phrase_lookup_forms(
    chars: &[char],
    words: &[LatinWordSpan],
    left: usize,
    right: usize,
) -> Vec<String> {
    let mut forms = Vec::new();
    let surface: String = chars[words[left].start..words[right].end].iter().collect();
    let joined = words[left..=right]
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let first_word = &words[left].text;
    let normalized_first = first_word.to_lowercase().replace('\u{2019}', "'");
    for base in english_base_form_candidates(first_word)
        .into_iter()
        .filter(|base| base != &normalized_first)
    {
        let rest = words[left + 1..=right]
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        push_unique_english_form(&mut forms, format!("{base} {rest}"));

        if let Some(surface_rest) = surface.strip_prefix(first_word.as_str()) {
            push_unique_english_form(&mut forms, format!("{base}{surface_rest}"));
        }
    }

    // Prefer the canonical lemma before a Yomitan `non-lemma` redirect.
    push_unique_english_form(&mut forms, surface.clone());
    push_unique_english_form(&mut forms, joined);

    add_possessive_idiom_variants(&mut forms);
    forms
}

fn is_english_phrasal_particle(word: &str) -> bool {
    matches!(
        word.to_lowercase().as_str(),
        "about"
            | "across"
            | "ahead"
            | "along"
            | "apart"
            | "around"
            | "aside"
            | "away"
            | "back"
            | "by"
            | "down"
            | "forward"
            | "in"
            | "off"
            | "on"
            | "out"
            | "over"
            | "round"
            | "through"
            | "together"
            | "up"
    )
}

fn english_separable_phrasal_forms(verb: &str, particle: &str) -> Vec<String> {
    let mut forms = Vec::new();
    for base in english_base_form_candidates(verb) {
        push_unique_english_form(&mut forms, format!("{base} {particle}"));
    }
    forms
}

fn scan_english_phrase_at_cursor(
    conn: &Connection,
    chars: &[char],
    cursor: usize,
) -> Result<Option<CursorLookupResult>, String> {
    const MAX_PHRASE_WORDS: usize = 8;

    let words = collect_latin_word_spans(chars);
    let Some(hit_index) = words
        .iter()
        .position(|word| word.start <= cursor && cursor < word.end)
    else {
        return Ok(None);
    };

    let mut component_start = hit_index;
    while component_start > 0
        && hit_index - component_start + 1 < MAX_PHRASE_WORDS
        && is_english_phrase_gap(
            chars,
            words[component_start - 1].end,
            words[component_start].start,
        )
    {
        component_start -= 1;
    }

    let mut component_end = hit_index;
    while component_end + 1 < words.len()
        && component_end - hit_index + 1 < MAX_PHRASE_WORDS
        && is_english_phrase_gap(
            chars,
            words[component_end].end,
            words[component_end + 1].start,
        )
    {
        component_end += 1;
    }

    let max_words = MAX_PHRASE_WORDS.min(component_end - component_start + 1);
    // Prefer the nearest expression under the tapped word. A longer idiom is still
    // selected when the user taps a word which only belongs to that idiom.
    for word_count in 2..=max_words {
        for left in component_start..=hit_index {
            let right = left + word_count - 1;
            if right > component_end || hit_index > right {
                continue;
            }

            let source_length = words[right].end - words[left].start;
            for form in english_phrase_lookup_forms(chars, &words, left, right) {
                let entries = query_exact_forms(conn, &form, source_length, &[])?;
                if entries.is_empty() {
                    continue;
                }
                let word = entries
                    .first()
                    .map(|entry| entry.term.clone())
                    .filter(|term| !term.is_empty())
                    .unwrap_or(form);
                return Ok(Some(CursorLookupResult {
                    word,
                    start: words[left].start,
                    end: words[right].end,
                    entries,
                }));
            }
        }
    }

    // Separable phrasal verbs keep their dictionary headword together but allow an
    // object between the verb and particle: "take it out", "space the cards out".
    const MAX_INTERVENING_WORDS: usize = 4;
    for span_word_count in 3..=MAX_INTERVENING_WORDS + 2 {
        for left in component_start..=hit_index {
            let right = left + span_word_count - 1;
            if right > component_end || hit_index > right {
                continue;
            }
            if !is_english_phrasal_particle(&words[right].text) {
                continue;
            }

            let source_length = words[right].end - words[left].start;
            for form in english_separable_phrasal_forms(&words[left].text, &words[right].text) {
                let entries = query_exact_forms(conn, &form, source_length, &[])?;
                if entries.is_empty() {
                    continue;
                }
                let word = entries
                    .first()
                    .map(|entry| entry.term.clone())
                    .filter(|term| !term.is_empty())
                    .unwrap_or(form);
                return Ok(Some(CursorLookupResult {
                    word,
                    start: words[left].start,
                    end: words[right].end,
                    entries,
                }));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
async fn manage_browser(
    _action: String,
    _id: Option<String>,
    _url: Option<String>,
    _x: Option<i32>,
    _y: Option<i32>,
    _width: Option<i32>,
    _height: Option<i32>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn get_browser_info() -> Result<Vec<(String, String)>, String> {
    Ok(Vec::new())
}

#[tauri::command]
async fn get_windows_device_name() -> Result<String, String> {
    Ok("Android phone".to_string())
}

#[tauri::command]
async fn log_frontend_diagnostics(_payload: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn clear_discord_presence() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_discord_presence(_payload: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn set_jl_mode_line(_text: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn open_jl_mode_window(_initial_text: Option<String>) -> Result<(), String> {
    Err("Setsuna Flow is not available on Android yet.".to_string())
}

#[tauri::command]
async fn close_jl_mode_window() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn get_furigana(
    text: String,
    _context_before: Option<String>,
    _context_after: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    if let Ok(tokens) = segment_japanese_text(&text) {
        return tokens
            .into_iter()
            .map(|token| serde_json::to_value(token).map_err(|error| error.to_string()))
            .collect();
    }

    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Ok(Vec::new());
    }

    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    let mut tokens: Vec<Value> = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        // Preserve English word boundaries so English dictionaries receive a word,
        // never an entire sentence.
        if is_latin_word_char(chars[i]) {
            let start = i;
            i += 1;
            while i < chars.len() && (is_latin_word_char(chars[i]) || is_latin_word_joiner(chars[i])) {
                i += 1;
            }
            while i > start && !is_latin_word_char(chars[i - 1]) {
                i -= 1;
            }
            let seg: String = chars[start..i].iter().collect();
            tokens.push(serde_json::json!({ "text": seg, "reading": Value::Null }));
            continue;
        }

        // Group runs of whitespace and punctuation into a plain token.
        if !is_japanese_word_char(chars[i]) {
            let start = i;
            while i < chars.len()
                && !is_japanese_word_char(chars[i])
                && !is_latin_word_char(chars[i])
            {
                i += 1;
            }
            let seg: String = chars[start..i].iter().collect();
            tokens.push(serde_json::json!({ "text": seg, "reading": Value::Null }));
            continue;
        }

        // Greedy longest dictionary match from the current position (Yomitan-style),
        // using the same term/reading table the lookup popup reads.
        let rest: String = chars[i..].iter().collect();
        let entries = lookup_word_in_db(&conn, &rest)?;
        if let Some(first) = entries.first() {
            let len = first.source_length.max(1).min(chars.len() - i);
            let word: String = chars[i..i + len].iter().collect();
            // Only show furigana for exact (non-deinflected) matches — a deinflected entry's
            // reading is for the dictionary form, not the conjugated surface on screen.
            let reading = if !first.reading.is_empty()
                && first.reading != word
                && first.deinflection_reasons.is_empty()
            {
                Value::String(first.reading.clone())
            } else {
                Value::Null
            };
            tokens.push(serde_json::json!({ "text": word, "reading": reading }));
            i += len;
        } else {
            let length = fallback_japanese_segment_len(&chars, i)
                .max(1)
                .min(chars.len() - i);
            let seg: String = chars[i..i + length].iter().collect();
            i += length;
            tokens.push(serde_json::json!({ "text": seg, "reading": Value::Null }));
        }
    }

    Ok(tokens)
}

#[tauri::command]
async fn get_flow_tokens(
    text: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    resolve_flow_tokens(&text, &conn)
}

fn resolve_flow_tokens(text: &str, conn: &Connection) -> Result<Vec<Value>, String> {
    let tokens = segment_japanese_text(text).map_err(|error| error.to_string())?;

    tokens
        .into_iter()
        .map(|token| {
            let entries = if token.lookup {
                lookup_segmented_token(&conn, &token)?
            } else {
                Vec::new()
            };
            let mut value = serde_json::to_value(&token).map_err(|error| error.to_string())?;
            if let Some(object) = value.as_object_mut() {
                if let Some(entry) = entries.first() {
                    object.insert("lookupTerm".to_string(), Value::String(entry.term.clone()));
                    object.insert("lookupReading".to_string(), Value::String(entry.reading.clone()));
                    object.insert("lookupFound".to_string(), Value::Bool(true));
                } else {
                    object.insert("lookupFound".to_string(), Value::Bool(false));
                }
            }
            Ok(value)
        })
        .collect()
}

#[tauri::command]
async fn lookup_cambridge_api(_word: String, _config: Value) -> Result<Vec<DictEntry>, String> {
    Ok(Vec::new())
}

#[tauri::command]
async fn anki_check() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
async fn start_text_sync_server(
    port: Option<u16>,
    token: Option<String>,
) -> Result<TextSyncServerStart, String> {
    Ok(TextSyncServerStart {
        url: String::new(),
        port: port.unwrap_or(48732),
        token: token.unwrap_or_default(),
    })
}

#[tauri::command]
async fn stop_text_sync_server() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn publish_text_sync_event(_kind: String, _payload: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn push_remote_text_sync_event(
    _url: String,
    _token: String,
    _kind: String,
    _payload: Value,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn push_text_sync_cloud_state(
    _url: String,
    _device_id: String,
    _state_key: String,
    _payload: Value,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn pull_text_sync_cloud_state(_url: String) -> Result<Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
async fn save_sync_file(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(path, content)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn load_sync_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn anki_request(action: String, params: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post("http://127.0.0.1:8765")
        .json(&serde_json::json!({
            "action": action,
            "version": 6,
            "params": params,
        }))
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

fn mobile_workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to access app data directory: {error}"))?;
    std::fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    Ok(app_dir.join("workspace-state.json"))
}

#[tauri::command]
async fn save_workspace_state(app: tauri::AppHandle, content: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("Invalid workspace state: {error}"))?;
    let path = mobile_workspace_path(&app)?;
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
async fn load_workspace_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = mobile_workspace_path(&app)?;
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

#[tauri::command]
async fn stop_capture_agent_server() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn get_flow_timer_state() -> bool {
    MOBILE_FLOW_TIMER_PAUSED.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_flow_timer_state(paused: bool) -> bool {
    MOBILE_FLOW_TIMER_PAUSED.store(paused, Ordering::Relaxed);
    paused
}

#[tauri::command]
fn toggle_flow_timer() -> bool {
    let previous = MOBILE_FLOW_TIMER_PAUSED.fetch_xor(true, Ordering::Relaxed);
    !previous
}

fn normalize_api_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

async fn read_json_response(response: reqwest::Response, context: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("{} response read failed: {}", context, e))?;
    if !status.is_success() {
        return Err(format!("{} failed: {} {}", context, status, text));
    }
    serde_json::from_str(&text)
        .map_err(|e| format!("{} response parse failed: {}. {}", context, e, text))
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
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "deviceId": device_id,
            "deviceName": device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Account login failed: {}", e))?;
    read_json_response(response, "Account login").await
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
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "deviceId": device_id,
            "deviceName": device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Account register failed: {}", e))?;
    read_json_response(response, "Account register").await
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
    let mut body = serde_json::json!({
        "deviceId": device_id,
        "deviceName": device_name,
    });
    if let Some(value) = capture_agent_url {
        body["captureAgentUrl"] = Value::String(value);
    }
    if let Some(value) = capture_agent_token {
        body["captureAgentToken"] = Value::String(value);
    }
    let response = reqwest::Client::new()
        .post(format!("{}/devices", normalize_api_base_url(&api_base_url)))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Device register failed: {}", e))?;
    read_json_response(response, "Device register").await
}

#[tauri::command]
async fn account_list_devices(api_base_url: String, token: String) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/devices", normalize_api_base_url(&api_base_url)))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Device list failed: {}", e))?;
    read_json_response(response, "Device list").await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let db_path = get_mobile_db_path(app)?;
            let mut conn = Connection::open(&db_path)
                .map_err(|e| format!("Failed to open db at {}: {e}", db_path.display()))?;
            init_mobile_db(&mut conn)?;

            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
            });

            Ok(())
        })
        .invoke_handler(generate_handler![
            import_dictionary,
            import_dictionaries,
            lookup_text,
            get_installed_dicts,
            clear_database,
            delete_dictionaries,
            lookup_word,
            scan_cursor,
            start_oauth_server,
            get_dictionary_storage_info,
            upload_db_to_drive,
            download_db_from_drive,
            manage_browser,
            get_browser_info,
            get_windows_device_name,
            log_frontend_diagnostics,
            clear_discord_presence,
            update_discord_presence,
            set_jl_mode_line,
            open_jl_mode_window,
            close_jl_mode_window,
            get_furigana,
            get_flow_tokens,
            lookup_cambridge_api,
            anki_check,
            start_text_sync_server,
            stop_text_sync_server,
            publish_text_sync_event,
            push_remote_text_sync_event,
            push_text_sync_cloud_state,
            pull_text_sync_cloud_state,
            save_sync_file,
            load_sync_file,
            anki_request,
            save_workspace_state,
            load_workspace_state,
            stop_capture_agent_server,
            get_flow_timer_state,
            set_flow_timer_state,
            toggle_flow_timer,
            account_login,
            account_register,
            account_register_device,
            account_list_devices
        ])
        .run(generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod deinflect_tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::Cursor;

    fn seeded_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let rows = [
            ("食べる", "たべる", "v1 vt"),
            ("見る", "みる", "v1 vt"),
            ("会う", "あう", "v5u vi"),
            ("降る", "ふる", "v5r vi"),
            ("痛い", "いたい", "adj-i"),
            ("杏", "あんず", "n"),
        ];
        for (term, reading, tags) in rows {
            conn.execute(
                "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, '[\"gloss\"]', 'Test', ?3)",
                params![term, reading, tags],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn mobile_yomitan_import_uses_canonical_entries_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let tx = conn.transaction().unwrap();
        let count = stream_mobile_term_bank(
            Cursor::new(r#"[["受け取る","うけとる","v5r",null,null,["to receive"],null,"vt"]]"#.as_bytes()),
            &tx,
            "Mobile test",
        )
        .unwrap();
        tx.commit().unwrap();

        assert_eq!(count, 1);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name = 'Mobile test'",
                [],
                |row| row.get::<_, i64>(0),
            )
                .unwrap(),
            1
        );
        assert!(!core::database::table_exists(&conn, "dictionary").unwrap());
    }

    #[test]
    fn mobile_lookup_reads_plain_desktop_definition() {
        let conn = seeded_conn();
        conn.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags)
             VALUES ('desktop', 'desktop', 'plain definition', 'Desktop test', '')",
            [],
        )
        .unwrap();

        let entries = lookup_word_in_db(&conn, "desktop").unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.definitions == vec!["plain definition".to_string()]));
    }

    #[test]
    fn past_tense_verb_resolves_to_dictionary_form() {
        let conn = seeded_conn();
        let entries = lookup_word_in_db(&conn, "食べた").unwrap();
        let hit = entries
            .iter()
            .find(|e| e.term == "食べる")
            .expect("食べた should deinflect to 食べる");
        assert!(
            !hit.deinflection_reasons.is_empty(),
            "deinflected entry must carry a reason chain"
        );
        assert_eq!(hit.source_length, 3, "source_length must span the full surface");
    }

    #[test]
    fn masu_stem_resolves() {
        let conn = seeded_conn();
        let entries = lookup_word_in_db(&conn, "降り").unwrap();
        assert!(
            entries.iter().any(|e| e.term == "降る"),
            "降り should deinflect to 降る"
        );
    }

    #[test]
    fn plain_noun_is_exact_with_no_reasons() {
        let conn = seeded_conn();
        let entries = lookup_word_in_db(&conn, "杏").unwrap();
        let hit = entries.iter().find(|e| e.term == "杏").expect("杏 should match exactly");
        assert!(
            hit.deinflection_reasons.is_empty(),
            "an exact noun match must not carry deinflection reasons"
        );
    }

    #[test]
    fn deinflection_does_not_match_random_noun() {
        // 杏 (noun) must never be produced by deinflecting some conjugation onto it.
        let conn = seeded_conn();
        let entries = lookup_word_in_db(&conn, "杏").unwrap();
        assert!(entries.iter().all(|e| e.deinflection_reasons.is_empty()));
    }

    #[test]
    fn starter_dictionaries_are_seeded_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name LIKE 'Setsuna Starter %'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        init_mobile_db(&mut conn).unwrap();
        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name LIKE 'Setsuna Starter %'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(before > 50);
        assert_eq!(before, after);
    }

    #[test]
    fn embedded_core_dictionaries_are_seeded_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name LIKE 'Setsuna Core JP-%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        init_mobile_db(&mut conn).unwrap();
        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE dict_name LIKE 'Setsuna Core JP-%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(before > 10_000);
        assert_eq!(before, after);
    }

    #[test]
    fn unknown_japanese_does_not_swallow_the_rest_of_the_sentence() {
        let chars: Vec<char> = "米屋で米をもらい、来た道を引き返す。".chars().collect();
        let mut segments = Vec::new();
        let mut index = 0usize;
        while index < chars.len() {
            if !is_japanese_word_char(chars[index]) {
                index += 1;
                continue;
            }
            let length = fallback_japanese_segment_len(&chars, index);
            segments.push(chars[index..index + length].iter().collect::<String>());
            index += length;
        }
        assert!(segments.len() >= 8, "segments: {segments:?}");
        assert!(segments.contains(&"米屋".to_string()));
        assert!(segments.contains(&"来た".to_string()));
        assert!(segments.contains(&"引き".to_string()));
        assert!(segments.contains(&"返す".to_string()));
    }

    #[test]
    fn mobile_scan_cursor_selects_word_under_tap() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let sentence = "私は日本人です";
        let result = scan_cursor_in_db(&conn, sentence, 3)
            .unwrap()
            .expect("tap on 本 must resolve a word");
        assert_eq!(result.word, "日本人");
        assert_eq!((result.start, result.end), (2, 5));
    }

    #[test]
    fn flow_tokens_resolve_polite_surface_to_dictionary_form() {
        let conn = seeded_conn();
        let tokens = resolve_flow_tokens("では、またお会いできますね", &conn).unwrap();
        let token = tokens
            .iter()
            .find(|token| token.get("text").and_then(Value::as_str) == Some("会いできます"))
            .expect("the polite verb must remain one clickable surface block");
        assert_eq!(token.get("lookupTerm").and_then(Value::as_str), Some("会う"));
        assert_eq!(token.get("lookupReading").and_then(Value::as_str), Some("あう"));
    }

    #[test]
    fn mobile_scan_cursor_keeps_the_full_segment_instead_of_a_short_prefix() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let result = scan_cursor_in_db(&conn, "米屋で米をもらい、来た道を引き返す。", 0)
            .unwrap()
            .expect("米屋 must resolve as the selected analyzer block");
        assert_eq!(result.word, "米屋");
        assert_eq!((result.start, result.end), (0, 2));
        assert!(result.entries.iter().all(|entry| entry.source_length == 2));
        assert!(result.entries.iter().any(|entry| entry.term == "米屋"));
    }

    #[test]
    fn mobile_scan_cursor_does_not_prepend_unrelated_katakana() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let result = scan_cursor_in_db(&conn, "ド変態", 1)
            .unwrap()
            .expect("tap on 変 must resolve 変態");
        assert_eq!(result.word, "変態");
        assert_eq!((result.start, result.end), (1, 3));
    }

    fn insert_english_test_entry(conn: &Connection, term: &str) {
        conn.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags)
             VALUES (?1, '', '[\"test definition\"]', 'English test', '')",
            params![term],
        )
        .unwrap();
    }

    #[test]
    fn english_phrasal_verb_beats_single_word_lookup() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "get out");
        insert_english_test_entry(&conn, "out");

        let result = scan_cursor_in_db(&conn, "Please get out now.", 12)
            .unwrap()
            .expect("get out must resolve as a phrase");
        assert_eq!(result.word, "get out");
        assert_eq!((result.start, result.end), (7, 14));
        assert!(result.entries.iter().all(|entry| entry.term == "get out"));
    }

    #[test]
    fn english_phrasal_verb_resolves_inflected_first_word() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "space out");

        let result = scan_cursor_in_db(&conn, "I spaced out again.", 10)
            .unwrap()
            .expect("spaced out must resolve to space out");
        assert_eq!(result.word, "space out");
        assert_eq!((result.start, result.end), (2, 12));
    }

    #[test]
    fn english_phrasal_verb_beats_exact_inflected_word() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "close up");
        insert_english_test_entry(&conn, "closed");

        let result = scan_cursor_in_db(&conn, "I closed up", 5)
            .unwrap()
            .expect("closed up must resolve to close up");
        assert_eq!(result.word, "close up");
        assert_eq!((result.start, result.end), (2, 11));
        assert!(result.entries.iter().all(|entry| entry.term == "close up"));
    }

    #[test]
    fn english_phrase_prefers_lemma_over_non_lemma_redirect() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "close up");
        insert_english_test_entry(&conn, "close up shop");
        conn.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags)
             VALUES (?1, '', ?2, 'English test', 'non-lemma')",
            params![
                "closed up shop",
                r#"[["close up shop",["past participle"]]]"#
            ],
        )
        .unwrap();

        let result = scan_cursor_in_db(&conn, "Anyway, I closed up shop.", 21)
            .unwrap()
            .expect("the canonical close up shop article must win");
        assert_eq!(result.word, "close up shop");
        assert_eq!((result.start, result.end), (10, 24));
        assert!(result
            .entries
            .iter()
            .all(|entry| entry.term == "close up shop"));
    }

    #[test]
    fn english_phrase_prefers_nearby_phrasal_verb_over_longer_idiom() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "close up");
        insert_english_test_entry(&conn, "close up shop");

        let result = scan_cursor_in_db(&conn, "Anyway, I closed up shop.", 13)
            .unwrap()
            .expect("closed up must remain available inside the longer idiom");
        assert_eq!(result.word, "close up");
        assert_eq!((result.start, result.end), (10, 19));
        assert!(result.entries.iter().all(|entry| entry.term == "close up"));
    }

    #[test]
    fn english_phrasal_verb_allows_an_object_before_particle() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "space out");

        let sentence = "She spaced the cards out evenly.";
        let cursor = sentence.find("cards").unwrap() + 2;
        let result = scan_cursor_in_db(&conn, sentence, cursor)
            .unwrap()
            .expect("separable phrasal verb must resolve across its object");
        assert_eq!(result.word, "space out");
        assert_eq!((result.start, result.end), (4, 24));
    }

    #[test]
    fn english_idiom_resolves_inflected_dictionary_form() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "kick the bucket");

        let result = scan_cursor_in_db(&conn, "He kicked the bucket yesterday.", 16)
            .unwrap()
            .expect("inflected idiom must resolve");
        assert_eq!(result.word, "kick the bucket");
        assert_eq!((result.start, result.end), (3, 20));
    }

    #[test]
    fn english_idiom_supports_possessive_placeholders() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "pull one's leg");

        let result = scan_cursor_in_db(&conn, "Stop pulling my leg.", 17)
            .unwrap()
            .expect("possessive idiom must resolve");
        assert_eq!(result.word, "pull one's leg");
        assert_eq!((result.start, result.end), (5, 19));
    }

    #[test]
    fn english_single_word_remains_available_without_phrase_hit() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "out");

        let result = scan_cursor_in_db(&conn, "Stay out.", 6)
            .unwrap()
            .expect("single word fallback must still work");
        assert_eq!(result.word, "out");
        assert_eq!((result.start, result.end), (5, 8));
    }
}
