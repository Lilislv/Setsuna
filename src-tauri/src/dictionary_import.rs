use flate2::read::GzDecoder;
use rusqlite::{params, ErrorCode, Transaction, TransactionBehavior};
use serde::de::DeserializeSeed;
use serde_json::Value;
use std::cell::RefCell;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use xz2::read::XzDecoder;
use zip::ZipArchive;

const MAX_PLAIN_DICTIONARY_BYTES: u64 = MAX_STREAM_DICTIONARY_BYTES;
const MAX_STREAM_DICTIONARY_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const STREAM_JSON_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024;
static DICTIONARY_IMPORT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static RECENT_DICTIONARY_IMPORT: OnceLock<Mutex<Option<(Vec<String>, Instant)>>> = OnceLock::new();

thread_local! {
    static IMPORT_BATCH_POSITION: RefCell<Option<(usize, usize)>> = const { RefCell::new(None) };
    static IMPORT_DATABASE_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug)]
struct YomitanDictionaryMetadata {
    title: String,
    revision: String,
    format: i64,
    index_url: String,
    download_url: String,
    is_updatable: bool,
}

#[derive(serde::Serialize, Clone)]
struct ImportProgress {
    dict_name: String,
    total_dicts: usize,
    current_file: usize,
    total_files: usize,
    words_added: usize,
    status: String,
}

#[tauri::command]
pub async fn import_dictionary(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    import_dictionaries(app, vec![path]).await
}

#[tauri::command]
pub async fn import_dictionaries(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        lower_import_thread_priority();
        import_dictionaries_blocking(app, paths)
    })
    .await
    .map_err(|e| format!("Dictionary import worker failed: {}", e))?
}

#[cfg(target_os = "windows")]
fn lower_import_thread_priority() {
    unsafe {
        let _ = winapi::um::processthreadsapi::SetThreadPriority(
            winapi::um::processthreadsapi::GetCurrentThread(),
            winapi::um::winbase::THREAD_PRIORITY_BELOW_NORMAL as i32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn lower_import_thread_priority() {}

fn import_dictionaries_blocking(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Err("No dictionary files selected".to_string());
    }
    let _import_guard = DICTIONARY_IMPORT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Dictionary import lock is poisoned".to_string())?;
    let import_key: Vec<String> = paths
        .iter()
        .map(|path| {
            std::fs::canonicalize(path)
                .unwrap_or_else(|_| PathBuf::from(path))
                .to_string_lossy()
                .to_lowercase()
        })
        .collect();
    if RECENT_DICTIONARY_IMPORT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map(|recent| {
            recent
                .as_ref()
                .map(|(key, completed_at)| {
                    key == &import_key && completed_at.elapsed() < Duration::from_secs(10)
                })
                .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        return Ok(0);
    }
    let total_dicts = paths.len();
    emit_progress(
        &app,
        "Dictionary import",
        total_dicts,
        0,
        1,
        0,
        "Opening database...",
    );

    let mut db = super::open_db(&app)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to configure dictionary database: {}", e))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, definition TEXT NOT NULL, dict_name TEXT DEFAULT 'Unknown', tags TEXT DEFAULT '');
         CREATE TABLE IF NOT EXISTS frequencies (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, value INTEGER, display_value TEXT, dict_name TEXT);
         CREATE TABLE IF NOT EXISTS pitches (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, position INTEGER, dict_name TEXT);
         CREATE TABLE IF NOT EXISTS pronunciations (id INTEGER PRIMARY KEY, term TEXT NOT NULL, reading TEXT, ipa TEXT NOT NULL, tags TEXT DEFAULT '', dict_name TEXT);
         CREATE TABLE IF NOT EXISTS dictionary_meta (title TEXT PRIMARY KEY, revision TEXT DEFAULT '', format INTEGER DEFAULT 0, index_url TEXT DEFAULT '', download_url TEXT DEFAULT '', is_updatable INTEGER DEFAULT 0, imported_at_ms INTEGER DEFAULT 0);",
    )
    .map_err(|e| format!("Failed to prepare dictionary database: {}", e))?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = OFF;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -131072;",
    )
    .map_err(|e| format!("Failed to optimize dictionary database: {}", e))?;
    drop_import_indexes(&db)?;

    let mut total_added = 0usize;
    let mut batch_result = Ok(());
    for (index, path) in paths.iter().enumerate() {
        IMPORT_BATCH_POSITION.with(|position| {
            *position.borrow_mut() = Some((index + 1, total_dicts));
        });
        let display_name = Path::new(path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        emit_progress(
            &app,
            &display_name,
            total_dicts,
            0,
            1,
            total_added,
            "Preparing dictionary...",
        );
        match import_dictionary_path(&app, &mut db, path) {
            Ok(added) => total_added += added,
            Err(error) => {
                batch_result = Err(format!("{}: {}", display_name, error));
                break;
            }
        }
    }
    IMPORT_BATCH_POSITION.with(|position| *position.borrow_mut() = None);

    emit_progress(
        &app,
        "Dictionary import",
        total_dicts,
        total_dicts,
        total_dicts,
        total_added,
        "Building lookup indexes...",
    );
    let index_result = rebuild_import_indexes(&db);
    db.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);")
        .ok();
    index_result?;
    let result = batch_result.map(|_| total_added);
    if result.is_ok() {
        emit_progress(
            &app,
            "Dictionary import",
            total_dicts,
            total_dicts,
            total_dicts,
            total_added,
            "Import complete",
        );
        if let Ok(mut recent) = RECENT_DICTIONARY_IMPORT
            .get_or_init(|| Mutex::new(None))
            .lock()
        {
            *recent = Some((import_key, Instant::now()));
        }
    }
    result
}

fn import_dictionary_path(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        import_tar_xz_dictionary(app, db, path)
    } else if lower.ends_with(".zip") {
        import_yomitan_zip(app, db, path)
    } else if lower.ends_with(".json") {
        import_simple_json_dictionary(app, db, path)
    } else if lower.ends_with(".jsonl") || lower.ends_with(".jsonl.gz") {
        import_kaikki_jsonl_dictionary(app, db, path)
    } else if lower.ends_with(".ifo")
        || lower.ends_with(".idx")
        || lower.ends_with(".idx.gz")
        || lower.ends_with(".dict")
        || lower.ends_with(".dict.dz")
    {
        import_stardict_dictionary(app, db, path)
    } else if lower.ends_with(".csv")
        || lower.ends_with(".tsv")
        || lower.ends_with(".txt")
        || lower.ends_with(".dsl")
    {
        import_plain_text_dictionary(app, db, path)
    } else {
        Err("Unsupported dictionary format. Use Yomitan ZIP, JSON/JSONL, StarDict IFO/IDX/DICT, CSV, TSV, TXT, or DSL.".to_string())
    }
}

fn is_database_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(details, _)
            if details.code == ErrorCode::DatabaseBusy
                || details.code == ErrorCode::DatabaseLocked
    )
}

fn begin_import_transaction(db: &rusqlite::Connection) -> Result<Transaction<'_>, String> {
    let mut last_error = None;
    for _ in 0..12 {
        match Transaction::new_unchecked(db, TransactionBehavior::Immediate) {
            Ok(transaction) => {
                IMPORT_DATABASE_ERROR.with(|slot| *slot.borrow_mut() = None);
                return Ok(transaction);
            }
            Err(error) if is_database_busy(&error) => {
                last_error = Some(error.to_string());
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => return Err(format!("Transaction error: {}", error)),
        }
    }
    Err(format!(
        "Dictionary database stayed locked for too long{}",
        last_error
            .map(|error| format!(": {}", error))
            .unwrap_or_default()
    ))
}

fn remember_import_database_error(error: impl Into<String>) {
    IMPORT_DATABASE_ERROR.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(error.into());
        }
    });
}

fn commit_import_transaction(transaction: Transaction<'_>) -> Result<(), String> {
    if let Some(error) = IMPORT_DATABASE_ERROR.with(|slot| slot.borrow_mut().take()) {
        return Err(format!("Database write error: {}", error));
    }
    transaction
        .commit()
        .map_err(|e| format!("Database save error: {}", e))
}

fn drop_import_indexes(db: &rusqlite::Connection) -> Result<(), String> {
    let transaction = begin_import_transaction(db)?;
    transaction
        .execute_batch(
            "DROP INDEX IF EXISTS idx_term;
         DROP INDEX IF EXISTS idx_reading;
         DROP INDEX IF EXISTS idx_freq_term;
         DROP INDEX IF EXISTS idx_freq_reading;
         DROP INDEX IF EXISTS idx_pitch_term;
         DROP INDEX IF EXISTS idx_pitch_reading;
         DROP INDEX IF EXISTS idx_pron_term;
         DROP INDEX IF EXISTS idx_pron_reading;",
        )
        .map_err(|e| format!("Failed to prepare dictionary indexes: {}", e))?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to save dictionary index changes: {}", e))
}

