use rusqlite::{params, Connection, Transaction};
use serde::de::DeserializeSeed;
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
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
        conn.busy_timeout(Duration::from_secs(15))
            .map_err(|error| format!("Failed to configure dictionary database: {error}"))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|error| format!("Failed to configure dictionary database: {error}"))?;
        ensure_mobile_schema(&conn)?;

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
    tx.execute(
        "DELETE FROM dictionary WHERE dict_name = ?1",
        params![&dict_name],
    )
    .map_err(|error| format!("Failed to replace existing dictionary: {error}"))?;
    let count = stream_mobile_term_bank(reader, &tx, &dict_name)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

fn import_yomitan_zip(conn: &mut Connection, path: &str) -> Result<usize, String> {
    let file = File::open(path).map_err(|e| format!("Zip open error: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Zip read error: {}", e))?;
    let mut dict_name = fallback_dict_name(path);

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
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM dictionary WHERE dict_name = ?1",
        params![&dict_name],
    )
    .map_err(|error| format!("Failed to replace existing dictionary: {error}"))?;
    let mut total = 0usize;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| format!("Zip entry error: {}", e))?;
        let name = file.name().to_string();
        let lower = name.to_lowercase();
        if !lower.ends_with(".json") || !lower.contains("term_bank") {
            continue;
        }

        total += stream_mobile_term_bank(file, &tx, &dict_name)
            .map_err(|error| format!("{}: {}", name, error))?;
    }

    if total == 0 {
        return Err("No term_bank*.json files found in this Yomitan zip.".to_string());
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(total)
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
        tx.execute(
            "INSERT INTO dictionary (term, reading, meanings, dict_name) VALUES (?1, ?2, ?3, ?4)",
            params![term, reading, meanings_str, dict_name],
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
            .prepare("SELECT term, reading, meanings FROM dictionary WHERE term = ?1 LIMIT 1")
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
    let mut names = Vec::new();

    if table_exists(&conn, "entries") {
        if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT dict_name FROM entries WHERE dict_name IS NOT NULL AND dict_name != '' ORDER BY dict_name") {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows {
                names.push(row.map_err(|e| e.to_string())?);
            }
        }
    }

    if table_exists(&conn, "dictionary") {
        ensure_mobile_schema(&conn)?;
        let mut stmt = conn
            .prepare("SELECT DISTINCT COALESCE(dict_name, 'Mobile dictionary') FROM dictionary ORDER BY 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let name = row.map_err(|e| e.to_string())?;
            if !names.iter().any(|item| item == &name) {
                names.push(name);
            }
        }
    }

    Ok(names)
}

