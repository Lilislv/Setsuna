use base64::{engine::general_purpose, Engine as _};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use zip::ZipArchive;

const MAX_EPUB_LINES: usize = 8000;
const MAX_EPUB_CHAPTERS: usize = 400;
const MAX_EPUB_IMAGES: usize = 64;
const MAX_EPUB_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone)]
struct ManifestItem {
    href: String,
    path: String,
    media_type: String,
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
    lines: Vec<String>,
    chapters: Vec<EpubChapter>,
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn strip_xml_tags(input: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_html_entities(&out)
}

fn normalize_text(input: &str) -> String {
    strip_xml_tags(input)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn escape_attr(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn find_attr_span(tag: &str, name: &str) -> Option<(usize, usize, String)> {
    let lower = tag.to_lowercase();
    let name_lower = name.to_lowercase();
    let bytes = tag.as_bytes();
    let mut offset = 0usize;

    while let Some(found) = lower[offset..].find(&name_lower) {
        let start = offset + found;
        let before = start.checked_sub(1).and_then(|idx| bytes.get(idx)).copied();
        let after_name = start + name_lower.len();
        let after = bytes.get(after_name).copied();
        let before_ok = before.map_or(true, |b| {
            !b.is_ascii_alphanumeric() && b != b'-' && b != b'_'
        });
        let after_ok = after.map_or(false, |b| b.is_ascii_whitespace() || b == b'=');
        if !before_ok || !after_ok {
            offset = after_name;
            continue;
        }

        let mut idx = after_name;
        while bytes.get(idx).map_or(false, |b| b.is_ascii_whitespace()) {
            idx += 1;
        }
        if bytes.get(idx) != Some(&b'=') {
            offset = idx;
            continue;
        }
        idx += 1;
        while bytes.get(idx).map_or(false, |b| b.is_ascii_whitespace()) {
            idx += 1;
        }
        let quote = bytes.get(idx).copied()?;
        if quote != b'"' && quote != b'\'' {
            offset = idx + 1;
            continue;
        }
        let value_start = idx + 1;
        let value_end_rel = bytes[value_start..].iter().position(|b| *b == quote)?;
        let value_end = value_start + value_end_rel;
        let attr_end = value_end + 1;
        return Some((
            start,
            attr_end,
            decode_html_entities(&tag[value_start..value_end]),
        ));
    }

    None
}

fn xml_attr(tag: &str, name: &str) -> Option<String> {
    find_attr_span(tag, name).map(|(_, _, value)| value)
}

fn set_attr(tag: &str, name: &str, value: &str) -> String {
    if let Some((start, end, _)) = find_attr_span(tag, name) {
        let mut out = String::with_capacity(tag.len() + value.len() + name.len() + 4);
        out.push_str(&tag[..start]);
        out.push_str(name);
        out.push_str("=\"");
        out.push_str(&escape_attr(value));
        out.push('"');
        out.push_str(&tag[end..]);
        out
    } else if let Some(close) = tag.rfind('>') {
        let mut out = String::with_capacity(tag.len() + value.len() + name.len() + 5);
        out.push_str(&tag[..close]);
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        out.push_str(&escape_attr(value));
        out.push('"');
        out.push_str(&tag[close..]);
        out
    } else {
        tag.to_string()
    }
}

fn remove_attr(tag: &str, name: &str) -> String {
    if let Some((start, end, _)) = find_attr_span(tag, name) {
        let mut out = String::with_capacity(tag.len());
        out.push_str(&tag[..start]);
        out.push_str(&tag[end..]);
        out
    } else {
        tag.to_string()
    }
}

fn remove_html_block(mut text: String, tag: &str) -> String {
    let start_pat = format!("<{}", tag);
    let end_pat = format!("</{}>", tag);
    loop {
        let lower = text.to_lowercase();
        let Some(start) = lower.find(&start_pat) else {
            break;
        };
        let Some(end_rel) = lower[start..].find(&end_pat) else {
            break;
        };
        let end = start + end_rel + end_pat.len();
        text.replace_range(start..end, " ");
    }
    text
}

fn normalize_tag_name(raw: &str) -> String {
    raw.trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start_matches('!')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('>')
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn tag_with_name(input: &str, name: &str) -> Option<String> {
    let lower = input.to_lowercase();
    let start = lower.find(&format!("<{}", name))?;
    let end = input[start..].find('>')?;
    Some(input[start..=start + end].to_string())
}

fn html_body_parts(input: &str) -> (String, Option<String>, Option<String>) {
    let html_class = tag_with_name(input, "html").and_then(|tag| xml_attr(&tag, "class"));
    let lower = input.to_lowercase();
    let Some(body_start) = lower.find("<body") else {
        return (input.to_string(), None, html_class);
    };
    let Some(open_end_rel) = input[body_start..].find('>') else {
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
    if href.starts_with('#') {
        return format!("{}{}", current_path, href);
    }

    let (path_part, fragment) = href
        .split_once('#')
        .map(|(path, fragment)| (path, Some(fragment)))
        .unwrap_or((href, None));
    let path = epub_join_path(base, path_part);
    match fragment {
        Some(fragment) if !fragment.is_empty() => format!("{}#{}", path, fragment),
        _ => path,
    }
}

fn mime_from_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

fn zip_read_to_string(zip: &mut ZipArchive<File>, path: &str) -> Result<String, String> {
    let mut file = zip
        .by_name(path)
        .map_err(|e| format!("EPUB file not found {}: {}", path, e))?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("EPUB read error {}: {}", path, e))?;
    Ok(text)
}

fn zip_read_image_data_url(
    zip: &mut ZipArchive<File>,
    path: &str,
    cache: &mut HashMap<String, String>,
) -> Option<String> {
    if let Some(cached) = cache.get(path) {
        return Some(cached.clone());
    }
    if cache.len() >= MAX_EPUB_IMAGES {
        return None;
    }
    let mut file = zip.by_name(path).ok()?;
    if file.size() > MAX_EPUB_IMAGE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).ok()?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    let data_url = format!("data:{};base64,{}", mime_from_path(path), encoded);
    cache.insert(path.to_string(), data_url.clone());
    Some(data_url)
}

fn find_epub_opf_path(zip: &mut ZipArchive<File>, container: &str) -> Result<String, String> {
    for part in container.split('<') {
        let part = part.trim_start();
        if !part.starts_with("rootfile") || part.starts_with("rootfiles") {
            continue;
        }
        if let Some(path) = xml_attr(part, "full-path").filter(|value| !value.trim().is_empty()) {
            return Ok(path);
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
    for part in opf.split('<') {
        let part = part.trim_start();
        if !part.starts_with("item ") {
            continue;
        }
        let Some(id) = xml_attr(part, "id") else {
            continue;
        };
        let Some(href) = xml_attr(part, "href") else {
            continue;
        };
        let media_type = xml_attr(part, "media-type").unwrap_or_default();
        manifest.insert(
            id,
            ManifestItem {
                path: epub_join_path(base_dir, &href),
                href,
                media_type,
            },
        );
    }
    manifest
}

fn spine_paths(opf: &str, manifest: &HashMap<String, ManifestItem>) -> Vec<(String, ManifestItem)> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for part in opf.split('<') {
        let part = part.trim_start();
        if !part.starts_with("itemref ") {
            continue;
        }
        let Some(idref) = xml_attr(part, "idref") else {
            continue;
        };
        let Some(item) = manifest.get(&idref) else {
            continue;
        };
        let lower = item.path.to_lowercase();
        if !(item.media_type.contains("xhtml")
            || item.media_type.contains("html")
            || lower.ends_with(".xhtml")
            || lower.ends_with(".html"))
        {
            continue;
        }
        if seen.insert(item.path.clone()) {
            paths.push((idref, item.clone()));
        }
    }
    paths
}

fn title_from_opf(opf: &str, fallback_path: &str) -> String {
    opf.split("<dc:title")
        .nth(1)
        .and_then(|rest| rest.split('>').nth(1))
        .and_then(|rest| rest.split("</dc:title>").next())
        .map(strip_xml_tags)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::path::Path::new(fallback_path)
                .file_stem()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "EPUB".to_string())
}

fn css_links(input: &str, chapter_base: &str) -> Vec<String> {
    let mut links = Vec::new();
    for part in input.split('<') {
        let part = part.trim_start();
        if !part.to_lowercase().starts_with("link ") {
            continue;
        }
        let rel = xml_attr(part, "rel").unwrap_or_default().to_lowercase();
        let href = xml_attr(part, "href").unwrap_or_default();
        if href.is_empty()
            || (!rel.contains("stylesheet") && !href.to_lowercase().ends_with(".css"))
        {
            continue;
        }
        links.push(epub_join_path(chapter_base, &href));
    }
    links
}

fn sanitize_tag_for_epub(tag: &str) -> Option<String> {
    let name = normalize_tag_name(tag);
    let blocked = [
        "script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select",
    ];
    if blocked.contains(&name.as_str()) {
        return None;
    }
    let mut clean = tag.to_string();
    for event in [
        "onclick",
        "onload",
        "onerror",
        "onmouseover",
        "onmouseenter",
        "onmouseleave",
        "onfocus",
        "onblur",
    ] {
        clean = remove_attr(&clean, event);
    }
    clean = remove_attr(&clean, "style");
    Some(clean)
}

fn rewrite_epub_html(
    input: &str,
    chapter_base: &str,
    chapter_path: &str,
    zip: &mut ZipArchive<File>,
    image_cache: &mut HashMap<String, String>,
) -> String {
    let mut html = input.replace("\r\n", "\n");
    html = remove_html_block(html, "script");
    let (body, _, _) = html_body_parts(&html);

    let mut output = String::with_capacity(body.len());
    let mut rest = body.as_str();

    while let Some(tag_start) = rest.find('<') {
        output.push_str(&rest[..tag_start]);
        rest = &rest[tag_start..];
        let Some(tag_end) = rest.find('>') else {
            break;
        };
        let tag = &rest[..=tag_end];
        let name = normalize_tag_name(tag);
        let closing = tag.trim_start().starts_with("</");

        if closing {
            output.push_str(tag);
            rest = &rest[tag_end + 1..];
            continue;
        }

        if name == "img" || name == "image" {
            let src_attr = if xml_attr(tag, "src").is_some() {
                "src"
            } else if xml_attr(tag, "href").is_some() {
                "href"
            } else {
                "xlink:href"
            };
            if let Some(src) = xml_attr(tag, src_attr) {
                let image_path = epub_join_path(chapter_base, &src);
                if let Some(data_url) = zip_read_image_data_url(zip, &image_path, image_cache) {
                    let mut rewritten = set_attr(tag, src_attr, &data_url);
                    if name == "image" && src_attr != "href" {
                        rewritten = set_attr(&rewritten, "href", &data_url);
                    }
                    if let Some(clean) = sanitize_tag_for_epub(&rewritten) {
                        output.push_str(&clean);
                    }
                }
            }
        } else if name == "a" {
            let href = xml_attr(tag, "href").unwrap_or_default();
            let target = if href.trim().is_empty() {
                String::new()
            } else {
                epub_join_href(chapter_base, chapter_path, &href)
            };
            let rewritten = set_attr(&remove_attr(tag, "href"), "data-epub-href", &target);
            if let Some(clean) = sanitize_tag_for_epub(&rewritten) {
                output.push_str(&clean);
            }
        } else if let Some(clean) = sanitize_tag_for_epub(tag) {
            output.push_str(&clean);
        }

        rest = &rest[tag_end + 1..];
    }

    output.push_str(rest);
    output
}

fn chapter_title(html: &str, fallback: &str) -> Option<String> {
    for tag in ["h1", "h2", "title"] {
        let lower = html.to_lowercase();
        let Some(start) = lower.find(&format!("<{}", tag)) else {
            continue;
        };
        let Some(open_end) = lower[start..].find('>') else {
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
    std::path::Path::new(fallback)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
}

fn import_epub_impl(path: String) -> Result<EpubImportResult, String> {
    let file = File::open(&path).map_err(|e| format!("Failed to open EPUB: {}", e))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("EPUB zip error: {}", e))?;
    let container = zip_read_to_string(&mut zip, "META-INF/container.xml")?;
    let opf_path = find_epub_opf_path(&mut zip, &container)?;
    let opf = zip_read_to_string(&mut zip, &opf_path)?;
    let base_dir = opf_path
        .rsplit_once('/')
        .map(|(base, _)| base)
        .unwrap_or("");

    let title = title_from_opf(&opf, &path);
    let manifest = collect_manifest(&opf, base_dir);
    let spine = spine_paths(&opf, &manifest);
    let mut image_cache = HashMap::new();
    let mut css_cache = HashMap::<String, String>::new();
    let mut chapters = Vec::new();
    let mut lines = Vec::new();

    for (id, item) in spine.into_iter().take(MAX_EPUB_CHAPTERS) {
        let Ok(chapter_html) = zip_read_to_string(&mut zip, &item.path) else {
            continue;
        };
        let chapter_base = item
            .path
            .rsplit_once('/')
            .map(|(base, _)| base)
            .unwrap_or("");
        let (_, body_class, html_class) = html_body_parts(&chapter_html);
        let mut css = String::new();
        for css_path in css_links(&chapter_html, chapter_base) {
            if !css_cache.contains_key(&css_path) {
                if let Ok(css_text) = zip_read_to_string(&mut zip, &css_path) {
                    css_cache.insert(css_path.clone(), css_text);
                }
            }
            if let Some(css_text) = css_cache.get(&css_path) {
                css.push_str(css_text);
                css.push('\n');
            }
        }

        let html = rewrite_epub_html(
            &chapter_html,
            chapter_base,
            &item.path,
            &mut zip,
            &mut image_cache,
        );
        let text = normalize_text(&html);
        if !text.is_empty() && lines.len() < MAX_EPUB_LINES {
            lines.push(text.clone());
        }
        if html.trim().is_empty() && text.is_empty() {
            continue;
        }

        chapters.push(EpubChapter {
            id,
            href: item.path.clone(),
            title: chapter_title(&chapter_html, &item.href),
            html,
            css,
            text,
            body_class,
            html_class,
        });
    }

    if chapters.is_empty() {
        return Err("EPUB imported, but no readable chapters were found.".to_string());
    }

    Ok(EpubImportResult {
        title,
        lines,
        chapters,
    })
}

#[tauri::command]
pub async fn import_epub(path: String) -> Result<EpubImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_epub_impl(path))
        .await
        .map_err(|e| format!("EPUB import task failed: {}", e))?
}