fn rebuild_import_indexes(db: &rusqlite::Connection) -> Result<(), String> {
    let transaction = begin_import_transaction(db)?;
    transaction
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_term ON entries(term);
         CREATE INDEX IF NOT EXISTS idx_reading ON entries(reading);
         CREATE INDEX IF NOT EXISTS idx_freq_term ON frequencies(term);
         CREATE INDEX IF NOT EXISTS idx_freq_reading ON frequencies(reading);
         CREATE INDEX IF NOT EXISTS idx_pitch_term ON pitches(term);
         CREATE INDEX IF NOT EXISTS idx_pitch_reading ON pitches(reading);
         CREATE INDEX IF NOT EXISTS idx_pron_term ON pronunciations(term);
         CREATE INDEX IF NOT EXISTS idx_pron_reading ON pronunciations(reading);",
        )
        .map_err(|e| format!("Failed to build dictionary indexes: {}", e))?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to save dictionary indexes: {}", e))?;
    db.execute_batch("PRAGMA synchronous = NORMAL;")
        .map_err(|e| format!("Failed to finalize dictionary database: {}", e))
}

/// Removes superseded revisions of auto-updatable dictionaries.
///
/// Yomitan dictionaries commonly put the revision date in `title`.  The
/// source URL is the stable identity, so retaining every title creates a new
/// dictionary on every update and makes the settings list grow indefinitely.
pub fn cleanup_stale_dictionary_revisions(db: &mut rusqlite::Connection) -> Result<usize, String> {
    let mut stmt = db
        .prepare(
            "SELECT title, imported_at_ms,
                    CASE WHEN download_url != '' THEN download_url ELSE index_url END AS source_key
             FROM dictionary_meta
             WHERE is_updatable = 1
               AND (download_url != '' OR index_url != '')
             ORDER BY source_key, imported_at_ms DESC, title DESC",
        )
        .map_err(|e| format!("Failed to inspect dictionary revisions: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1).unwrap_or_default(),
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to read dictionary revisions: {e}"))?;

    let mut latest_by_source = std::collections::HashSet::new();
    let mut stale_titles = Vec::new();
    for row in rows {
        let (title, _imported_at, source_key) =
            row.map_err(|e| format!("Failed to read dictionary revision: {e}"))?;
        if !latest_by_source.insert(source_key) {
            stale_titles.push(title);
        }
    }
    drop(stmt);

    if stale_titles.is_empty() {
        return Ok(0);
    }

    let tx = db
        .transaction()
        .map_err(|e| format!("Failed to start dictionary cleanup: {e}"))?;
    for title in &stale_titles {
        for table in ["entries", "frequencies", "pitches", "pronunciations"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE dict_name = ?1"),
                params![title],
            )
            .map_err(|e| format!("Failed to remove stale dictionary data: {e}"))?;
        }
        tx.execute(
            "DELETE FROM dictionary_meta WHERE title = ?1",
            params![title],
        )
        .map_err(|e| format!("Failed to remove stale dictionary metadata: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to save dictionary cleanup: {e}"))?;
    Ok(stale_titles.len())
}

fn emit_progress(
    app: &tauri::AppHandle,
    dict_name: &str,
    total_dicts: usize,
    current_file: usize,
    total_files: usize,
    words_added: usize,
    status: &str,
) {
    let (total_dicts, status) = IMPORT_BATCH_POSITION.with(|position| {
        if let Some((current, total)) = *position.borrow() {
            (total, format!("[{}/{}] {}", current, total, status))
        } else {
            (total_dicts, status.to_string())
        }
    });
    app.emit(
        "import_progress",
        ImportProgress {
            dict_name: dict_name.to_string(),
            total_dicts,
            current_file,
            total_files,
            words_added,
            status,
        },
    )
    .ok();
}

fn stream_json_array<R, F>(reader: R, mut on_value: F) -> Result<usize, String>
where
    R: Read,
    F: FnMut(Value) -> Result<(), String>,
{
    struct ArraySeed<'a, F> {
        on_value: &'a mut F,
    }

    impl<'de, 'a, F> serde::de::DeserializeSeed<'de> for ArraySeed<'a, F>
    where
        F: FnMut(Value) -> Result<(), String>,
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
                F: FnMut(Value) -> Result<(), String>,
            {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("a top-level JSON array")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: serde::de::SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while let Some(value) = seq.next_element::<Value>()? {
                        (self.on_value)(value).map_err(serde::de::Error::custom)?;
                        count += 1;
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
    .map_err(|e| format!("Failed to stream JSON array: {}", e))?;
    Ok(count)
}

enum StreamedJsonItem {
    Entry(Value),
    MapEntry(String, Value),
}

fn stream_json_dictionary<R, F>(reader: R, mut on_item: F) -> Result<usize, String>
where
    R: Read,
    F: FnMut(StreamedJsonItem) -> Result<(), String>,
{
    struct EntriesSeed<'a, F> {
        on_item: &'a mut F,
    }

    impl<'de, 'a, F> DeserializeSeed<'de> for EntriesSeed<'a, F>
    where
        F: FnMut(StreamedJsonItem) -> Result<(), String>,
    {
        type Value = usize;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct EntriesVisitor<'a, F> {
                on_item: &'a mut F,
            }

            impl<'de, 'a, F> serde::de::Visitor<'de> for EntriesVisitor<'a, F>
            where
                F: FnMut(StreamedJsonItem) -> Result<(), String>,
            {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("an entries array")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: serde::de::SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while let Some(value) = seq.next_element::<Value>()? {
                        (self.on_item)(StreamedJsonItem::Entry(value))
                            .map_err(serde::de::Error::custom)?;
                        count += 1;
                    }
                    Ok(count)
                }
            }

            deserializer.deserialize_seq(EntriesVisitor {
                on_item: self.on_item,
            })
        }
    }

    struct DictionarySeed<'a, F> {
        on_item: &'a mut F,
    }

    impl<'de, 'a, F> DeserializeSeed<'de> for DictionarySeed<'a, F>
    where
        F: FnMut(StreamedJsonItem) -> Result<(), String>,
    {
        type Value = usize;

        fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct DictionaryVisitor<'a, F> {
                on_item: &'a mut F,
            }

            impl<'de, 'a, F> serde::de::Visitor<'de> for DictionaryVisitor<'a, F>
            where
                F: FnMut(StreamedJsonItem) -> Result<(), String>,
            {
                type Value = usize;

                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("a dictionary array or object")
                }

                fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
                where
                    A: serde::de::SeqAccess<'de>,
                {
                    let mut count = 0usize;
                    while let Some(value) = seq.next_element::<Value>()? {
                        (self.on_item)(StreamedJsonItem::Entry(value))
                            .map_err(serde::de::Error::custom)?;
                        count += 1;
                    }
                    Ok(count)
                }

                fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
                where
                    A: serde::de::MapAccess<'de>,
                {
                    let mut count = 0usize;
                    while let Some(key) = map.next_key::<String>()? {
                        if key == "entries" {
                            count += map.next_value_seed(EntriesSeed {
                                on_item: self.on_item,
                            })?;
                        } else {
                            let value = map.next_value::<Value>()?;
                            (self.on_item)(StreamedJsonItem::MapEntry(key, value))
                                .map_err(serde::de::Error::custom)?;
                            count += 1;
                        }
                    }
                    Ok(count)
                }
            }

            deserializer.deserialize_any(DictionaryVisitor {
                on_item: self.on_item,
            })
        }
    }

    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let count = DictionarySeed {
        on_item: &mut on_item,
    }
    .deserialize(&mut deserializer)
    .map_err(|e| format!("Failed to stream JSON dictionary: {}", e))?;
    deserializer
        .end()
        .map_err(|e| format!("Invalid data after JSON dictionary: {}", e))?;
    Ok(count)
}

