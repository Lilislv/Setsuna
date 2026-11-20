//! Full text history of each reading tab, one file per tab
//! (`<data>/tab-lines/<id>.json`). Keeping lines out of the workspace file
//! means a new hooked line only rewrites the file of the tab that changed,
//! instead of re-serialising every tab's whole history.

use std::path::{Path, PathBuf};

fn tab_file(dir: &Path, tab_id: i64) -> PathBuf {
    dir.join(format!("{tab_id}.json"))
}

fn write_atomic(dir: &Path, tab_id: i64, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create tab history folder: {e}"))?;
    let path = tab_file(dir, tab_id);
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, content).map_err(|e| format!("Failed to write tab history: {e}"))?;
    // std::fs::rename replaces the destination atomically on Windows and Unix.
    std::fs::rename(&temporary, &path).map_err(|e| format!("Failed to replace tab history: {e}"))
}

fn read(dir: &Path, tab_id: i64) -> Result<Option<String>, String> {
    let path = tab_file(dir, tab_id);
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read tab history: {error}")),
    }
}

/// Deletes history files of tabs that no longer exist.
fn prune(dir: &Path, keep: &[i64]) -> Result<usize, String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(0) };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
        let Ok(id) = stem.trim_end_matches(".json").parse::<i64>() else { continue };
        if !keep.contains(&id) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn history_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::get_data_path(app, "tab-lines")
}

#[tauri::command]
pub async fn save_tab_lines(app: tauri::AppHandle, tab_id: i64, content: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("Invalid tab history: {e}"))?;
    let dir = history_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_atomic(&dir, tab_id, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn load_tab_lines(app: tauri::AppHandle, tab_id: i64) -> Result<Option<String>, String> {
    let dir = history_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read(&dir, tab_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prune_tab_lines(app: tauri::AppHandle, keep_ids: Vec<i64>) -> Result<usize, String> {
    let dir = history_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || prune(&dir, &keep_ids))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_reads_and_prunes_tab_histories() {
        let dir = std::env::temp_dir().join(format!("setsuna-tab-lines-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert_eq!(read(&dir, 7).unwrap(), None);
        write_atomic(&dir, 7, r#"{"lines":["a"]}"#).unwrap();
        write_atomic(&dir, 7, r#"{"lines":["a","b"]}"#).unwrap();
        write_atomic(&dir, 9, r#"{"lines":[]}"#).unwrap();
        assert_eq!(read(&dir, 7).unwrap().as_deref(), Some(r#"{"lines":["a","b"]}"#));
        assert!(!dir.join("7.json.tmp").exists());
        assert_eq!(prune(&dir, &[7]).unwrap(), 1);
        assert_eq!(read(&dir, 9).unwrap(), None);
        assert!(read(&dir, 7).unwrap().is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
