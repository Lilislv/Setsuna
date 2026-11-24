//! Manga reader backend for Setsuna (Desktop + Android):
//! - Supports image folders, `.cbz` / `.zip` archives, and `.mokuro` / `.mokuro.gz` / legacy `_ocr/*.json` overlays
//! - Provides natural page sorting, fast page/cover loading (CORS-safe data URIs for Anki canvas cropping),
//!   local OCR typo override persistence, recursive folder scanning, and desktop `mokuro` CLI integration.

use base64::{engine::general_purpose, Engine as _};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Emitter;

const MAX_MANGA_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_SCAN_VOLUMES: usize = 300;
const MAX_SCAN_DEPTH: usize = 6;

// Custom serialization so JSON uses `"box"` matching the TypeScript `MokuroBlock` interface.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MokuroBlockOut {
    #[serde(rename = "box")]
    pub box_coords: [f64; 4],
    pub vertical: bool,
    pub font_size: f64,
    pub lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_coords: Option<Vec<Vec<Vec<f64>>>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaPageInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub char_count: usize,
    pub block_count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaMeta {
    pub title: String,
    pub volume: Option<String>,
    pub series: Option<String>,
    pub series_position: Option<f64>,
    pub page_count: usize,
    pub has_mokuro: bool,
    pub mokuro_path: Option<String>,
    pub source_kind: String,
    pub total_chars: usize,
    pub cover: Option<String>,
    pub pages: Vec<MangaPageInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaPagePayload {
    pub index: usize,
    pub name: String,
    pub image_src: String,
    pub width: u32,
    pub height: u32,
    pub blocks: Vec<MokuroBlockOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaFolderEntry {
    pub path: String,
    pub subfolder_series: Option<String>,
    pub has_mokuro: bool,
    pub source_kind: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaMokuroStatus {
    pub available: bool,
    pub command: Option<String>,
    pub version: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawMokuroFile {
    title: Option<String>,
    volume: Option<String>,
    #[serde(default)]
    pages: Vec<RawMokuroPage>,
}

#[derive(Deserialize, Default)]
struct RawMokuroPage {
    img_path: Option<String>,
    img_width: Option<u32>,
    img_height: Option<u32>,
    #[serde(default)]
    blocks: Vec<RawMokuroBlock>,
}

#[derive(Deserialize, Default)]
struct RawMokuroBlock {
    #[serde(rename = "box")]
    box_coords: Option<[f64; 4]>,
    vertical: Option<bool>,
    font_size: Option<f64>,
    #[serde(default)]
    lines: Vec<String>,
    lines_coords: Option<Vec<Vec<Vec<f64>>>>,
}

#[derive(Clone)]
struct ParsedMokuroPage {
    img_path: String,
    width: u32,
    height: u32,
    blocks: Vec<MokuroBlockOut>,
}

struct ParsedMokuro {
    title: Option<String>,
    volume: Option<String>,
    source_path: Option<String>,
    pages: Vec<ParsedMokuroPage>,
}

enum MangaSource {
    Folder(PathBuf),
    Archive(PathBuf),
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bmp"
    )
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

fn path_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();

    loop {
        match (ia.peek(), ib.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(&c) = ia.peek() {
                        if c.is_ascii_digit() {
                            na.push(c);
                            ia.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(&c) = ib.peek() {
                        if c.is_ascii_digit() {
                            nb.push(c);
                            ib.next();
                        } else {
                            break;
                        }
                    }
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    let ord = ta
                        .len()
                        .cmp(&tb.len())
                        .then_with(|| ta.cmp(tb))
                        .then_with(|| na.len().cmp(&nb.len()));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                } else {
                    let la = ca.to_lowercase().next().unwrap_or(ca);
                    let lb = cb.to_lowercase().next().unwrap_or(cb);
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}

fn manga_hash(path: &Path) -> String {
    let norm = path.to_string_lossy().to_lowercase();
    format!("{:x}", md5::compute(norm.as_bytes()))
}

fn sidecar_mokuro_path(app: &AppHandle, manga_path: &Path) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("manga-mokuro");
    Some(dir.join(format!("{}.mokuro", manga_hash(manga_path))))
}

fn overrides_json_path(app: &AppHandle, manga_path: &Path) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("manga-overrides");
    Some(dir.join(format!("{}.json", manga_hash(manga_path))))
}

fn resolve_manga_source(raw_path: &Path) -> Result<(MangaSource, Option<PathBuf>), String> {
    if !raw_path.exists() {
        return Err(format!("Manga path does not exist: {}", raw_path.display()));
    }
    if raw_path.is_dir() {
        return Ok((MangaSource::Folder(raw_path.to_path_buf()), None));
    }
    let name_lower = raw_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path_ext_lower(raw_path);

    if ext == "cbz" || ext == "zip" {
        return Ok((MangaSource::Archive(raw_path.to_path_buf()), None));
    }

    if ext == "mokuro" || name_lower.ends_with(".mokuro.gz") {
        let stem = if name_lower.ends_with(".mokuro.gz") {
            let fname = raw_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            fname[..fname.len().saturating_sub(".mokuro.gz".len())].to_string()
        } else {
            raw_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        };
        if let Some(parent) = raw_path.parent() {
            let sibling_dir = parent.join(&stem);
            if sibling_dir.is_dir() {
                return Ok((MangaSource::Folder(sibling_dir), Some(raw_path.to_path_buf())));
            }
            for archive_ext in ["cbz", "zip"] {
                let sibling_archive = parent.join(format!("{stem}.{archive_ext}"));
                if sibling_archive.is_file() {
                    return Ok((
                        MangaSource::Archive(sibling_archive),
                        Some(raw_path.to_path_buf()),
                    ));
                }
            }
            // Fallback: `.mokuro` placed directly inside the image folder
            if list_folder_images(parent).map_or(false, |imgs| !imgs.is_empty()) {
                return Ok((
                    MangaSource::Folder(parent.to_path_buf()),
                    Some(raw_path.to_path_buf()),
                ));
            }
        }
        return Err(
            "Could not find matching image folder or .cbz next to this .mokuro file.".to_string(),
        );
    }

    Err(format!(
        "Unsupported manga format: {}",
        raw_path.display()
    ))
}

fn list_folder_images(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut images: Vec<PathBuf> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read folder: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') || fname.eq_ignore_ascii_case("_ocr") {
            continue;
        }
        if path.is_file() && is_image_ext(&path_ext_lower(&path)) {
            images.push(path);
        }
    }
    images.sort_by(|a, b| {
        let na = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let nb = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        natural_cmp(na, nb)
    });
    Ok(images)
}

fn list_archive_entries(archive_path: &Path) -> Result<(Vec<String>, Option<String>), String> {
    let file = File::open(archive_path).map_err(|e| format!("Failed to open archive: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("Invalid CBZ/ZIP archive: {e}"))?;
    let mut images: Vec<String> = Vec::new();
    let mut embedded_mokuro: Option<String> = None;

    for i in 0..zip.len() {
        let entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if name.starts_with("__MACOSX/")
            || name.contains("/._")
            || name.starts_with('.')
            || name.contains("/_ocr/")
        {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if embedded_mokuro.is_none()
            && (lower.ends_with(".mokuro") || lower.ends_with(".mokuro.gz"))
        {
            embedded_mokuro = Some(name);
            continue;
        }
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if is_image_ext(ext) {
            images.push(name);
        }
    }
    images.sort_by(|a, b| natural_cmp(a, b));
    Ok((images, embedded_mokuro))
}

fn convert_blocks(raw_blocks: Vec<RawMokuroBlock>) -> Vec<MokuroBlockOut> {
    raw_blocks
        .into_iter()
        .filter_map(|b| {
            let coords = b.box_coords?;
            let bw = (coords[2] - coords[0]).abs();
            let bh = (coords[3] - coords[1]).abs();
            let vertical = b.vertical.unwrap_or(bh > bw * 1.15);
            let font_size = b.font_size.unwrap_or(20.0).max(8.0);
            let lines: Vec<String> = b
                .lines
                .into_iter()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if lines.is_empty() {
                return None;
            }
            Some(MokuroBlockOut {
                box_coords: coords,
                vertical,
                font_size,
                lines,
                lines_coords: b.lines_coords,
            })
        })
        .collect()
}

fn parse_mokuro_bytes(bytes: &[u8], is_gz: bool, source_path: Option<String>) -> Option<ParsedMokuro> {
    let json_bytes: Vec<u8> = if is_gz {
        let mut decoder = GzDecoder::new(bytes);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).ok()?;
        out
    } else {
        bytes.to_vec()
    };
    let text = String::from_utf8_lossy(&json_bytes);
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    let parsed: RawMokuroFile = serde_json::from_str(trimmed).ok()?;
    let pages = parsed
        .pages
        .into_iter()
        .map(|p| ParsedMokuroPage {
            img_path: p.img_path.unwrap_or_default(),
            width: p.img_width.unwrap_or(0),
            height: p.img_height.unwrap_or(0),
            blocks: convert_blocks(p.blocks),
        })
        .collect();
    Some(ParsedMokuro {
        title: parsed.title.filter(|s| !s.trim().is_empty()),
        volume: parsed.volume.filter(|s| !s.trim().is_empty()),
        source_path,
        pages,
    })
}

fn parse_mokuro_file(path: &Path) -> Option<ParsedMokuro> {
    let bytes = fs::read(path).ok()?;
    let is_gz = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .ends_with(".gz");
    parse_mokuro_bytes(&bytes, is_gz, Some(path.to_string_lossy().to_string()))
}

fn parse_legacy_ocr_dir(ocr_dir: &Path) -> Option<ParsedMokuro> {
    if !ocr_dir.is_dir() {
        return None;
    }
    let mut json_files: Vec<PathBuf> = fs::read_dir(ocr_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && path_ext_lower(p) == "json")
        .collect();
    if json_files.is_empty() {
        return None;
    }
    json_files.sort_by(|a, b| {
        natural_cmp(
            a.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            b.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        )
    });
    let mut pages = Vec::with_capacity(json_files.len());
    for jf in json_files {
        let raw = match fs::read_to_string(&jf) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let page: RawMokuroPage = match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let stem = jf
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        pages.push(ParsedMokuroPage {
            img_path: page.img_path.unwrap_or(stem),
            width: page.img_width.unwrap_or(0),
            height: page.img_height.unwrap_or(0),
            blocks: convert_blocks(page.blocks),
        });
    }
    let has_any_blocks = pages.iter().any(|p| !p.blocks.is_empty());
    if pages.is_empty() || !has_any_blocks {
        return None;
    }
    Some(ParsedMokuro {
        title: None,
        volume: None,
        source_path: Some(ocr_dir.to_string_lossy().to_string()),
        pages,
    })
}

fn find_mokuro_for_source(
    app: &AppHandle,
    source: &MangaSource,
    explicit_mokuro: Option<&Path>,
) -> Option<ParsedMokuro> {
    if let Some(mpath) = explicit_mokuro {
        if let Some(parsed) = parse_mokuro_file(mpath) {
            return Some(parsed);
        }
    }

    match source {
        MangaSource::Folder(dir) => {
            if let (Some(parent), Some(name)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str())) {
                for ext in ["mokuro", "mokuro.gz"] {
                    let sibling = parent.join(format!("{name}.{ext}"));
                    if sibling.is_file() {
                        if let Some(p) = parse_mokuro_file(&sibling) {
                            return Some(p);
                        }
                    }
                }
                // Legacy v0.1 `_ocr/<vol_name>/*.json`
                let legacy_sibling = parent.join("_ocr").join(name);
                if let Some(p) = parse_legacy_ocr_dir(&legacy_sibling) {
                    return Some(p);
                }
            }
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let lower = p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if p.is_file() && (lower.ends_with(".mokuro") || lower.ends_with(".mokuro.gz")) {
                        if let Some(parsed) = parse_mokuro_file(&p) {
                            return Some(parsed);
                        }
                    }
                }
            }
            let legacy_inside = dir.join("_ocr");
            if let Some(p) = parse_legacy_ocr_dir(&legacy_inside) {
                return Some(p);
            }
            if let Some(sidecar) = sidecar_mokuro_path(app, dir) {
                if sidecar.is_file() {
                    if let Some(p) = parse_mokuro_file(&sidecar) {
                        return Some(p);
                    }
                }
            }
            None
        }
        MangaSource::Archive(archive_path) => {
            // 1. Embedded inside CBZ/ZIP
            if let Ok((_, Some(embedded_name))) = list_archive_entries(archive_path) {
                if let Ok(file) = File::open(archive_path) {
                    if let Ok(mut zip) = ZipArchive::new(file) {
                        if let Ok(mut entry) = zip.by_name(&embedded_name) {
                            let mut buf = Vec::new();
                            if entry.read_to_end(&mut buf).is_ok() {
                                let is_gz = embedded_name.to_ascii_lowercase().ends_with(".gz");
                                if let Some(parsed) = parse_mokuro_bytes(
                                    &buf,
                                    is_gz,
                                    Some(format!("{}::{}", archive_path.display(), embedded_name)),
                                ) {
                                    return Some(parsed);
                                }
                            }
                        }
                    }
                }
            }
            // 2. Sibling `<stem>.mokuro`
            if let (Some(parent), Some(stem)) = (
                archive_path.parent(),
                archive_path.file_stem().and_then(|s| s.to_str()),
            ) {
                for ext in ["mokuro", "mokuro.gz"] {
                    let sibling = parent.join(format!("{stem}.{ext}"));
                    if sibling.is_file() {
                        if let Some(p) = parse_mokuro_file(&sibling) {
                            return Some(p);
                        }
                    }
                }
            }
            // 3. Sidecar in app data
            if let Some(sidecar) = sidecar_mokuro_path(app, archive_path) {
                if sidecar.is_file() {
                    if let Some(p) = parse_mokuro_file(&sidecar) {
                        return Some(p);
                    }
                }
            }
            None
        }
    }
}

fn match_mokuro_page<'a>(
    mokuro: &'a ParsedMokuro,
    page_name: &str,
    page_index: usize,
    total_images: usize,
) -> Option<&'a ParsedMokuroPage> {
    let norm_target = page_name.replace('\\', "/").to_ascii_lowercase();
    let target_file = Path::new(&norm_target)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&norm_target);
    let target_stem = Path::new(target_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(target_file);

    // 1. Exact relative path or filename match
    for mp in &mokuro.pages {
        let norm_mp = mp.img_path.replace('\\', "/").to_ascii_lowercase();
        let mp_file = Path::new(&norm_mp)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&norm_mp);
        if norm_mp == norm_target || mp_file == target_file {
            return Some(mp);
        }
    }
    // 2. Stem match (e.g. converted jpg -> webp)
    for mp in &mokuro.pages {
        let norm_mp = mp.img_path.replace('\\', "/").to_ascii_lowercase();
        let mp_stem = Path::new(&norm_mp)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&norm_mp);
        if !mp_stem.is_empty() && mp_stem == target_stem {
            return Some(mp);
        }
    }
    // 3. Index fallback when page counts match
    if mokuro.pages.len() == total_images {
        return mokuro.pages.get(page_index);
    }
    None
}

