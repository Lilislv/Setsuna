use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::epub_import::{epub_chapter_impl, epub_open_impl};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedCue {
    pub index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    pub chapter_index: Option<usize>,
    pub paragraph_index: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedParagraph {
    pub chapter_index: usize,
    pub paragraph_index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChapterMarker {
    pub title: String,
    pub start_sec: f64,
    pub chapter_index: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubAudioAlignment {
    pub matched_chars: usize,
    pub total_chars: usize,
    pub match_pct: f64,
    pub matched_cues: usize,
    pub total_cues: usize,
    pub cues: Vec<AlignedCue>,
    pub paragraphs: Vec<AlignedParagraph>,
    pub chapters: Vec<AudioChapterMarker>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileLinkInfo {
    pub audio_path: String,
    pub companion_srt: Option<String>,
    pub companion_cue: Option<String>,
}

#[derive(Debug, Clone)]
struct RawCue {
    start_sec: f64,
    end_sec: f64,
    text: String,
    norm_chars: Vec<char>,
}

fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{FEFF}')
        .to_string()
}

fn normalize_char(c: char) -> Option<char> {
    // Full-width ASCII variants (！..～) -> half-width ASCII
    let mapped = match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32((c as u32) - 0xFEE0).unwrap_or(c),
        '\u{3000}' => ' ',
        // Unify katakana middle dot / dashes / prolonged sound marks? Keep ー because it's meaningful in JP.
        _ => c,
    };
    let lower = mapped.to_ascii_lowercase();
    if lower.is_whitespace() {
        return None;
    }
    if matches!(
        lower,
        '「' | '」' | '『' | '』' | '（' | '）' | '(' | ')' | '【' | '】' | '[' | ']'
            | '〈' | '〉' | '《' | '》' | '、' | '。' | '.' | ',' | '!' | '?' | '！' | '？'
            | '・' | '…' | '―' | '─' | '‐' | '-' | '\'' | '"' | '‘' | '’' | '“' | '”'
            | ':' | ';' | '：' | '；' | '　' | '~' | '～' | '〜' | '/' | '\\' | '／' | '*' | '＊'
            | '☆' | '★' | '♪' | '♡' | '♥' | '◆' | '◇' | '■' | '□' | '●' | '○' | '※'
    ) {
        return None;
    }
    Some(lower)
}

fn normalize_chars(text: &str) -> Vec<char> {
    text.chars().filter_map(normalize_char).collect()
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    let mut in_ass = false;
    for ch in input.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if in_tag {
            if ch == '>' {
                in_tag = false;
            }
            continue;
        }
        if ch == '{' {
            in_ass = true;
            continue;
        }
        if in_ass {
            if ch == '}' {
                in_ass = false;
            }
            continue;
        }
        out.push(ch);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_srt_timestamp(raw: &str) -> Option<f64> {
    let clean = raw.trim().replace(',', ".");
    let parts: Vec<&str> = clean.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let nums: Option<Vec<f64>> = parts.iter().map(|p| p.parse::<f64>().ok()).collect();
    let nums = nums?;
    if nums.iter().any(|n| !n.is_finite() || *n < 0.0) {
        return None;
    }
    if nums.len() == 3 {
        Some(nums[0] * 3600.0 + nums[1] * 60.0 + nums[2])
    } else {
        Some(nums[0] * 60.0 + nums[1])
    }
}

fn parse_srt_or_vtt(raw: &str) -> Vec<RawCue> {
    let normalized = raw
        .trim_start_matches('\u{FEFF}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut cues = Vec::new();
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let first_upper = lines[0].to_ascii_uppercase();
        if first_upper.starts_with("WEBVTT")
            || first_upper.starts_with("NOTE")
            || first_upper.starts_with("STYLE")
            || first_upper.starts_with("REGION")
        {
            continue;
        }
        let Some(arrow_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let timing_line = lines[arrow_idx];
        let Some((start_raw, rest)) = timing_line.split_once("-->") else {
            continue;
        };
        let end_raw = rest.trim().split_whitespace().next().unwrap_or("");
        let (Some(start_sec), Some(end_sec)) =
            (parse_srt_timestamp(start_raw), parse_srt_timestamp(end_raw))
        else {
            continue;
        };
        if end_sec < start_sec {
            continue;
        }
        let body = strip_html_tags(&lines[arrow_idx + 1..].join(" "));
        if body.is_empty() {
            continue;
        }
        let norm_chars = normalize_chars(&body);
        cues.push(RawCue {
            start_sec,
            end_sec,
            text: body,
            norm_chars,
        });
    }
    cues.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.end_sec
                    .partial_cmp(&b.end_sec)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    cues
}

pub fn parse_cue_sheet(raw: &str) -> Vec<(String, f64)> {
    let mut tracks: Vec<(String, f64)> = Vec::new();
    let mut in_track = false;
    let mut current_title: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        let upper = trimmed.to_ascii_uppercase();
        if upper.starts_with("TRACK ") {
            in_track = true;
            current_title = None;
            continue;
        }
        if !in_track {
            continue;
        }
        if upper.starts_with("TITLE ") {
            let val = trimmed[6..].trim().trim_matches('"').trim().to_string();
            if !val.is_empty() {
                current_title = Some(val);
            }
        } else if upper.starts_with("INDEX 01 ") {
            let ts = trimmed[9..].trim();
            let parts: Vec<&str> = ts.split(':').collect();
            if parts.len() == 3 {
                if let (Ok(mm), Ok(ss), Ok(ff)) = (
                    parts[0].parse::<f64>(),
                    parts[1].parse::<f64>(),
                    parts[2].parse::<f64>(),
                ) {
                    let secs = mm * 60.0 + ss + ff / 75.0;
                    let title = current_title
                        .take()
                        .unwrap_or_else(|| format!("Track {}", tracks.len() + 1));
                    tracks.push((title, secs));
                }
            }
        }
    }
    tracks
}

/// Greedy local edit-tolerant matcher: aligns `cue` against `book[start..]`.
/// Returns `(matched_count, end_pos_in_book)`.
fn match_cue_at(cue: &[char], book: &[char], start: usize) -> (usize, usize) {
    let mut ci = 0usize;
    let mut bi = start;
    let mut matched = 0usize;
    let max_bi = (start + cue.len() * 2 + 12).min(book.len());
    let mut consecutive_misses = 0usize;

    while ci < cue.len() && bi < max_bi {
        if cue[ci] == book[bi] {
            matched += 1;
            ci += 1;
            bi += 1;
            consecutive_misses = 0;
            continue;
        }

        // Small local lookahead for kanji/okurigana/ruby/Whisper variance
        let mut found = None;
        let max_skip = 6usize;
        'search: for dist in 1..=max_skip {
            // Skip in book (book has extra chars/ruby/title not read)
            if bi + dist < max_bi && cue[ci] == book[bi + dist] {
                found = Some((0, dist));
                break 'search;
            }
            // Skip in cue (narrator added filler or Whisper split word)
            if ci + dist < cue.len() && cue[ci + dist] == book[bi] {
                found = Some((dist, 0));
                break 'search;
            }
            // Substitution (1-for-1, 2-for-2, etc.)
            if ci + dist < cue.len() && bi + dist < max_bi && cue[ci + dist] == book[bi + dist] {
                found = Some((dist, dist));
                break 'search;
            }
        }

        if let Some((dc, db)) = found {
            ci += dc;
            bi += db;
            consecutive_misses = 0;
        } else {
            ci += 1;
            bi += 1;
            consecutive_misses += 1;
            if consecutive_misses >= 6 && matched == 0 {
                break;
            }
        }
    }

    (matched, bi)
}

pub fn align_epub_with_subtitles(
    book_path: &str,
    srt_text: &str,
    cue_text: Option<&str>,
) -> Result<EpubAudioAlignment, String> {
    let meta = epub_open_impl(book_path.to_string())?;
    let cues = parse_srt_or_vtt(srt_text);
    if cues.is_empty() {
        return Err("No valid subtitle cues found in the subtitle file.".to_string());
    }

    // Flatten entire book text into normalized char stream with (chapter_index, paragraph_index) back-pointers
    let mut book_chars: Vec<char> = Vec::with_capacity(meta.total_chars.max(4096));
    let mut book_loc: Vec<(usize, usize)> = Vec::with_capacity(meta.total_chars.max(4096));
    let mut chapter_first_char: HashMap<usize, usize> = HashMap::new();
    let mut chapter_para_counts: HashMap<usize, usize> = HashMap::new();

    for ch in &meta.chapters {
        let Ok(content) = epub_chapter_impl(book_path.to_string(), ch.index) else {
            continue;
        };
        chapter_first_char.entry(ch.index).or_insert(book_chars.len());
        chapter_para_counts.insert(ch.index, content.paragraphs.len());
        for para in &content.paragraphs {
            if para.kind == "image" || para.kind == "separator" {
                continue;
            }
            let norm = normalize_chars(&para.text);
            if norm.is_empty() {
                continue;
            }
            for c in norm {
                book_chars.push(c);
                book_loc.push((ch.index, para.index));
            }
        }
    }

    let total_chars = book_chars.len();
    if total_chars == 0 {
        return Err("Book contains no alignable text.".to_string());
    }

    // Build fast trigram & bigram index over book_chars
    let mut trigram_index: HashMap<[char; 3], Vec<usize>> = HashMap::with_capacity(total_chars / 2);
    if total_chars >= 3 {
        for i in 0..=(total_chars - 3) {
            let key = [book_chars[i], book_chars[i + 1], book_chars[i + 2]];
            trigram_index.entry(key).or_default().push(i);
        }
    }
    let mut bigram_index: HashMap<[char; 2], Vec<usize>> = HashMap::with_capacity(total_chars / 2);
    if total_chars >= 2 {
        for i in 0..=(total_chars - 2) {
            let key = [book_chars[i], book_chars[i + 1]];
            bigram_index.entry(key).or_default().push(i);
        }
    }

    let mut covered = vec![false; total_chars];
    let mut book_pos: usize = 0;
    let mut misses_in_a_row: usize = 0;
    let mut matched_cues: usize = 0;
    let mut aligned_cues: Vec<AlignedCue> = Vec::with_capacity(cues.len());
    // (chapter_index, paragraph_index) -> (min_start_sec, max_end_sec)
    let mut para_times: HashMap<(usize, usize), (f64, f64)> = HashMap::new();
    let mut candidate_set: HashSet<usize> = HashSet::with_capacity(64);

    for (idx, cue) in cues.iter().enumerate() {
        let nc = &cue.norm_chars;
        if nc.is_empty() {
            aligned_cues.push(AlignedCue {
                index: idx,
                start_sec: cue.start_sec,
                end_sec: cue.end_sec,
                text: cue.text.clone(),
                chapter_index: None,
                paragraph_index: None,
            });
            continue;
        }

        let back_slack = 24usize;
        let forward_window = if misses_in_a_row >= 6 {
            16000usize
        } else if misses_in_a_row >= 3 {
            4500usize
        } else {
            650usize
        };
        let win_start = book_pos.saturating_sub(back_slack);
        let win_end = (book_pos + forward_window).min(total_chars);

        candidate_set.clear();
        candidate_set.insert(book_pos.min(total_chars.saturating_sub(1)));
        if book_pos + 1 < win_end {
            candidate_set.insert(book_pos + 1);
        }

        // Gather anchor candidates from trigrams (or bigrams for short cues)
        if nc.len() >= 3 {
            let sample_offsets: Vec<usize> = if nc.len() <= 9 {
                (0..=(nc.len() - 3)).collect()
            } else {
                vec![
                    0,
                    2,
                    nc.len() / 4,
                    nc.len() / 2,
                    (nc.len() * 3) / 4,
                    nc.len() - 3,
                ]
            };
            for off in sample_offsets {
                if off + 3 > nc.len() {
                    continue;
                }
                let key = [nc[off], nc[off + 1], nc[off + 2]];
                if let Some(positions) = trigram_index.get(&key) {
                    let lo = positions.partition_point(|&p| p < win_start);
                    for &p in &positions[lo..] {
                        if p >= win_end {
                            break;
                        }
                        let est = p.saturating_sub(off);
                        if est >= win_start && est < win_end {
                            candidate_set.insert(est);
                        }
                    }
                }
            }
        } else if nc.len() == 2 {
            let key = [nc[0], nc[1]];
            if let Some(positions) = bigram_index.get(&key) {
                let lo = positions.partition_point(|&p| p < win_start);
                for &p in &positions[lo..] {
                    if p >= win_end {
                        break;
                    }
                    candidate_set.insert(p);
                }
            }
        }

        // Evaluate candidates, favoring high match ratio and proximity to `book_pos`
        let mut best: Option<(f64, usize, usize, usize)> = None; // (score, matched, start, end)
        for &cand in &candidate_set {
            let (m, end_pos) = match_cue_at(nc, &book_chars, cand);
            if m == 0 {
                continue;
            }
            let ratio = m as f64 / nc.len() as f64;
            let jump = cand.saturating_sub(book_pos);

            // Guard against spurious long jumps on short phrases
            let min_ratio = if jump > 1200 {
                if nc.len() < 6 {
                    continue;
                }
                0.78
            } else if jump > 220 {
                if nc.len() < 4 {
                    continue;
                }
                0.68
            } else if nc.len() <= 2 {
                1.0
            } else {
                0.52
            };

            if ratio < min_ratio {
                continue;
            }

            // Combined score: reward match ratio & matched chars, penalize large jumps
            let jump_penalty = (jump as f64) * 0.0012;
            let score = ratio * 100.0 + (m as f64).min(30.0) * 0.4 - jump_penalty;
            if best.map_or(true, |(bs, _, _, _)| score > bs) {
                best = Some((score, m, cand, end_pos));
            }
        }

        if let Some((_score, _m, start_p, end_p)) = best {
            let clamped_end = end_p.min(total_chars).max(start_p + 1);
            for pos in start_p..clamped_end {
                covered[pos] = true;
                let loc = book_loc[pos];
                para_times
                    .entry(loc)
                    .and_modify(|(s, e)| {
                        if cue.start_sec < *s {
                            *s = cue.start_sec;
                        }
                        if cue.end_sec > *e {
                            *e = cue.end_sec;
                        }
                    })
                    .or_insert((cue.start_sec, cue.end_sec));
            }
            let primary_loc = book_loc[start_p];
            if clamped_end > book_pos {
                book_pos = clamped_end;
            }
            misses_in_a_row = 0;
            matched_cues += 1;
            aligned_cues.push(AlignedCue {
                index: idx,
                start_sec: cue.start_sec,
                end_sec: cue.end_sec,
                text: cue.text.clone(),
                chapter_index: Some(primary_loc.0),
                paragraph_index: Some(primary_loc.1),
            });
        } else {
            misses_in_a_row += 1;
            aligned_cues.push(AlignedCue {
                index: idx,
                start_sec: cue.start_sec,
                end_sec: cue.end_sec,
                text: cue.text.clone(),
                chapter_index: None,
                paragraph_index: None,
            });
        }
    }

    // Interpolate short un-hit paragraphs sitting between two aligned neighbors in the same chapter
    let mut paragraphs: Vec<AlignedParagraph> = para_times
        .iter()
        .map(|(&(ch, p), &(s, e))| AlignedParagraph {
            chapter_index: ch,
            paragraph_index: p,
            start_sec: s,
            end_sec: e,
        })
        .collect();
    paragraphs.sort_by_key(|p| (p.chapter_index, p.paragraph_index));

    let mut interpolated: Vec<AlignedParagraph> = Vec::new();
    for pair in paragraphs.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        if a.chapter_index == b.chapter_index
            && b.paragraph_index > a.paragraph_index + 1
            && b.paragraph_index - a.paragraph_index <= 4
            && b.start_sec >= a.end_sec
            && b.start_sec - a.end_sec <= 25.0
        {
            let gap = (b.paragraph_index - a.paragraph_index) as f64;
            for step in 1..(b.paragraph_index - a.paragraph_index) {
                let frac0 = (step as f64 - 0.5) / gap;
                let frac1 = (step as f64 + 0.5) / gap;
                let span = (b.start_sec - a.end_sec).max(0.5);
                interpolated.push(AlignedParagraph {
                    chapter_index: a.chapter_index,
                    paragraph_index: a.paragraph_index + step,
                    start_sec: a.end_sec + span * frac0.clamp(0.0, 1.0),
                    end_sec: a.end_sec + span * frac1.clamp(0.0, 1.0),
                });
            }
        }
    }
    paragraphs.extend(interpolated);
    paragraphs.sort_by_key(|p| (p.chapter_index, p.paragraph_index));

    // Compute per-chapter earliest aligned start time
    let mut chapter_start_sec: HashMap<usize, f64> = HashMap::new();
    for p in &paragraphs {
        chapter_start_sec
            .entry(p.chapter_index)
            .and_modify(|s| {
                if p.start_sec < *s {
                    *s = p.start_sec;
                }
            })
            .or_insert(p.start_sec);
    }

    // Build chapter markers (prefer CUE sheet if present & non-empty, linked to nearest aligned chapter)
    let mut chapters: Vec<AudioChapterMarker> = Vec::new();
    if let Some(cue_raw) = cue_text {
        let cue_tracks = parse_cue_sheet(cue_raw);
        for (title, secs) in cue_tracks {
            // Find the aligned cue closest to this CUE track start time to resolve chapter_index
            let nearest_ch = aligned_cues
                .iter()
                .find(|c| c.chapter_index.is_some() && c.start_sec + 1.0 >= secs)
                .and_then(|c| c.chapter_index);
            chapters.push(AudioChapterMarker {
                title,
                start_sec: secs,
                chapter_index: nearest_ch,
            });
        }
    }
    if chapters.is_empty() {
        if !meta.toc.is_empty() {
            for toc in &meta.toc {
                if let Some(&secs) = chapter_start_sec.get(&toc.chapter_index) {
                    chapters.push(AudioChapterMarker {
                        title: toc.title.clone(),
                        start_sec: secs,
                        chapter_index: Some(toc.chapter_index),
                    });
                }
            }
        } else {
            for ch in &meta.chapters {
                if let Some(&secs) = chapter_start_sec.get(&ch.index) {
                    chapters.push(AudioChapterMarker {
                        title: ch
                            .title
                            .clone()
                            .unwrap_or_else(|| format!("Chapter {}", ch.index + 1)),
                        start_sec: secs,
                        chapter_index: Some(ch.index),
                    });
                }
            }
        }
    }

    let matched_chars = covered.iter().filter(|&&b| b).count();
    let match_pct = if total_chars > 0 {
        ((matched_chars as f64 / total_chars as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    Ok(EpubAudioAlignment {
        matched_chars,
        total_chars,
        match_pct,
        matched_cues,
        total_cues: cues.len(),
        cues: aligned_cues,
        paragraphs,
        chapters,
    })
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("epub-audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create epub-audio dir: {}", e))?;
    Ok(dir)
}

fn cache_file_for_key(app: &tauri::AppHandle, book_key: &str) -> Result<PathBuf, String> {
    // Stable FNV-1a 64-bit hash so arbitrary Unicode book titles map to safe filenames
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in book_key.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(cache_dir(app)?.join(format!("align_{:016x}.json", hash)))
}

fn find_companions_in_dir(dir: &Path) -> (Option<String>, Option<String>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return (None, None);
    };
    let mut srt: Option<String> = None;
    let mut cue: Option<String> = None;
    let mut entries: Vec<PathBuf> = read_dir.filter_map(|e| e.ok().map(|x| x.path())).collect();
    entries.sort();
    for p in entries {
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if srt.is_none() && (ext == "srt" || ext == "vtt") {
            srt = Some(p.to_string_lossy().to_string());
        } else if cue.is_none() && ext == "cue" {
            cue = Some(p.to_string_lossy().to_string());
        }
    }
    (srt, cue)
}

#[tauri::command]
pub fn epub_audio_allow_file(app: tauri::AppHandle, path: String) -> Result<AudioFileLinkInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("Audiobook file not found on disk.".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&p)
        .map_err(|e| format!("Failed to grant media read permission: {}", e))?;
    let (companion_srt, companion_cue) = p
        .parent()
        .map(find_companions_in_dir)
        .unwrap_or((None, None));
    Ok(AudioFileLinkInfo {
        audio_path: path,
        companion_srt,
        companion_cue,
    })
}

#[tauri::command]
pub async fn epub_audio_align(
    app: tauri::AppHandle,
    book_path: String,
    srt_path: String,
    cue_path: Option<String>,
    book_key: String,
) -> Result<EpubAudioAlignment, String> {
    let cache_path = cache_file_for_key(&app, &book_key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let srt_bytes = std::fs::read(&srt_path)
            .map_err(|e| format!("Failed to read subtitle file: {}", e))?;
        let srt_text = decode_text_bytes(&srt_bytes);
        let cue_text = match cue_path {
            Some(cp) if !cp.trim().is_empty() => std::fs::read(&cp)
                .ok()
                .map(|b| decode_text_bytes(&b)),
            _ => None,
        };
        let alignment = align_epub_with_subtitles(&book_path, &srt_text, cue_text.as_deref())?;
        if let Ok(json) = serde_json::to_string(&alignment) {
            let _ = std::fs::write(&cache_path, json);
        }
        Ok(alignment)
    })
    .await
    .map_err(|e| format!("Audiobook alignment task failed: {}", e))?
}