fn import_yomitan_zip(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open dictionary file: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP: {}", e))?;
    let metadata = read_zip_dictionary_metadata(&mut archive, path)?;
    let dict_name = metadata.title.clone();
    let total_files = archive.len();
    emit_progress(
        app,
        &dict_name,
        1,
        0,
        total_files,
        0,
        "Waiting for dictionary database...",
    );
    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;

    // A revision may have a different title (for example `JMdict [2026-07-31]`)
    // while keeping the same update source. Remove the previous revision inside
    // this transaction before importing the replacement.
    let source_key = if !metadata.download_url.trim().is_empty() {
        metadata.download_url.trim()
    } else {
        metadata.index_url.trim()
    };
    if !source_key.is_empty() {
        let mut stale_stmt = tx
            .prepare(
                "SELECT title FROM dictionary_meta
                 WHERE title != ?1 AND is_updatable = 1
                   AND (download_url = ?2 OR (download_url = '' AND index_url = ?2))",
            )
            .map_err(|e| format!("Failed to inspect previous dictionary revision: {e}"))?;
        let stale_titles = stale_stmt
            .query_map(params![&dict_name, source_key], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| format!("Failed to read previous dictionary revision: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect previous dictionary revision: {e}"))?;
        drop(stale_stmt);
        for stale_title in stale_titles {
            for table in ["entries", "frequencies", "pitches", "pronunciations"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE dict_name = ?1"),
                    params![&stale_title],
                )
                .map_err(|e| format!("Failed to replace previous dictionary: {e}"))?;
            }
            tx.execute(
                "DELETE FROM dictionary_meta WHERE title = ?1",
                params![&stale_title],
            )
            .map_err(|e| format!("Failed to replace previous dictionary metadata: {e}"))?;
        }
    }

    // Re-imports and updates replace the prior revision atomically.
    for table in ["entries", "frequencies", "pitches", "pronunciations"] {
        tx.execute(
            &format!("DELETE FROM {} WHERE dict_name = ?1", table),
            params![&dict_name],
        )
        .map_err(|e| format!("Failed to replace existing dictionary: {}", e))?;
    }

    for i in 0..total_files {
        emit_progress(
            app,
            &dict_name,
            1,
            i + 1,
            total_files,
            words_added,
            "Reading dictionary archive...",
        );

        let file = match archive.by_index(i) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let file_name = file.name().to_string();
        if file_name.contains("__MACOSX")
            || !file_name.ends_with(".json")
            || !(file_name.contains("term_bank_")
                || file_name.contains("kanji_bank_")
                || file_name.contains("term_meta_bank_"))
        {
            continue;
        }

        let imported = stream_json_array(file, |entry| {
            let Some(data_arr) = entry.as_array() else {
                return Ok(());
            };
            import_yomitan_bank_entry(&tx, &file_name, data_arr, &dict_name, &mut words_added);
            Ok(())
        });
        if let Err(error) = imported {
            return Err(format!("Failed to import {}: {}", file_name, error));
        }
    }

    emit_progress(
        app,
        &dict_name,
        1,
        total_files,
        total_files,
        words_added,
        "Saving dictionary...",
    );
    tx.execute(
        "INSERT INTO dictionary_meta (title, revision, format, index_url, download_url, is_updatable, imported_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(title) DO UPDATE SET revision = excluded.revision, format = excluded.format,
         index_url = excluded.index_url, download_url = excluded.download_url,
         is_updatable = excluded.is_updatable, imported_at_ms = excluded.imported_at_ms",
        params![
            &metadata.title,
            &metadata.revision,
            metadata.format,
            &metadata.index_url,
            &metadata.download_url,
            if metadata.is_updatable { 1 } else { 0 },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        ],
    )
    .map_err(|e| format!("Failed to save dictionary metadata: {}", e))?;
    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_simple_json_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let file_name = Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_yomitan_bank_file(&file_name) {
        return import_yomitan_bank_json_file(app, db, path, &file_name);
    }

    if looks_like_jsonl_file(path)? {
        return import_cambridge_jsonl_dictionary(app, db, path);
    }

    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read dictionary file: {}", e))?
        .len();
    if file_size >= STREAM_JSON_THRESHOLD_BYTES {
        return import_streaming_json_dictionary(app, db, path);
    }

    emit_progress(
        app,
        "JSON dictionary",
        1,
        0,
        1,
        0,
        "Reading JSON dictionary...",
    );
    let bytes = read_dictionary_bytes(path)?;
    let contents = decode_dictionary_text(&bytes);
    let json: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse JSON dictionary: {}", e))?;
    let dict_name = json
        .get("title")
        .or_else(|| json.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dictionary_name_from_path(path));

    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;

    let cambridge_words = import_cambridge_map_dictionary(app, &tx, &json, &dict_name)?;
    if cambridge_words > 0 {
        words_added = cambridge_words;
    } else if import_json_entry(&tx, &json, &dict_name) {
        words_added += 1;
    } else if let Some(entries) = json
        .get("entries")
        .and_then(|v| v.as_array())
        .or_else(|| json.as_array())
    {
        for (index, entry) in entries.iter().enumerate() {
            if index % 1000 == 0 {
                emit_progress(
                    app,
                    &dict_name,
                    1,
                    index + 1,
                    entries.len(),
                    words_added,
                    "Importing JSON entries...",
                );
            }
            if import_json_entry(&tx, entry, &dict_name) {
                words_added += 1;
            }
        }
    } else if let Some(map) = json.as_object() {
        let total = map.len();
        for (index, (term, definition)) in map.iter().enumerate() {
            if matches!(term.as_str(), "title" | "name" | "metadata" | "format") {
                continue;
            }
            if index % 1000 == 0 {
                emit_progress(
                    app,
                    &dict_name,
                    1,
                    index + 1,
                    total,
                    words_added,
                    "Importing JSON entries...",
                );
            }
            let definition = definition_to_string(definition);
            if !definition.trim().is_empty() {
                insert_entry(&tx, term, "", &definition, &dict_name, "en");
                words_added += 1;
            }
        }
    }

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_streaming_json_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let dict_name = dictionary_name_from_path(path);
    emit_progress(
        app,
        &dict_name,
        1,
        0,
        0,
        0,
        "Streaming large JSON dictionary...",
    );
    let file = File::open(path).map_err(|e| format!("Failed to open JSON dictionary: {}", e))?;
    let reader = BufReader::with_capacity(1024 * 1024, file);
    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;
    let mut items_seen = 0usize;

    stream_json_dictionary(reader, |item| {
        items_seen += 1;
        if items_seen % 5000 == 0 {
            emit_progress(
                app,
                &dict_name,
                1,
                items_seen,
                0,
                words_added,
                "Streaming large JSON dictionary...",
            );
        }

        let added = match item {
            StreamedJsonItem::Entry(entry) => {
                if entry.get("pos_items").is_some() {
                    import_cambridge_jsonl_entry(&tx, &entry, &dict_name)
                } else if entry.get("senses").is_some() || entry.get("lang_code").is_some() {
                    import_kaikki_entry(&tx, &entry, &dict_name)
                } else {
                    import_json_entry(&tx, &entry, &dict_name)
                }
            }
            StreamedJsonItem::MapEntry(term, entry) => {
                if matches!(term.as_str(), "title" | "name" | "metadata" | "format") {
                    false
                } else if import_json_entry(&tx, &entry, &dict_name) {
                    true
                } else {
                    let definition = if entry.get("def").is_some() || entry.get("example").is_some()
                    {
                        format_cambridge_map_entry(&entry)
                    } else {
                        entry
                            .get("definition")
                            .or_else(|| entry.get("definitions"))
                            .or_else(|| entry.get("meaning"))
                            .or_else(|| entry.get("meanings"))
                            .or_else(|| entry.get("gloss"))
                            .or_else(|| entry.get("glosses"))
                            .map(definition_to_string)
                            .unwrap_or_else(|| definition_to_string(&entry))
                    };
                    if term.trim().is_empty() || definition.trim().is_empty() {
                        false
                    } else {
                        insert_entry(&tx, &term, "", &definition, &dict_name, "en");
                        true
                    }
                }
            }
        };
        if added {
            words_added += 1;
        }
        Ok(())
    })?;

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn is_yomitan_bank_file(file_name: &str) -> bool {
    file_name.contains("term_bank_")
        || file_name.contains("kanji_bank_")
        || file_name.contains("term_meta_bank_")
}

