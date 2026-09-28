use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, path::Path, time::Duration};

const MAX_AUDIO_BYTES: i64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDatabaseInfo {
    filename: String,
    entries: i64,
    sources: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClip {
    pub data: String,
    pub mime_type: String,
    pub filename: String,
    pub source: String,
    pub speaker: String,
    pub display: String,
    pub reading: String,
}

fn open_database(path: &str) -> Result<Connection, String> {
    if path.trim().is_empty() { return Err("Select a local audio database first".into()); }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Cannot open audio database: {e}"))?;
    db.busy_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA mmap_size=0;")
        .map_err(|e| e.to_string())?;
    // Validate metadata without loading any recordings or changing the supplied database.
    for (table, columns) in [
        ("entries", "id, expression, reading, source, speaker, display, file"),
        ("android", "id, file, source, data"),
    ] {
        let is_table: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if !is_table { return Err("Unsupported audio database. Expected the android.db audio format".into()); }
        db.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
            .map_err(|_| "Unsupported audio database schema".to_string())?;
    }
    Ok(db)
}

fn inspect(path: &str) -> Result<AudioDatabaseInfo, String> {
    let db = open_database(path)?;
    let entries = db.query_row("SELECT count(*) FROM entries", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    let mut statement = db.prepare("SELECT DISTINCT source FROM entries ORDER BY source").map_err(|e| e.to_string())?;
    let sources = statement.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())?;
    Ok(AudioDatabaseInfo { filename: Path::new(path).file_name().unwrap_or_default().to_string_lossy().into(), entries, sources })
}

fn audio_format(data: &[u8]) -> Option<(&'static str, &'static str)> {
    if data.starts_with(b"ID3") || (data.len() > 1 && data[0] == 0xff && data[1] & 0xe0 == 0xe0) { Some(("audio/mpeg", "mp3")) }
    else if data.starts_with(b"OggS") { Some(("audio/ogg", "ogg")) }
    else if data.starts_with(b"fLaC") { Some(("audio/flac", "flac")) }
    else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WAVE") { Some(("audio/wav", "wav")) }
    else if data.get(4..8) == Some(b"ftyp") { Some(("audio/mp4", "m4a")) }
    else { None }
}

fn lookup(path: &str, term: &str, reading: &str, preferred_source: &str) -> Result<Option<AudioClip>, String> {
    if term.trim().is_empty() { return Ok(None); }
    if term.chars().count() > 200 || reading.chars().count() > 200 { return Err("Audio query is too long".into()); }
    let db = open_database(path)?;
    let terms = super::lookup_normalization::japanese_lookup_variants(term.trim());
    let readings = super::lookup_normalization::japanese_lookup_variants(reading.trim());
    let mut values: Vec<String> = terms.clone();
    let placeholders = |start: usize, count: usize| (start..start + count).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",");
    let term_parameters = placeholders(1, terms.len());
    let reading_parameters = placeholders(values.len() + 1, readings.len());
    values.extend(readings);
    let preferred_parameter = values.len() + 1;
    values.push(preferred_source.into());
    let reading_filter = if reading.trim().is_empty() { "1".into() } else {
        format!("(e.reading IN ({reading_parameters}) OR e.reading IS NULL OR e.reading='')")
    };
    // Both joins use the database's expression/reading and file/source indexes.
    // Exact readings precede unknown readings; other pronunciations are excluded.
    let sql = format!("SELECT a.data, e.source, COALESCE(e.speaker,''), COALESCE(e.display,''), COALESCE(e.reading,'')
        FROM entries e JOIN android a ON a.file=e.file AND a.source=e.source
        WHERE e.expression IN ({term_parameters}) AND {reading_filter}
          AND typeof(a.data)='blob' AND length(a.data)>0 AND length(a.data)<={MAX_AUDIO_BYTES}
        ORDER BY CASE WHEN e.reading IN ({reading_parameters}) THEN 0 ELSE 1 END,
          CASE WHEN e.source=?{preferred_parameter} THEN 0 ELSE 1 END,
          CASE WHEN e.expression=?1 THEN 0 ELSE 1 END, e.id, a.id LIMIT 1");
    let row: Option<(Vec<u8>, String, String, String, String)> = db.query_row(&sql, params_from_iter(values), |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
    }).optional().map_err(|e| format!("Audio lookup failed: {e}"))?;
    let Some((bytes, source, speaker, display, reading)) = row else { return Ok(None); };
    let (mime, extension) = audio_format(&bytes).ok_or("Unsupported recording format in audio database")?;
    let mut fingerprint = DefaultHasher::new();
    bytes.hash(&mut fingerprint);
    Ok(Some(AudioClip { data: STANDARD.encode(&bytes), mime_type: mime.into(),
        filename: format!("setsuna_audio_{:016x}.{extension}", fingerprint.finish()), source, speaker, display, reading }))
}

#[tauri::command]
pub async fn inspect_local_audio_database(path: String) -> Result<AudioDatabaseInfo, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lookup_local_audio(path: String, term: String, reading: String, preferred_source: Option<String>) -> Result<Option<AudioClip>, String> {
    tauri::async_runtime::spawn_blocking(move || lookup(&path, &term, &reading, preferred_source.as_deref().unwrap_or(""))).await.map_err(|e| e.to_string())?
}