#[tauri::command]
pub async fn epub_audio_align_text(
    app: tauri::AppHandle,
    book_path: String,
    srt_text: String,
    cue_text: Option<String>,
    book_key: String,
) -> Result<EpubAudioAlignment, String> {
    let cache_path = cache_file_for_key(&app, &book_key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let alignment = align_epub_with_subtitles(&book_path, &srt_text, cue_text.as_deref())?;
        if let Ok(json) = serde_json::to_string(&alignment) {
            let _ = std::fs::write(&cache_path, json);
        }
        Ok(alignment)
    })
    .await
    .map_err(|e| format!("Audiobook alignment task failed: {}", e))?
}

#[tauri::command]
pub async fn epub_audio_load_alignment(
    app: tauri::AppHandle,
    book_key: String,
) -> Result<Option<EpubAudioAlignment>, String> {
    let cache_path = cache_file_for_key(&app, &book_key)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !cache_path.is_file() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&cache_path)
            .map_err(|e| format!("Failed to read cached alignment: {}", e))?;
        let parsed: EpubAudioAlignment = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid cached alignment: {}", e))?;
        Ok(Some(parsed))
    })
    .await
    .map_err(|e| format!("Failed to load cached alignment: {}", e))?
}

#[tauri::command]
pub async fn epub_audio_clear_alignment(
    app: tauri::AppHandle,
    book_key: String,
) -> Result<(), String> {
    let cache_path = cache_file_for_key(&app, &book_key)?;
    if cache_path.is_file() {
        let _ = std::fs::remove_file(&cache_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cue_sheet_with_minutes_over_60() {
        let cue = r#"
FILE "book.m4b" MP3
TRACK 1 AUDIO
  TITLE "Intro"
  INDEX 01 0:00:00
TRACK 2 AUDIO
  TITLE "Chapter 2"
  INDEX 01 111:37:66
"#;
        let tracks = parse_cue_sheet(cue);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].0, "Intro");
        assert!((tracks[0].1 - 0.0).abs() < 0.01);
        assert_eq!(tracks[1].0, "Chapter 2");
        assert!((tracks[1].1 - (111.0 * 60.0 + 37.0 + 66.0 / 75.0)).abs() < 0.01);
    }

    #[test]
    #[ignore]
    fn benchmark_slayers_vol1_alignment() {
        let dir = Path::new(r"C:\Users\Serichka\Desktop\[1巻] スレイヤーズ1 [B079JNHX8F]");
        let epub = dir.join("1.epub");
        let srt = dir.join("Slayers01.srt");
        let cue = dir.join("[1巻] スレイヤーズ1 [B079JNHX8F].cue");
        if !epub.is_file() || !srt.is_file() {
            return;
        }
        let srt_text = decode_text_bytes(&std::fs::read(&srt).unwrap());
        let cue_text = std::fs::read(&cue).ok().map(|b| decode_text_bytes(&b));
        let t0 = std::time::Instant::now();
        let res = align_epub_with_subtitles(
            epub.to_str().unwrap(),
            &srt_text,
            cue_text.as_deref(),
        )
        .unwrap();
        let elapsed = t0.elapsed();
        println!(
            "Slayers Vol. 1 alignment: {}/{} chars ({:.1}%), {}/{} cues, {} paragraphs, {} chapters in {:?}",
            res.matched_chars,
            res.total_chars,
            res.match_pct,
            res.matched_cues,
            res.total_cues,
            res.paragraphs.len(),
            res.chapters.len(),
            elapsed,
        );
        assert!(res.match_pct >= 90.0, "Expected >=90% match, got {}%", res.match_pct);
    }
}
