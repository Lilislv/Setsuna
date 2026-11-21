use base64::{engine::general_purpose, Engine as _};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_EPUB_LINES: usize = 8000;
const MAX_EPUB_CHAPTERS: usize = 400;
const MAX_EPUB_IMAGES_PER_CHAPTER: usize = 64;
const MAX_EPUB_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const LANGUAGE_SAMPLE_CHARS: usize = 5000;
const MAX_CSS_INSPECT_CHAPTERS: usize = 5;

#[derive(Clone)]
struct ManifestItem {
    href: String,
    path: String,
    media_type: String,
    properties: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterMeta {
    pub index: usize,
    pub id: String,
    pub href: String,
    pub title: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubBookMeta {
    pub title: String,
    pub language: String,
    pub metadata_language: Option<String>,
    pub page_progression_direction: Option<String>,
    pub primary_writing_mode: Option<String>,
    pub css_writing_mode: Option<String>,
    pub default_vertical: bool,
    pub chapters: Vec<EpubChapterMeta>,
    pub cover: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubParagraph {
    pub index: usize,
    pub id: Option<String>,
    pub anchor_ids: Vec<String>,
    pub kind: String,
    pub html: String,
    pub text: String,
    pub image_src: Option<String>,
    pub image_alt: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterContent {
    pub index: usize,
    pub id: String,
    pub href: String,
    pub title: Option<String>,
    pub html: String,
    pub text: String,
    pub paragraphs: Vec<EpubParagraph>,
}

#[derive(serde::Serialize, Clone)]
pub struct EpubChapter {
    id: String,
    href: String,
    title: Option<String>,
    html: String,
    css: String,
    text: String,
    body_class: Option<String>,
    html_class: Option<String>,
}

#[derive(serde::Serialize)]
pub struct EpubImportResult {
    title: String,
    language: String,
    page_progression_direction: Option<String>,
    primary_writing_mode: Option<String>,
    default_vertical: bool,
    lines: Vec<String>,
    chapters: Vec<EpubChapter>,
}

fn decode_html_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest[1..].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..1 + semi];
        if entity.len() > 16 || entity.contains(char::is_whitespace) || entity.contains('<') {
            out.push('&');
            rest = &rest[1..];
            continue;
        }
        let decoded: Option<char> = if let Some(hex) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = entity.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match entity {
                "nbsp" => Some(' '),
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "mdash" => Some('\u{2014}'),
                "ndash" => Some('\u{2013}'),
                "hellip" => Some('\u{2026}'),
                "lsquo" => Some('\u{2018}'),
                "rsquo" => Some('\u{2019}'),
                "ldquo" => Some('\u{201C}'),
                "rdquo" => Some('\u{201D}'),
                "laquo" => Some('\u{00AB}'),
                "raquo" => Some('\u{00BB}'),
                "copy" => Some('\u{00A9}'),
                "middot" => Some('\u{00B7}'),
                "bull" => Some('\u{2022}'),
                "ensp" | "emsp" | "thinsp" => Some(' '),
                _ => None,
            }
        };

        if let Some(ch) = decoded {
            out.push(ch);
            rest = &rest[1 + semi + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn escape_attr(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'%' && idx + 2 < bytes.len() {
            let h1 = (bytes[idx + 1] as char).to_digit(16);
            let h2 = (bytes[idx + 2] as char).to_digit(16);
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push(((a << 4) | b) as u8);
                idx += 3;
                continue;
            }
        }
        out.push(bytes[idx]);
        idx += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn strip_bom(input: String) -> String {
    input.strip_prefix('\u{FEFF}').map(str::to_string).unwrap_or(input)
}

fn normalize_tag_name(raw: &str) -> String {
    raw.trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start_matches('!')
        .trim_start_matches('?')
        .split(|ch: char| ch.is_ascii_whitespace() || ch == '>' || ch == '/')
        .next()
        .unwrap_or("")
        .rsplit(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn is_closing_tag(tag: &str) -> bool {
    tag.trim_start().starts_with("</")
}

fn is_self_closing_tag(tag: &str) -> bool {
    let trimmed = tag.trim_end();
    trimmed.ends_with("/>")
}

fn parse_tag_attributes(tag: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let trimmed = tag.trim();
    if !trimmed.starts_with('<') || trimmed.starts_with("</") || trimmed.starts_with("<!") || trimmed.starts_with("<?") {
        return attrs;
    }
    let inner = trimmed
        .strip_prefix('<')
        .unwrap_or(trimmed)
        .strip_suffix('>')
        .unwrap_or(trimmed)
        .trim_end();
    let inner = inner.strip_suffix('/').unwrap_or(inner);

    let bytes = inner.as_bytes();
    let mut idx = 0;
    // Skip tag name
    while idx < bytes.len() && !bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }

    while idx < bytes.len() {
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() {
            break;
        }
        let name_start = idx;
        while idx < bytes.len()
            && !bytes[idx].is_ascii_whitespace()
            && bytes[idx] != b'='
            && bytes[idx] != b'/'
        {
            idx += 1;
        }
        if idx == name_start {
            idx += 1;
            continue;
        }
        let name = inner[name_start..idx].to_lowercase();

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b'=' {
            attrs.push((name, String::new()));
            continue;
        }
        idx += 1;
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() {
            attrs.push((name, String::new()));
            break;
        }
        let quote = bytes[idx];
        let value = if quote == b'"' || quote == b'\'' {
            idx += 1;
            let val_start = idx;
            while idx < bytes.len() && bytes[idx] != quote {
                idx += 1;
            }
            let raw_val = &inner[val_start..idx];
            if idx < bytes.len() {
                idx += 1;
            }
            decode_html_entities(raw_val)
        } else {
            let val_start = idx;
            while idx < bytes.len() && !bytes[idx].is_ascii_whitespace() {
                idx += 1;
            }
            decode_html_entities(&inner[val_start..idx])
        };
        attrs.push((name, value));
    }

    attrs
}

fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let target = name.to_lowercase();
    for (attr_name, value) in parse_tag_attributes(tag) {
        if attr_name == target {
            return Some(value);
        }
    }
    None
}

fn find_tag_end(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut quote: Option<u8> = None;
    for (idx, &b) in bytes.iter().enumerate() {
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'>' {
                    return Some(idx);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
enum HtmlToken<'a> {
    Text(&'a str),
    Tag(&'a str),
}

fn tokenize_html(input: &str) -> Vec<HtmlToken<'_>> {
    let mut tokens = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            tokens.push(HtmlToken::Text(rest));
            break;
        };
        if lt > 0 {
            tokens.push(HtmlToken::Text(&rest[..lt]));
        }
        rest = &rest[lt..];

        if rest.starts_with("<!--") {
            if let Some(end) = rest.find("-->") {
                rest = &rest[end + 3..];
                continue;
            } else {
                break;
            }
        }
        if rest.starts_with("<![CDATA[") {
            if let Some(end) = rest.find("]]>") {
                let inner = &rest[9..end];
                if !inner.is_empty() {
                    tokens.push(HtmlToken::Text(inner));
                }
                rest = &rest[end + 3..];
                continue;
            } else {
                break;
            }
        }
        if rest.starts_with("<?") {
            if let Some(end) = rest.find("?>") {
                rest = &rest[end + 2..];
                continue;
            } else {
                break;
            }
        }
        if rest.starts_with("<!") {
            if let Some(end) = rest.find('>') {
                rest = &rest[end + 1..];
                continue;
            } else {
                break;
            }
        }

        let Some(tag_end) = find_tag_end(rest) else {
            break;
        };
        tokens.push(HtmlToken::Tag(&rest[..=tag_end]));
        rest = &rest[tag_end + 1..];
    }
    tokens
}

fn is_drop_content_tag(name: &str) -> bool {
    matches!(
        name,
        "script"
            | "style"
            | "iframe"
            | "object"
            | "embed"
            | "applet"
            | "form"
            | "input"
            | "button"
            | "textarea"
            | "select"
            | "option"
            | "noscript"
            | "template"
            | "math"
            | "head"
            | "title"
            | "meta"
            | "link"
            | "base"
            | "audio"
            | "video"
            | "source"
            | "canvas"
    )
}

fn is_allowed_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "span"
            | "br"
            | "wbr"
            | "ruby"
            | "rb"
            | "rt"
            | "rp"
            | "rtc"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "em"
            | "strong"
            | "b"
            | "i"
            | "u"
            | "s"
            | "sub"
            | "sup"
            | "small"
            | "mark"
            | "cite"
            | "q"
            | "abbr"
            | "code"
            | "pre"
            | "img"
            | "a"
            | "ul"
            | "ol"
            | "li"
            | "dl"
            | "dt"
            | "dd"
            | "blockquote"
            | "hr"
            | "figure"
            | "figcaption"
            | "section"
            | "article"
            | "aside"
            | "header"
            | "footer"
            | "nav"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
            | "td"
            | "th"
    )
}

fn is_void_tag(name: &str) -> bool {
    matches!(name, "br" | "hr" | "img" | "wbr")
}

fn is_safe_raster_data_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("data:image/png;base64,")
        || lower.starts_with("data:image/jpeg;base64,")
        || lower.starts_with("data:image/webp;base64,")
        || lower.starts_with("data:image/gif;base64,")
        || lower.starts_with("data:image/avif;base64,")
}

fn is_safe_internal_href(href: &str) -> bool {
    let trimmed = href.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    !(lower.starts_with("javascript:")
        || lower.starts_with("vbscript:")
        || lower.starts_with("data:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("file:")
        || lower.starts_with("//"))
}

fn strip_ruby_and_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut skip_stack: Vec<String> = Vec::new();

    for token in tokenize_html(input) {
        match token {
            HtmlToken::Text(text) => {
                if skip_stack.is_empty() {
                    out.push_str(text);
                }
            }
            HtmlToken::Tag(tag) => {
                let name = normalize_tag_name(tag);
                if name.is_empty() {
                    continue;
                }
                let closing = is_closing_tag(tag);
                let self_closing = is_self_closing_tag(tag) || is_void_tag(&name);

                if matches!(name.as_str(), "rt" | "rp" | "rtc") || is_drop_content_tag(&name) {
                    if closing {
                        if let Some(pos) = skip_stack.iter().rposition(|t| t == &name) {
                            skip_stack.truncate(pos);
                        }
                    } else if !self_closing {
                        skip_stack.push(name);
                    }
                    continue;
                }

                if skip_stack.is_empty()
                    && matches!(
                        name.as_str(),
                        "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    )
                {
                    out.push(' ');
                }
            }
        }
    }

    decode_html_entities(&out)
}

fn normalize_text(input: &str) -> String {
    strip_ruby_and_tags(input)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn tag_with_name(input: &str, name: &str) -> Option<String> {
    for token in tokenize_html(input) {
        if let HtmlToken::Tag(tag) = token {
            if !is_closing_tag(tag) && normalize_tag_name(tag) == name {
                return Some(tag.to_string());
            }
        }
    }
    None
}

fn html_body_parts(input: &str) -> (String, Option<String>, Option<String>) {
    let html_class = tag_with_name(input, "html").and_then(|tag| xml_attr(&tag, "class"));
    let lower = input.to_lowercase();
    let Some(body_start) = lower.find("<body") else {
        return (input.to_string(), None, html_class);
    };
    let Some(open_end_rel) = find_tag_end(&input[body_start..]) else {
        return (input.to_string(), None, html_class);
    };
    let body_tag = &input[body_start..=body_start + open_end_rel];
    let body_class = xml_attr(body_tag, "class");
    let content_start = body_start + open_end_rel + 1;
    let content_end = lower[content_start..]
        .find("</body>")
        .map(|idx| content_start + idx)
        .unwrap_or(input.len());
    (
        input[content_start..content_end].to_string(),
        body_class,
        html_class,
    )
}

fn epub_join_path(base: &str, href: &str) -> String {
    let clean_href = href.split('#').next().unwrap_or(href);
    let clean_href = clean_href.split('?').next().unwrap_or(clean_href);
    let raw = if base.is_empty() {
        clean_href.to_string()
    } else {
        format!(
            "{}/{}",
            base.trim_end_matches('/'),
            clean_href.trim_start_matches('/')
        )
    };

    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn epub_join_href(base: &str, current_path: &str, href: &str) -> String {
    let trimmed = href.trim();
    if trimmed.starts_with('#') {
        return format!("{}{}", current_path, trimmed);
    }

    let (path_part, fragment) = trimmed
        .split_once('#')
        .map(|(path, fragment)| (path, Some(fragment)))
        .unwrap_or((trimmed, None));
    let path = epub_join_path(base, path_part);
    match fragment {
        Some(fragment) if !fragment.is_empty() => format!("{}#{}", path, fragment),
        _ => path,
    }
}

fn safe_raster_mime_from_path(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".jpe") {
        Some("image/jpeg")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".avif") {
        Some("image/avif")
    } else {
        None
    }
}

fn zip_open_entry<'a>(zip: &'a mut ZipArchive<File>, path: &str) -> Option<zip::read::ZipFile<'a>> {
    let decoded = percent_decode(path);
    let candidates = [path, decoded.as_str()];
    for candidate in candidates {
        if zip.by_name(candidate).is_ok() {
            return zip.by_name(candidate).ok();
        }
    }
    None
}

fn zip_read_to_string(zip: &mut ZipArchive<File>, path: &str) -> Result<String, String> {
    let mut file = zip_open_entry(zip, path)
        .ok_or_else(|| format!("EPUB file not found: {}", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("EPUB read error {}: {}", path, e))?;
    let text = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(strip_bom(text))
}

fn zip_read_image_data_url(
    zip: &mut ZipArchive<File>,
    path: &str,
    cache: &mut HashMap<String, String>,
) -> Option<String> {
    let mime = safe_raster_mime_from_path(path)?;
    if let Some(cached) = cache.get(path) {
        return Some(cached.clone());
    }
    if cache.len() >= MAX_EPUB_IMAGES_PER_CHAPTER {
        return None;
    }
    let mut file = zip_open_entry(zip, path)?;
    if file.size() > MAX_EPUB_IMAGE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).ok()?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    let data_url = format!("data:{};base64,{}", mime, encoded);
    cache.insert(path.to_string(), data_url.clone());
    Some(data_url)
}

fn find_epub_opf_path(zip: &mut ZipArchive<File>, container: &str) -> Result<String, String> {
    for token in tokenize_html(container) {
        if let HtmlToken::Tag(tag) = token {
            if !is_closing_tag(tag) && normalize_tag_name(tag) == "rootfile" {
                if let Some(path) = xml_attr(tag, "full-path").filter(|v| !v.trim().is_empty()) {
                    return Ok(path);
                }
            }
        }
    }

    for idx in 0..zip.len() {
        if let Ok(file) = zip.by_index(idx) {
            let name = file.name().replace('\\', "/");
            if name.to_lowercase().ends_with(".opf") {
                return Ok(name);
            }
        }
    }

    Err("EPUB container has no OPF package path".to_string())
}

fn collect_manifest(opf: &str, base_dir: &str) -> HashMap<String, ManifestItem> {
    let mut manifest = HashMap::new();
    for token in tokenize_html(opf) {
        if let HtmlToken::Tag(tag) = token {
            if is_closing_tag(tag) || normalize_tag_name(tag) != "item" {
                continue;
            }
            let Some(id) = xml_attr(tag, "id") else {
                continue;
            };
            let Some(href) = xml_attr(tag, "href") else {
                continue;
            };
            let media_type = xml_attr(tag, "media-type").unwrap_or_default();
            let properties = xml_attr(tag, "properties").unwrap_or_default();
            manifest.insert(
                id,
                ManifestItem {
                    path: epub_join_path(base_dir, &href),
                    href,
                    media_type,
                    properties,
                },
            );
        }
    }
    manifest
}

fn spine_paths(opf: &str, manifest: &HashMap<String, ManifestItem>) -> Vec<(String, ManifestItem)> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for token in tokenize_html(opf) {
        if let HtmlToken::Tag(tag) = token {
            if is_closing_tag(tag) || normalize_tag_name(tag) != "itemref" {
                continue;
            }
            let Some(idref) = xml_attr(tag, "idref") else {
                continue;
            };
            let Some(item) = manifest.get(&idref) else {
                continue;
            };
            let lower = item.path.to_lowercase();
            if !(item.media_type.contains("xhtml")
                || item.media_type.contains("html")
                || lower.ends_with(".xhtml")
                || lower.ends_with(".html")
                || lower.ends_with(".htm"))
            {
                continue;
            }
            if seen.insert(item.path.clone()) {
                paths.push((idref, item.clone()));
            }
        }
    }
    paths
}

fn extract_tag_text_values(xml: &str, target_local_name: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut capturing = false;
    let mut current = String::new();
    for token in tokenize_html(xml) {
        match token {
            HtmlToken::Tag(tag) => {
                let name = normalize_tag_name(tag);
                if name == target_local_name {
                    if is_closing_tag(tag) {
                        if capturing {
                            let val = decode_html_entities(&current).trim().to_string();
                            if !val.is_empty() {
                                values.push(val);
                            }
                            current.clear();
                            capturing = false;
                        }
                    } else if !is_self_closing_tag(tag) {
                        capturing = true;
                        current.clear();
                    }
                }
            }
            HtmlToken::Text(text) => {
                if capturing {
                    current.push_str(text);
                }
            }
        }
    }
    values
}

fn title_from_opf(opf: &str, fallback_path: &str) -> String {
    extract_tag_text_values(opf, "title")
        .into_iter()
        .next()
        .or_else(|| {
            Path::new(fallback_path)
                .file_stem()
                .map(|name| name.to_string_lossy().to_string())
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "EPUB".to_string())
}

fn languages_from_opf(opf: &str) -> Vec<String> {
    extract_tag_text_values(opf, "language")
}

fn page_progression_direction_from_opf(opf: &str) -> Option<String> {
    for token in tokenize_html(opf) {
        if let HtmlToken::Tag(tag) = token {
            if !is_closing_tag(tag) && normalize_tag_name(tag) == "spine" {
                if let Some(dir) = xml_attr(tag, "page-progression-direction") {
                    let normalized = dir.trim().to_lowercase();
                    if matches!(normalized.as_str(), "rtl" | "ltr" | "default") {
                        return Some(normalized);
                    }
                }
            }
        }
    }
    None
}

fn primary_writing_mode_from_opf(opf: &str) -> Option<String> {
    let tokens = tokenize_html(opf);
    let mut idx = 0;
    while idx < tokens.len() {
        if let HtmlToken::Tag(tag) = tokens[idx] {
            if !is_closing_tag(tag) && normalize_tag_name(tag) == "meta" {
                let name = xml_attr(tag, "name").unwrap_or_default().to_lowercase();
                if name == "primary-writing-mode" {
                    if let Some(content) = xml_attr(tag, "content") {
                        let trimmed = content.trim().to_lowercase();
                        if !trimmed.is_empty() {
                            return Some(trimmed);
                        }
                    }
                }
                let prop = xml_attr(tag, "property").unwrap_or_default().to_lowercase();
                if prop == "primary-writing-mode" && !is_self_closing_tag(tag) {
                    let mut val = String::new();
                    idx += 1;
                    while idx < tokens.len() {
                        match tokens[idx] {
                            HtmlToken::Tag(close)
                                if is_closing_tag(close) && normalize_tag_name(close) == "meta" =>
                            {
                                break;
                            }
                            HtmlToken::Text(t) => val.push_str(t),
                            _ => {}
                        }
                        idx += 1;
                    }
                    let trimmed = decode_html_entities(&val).trim().to_lowercase();
                    if !trimmed.is_empty() {
                        return Some(trimmed);
                    }
                }
            }
        }
        idx += 1;
    }
    None
}

fn cover_path_from_opf(opf: &str, manifest: &HashMap<String, ManifestItem>) -> Option<String> {
    for item in manifest.values() {
        if item
            .properties
            .split_whitespace()
            .any(|p| p.eq_ignore_ascii_case("cover-image"))
            && safe_raster_mime_from_path(&item.path).is_some()
        {
            return Some(item.path.clone());
        }
    }
    for token in tokenize_html(opf) {
        if let HtmlToken::Tag(tag) = token {
            if !is_closing_tag(tag) && normalize_tag_name(tag) == "meta" {
                let name = xml_attr(tag, "name").unwrap_or_default().to_lowercase();
                if name == "cover" {
                    if let Some(cover_id) = xml_attr(tag, "content") {
                        let trimmed = cover_id.trim();
                        if let Some(item) = manifest.get(trimmed) {
                            if safe_raster_mime_from_path(&item.path).is_some() {
                                return Some(item.path.clone());
                            }
                        }
                        if safe_raster_mime_from_path(trimmed).is_some() {
                            if let Some(item) = manifest
                                .values()
                                .find(|i| i.href.eq_ignore_ascii_case(trimmed) || i.path.ends_with(trimmed))
                            {
                                return Some(item.path.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    for (id, item) in manifest {
        if safe_raster_mime_from_path(&item.path).is_some()
            && (id.to_ascii_lowercase().contains("cover")
                || item.href.to_ascii_lowercase().contains("cover"))
        {
            return Some(item.path.clone());
        }
    }
    None
}

fn first_image_path_in_html(html: &str, chapter_base: &str) -> Option<String> {
    for token in tokenize_html(html) {
        if let HtmlToken::Tag(tag) = token {
            if is_closing_tag(tag) {
                continue;
            }
            let name = normalize_tag_name(tag);
            let raw_src = if name == "img" {
                xml_attr(tag, "src")
            } else if name == "image" {
                xml_attr(tag, "href").or_else(|| xml_attr(tag, "xlink:href"))
            } else {
                None
            };
            if let Some(src) = raw_src {
                let trimmed = src.trim();
                if trimmed.is_empty() || trimmed.contains(':') {
                    continue;
                }
                let clean = trimmed.split('#').next().unwrap_or(trimmed).split('?').next().unwrap_or(trimmed);
                let resolved = epub_join_path(chapter_base, clean);
                if safe_raster_mime_from_path(&resolved).is_some() {
                    return Some(resolved);
                }
            }
        }
    }
    None
}

fn read_cover_thumbnail_data_url(zip: &mut ZipArchive<File>, path: &str) -> Option<String> {
    let mime = safe_raster_mime_from_path(path)?;
    let mut file = zip_open_entry(zip, path)?;
    if file.size() > MAX_EPUB_IMAGE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).ok()?;
    if bytes.is_empty() {
        return None;
    }
    if let Ok(decoded) = image::load_from_memory(&bytes) {
        let resized = if decoded.width() > 420 || decoded.height() > 630 {
            decoded.thumbnail(420, 630)
        } else {
            decoded
        };
        let rgb = resized.to_rgb8();
        let mut out = std::io::Cursor::new(Vec::new());
        if image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .is_ok()
        {
            let encoded = general_purpose::STANDARD.encode(out.into_inner());
            return Some(format!("data:image/jpeg;base64,{}", encoded));
        }
    }
    let encoded = general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

fn extract_cover_data_url(pkg: &mut ParsedPackage) -> Option<String> {
    if let Some(cover_path) = cover_path_from_opf(&pkg.opf, &pkg.manifest) {
        if let Some(url) = read_cover_thumbnail_data_url(&mut pkg.zip, &cover_path) {
            return Some(url);
        }
    }
    for (_, item) in pkg.spine.iter().take(2) {
        if let Ok(html) = zip_read_to_string(&mut pkg.zip, &item.path) {
            let base = item.path.rsplit_once('/').map(|(b, _)| b).unwrap_or("");
            if let Some(img_path) = first_image_path_in_html(&html, base) {
                if let Some(url) = read_cover_thumbnail_data_url(&mut pkg.zip, &img_path) {
                    return Some(url);
                }
            }
        }
    }
    None
}

/// Parses an OPF `<dc:language>` tag into `"ja"` or `"en"` if recognized.
pub fn parse_language_tag(raw: &str) -> Option<&'static str> {
    let normalized = raw.trim().to_ascii_lowercase().replace('_', "-");
    if normalized.is_empty() {
        return None;
    }
    let primary = normalized.split('-').next().unwrap_or("");
    match primary {
        "ja" | "jpn" => Some("ja"),
        "en" | "eng" => Some("en"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScriptCounts {
    kana: usize,
    kanji: usize,
    latin: usize,
}

fn count_script_chars(sample: &str) -> ScriptCounts {
    let mut kana = 0usize;
    let mut kanji = 0usize;
    let mut latin = 0usize;
    for ch in sample.chars().take(LANGUAGE_SAMPLE_CHARS) {
        let code = ch as u32;
        if (0x3040..=0x30FF).contains(&code) {
            kana += 1;
        } else if (0x4E00..=0x9FFF).contains(&code)
            || (0x3400..=0x4DBF).contains(&code)
            || matches!(ch, '々' | '〆' | 'ヶ')
        {
            kanji += 1;
        } else if ch.is_ascii_alphabetic()
            || (0x00C0..=0x024F).contains(&code)
        {
            latin += 1;
        }
    }
    ScriptCounts { kana, kanji, latin }
}

/// Detects `"ja"` or `"en"` from plain book text (already excluding `<rt>`/`<rp>`).
/// Japanese when kana + kanji >= 30% of letters AND kana > 0 (kanji alone could be Chinese).
pub fn detect_language_from_sample(sample: &str) -> &'static str {
    let counts = count_script_chars(sample);
    let total = counts.kana + counts.kanji + counts.latin;
    if total == 0 || counts.kana == 0 {
        return "en";
    }
    let jp = counts.kana + counts.kanji;
    if jp * 100 >= total * 30 {
        "ja"
    } else {
        "en"
    }
}

/// Resolves the book language per A1:
/// 1) First recognized `<dc:language>` entry (`ja`/`ja-*`/`jpn` -> `"ja"`, `en`/`en-*`/`eng` -> `"en"`).
/// 2) Recommended override: if metadata says `"en"` but the text sample is overwhelmingly Japanese
///    with real kana (`kana >= 20` and `(kana + kanji) >= 60%`), trust the text.
/// 3) Fallback to character check of the book sample (excluding `<rt>`/`<rp>`).
pub fn detect_book_language(metadata_languages: &[String], text_sample: &str) -> (&'static str, Option<String>) {
    let mut first_recognized: Option<(&'static str, String)> = None;
    for raw in metadata_languages {
        if let Some(parsed) = parse_language_tag(raw) {
            first_recognized = Some((parsed, raw.trim().to_string()));
            break;
        }
    }

    match first_recognized {
        Some(("ja", raw)) => ("ja", Some(raw)),
        Some(("en", raw)) => {
            let counts = count_script_chars(text_sample);
            let total = counts.kana + counts.kanji + counts.latin;
            let jp = counts.kana + counts.kanji;
            if total > 0 && counts.kana >= 20 && jp * 100 >= total * 60 {
                ("ja", Some(raw))
            } else {
                ("en", Some(raw))
            }
        }
        _ => {
            let first_raw = metadata_languages.first().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            (detect_language_from_sample(text_sample), first_raw)
        }
    }
}

fn css_links(input: &str, chapter_base: &str) -> Vec<String> {
    let mut links = Vec::new();
    for token in tokenize_html(input) {
        if let HtmlToken::Tag(tag) = token {
            if is_closing_tag(tag) || normalize_tag_name(tag) != "link" {
                continue;
            }
            let rel = xml_attr(tag, "rel").unwrap_or_default().to_lowercase();
            let href = xml_attr(tag, "href").unwrap_or_default();
            if href.is_empty()
                || (!rel.contains("stylesheet") && !href.to_lowercase().ends_with(".css"))
            {
                continue;
            }
            links.push(epub_join_path(chapter_base, &href));
        }
    }
    links
}

fn extract_inline_style_blocks(input: &str) -> String {
    let mut css = String::new();
    let mut in_style = false;
    for token in tokenize_html(input) {
        match token {
            HtmlToken::Tag(tag) => {
                if normalize_tag_name(tag) == "style" {
                    if is_closing_tag(tag) {
                        in_style = false;
                    } else if !is_self_closing_tag(tag) {
                        in_style = true;
                    }
                }
            }
            HtmlToken::Text(t) => {
                if in_style {
                    css.push_str(t);
                    css.push('\n');
                }
            }
        }
    }
    css
}

fn extract_vertical_mode_from_declaration(decl_block: &str) -> Option<&'static str> {
    let lower = decl_block.to_ascii_lowercase();
    for decl in lower.split(';') {
        let Some((prop, val)) = decl.split_once(':') else {
            continue;
        };
        let prop = prop.trim();
        if matches!(
            prop,
            "writing-mode" | "-epub-writing-mode" | "-webkit-writing-mode"
        ) {
            let val = val.trim();
            if val.starts_with("vertical-rl") {
                return Some("vertical-rl");
            }
            if val.starts_with("vertical-lr") {
                return Some("vertical-lr");
            }
        }
    }
    None
}

fn strip_css_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("*/") {
            rest = &rest[end + 2..];
        } else {
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn selector_targets_root_or_classes(selector_list: &str, root_classes: &HashSet<String>) -> bool {
    for sel in selector_list.split(',') {
        let s = sel.trim().to_ascii_lowercase();
        if s.is_empty() {
            continue;
        }
        // Only inspect single-element / root selectors (no descendant combinator targeting a child class)
        if s.contains(' ') || s.contains('>') || s.contains('+') || s.contains('~') {
            continue;
        }
        if matches!(s.as_str(), "html" | "body" | ":root") {
            return true;
        }
        if let Some(rest) = s.strip_prefix("html.") {
            if root_classes.contains(rest) {
                return true;
            }
        } else if let Some(rest) = s.strip_prefix("body.") {
            if root_classes.contains(rest) {
                return true;
            }
        } else if let Some(rest) = s.strip_prefix('.') {
            if root_classes.contains(rest) {
                return true;
            }
        }
    }
    false
}

fn detect_chapter_css_writing_mode(chapter_html: &str, linked_css: &str) -> Option<&'static str> {
    // 1. Inline style on <html> or <body>
    for tag_name in ["html", "body"] {
        if let Some(tag) = tag_with_name(chapter_html, tag_name) {
            if let Some(style) = xml_attr(&tag, "style") {
                if let Some(mode) = extract_vertical_mode_from_declaration(&style) {
                    return Some(mode);
                }
            }
        }
    }

    let mut root_classes = HashSet::new();
    for tag_name in ["html", "body"] {
        if let Some(tag) = tag_with_name(chapter_html, tag_name) {
            if let Some(cls) = xml_attr(&tag, "class") {
                for c in cls.split_whitespace() {
                    root_classes.insert(c.to_ascii_lowercase());
                }
            }
        }
    }

    let mut combined_css = String::new();
    combined_css.push_str(linked_css);
    combined_css.push('\n');
    combined_css.push_str(&extract_inline_style_blocks(chapter_html));
    let clean_css = strip_css_comments(&combined_css);

    let mut rest = clean_css.as_str();
    while let Some(open) = rest.find('{') {
        let selector = rest[..open].trim();
        rest = &rest[open + 1..];
        let Some(close) = rest.find('}') else {
            break;
        };
        let block = &rest[..close];
        rest = &rest[close + 1..];
        if selector.starts_with('@') {
            continue;
        }
        if selector_targets_root_or_classes(selector, &root_classes) {
            if let Some(mode) = extract_vertical_mode_from_declaration(block) {
                return Some(mode);
            }
        }
    }

    None
}

fn collect_toc_titles(
    zip: &mut ZipArchive<File>,
    manifest: &HashMap<String, ManifestItem>,
) -> HashMap<String, String> {
    let mut titles = HashMap::new();

    // 1. EPUB 3 Nav document (`properties="nav"`)
    if let Some(nav_item) = manifest.values().find(|item| {
        item.properties
            .split_whitespace()
            .any(|p| p.eq_ignore_ascii_case("nav"))
    }) {
        if let Ok(nav_html) = zip_read_to_string(zip, &nav_item.path) {
            let nav_base = nav_item
                .path
                .rsplit_once('/')
                .map(|(b, _)| b)
                .unwrap_or("");
            let mut in_toc_nav = false;
            let mut nav_depth = 0usize;
            let mut current_href: Option<String> = None;
            let mut current_label = String::new();

            for token in tokenize_html(&nav_html) {
                match token {
                    HtmlToken::Tag(tag) => {
                        let name = normalize_tag_name(tag);
                        let closing = is_closing_tag(tag);
                        if name == "nav" {
                            if closing {
                                if in_toc_nav {
                                    nav_depth = nav_depth.saturating_sub(1);
                                    if nav_depth == 0 {
                                        in_toc_nav = false;
                                    }
                                }
                            } else if !is_self_closing_tag(tag) {
                                let epub_type = xml_attr(tag, "epub:type")
                                    .or_else(|| xml_attr(tag, "type"))
                                    .unwrap_or_default()
                                    .to_lowercase();
                                if in_toc_nav || epub_type.split_whitespace().any(|t| t == "toc") {
                                    in_toc_nav = true;
                                    nav_depth += 1;
                                }
                            }
                        } else if in_toc_nav && name == "a" {
                            if closing {
                                if let Some(href) = current_href.take() {
                                    let label = normalize_text(&current_label);
                                    if !label.is_empty() {
                                        titles.entry(href).or_insert(label);
                                    }
                                }
                                current_label.clear();
                            } else if !is_self_closing_tag(tag) {
                                if let Some(href) = xml_attr(tag, "href") {
                                    current_href = Some(epub_join_path(nav_base, &href));
                                    current_label.clear();
                                }
                            }
                        }
                    }
                    HtmlToken::Text(t) => {
                        if current_href.is_some() {
                            current_label.push_str(t);
                        }
                    }
                }
            }
        }
    }

    if !titles.is_empty() {
        return titles;
    }

    // 2. EPUB 2 NCX (`application/x-dtbncx+xml`)
    if let Some(ncx_item) = manifest.values().find(|item| {
        item.media_type.eq_ignore_ascii_case("application/x-dtbncx+xml")
            || item.path.to_lowercase().ends_with(".ncx")
    }) {
        if let Ok(ncx_xml) = zip_read_to_string(zip, &ncx_item.path) {
            let ncx_base = ncx_item
                .path
                .rsplit_once('/')
                .map(|(b, _)| b)
                .unwrap_or("");
            let mut in_text = false;
            let mut label_buf = String::new();
            let mut last_label = String::new();

            for token in tokenize_html(&ncx_xml) {
                match token {
                    HtmlToken::Tag(tag) => {
                        let name = normalize_tag_name(tag);
                        let closing = is_closing_tag(tag);
                        if name == "text" {
                            if closing {
                                in_text = false;
                                let cleaned = decode_html_entities(&label_buf).trim().to_string();
                                if !cleaned.is_empty() {
                                    last_label = cleaned;
                                }
                                label_buf.clear();
                            } else if !is_self_closing_tag(tag) {
                                in_text = true;
                                label_buf.clear();
                            }
                        } else if !closing && name == "content" {
                            if let Some(src) = xml_attr(tag, "src") {
                                let target = epub_join_path(ncx_base, &src);
                                if !last_label.is_empty() {
                                    titles.entry(target).or_insert_with(|| last_label.clone());
                                    last_label.clear();
                                }
                            }
                        }
                    }
                    HtmlToken::Text(t) => {
                        if in_text {
                            label_buf.push_str(t);
                        }
                    }
                }
            }
        }
    }

    titles
}

fn build_sanitized_tag(
    name: &str,
    raw_attrs: &[(String, String)],
    self_closing: bool,
) -> String {
    let mut kept: Vec<(&str, String)> = Vec::new();
    for (attr_name, value) in raw_attrs {
        match attr_name.as_str() {
            "class" | "id" | "lang" | "dir" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    kept.push((
                        match attr_name.as_str() {
                            "class" => "class",
                            "id" => "id",
                            "lang" => "lang",
                            _ => "dir",
                        },
                        trimmed.to_string(),
                    ));
                }
            }
            "src" if name == "img" => {
                if is_safe_raster_data_url(value) {
                    kept.push(("src", value.trim().to_string()));
                }
            }
            "alt" if name == "img" => {
                kept.push(("alt", value.clone()));
            }
            "data-epub-href" if name == "a" => {
                if !value.trim().is_empty() {
                    kept.push(("data-epub-href", value.trim().to_string()));
                }
            }
            "colspan" if matches!(name, "td" | "th") => {
                if value.trim().parse::<u16>().map_or(false, |n| n > 0 && n <= 100) {
                    kept.push(("colspan", value.trim().to_string()));
                }
            }
            "rowspan" if matches!(name, "td" | "th") => {
                if value.trim().parse::<u16>().map_or(false, |n| n > 0 && n <= 100) {
                    kept.push(("rowspan", value.trim().to_string()));
                }
            }
            _ => {}
        }
    }

    let mut out = String::new();
    out.push('<');
    out.push_str(name);
    for (k, v) in kept {
        out.push(' ');
        out.push_str(k);
        out.push_str("=\"");
        out.push_str(&escape_attr(&v));
        out.push('"');
    }
    if is_void_tag(name) {
        if name == "br" {
            out.push_str(" />\n");
        } else {
            out.push_str(" />");
        }
    } else if self_closing {
        out.push_str("></");
        out.push_str(name);
        out.push('>');
    } else {
        out.push('>');
    }
    out
}

/// Allow-list HTML sanitizer for EPUB chapter bodies.
/// Drops all scripts, styles, event handlers, external URLs, SVGs, forms, and disallowed tags.
/// Converts safe raster `<svg><image href="..."/></svg>` illustrations into `<img src="data:image/...;base64,..."/>`.
#[cfg(test)]
pub fn sanitize_epub_html_without_zip(input: &str, chapter_base: &str, chapter_path: &str) -> String {
    sanitize_epub_html_inner(input, chapter_base, chapter_path, None, None)
}

fn sanitize_epub_html_inner(
    input: &str,
    chapter_base: &str,
    chapter_path: &str,
    mut zip: Option<&mut ZipArchive<File>>,
    mut image_cache: Option<&mut HashMap<String, String>>,
) -> String {
    let normalized = input.replace("\r\n", "\n");
    let (body, _, _) = html_body_parts(&normalized);
    let mut output = String::with_capacity(body.len());
    let mut drop_stack: Vec<String> = Vec::new();
    let mut in_svg = false;
    let mut svg_depth = 0usize;

    for token in tokenize_html(&body) {
        match token {
            HtmlToken::Text(text) => {
                if drop_stack.is_empty() && !in_svg {
                    output.push_str(text);
                }
            }
            HtmlToken::Tag(tag) => {
                let name = normalize_tag_name(tag);
                if name.is_empty() {
                    continue;
                }
                let closing = is_closing_tag(tag);
                let self_closing = is_self_closing_tag(tag);

                if name == "svg" {
                    if closing {
                        if in_svg {
                            svg_depth = svg_depth.saturating_sub(1);
                            if svg_depth == 0 {
                                in_svg = false;
                            }
                        }
                    } else if !self_closing {
                        in_svg = true;
                        svg_depth += 1;
                    }
                    continue;
                }

                // Inside <svg>, rescue raster <image xlink:href="..."> as a safe <img>, drop everything else.
                if in_svg {
                    if !closing && name == "image" {
                        let attrs = parse_tag_attributes(tag);
                        let raw_src = attrs
                            .iter()
                            .find(|(k, _)| matches!(k.as_str(), "href" | "xlink:href" | "src"))
                            .map(|(_, v)| v.clone());
                        if let Some(src) = raw_src {
                            let resolved = if is_safe_raster_data_url(&src) {
                                Some(src)
                            } else if let (Some(z), Some(cache)) = (zip.as_deref_mut(), image_cache.as_deref_mut()) {
                                let img_path = epub_join_path(chapter_base, &src);
                                zip_read_image_data_url(z, &img_path, cache)
                            } else {
                                None
                            };
                            if let Some(data_url) = resolved {
                                let img_attrs = vec![("src".to_string(), data_url)];
                                output.push_str(&build_sanitized_tag("img", &img_attrs, true));
                            }
                        }
                    }
                    continue;
                }

                if is_drop_content_tag(&name) {
                    if closing {
                        if let Some(pos) = drop_stack.iter().rposition(|t| t == &name) {
                            drop_stack.truncate(pos);
                        }
                    } else if !self_closing && !is_void_tag(&name) {
                        drop_stack.push(name);
                    }
                    continue;
                }

                if !drop_stack.is_empty() {
                    continue;
                }

                if !is_allowed_tag(&name) {
                    continue;
                }

                if closing {
                    if !is_void_tag(&name) {
                        output.push_str("</");
                        output.push_str(&name);
                        output.push('>');
                    }
                    continue;
                }

                let mut attrs = parse_tag_attributes(tag);

                if name == "img" {
                    let raw_src = attrs
                        .iter()
                        .find(|(k, _)| k == "src")
                        .map(|(_, v)| v.clone());
                    let resolved = raw_src.and_then(|src| {
                        if is_safe_raster_data_url(&src) {
                            Some(src)
                        } else if let (Some(z), Some(cache)) = (zip.as_deref_mut(), image_cache.as_deref_mut()) {
                            let img_path = epub_join_path(chapter_base, &src);
                            zip_read_image_data_url(z, &img_path, cache)
                        } else {
                            None
                        }
                    });
                    let Some(data_url) = resolved else {
                        continue;
                    };
                    attrs.retain(|(k, _)| k != "src");
                    attrs.push(("src".to_string(), data_url));
                    output.push_str(&build_sanitized_tag("img", &attrs, true));
                } else if name == "a" {
                    let href = attrs
                        .iter()
                        .find(|(k, _)| k == "href")
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default();
                    attrs.retain(|(k, _)| k != "href" && k != "data-epub-href");
                    if is_safe_internal_href(&href) {
                        let target = epub_join_href(chapter_base, chapter_path, &href);
                        if !target.is_empty() {
                            attrs.push(("data-epub-href".to_string(), target));
                        }
                    }
                    output.push_str(&build_sanitized_tag("a", &attrs, self_closing));
                } else {
                    output.push_str(&build_sanitized_tag(&name, &attrs, self_closing));
                }
            }
        }
    }

    output
}

fn is_container_block_tag(name: &str) -> bool {
    matches!(
        name,
        "div"
            | "section"
            | "article"
            | "aside"
            | "header"
            | "footer"
            | "nav"
            | "ul"
            | "ol"
            | "dl"
            | "figure"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
    )
}

fn is_leaf_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "blockquote" | "figcaption" | "dt" | "dd" | "pre" | "tr"
    )
}

fn block_kind_for_tag(name: &str, ancestor_tags: &[String]) -> String {
    if matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
        return "heading".to_string();
    }
    if name == "blockquote" || ancestor_tags.iter().any(|t| t == "blockquote") {
        return "blockquote".to_string();
    }
    if name == "li" || ancestor_tags.iter().any(|t| t == "li") {
        return "list-item".to_string();
    }
    "paragraph".to_string()
}

fn extract_standalone_image(html: &str) -> Option<(String, Option<String>)> {
    let mut found: Option<(String, Option<String>)> = None;
    for token in tokenize_html(html) {
        match token {
            HtmlToken::Text(t) => {
                if !t.trim().is_empty() {
                    return None;
                }
            }
            HtmlToken::Tag(tag) => {
                let name = normalize_tag_name(tag);
                if name == "img" && !is_closing_tag(tag) {
                    if found.is_some() {
                        return None;
                    }
                    let src = xml_attr(tag, "src")?;
                    let alt = xml_attr(tag, "alt").filter(|a| !a.trim().is_empty());
                    found = Some((src, alt));
                }
            }
        }
    }
    found
}

fn collect_ids_from_html(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for token in tokenize_html(html) {
        if let HtmlToken::Tag(tag) = token {
            if !is_closing_tag(tag) {
                if let Some(id) = xml_attr(tag, "id").filter(|v| !v.trim().is_empty()) {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
        }
    }
    ids
}

/// Splits sanitized chapter body HTML into discrete paragraph/block units.
/// Each text block corresponds to a single `.text-line` element in the reader.
pub fn extract_paragraphs(sanitized_body: &str) -> Vec<EpubParagraph> {
    let mut paragraphs: Vec<EpubParagraph> = Vec::new();
    let mut block_stack: Vec<String> = Vec::new();
    let mut pending_anchor_ids: Vec<String> = Vec::new();
    let mut buf_html = String::new();
    let mut buf_kind = "paragraph".to_string();
    let mut buf_open_inline: Vec<String> = Vec::new();
    let mut buf_block_id: Option<String> = None;

    let flush = |paragraphs: &mut Vec<EpubParagraph>,
                 buf_html: &mut String,
                 buf_kind: &mut String,
                 buf_open_inline: &mut Vec<String>,
                 buf_block_id: &mut Option<String>,
                 pending_anchor_ids: &mut Vec<String>| {
        if buf_html.trim().is_empty() {
            buf_html.clear();
            buf_open_inline.clear();
            *buf_block_id = None;
            return;
        }
        // Close any unclosed inline tags cleanly
        while let Some(open) = buf_open_inline.pop() {
            buf_html.push_str("</");
            buf_html.push_str(&open);
            buf_html.push('>');
        }

        let trimmed_html = buf_html.trim().to_string();
        let plain_text = normalize_text(&trimmed_html);
        let standalone_img = if plain_text.is_empty() {
            extract_standalone_image(&trimmed_html)
        } else {
            None
        };

        if plain_text.is_empty() && standalone_img.is_none() {
            buf_html.clear();
            *buf_block_id = None;
            return;
        }

        let mut anchor_ids = std::mem::take(pending_anchor_ids);
        if let Some(ref id) = *buf_block_id {
            if !anchor_ids.contains(id) {
                anchor_ids.push(id.clone());
            }
        }
        for id in collect_ids_from_html(&trimmed_html) {
            if !anchor_ids.contains(&id) {
                anchor_ids.push(id);
            }
        }
        let primary_id = buf_block_id
            .take()
            .or_else(|| anchor_ids.first().cloned());

        let index = paragraphs.len();
        if let Some((src, alt)) = standalone_img {
            paragraphs.push(EpubParagraph {
                index,
                id: primary_id,
                anchor_ids,
                kind: "image".to_string(),
                html: trimmed_html,
                text: String::new(),
                image_src: Some(src),
                image_alt: alt,
            });
        } else {
            paragraphs.push(EpubParagraph {
                index,
                id: primary_id,
                anchor_ids,
                kind: buf_kind.clone(),
                html: trimmed_html,
                text: plain_text,
                image_src: None,
                image_alt: None,
            });
        }

        buf_html.clear();
        *buf_kind = "paragraph".to_string();
    };

    for token in tokenize_html(sanitized_body) {
        match token {
            HtmlToken::Text(text) => {
                if buf_html.is_empty() && text.trim().is_empty() {
                    continue;
                }
                if buf_html.is_empty() {
                    buf_kind = block_stack
                        .last()
                        .map(|t| block_kind_for_tag(t, &block_stack))
                        .unwrap_or_else(|| "paragraph".to_string());
                }
                buf_html.push_str(text);
            }
            HtmlToken::Tag(tag) => {
                let name = normalize_tag_name(tag);
                if name.is_empty() {
                    continue;
                }
                let closing = is_closing_tag(tag);

                if name == "hr" {
                    flush(
                        &mut paragraphs,
                        &mut buf_html,
                        &mut buf_kind,
                        &mut buf_open_inline,
                        &mut buf_block_id,
                        &mut pending_anchor_ids,
                    );
                    let id = xml_attr(tag, "id").filter(|v| !v.trim().is_empty());
                    let mut anchor_ids = std::mem::take(&mut pending_anchor_ids);
                    if let Some(ref i) = id {
                        if !anchor_ids.contains(i) {
                            anchor_ids.push(i.clone());
                        }
                    }
                    let index = paragraphs.len();
                    paragraphs.push(EpubParagraph {
                        index,
                        id,
                        anchor_ids,
                        kind: "separator".to_string(),
                        html: "<hr />".to_string(),
                        text: String::new(),
                        image_src: None,
                        image_alt: None,
                    });
                    continue;
                }

                if is_container_block_tag(&name) || is_leaf_block_tag(&name) {
                    flush(
                        &mut paragraphs,
                        &mut buf_html,
                        &mut buf_kind,
                        &mut buf_open_inline,
                        &mut buf_block_id,
                        &mut pending_anchor_ids,
                    );
                    if closing {
                        if let Some(pos) = block_stack.iter().rposition(|t| t == &name) {
                            block_stack.truncate(pos);
                        }
                    } else {
                        if let Some(id) = xml_attr(tag, "id").filter(|v| !v.trim().is_empty()) {
                            if is_leaf_block_tag(&name) {
                                buf_block_id = Some(id);
                            } else if !pending_anchor_ids.contains(&id) {
                                pending_anchor_ids.push(id);
                            }
                        }
                        if !is_self_closing_tag(tag) {
                            let kind = block_kind_for_tag(&name, &block_stack);
                            block_stack.push(name);
                            buf_kind = kind;
                        }
                    }
                    continue;
                }

                // Inline tag (ruby, rt, rp, span, em, strong, a, img, br, etc.)
                if buf_html.is_empty() && !closing {
                    buf_kind = block_stack
                        .last()
                        .map(|t| block_kind_for_tag(t, &block_stack))
                        .unwrap_or_else(|| "paragraph".to_string());
                }
                if !closing && !is_void_tag(&name) && !is_self_closing_tag(tag) {
                    buf_open_inline.push(name);
                } else if closing {
                    if let Some(pos) = buf_open_inline.iter().rposition(|t| t == &name) {
                        buf_open_inline.truncate(pos);
                    }
                }
                buf_html.push_str(tag);
            }
        }
    }

    flush(
        &mut paragraphs,
        &mut buf_html,
        &mut buf_kind,
        &mut buf_open_inline,
        &mut buf_block_id,
        &mut pending_anchor_ids,
    );

    paragraphs
}

fn chapter_title_from_html(html: &str, fallback: &str) -> Option<String> {
    for tag in ["h1", "h2", "title"] {
        let lower = html.to_lowercase();
        let Some(start) = lower.find(&format!("<{}", tag)) else {
            continue;
        };
        let Some(open_end) = find_tag_end(&html[start..]) else {
            continue;
        };
        let content_start = start + open_end + 1;
        let Some(end_rel) = lower[content_start..].find(&format!("</{}>", tag)) else {
            continue;
        };
        let text = normalize_text(&html[content_start..content_start + end_rel]);
        if !text.is_empty() {
            return Some(text);
        }
    }
    Path::new(fallback)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
}

struct ParsedPackage {
    zip: ZipArchive<File>,
    opf: String,
    title: String,
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<(String, ManifestItem)>,
}

fn open_epub_package(path: &str) -> Result<ParsedPackage, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open EPUB: {}", e))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("EPUB zip error: {}", e))?;
    let container = zip_read_to_string(&mut zip, "META-INF/container.xml")?;
    let opf_path = find_epub_opf_path(&mut zip, &container)?;
    let opf = zip_read_to_string(&mut zip, &opf_path)?;
    let base_dir = opf_path
        .rsplit_once('/')
        .map(|(base, _)| base)
        .unwrap_or("");
    let title = title_from_opf(&opf, path);
    let manifest = collect_manifest(&opf, base_dir);
    let spine = spine_paths(&opf, &manifest)
        .into_iter()
        .take(MAX_EPUB_CHAPTERS)
        .collect();
    Ok(ParsedPackage {
        zip,
        opf,
        title,
        manifest,
        spine,
    })
}

pub fn epub_open_impl(path: String) -> Result<EpubBookMeta, String> {
    let mut pkg = open_epub_package(&path)?;
    let toc_titles = collect_toc_titles(&mut pkg.zip, &pkg.manifest);
    let metadata_languages = languages_from_opf(&pkg.opf);
    let page_progression_direction = page_progression_direction_from_opf(&pkg.opf);
    let primary_writing_mode = primary_writing_mode_from_opf(&pkg.opf);

    let mut css_cache: HashMap<String, String> = HashMap::new();
    let mut css_writing_mode: Option<String> = None;
    let mut text_sample = String::new();
    let mut chapters = Vec::new();

    for (spine_idx, (id, item)) in pkg.spine.iter().enumerate() {
        let Ok(chapter_html) = zip_read_to_string(&mut pkg.zip, &item.path) else {
            continue;
        };

        if spine_idx < MAX_CSS_INSPECT_CHAPTERS && css_writing_mode.is_none() {
            let chapter_base = item
                .path
                .rsplit_once('/')
                .map(|(b, _)| b)
                .unwrap_or("");
            let mut linked_css = String::new();
            for css_path in css_links(&chapter_html, chapter_base) {
                if !css_cache.contains_key(&css_path) {
                    if let Ok(css_text) = zip_read_to_string(&mut pkg.zip, &css_path) {
                        css_cache.insert(css_path.clone(), css_text);
                    }
                }
                if let Some(css_text) = css_cache.get(&css_path) {
                    linked_css.push_str(css_text);
                    linked_css.push('\n');
                }
            }
            if let Some(mode) = detect_chapter_css_writing_mode(&chapter_html, &linked_css) {
                css_writing_mode = Some(mode.to_string());
            }
        }

        if text_sample.chars().count() < LANGUAGE_SAMPLE_CHARS {
            let (body, _, _) = html_body_parts(&chapter_html);
            let plain = normalize_text(&body);
            if !plain.is_empty() {
                if !text_sample.is_empty() {
                    text_sample.push(' ');
                }
                text_sample.push_str(&plain);
            }
        }

        let resolved_title = toc_titles
            .get(&item.path)
            .cloned()
            .or_else(|| chapter_title_from_html(&chapter_html, &item.href));

        chapters.push(EpubChapterMeta {
            index: spine_idx,
            id: id.clone(),
            href: item.path.clone(),
            title: resolved_title,
        });
    }

    if chapters.is_empty() {
        return Err("EPUB opened, but no readable chapters were found.".to_string());
    }

    let (language, metadata_language) = detect_book_language(&metadata_languages, &text_sample);

    let default_vertical = if page_progression_direction.as_deref() == Some("rtl") {
        true
    } else if let Some(ref pwm) = primary_writing_mode {
        pwm.contains("vertical")
    } else {
        css_writing_mode
            .as_deref()
            .map_or(false, |mode| mode.contains("vertical"))
    };

    let cover = extract_cover_data_url(&mut pkg);

    Ok(EpubBookMeta {
        title: pkg.title,
        language: language.to_string(),
        metadata_language,
        page_progression_direction,
        primary_writing_mode,
        css_writing_mode,
        default_vertical,
        chapters,
        cover,
    })
}

pub fn epub_chapter_impl(path: String, index: usize) -> Result<EpubChapterContent, String> {
    let mut pkg = open_epub_package(&path)?;
    let (id, item) = pkg
        .spine
        .get(index)
        .cloned()
        .ok_or_else(|| format!("EPUB chapter index {} out of bounds", index))?;
    let toc_titles = collect_toc_titles(&mut pkg.zip, &pkg.manifest);
    let chapter_html = zip_read_to_string(&mut pkg.zip, &item.path)?;
    let chapter_base = item
        .path
        .rsplit_once('/')
        .map(|(b, _)| b)
        .unwrap_or("");
    let mut image_cache = HashMap::new();
    let sanitized_html = sanitize_epub_html_inner(
        &chapter_html,
        chapter_base,
        &item.path,
        Some(&mut pkg.zip),
        Some(&mut image_cache),
    );
    let paragraphs = extract_paragraphs(&sanitized_html);
    let text = paragraphs
        .iter()
        .filter(|p| !p.text.is_empty())
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let title = toc_titles
        .get(&item.path)
        .cloned()
        .or_else(|| chapter_title_from_html(&chapter_html, &item.href));

    Ok(EpubChapterContent {
        index,
        id,
        href: item.path,
        title,
        html: sanitized_html,
        text,
        paragraphs,
    })
}

fn import_epub_impl(path: String) -> Result<EpubImportResult, String> {
    let meta = epub_open_impl(path.clone())?;
    let mut pkg = open_epub_package(&path)?;
    let mut chapters = Vec::new();
    let mut lines = Vec::new();

    for chapter_meta in &meta.chapters {
        let Some((id, item)) = pkg.spine.get(chapter_meta.index).cloned() else {
            continue;
        };
        let Ok(chapter_html) = zip_read_to_string(&mut pkg.zip, &item.path) else {
            continue;
        };
        let chapter_base = item
            .path
            .rsplit_once('/')
            .map(|(base, _)| base)
            .unwrap_or("");
        let (_, body_class, html_class) = html_body_parts(&chapter_html);
        let mut image_cache = HashMap::new();
        let html = sanitize_epub_html_inner(
            &chapter_html,
            chapter_base,
            &item.path,
            Some(&mut pkg.zip),
            Some(&mut image_cache),
        );
        let paragraphs = extract_paragraphs(&html);
        let text = paragraphs
            .iter()
            .filter(|p| !p.text.is_empty())
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        for p in &paragraphs {
            if !p.text.is_empty() && lines.len() < MAX_EPUB_LINES {
                lines.push(p.text.clone());
            }
        }
        if paragraphs.is_empty() && html.trim().is_empty() {
            continue;
        }

        chapters.push(EpubChapter {
            id,
            href: item.path,
            title: chapter_meta.title.clone(),
            html,
            css: String::new(),
            text,
            body_class,
            html_class,
        });
    }

    if chapters.is_empty() {
        return Err("EPUB imported, but no readable chapters were found.".to_string());
    }

    Ok(EpubImportResult {
        title: meta.title,
        language: meta.language,
        page_progression_direction: meta.page_progression_direction,
        primary_writing_mode: meta.primary_writing_mode,
        default_vertical: meta.default_vertical,
        lines,
        chapters,
    })
}

fn stored_book_path(dir: &Path, tab_id: i64) -> PathBuf {
    dir.join(format!("{tab_id}.epub"))
}

fn store_epub_file(dir: &Path, source_path: &str, tab_id: i64) -> Result<String, String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create epub-books folder: {}", e))?;
    let src = Path::new(source_path);
    if !src.is_file() {
        return Err(format!("EPUB file does not exist: {}", source_path));
    }
    let dest = stored_book_path(dir, tab_id);
    // Avoid self-copy if already stored at the target path
    if let (Ok(src_canon), Ok(dest_canon)) = (std::fs::canonicalize(src), std::fs::canonicalize(&dest)) {
        if src_canon == dest_canon {
            return Ok(dest.to_string_lossy().to_string());
        }
    }
    let tmp = dest.with_extension("epub.tmp");
    std::fs::copy(src, &tmp).map_err(|e| format!("Failed to copy EPUB: {}", e))?;
    if dest.exists() {
        std::fs::remove_file(&dest).ok();
    }
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to store EPUB: {}", e)
    })?;
    Ok(dest.to_string_lossy().to_string())
}

fn prune_epub_files(dir: &Path, keep: &[i64]) -> Result<usize, String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("epub") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(id) = stem.parse::<i64>() else {
            continue;
        };
        if !keep.contains(&id) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn epub_books_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::get_data_path(app, "epub-books")
}

#[tauri::command]
pub async fn epub_store(
    app: tauri::AppHandle,
    path: String,
    tab_id: i64,
) -> Result<String, String> {
    let dir = epub_books_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || store_epub_file(&dir, &path, tab_id))
        .await
        .map_err(|e| format!("EPUB store task failed: {}", e))?
}

#[tauri::command]
pub async fn epub_prune(app: tauri::AppHandle, keep_ids: Vec<i64>) -> Result<usize, String> {
    let dir = epub_books_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || prune_epub_files(&dir, &keep_ids))
        .await
        .map_err(|e| format!("EPUB prune task failed: {}", e))?
}

pub fn epub_cover_impl(path: String) -> Result<Option<String>, String> {
    let mut pkg = open_epub_package(&path)?;
    Ok(extract_cover_data_url(&mut pkg))
}

#[tauri::command]
pub async fn epub_cover(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || epub_cover_impl(path))
        .await
        .map_err(|e| format!("EPUB cover task failed: {}", e))?
}

