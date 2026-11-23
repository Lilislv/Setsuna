//! Sharing dictionaries between users through Google Drive, with no server.
//!
//! Sharing: the chosen dictionaries are copied into a small SQLite pack (the
//! same schema as `dictionary.db`), gzip-compressed, uploaded to the sharer's
//! own Drive (scope `drive.file`: the app only sees files it created) and made
//! readable by anyone with the link. The Drive file id is the share code.
//!
//! Receiving: the code (or a Drive link) is downloaded without signing in,
//! unpacked and imported like a `dictionary.db` from a PC, which is a plain
//! SQL copy and much faster than parsing Yomitan JSON.

use rusqlite::{params, Connection};
use serde_json::json;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Emitter;

const PACK_TABLES: [(&str, &str, &str); 5] = [
    ("entries", "term,reading,definition,dict_name,tags,lookup_rules,score", "dict_name"),
    ("frequencies", "term,reading,value,display_value,dict_name", "dict_name"),
    ("pitches", "term,reading,position,dict_name", "dict_name"),
    ("pronunciations", "term,reading,ipa,tags,dict_name", "dict_name"),
    ("dictionary_meta", "title,revision,format,index_url,download_url,is_updatable,imported_at_ms", "title"),
];

fn temp_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = crate::get_data_path(app, "dictionary.db")?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("No data folder")?
        .join("share-temp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Extracts a Drive file id from a share code or any Drive link.
pub(crate) fn parse_share_code(code: &str) -> Option<String> {
    let code = code.trim();
    let candidate = if let Some(index) = code.find("/d/") {
        code[index + 3..].split(['/', '?', '#']).next().unwrap_or("")
    } else if let Some(index) = code.find("id=") {
        code[index + 3..].split(['&', '#']).next().unwrap_or("")
    } else {
        code
    };
    let candidate: String = candidate.chars().filter(|c| !c.is_whitespace()).collect();
    let valid = (20..=80).contains(&candidate.len())
        && candidate.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then_some(candidate)
}

/// Copies the named dictionaries from `source` into a new pack database.
pub(crate) fn build_pack(source: &Path, pack: &Path, names: &[String]) -> Result<u64, String> {
    let _ = std::fs::remove_file(pack);
    let mut conn = Connection::open(pack).map_err(|e| e.to_string())?;
    crate::core::database::ensure_canonical_schema(&mut conn)?;
    // Lookup indexes are rebuilt by the receiver; leaving them out keeps the pack small.
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_term; DROP INDEX IF EXISTS idx_reading;
         DROP INDEX IF EXISTS idx_freq_term; DROP INDEX IF EXISTS idx_freq_reading;
         DROP INDEX IF EXISTS idx_pitch_term; DROP INDEX IF EXISTS idx_pitch_reading;
         DROP INDEX IF EXISTS idx_pron_term; DROP INDEX IF EXISTS idx_pron_reading;
         PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute("ATTACH DATABASE ?1 AS src", params![source.to_string_lossy()])
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<u64, String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("CREATE TEMP TABLE share_names(name TEXT PRIMARY KEY);")
            .map_err(|e| e.to_string())?;
        for name in names {
            tx.execute("INSERT OR IGNORE INTO share_names(name) VALUES (?1)", params![name])
                .map_err(|e| e.to_string())?;
        }
        let mut rows = 0u64;
        for (table, columns, key) in PACK_TABLES {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM src.sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                continue;
            }
            let mut stmt = tx
                .prepare(&format!("PRAGMA src.table_info({table})"))
                .map_err(|e| e.to_string())?;
            let available = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(stmt);
            let columns = columns
                .split(',')
                .filter(|c| available.iter().any(|a| a == c))
                .collect::<Vec<_>>()
                .join(",");
            rows += tx
                .execute(
                    &format!(
                        "INSERT INTO main.{table} ({columns}) SELECT {columns} FROM src.{table}
                         WHERE {key} IN (SELECT name FROM share_names)"
                    ),
                    [],
                )
                .map_err(|e| e.to_string())? as u64;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(rows)
    })();
    let _ = conn.execute_batch("DETACH DATABASE src");
    let rows = result?;
    if rows == 0 {
        return Err("The selected dictionaries are empty".into());
    }
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Compresses a pack with xz (LZMA). On real dictionaries it is 30-35% smaller
/// than gzip (JMdict Extra: 14 MB instead of 20 MB), which matters on a 15 GB
/// Google Drive. It is slower to compress, but each dictionary part is
/// compressed once and then reused by every share; unpacking takes under a second.
fn compress_file(from: &Path, to: &Path, mut progress: impl FnMut(f64)) -> Result<u64, String> {
    let total = std::fs::metadata(from).map_err(|e| e.to_string())?.len().max(1);
    let mut input = BufReader::with_capacity(1 << 20, File::open(from).map_err(|e| e.to_string())?);
    let output = BufWriter::with_capacity(1 << 20, File::create(to).map_err(|e| e.to_string())?);
    let mut encoder = xz2::write::XzEncoder::new(output, 6);
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        encoder.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        progress(done as f64 / total as f64);
    }
    encoder.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    Ok(std::fs::metadata(to).map_err(|e| e.to_string())?.len())
}

