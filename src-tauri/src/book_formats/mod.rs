pub(super) mod docx;
pub(super) mod fb2;
pub(super) mod html_md;
pub(super) mod mobi;
pub(super) mod txt_aozora;

use super::*;
use std::collections::HashSet;

pub(super) struct ParsedSection {
    pub id: String,
    pub href: String,
    pub title: Option<String>,
    pub html: String,
    pub paragraphs: Vec<EpubParagraph>,
}

pub(super) struct ParsedBook {
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_position: Option<f64>,
    pub metadata_languages: Vec<String>,
    pub default_vertical: bool,
    pub cover: Option<String>,
    pub sections: Vec<ParsedSection>,
}

/// Decodes arbitrary text bytes into UTF-8 using BOM detection, strict UTF-8 check,
/// and `chardetng` + `encoding_rs` fallback (handles Shift-JIS, EUC-JP, Windows-1251, UTF-16, etc.).
pub(super) fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return utf8.to_string();
    }

    let mut detector = chardetng::EncodingDetector::new();
    let sample_len = bytes.len().min(65_536);
    detector.feed(&bytes[..sample_len], sample_len == bytes.len());
    let encoding = detector.guess(None, true);
    let (cow, _, _) = encoding.decode(bytes);
    cow.into_owned()
}

/// Decodes XML bytes honoring any `<?xml ... encoding="..."?>` declaration first,
/// falling back to `decode_text_bytes`.
pub(super) fn decode_xml_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
    {
        return decode_text_bytes(bytes);
    }

    let header_len = bytes.len().min(256);
    let header_ascii: String = bytes[..header_len]
        .iter()
        .map(|&b| if b.is_ascii() { b as char } else { ' ' })
        .collect();
    if let Some(decl_end) = header_ascii.find("?>") {
        let decl = &header_ascii[..decl_end];
        if let Some(enc_label) = extract_xml_decl_encoding(decl) {
            if let Some(enc) = encoding_rs::Encoding::for_label(enc_label.as_bytes()) {
                let (cow, _, _) = enc.decode(bytes);
                return cow.into_owned();
            }
        }
    }

    decode_text_bytes(bytes)
}

fn extract_xml_decl_encoding(decl: &str) -> Option<String> {
    let lower = decl.to_ascii_lowercase();
    let pos = lower.find("encoding")?;
    let after = &decl[pos + "encoding".len()..];
    let eq = after.find('=')?;
    let val = after[eq + 1..].trim_start();
    let quote = val.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &val[1..];
    let end = rest.find(quote)?;
    let label = rest[..end].trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

pub(super) fn infer_image_mime(bytes: &[u8], name_hint: Option<&str>) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
        return "image/svg+xml";
    }
    if let Some(name) = name_hint {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".png") {
            return "image/png";
        }
        if lower.ends_with(".gif") {
            return "image/gif";
        }
        if lower.ends_with(".webp") {
            return "image/webp";
        }
        if lower.ends_with(".svg") {
            return "image/svg+xml";
        }
    }
    "image/jpeg"
}

pub(super) fn encode_data_url(bytes: &[u8], mime: &str) -> Option<String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_EPUB_IMAGE_BYTES {
        return None;
    }
    let encoded = general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

