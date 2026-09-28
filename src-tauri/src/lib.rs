mod dictionary_engine;
mod database_access;
mod dictionary_import;
use dictionary_engine::{DictEntry, lookup_word_in_db, scan_cursor_in_db};
mod core;
mod japanese_tokenizer;
mod lookup_normalization;
mod japanese_deinflector;
mod local_audio;
mod flow_timer;
mod drive_download;
#[cfg(target_os = "android")]
mod android_lookup;

use japanese_tokenizer::{segment_text as segment_japanese_text, TextToken};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
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
        let mut guard = oauth_server_port_state()
            .lock()
            .map_err(|e| e.to_string())?;
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
                                        let callback_url =
                                            format!("http://127.0.0.1:{}{}", port, path);
                                        let _ = app.emit("oauth_code", callback_url);
                                        let html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Setsuna</title></head><body style=\"background:#1a1a1a;color:#fff;text-align:center;padding:48px 24px;font-family:sans-serif;\"><h1>Code received</h1><p>Return to Setsuna to finish connecting Google Drive.</p><p style=\"color:#999\">Код получен. Вернитесь в Setsuna для завершения подключения.</p></body></html>";
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
    tx.execute(
        "DELETE FROM dictionary_meta WHERE title = ?1",
        params![dict_name],
    )
    .map_err(|error| format!("Failed to replace existing dictionary metadata: {error}"))?;
    Ok(())
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
    (
        "米屋",
        "こめや",
        "рисовая лавка; магазин или продавец риса",
        "n",
    ),
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
    (
        "外れる",
        "はずれる",
        "соскочить; промахнуться; оказаться неверным",
        "v1 vi",
    ),
    ("薄い", "うすい", "тонкий; слабый; бледный", "adj-i"),
    (
        "変態",
        "へんたい",
        "извращенец; превращение; метаморфоз",
        "n",
    ),
    (
        "突っ張り",
        "つっぱり",
        "распорка; толчок ладонями; упрямство",
        "n",
    ),
    ("回転", "かいてん", "вращение; оборот", "n vs"),
    ("回転速度", "かいてんそくど", "скорость вращения", "n"),
    ("速度", "そくど", "скорость", "n"),
    (
        "大昔",
        "おおむかし",
        "давным-давно; глубокая древность",
        "n",
    ),
    (
        "納得",
        "なっとく",
        "понимание; согласие; убеждённость",
        "n vs",
    ),
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
    (
        "外れる",
        "はずれる",
        "to come off; to miss; to be wrong",
        "v1 vi",
    ),
    ("薄い", "うすい", "thin; weak; pale", "adj-i"),
    ("変態", "へんたい", "transformation; pervert", "n"),
    ("突っ張り", "つっぱり", "thrust; brace; stubbornness", "n"),
    ("回転速度", "かいてんそくど", "rotational speed", "n"),
];

const STARTER_GRAMMAR: &[(&str, &str, &str, &str)] = &[
    (
        "ではない",
        "ではない",
        "не является; отрицательная связка",
        "exp",
    ),
    (
        "なくてはいけない",
        "なくてはいけない",
        "нужно; необходимо сделать",
        "exp",
    ),
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
        let definition =
            serde_json::to_string(&[*definition]).map_err(|error| error.to_string())?;
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
            format!(
                "Failed to read embedded dictionary line {}: {error}",
                line_index + 1
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: EmbeddedStarterEntry = serde_json::from_str(&line).map_err(|error| {
            format!(
                "Failed to parse embedded dictionary line {}: {error}",
                line_index + 1
            )
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
    // Installation bookkeeping is separate from removable dictionary metadata.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS setsuna_installation (key TEXT PRIMARY KEY);").map_err(|e| e.to_string())?;
    let seeded: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM setsuna_installation WHERE key='starter-dictionaries')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !seeded {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if count == 0 {
            seed_mobile_starter_dictionaries(conn)?;
            seed_mobile_core_dictionaries(conn)?;
        }
        conn.execute("INSERT INTO setsuna_installation(key) VALUES ('starter-dictionaries')", []).map_err(|e| e.to_string())?;
    }
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
fn get_dictionary_storage_info(
    state: State<'_, AppState>,
) -> Result<DictionaryStorageInfo, String> {
    let path = state.db_path.clone();
    let size = std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
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
            return Err(format!(
                "Dictionary database upload failed: {} - {}",
                status, body
            ));
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
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", offset, end, file_len),
                )
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
                if attempts < 4 {
                    continue;
                }
            }
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "Dictionary database upload failed: {} - {}",
                status, body
            ));
        }
        emit_drive_progress(&app, "upload", offset, file_len);
    }
    Ok(())
}