fn drive_error(status: reqwest::StatusCode, body: &str) -> String {
    if status.as_u16() == 403 && (body.contains("insufficient") || body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
        return "DRIVE_SCOPE_MISSING".into();
    }
    format!("Google Drive: {status} {}", body.chars().take(300).collect::<String>())
}

/// Pack format 2: `SETSUNA2`, a little-endian u32 manifest length, the JSON
/// manifest, then one gzip-compressed SQLite pack per dictionary. The manifest
/// lists each dictionary's byte range, so a receiver reads only the manifest
/// first (a few KB, via an HTTP Range request) and then downloads just the
/// dictionaries it picked. Format 1 (one gzip of the whole pack) is still read.
const PACK_MAGIC: &[u8; 8] = b"SETSUNA2";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct PackEntry {
    name: String,
    rows: u64,
    /// Offset from the start of the body (right after the manifest).
    offset: u64,
    size: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PackManifest {
    version: u32,
    dictionaries: Vec<PackEntry>,
}

fn emit_step(app: &tauri::AppHandle, operation: &str, name: &str, index: usize, count: usize, percent: f64, status: &str) {
    let _ = app.emit(
        "import_progress",
        json!({
            "operation": operation,
            "dict_name": name,
            "total_dicts": count,
            "dict_index": index,
            "dict_count": count,
            "current_file": 0,
            "total_files": 1,
            "words_added": 0,
            "percent": percent.clamp(0.0, 100.0),
            "status": status,
        }),
    );
}

// ---------------------------------------------------------------------------
// Sharing, format 3: every dictionary is stored once in the sharer's Drive as
// its own gzip-compressed pack ("part"). A share is a small JSON manifest that
// lists the parts. Sharing another set of dictionaries reuses the parts that
// are already uploaded and unchanged, so nothing is packed or uploaded twice.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ShareEntry {
    name: String,
    rows: u64,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    /// Drive file id of the dictionary part.
    file: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ShareManifest {
    setsuna: u32,
    title: String,
    dictionaries: Vec<ShareEntry>,
}

/// Rows and revision identify a dictionary version; a changed dictionary gets a new part.
fn dictionary_fingerprint(source: &Path, name: &str) -> Result<(u64, String), String> {
    let conn = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let rows: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM entries WHERE dict_name = ?1)
                  + (SELECT COUNT(*) FROM frequencies WHERE dict_name = ?1)
                  + (SELECT COUNT(*) FROM pitches WHERE dict_name = ?1)
                  + (SELECT COUNT(*) FROM pronunciations WHERE dict_name = ?1)",
            params![name],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let revision: String = conn
        .query_row("SELECT COALESCE(revision, '') FROM dictionary_meta WHERE title = ?1", params![name], |row| row.get(0))
        .unwrap_or_default();
    Ok((rows.max(0) as u64, revision.chars().take(40).collect()))
}

