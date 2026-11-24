use super::*;

/// Parses a plain text file with automatic encoding detection (UTF-8, Shift-JIS, EUC-JP,
/// Windows-1251, UTF-16) and Aozora Bunko markup support (`｜漢字《かんじ》`, `漢字《かんじ》`,
/// bouten `［＃「...」に傍点］`, and stripping `［＃...］` formatting directives).
pub(in crate::epub_import) fn parse_txt_book(path: &str) -> Result<ParsedBook, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read TXT: {}", e))?;
    let raw = decode_text_bytes(&bytes);
    let cleaned = raw
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let is_aozora = detect_aozora_markup(&cleaned);
    let body = if is_aozora {
        strip_aozora_header_block(&cleaned)
    } else {
        cleaned.as_str()
    };

    let raw_paragraphs = split_text_into_raw_paragraphs(body);
    if raw_paragraphs.is_empty() {
        return Err("TXT file is empty.".to_string());
    }

    let mut paragraphs: Vec<EpubParagraph> = Vec::with_capacity(raw_paragraphs.len());
    for raw_p in raw_paragraphs {
        let html_inner = if is_aozora {
            convert_aozora_paragraph_to_html(&raw_p)
        } else {
            escape_html_text(&raw_p).replace('\n', "<br />\n")
        };
        if html_inner.trim().is_empty() {
            continue;
        }
        let html = format!("<p>{}</p>", html_inner);
        let plain = normalize_text(&html);
        if plain.is_empty() {
            continue;
        }
        let idx = paragraphs.len();
        paragraphs.push(EpubParagraph {
            index: idx,
            id: None,
            anchor_ids: Vec::new(),
            kind: "paragraph".to_string(),
            html,
            text: plain,
            image_src: None,
            image_alt: None,
        });
    }

    if paragraphs.is_empty() {
        return Err("TXT file is empty.".to_string());
    }

    let (title, author) = if is_aozora {
        extract_aozora_title_author(&cleaned)
            .unwrap_or_else(|| (file_stem_title(path, "Text"), None))
    } else {
        (file_stem_title(path, "Text"), None)
    };

    let sections = split_paragraphs_into_sections(paragraphs, "txt", "txt", &title);

    Ok(ParsedBook {
        title,
        author,
        series: None,
        series_position: None,
        metadata_languages: Vec::new(),
        default_vertical: false,
        cover: None,
        sections,
    })
}

fn detect_aozora_markup(text: &str) -> bool {
    let sample: String = text.chars().take(6000).collect();
    (sample.contains('《') && sample.contains('》'))
        || (sample.contains("［＃") && sample.contains('］'))
}

/// Aozora Bunko files place an explanatory header between two lines of `------` (50+ hyphens).
fn strip_aozora_header_block(text: &str) -> &str {
    let mut dash_lines: Vec<(usize, usize)> = Vec::new();
    let mut offset = 0usize;
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.len() >= 20 && trimmed.chars().all(|c| c == '-' || c == '－') {
            dash_lines.push((offset, offset + line.len()));
            if dash_lines.len() == 2 {
                break;
            }
        }
        offset += line.len() + 1;
        if offset > 8000 {
            break;
        }
    }
    if dash_lines.len() == 2 {
        let after_second = (dash_lines[1].1 + 1).min(text.len());
        if after_second < text.len() {
            return &text[after_second..];
        }
    }
    text
}

fn extract_aozora_title_author(text: &str) -> Option<(String, Option<String>)> {
    let mut non_empty = text
        .lines()
        .take(12)
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !(l.len() >= 20 && l.chars().all(|c| c == '-' || c == '－')));
    let first = non_empty.next()?;
    let second = non_empty.next();
    // Only treat top lines as Aozora title/author when the standard `------` metadata divider exists nearby
    let has_divider = text
        .lines()
        .take(25)
        .any(|l| {
            let t = l.trim();
            t.len() >= 20 && t.chars().all(|c| c == '-' || c == '－')
        });
    if !has_divider || first.chars().count() > 80 {
        return None;
    }
    let author = second
        .filter(|s| s.chars().count() <= 40 && !s.contains('。'))
        .map(|s| s.to_string());
    Some((first.to_string(), author))
}

fn split_text_into_raw_paragraphs(cleaned: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();
    for line in cleaned.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line.trim_end().to_string());
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join("\n"));
    }

    // If a file has no blank lines at all (common in Japanese webnovel / Aozora .txt), split per non-empty line
    if paragraphs.len() <= 2 && cleaned.lines().filter(|l| !l.trim().is_empty()).count() > 10 {
        paragraphs = cleaned
            .lines()
            .map(|l| l.trim_end().to_string())
            .filter(|l| !l.trim().is_empty())
            .collect();
    }

    paragraphs
}