fn import_yomitan_bank_json_file(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
    file_name: &str,
) -> Result<usize, String> {
    let dict_name = dictionary_name_from_path(path);
    emit_progress(app, &dict_name, 1, 0, 1, 0, "Streaming Yomitan JSON...");
    let file = File::open(path).map_err(|e| format!("Failed to open Yomitan JSON: {}", e))?;
    let reader = BufReader::with_capacity(1024 * 1024, file);
    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;
    let mut seen = 0usize;

    stream_json_array(reader, |entry| {
        seen += 1;
        if seen % 5000 == 0 {
            emit_progress(
                app,
                &dict_name,
                1,
                seen,
                0,
                words_added,
                "Streaming Yomitan JSON...",
            );
        }
        let Some(data_arr) = entry.as_array() else {
            return Ok(());
        };
        import_yomitan_bank_entry(&tx, file_name, data_arr, &dict_name, &mut words_added);
        Ok(())
    })?;

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_plain_text_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let dict_name = dictionary_name_from_path(path);
    emit_progress(app, &dict_name, 1, 0, 1, 0, "Reading text dictionary...");
    let bytes = read_dictionary_bytes(path)?;
    let contents = decode_dictionary_text(&bytes);
    let tx = begin_import_transaction(db)?;

    let lower = path.to_lowercase();
    let words_added = if lower.ends_with(".dsl") {
        import_dsl_lines(app, &tx, &dict_name, &contents)
    } else {
        import_delimited_lines(app, &tx, &dict_name, &contents, lower.ends_with(".tsv"))
    };

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_kaikki_jsonl_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    emit_progress(
        app,
        "Kaikki / Wiktionary",
        1,
        0,
        1,
        0,
        "Opening JSONL dictionary...",
    );
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read dictionary file: {}", e))?;
    if metadata.len() > MAX_STREAM_DICTIONARY_BYTES {
        return Err(format!(
            "Dictionary file is too large for safe import ({} MB).",
            metadata.len() / 1024 / 1024
        ));
    }

    let file = File::open(path).map_err(|e| format!("Failed to open JSONL dictionary: {}", e))?;
    let lower = path.to_lowercase();
    let reader: Box<dyn BufRead> = if lower.ends_with(".gz") {
        Box::new(BufReader::new(GzDecoder::new(file)))
    } else {
        Box::new(BufReader::new(file))
    };

    let dict_name = if lower.contains("kaikki") || lower.contains("wiktionary") {
        dictionary_name_from_path(path)
    } else {
        format!("Kaikki {}", dictionary_name_from_path(path))
    };

    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;
    let mut lines_seen = 0usize;

    for line_result in reader.lines() {
        lines_seen += 1;
        if lines_seen % 1000 == 0 {
            emit_progress(
                app,
                &dict_name,
                1,
                lines_seen,
                0,
                words_added,
                "Importing Kaikki JSONL...",
            );
        }
        let Ok(line) = line_result else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if import_kaikki_entry(&tx, &entry, &dict_name) {
            words_added += 1;
        }
    }

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_stardict_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    emit_progress(app, "StarDict", 1, 0, 1, 0, "Opening StarDict files...");
    let base = stardict_base_path(path)?;
    let ifo_path = base.with_extension("ifo");
    let idx_path = first_existing_path(&[
        base.with_extension("idx"),
        PathBuf::from(format!("{}.idx.gz", base.to_string_lossy())),
    ])
    .ok_or_else(|| {
        "StarDict index file not found. Select the .ifo file or keep .idx near it.".to_string()
    })?;
    let dict_path = first_existing_path(&[
        base.with_extension("dict"),
        PathBuf::from(format!("{}.dict.dz", base.to_string_lossy())),
    ])
    .ok_or_else(|| {
        "StarDict data file not found. Keep .dict or .dict.dz near the .ifo/.idx file.".to_string()
    })?;

    let dict_name =
        read_stardict_name(&ifo_path).unwrap_or_else(|| dictionary_name_from_path(path));
    let idx_bytes = read_maybe_gzip_file(&idx_path)?;
    let dict_bytes = read_maybe_gzip_file(&dict_path)?;
    import_stardict_bytes(app, db, &dict_name, &idx_bytes, &dict_bytes)
}

fn import_tar_xz_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    emit_progress(
        app,
        "Dictionary archive",
        1,
        0,
        1,
        0,
        "Opening TAR.XZ dictionary...",
    );
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read dictionary archive: {}", e))?;
    if metadata.len() > MAX_STREAM_DICTIONARY_BYTES {
        return Err(format!(
            "Dictionary archive is too large for safe import ({} MB).",
            metadata.len() / 1024 / 1024
        ));
    }

    let file = File::open(path).map_err(|e| format!("Failed to open dictionary archive: {}", e))?;
    let decoder = XzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();

    for entry_result in archive
        .entries()
        .map_err(|e| format!("Failed to read TAR.XZ archive: {}", e))?
    {
        let mut entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let Ok(entry_path) = entry.path() else {
            continue;
        };
        let name = entry_path.to_string_lossy().replace('\\', "/");
        let lower = name.to_lowercase();
        let is_dictionary_file = lower.ends_with(".ifo")
            || lower.ends_with(".idx")
            || lower.ends_with(".idx.gz")
            || lower.ends_with(".dict")
            || lower.ends_with(".dict.dz")
            || lower.ends_with(".index");
        if !is_dictionary_file {
            continue;
        }
        let mut buffer = Vec::new();
        if entry.read_to_end(&mut buffer).is_ok() {
            files.push((name, buffer));
        }
    }

    if let (
        Some((ifo_name, ifo_bytes)),
        Some((idx_name, idx_bytes)),
        Some((dict_name_path, dict_bytes)),
    ) = (
        find_archive_file(&files, &[".ifo"]),
        find_archive_file(&files, &[".idx", ".idx.gz"]),
        find_archive_file(&files, &[".dict", ".dict.dz"]),
    ) {
        let dict_name = read_stardict_name_from_bytes(ifo_bytes)
            .unwrap_or_else(|| archive_dictionary_name(ifo_name, path));
        let idx_bytes = read_maybe_gzip_bytes(idx_name, idx_bytes)?;
        let dict_bytes = read_maybe_gzip_bytes(dict_name_path, dict_bytes)?;
        return import_stardict_bytes(app, db, &dict_name, &idx_bytes, &dict_bytes);
    }

    if find_archive_file(&files, &[".index"]).is_some()
        && find_archive_file(&files, &[".dict.dz"]).is_some()
    {
        let (index_name, index_bytes) = find_archive_file(&files, &[".index"]).unwrap();
        let (dict_name_path, dict_bytes) = find_archive_file(&files, &[".dict.dz"]).unwrap();
        let dict_name = archive_dictionary_name(index_name, path);
        let index_text = decode_dictionary_text(index_bytes);
        let dict_bytes = read_maybe_gzip_bytes(dict_name_path, dict_bytes)?;
        return import_dictd_bytes(app, db, &dict_name, &index_text, &dict_bytes);
    }

    Err("No supported dictionary files found inside TAR.XZ. Use a StarDict archive with .ifo, .idx/.idx.gz and .dict/.dict.dz.".to_string())
}