static DRIVE_DOWNLOAD_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct DriveDownloadGuard(PathBuf);
impl Drop for DriveDownloadGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(format!("{}-wal", self.0.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.0.display()));
        DRIVE_DOWNLOAD_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
#[tauri::command]
async fn download_db_from_drive(
    app: tauri::AppHandle, url: String, token: String, expected_size: Option<u64>, state: State<'_, AppState>,
) -> Result<(), String> {
    if DRIVE_DOWNLOAD_ACTIVE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("A dictionary download is already running".into());
    }
    let db_path = state.db_path.clone();
    let temp_path = db_path.with_extension("db.drive-download");
    let guard = DriveDownloadGuard(temp_path.clone());
    if expected_size == Some(0) { return Err("The dictionary on Google Drive is empty. Upload it again from the PC.".into()); }
    if let (Some(total), Some(available)) = (expected_size, available_space_for_path(&db_path)) {
        if available < total.saturating_add((total / 50).max(32 * 1024 * 1024)) {
            return Err(format!("Not enough storage for the dictionary: {total} bytes needed, {available} available"));
        }
    }
    let downloaded = drive_download::download(&drive_download::client()?, &url, &token, &temp_path, expected_size, |done, total, phase| {
        let _ = app.emit("drive_dictionary_progress", serde_json::json!({
            "operation": "download", "transferred": done, "total": total,
            "percent": if total == 0 { 0.0 } else { (done as f64 / total as f64 * 100.0).min(99.0) },
            "phase": phase,
        }));
    }).await?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Keep the cleanup/download guard alive through validation and replacement.
        let _guard = guard;
        let mut header = [0u8; 16];
        File::open(&temp_path).and_then(|mut file| file.read_exact(&mut header)).map_err(|e| e.to_string())?;
        if &header != b"SQLite format 3\0" { return Err("Google Drive did not return a SQLite dictionary database".into()); }
        let mut validation = Connection::open(&temp_path).map_err(|e| e.to_string())?;
        let check: String = validation.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if check != "ok" { return Err(format!("Downloaded dictionary is damaged: {check}")); }
        if !core::database::table_exists(&validation, "entries")? && !core::database::table_exists(&validation, "dictionary")? {
            return Err("The downloaded SQLite file is not a Setsuna dictionary".into());
        }
        core::database::configure_connection(&validation)?;
        core::database::ensure_canonical_schema(&mut validation)?;
        validation.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;").map_err(|e| e.to_string())?;
        drop(validation);
        let state = worker_app.state::<AppState>();
        let _exclusive = database_access::replacing()?;
        let mut conn = state.db.lock().map_err(|_| "DB lock error")?;
        replace_mobile_database(&mut conn, &db_path, &temp_path)
    }).await.map_err(|e| format!("Dictionary restore worker failed: {e}"))??;
    emit_drive_progress(&app, "download", downloaded, downloaded);
    Ok(())
}