fn count_blocks_chars(blocks: &[MokuroBlockOut]) -> usize {
    blocks
        .iter()
        .flat_map(|b| b.lines.iter())
        .flat_map(|l| l.chars())
        .filter(|c| !c.is_whitespace())
        .count()
}

fn infer_title_and_series(
    source: &MangaSource,
    mokuro: Option<&ParsedMokuro>,
) -> (String, Option<String>, Option<String>, Option<f64>) {
    let raw_path = match source {
        MangaSource::Folder(p) | MangaSource::Archive(p) => p,
    };
    let file_name = raw_path
        .file_stem()
        .or_else(|| raw_path.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("Manga")
        .trim()
        .to_string();

    let mokuro_title = mokuro.and_then(|m| m.title.clone());
    let mokuro_vol = mokuro.and_then(|m| m.volume.clone());

    let display_title = match (&mokuro_title, &mokuro_vol) {
        (Some(t), Some(v)) if !t.eq_ignore_ascii_case(v) && !v.contains(t.as_str()) => {
            format!("{t} — {v}")
        }
        (_, Some(v)) => v.clone(),
        (Some(t), None) => t.clone(),
        (None, None) => file_name.clone(),
    };

    let series = mokuro_title.or_else(|| {
        raw_path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("books"))
    });

    // Simple trailing volume number extraction (e.g. "Vol. 03", "v2", "第12巻", " 01")
    let vol_src = mokuro_vol.as_deref().unwrap_or(&file_name);
    let series_pos = extract_volume_number(vol_src);

    (display_title, mokuro_vol, series, series_pos)
}

