use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct LibraryScan {
    path: String,
    directories: Vec<MediaDirectory>,
}

#[derive(Default, Serialize)]
struct MediaDirectory {
    path: String,
    episodes: Vec<Episode>,
    subtitles: Vec<String>,
}

#[derive(Serialize)]
struct Episode {
    path: String,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_media(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "mp4" | "mkv" | "webm" | "mov" | "m4v" | "ogv" | "avi" | "mp3" | "m4a" | "ogg" | "flac"
    )
}

fn is_subtitle(path: &Path) -> bool {
    matches!(extension(path).as_str(), "srt" | "vtt" | "ass" | "ssa")
}

fn is_subtitle_folder(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    ["sub", "subs", "subtitle", "subtitles"]
        .iter()
        .any(|value| name.eq_ignore_ascii_case(value))
}

fn scan(root: &Path, resolved_root: &Path) -> Result<LibraryScan, String> {
    let mut groups = BTreeMap::<PathBuf, MediaDirectory>::new();
    let mut pending = vec![(root.to_owned(), None::<PathBuf>)];
    let mut visited = HashSet::new();
    while let Some((directory, subtitle_owner)) = pending.pop() {
        let resolved = match directory.canonicalize() {
            Ok(path) => path,
            Err(error) if directory == root => return Err(error.to_string()),
            Err(_) => continue,
        };
        // Junctions can be reported as directories on Windows. Never traverse an alias.
        if resolved != resolved_root.join(directory.strip_prefix(root).unwrap())
            || !visited.insert(resolved)
        {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => return Err(error.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let owner = subtitle_owner
                    .clone()
                    .or_else(|| is_subtitle_folder(&path).then(|| directory.clone()));
                pending.push((path, owner));
            } else if kind.is_file() {
                let Some(name) = path.to_str() else { continue };
                if is_media(&path) {
                    groups
                        .entry(directory.clone())
                        .or_default()
                        .episodes
                        .push(Episode {
                            path: name.to_owned(),
                        });
                } else if is_subtitle(&path) {
                    let owner = subtitle_owner.as_ref().unwrap_or(&directory);
                    groups
                        .entry(owner.clone())
                        .or_default()
                        .subtitles
                        .push(name.to_owned());
                }
            }
        }
    }
    let directories = groups
        .into_iter()
        .filter_map(|(path, mut group)| {
            if group.episodes.is_empty() {
                return None;
            }
            group.path = path.to_str()?.to_owned();
            group.episodes.sort_by(|a, b| a.path.cmp(&b.path));
            group.subtitles.sort();
            Some(group)
        })
        .collect();
    Ok(LibraryScan {
        path: root.to_string_lossy().into_owned(),
        directories,
    })
}

fn registry(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let db =
        Connection::open(dir.join("player-library.sqlite3")).map_err(|error| error.to_string())?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY, resolved TEXT NOT NULL)",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(db)
}

fn registered(db: &Connection, path: &str, resolved: &Path) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM roots WHERE path = ?1 AND resolved = ?2)",
        params![path, resolved.to_str()],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn player_scan_folder(app: AppHandle, path: String) -> Result<LibraryScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path);
        let resolved = root.canonicalize().map_err(|error| error.to_string())?;
        let db = registry(&app)?;
        let known = registered(&db, &path, &resolved)?;
        if !known && !app.asset_protocol_scope().is_allowed(&resolved) {
            return Err("Select this library folder in the folder picker first.".into());
        }
        let result = scan(root, &resolved)?;
        if !known {
            db.execute(
                "INSERT OR REPLACE INTO roots(path, resolved) VALUES (?1, ?2)",
                params![path, resolved.to_str()],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn player_forget_library_folder(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        registry(&app)?
            .execute("DELETE FROM roots WHERE path = ?1", [path])
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn player_allow_library_media(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
        let resolved = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !resolved.starts_with(&resolved_root)
            || !is_media(&resolved)
            || !resolved.is_file()
            || !registered(&registry(&app)?, &root, &resolved_root)?
        {
            return Err("Media file is outside the selected library or unsupported.".into());
        }
        app.asset_protocol_scope()
            .allow_file(&resolved)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn player_read_local_subtitle(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !is_subtitle(&resolved) || !resolved.is_file() {
            return Err("Select an SRT, VTT, ASS or SSA subtitle file.".into());
        }
        let bytes = fs::read(resolved).map_err(|error| error.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_series_with_sidecars_once_per_media_directory() {
        let root = std::env::temp_dir().join(format!(
            "setsuna-library-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let release = root.join("Series [1080p]");
        let subs = release.join("sUb").join("ja");
        fs::create_dir_all(&subs).unwrap();
        fs::write(root.join("movie.MP4"), []).unwrap();
        fs::write(root.join("movie.vtt"), []).unwrap();
        fs::write(release.join("02.MKV"), []).unwrap();
        fs::write(release.join("01.mkv"), []).unwrap();
        fs::write(release.join("info.txt"), []).unwrap();
        fs::write(subs.join("different release 01.ASS"), []).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, release.join("loop")).unwrap();
        let result = scan(&root, &root.canonicalize().unwrap()).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(result.directories.len(), 2);
        assert_eq!(result.directories[0].episodes.len(), 1);
        assert_eq!(result.directories[0].subtitles.len(), 1);
        let series = &result.directories[1];
        assert_eq!(series.episodes.len(), 2);
        assert!(series.episodes[0].path.ends_with("01.mkv"));
        assert_eq!(series.subtitles.len(), 1);
        assert!(series.subtitles[0].ends_with("different release 01.ASS"));
    }
}