fn import_stardict_bytes(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    dict_name: &str,
    idx_bytes: &[u8],
    dict_bytes: &[u8],
) -> Result<usize, String> {
    let entries = parse_stardict_idx(&idx_bytes);

    let tx = begin_import_transaction(db)?;
    let total = entries.len().max(1);
    let mut words_added = 0usize;

    for (index, (term, offset, size)) in entries.into_iter().enumerate() {
        if index % 1000 == 0 {
            emit_progress(
                app,
                &dict_name,
                1,
                index + 1,
                total,
                words_added,
                "Importing StarDict entries...",
            );
        }
        let offset = offset as usize;
        let size = size as usize;
        if offset >= dict_bytes.len() || offset.saturating_add(size) > dict_bytes.len() {
            continue;
        }
        let (reading, definition) =
            decode_stardict_definition(&term, &dict_bytes[offset..offset + size]);
        if definition.trim().is_empty() {
            continue;
        }
        insert_entry(&tx, &term, &reading, &definition, &dict_name, "en");
        words_added += 1;
    }

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_dictd_bytes(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    dict_name: &str,
    index_text: &str,
    dict_bytes: &[u8],
) -> Result<usize, String> {
    let entries = parse_dictd_index(index_text);
    let tx = begin_import_transaction(db)?;
    let total = entries.len().max(1);
    let mut words_added = 0usize;

    for (index, (term, offset, size)) in entries.into_iter().enumerate() {
        if index % 1000 == 0 {
            emit_progress(
                app,
                dict_name,
                1,
                index + 1,
                total,
                words_added,
                "Importing DICTD entries...",
            );
        }
        let offset = offset as usize;
        let size = size as usize;
        if offset >= dict_bytes.len() || offset.saturating_add(size) > dict_bytes.len() {
            continue;
        }
        let (reading, definition) =
            decode_stardict_definition(&term, &dict_bytes[offset..offset + size]);
        if definition.trim().is_empty() {
            continue;
        }
        insert_entry(&tx, &term, &reading, &definition, dict_name, "en");
        words_added += 1;
    }

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn looks_like_jsonl_file(path: &str) -> Result<bool, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open JSON dictionary: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    let mut second = String::new();
    while first.trim().is_empty()
        && reader
            .read_line(&mut first)
            .map_err(|e| format!("Failed to read JSON dictionary: {}", e))?
            > 0
    {}
    while second.trim().is_empty()
        && reader
            .read_line(&mut second)
            .map_err(|e| format!("Failed to read JSON dictionary: {}", e))?
            > 0
    {}
    let first = first.trim();
    let second = second.trim();
    if first.is_empty() || second.is_empty() {
        return Ok(false);
    }
    Ok(first.starts_with('{')
        && first.ends_with('}')
        && second.starts_with('{')
        && second.ends_with('}'))
}

fn import_cambridge_jsonl_dictionary(
    app: &tauri::AppHandle,
    db: &mut rusqlite::Connection,
    path: &str,
) -> Result<usize, String> {
    let dict_name = dictionary_name_from_path(path);
    emit_progress(app, &dict_name, 1, 0, 0, 0, "Importing Cambridge JSONL...");

    let file = File::open(path).map_err(|e| format!("Failed to open JSONL dictionary: {}", e))?;
    let reader = BufReader::new(file);
    let tx = begin_import_transaction(db)?;
    let mut words_added = 0usize;
    let mut lines_seen = 0usize;

    for line_result in reader.lines() {
        lines_seen += 1;
        if lines_seen % 1000 == 0 {
            emit_progress(
                app,
                &dict_name,
                1,
                lines_seen,
                0,
                words_added,
                "Importing Cambridge JSONL...",
            );
        }
        let Ok(line) = line_result else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if import_cambridge_jsonl_entry(&tx, &entry, &dict_name) {
            words_added += 1;
        }
    }

    commit_import_transaction(tx)?;
    Ok(words_added)
}

fn import_cambridge_jsonl_entry(tx: &Transaction<'_>, entry: &Value, dict_name: &str) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    let term = obj
        .get("word")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if term.is_empty() {
        return false;
    }

    let Some(pos_items) = obj.get("pos_items").and_then(|v| v.as_array()) else {
        return false;
    };

    let mut readings = Vec::new();
    let mut parts = Vec::new();
    for item in pos_items {
        let pos = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !pos.is_empty() {
            parts.push(format!("[{}]", pos));
        }

        if let Some(prons) = item.get("pronunciations").and_then(|v| v.as_array()) {
            for pron in prons {
                let region = pron
                    .get("region")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let value = pron
                    .get("pronunciation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let Some(clean) = clean_cambridge_pronunciation(value) else {
                    continue;
                };
                let formatted = if region.is_empty() {
                    clean
                } else {
                    format!("{} {}", region.to_uppercase(), clean)
                };
                if !readings.contains(&formatted) {
                    readings.push(formatted);
                }
            }
        }

        if let Some(definitions) = item.get("definitions").and_then(|v| v.as_array()) {
            for (index, definition) in definitions.iter().enumerate() {
                let text = definition
                    .get("definition")
                    .and_then(|v| v.as_str())
                    .map(clean_cambridge_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    parts.push(format!("{}. {}", index + 1, text));
                }
                if let Some(examples) = definition.get("examples").and_then(|v| v.as_array()) {
                    for example in examples.iter().take(3) {
                        if let Some(example) = example
                            .as_str()
                            .map(clean_cambridge_text)
                            .filter(|s| !s.is_empty())
                        {
                            parts.push(format!("   eg. {}", example));
                        }
                    }
                }
            }
        }
    }

    let definition = parts.join("\n");
    if definition.trim().is_empty() {
        return false;
    }
    insert_entry(
        tx,
        term,
        &readings.join(" / "),
        &definition,
        dict_name,
        "en cambridge",
    );
    true
}

fn import_cambridge_map_dictionary(
    app: &tauri::AppHandle,
    tx: &Transaction<'_>,
    json: &Value,
    dict_name: &str,
) -> Result<usize, String> {
    let Some(map) = json.as_object() else {
        return Ok(0);
    };
    if !map
        .values()
        .any(|value| value.get("def").is_some() || value.get("example").is_some())
    {
        return Ok(0);
    }

    let total = map.len().max(1);
    let mut words_added = 0usize;
    for (index, (term, entry)) in map.iter().enumerate() {
        if index % 1000 == 0 {
            emit_progress(
                app,
                dict_name,
                1,
                index + 1,
                total,
                words_added,
                "Importing Cambridge JSON...",
            );
        }
        let definition = format_cambridge_map_entry(entry);
        if definition.trim().is_empty() {
            continue;
        }
        insert_entry(tx, term, "", &definition, dict_name, "en cambridge");
        words_added += 1;
    }
    Ok(words_added)
}

fn format_cambridge_map_entry(entry: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(defs) = entry.get("def") {
        collect_cambridge_definitions(defs, &mut Vec::new(), &mut parts);
    }
    if let Some(examples) = entry.get("example").and_then(|v| v.as_array()) {
        let mut example_parts = Vec::new();
        for pair in examples.iter().take(5) {
            if let Some(items) = pair.as_array() {
                let en = items
                    .get(0)
                    .and_then(|v| v.as_str())
                    .map(clean_cambridge_text)
                    .unwrap_or_default();
                let translation = items
                    .get(1)
                    .and_then(|v| v.as_str())
                    .map(clean_cambridge_text)
                    .unwrap_or_default();
                if !en.is_empty() && !translation.is_empty() {
                    example_parts.push(format!("eg. {}\n   {}", en, translation));
                } else if !en.is_empty() {
                    example_parts.push(format!("eg. {}", en));
                }
            }
        }
        if !example_parts.is_empty() {
            parts.push("[examples]".to_string());
            parts.extend(example_parts);
        }
    }
    parts.join("\n")
}

fn collect_cambridge_definitions(value: &Value, path: &mut Vec<String>, parts: &mut Vec<String>) {
    if let Some(array) = value.as_array() {
        for pair in array {
            let Some(items) = pair.as_array() else {
                continue;
            };
            let en = items
                .get(0)
                .and_then(|v| v.as_str())
                .map(clean_cambridge_text)
                .unwrap_or_default();
            let translation = items
                .get(1)
                .and_then(|v| v.as_str())
                .map(clean_cambridge_text)
                .unwrap_or_default();
            if en.is_empty() && translation.is_empty() {
                continue;
            }
            let label = path
                .iter()
                .filter(|part| part.as_str() != "NONE")
                .cloned()
                .collect::<Vec<_>>()
                .join(" / ");
            if !label.is_empty() {
                parts.push(format!("[{}]", label));
            }
            if !en.is_empty() {
                parts.push(en);
            }
            if !translation.is_empty() {
                parts.push(format!("=> {}", translation));
            }
        }
        return;
    }

    if let Some(map) = value.as_object() {
        for (key, child) in map {
            path.push(key.to_string());
            collect_cambridge_definitions(child, path, parts);
            path.pop();
        }
    }
}

fn clean_cambridge_pronunciation(value: &str) -> Option<String> {
    let cleaned = clean_cambridge_text(value);
    if cleaned.is_empty()
        || cleaned
            .chars()
            .any(|ch| ('\u{ff61}'..='\u{ff9f}').contains(&ch))
        || cleaned.contains('�')
    {
        None
    } else {
        Some(cleaned)
    }
}

fn clean_cambridge_text(value: &str) -> String {
    clean_dictionary_markup(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_dictionary_bytes(path: &str) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read dictionary file: {}", e))?;
    if metadata.len() > MAX_PLAIN_DICTIONARY_BYTES {
        return Err(format!(
            "Dictionary file is too large for safe import ({} MB). Split it into smaller files.",
            metadata.len() / 1024 / 1024
        ));
    }
    std::fs::read(path).map_err(|e| format!("Failed to read dictionary file: {}", e))
}

fn decode_dictionary_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

fn dictionary_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "English Dictionary".to_string())
}