fn extract_volume_number(text: &str) -> Option<f64> {
    let chars: Vec<char> = text.chars().collect();
    let mut end = chars.len();
    while end > 0 && !chars[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut start = end;
    while start > 0 && (chars[start - 1].is_ascii_digit() || chars[start - 1] == '.') {
        start -= 1;
    }
    let num_str: String = chars[start..end].iter().collect();
    let parsed = num_str.trim_matches('.').parse::<f64>().ok()?;
    if parsed > 0.0 && parsed < 5000.0 {
        Some(parsed)
    } else {
        None
    }
}

fn encode_data_uri(bytes: &[u8], ext: &str) -> String {
    let mime = mime_for_ext(ext);
    let encoded = general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{encoded}")
}

fn read_page_image_bytes(
    source: &MangaSource,
    page_index: usize,
) -> Result<(String, String, Vec<u8>), String> {
    match source {
        MangaSource::Folder(dir) => {
            let images = list_folder_images(dir)?;
            let img_path = images
                .get(page_index)
                .ok_or_else(|| format!("Page {page_index} out of range"))?;
            let meta = fs::metadata(img_path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_MANGA_IMAGE_BYTES {
                return Err("Manga page image exceeds 24 MB limit.".to_string());
            }
            let bytes = fs::read(img_path).map_err(|e| format!("Failed to read page: {e}"))?;
            let name = img_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("page.jpg")
                .to_string();
            let ext = path_ext_lower(img_path);
            Ok((name, ext, bytes))
        }
        MangaSource::Archive(archive_path) => {
            let (images, _) = list_archive_entries(archive_path)?;
            let entry_name = images
                .get(page_index)
                .ok_or_else(|| format!("Page {page_index} out of range"))?
                .clone();
            let file = File::open(archive_path).map_err(|e| e.to_string())?;
            let mut zip = ZipArchive::new(file).map_err(|e| e.to_string())?;
            let mut entry = zip.by_name(&entry_name).map_err(|e| e.to_string())?;
            if entry.size() > MAX_MANGA_IMAGE_BYTES {
                return Err("Manga page image exceeds 24 MB limit.".to_string());
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            let ext = Path::new(&entry_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_ascii_lowercase();
            Ok((entry_name, ext, bytes))
        }
    }
}

fn probe_bytes_dimensions(bytes: &[u8]) -> (u32, u32) {
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

#[tauri::command]
pub fn manga_open(app: AppHandle, path: String) -> Result<MangaMeta, String> {
    let raw = PathBuf::from(path.trim());
    let (source, explicit_mokuro) = resolve_manga_source(&raw)?;
    let mokuro = find_mokuro_for_source(&app, &source, explicit_mokuro.as_deref());

    let page_names: Vec<String> = match &source {
        MangaSource::Folder(dir) => list_folder_images(dir)?
            .into_iter()
            .map(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect(),
        MangaSource::Archive(archive) => list_archive_entries(archive)?.0,
    };

    if page_names.is_empty() {
        return Err("No manga page images found in this volume.".to_string());
    }

    let total_images = page_names.len();
    let mut pages = Vec::with_capacity(total_images);
    let mut total_chars = 0usize;

    for (idx, name) in page_names.iter().enumerate() {
        let matched = mokuro
            .as_ref()
            .and_then(|m| match_mokuro_page(m, name, idx, total_images));
        let (width, height, char_count, block_count) = if let Some(mp) = matched {
            let cc = count_blocks_chars(&mp.blocks);
            (mp.width, mp.height, cc, mp.blocks.len())
        } else {
            (0, 0, 0, 0)
        };
        total_chars = total_chars.saturating_add(char_count);
        pages.push(MangaPageInfo {
            index: idx,
            name: name.clone(),
            width,
            height,
            char_count,
            block_count,
        });
    }

    let (title, volume, series, series_position) =
        infer_title_and_series(&source, mokuro.as_ref());

    let cover = read_page_image_bytes(&source, 0)
        .ok()
        .map(|(_, ext, bytes)| encode_data_uri(&bytes, &ext));

    let source_kind = match source {
        MangaSource::Folder(_) => "folder".to_string(),
        MangaSource::Archive(_) => "cbz".to_string(),
    };

    Ok(MangaMeta {
        title,
        volume,
        series,
        series_position,
        page_count: pages.len(),
        has_mokuro: mokuro.is_some(),
        mokuro_path: mokuro.and_then(|m| m.source_path),
        source_kind,
        total_chars,
        cover,
        pages,
    })
}

#[tauri::command]
pub fn manga_cover(_app: AppHandle, path: String) -> Result<Option<String>, String> {
    let raw = PathBuf::from(path.trim());
    let (source, _) = resolve_manga_source(&raw)?;
    match read_page_image_bytes(&source, 0) {
        Ok((_, ext, bytes)) => Ok(Some(encode_data_uri(&bytes, &ext))),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn manga_page(app: AppHandle, path: String, page_index: usize) -> Result<MangaPagePayload, String> {
    let raw = PathBuf::from(path.trim());
    let (source, explicit_mokuro) = resolve_manga_source(&raw)?;
    let mokuro = find_mokuro_for_source(&app, &source, explicit_mokuro.as_deref());

    let total_images = match &source {
        MangaSource::Folder(dir) => list_folder_images(dir)?.len(),
        MangaSource::Archive(archive) => list_archive_entries(archive)?.0.len(),
    };

    let (name, ext, bytes) = read_page_image_bytes(&source, page_index)?;
    let matched = mokuro
        .as_ref()
        .and_then(|m| match_mokuro_page(m, &name, page_index, total_images));

    let (mut width, mut height, blocks) = if let Some(mp) = matched {
        (mp.width, mp.height, mp.blocks.clone())
    } else {
        (0, 0, Vec::new())
    };

    if width == 0 || height == 0 {
        let (w, h) = probe_bytes_dimensions(&bytes);
        width = w;
        height = h;
    }

    let image_src = encode_data_uri(&bytes, &ext);

    Ok(MangaPagePayload {
        index: page_index,
        name,
        image_src,
        width,
        height,
        blocks,
    })
}

/// Store a `.cbz` / `.zip` manga archive (and any sibling `.mokuro`) into app data so Android
/// temporary picker files persist. Local image folders stay in-place to avoid duplicating GBs.
#[tauri::command]
pub fn manga_store(app: AppHandle, path: String, tab_id: u64) -> Result<String, String> {
    let raw = PathBuf::from(path.trim());
    let (source, explicit_mokuro) = resolve_manga_source(&raw)?;

    match source {
        MangaSource::Folder(dir) => {
            if let Some(mpath) = explicit_mokuro {
                if let Some(sidecar) = sidecar_mokuro_path(&app, &dir) {
                    if let Some(parent) = sidecar.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::copy(&mpath, &sidecar);
                }
            }
            Ok(dir.to_string_lossy().to_string())
        }
        MangaSource::Archive(archive_path) => {
            let books_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("books");
            fs::create_dir_all(&books_dir).map_err(|e| e.to_string())?;
            let ext = path_ext_lower(&archive_path);
            let target_ext = if ext == "zip" { "zip" } else { "cbz" };
            let target = books_dir.join(format!("book_{tab_id}.{target_ext}"));
            if archive_path != target {
                fs::copy(&archive_path, &target)
                    .map_err(|e| format!("Failed to store manga archive: {e}"))?;
            }
            // Also preserve sibling `.mokuro` if present
            let sibling_mokuro = explicit_mokuro.or_else(|| {
                let parent = archive_path.parent()?;
                let stem = archive_path.file_stem()?.to_str()?;
                for mext in ["mokuro", "mokuro.gz"] {
                    let cand = parent.join(format!("{stem}.{mext}"));
                    if cand.is_file() {
                        return Some(cand);
                    }
                }
                None
            });
            if let Some(mpath) = sibling_mokuro {
                if let Some(sidecar) = sidecar_mokuro_path(&app, &target) {
                    if let Some(parent) = sidecar.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::copy(&mpath, &sidecar);
                }
            }
            Ok(target.to_string_lossy().to_string())
        }
    }
}

#[tauri::command]
pub fn manga_attach_mokuro(
    app: AppHandle,
    manga_path: String,
    mokuro_path: String,
) -> Result<MangaMeta, String> {
    let raw = PathBuf::from(manga_path.trim());
    let (source, _) = resolve_manga_source(&raw)?;
    let target_key = match &source {
        MangaSource::Folder(p) | MangaSource::Archive(p) => p.clone(),
    };
    let mpath = PathBuf::from(mokuro_path.trim());
    if parse_mokuro_file(&mpath).is_none() {
        return Err("Selected file is not a valid .mokuro JSON file.".to_string());
    }
    let sidecar = sidecar_mokuro_path(&app, &target_key)
        .ok_or_else(|| "Could not resolve app data directory.".to_string())?;
    if let Some(parent) = sidecar.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&mpath, &sidecar).map_err(|e| format!("Failed to save .mokuro overlay: {e}"))?;
    manga_open(app, target_key.to_string_lossy().to_string())
}

#[tauri::command]
pub fn manga_load_overrides(
    app: AppHandle,
    manga_path: String,
) -> Result<HashMap<usize, HashMap<usize, String>>, String> {
    let raw = PathBuf::from(manga_path.trim());
    let key = match resolve_manga_source(&raw) {
        Ok((MangaSource::Folder(p) | MangaSource::Archive(p), _)) => p,
        Err(_) => raw,
    };
    let Some(path) = overrides_json_path(&app, &key) else {
        return Ok(HashMap::new());
    };
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

#[tauri::command]
pub fn manga_save_override(
    app: AppHandle,
    manga_path: String,
    page_index: usize,
    block_index: usize,
    text: String,
) -> Result<(), String> {
    let raw = PathBuf::from(manga_path.trim());
    let key = match resolve_manga_source(&raw) {
        Ok((MangaSource::Folder(p) | MangaSource::Archive(p), _)) => p,
        Err(_) => raw,
    };
    let path = overrides_json_path(&app, &key)
        .ok_or_else(|| "Could not resolve app data directory.".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut map: HashMap<usize, HashMap<usize, String>> = if path.is_file() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        if let Some(page_map) = map.get_mut(&page_index) {
            page_map.remove(&block_index);
            if page_map.is_empty() {
                map.remove(&page_index);
            }
        }
    } else {
        map.entry(page_index)
            .or_default()
            .insert(block_index, trimmed);
    }

    let serialized = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    fs::write(&path, serialized).map_err(|e| e.to_string())?;
    Ok(())
}

/// Recursively scan a folder for manga volumes (folders with >= 2 images, or `.cbz`/`.zip` with images).
#[tauri::command]
pub fn manga_scan_folder(app: AppHandle, dir: String) -> Result<Vec<MangaFolderEntry>, String> {
    let root = PathBuf::from(dir.trim());
    if !root.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }
    let mut results: Vec<MangaFolderEntry> = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();

    fn walk(
        app: &AppHandle,
        root: &Path,
        current: &Path,
        depth: usize,
        visited: &mut HashSet<PathBuf>,
        results: &mut Vec<MangaFolderEntry>,
    ) {
        if depth > MAX_SCAN_DEPTH || results.len() >= MAX_SCAN_VOLUMES {
            return;
        }
        let canon = current.canonicalize().unwrap_or_else(|_| current.to_path_buf());
        if !visited.insert(canon) {
            return;
        }

        let mut direct_images = 0usize;
        let mut subdirs: Vec<PathBuf> = Vec::new();
        let mut archives: Vec<PathBuf> = Vec::new();

        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with('.') || fname.eq_ignore_ascii_case("_ocr") {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                subdirs.push(path);
            } else if ft.is_file() {
                let ext = path_ext_lower(&path);
                if is_image_ext(&ext) {
                    direct_images += 1;
                } else if ext == "cbz" || ext == "zip" {
                    archives.push(path);
                }
            }
        }

        // If this folder itself contains >= 2 manga images, treat it as a manga volume!
        if direct_images >= 2 {
            let src = MangaSource::Folder(current.to_path_buf());
            let has_mokuro = find_mokuro_for_source(app, &src, None).is_some();
            let subfolder_series = if current == root {
                current
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
            } else {
                current
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
            };
            results.push(MangaFolderEntry {
                path: current.to_string_lossy().to_string(),
                subfolder_series,
                has_mokuro,
                source_kind: "folder".to_string(),
            });
        }

        archives.sort_by(|a, b| {
            natural_cmp(
                a.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                b.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            )
        });
        for arc in archives {
            if results.len() >= MAX_SCAN_VOLUMES {
                break;
            }
            if let Ok((imgs, _)) = list_archive_entries(&arc) {
                if imgs.len() >= 2 {
                    let src = MangaSource::Archive(arc.clone());
                    let has_mokuro = find_mokuro_for_source(app, &src, None).is_some();
                    let subfolder_series = arc
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string());
                    results.push(MangaFolderEntry {
                        path: arc.to_string_lossy().to_string(),
                        subfolder_series,
                        has_mokuro,
                        source_kind: "cbz".to_string(),
                    });
                }
            }
        }

        subdirs.sort_by(|a, b| {
            natural_cmp(
                a.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                b.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            )
        });
        for sub in subdirs {
            walk(app, root, &sub, depth + 1, visited, results);
        }
    }

    walk(&app, &root, &root, 0, &mut visited, &mut results);
    Ok(results)
}

/// Extract a `.rar` / `.cbr` / `.7z` / `.cb7` manga archive (single volume or multi-volume pack)
/// into `app_data_dir/manga-extracted/` using the OS libarchive (`C:\Windows\System32\tar.exe` on
/// Windows 11, or `bsdtar`/`7z`/`unrar` on Unix) and scan all manga volumes inside.
#[tauri::command]
pub async fn manga_extract_archive(
    app: AppHandle,
    path: String,
) -> Result<Vec<MangaFolderEntry>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, path);
        return Err("Extracting .rar/.cbr/.7z archives is currently supported on Desktop. Convert to .cbz/.zip for Android.".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let raw = PathBuf::from(path.trim());
        if !raw.is_file() {
            return Err(format!("Archive does not exist: {}", raw.display()));
        }
        let stem = raw
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("manga")
            .chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                    '_'
                } else {
                    c
                }
            })
            .collect::<String>();
        let short_hash = &manga_hash(&raw)[..8];
        let dest = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("manga-extracted")
            .join(format!("{stem}-{short_hash}"));

        let app_clone = app.clone();
        let raw_clone = raw.clone();
        let dest_clone = dest.clone();

        tokio::task::spawn_blocking(move || -> Result<Vec<MangaFolderEntry>, String> {
            let already_has_volumes = dest_clone.is_dir()
                && manga_scan_folder(
                    app_clone.clone(),
                    dest_clone.to_string_lossy().to_string(),
                )
                .map_or(false, |v| !v.is_empty());

            if !already_has_volumes {
                fs::create_dir_all(&dest_clone).map_err(|e| e.to_string())?;
                let mut extracted = false;
                let mut last_err = String::new();

                #[cfg(target_os = "windows")]
                {
                    let win_tar = PathBuf::from(r"C:\Windows\System32\tar.exe");
                    if win_tar.is_file() {
                        let output = new_quiet_command(&win_tar.to_string_lossy())
                            .arg("-xf")
                            .arg(&raw_clone)
                            .arg("-C")
                            .arg(&dest_clone)
                            .output();
                        match output {
                            Ok(o) if o.status.success() => extracted = true,
                            Ok(o) => {
                                last_err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                            }
                            Err(e) => last_err = e.to_string(),
                        }
                    }
                }

                if !extracted {
                    for (prog, args) in [
                        (
                            "7z",
                            vec![
                                "x".to_string(),
                                "-y".to_string(),
                                format!("-o{}", dest_clone.display()),
                                raw_clone.to_string_lossy().to_string(),
                            ],
                        ),
                        (
                            "bsdtar",
                            vec![
                                "-xf".to_string(),
                                raw_clone.to_string_lossy().to_string(),
                                "-C".to_string(),
                                dest_clone.to_string_lossy().to_string(),
                            ],
                        ),
                    ] {
                        if let Ok(o) = new_quiet_command(prog).args(&args).output() {
                            if o.status.success() {
                                extracted = true;
                                break;
                            } else {
                                last_err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                            }
                        }
                    }
                }

                if !extracted {
                    let _ = fs::remove_dir_all(&dest_clone);
                    return Err(if last_err.is_empty() {
                        "Could not extract RAR/7Z archive (install 7-Zip or use Windows 11 tar).".to_string()
                    } else {
                        format!("Failed to extract archive: {last_err}")
                    });
                }
            }

            let volumes = manga_scan_folder(app_clone, dest_clone.to_string_lossy().to_string())?;
            if volumes.is_empty() {
                return Err("No manga volumes found inside this archive.".to_string());
            }
            Ok(volumes)
        })
        .await
        .map_err(|e| format!("Archive extract worker failed: {e}"))?
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn new_quiet_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn detect_mokuro_runner() -> Option<(String, Vec<String>, Option<String>)> {
    // Fast metadata-only probe (~30ms, never loads PyTorch/CUDA DLLs just to check presence!)
    const PROBE_SCRIPT: &str = "import importlib.metadata as m; print(m.version('mokuro'))";

    let python_candidates: &[(&str, &[&str])] = &[
        ("py", &["-3.12"]),
        ("py", &["-3.11"]),
        ("py", &["-3.10"]),
        ("python", &[]),
        ("python3", &[]),
        ("py", &[]),
    ];

    for (prog, py_args) in python_candidates {
        let mut cmd = new_quiet_command(prog);
        cmd.args(*py_args).arg("-c").arg(PROBE_SCRIPT);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let mut run_args: Vec<String> = py_args.iter().map(|s| (*s).to_string()).collect();
                run_args.push("-m".to_string());
                run_args.push("mokuro".to_string());
                return Some((
                    (*prog).to_string(),
                    run_args,
                    if ver.is_empty() { None } else { Some(ver) },
                ));
            }
        }
    }

    // Fallback: standalone `mokuro` executable on PATH (e.g. pipx / uv tool)
    let mut cmd = new_quiet_command("mokuro");
    cmd.arg("--version");
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Some((
                "mokuro".to_string(),
                Vec::new(),
                if ver.is_empty() { None } else { Some(ver) },
            ));
        }
    }
    None
}

