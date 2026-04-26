use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::File;
use std::io::BufReader;
use std::sync::Mutex;
use tauri::{generate_context, generate_handler, Builder, State};

#[derive(Serialize)]
pub struct DictResult {
    pub term: String,
    pub reading: String,
    pub meanings: Value,
}

pub struct AppState {
    pub db: Mutex<Connection>,
}

#[tauri::command]
async fn import_dictionary(path: String, state: State<'_, AppState>) -> Result<usize, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let json_val: Value =
        serde_json::from_reader(reader).map_err(|e| format!("JSON read error: {}", e))?;

    let entries = match json_val.as_array() {
        Some(arr) => arr,
        None => {
            return Err("Invalid file. Please select term_bank_X.json (not index.json)".to_string())
        }
    };

    let mut conn = state.db.lock().map_err(|_| "DB lock error".to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut count = 0;
    for entry in entries {
        if let Some(arr) = entry.as_array() {
            let term = arr.get(0).and_then(|v| v.as_str()).unwrap_or("");
            let reading = arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
            let meanings = arr.get(5).unwrap_or(&Value::Null);

            let meanings_str = serde_json::to_string(meanings).unwrap_or_else(|_| "[]".to_string());

            tx.execute(
                "INSERT INTO dictionary (term, reading, meanings) VALUES (?1, ?2, ?3)",
                params![term, reading, meanings_str],
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = Connection::open("yomitan.db").expect("Failed to open db");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS dictionary (
            id INTEGER PRIMARY KEY,
            term TEXT NOT NULL,
            reading TEXT,
            meanings TEXT
        )",
        [],
    )
    .expect("Failed to create table");

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_term ON dictionary (term)",
        [],
    )
    .expect("Failed to create index");

    let app_state = AppState {
        db: Mutex::new(conn),
    };

    Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(generate_handler![import_dictionary, lookup_text])
        .run(generate_context!())
        .expect("error while running tauri application");
}