fn import_json_entry(tx: &Transaction<'_>, entry: &Value, dict_name: &str) -> bool {
    if let Some(obj) = entry.as_object() {
        let term = obj
            .get("term")
            .or_else(|| obj.get("word"))
            .or_else(|| obj.get("headword"))
            .or_else(|| obj.get("expression"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let reading = obj
            .get("reading")
            .or_else(|| obj.get("pronunciation"))
            .or_else(|| obj.get("ipa"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let definition_value = obj
            .get("definition")
            .or_else(|| obj.get("definitions"))
            .or_else(|| obj.get("meaning"))
            .or_else(|| obj.get("meanings"))
            .or_else(|| obj.get("gloss"))
            .or_else(|| obj.get("glosses"))
            .or_else(|| obj.get("text"));
        let definition = definition_value
            .map(definition_to_string)
            .unwrap_or_default();
        if !term.is_empty() && !definition.trim().is_empty() {
            insert_entry(tx, term, reading, &definition, dict_name, "en");
            return true;
        }
    } else if let Some(arr) = entry.as_array() {
        let term = arr.get(0).and_then(|v| v.as_str()).unwrap_or("").trim();
        let (reading, definition_value) = if arr.len() >= 3 {
            (
                arr.get(1).and_then(|v| v.as_str()).unwrap_or("").trim(),
                arr.get(2),
            )
        } else {
            ("", arr.get(1))
        };
        let definition = definition_value
            .map(definition_to_string)
            .unwrap_or_default();
        if !term.is_empty() && !definition.trim().is_empty() {
            insert_entry(tx, term, reading, &definition, dict_name, "en");
            return true;
        }
    }
    false
}

fn definition_to_string(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        text.trim().to_string()
    } else if let Some(items) = value.as_array() {
        let strings: Vec<String> = items
            .iter()
            .map(definition_to_string)
            .filter(|s| !s.trim().is_empty())
            .collect();
        if strings
            .iter()
            .all(|s| !s.starts_with('{') && !s.starts_with('['))
        {
            strings.join("; ")
        } else {
            value.to_string()
        }
    } else {
        value.to_string()
    }
}

fn import_kaikki_entry(tx: &Transaction<'_>, entry: &Value, dict_name: &str) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    if let Some(lang_code) = obj.get("lang_code").and_then(|v| v.as_str()) {
        if lang_code != "en" {
            return false;
        }
    }

    let term = obj
        .get("word")
        .or_else(|| obj.get("term"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if term.is_empty() {
        return false;
    }

    let pos = obj.get("pos").and_then(|v| v.as_str()).unwrap_or("").trim();
    let reading = obj
        .get("sounds")
        .and_then(|v| v.as_array())
        .and_then(|sounds| {
            sounds
                .iter()
                .find_map(|sound| sound.get("ipa").and_then(|v| v.as_str()))
        })
        .unwrap_or("")
        .trim();

    let mut parts = Vec::new();
    if !pos.is_empty() {
        parts.push(format!("[{}]", pos));
    }

    if let Some(senses) = obj.get("senses").and_then(|v| v.as_array()) {
        for (index, sense) in senses.iter().enumerate() {
            let glosses = sense
                .get("glosses")
                .or_else(|| sense.get("raw_glosses"))
                .and_then(value_string_list)
                .unwrap_or_default();
            if glosses.is_empty() {
                continue;
            }
            parts.push(format!("{}. {}", index + 1, glosses.join("; ")));

            if let Some(examples) = sense.get("examples").and_then(|v| v.as_array()) {
                for example in examples.iter().take(2) {
                    if let Some(text) = example.get("text").and_then(|v| v.as_str()) {
                        let text = text.trim();
                        if !text.is_empty() {
                            parts.push(format!("   eg. {}", text));
                        }
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        if let Some(definition) = obj
            .get("definition")
            .or_else(|| obj.get("definitions"))
            .or_else(|| obj.get("glosses"))
            .map(definition_to_string)
        {
            if !definition.trim().is_empty() {
                parts.push(definition);
            }
        }
    }

    let definition = parts.join("\n");
    if definition.trim().is_empty() {
        return false;
    }

    let tags = if pos.is_empty() {
        "en".to_string()
    } else {
        format!("en {}", pos)
    };
    insert_entry(tx, term, reading, &definition, dict_name, &tags);
    true
}

fn value_string_list(value: &Value) -> Option<Vec<String>> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() {
            None
        } else {
            Some(vec![text.to_string()])
        }
    } else {
        let items = value.as_array()?;
        let strings: Vec<String> = items
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if strings.is_empty() {
            None
        } else {
            Some(strings)
        }
    }
}

fn import_delimited_lines(
    app: &tauri::AppHandle,
    tx: &Transaction<'_>,
    dict_name: &str,
    contents: &str,
    force_tsv: bool,
) -> usize {
    let lines: Vec<&str> = contents.lines().collect();
    let total = lines.len().max(1);
    let mut words_added = 0usize;
    for (index, line) in lines.iter().enumerate() {
        if index % 1000 == 0 {
            emit_progress(
                app,
                dict_name,
                1,
                index + 1,
                total,
                words_added,
                "Importing text entries...",
            );
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let columns = if force_tsv || trimmed.contains('\t') {
            split_tsv_line(trimmed)
        } else {
            let csv_columns = split_csv_line(trimmed);
            if csv_columns.len() >= 2 {
                csv_columns
            } else {
                split_loose_dictionary_line(trimmed)
            }
        };
        if columns.len() < 2 {
            continue;
        }
        let term = columns[0].trim();
        let definition = columns[1..].join("; ");
        if term.is_empty() || definition.trim().is_empty() {
            continue;
        }
        insert_entry(tx, term, "", definition.trim(), dict_name, "en");
        words_added += 1;
    }
    words_added
}

fn import_dsl_lines(
    app: &tauri::AppHandle,
    tx: &Transaction<'_>,
    dict_name: &str,
    contents: &str,
) -> usize {
    let lines: Vec<&str> = contents.lines().collect();
    let total = lines.len().max(1);
    let mut words_added = 0usize;
    let mut current_terms: Vec<String> = Vec::new();
    let mut definition_lines: Vec<String> = Vec::new();

    let flush = |terms: &mut Vec<String>, defs: &mut Vec<String>, count: &mut usize| {
        if terms.is_empty() || defs.is_empty() {
            terms.clear();
            defs.clear();
            return;
        }
        let definition = cleanup_dsl_definition(&defs.join("\n"));
        if !definition.trim().is_empty() {
            for term in terms.iter() {
                insert_entry(tx, term.trim(), "", &definition, dict_name, "en");
                *count += 1;
            }
        }
        terms.clear();
        defs.clear();
    };

    for (index, raw_line) in lines.iter().enumerate() {
        if index % 1000 == 0 {
            emit_progress(
                app,
                dict_name,
                1,
                index + 1,
                total,
                words_added,
                "Importing DSL entries...",
            );
        }
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            definition_lines.push(line.trim().to_string());
        } else {
            if !definition_lines.is_empty() {
                flush(&mut current_terms, &mut definition_lines, &mut words_added);
            }
            current_terms.push(line.trim().to_string());
        }
    }
    flush(&mut current_terms, &mut definition_lines, &mut words_added);
    words_added
}

fn cleanup_dsl_definition(value: &str) -> String {
    value
        .replace("[m1]", "")
        .replace("[m2]", "")
        .replace("[m3]", "")
        .replace("[/m]", "")
        .replace("[b]", "")
        .replace("[/b]", "")
        .replace("[i]", "")
        .replace("[/i]", "")
        .replace("[c]", "")
        .replace("[/c]", "")
        .trim()
        .to_string()
}

fn split_tsv_line(line: &str) -> Vec<String> {
    line.split('\t')
        .map(|part| part.trim().to_string())
        .collect()
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut columns = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                columns.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    columns.push(current.trim().to_string());
    columns
}

fn split_loose_dictionary_line(line: &str) -> Vec<String> {
    for separator in [" - ", " — ", " – ", ": "] {
        if let Some(index) = line.find(separator) {
            return vec![
                line[..index].trim().to_string(),
                line[index + separator.len()..].trim().to_string(),
            ];
        }
    }
    vec![line.trim().to_string()]
}

fn stardict_base_path(path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid StarDict file path.".to_string())?;
    let lower = file_name.to_lowercase();
    let parent = source.parent().unwrap_or_else(|| Path::new(""));
    let stem = if lower.ends_with(".dict.dz") {
        &file_name[..file_name.len().saturating_sub(".dict.dz".len())]
    } else if lower.ends_with(".idx.gz") {
        &file_name[..file_name.len().saturating_sub(".idx.gz".len())]
    } else if lower.ends_with(".ifo") || lower.ends_with(".idx") || lower.ends_with(".dict") {
        source
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid StarDict file path.".to_string())?
    } else {
        return Err(
            "Unsupported StarDict file. Select .ifo, .idx, .idx.gz, .dict, or .dict.dz."
                .to_string(),
        );
    };
    Ok(parent.join(stem))
}

fn first_existing_path(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|path| path.exists()).cloned()
}

fn read_stardict_name(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    read_stardict_name_from_bytes(&bytes)
}

fn read_stardict_name_from_bytes(bytes: &[u8]) -> Option<String> {
    let contents = decode_dictionary_text(&bytes);
    contents.lines().find_map(|line| {
        line.strip_prefix("bookname=")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn find_archive_file<'a>(
    files: &'a [(String, Vec<u8>)],
    suffixes: &[&str],
) -> Option<(&'a str, &'a [u8])> {
    files.iter().find_map(|(name, bytes)| {
        let lower = name.to_lowercase();
        if suffixes.iter().any(|suffix| lower.ends_with(suffix)) {
            Some((name.as_str(), bytes.as_slice()))
        } else {
            None
        }
    })
}

fn archive_dictionary_name(entry_name: &str, archive_path: &str) -> String {
    Path::new(entry_name)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| dictionary_name_from_path(archive_path))
}

fn read_maybe_gzip_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read dictionary file: {}", e))?;
    if metadata.len() > MAX_STREAM_DICTIONARY_BYTES {
        return Err(format!(
            "Dictionary file is too large for safe import ({} MB).",
            metadata.len() / 1024 / 1024
        ));
    }
    let file = File::open(path).map_err(|e| format!("Failed to open dictionary file: {}", e))?;
    let lower = path.to_string_lossy().to_lowercase();
    let mut buffer = Vec::new();
    if lower.ends_with(".gz") || lower.ends_with(".dz") {
        GzDecoder::new(file)
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to decompress dictionary file: {}", e))?;
    } else {
        BufReader::new(file)
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read dictionary file: {}", e))?;
    }
    Ok(buffer)
}

fn read_maybe_gzip_bytes(name: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let lower = name.to_lowercase();
    if lower.ends_with(".gz") || lower.ends_with(".dz") {
        let mut buffer = Vec::new();
        GzDecoder::new(bytes)
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to decompress dictionary file: {}", e))?;
        Ok(buffer)
    } else {
        Ok(bytes.to_vec())
    }
}

fn parse_stardict_idx(bytes: &[u8]) -> Vec<(String, u32, u32)> {
    let mut entries = Vec::new();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        let Some(relative_end) = bytes[cursor..].iter().position(|byte| *byte == 0) else {
            break;
        };
        let word_end = cursor + relative_end;
        let word = String::from_utf8_lossy(&bytes[cursor..word_end])
            .trim()
            .to_string();
        cursor = word_end + 1;
        if cursor + 8 > bytes.len() {
            break;
        }
        let offset = u32::from_be_bytes([
            bytes[cursor],
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
        ]);
        let size = u32::from_be_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]);
        cursor += 8;
        if !word.is_empty() && size > 0 {
            entries.push((word, offset, size));
        }
    }

    entries
}

fn parse_dictd_index(contents: &str) -> Vec<(String, u32, u32)> {
    let mut entries = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("00database") {
            continue;
        }
        let mut parts = trimmed.split('\t');
        let Some(term) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(offset_text) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(size_text) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(offset) = decode_dictd_base64(offset_text) else {
            continue;
        };
        let Some(size) = decode_dictd_base64(size_text) else {
            continue;
        };
        if size > 0 {
            entries.push((term.to_string(), offset, size));
        }
    }
    entries
}

fn decode_dictd_base64(value: &str) -> Option<u32> {
    let mut result: u32 = 0;
    for ch in value.chars() {
        let digit = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => 26 + ch as u32 - 'a' as u32,
            '0'..='9' => 52 + ch as u32 - '0' as u32,
            '+' => 62,
            '/' => 63,
            _ => return None,
        };
        result = result.checked_mul(64)?.checked_add(digit)?;
    }
    Some(result)
}