fn part_key(name: &str) -> String {
    format!("{:x}", md5::compute(name.as_bytes()))
}

struct DrivePart {
    id: String,
    size: u64,
}

/// Parts already uploaded by this user, by (name key, rows, revision).
async fn list_drive_parts(client: &reqwest::Client, token: &str) -> Result<std::collections::HashMap<(String, String, String), DrivePart>, String> {
    let mut parts = std::collections::HashMap::new();
    let mut page_token = String::new();
    loop {
        let mut url = reqwest::Url::parse("https://www.googleapis.com/drive/v3/files").map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("q", "appProperties has { key='setsunaPart' and value='1' } and trashed=false")
            .append_pair("pageSize", "1000")
            .append_pair("fields", "nextPageToken,files(id,size,appProperties)");
        if !page_token.is_empty() {
            url.query_pairs_mut().append_pair("pageToken", &page_token);
        }
        let response = client.get(url).bearer_auth(token).send().await.map_err(|e| format!("Google Drive: {}", e.without_url()))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(drive_error(status, &text));
        }
        let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        for file in data.get("files").and_then(|f| f.as_array()).into_iter().flatten() {
            let props = file.get("appProperties").cloned().unwrap_or_default();
            let get = |key: &str| props.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let id = file.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let size = file.get("size").and_then(|v| v.as_str()).and_then(|v| v.parse().ok()).unwrap_or(0);
            if !id.is_empty() {
                parts.insert((get("setsunaDict"), get("setsunaRows"), get("setsunaRev")), DrivePart { id, size });
            }
        }
        page_token = data.get("nextPageToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if page_token.is_empty() {
            break;
        }
    }
    Ok(parts)
}

/// Resumable upload of a local file; returns the new Drive file id.
async fn upload_file(
    client: &reqwest::Client,
    token: &str,
    metadata: serde_json::Value,
    path: &Path,
    content_type: &str,
    mut progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let start = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id")
        .bearer_auth(token)
        .header("Content-Type", "application/json; charset=UTF-8")
        .header("X-Upload-Content-Type", content_type)
        .header("X-Upload-Content-Length", size.to_string())
        .body(metadata.to_string())
        .send()
        .await
        .map_err(|e| format!("Google Drive: {}", e.without_url()))?;
    if !start.status().is_success() {
        let status = start.status();
        let text = start.text().await.unwrap_or_default();
        return Err(drive_error(status, &text));
    }
    let upload_url = start
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("Google Drive did not return an upload address")?
        .to_string();
    const CHUNK: u64 = 8 * 1024 * 1024;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut sent = 0u64;
    loop {
        let amount = (size - sent).min(CHUNK);
        let mut chunk = vec![0u8; amount as usize];
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        let range = if size == 0 { "bytes */0".to_string() } else { format!("bytes {}-{}/{}", sent, sent + amount - 1, size) };
        let mut attempt = 0;
        let response = loop {
            attempt += 1;
            let result = client
                .put(&upload_url)
                .header("Content-Length", amount.to_string())
                .header("Content-Range", range.clone())
                .body(chunk.clone())
                .send()
                .await;
            match result {
                Ok(response) => break response,
                Err(_) if attempt < 4 => tokio::time::sleep(Duration::from_secs(2)).await,
                Err(error) => return Err(format!("Upload failed: {}", error.without_url())),
            }
        };
        let status = response.status();
        if status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            progress(size, size);
            return if id.is_empty() { Err("Google Drive did not return the file id".into()) } else { Ok(id) };
        }
        if status.as_u16() != 308 {
            let text = response.text().await.unwrap_or_default();
            return Err(drive_error(status, &text));
        }
        sent += amount;
        progress(sent, size);
    }
}