pub(super) fn file_stem_title(path: &str, fallback: &str) -> String {
    let p = Path::new(path);
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".fb2.zip") && name.len() > 8 {
        let trimmed = name[..name.len() - 8].trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    p.file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Splits a flat list of `EpubParagraph` blocks into sections either by major headings (`<h1>`/`<h2>`)
/// or fixed-size chunks (`TXT_PARAGRAPHS_PER_CHAPTER`) when headings aren't structured for chapter breaks.
pub(super) fn split_paragraphs_into_sections(
    all_paragraphs: Vec<EpubParagraph>,
    id_prefix: &str,
    href_base: &str,
    book_title: &str,
) -> Vec<ParsedSection> {
    if all_paragraphs.is_empty() {
        return Vec::new();
    }

    // Collect indices of heading paragraphs to build logical chapter splits
    let mut heading_starts: Vec<usize> = Vec::new();
    for (idx, p) in all_paragraphs.iter().enumerate() {
        if p.kind == "heading" && !p.text.trim().is_empty() {
            heading_starts.push(idx);
        }
    }

    let use_heading_splits = heading_starts.len() >= 2 && heading_starts.len() <= MAX_EPUB_CHAPTERS;
    let mut sections: Vec<ParsedSection> = Vec::new();

    if use_heading_splits {
        let mut ranges: Vec<(usize, usize, Option<String>)> = Vec::new();
        if heading_starts[0] > 0 {
            ranges.push((0, heading_starts[0], Some(book_title.to_string())));
        }
        for i in 0..heading_starts.len() {
            let start = heading_starts[i];
            let end = if i + 1 < heading_starts.len() {
                heading_starts[i + 1]
            } else {
                all_paragraphs.len()
            };
            let h_title = all_paragraphs[start].text.trim().to_string();
            let title = if h_title.is_empty() {
                Some(format!("Part {}", ranges.len() + 1))
            } else {
                Some(h_title)
            };
            ranges.push((start, end, title));
        }

        // Sub-chunk any overly long section (> 400 paragraphs) so reader pagination stays snappy
        const MAX_SECTION_PARAGRAPHS: usize = 360;
        for (start, end, title) in ranges {
            if sections.len() >= MAX_EPUB_CHAPTERS {
                break;
            }
            let len = end.saturating_sub(start);
            if len == 0 {
                continue;
            }
            if len <= MAX_SECTION_PARAGRAPHS {
                let mut slice = all_paragraphs[start..end].to_vec();
                reindex_paragraphs(&mut slice);
                let html = slice.iter().map(|p| p.html.as_str()).collect::<Vec<_>>().join("\n");
                let idx = sections.len();
                sections.push(ParsedSection {
                    id: format!("{}-sec-{}", id_prefix, idx + 1),
                    href: format!("{}#sec-{}", href_base, idx + 1),
                    title,
                    html,
                    paragraphs: slice,
                });
            } else {
                let mut sub_start = start;
                let mut part_no = 1usize;
                while sub_start < end && sections.len() < MAX_EPUB_CHAPTERS {
                    let sub_end = (sub_start + TXT_PARAGRAPHS_PER_CHAPTER).min(end);
                    let mut slice = all_paragraphs[sub_start..sub_end].to_vec();
                    reindex_paragraphs(&mut slice);
                    let html = slice.iter().map(|p| p.html.as_str()).collect::<Vec<_>>().join("\n");
                    let idx = sections.len();
                    let sub_title = title.as_ref().map(|t| {
                        if part_no == 1 {
                            t.clone()
                        } else {
                            format!("{} ({})", t, part_no)
                        }
                    });
                    sections.push(ParsedSection {
                        id: format!("{}-sec-{}", id_prefix, idx + 1),
                        href: format!("{}#sec-{}", href_base, idx + 1),
                        title: sub_title,
                        html,
                        paragraphs: slice,
                    });
                    sub_start = sub_end;
                    part_no += 1;
                }
            }
        }
    } else {
        let total = all_paragraphs.len();
        let chunk_count = ((total.max(1)) + TXT_PARAGRAPHS_PER_CHAPTER - 1) / TXT_PARAGRAPHS_PER_CHAPTER;
        for idx in 0..chunk_count.min(MAX_EPUB_CHAPTERS) {
            let start = idx * TXT_PARAGRAPHS_PER_CHAPTER;
            let end = (start + TXT_PARAGRAPHS_PER_CHAPTER).min(total);
            let mut slice = all_paragraphs[start..end].to_vec();
            reindex_paragraphs(&mut slice);
            let html = slice.iter().map(|p| p.html.as_str()).collect::<Vec<_>>().join("\n");
            let title = if chunk_count == 1 {
                Some(book_title.to_string())
            } else {
                Some(format!("Part {}", idx + 1))
            };
            sections.push(ParsedSection {
                id: format!("{}-part-{}", id_prefix, idx + 1),
                href: format!("{}#part-{}", href_base, idx + 1),
                title,
                html,
                paragraphs: slice,
            });
        }
    }

    sections
}

pub(super) fn reindex_paragraphs(paragraphs: &mut [EpubParagraph]) {
    for (idx, p) in paragraphs.iter_mut().enumerate() {
        p.index = idx;
    }
}

pub(super) fn parsed_book_to_meta(book: ParsedBook) -> Result<EpubBookMeta, String> {
    if book.sections.is_empty() {
        return Err("Book opened, but no readable content was found.".to_string());
    }

    let mut sample = String::new();
    let mut chapters = Vec::with_capacity(book.sections.len());
    let mut total_chars = 0usize;

    for (idx, sec) in book.sections.iter().enumerate() {
        let mut ch_chars = 0usize;
        for p in &sec.paragraphs {
            if p.text.is_empty() {
                continue;
            }
            ch_chars += p.text.chars().filter(|c| !c.is_whitespace()).count();
            if sample.chars().count() < LANGUAGE_SAMPLE_CHARS {
                if !sample.is_empty() {
                    sample.push(' ');
                }
                sample.push_str(&p.text);
            }
        }
        total_chars += ch_chars;
        chapters.push(EpubChapterMeta {
            index: idx,
            id: sec.id.clone(),
            href: sec.href.clone(),
            title: sec.title.clone(),
            char_count: ch_chars,
        });
    }

    let (language, metadata_language) = detect_book_language(&book.metadata_languages, &sample);
    let toc = build_default_toc(&chapters);

    Ok(EpubBookMeta {
        title: book.title,
        author: book.author,
        series: book.series,
        series_position: book.series_position,
        language: language.to_string(),
        metadata_language,
        page_progression_direction: None,
        primary_writing_mode: None,
        css_writing_mode: None,
        default_vertical: book.default_vertical,
        chapters,
        toc,
        cover: book.cover,
        total_chars,
    })
}

pub(super) fn parsed_book_chapter(book: ParsedBook, index: usize) -> Result<EpubChapterContent, String> {
    let sec = book
        .sections
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("Book chapter index {} out of bounds", index))?;
    let text = sec
        .paragraphs
        .iter()
        .filter(|p| !p.text.is_empty())
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EpubChapterContent {
        index,
        id: sec.id,
        href: sec.href,
        title: sec.title,
        html: sec.html,
        text,
        paragraphs: sec.paragraphs,
    })
}