fn decode_stardict_definition(term: &str, bytes: &[u8]) -> (String, String) {
    let cleaned = clean_dictionary_markup(&String::from_utf8_lossy(bytes));
    split_free_dict_header(term, &cleaned)
}

fn clean_dictionary_markup(value: &str) -> String {
    let mut text = value
        .replace('\0', "\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</div>", "\n")
        .replace("</p>", "\n")
        .replace("</li>", "\n")
        .replace("<li>", "- ");

    let mut cleaned = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => cleaned.push(ch),
            _ => {}
        }
    }

    text = decode_html_entities(&cleaned);
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_html_entities(value: &str) -> String {
    let mut output = value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    while let Some(start) = output.find("&#") {
        let Some(relative_end) = output[start..].find(';') else {
            break;
        };
        let end = start + relative_end;
        let entity = &output[start + 2..end];
        let number = if let Some(hex) = entity.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            entity.parse::<u32>().ok()
        };
        let Some(ch) = number.and_then(char::from_u32) else {
            break;
        };
        output.replace_range(start..=end, &ch.to_string());
    }

    output
}

fn split_free_dict_header(term: &str, value: &str) -> (String, String) {
    let mut lines: Vec<String> = value
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    if lines.is_empty() {
        return (String::new(), String::new());
    }

    let first = lines[0].trim();
    let term_lower = term.trim().to_lowercase();
    let first_lower = first.to_lowercase();
    let mut first_body = first.to_string();
    let mut consumed_first_line = false;

    if !term_lower.is_empty() && first_lower.starts_with(&term_lower) {
        first_body = first[term.trim().len().min(first.len())..]
            .trim()
            .to_string();
        consumed_first_line = true;
    }

    let (reading_parts, definition_prefix) = extract_leading_ipa(&first_body);

    if consumed_first_line || !definition_prefix.is_empty() || !reading_parts.is_empty() {
        lines.remove(0);
        if !definition_prefix.is_empty() {
            lines.insert(0, definition_prefix);
        }
    }

    (
        reading_parts.join(" "),
        format_free_dict_definition(&lines.join("\n")),
    )
}

fn extract_leading_ipa(value: &str) -> (Vec<String>, String) {
    let mut readings = Vec::new();
    let mut rest = value.trim_start();

    loop {
        let trimmed = rest.trim_start();
        if !trimmed.starts_with('/') {
            rest = trimmed;
            break;
        }

        let Some(end_rel) = trimmed[1..].find('/') else {
            rest = trimmed;
            break;
        };

        let end = 1 + end_rel;
        let ipa = trimmed[1..end].trim();
        if !ipa.is_empty() {
            readings.push(format!("/{}/", ipa));
        }

        rest = trimmed[end + 1..].trim_start();
        if rest.starts_with(',') || rest.starts_with(';') {
            rest = rest[1..].trim_start();
        }
    }

    (readings, rest.trim().to_string())
}