async fn make_public(client: &reqwest::Client, token: &str, id: &str) -> Result<(), String> {
    let response = client
        .post(format!("https://www.googleapis.com/drive/v3/files/{id}/permissions"))
        .bearer_auth(token)
        .json_body(&json!({ "role": "reader", "type": "anyone" }))
        .send()
        .await
        .map_err(|e| format!("Google Drive: {}", e.without_url()))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    Err(drive_error(status, &text))
}

#[tauri::command]
pub(crate) async fn share_dictionaries(
    app: tauri::AppHandle,
    token: String,
    names: Vec<String>,
    title: String,
) -> Result<serde_json::Value, String> {
    if names.is_empty() {
        return Err("Choose at least one dictionary".into());
    }
    let source = crate::get_data_path(&app, "dictionary.db")?;
    let label = title.trim().to_string();
    let count = names.len();
    let client = crate::http_client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    emit_step(&app, "share", &label, 1, count, 0.0, "Checking Google Drive...");
    let existing = list_drive_parts(&client, &token).await?;
    let mut entries: Vec<ShareEntry> = Vec::new();
    let mut uploaded_bytes = 0u64;
    let mut reused = 0usize;
    for (index, name) in names.iter().enumerate() {
        let step = index + 1;
        let (source2, name2) = (source.clone(), name.clone());
        let (rows, revision) = tauri::async_runtime::spawn_blocking(move || dictionary_fingerprint(&source2, &name2))
            .await
            .map_err(|e| e.to_string())??;
        if rows == 0 {
            continue;
        }
        let key = (part_key(name), rows.to_string(), revision.clone());
        if let Some(part) = existing.get(&key) {
            // Unchanged since it was last shared: reuse the uploaded part.
            reused += 1;
            emit_step(&app, "share", name, step, count, 100.0, "Already on Google Drive");
            entries.push(ShareEntry { name: name.clone(), rows, size_bytes: part.size, file: part.id.clone() });
            continue;
        }
        // Only one dictionary is packed at a time, and its files are deleted
        // as soon as it is uploaded.
        let pack = temp_path(&app, "share-part.db")?;
        let packed = temp_path(&app, "share-part.db.xz")?;
        emit_step(&app, "share", name, step, count, 0.0, "Collecting dictionaries...");
        let (pack2, packed2, source2, name2, app2) = (pack.clone(), packed.clone(), source.clone(), name.clone(), app.clone());
        let size = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
            build_pack(&source2, &pack2, std::slice::from_ref(&name2))?;
            let mut last = Instant::now();
            let size = compress_file(&pack2, &packed2, |fraction| {
                if last.elapsed() >= Duration::from_millis(250) {
                    last = Instant::now();
                    emit_step(&app2, "share", &name2, step, count, 5.0 + fraction * 35.0, "Compressing...");
                }
            });
            let _ = std::fs::remove_file(&pack2);
            size
        })
        .await
        .map_err(|e| e.to_string())?;
        let size = match size {
            Ok(size) => size,
            Err(error) => {
                let _ = std::fs::remove_file(&packed);
                return Err(error);
            }
        };
        let metadata = json!({
            "name": format!("{name} — Setsuna dictionary part"),
            "mimeType": "application/x-xz",
            "description": format!("A Setsuna dictionary pack: {name} ({rows} rows). Used by shared dictionary codes."),
            "appProperties": {
                "setsunaPart": "1",
                "setsunaDict": key.0,
                "setsunaRows": key.1,
                "setsunaRev": key.2,
            },
        });
        let mut last = Instant::now();
        let uploaded = upload_file(&client, &token, metadata, &packed, "application/x-xz", |sent, total| {
            if last.elapsed() >= Duration::from_millis(250) || sent == total {
                last = Instant::now();
                emit_step(&app, "share", name, step, count, 40.0 + sent as f64 / total.max(1) as f64 * 58.0, "Uploading to Google Drive...");
            }
        })
        .await;
        let _ = std::fs::remove_file(&packed);
        let id = uploaded?;
        make_public(&client, &token, &id).await?;
        uploaded_bytes += size;
        entries.push(ShareEntry { name: name.clone(), rows, size_bytes: size, file: id });
    }
    if entries.is_empty() {
        return Err("The selected dictionaries are empty".into());
    }

    let manifest = ShareManifest { setsuna: 3, title: label.clone(), dictionaries: entries.clone() };
    let manifest_path = temp_path(&app, "share-manifest.json")?;
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let shown = if label.is_empty() { "Setsuna".to_string() } else { label.clone() };
    let description = format!("Setsuna dictionaries: {}", entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", "));
    let metadata = json!({
        "name": format!("{shown} — Setsuna.setsuna-dicts.json"),
        "mimeType": "application/json",
        "description": description.chars().take(2000).collect::<String>(),
        "appProperties": { "setsunaShare": "1" },
    });
    emit_step(&app, "share", &label, count, count, 99.0, "Uploading to Google Drive...");
    let created = upload_file(&client, &token, metadata, &manifest_path, "application/json", |_, _| {}).await;
    let _ = std::fs::remove_file(&manifest_path);
    let manifest_id = created?;
    make_public(&client, &token, &manifest_id).await?;
    emit_step(&app, "share", &label, count, count, 100.0, "Done");
    let total: u64 = entries.iter().map(|e| e.size_bytes).sum();
    Ok(json!({
        "code": manifest_id,
        "sizeBytes": total,
        "uploadedBytes": uploaded_bytes,
        "reused": reused,
        "count": entries.len(),
    }))
}