fn is_kanji_like(c: char) -> bool {
    let code = c as u32;
    (0x4E00..=0x9FFF).contains(&code)
        || (0x3400..=0x4DBF).contains(&code)
        || matches!(c, '々' | '〆' | 'ヶ' | '〇' | '仝')
}

/// Converts a single Aozora Bunko paragraph into safe HTML with `<ruby>` and bouten emphasis.
pub(super) fn convert_aozora_paragraph_to_html(raw: &str) -> String {
    let lines: Vec<String> = raw
        .split('\n')
        .map(convert_aozora_line_to_html)
        .filter(|l| !l.trim().is_empty())
        .collect();
    lines.join("<br />\n")
}

fn convert_aozora_line_to_html(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(line.len() + 32);
    let mut i = 0usize;

    // Pending plain text buffer so implicit `漢字《ruby》` can retroactively split the trailing kanji run
    let mut pending = String::new();

    let flush_pending = |pending: &mut String, out: &mut String| {
        if !pending.is_empty() {
            out.push_str(&escape_html_text(pending));
            pending.clear();
        }
    };

    while i < len {
        let ch = chars[i];

        // 1. Explicit ruby anchor: `｜base《ruby》`
        if ch == '｜' || ch == '|' {
            if let Some(rel_open) = chars[i + 1..].iter().position(|&c| c == '《') {
                let open_idx = i + 1 + rel_open;
                if let Some(rel_close) = chars[open_idx + 1..].iter().position(|&c| c == '》') {
                    let close_idx = open_idx + 1 + rel_close;
                    let base: String = chars[i + 1..open_idx].iter().collect();
                    let ruby: String = chars[open_idx + 1..close_idx].iter().collect();
                    if !base.is_empty() && !ruby.is_empty() && base.chars().count() <= 30 {
                        flush_pending(&mut pending, &mut out);
                        out.push_str("<ruby>");
                        out.push_str(&escape_html_text(&base));
                        out.push_str("<rt>");
                        out.push_str(&escape_html_text(&ruby));
                        out.push_str("</rt></ruby>");
                        i = close_idx + 1;
                        continue;
                    }
                }
            }
        }

        // 2. Implicit ruby: `漢字《ruby》` (attaches to trailing kanji run in `pending`)
        if ch == '《' {
            if let Some(rel_close) = chars[i + 1..].iter().position(|&c| c == '》') {
                let close_idx = i + 1 + rel_close;
                let ruby: String = chars[i + 1..close_idx].iter().collect();
                if !ruby.is_empty() && ruby.chars().count() <= 30 {
                    let pending_chars: Vec<char> = pending.chars().collect();
                    let mut split_at = pending_chars.len();
                    while split_at > 0 && is_kanji_like(pending_chars[split_at - 1]) {
                        split_at -= 1;
                    }
                    if split_at < pending_chars.len() {
                        let prefix: String = pending_chars[..split_at].iter().collect();
                        let base: String = pending_chars[split_at..].iter().collect();
                        pending.clear();
                        if !prefix.is_empty() {
                            out.push_str(&escape_html_text(&prefix));
                        }
                        out.push_str("<ruby>");
                        out.push_str(&escape_html_text(&base));
                        out.push_str("<rt>");
                        out.push_str(&escape_html_text(&ruby));
                        out.push_str("</rt></ruby>");
                        i = close_idx + 1;
                        continue;
                    }
                }
            }
        }

        // 3. Aozora inline note: `［＃...］`
        if ch == '［' && i + 1 < len && chars[i + 1] == '＃' {
            if let Some(rel_close) = chars[i + 2..].iter().position(|&c| c == '］') {
                let close_idx = i + 2 + rel_close;
                let note: String = chars[i + 2..close_idx].iter().collect();
                // Handle bouten directive: `［＃「...」に傍点］`
                if note.contains("傍点") {
                    if let Some((start_q, end_q)) = note
                        .find('「')
                        .and_then(|s| note[s + '「'.len_utf8()..].find('」').map(|e| (s + '「'.len_utf8(), s + '「'.len_utf8() + e)))
                    {
                        let target = &note[start_q..end_q];
                        if !target.is_empty() {
                            if let Some(pos) = pending.rfind(target) {
                                let prefix = pending[..pos].to_string();
                                let suffix = pending[pos + target.len()..].to_string();
                                pending.clear();
                                if !prefix.is_empty() {
                                    out.push_str(&escape_html_text(&prefix));
                                }
                                out.push_str("<span data-epub-emphasis=\"filled dot\">");
                                out.push_str(&escape_html_text(target));
                                out.push_str("</span>");
                                pending.push_str(&suffix);
                            }
                        }
                    }
                }
                i = close_idx + 1;
                continue;
            }
        }

        pending.push(ch);
        i += 1;
    }

    flush_pending(&mut pending, &mut out);
    out
}