#[tauri::command]
pub async fn epub_open(path: String) -> Result<EpubBookMeta, String> {
    tauri::async_runtime::spawn_blocking(move || epub_open_impl(path))
        .await
        .map_err(|e| format!("EPUB open task failed: {}", e))?
}

#[tauri::command]
pub async fn epub_chapter(path: String, index: usize) -> Result<EpubChapterContent, String> {
    tauri::async_runtime::spawn_blocking(move || epub_chapter_impl(path, index))
        .await
        .map_err(|e| format!("EPUB chapter task failed: {}", e))?
}

#[tauri::command]
pub async fn import_epub(path: String) -> Result<EpubImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_epub_impl(path))
        .await
        .map_err(|e| format!("EPUB import task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    fn temp_path(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("setsuna-epub-{}-{}-{}", std::process::id(), nanos, name))
    }

    fn build_test_epub(entries: &[(&str, &[u8])]) -> PathBuf {
        let path = temp_path("book.epub");
        let file = File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = FileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    const CONTAINER_XML: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE,
    ];

    #[test]
    fn parses_language_tags_and_character_fallback() {
        assert_eq!(parse_language_tag("ja"), Some("ja"));
        assert_eq!(parse_language_tag("ja-JP"), Some("ja"));
        assert_eq!(parse_language_tag("JPN"), Some("ja"));
        assert_eq!(parse_language_tag("en-US"), Some("en"));
        assert_eq!(parse_language_tag("eng"), Some("en"));
        assert_eq!(parse_language_tag("fr-FR"), None);

        assert_eq!(detect_language_from_sample("吾輩は猫である。名前はまだ無い。"), "ja");
        // Kanji alone (Chinese) must not be classified as Japanese
        assert_eq!(detect_language_from_sample("天地玄黄宇宙洪荒日月盈昃"), "en");
        assert_eq!(detect_language_from_sample("It was the best of times, it was the worst of times."), "en");

        // First recognized tag wins
        let (lang, raw) = detect_book_language(
            &["fr".to_string(), "ja-JP".to_string(), "en".to_string()],
            "Hello world",
        );
        assert_eq!(lang, "ja");
        assert_eq!(raw.as_deref(), Some("ja-JP"));

        // Overwhelmingly Japanese text overrides mislabelled `en` metadata
        let jp_text = "これは日本語の小説の本文です。ひらがなとカタカナがたくさん含まれています。物語は静かな夜から始まります。";
        let (lang, _) = detect_book_language(&["en".to_string()], jp_text);
        assert_eq!(lang, "ja");

        // English book quoting a few Japanese words keeps `en`
        let en_with_quote = "She greeted him with こんにちは and then continued walking down the busy London street talking about weather and tea.";
        let (lang, _) = detect_book_language(&["en".to_string()], en_with_quote);
        assert_eq!(lang, "en");
    }

    #[test]
    fn ruby_readings_are_excluded_from_plain_text() {
        let html = "<p><ruby><rb>漢字</rb><rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>を読む。</p>";
        assert_eq!(normalize_text(html), "漢字を読む。");
        let html2 = "<p><ruby>明日<rt>あした</rt></ruby>は<ruby>晴<rt>は</rt></ruby>れ。</p>";
        assert_eq!(normalize_text(html2), "明日は晴れ。");
    }

    #[test]
    fn allow_list_sanitizer_strips_xss_styles_and_external_urls() {
        let dirty = r#"
            <html><head><style>body { color: red; }</style><link rel="stylesheet" href="a.css"/><base href="https://evil.example/"/></head>
            <body>
                <script>window.__TAURI__.invoke('read_file_bytes')</script>
                <iframe src="https://evil.example"></iframe>
                <form action="/steal"><input value="x"/><button onclick="evil()">go</button></form>
                <p id="p1" class="lead" style="position:fixed" onmouseover="alert(1)" onclick="alert(2)">
                    <ruby>猫<rt>ねこ</rt></ruby>
                    <a href="javascript:alert(1)" onclick="evil()">bad link</a>
                    <a href="ch2.xhtml#sec1" target="_blank">good link</a>
                    <img src="https://evil.example/track.png" onerror="alert(1)"/>
                    <img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg"/>
                </p>
                <svg onload="alert(1)"><script>evil()</script></svg>
            </body></html>
        "#;
        let clean = sanitize_epub_html_without_zip(dirty, "OEBPS/Text", "OEBPS/Text/ch1.xhtml");
        assert!(!clean.contains("script"));
        assert!(!clean.contains("iframe"));
        assert!(!clean.contains("style="));
        assert!(!clean.contains("onmouseover"));
        assert!(!clean.contains("onclick"));
        assert!(!clean.contains("onerror"));
        assert!(!clean.contains("javascript:"));
        assert!(!clean.contains("evil.example"));
        assert!(!clean.contains("svg"));
        assert!(!clean.contains("form"));
        assert!(!clean.contains("button"));
        assert!(!clean.contains(" href=\""));
        assert!(clean.contains("data-epub-href=\"OEBPS/Text/ch2.xhtml#sec1\""));
        assert!(clean.contains("<ruby>猫<rt>ねこ</rt></ruby>"));
        assert!(clean.contains("id=\"p1\""));

        let poem = sanitize_epub_html_without_zip("<p>to<br/>be</p>", "OEBPS", "OEBPS/ch1.xhtml");
        assert!(poem.contains("<br />\nbe"));
    }

    #[test]
    fn opens_japanese_vertical_epub_loads_paragraphs_and_images() {
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テスト小説</dc:title>
    <dc:language>ja-JP</dc:language>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="Images/pic.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="ch1"/>
  </spine>
</package>"#.as_bytes();

        let nav = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">第一章 始まり</a></li></ol></nav></body>
</html>"#.as_bytes();

        let ch1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1 id="top">第一章</h1>
    <p id="p1"><ruby>吾輩<rt>わがはい</rt></ruby>は猫である。</p>
    <p>名前はまだ無い。</p>
    <figure><svg><image xlink:href="../Images/pic.png"/></svg></figure>
  </body>
</html>"#.as_bytes();

        let path = build_test_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf),
            ("OEBPS/nav.xhtml", nav),
            ("OEBPS/Text/ch1.xhtml", ch1),
            ("OEBPS/Images/pic.png", TINY_PNG),
        ]);

        let meta = epub_open_impl(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(meta.title, "テスト小説");
        assert_eq!(meta.language, "ja");
        assert_eq!(meta.metadata_language.as_deref(), Some("ja-JP"));
        assert_eq!(meta.page_progression_direction.as_deref(), Some("rtl"));
        assert_eq!(meta.primary_writing_mode.as_deref(), Some("vertical-rl"));
        assert!(meta.default_vertical);
        assert!(meta.cover.as_deref().unwrap_or("").starts_with("data:image/png;base64,"));
        assert_eq!(meta.chapters.len(), 1);
        assert_eq!(meta.chapters[0].title.as_deref(), Some("第一章 始まり"));

        let chapter = epub_chapter_impl(path.to_string_lossy().to_string(), 0).unwrap();
        assert_eq!(chapter.paragraphs.len(), 4);
        assert_eq!(chapter.paragraphs[0].kind, "heading");
        assert_eq!(chapter.paragraphs[0].text, "第一章");
        assert_eq!(chapter.paragraphs[0].id.as_deref(), Some("top"));
        assert_eq!(chapter.paragraphs[1].kind, "paragraph");
        assert_eq!(chapter.paragraphs[1].text, "吾輩は猫である。");
        assert!(chapter.paragraphs[1].html.contains("<rt>わがはい</rt>"));
        assert_eq!(chapter.paragraphs[2].text, "名前はまだ無い。");
        assert_eq!(chapter.paragraphs[3].kind, "image");
        assert!(chapter.paragraphs[3]
            .image_src
            .as_deref()
            .unwrap_or("")
            .starts_with("data:image/png;base64,"));

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn detects_vertical_mode_from_chapter_css_when_opf_omits_it() {
        let opf = br#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>CSS Vertical</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css1" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>"#;

        let css = b"html.vrtl { -epub-writing-mode: vertical-rl; writing-mode: vertical-rl; }";
        let ch1 = r#"<html class="vrtl"><head><link rel="stylesheet" href="style.css"/></head><body><p>静かな森の中で鳥が鳴いている。</p></body></html>"#.as_bytes();

        let path = build_test_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf),
            ("OEBPS/style.css", css),
            ("OEBPS/ch1.xhtml", ch1),
        ]);

        let meta = epub_open_impl(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(meta.language, "ja");
        assert_eq!(meta.page_progression_direction, None);
        assert_eq!(meta.css_writing_mode.as_deref(), Some("vertical-rl"));
        assert!(meta.default_vertical);

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn stores_and_prunes_epub_files() {
        let dir = temp_path("store-dir");
        let src = temp_path("source.epub");
        std::fs::write(&src, b"fake-epub-bytes").unwrap();

        let stored = store_epub_file(&dir, &src.to_string_lossy(), 42).unwrap();
        assert_eq!(std::fs::read(&stored).unwrap(), b"fake-epub-bytes");
        // Storing same path again is a safe no-op
        let stored_again = store_epub_file(&dir, &stored, 42).unwrap();
        assert_eq!(stored_again, stored);

        let _ = store_epub_file(&dir, &src.to_string_lossy(), 99).unwrap();
        assert_eq!(prune_epub_files(&dir, &[42]).unwrap(), 1);
        assert!(Path::new(&stored).exists());
        assert!(!dir.join("99.epub").exists());

        std::fs::remove_file(src).ok();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn extracts_cover_from_first_chapter_fallback() {
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Cover Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/front.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>"#;

        // 1x1 PNG
        let mut png_bytes = Vec::new();
        let img = image::DynamicImage::new_rgb8(2, 3);
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        let ch1 = br#"<html><body><div><img src="images/front.png" alt="Cover"/></div><p>Hello world.</p></body></html>"#;

        let path = build_test_epub(&[
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf),
            ("OEBPS/ch1.xhtml", ch1),
            ("OEBPS/images/front.png", &png_bytes),
        ]);

        let cover = epub_cover_impl(path.to_string_lossy().to_string()).unwrap();
        assert!(cover.as_deref().is_some_and(|s| s.starts_with("data:image/jpeg;base64,")));

        std::fs::remove_file(path).ok();
    }
}