#[tauri::command]
async fn clear_database(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    if table_exists(&conn, "entries") {
        conn.execute("DELETE FROM entries", [])
            .map_err(|e| e.to_string())?;
    }
    if table_exists(&conn, "dictionary") {
        conn.execute("DELETE FROM dictionary", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_dictionaries(
    dict_names: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    for name in dict_names {
        if table_exists(&conn, "entries") {
            conn.execute("DELETE FROM entries WHERE dict_name = ?1", params![name])
                .map_err(|e| e.to_string())?;
        }
        if table_exists(&conn, "dictionary") {
            ensure_mobile_schema(&conn)?;
            conn.execute("DELETE FROM dictionary WHERE dict_name = ?1", params![name])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

fn entry_from_row(
    term: String,
    reading: String,
    meanings_str: String,
    dict_name: String,
    source_length: usize,
) -> DictEntry {
    let meanings = serde_json::from_str(&meanings_str).unwrap_or(Value::Null);
    DictEntry {
        term,
        reading,
        definitions: meanings_to_definitions(meanings),
        dict_name,
        score: 0,
        tags: String::new(),
        deinflection_reasons: Vec::new(),
        frequencies: Vec::new(),
        pitches: Vec::new(),
        source_length,
    }
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        params![name],
        |_| Ok(()),
    )
    .is_ok()
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

// Exact term/reading query against whichever table is present, building entries for a given
// source_length and (optional) deinflection reason chain.
fn query_exact_forms(
    conn: &Connection,
    snippet: &str,
    source_length: usize,
    reasons: &[Value],
) -> Result<Vec<DictEntry>, String> {
    let mut entries = Vec::new();
    if table_exists(conn, "entries") {
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
    } else if table_exists(conn, "dictionary") {
        let mut stmt = conn
            .prepare(
                "SELECT term, reading, meanings, COALESCE(dict_name, 'Mobile dictionary') FROM dictionary
                 WHERE term = ?1 OR reading = ?1
                 LIMIT 20",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![snippet], |row| {
                let term: String = row.get(0)?;
                let reading: String = row.get(1)?;
                let meanings_str: String = row.get(2)?;
                let dict_name: String = row.get(3)?;
                let mut entry = entry_from_row(term, reading, meanings_str, dict_name, source_length);
                entry.deinflection_reasons = reasons.to_vec();
                Ok(entry)
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(entries)
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

fn ensure_mobile_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dictionary (
            id INTEGER PRIMARY KEY,
            term TEXT NOT NULL,
            reading TEXT,
            meanings TEXT,
            dict_name TEXT DEFAULT 'Mobile dictionary'
        )",
        [],
    )
    .map_err(|e| format!("Failed to create dictionary table: {e}"))?;

    let has_dict_name = conn
        .prepare("SELECT dict_name FROM dictionary LIMIT 1")
        .is_ok();
    if !has_dict_name {
        conn.execute(
            "ALTER TABLE dictionary ADD COLUMN dict_name TEXT DEFAULT 'Mobile dictionary'",
            [],
        )
        .map_err(|e| format!("Failed to migrate dictionary table: {e}"))?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_term ON dictionary (term)",
        [],
    )
    .map_err(|e| format!("Failed to create term index: {e}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_dictionary_dict_name ON dictionary (dict_name)",
        [],
    )
    .map_err(|e| format!("Failed to create dictionary name index: {e}"))?;

    Ok(())
}

fn init_mobile_db(conn: &Connection) -> Result<(), String> {
    ensure_mobile_schema(conn)
}

fn get_mobile_db_path(app: &tauri::App) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to access app data dir: {e}"))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(app_dir.join("dictionary.db"))
}

#[tauri::command]
async fn upload_db_to_drive(
    url: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    if !Path::new(&db_path).exists() {
        return Err("Dictionary database does not exist yet.".to_string());
    }

    let file = tokio::fs::File::open(&db_path)
        .await
        .map_err(|e| format!("Failed to open dictionary database: {}", e))?;
    let file_len = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to inspect dictionary database: {}", e))?
        .len();
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = reqwest::Body::wrap_stream(stream);
    let res = reqwest::Client::new()
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
        return Err(format!(
            "Dictionary database upload failed: {status} {body}"
        ));
    }

    Ok(())
}

#[tauri::command]
async fn download_db_from_drive(
    url: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    let temp_path = db_path.with_extension("download");
    let mut res = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Failed to download dictionary database: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Dictionary database download failed: {}",
            res.status()
        ));
    }

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temporary dictionary database: {}", e))?;
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Failed to read downloaded dictionary database: {}", e))?
    {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("Failed to save dictionary database: {}", e))?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("Failed to flush dictionary database: {}", e))?;
    drop(file);

    let mut conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    *conn =
        Connection::open_in_memory().map_err(|e| format!("Failed to release old database: {e}"))?;
    std::fs::rename(&temp_path, &db_path)
        .or_else(|_| {
            std::fs::copy(&temp_path, &db_path).map(|_| ())?;
            std::fs::remove_file(&temp_path).ok();
            Ok::<(), std::io::Error>(())
        })
        .map_err(|e| format!("Failed to replace dictionary database: {}", e))?;
    *conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open downloaded dictionary database: {}", e))?;

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
    let chars: Vec<char> = sentence.chars().collect();
    if chars.is_empty() {
        return Ok(None);
    }

    let cursor = cursor.min(chars.len().saturating_sub(1));
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

    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    let slice: String = chars[start..end].iter().collect();

    for offset in 0..(end - start) {
        let probe_start = start + offset;
        let probe: String = chars[probe_start..end].iter().collect();
        let entries = lookup_word_in_db(&conn, &probe)?;
        if let Some(first) = entries.first() {
            let word_len = first
                .source_length
                .max(first.term.chars().count())
                .min(end - probe_start);
            return Ok(Some(CursorLookupResult {
                word: chars[probe_start..probe_start + word_len].iter().collect(),
                start: probe_start,
                end: probe_start + word_len,
                entries,
            }));
        }
    }

    let entries = lookup_word_in_db(&conn, &slice)?;
    if entries.is_empty() {
        Ok(None)
    } else {
        Ok(Some(CursorLookupResult {
            word: slice,
            start,
            end,
            entries,
        }))
    }
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
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Ok(Vec::new());
    }

    let conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    let mut tokens: Vec<Value> = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        // Group runs of non-Japanese characters (spaces, punctuation, latin) into one plain token.
        if !is_japanese_word_char(chars[i]) {
            let start = i;
            while i < chars.len() && !is_japanese_word_char(chars[i]) {
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
            // No dictionary match: emit a single character so it stays individually tappable.
            let seg: String = chars[i..i + 1].iter().collect();
            tokens.push(serde_json::json!({ "text": seg, "reading": Value::Null }));
            i += 1;
        }
    }

    Ok(tokens)
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
            let conn = Connection::open(&db_path)
                .map_err(|e| format!("Failed to open db at {}: {e}", db_path.display()))?;
            init_mobile_db(&conn)?;

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

    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE entries (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, definition TEXT NOT NULL, dict_name TEXT DEFAULT 'Test', tags TEXT DEFAULT '')",
            [],
        )
        .unwrap();
        let rows = [
            ("食べる", "たべる", "v1 vt"),
            ("見る", "みる", "v1 vt"),
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
}