trait JsonBody {
    fn json_body(self, value: &serde_json::Value) -> Self;
}

impl JsonBody for reqwest::RequestBuilder {
    fn json_body(self, value: &serde_json::Value) -> Self {
        self.header("Content-Type", "application/json; charset=UTF-8").body(value.to_string())
    }
}

fn download_client() -> Result<reqwest::Client, String> {
    crate::http_client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn download_url(id: &str) -> String {
    format!("https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t")
}

fn check_download_status(status: reqwest::StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    // 404: no such file; 401/403: the file exists but is not shared publicly.
    Err(if matches!(status.as_u16(), 401 | 403 | 404) { "SHARE_CODE_NOT_FOUND".into() } else { format!("Download failed: HTTP {status}") })
}

/// Fetches bytes `[start, start+len)` of a shared file.
async fn fetch_range(client: &reqwest::Client, id: &str, start: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(download_url(id))
        .header("Range", format!("bytes={}-{}", start, start + len - 1))
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e.without_url()))?;
    check_download_status(response.status())?;
    // A server that ignores Range sends the whole file from byte 0.
    let mut skip = if response.status().as_u16() == 206 { 0 } else { start };
    let mut out = Vec::with_capacity(len as usize);
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Download failed: {}", e.without_url()))? {
        let mut data: &[u8] = &chunk;
        if skip > 0 {
            let drop_now = skip.min(data.len() as u64) as usize;
            data = &data[drop_now..];
            skip -= drop_now as u64;
        }
        let need = len as usize - out.len();
        out.extend_from_slice(&data[..data.len().min(need)]);
        if out.len() as u64 >= len {
            break;
        }
    }
    Ok(out)
}

enum PackInfo {
    Legacy,
    V2 { body_start: u64, manifest: PackManifest },
    V3(ShareManifest),
}