pub(super) fn search_parsed_book(book: &ParsedBook, needle_lower: &str) -> Vec<EpubSearchHit> {
    let mut hits = Vec::new();
    for (chapter_index, sec) in book.sections.iter().enumerate() {
        if hits.len() >= MAX_SEARCH_HITS {
            break;
        }
        for p in &sec.paragraphs {
            if hits.len() >= MAX_SEARCH_HITS {
                break;
            }
            if p.text.is_empty() {
                continue;
            }
            if let Some(snippet) = build_search_snippet(&p.text, needle_lower) {
                hits.push(EpubSearchHit {
                    chapter_index,
                    chapter_title: sec.title.clone(),
                    paragraph_index: p.index,
                    snippet,
                });
            }
        }
    }
    hits
}

pub(super) fn gallery_from_parsed_book(book: &ParsedBook) -> Vec<EpubGalleryImage> {
    const MAX_GALLERY_IMAGES: usize = 200;
    let mut images = Vec::new();
    let mut seen_srcs: HashSet<String> = HashSet::new();

    for (chapter_index, sec) in book.sections.iter().enumerate() {
        if images.len() >= MAX_GALLERY_IMAGES {
            break;
        }
        for p in &sec.paragraphs {
            if images.len() >= MAX_GALLERY_IMAGES {
                break;
            }
            if p.kind == "image" {
                if let Some(src) = p.image_src.as_ref() {
                    if seen_srcs.insert(src.clone()) {
                        images.push(EpubGalleryImage {
                            chapter_index,
                            chapter_title: sec.title.clone(),
                            paragraph_index: p.index,
                            src: src.clone(),
                            alt: p.image_alt.clone(),
                        });
                    }
                }
            }
        }
    }
    images
}

/// Replaces relative local `<img src="...">` references inside HTML with embedded data URLs
/// when the referenced file exists inside `base_dir` (preventing path traversal outside `base_dir`).
pub(super) fn inline_local_html_images(html: &str, base_dir: &Path) -> String {
    let Ok(canon_base) = std::fs::canonicalize(base_dir) else {
        return html.to_string();
    };
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut image_count = 0usize;

    while let Some(img_rel) = rest.to_ascii_lowercase().find("<img") {
        out.push_str(&rest[..img_rel]);
        let after_img = &rest[img_rel..];
        let Some(tag_end) = after_img.find('>') else {
            out.push_str(after_img);
            return out;
        };
        let tag = &after_img[..=tag_end];
        rest = &after_img[tag_end + 1..];

        if image_count >= MAX_EPUB_IMAGES_PER_CHAPTER {
            out.push_str(tag);
            continue;
        }
        if let Some(src) = xml_attr(tag, "src") {
            let trimmed = src.trim();
            let lower_src = trimmed.to_ascii_lowercase();
            if !trimmed.is_empty()
                && !lower_src.starts_with("data:")
                && !lower_src.starts_with("http://")
                && !lower_src.starts_with("https://")
                && !lower_src.starts_with("file:")
            {
                let clean_rel = trimmed
                    .split('#')
                    .next()
                    .unwrap_or(trimmed)
                    .split('?')
                    .next()
                    .unwrap_or(trimmed);
                let candidate = base_dir.join(clean_rel);
                if let Ok(canon_img) = std::fs::canonicalize(&candidate) {
                    if canon_img.starts_with(&canon_base) {
                        if let Ok(bytes) = std::fs::read(&canon_img) {
                            let mime = infer_image_mime(&bytes, Some(clean_rel));
                            if let Some(data_url) = encode_data_url(&bytes, mime) {
                                image_count += 1;
                                let alt = xml_attr(tag, "alt")
                                    .map(|a| format!(" alt=\"{}\"", escape_html_text(&a)))
                                    .unwrap_or_default();
                                out.push_str(&format!("<img src=\"{}\"{} />", data_url, alt));
                                continue;
                            }
                        }
                    }
                }
            }
        }
        out.push_str(tag);
    }

    out.push_str(rest);
    out
}