fn replace_mobile_database(conn: &mut Connection, db_path: &Path, temp_path: &Path) -> Result<(), String> {
    let rollback = db_path.with_extension("db.before-drive-restore");
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if busy != 0 { return Err("The dictionary is busy. Close lookup and retry.".into()); }
    // A failed earlier restore must never have its only backup overwritten.
    if rollback.exists() { return Err("A previous dictionary rollback file exists; the current database was left unchanged.".into()); }
    *conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let result = (|| -> Result<Connection, String> {
        std::fs::rename(db_path, &rollback).map_err(|e| e.to_string())?;
        std::fs::rename(temp_path, db_path).map_err(|e| e.to_string())?;
        let replacement = Connection::open(db_path).map_err(|e| e.to_string())?;
        core::database::configure_connection(&replacement)?;
        Ok(replacement)
    })();
    match result {
        Ok(replacement) => { *conn = replacement; let _ = std::fs::remove_file(rollback); Ok(()) }
        Err(error) => {
            if rollback.exists() {
                if db_path.exists() { std::fs::rename(db_path, temp_path).map_err(|e| format!("{error}; rollback failed: {e}"))?; }
                std::fs::rename(&rollback, db_path).map_err(|e| format!("{error}; rollback failed: {e}"))?;
            }
            *conn = Connection::open(db_path).map_err(|e| format!("{error}; reopen failed: {e}"))?;
            core::database::configure_connection(conn)?;
            Err(format!("Could not replace dictionary; previous database restored: {error}"))
        }
    }
}

fn lookup_segmented_token(conn: &Connection, token: &TextToken) -> Result<Vec<DictEntry>, String> {
    let length = token.text.chars().count();
    let entries: Vec<_> = lookup_word_in_db(conn, &token.text)?.into_iter().filter(|e| e.source_length >= length).collect();
    if !entries.is_empty() { return Ok(entries); }
    match token.lemma.as_deref().filter(|lemma| *lemma != token.text) {
        Some(lemma) => lookup_word_in_db(conn, lemma),
        None => Ok(entries),
    }
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
async fn get_flow_tokens(text: String, app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || { let db = open_db(&app)?; resolve_flow_tokens(&text, &db) })
        .await.map_err(|e| e.to_string())?
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
                    object.insert(
                        "lookupReading".to_string(),
                        Value::String(entry.reading.clone()),
                    );
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
    flow_timer::snapshot(None, false).paused
}

#[tauri::command]
fn set_flow_timer_state(paused: bool) -> bool {
    flow_timer::snapshot(Some(paused), false).paused
}

#[tauri::command]
fn toggle_flow_timer() -> bool {
    flow_timer::snapshot(None, true).paused
}