async fn inspect_pack(client: &reqwest::Client, id: &str) -> Result<PackInfo, String> {
    let head = fetch_range(client, id, 0, 64 * 1024).await?;
    if head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b {
        return Ok(PackInfo::Legacy);
    }
    if head.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{') {
        let parsed = serde_json::from_slice::<ShareManifest>(&head);
        let manifest = match parsed {
            Ok(manifest) => manifest,
            // A very long list may not fit in the first request.
            Err(error) if error.is_eof() => serde_json::from_slice::<ShareManifest>(&fetch_range(client, id, 0, 8 * 1024 * 1024).await?)
                .map_err(|e| format!("The shared list is damaged: {e}"))?,
            Err(_) => return Err("SHARE_CODE_NOT_FOUND".into()),
        };
        if manifest.setsuna != 3 {
            return Err("This share was made by a newer Setsuna. Update the app.".into());
        }
        return Ok(PackInfo::V3(manifest));
    }
    if head.len() < 12 || &head[..8] != PACK_MAGIC {
        return Err("SHARE_CODE_NOT_FOUND".into());
    }
    let manifest_len = u32::from_le_bytes([head[8], head[9], head[10], head[11]]) as u64;
    if manifest_len > 16 * 1024 * 1024 {
        return Err("The shared pack is damaged".into());
    }
    let manifest_bytes = if 12 + manifest_len <= head.len() as u64 {
        head[12..12 + manifest_len as usize].to_vec()
    } else {
        fetch_range(client, id, 12, manifest_len).await?
    };
    let manifest: PackManifest = serde_json::from_slice(&manifest_bytes).map_err(|e| format!("The shared pack is damaged: {e}"))?;
    Ok(PackInfo::V2 { body_start: 12 + manifest_len, manifest })
}

/// Lists the dictionaries in a shared pack without downloading them.
#[tauri::command]
pub(crate) async fn inspect_shared_dictionaries(code: String) -> Result<serde_json::Value, String> {
    let id = parse_share_code(&code).ok_or("SHARE_CODE_INVALID")?;
    let client = download_client()?;
    Ok(match inspect_pack(&client, &id).await? {
        PackInfo::Legacy => json!({ "format": 1, "dictionaries": [] }),
        PackInfo::V2 { manifest, .. } => json!({
            "format": 2,
            "dictionaries": manifest.dictionaries.iter().map(|d| json!({ "name": d.name, "rows": d.rows, "sizeBytes": d.size })).collect::<Vec<_>>(),
        }),
        PackInfo::V3(manifest) => json!({
            "format": 3,
            "title": manifest.title,
            "dictionaries": manifest.dictionaries.iter().map(|d| json!({ "name": d.name, "rows": d.rows, "sizeBytes": d.size_bytes })).collect::<Vec<_>>(),
        }),
    })
}

/// Streams a byte range of a shared file into `to`, reporting progress.
async fn download_to_file(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    id: &str,
    range: Option<(u64, u64)>,
    to: &Path,
    progress: (&str, usize, usize),
) -> Result<(), String> {
    let mut request = client.get(download_url(id));
    if let Some((start, len)) = range {
        request = request.header("Range", format!("bytes={}-{}", start, start + len - 1));
    }
    let mut response = request.send().await.map_err(|e| format!("Download failed: {}", e.without_url()))?;
    check_download_status(response.status())?;
    let (mut skip, total) = match range {
        Some((start, len)) if response.status().as_u16() != 206 => (start, len),
        Some((_, len)) => (0, len),
        None => (0, response.content_length().unwrap_or(0)),
    };
    let limit = range.map(|(_, len)| len);
    let mut out = BufWriter::with_capacity(1 << 20, File::create(to).map_err(|e| e.to_string())?);
    let mut written = 0u64;
    let mut first = true;
    let mut last = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Download failed: {}", e.without_url()))? {
        let mut data: &[u8] = &chunk;
        if skip > 0 {
            let drop_now = skip.min(data.len() as u64) as usize;
            data = &data[drop_now..];
            skip -= drop_now as u64;
        }
        if let Some(limit) = limit {
            data = &data[..data.len().min((limit - written) as usize)];
        }
        if data.is_empty() {
            if limit.is_some_and(|limit| written >= limit) { break; }
            continue;
        }
        if first {
            first = false;
            // A private or missing file returns Google's HTML page instead of pack data.
            if !(data.starts_with(&[0x1f, 0x8b]) || data.starts_with(XZ_MAGIC)) {
                drop(out);
                let _ = std::fs::remove_file(to);
                return Err("SHARE_CODE_NOT_FOUND".into());
            }
        }
        out.write_all(data).map_err(|e| e.to_string())?;
        written += data.len() as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            let percent = if total > 0 { written as f64 / total as f64 * 70.0 } else { 30.0 };
            emit_step(app, "download", progress.0, progress.1, progress.2, percent, "Downloading...");
        }
        if limit.is_some_and(|limit| written >= limit) {
            break;
        }
    }
    out.flush().map_err(|e| e.to_string())
}