fn online_clip(bytes: &[u8], term: &str, reading: &str) -> Option<AudioClip> {
    // JapanesePod101's HTTP-200 "not found" recording (also used by Anki skipHash).
    let fingerprint = format!("{:x}", md5::compute(bytes));
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES as usize
        || fingerprint == "7e2c2f954ef6051373ba916f000168dc" { return None; }
    let (mime, extension) = audio_format(bytes)?;
    Some(AudioClip { data: STANDARD.encode(bytes), mime_type: mime.into(),
        filename: format!("setsuna_online_{fingerprint}.{extension}"), source: "JapanesePod101".into(),
        speaker: String::new(), display: term.into(), reading: reading.into() })
}

#[tauri::command]
pub async fn lookup_online_audio(term: String, reading: String) -> Result<Option<AudioClip>, String> {
    let term = term.trim();
    let reading = if reading.trim().is_empty() { term } else { reading.trim() };
    if term.is_empty() || term.chars().count() > 200 || reading.chars().count() > 200 { return Ok(None); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(6))
        .build().map_err(|e| e.to_string())?;
    let mut url = reqwest::Url::parse("https://assets.languagepod101.com/dictionary/japanese/audiomp3.php").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("kanji", term).append_pair("kana", reading);
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > MAX_AUDIO_BYTES as u64 { return Ok(None); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_AUDIO_BYTES as usize { return Ok(None); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(online_clip(&bytes, term, reading))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn online_audio_rejects_error_pages_and_bounded_invalid_payloads() {
        assert!(online_clip(b"<html>Not found</html>", "猫", "ねこ").is_none());
        assert!(online_clip(b"", "猫", "ねこ").is_none());
        assert!(online_clip(&vec![0; MAX_AUDIO_BYTES as usize + 1], "猫", "ねこ").is_none());
        let audio = online_clip(b"ID3\x01", "猫", "ねこ").unwrap();
        assert_eq!(audio.source, "JapanesePod101");
        assert_eq!(STANDARD.decode(audio.data).unwrap(), b"ID3\x01");
    }
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    fn fixture() -> Fixture {
        static SERIAL: AtomicUsize = AtomicUsize::new(0);
        let file = Fixture(std::env::temp_dir().join(format!("setsuna-audio-test-{}-{}.db", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed))));
        let db = Connection::open(&file.0).unwrap();
        db.execute_batch("CREATE TABLE entries(id INTEGER PRIMARY KEY,expression TEXT,reading TEXT,source TEXT,speaker TEXT,display TEXT,file TEXT);
            CREATE TABLE android(id INTEGER PRIMARY KEY,file TEXT,source TEXT,data BLOB);
            CREATE INDEX idx_expr ON entries(expression,reading); CREATE INDEX idx_audio ON android(file,source);
            INSERT INTO entries VALUES (1,'生','せい','wrong',NULL,NULL,'same.mp3'), (2,'生','なま','right',NULL,NULL,'same.mp3'),
              (3,'生',NULL,'unknown',NULL,NULL,'same.mp3'), (4,'どじ','どじ','right',NULL,NULL,'doji.mp3');
            INSERT INTO android VALUES (1,'same.mp3','wrong',x'49443301'),(2,'same.mp3','right',x'49443302'),
              (3,'same.mp3','unknown',x'49443303'),(4,'doji.mp3','right',x'49443304');").unwrap();
        file
    }
    #[test]
    fn matches_reading_and_source_and_preserves_original_database() {
        let file = fixture(); let path = file.0.to_str().unwrap();
        let before = std::fs::read(path).unwrap();
        let clip = lookup(path, "生", "なま", "unknown").unwrap().unwrap();
        assert_eq!(clip.source, "right");
        assert_eq!(STANDARD.decode(clip.data).unwrap(), b"ID3\x02");
        assert!(lookup(path, "不存在", "ふそんざい", "").unwrap().is_none());
        assert_eq!(lookup(path, "ドジ", "ドジ", "").unwrap().unwrap().reading, "どじ");
        assert_eq!(before, std::fs::read(path).unwrap());
    }
    #[test]
    fn rejects_other_readings_and_skips_missing_or_oversized_recordings() {
        let file = fixture(); let path = file.0.to_str().unwrap();
        let db = Connection::open(path).unwrap();
        db.execute("DELETE FROM entries WHERE reading IS NULL", []).unwrap();
        assert!(lookup(path, "生", "しょう", "").unwrap().is_none());
        db.execute("UPDATE android SET data=zeroblob(?1) WHERE source='right'", [MAX_AUDIO_BYTES + 1]).unwrap();
        assert!(lookup(path, "生", "なま", "").unwrap().is_none());
    }
    #[test]
    #[ignore = "requires SETSUNA_AUDIO_DB"]
    fn real_audio_database() {
        let path = std::env::var("SETSUNA_AUDIO_DB").unwrap();
        assert!(inspect(&path).unwrap().entries > 0);
        let clip = lookup(&path, "食べる", "たべる", "nhk16").unwrap().unwrap();
        assert_eq!(clip.source, "nhk16"); assert_eq!(clip.mime_type, "audio/mpeg");
        assert!(STANDARD.decode(clip.data).unwrap().len() > 100);
    }
}