#[tauri::command]
pub async fn manga_mokuro_status() -> MangaMokuroStatus {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(Some((prog, prefix, version))) =
            tokio::task::spawn_blocking(detect_mokuro_runner).await
        {
            let cmd_label = if prefix.is_empty() {
                prog
            } else {
                format!("{prog} {}", prefix.join(" "))
            };
            return MangaMokuroStatus {
                available: true,
                command: Some(cmd_label),
                version,
            };
        }
    }
    MangaMokuroStatus {
        available: false,
        command: None,
        version: None,
    }
}

#[tauri::command]
pub async fn manga_run_mokuro(app: AppHandle, path: String) -> Result<MangaMeta, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, path);
        return Err("Running mokuro CLI is only supported on Desktop. Generate .mokuro on PC and import the .cbz + .mokuro bundle on Android.".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use std::process::Stdio;

        fn emit_parsed_mokuro_line(app: &AppHandle, path: &str, raw: &str) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return;
            }
            let lower = trimmed.to_ascii_lowercase();
            let device = if lower.contains("using device cuda") || lower.contains("using cuda") {
                Some("cuda")
            } else if lower.contains("using device cpu") || lower.contains("using cpu") {
                Some("cpu")
            } else {
                None
            };

            let mut stage = "running";
            let mut current: Option<u32> = None;
            let mut total: Option<u32> = None;
            let mut percent: Option<u8> = None;
            let mut eta: Option<String> = None;

            if lower.contains("initializing text detector") {
                stage = "detector_init";
            } else if lower.contains("loading ocr model") || lower.contains("loading weights") {
                stage = "model_load";
            } else if lower.contains("downloading") {
                stage = "downloading";
            } else if lower.contains("processing pages") {
                stage = "ocr";
                // Parse tqdm format: `Processing pages...:  45%|████| 89/198 [00:12<00:14, 7.2it/s]`
                if let Some(bar_end) = trimmed.rfind('|') {
                    let after_bar = trimmed[bar_end + 1..].trim();
                    if let Some(frac_token) = after_bar.split_whitespace().next() {
                        if let Some((c_str, t_str)) = frac_token.split_once('/') {
                            if let (Ok(c), Ok(t)) = (c_str.parse::<u32>(), t_str.parse::<u32>()) {
                                current = Some(c);
                                total = Some(t);
                                if t > 0 {
                                    percent = Some(((c as f64 / t as f64) * 100.0).round().clamp(0.0, 100.0) as u8);
                                }
                            }
                        }
                    }
                    if let (Some(lt), Some(comma)) = (after_bar.find('<'), after_bar.find(',')) {
                        if comma > lt + 1 {
                            let candidate = after_bar[lt + 1..comma].trim();
                            if !candidate.is_empty() && candidate != "?" {
                                eta = Some(candidate.to_string());
                            }
                        }
                    }
                }
            } else if lower.contains("processed successfully") {
                stage = "done";
                percent = Some(100);
            }

            let _ = app.emit(
                "manga_mokuro_progress",
                serde_json::json!({
                    "path": path,
                    "status": "running",
                    "stage": stage,
                    "device": device,
                    "current": current,
                    "total": total,
                    "percent": percent,
                    "eta": eta,
                    "line": trimmed,
                }),
            );
        }

        fn read_cr_lf_stream<R: Read>(mut reader: R, app: &AppHandle, path: &str) -> String {
            let mut buf = [0u8; 1024];
            let mut line_bytes: Vec<u8> = Vec::with_capacity(256);
            let mut tail = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                for &b in &buf[..n] {
                    if b == b'\r' || b == b'\n' {
                        if !line_bytes.is_empty() {
                            let s = String::from_utf8_lossy(&line_bytes).trim().to_string();
                            line_bytes.clear();
                            if !s.is_empty() {
                                tail = s.clone();
                                emit_parsed_mokuro_line(app, path, &s);
                            }
                        }
                    } else if line_bytes.len() < 4096 {
                        line_bytes.push(b);
                    }
                }
            }
            if !line_bytes.is_empty() {
                let s = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if !s.is_empty() {
                    tail = s.clone();
                    emit_parsed_mokuro_line(app, path, &s);
                }
            }
            tail
        }

        let raw = PathBuf::from(path.trim());
        let (source, _) = resolve_manga_source(&raw)?;
        let (prog, prefix, _) = detect_mokuro_runner().ok_or_else(|| {
            "mokuro CLI is not installed. Run `pip install mokuro` (or `uv tool install mokuro`) and try again.".to_string()
        })?;

        let app_clone = app.clone();
        let original_path_str = path.clone();

        tokio::task::spawn_blocking(move || -> Result<MangaMeta, String> {
            let mut temp_dir_to_clean: Option<PathBuf> = None;
            let (work_dir, target_archive_key) = match &source {
                MangaSource::Folder(dir) => (dir.clone(), None),
                MangaSource::Archive(archive_path) => {
                    let tmp_root = std::env::temp_dir().join(format!(
                        "setsuna-mokuro-{}",
                        manga_hash(archive_path)
                    ));
                    let _ = fs::remove_dir_all(&tmp_root);
                    let vol_dir = tmp_root.join(
                        archive_path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("volume"),
                    );
                    fs::create_dir_all(&vol_dir).map_err(|e| e.to_string())?;
                    let file = File::open(archive_path).map_err(|e| e.to_string())?;
                    let mut zip = ZipArchive::new(file).map_err(|e| e.to_string())?;
                    for i in 0..zip.len() {
                        let mut entry = match zip.by_index(i) {
                            Ok(e) => e,
                            Err(_) => continue,
                        };
                        if entry.is_dir() {
                            continue;
                        }
                        let ename = entry.name().to_string();
                        let ext = Path::new(&ename)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("");
                        if !is_image_ext(ext) {
                            continue;
                        }
                        let flat_name = Path::new(&ename)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("page.jpg");
                        let dest = vol_dir.join(flat_name);
                        let mut out = File::create(&dest).map_err(|e| e.to_string())?;
                        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                    }
                    temp_dir_to_clean = Some(tmp_root);
                    (vol_dir, Some(archive_path.clone()))
                }
            };

            let _ = app_clone.emit(
                "manga_mokuro_progress",
                serde_json::json!({
                    "path": original_path_str,
                    "status": "running",
                    "stage": "starting",
                    "line": "Starting mokuro OCR...",
                }),
            );

            let mut cmd = new_quiet_command(&prog);
            cmd.args(&prefix)
                .arg(&work_dir)
                .arg("--disable_confirmation")
                .env("PYTHONUNBUFFERED", "1")
                .env("PYTHONIOENCODING", "utf-8")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to start mokuro: {e}"))?;

            let stderr = child.stderr.take();
            let app_err = app_clone.clone();
            let path_err = original_path_str.clone();
            let stderr_thread = std::thread::spawn(move || {
                if let Some(stream) = stderr {
                    read_cr_lf_stream(stream, &app_err, &path_err)
                } else {
                    String::new()
                }
            });

            if let Some(stdout) = child.stdout.take() {
                let _ = read_cr_lf_stream(stdout, &app_clone, &original_path_str);
            }

            let status = child
                .wait()
                .map_err(|e| format!("Failed waiting for mokuro: {e}"))?;
            let err_tail = stderr_thread.join().unwrap_or_default();

            if !status.success() {
                if let Some(tmp) = temp_dir_to_clean {
                    let _ = fs::remove_dir_all(tmp);
                }
                return Err(if err_tail.is_empty() {
                    format!("mokuro exited with status {status}")
                } else {
                    format!("mokuro failed: {err_tail}")
                });
            }

            // If we ran mokuro on an extracted archive, copy generated `.mokuro` into Setsuna's sidecar store
            if let Some(arc_key) = target_archive_key {
                if let (Some(parent), Some(vol_name)) = (
                    work_dir.parent(),
                    work_dir.file_name().and_then(|n| n.to_str()),
                ) {
                    let generated = parent.join(format!("{vol_name}.mokuro"));
                    if generated.is_file() {
                        if let Some(sidecar) = sidecar_mokuro_path(&app_clone, &arc_key) {
                            if let Some(sp) = sidecar.parent() {
                                let _ = fs::create_dir_all(sp);
                            }
                            let _ = fs::copy(&generated, &sidecar);
                        }
                    }
                }
            }

            if let Some(tmp) = temp_dir_to_clean {
                let _ = fs::remove_dir_all(tmp);
            }

            let meta = manga_open(app_clone.clone(), original_path_str.clone())?;
            let _ = app_clone.emit(
                "manga_mokuro_progress",
                serde_json::json!({
                    "path": original_path_str,
                    "status": "done",
                    "line": "OCR complete!",
                }),
            );
            Ok(meta)
        })
        .await
        .map_err(|e| format!("mokuro worker failed: {e}"))?
    }
}