const XZ_MAGIC: &[u8] = &[0xfd, b'7', b'z', b'X', b'Z', 0x00];

/// Unpacks a part compressed with xz (current) or gzip (older shares).
fn unpack_file(from: &Path, to: &Path) -> Result<(), String> {
    let mut magic = [0u8; 6];
    File::open(from).and_then(|mut f| f.read_exact(&mut magic)).map_err(|e| format!("The shared pack is damaged: {e}"))?;
    let input = BufReader::with_capacity(1 << 20, File::open(from).map_err(|e| e.to_string())?);
    let mut decoder: Box<dyn Read> = if magic == XZ_MAGIC {
        Box::new(xz2::read::XzDecoder::new(input))
    } else {
        Box::new(flate2::read::GzDecoder::new(input))
    };
    let mut output = BufWriter::with_capacity(1 << 20, File::create(to).map_err(|e| e.to_string())?);
    std::io::copy(&mut decoder, &mut output).map_err(|e| format!("The shared pack is damaged: {e}"))?;
    output.flush().map_err(|e| e.to_string())
}

/// Downloads, unpacks and imports one pack part, then deletes its temporary files.
async fn install_part(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    id: &str,
    range: Option<(u64, u64)>,
    name: &str,
    index: usize,
    count: usize,
) -> Result<usize, String> {
    // Unique names per part: the importer ignores a repeated path for 10 s.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let packed = temp_path(app, &format!("received-{stamp}-{index}.pack"))?;
    let pack = temp_path(app, &format!("received-{stamp}-{index}.db"))?;
    emit_step(app, "download", name, index, count, 0.0, "Downloading...");
    let downloaded = download_to_file(app, client, id, range, &packed, (name, index, count)).await;
    if let Err(error) = downloaded {
        let _ = std::fs::remove_file(&packed);
        return Err(error);
    }
    emit_step(app, "download", name, index, count, 72.0, "Unpacking...");
    let (packed2, pack2) = (packed.clone(), pack.clone());
    let unpacked = tauri::async_runtime::spawn_blocking(move || unpack_file(&packed2, &pack2))
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&packed);
    if let Err(error) = unpacked {
        let _ = std::fs::remove_file(&pack);
        return Err(error);
    }
    let result = crate::dictionary_import::import_dictionaries(app.clone(), vec![pack.to_string_lossy().into_owned()]).await;
    let _ = std::fs::remove_file(&pack);
    result
}