#[tauri::command]
fn get_mobile_flow_timer_snapshot() -> flow_timer::Snapshot {
    flow_timer::snapshot(None, false)
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
            dictionary_engine::delete_dictionary,
            dictionary_engine::update_dictionary_from_source,
            dictionary_engine::check_dictionary_updates,
            local_audio::inspect_local_audio_database,
            local_audio::lookup_local_audio,
            local_audio::lookup_online_audio,
            dictionary_import::import_dictionary,
            dictionary_import::import_dictionaries,
            dictionary_engine::get_installed_dicts,
            dictionary_engine::clear_database,
            dictionary_engine::delete_dictionaries,
            dictionary_engine::lookup_word,
            dictionary_engine::scan_cursor,
            start_oauth_server,
            get_dictionary_storage_info,
            upload_db_to_drive,
            download_db_from_drive,
            get_windows_device_name,
            log_frontend_diagnostics,
            clear_discord_presence,
            update_discord_presence,
            set_jl_mode_line,
            open_jl_mode_window,
            close_jl_mode_window,
            dictionary_engine::get_furigana,
            get_flow_tokens,
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
            get_mobile_flow_timer_snapshot,
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


    #[test]
    fn failed_mobile_restore_reopens_previous_database() {
        let dir = std::env::temp_dir().join(format!("setsuna-restore-test-{}", unix_now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dictionary.db");
        let mut conn = Connection::open(&path).unwrap();
        core::database::configure_connection(&conn).unwrap();
        conn.execute_batch("CREATE TABLE preserved(value); INSERT INTO preserved VALUES(42);").unwrap();
        assert!(replace_mobile_database(&mut conn, &path, &dir.join("missing.db")).unwrap_err().contains("restored"));
        assert_eq!(conn.query_row("SELECT value FROM preserved", [], |row| row.get::<_, i64>(0)).unwrap(), 42);
        drop(conn); std::fs::remove_dir_all(dir).unwrap();
    }

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
            .any(|entry| entry.definition == "plain definition"));
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
        assert_eq!(
            hit.source_length, 3,
            "source_length must span the full surface"
        );
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
        let hit = entries
            .iter()
            .find(|e| e.term == "杏")
            .expect("杏 should match exactly");
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
    fn deleted_dictionaries_do_not_return_after_restart() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        core::database::clear_dictionary_data(&conn).unwrap();
        init_mobile_db(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }


    #[test]
    fn mobile_scan_cursor_selects_word_from_the_token_start() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let sentence = "私は日本人です";
        let result = scan_cursor_in_db(&conn, sentence, 2).expect("the 日本人 token start must resolve the compound");
        assert_eq!(result.word, "日本人");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (2, 5));
    }

    #[test]
    fn flow_tokens_resolve_polite_surface_to_dictionary_form() {
        let conn = seeded_conn();
        let tokens = resolve_flow_tokens("では、またお会いできますね", &conn).unwrap();
        let token = tokens
            .iter()
            .find(|token| token.get("text").and_then(Value::as_str) == Some("会いできます"))
            .expect("the polite verb must remain one clickable surface block");
        assert_eq!(
            token.get("lookupTerm").and_then(Value::as_str),
            Some("会う")
        );
        assert_eq!(
            token.get("lookupReading").and_then(Value::as_str),
            Some("あう")
        );
    }

    #[test]
    fn mobile_scan_cursor_keeps_the_full_segment_instead_of_a_short_prefix() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let result = scan_cursor_in_db(&conn, "米屋で米をもらい、来た道を引き返す。", 0).expect("米屋 must resolve as the selected analyzer block");
        assert_eq!(result.word, "米屋");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (0, 2));
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "米屋" && entry.source_length == 2));
        assert!(result
            .entries
            .windows(2)
            .all(|pair| pair[0].source_length >= pair[1].source_length));
    }

    #[test]
    fn mobile_lookup_prioritizes_exact_kana_over_frequent_homophones() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        conn.execute_batch("INSERT INTO entries(term,reading,definition,dict_name,tags) VALUES
            ('日々','ひび','[\"daily\"]','test','n'),('ひび','ひび','[\"crack\"]','test','n');
            INSERT INTO frequencies(term,reading,dict_name,display_value,value) VALUES
            ('日々','ひび','freq','1',1),('ひび','ひび','freq','20000',20000);").unwrap();
        for surface in ["ヒビ", "ひび", "ﾋﾋﾞ"] {
            let result = lookup_word_in_db(&conn, surface).unwrap();
            assert_eq!(result[0].term, "ひび", "{surface}");
            assert!(result.iter().any(|entry| entry.term == "日々"));
        }
    }

    #[test]
    fn mobile_lookup_keeps_every_matching_katakana_prefix() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        for (term, definition) in [
            ("リバーシ", "Reversi"),
            ("リバー", "liver; river"),
            ("リバ", "reversible"),
        ] {
            conn.execute(
                "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?1, ?2, 'prefix-test', 'n')",
                params![term, definition],
            )
            .unwrap();
        }

        let result = scan_cursor_in_db(&conn, "リバーシを始める", 0).expect("リバーシ must resolve");
        assert_eq!(result.word, "リバーシ");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (0, 4));
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "リバーシ" && entry.source_length == 4));
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "リバー" && entry.source_length == 3));
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "リバ" && entry.source_length == 2));
    }

    #[test]
    fn mobile_lookup_prefers_the_longest_kana_reading() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES ('制限', 'せいげん', 'restriction', 'prefix-test', 'n')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES ('所為', 'せい', 'cause', 'prefix-test', 'n')",
            [],
        )
        .unwrap();

        let result = scan_cursor_in_db(&conn, "せいげんを超える", 0).expect("せいげん must resolve");
        assert_eq!(result.word, "せいげん");
        assert_eq!(result.entries[0].term, "制限");
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.term == "所為" && entry.source_length == 2));
    }

    #[test]
    fn mobile_scan_cursor_does_not_prepend_unrelated_katakana() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_mobile_db(&mut conn).unwrap();
        let result = scan_cursor_in_db(&conn, "ド変態", 1).expect("tap on 変 must resolve 変態");
        assert_eq!(result.word, "変態");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (1, 3));
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

        let result = scan_cursor_in_db(&conn, "Please get out now.", 12).expect("get out must resolve as a phrase");
        assert_eq!(result.word, "get out");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (7, 14));
        assert!(result.entries.iter().all(|entry| entry.term == "get out"));
    }

    #[test]
    fn english_phrasal_verb_resolves_inflected_first_word() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "space out");

        let result = scan_cursor_in_db(&conn, "I spaced out again.", 10).expect("spaced out must resolve to space out");
        assert_eq!(result.word, "space out");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (2, 12));
    }

    #[test]
    fn english_phrasal_verb_beats_exact_inflected_word() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "close up");
        insert_english_test_entry(&conn, "closed");

        let result = scan_cursor_in_db(&conn, "I closed up", 5).expect("closed up must resolve to close up");
        assert_eq!(result.word, "close up");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (2, 11));
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

        let result = scan_cursor_in_db(&conn, "Anyway, I closed up shop.", 21).expect("the canonical close up shop article must win");
        assert_eq!(result.word, "close up shop");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (10, 24));
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

        let result = scan_cursor_in_db(&conn, "Anyway, I closed up shop.", 13).expect("closed up must remain available inside the longer idiom");
        assert_eq!(result.word, "close up");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (10, 19));
        assert!(result.entries.iter().all(|entry| entry.term == "close up"));
    }

    #[test]
    fn english_phrasal_verb_allows_an_object_before_particle() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "space out");

        let sentence = "She spaced the cards out evenly.";
        let cursor = sentence.find("cards").unwrap() + 2;
        let result = scan_cursor_in_db(&conn, sentence, cursor).expect("separable phrasal verb must resolve across its object");
        assert_eq!(result.word, "space out");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (4, 24));
    }

    #[test]
    fn english_idiom_resolves_inflected_dictionary_form() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "kick the bucket");

        let result = scan_cursor_in_db(&conn, "He kicked the bucket yesterday.", 16).expect("inflected idiom must resolve");
        assert_eq!(result.word, "kick the bucket");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (3, 20));
    }

    #[test]
    fn english_idiom_supports_possessive_placeholders() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "pull one's leg");

        let result = scan_cursor_in_db(&conn, "Stop pulling my leg.", 17).expect("possessive idiom must resolve");
        assert_eq!(result.word, "pull one's leg");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (5, 19));
    }

    #[test]
    fn english_single_word_remains_available_without_phrase_hit() {
        let conn = seeded_conn();
        insert_english_test_entry(&conn, "out");

        let result = scan_cursor_in_db(&conn, "Stay out.", 6).expect("single word fallback must still work");
        assert_eq!(result.word, "out");
        assert_eq!((result.match_start, (result.match_start + result.match_len)), (5, 8));
    }
}

fn get_data_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(filename))
}
fn open_db(app: &tauri::AppHandle) -> Result<database_access::DatabaseConnection, String> {
    database_access::DatabaseConnection::open(&get_data_path(app, "dictionary.db")?)
}