fn format_free_dict_definition(value: &str) -> String {
    let mut lines: Vec<String> = value
        .lines()
        .map(|line| normalize_free_dict_line(line.trim()))
        .filter(|line| !line.is_empty())
        .collect();

    if lines.is_empty() {
        return String::new();
    }

    let mut formatted = Vec::new();
    let first = lines.remove(0);
    let (labels, body) = split_free_dict_labels(&first);
    for label in labels {
        formatted.push(format!("[{}]", label));
    }
    if !body.is_empty() {
        formatted.push(format_free_dict_body_line(&body));
    }
    for line in lines {
        formatted.push(format_free_dict_body_line(&line));
    }

    formatted
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_free_dict_line(line: &str) -> String {
    line.replace("竊陳", "")
        .replace("竊陳", "")
        .replace("", " ")
        .replace(" ,", ",")
        .replace(" ;", ";")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_free_dict_labels(line: &str) -> (Vec<String>, String) {
    const PARTS_OF_SPEECH: &[&str] = &[
        "adjective",
        "adverb",
        "article",
        "auxiliary verb",
        "conjunction",
        "determiner",
        "exclamation",
        "interjection",
        "noun",
        "number",
        "particle",
        "phrasal verb",
        "phrase",
        "prefix",
        "preposition",
        "pronoun",
        "suffix",
        "verb",
    ];

    let mut labels = Vec::new();
    let lower = line.to_lowercase();
    let mut rest = line.trim();

    for part in PARTS_OF_SPEECH {
        if lower == *part {
            labels.push((*part).to_string());
            return (labels, String::new());
        }
        let with_space = format!("{} ", part);
        if lower.starts_with(&with_space) {
            labels.push((*part).to_string());
            rest = line[part.len()..].trim();
            break;
        }
    }

    loop {
        let trimmed = rest.trim_start();
        if !trimmed.starts_with('(') {
            rest = trimmed;
            break;
        }
        let Some(end) = trimmed.find(')') else {
            rest = trimmed;
            break;
        };
        let label = trimmed[1..end].trim();
        if !label.is_empty() && label.len() <= 48 {
            labels.push(label.to_string());
            rest = trimmed[end + 1..].trim_start();
        } else {
            rest = trimmed;
            break;
        }
    }

    (labels, rest.to_string())
}

fn format_free_dict_body_line(line: &str) -> String {
    let line = line.trim();
    if line.is_empty() {
        return String::new();
    }

    if let Some((left, right)) = line.split_once(" - ") {
        let left = left.trim();
        let right = right.trim();
        if !left.is_empty() && !right.is_empty() {
            return format!("{}\n=> {}", left, right);
        }
    }

    line.to_string()
}

fn read_zip_dictionary_metadata(
    archive: &mut ZipArchive<File>,
    path: &str,
) -> Result<YomitanDictionaryMetadata, String> {
    let fallback_title = std::path::Path::new(path)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported Dictionary".to_string());
    for i in 0..archive.len() {
        let Ok(mut file) = archive.by_index(i) else {
            continue;
        };
        let file_name = file.name().to_string();
        if !file_name.ends_with("index.json") || file_name.contains("__MACOSX") {
            continue;
        }
        let mut buffer = Vec::new();
        if file.read_to_end(&mut buffer).is_err() {
            continue;
        }
        let contents = String::from_utf8_lossy(&buffer);
        let Some(start) = contents.find('{') else {
            continue;
        };
        if let Ok(json) = serde_json::from_str::<Value>(&contents[start..]) {
            let title = json
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&fallback_title)
                .to_string();
            return Ok(YomitanDictionaryMetadata {
                title,
                revision: json
                    .get("revision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                format: json
                    .get("format")
                    .or_else(|| json.get("version"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                index_url: json
                    .get("indexUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                download_url: json
                    .get("downloadUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                is_updatable: json
                    .get("isUpdatable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
    }
    Ok(YomitanDictionaryMetadata {
        title: fallback_title,
        revision: String::new(),
        format: 0,
        index_url: String::new(),
        download_url: String::new(),
        is_updatable: false,
    })
}

fn insert_entry(
    tx: &Transaction<'_>,
    term: &str,
    reading: &str,
    definition: &str,
    dict_name: &str,
    tags: &str,
) {
    if term.trim().is_empty() {
        return;
    }

    match tx.prepare_cached(
        "INSERT INTO entries (term, reading, definition, dict_name, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
    ) {
        Ok(mut statement) => {
            if let Err(error) =
                statement.execute(params![term, reading, definition, dict_name, tags])
            {
                remember_import_database_error(error.to_string());
            }
        }
        Err(error) => remember_import_database_error(error.to_string()),
    }
}

fn import_yomitan_bank_entry(
    tx: &Transaction<'_>,
    file_name: &str,
    data_arr: &[Value],
    dict_name: &str,
    words_added: &mut usize,
) {
    if file_name.contains("term_bank_") {
        let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or("");
        let reading = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
        let def_tags = data_arr.get(2).and_then(|v| v.as_str()).unwrap_or("");
        let term_tags = data_arr.get(7).and_then(|v| v.as_str()).unwrap_or("");
        let tags = format!("{} {}", def_tags, term_tags).trim().to_string();
        let definition = data_arr
            .get(5)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string());
        insert_entry(tx, term, reading, &definition, dict_name, &tags);
        *words_added += 1;
    } else if file_name.contains("kanji_bank_") {
        let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or("");
        let onyomi = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
        let kunyomi = data_arr.get(2).and_then(|v| v.as_str()).unwrap_or("");
        let tags = data_arr.get(3).and_then(|v| v.as_str()).unwrap_or("");
        let definition = data_arr
            .get(4)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".to_string());
        let reading = format!("{} {}", onyomi, kunyomi).trim().to_string();
        insert_entry(tx, term, &reading, &definition, dict_name, tags);
        *words_added += 1;
    } else if file_name.contains("term_meta_bank_") {
        let term = data_arr.get(0).and_then(|v| v.as_str()).unwrap_or("");
        let mode = data_arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
        let data_obj = data_arr.get(2);
        if mode == "freq" {
            insert_frequency_from_value(tx, term, data_obj, dict_name, words_added);
        } else if mode == "pitch" {
            insert_pitch_from_value(tx, term, data_obj, dict_name, words_added);
        } else if mode == "ipa" {
            insert_pronunciation_from_value(tx, term, data_obj, dict_name, words_added);
        }
    }
}

fn insert_frequency_from_value(
    tx: &Transaction<'_>,
    term: &str,
    data_obj: Option<&Value>,
    dict_name: &str,
    words_added: &mut usize,
) {
    if term.trim().is_empty() {
        return;
    }

    let mut value = 0;
    let mut display_value = String::new();
    let mut reading = "";
    if let Some(obj) = data_obj.and_then(|v| v.as_object()) {
        reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(freq_obj) = obj.get("frequency").and_then(|v| v.as_object()) {
            value = freq_obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            display_value = json_display_value(freq_obj.get("displayValue"));
        } else if let Some(freq_val) = obj.get("frequency").and_then(|v| v.as_i64()) {
            value = freq_val;
            display_value = freq_val.to_string();
        } else if let Some(freq_str) = obj.get("frequency").and_then(|v| v.as_str()) {
            display_value = freq_str.to_string();
            value = freq_str.parse().unwrap_or(0);
        } else {
            value = obj.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            display_value = json_display_value(obj.get("displayValue"));
        }
    } else if let Some(num) = data_obj.and_then(|v| v.as_i64()) {
        value = num;
        display_value = num.to_string();
    } else if let Some(text) = data_obj.and_then(|v| v.as_str()) {
        display_value = text.to_string();
        value = text.parse().unwrap_or(0);
    }
    if display_value.is_empty() && value > 0 {
        display_value = value.to_string();
    }
    if !display_value.is_empty() {
        match tx.prepare_cached(
            "INSERT INTO frequencies (term, reading, value, display_value, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
        ) {
            Ok(mut statement) => {
                match statement.execute(params![term, reading, value, display_value, dict_name]) {
                    Ok(_) => *words_added += 1,
                    Err(error) => remember_import_database_error(error.to_string()),
                }
            }
            Err(error) => remember_import_database_error(error.to_string()),
        }
    }
}

fn insert_pitch_from_value(
    tx: &Transaction<'_>,
    term: &str,
    data_obj: Option<&Value>,
    dict_name: &str,
    words_added: &mut usize,
) {
    if term.trim().is_empty() {
        return;
    }

    let Some(obj) = data_obj.and_then(|v| v.as_object()) else {
        return;
    };
    let reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
    let Some(pitches_arr) = obj.get("pitches").and_then(|v| v.as_array()) else {
        return;
    };
    for pitch in pitches_arr {
        if let Some(position) = pitch.get("position").and_then(|v| v.as_i64()) {
            match tx.prepare_cached(
                "INSERT INTO pitches (term, reading, position, dict_name) VALUES (?1, ?2, ?3, ?4)",
            ) {
                Ok(mut statement) => {
                    match statement.execute(params![term, reading, position, dict_name]) {
                        Ok(_) => *words_added += 1,
                        Err(error) => remember_import_database_error(error.to_string()),
                    }
                }
                Err(error) => remember_import_database_error(error.to_string()),
            }
        }
    }
}

fn insert_pronunciation_from_value(
    tx: &Transaction<'_>,
    term: &str,
    data_obj: Option<&Value>,
    dict_name: &str,
    words_added: &mut usize,
) {
    if term.trim().is_empty() {
        return;
    }
    let Some(obj) = data_obj.and_then(|v| v.as_object()) else {
        return;
    };
    let reading = obj.get("reading").and_then(|v| v.as_str()).unwrap_or("");
    let Some(transcriptions) = obj.get("transcriptions").and_then(|v| v.as_array()) else {
        return;
    };

    for transcription in transcriptions {
        let ipa = transcription
            .get("ipa")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if ipa.trim().is_empty() {
            continue;
        }
        let tags = transcription
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        match tx.prepare_cached(
            "INSERT INTO pronunciations (term, reading, ipa, tags, dict_name) VALUES (?1, ?2, ?3, ?4, ?5)",
        ) {
            Ok(mut statement) => {
                match statement.execute(params![term, reading, ipa, tags, dict_name]) {
                    Ok(_) => *words_added += 1,
                    Err(error) => remember_import_database_error(error.to_string()),
                }
            }
            Err(error) => remember_import_database_error(error.to_string()),
        }
    }
}

fn json_display_value(value: Option<&Value>) -> String {
    value
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::Cursor;

    #[test]
    fn streams_nested_entries_without_materializing_the_document() {
        let json = br#"{
            "title": "Large dictionary",
            "entries": [
                {"term": "alpha", "definition": "first"},
                ["beta", "second"]
            ]
        }"#;
        let mut entries = Vec::new();
        let count = stream_json_dictionary(Cursor::new(json), |item| {
            if let StreamedJsonItem::Entry(value) = item {
                entries.push(value);
            }
            Ok(())
        })
        .unwrap();

        assert_eq!(count, 3);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].get("term").and_then(Value::as_str),
            Some("alpha")
        );
        assert_eq!(entries[1].get(0).and_then(Value::as_str), Some("beta"));
    }

    #[test]
    fn database_insert_errors_abort_the_import_transaction() {
        let db = Connection::open_in_memory().unwrap();
        let transaction = begin_import_transaction(&db).unwrap();
        insert_entry(&transaction, "missing-table", "", "definition", "test", "");

        let error = commit_import_transaction(transaction).unwrap_err();
        assert!(error.contains("Database write error"));
    }

    #[test]
    fn import_transaction_waits_for_existing_writer() {
        let path = std::env::temp_dir().join(format!(
            "setsuna-import-lock-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let holder = Connection::open(&path).unwrap();
        holder
            .execute("CREATE TABLE values_table (value INTEGER)", [])
            .unwrap();
        holder.execute_batch("BEGIN IMMEDIATE").unwrap();

        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            holder.execute_batch("COMMIT").unwrap();
        });

        let db = Connection::open(&path).unwrap();
        db.busy_timeout(Duration::from_millis(50)).unwrap();
        let transaction = begin_import_transaction(&db).unwrap();
        transaction
            .execute("INSERT INTO values_table (value) VALUES (1)", [])
            .unwrap();
        transaction.commit().unwrap();
        release.join().unwrap();
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