#[tauri::command]
pub(crate) async fn receive_shared_dictionaries(
    app: tauri::AppHandle,
    code: String,
    names: Option<Vec<String>>,
) -> Result<usize, String> {
    let id = parse_share_code(&code).ok_or("SHARE_CODE_INVALID")?;
    let client = download_client()?;
    match inspect_pack(&client, &id).await? {
        PackInfo::Legacy => install_part(&app, &client, &id, None, "Google Drive", 1, 1).await,
        PackInfo::V2 { body_start, manifest } => {
            let chosen: Vec<PackEntry> = manifest
                .dictionaries
                .into_iter()
                .filter(|entry| names.as_ref().is_none_or(|names| names.contains(&entry.name)))
                .collect();
            if chosen.is_empty() {
                return Err("Choose at least one dictionary".into());
            }
            let count = chosen.len();
            let mut added = 0usize;
            for (index, entry) in chosen.iter().enumerate() {
                added += install_part(&app, &client, &id, Some((body_start + entry.offset, entry.size)), &entry.name, index + 1, count).await?;
            }
            Ok(added)
        }
        PackInfo::V3(manifest) => {
            let chosen: Vec<ShareEntry> = manifest
                .dictionaries
                .into_iter()
                .filter(|entry| names.as_ref().is_none_or(|names| names.contains(&entry.name)))
                .collect();
            if chosen.is_empty() {
                return Err("Choose at least one dictionary".into());
            }
            let count = chosen.len();
            let mut added = 0usize;
            for (index, entry) in chosen.iter().enumerate() {
                let part = parse_share_code(&entry.file).ok_or("The shared list is damaged")?;
                added += install_part(&app, &client, &part, None, &entry.name, index + 1, count).await?;
            }
            Ok(added)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_round_trip_through_xz_and_old_gzip() {
        let dir = std::env::temp_dir().join(format!("setsuna-share-pack-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("pack.db");
        let data: Vec<u8> = (0..200_000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        std::fs::write(&original, &data).unwrap();
        let xz = dir.join("pack.xz");
        compress_file(&original, &xz, |_| {}).unwrap();
        let back = dir.join("back.db");
        unpack_file(&xz, &back).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data);
        let gz = dir.join("pack.gz");
        let mut encoder = flate2::write::GzEncoder::new(File::create(&gz).unwrap(), flate2::Compression::new(6));
        encoder.write_all(&data).unwrap();
        encoder.finish().unwrap();
        unpack_file(&gz, &back).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn share_manifest_lists_parts() {
        let text = r#"{"setsuna":3,"title":"VN","dictionaries":[{"name":"Warodai","rows":107341,"sizeBytes":4300000,"file":"1AbCdEfGhIjKlMnOpQrStUvWxYz012345"}]}"#;
        let manifest: ShareManifest = serde_json::from_str(text).unwrap();
        assert_eq!(manifest.setsuna, 3);
        assert_eq!(manifest.dictionaries[0].name, "Warodai");
        assert_eq!(parse_share_code(&manifest.dictionaries[0].file).as_deref(), Some("1AbCdEfGhIjKlMnOpQrStUvWxYz012345"));
    }

    #[test]
    fn share_codes_accept_ids_and_links() {
        let id = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        assert_eq!(parse_share_code(id).as_deref(), Some(id));
        assert_eq!(parse_share_code(&format!("  {id}\n")).as_deref(), Some(id));
        assert_eq!(parse_share_code(&format!("https://drive.google.com/file/d/{id}/view?usp=sharing")).as_deref(), Some(id));
        assert_eq!(parse_share_code(&format!("https://drive.google.com/open?id={id}")).as_deref(), Some(id));
        assert_eq!(parse_share_code("hello"), None);
        assert_eq!(parse_share_code("<script>alert(1)</script>"), None);
    }

    #[test]
    fn pack_contains_only_the_chosen_dictionaries() {
        let dir = std::env::temp_dir().join(format!("setsuna-share-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.db");
        let pack = dir.join("pack.db");
        let mut conn = Connection::open(&source).unwrap();
        crate::core::database::ensure_canonical_schema(&mut conn).unwrap();
        conn.execute_batch(r#"
            INSERT INTO entries(term,reading,definition,dict_name) VALUES ('食べる','たべる','["eat"]','JMdict'),('abuse','','["злоупотребление"]','wty-en-ru');
            INSERT INTO frequencies(term,reading,value,display_value,dict_name) VALUES ('食べる','たべる',10,'10','JPDB');
            INSERT INTO dictionary_meta(title,revision) VALUES ('JMdict','2026'),('wty-en-ru','2026');
        "#).unwrap();
        drop(conn);
        let rows = build_pack(&source, &pack, &["wty-en-ru".to_string(), "JPDB".to_string()]).unwrap();
        assert_eq!(rows, 3);
        let packed = Connection::open(&pack).unwrap();
        let names: Vec<String> = packed
            .prepare("SELECT dict_name FROM entries UNION SELECT dict_name FROM frequencies UNION SELECT title FROM dictionary_meta ORDER BY 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["JPDB", "wty-en-ru"]);
        assert!(build_pack(&source, &pack, &["Missing".to_string()]).is_err());
        drop(packed);
        let _ = std::fs::remove_dir_all(dir);
    }
}
