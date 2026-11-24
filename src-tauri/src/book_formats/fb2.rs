use super::*;
use roxmltree::{Document, Node};
use std::collections::HashMap;

/// Parses an `.fb2` or `.fb2.zip` FictionBook 2.0 file into structured chapters, ToC,
/// metadata (title, author, series/sequence, language), cover image, embedded illustrations,
/// and notes.
pub(in crate::epub_import) fn parse_fb2_book(
    path: &str,
    include_images: bool,
) -> Result<ParsedBook, String> {
    let xml_bytes = read_fb2_bytes(path)?;
    let decoded = decode_xml_bytes(&xml_bytes);
    let cleaned = sanitize_fb2_xml_for_parse(&decoded);
    let escaped_buf;
    let doc = match Document::parse(&cleaned) {
        Ok(d) => d,
        Err(_) => {
            escaped_buf = escape_stray_xml_ampersands(&cleaned);
            Document::parse(&escaped_buf)
                .map_err(|e| format!("Failed to parse FB2 XML: {}", e))?
        }
    };

    let root = doc.root_element();

    // 1. Collect <binary id="..." content-type="..."> map for cover & inline images
    let mut binaries: HashMap<String, (String, String)> = HashMap::new();
    let mut cover_id: Option<String> = None;

    let mut title = String::new();
    let mut author: Option<String> = None;
    let mut series: Option<String> = None;
    let mut series_position: Option<f64> = None;
    let mut metadata_languages: Vec<String> = Vec::new();

    if let Some(desc) = child_by_name(root, "description") {
        if let Some(info) = child_by_name(desc, "title-info") {
            if let Some(t) = child_by_name(info, "book-title") {
                title = collect_plain_text(t).trim().to_string();
            }
            let authors: Vec<String> = info
                .children()
                .filter(|n| n.is_element() && n.tag_name().name() == "author")
                .filter_map(format_fb2_author)
                .collect();
            if !authors.is_empty() {
                author = Some(authors.join(", "));
            }
            if let Some(seq) = child_by_name(info, "sequence") {
                if let Some(name) = seq.attribute("name").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    series = Some(name.to_string());
                    series_position = seq
                        .attribute("number")
                        .and_then(|n| n.trim().parse::<f64>().ok());
                }
            }
            if let Some(lang) = child_by_name(info, "lang") {
                let l = collect_plain_text(lang).trim().to_string();
                if !l.is_empty() {
                    metadata_languages.push(l);
                }
            }
            if let Some(cp) = child_by_name(info, "coverpage") {
                if let Some(img) = cp
                    .descendants()
                    .find(|n| n.is_element() && n.tag_name().name() == "image")
                {
                    if let Some(href) = fb2_href(img) {
                        cover_id = Some(href.trim_start_matches('#').to_string());
                    }
                }
            }
        }
    }

    if title.is_empty() {
        title = file_stem_title(path, "FB2 Book");
    }

    // Parse binary attachments needed for cover or full chapter rendering
    for node in root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "binary")
    {
        let Some(id) = node.attribute("id").map(|s| s.trim()).filter(|s| !s.is_empty()) else {
            continue;
        };
        if !include_images && cover_id.as_deref() != Some(id) {
            continue;
        }
        let content_type = node
            .attribute("content-type")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("image/jpeg");
        let raw_b64: String = node
            .text()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect();
        if raw_b64.is_empty() {
            continue;
        }
        if let Ok(decoded_bytes) = general_purpose::STANDARD.decode(&raw_b64) {
            let mime = if content_type.starts_with("image/") {
                content_type
            } else {
                infer_image_mime(&decoded_bytes, Some(id))
            };
            if let Some(data_url) = encode_data_url(&decoded_bytes, mime) {
                binaries.insert(id.to_string(), (mime.to_string(), data_url));
            }
        }
    }

    let cover = cover_id
        .as_deref()
        .and_then(|id| binaries.get(id).map(|(_, url)| url.clone()));

    // 2. Render <body> elements into chapters/sections
    let mut sections: Vec<ParsedSection> = Vec::new();
    let bodies: Vec<Node> = root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "body")
        .collect();

    for (body_idx, body) in bodies.iter().enumerate() {
        let body_name = body.attribute("name").unwrap_or("").trim();
        let is_notes = body_name.eq_ignore_ascii_case("notes");

        // Optional body-level title/epigraph/image before sections
        let mut preamble_html = String::new();
        for child in body.children().filter(|n| n.is_element()) {
            match child.tag_name().name() {
                "title" => render_fb2_title(child, 1, &mut preamble_html),
                "epigraph" => render_fb2_epigraph(child, &binaries, include_images, &mut preamble_html),
                "image" => render_fb2_image(child, &binaries, include_images, &mut preamble_html),
                _ => {}
            }
        }

        let top_sections: Vec<Node> = body
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "section")
            .collect();

        if is_notes {
            // Group all footnotes into a single clean Notes section at the end
            let mut notes_html = String::new();
            if !preamble_html.is_empty() {
                notes_html.push_str(&preamble_html);
            } else {
                notes_html.push_str("<h1>Notes</h1>\n");
            }
            for sec in top_sections {
                render_fb2_section_inline(sec, 2, &binaries, include_images, &mut notes_html);
            }
            push_fb2_section(&mut sections, Some("Notes".to_string()), notes_html);
            continue;
        }

        if top_sections.is_empty() {
            if !preamble_html.trim().is_empty() {
                push_fb2_section(&mut sections, Some(title.clone()), preamble_html);
            }
            continue;
        }

        // If a body has only 1 wrapper section containing multiple nested sections, flatten one level
        // so real chapters appear cleanly in the ToC.
        let effective_sections = if top_sections.len() == 1 {
            let only = top_sections[0];
            let nested: Vec<Node> = only
                .children()
                .filter(|n| n.is_element() && n.tag_name().name() == "section")
                .collect();
            let direct_paras = only
                .children()
                .filter(|n| n.is_element() && matches!(n.tag_name().name(), "p" | "poem" | "cite" | "subtitle"))
                .count();
            if nested.len() >= 2 && direct_paras <= 2 {
                // Include wrapper title in preamble
                if let Some(t) = child_by_name(only, "title") {
                    render_fb2_title(t, 1, &mut preamble_html);
                }
                nested
            } else {
                top_sections
            }
        } else {
            top_sections
        };

        let mut pending_preamble = preamble_html;
        for (sec_idx, sec) in effective_sections.into_iter().enumerate() {
            if sections.len() >= MAX_EPUB_CHAPTERS {
                break;
            }
            let sec_title = child_by_name(sec, "title")
                .map(collect_plain_text)
                .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    if body_idx == 0 && sec_idx == 0 {
                        Some(title.clone())
                    } else {
                        Some(format!("Chapter {}", sections.len() + 1))
                    }
                });

            let mut html = String::new();
            if !pending_preamble.is_empty() {
                html.push_str(&pending_preamble);
                pending_preamble.clear();
            }
            render_fb2_section_inline(sec, 1, &binaries, include_images, &mut html);
            push_fb2_section(&mut sections, sec_title, html);
        }
    }

    Ok(ParsedBook {
        title,
        author,
        series,
        series_position,
        metadata_languages,
        default_vertical: false,
        cover,
        sections,
    })
}

fn read_fb2_bytes(path: &str) -> Result<Vec<u8>, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".fb2.zip") || lower.ends_with(".zip") {
        let file = File::open(path).map_err(|e| format!("Failed to open FB2.ZIP: {}", e))?;
        let mut zip = ZipArchive::new(file).map_err(|e| format!("FB2.ZIP archive error: {}", e))?;
        let mut fb2_index: Option<usize> = None;
        for i in 0..zip.len() {
            if let Ok(entry) = zip.by_index(i) {
                let name = entry.name().to_ascii_lowercase();
                if name.ends_with(".fb2") {
                    fb2_index = Some(i);
                    break;
                }
            }
        }
        let idx = fb2_index.ok_or_else(|| "FB2.ZIP archive does not contain an .fb2 file.".to_string())?;
        let mut entry = zip
            .by_index(idx)
            .map_err(|e| format!("Failed to read entry from FB2.ZIP: {}", e))?;
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to extract FB2 from ZIP: {}", e))?;
        return Ok(buf);
    }

    std::fs::read(path).map_err(|e| format!("Failed to read FB2 file: {}", e))
}

/// Removes BOM, strips `<!DOCTYPE ...>` (roxmltree forbids DTDs), and trims leading garbage.
fn sanitize_fb2_xml_for_parse(input: &str) -> String {
    let s = input.trim_start_matches('\u{feff}');
    let start = s.find('<').unwrap_or(0);
    let trimmed = &s[start..];
    if let Some(dt_pos) = trimmed.find("<!DOCTYPE") {
        if let Some(dt_end) = trimmed[dt_pos..].find('>') {
            let mut out = String::with_capacity(trimmed.len());
            out.push_str(&trimmed[..dt_pos]);
            out.push_str(&trimmed[dt_pos + dt_end + 1..]);
            return out;
        }
    }
    trimmed.to_string()
}

/// Escapes stray unescaped `&` in non-strict FB2 files while preserving valid XML entities.
fn escape_stray_xml_ampersands(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 64);
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let rest = &input[i + 1..];
            let valid_entity = rest.starts_with("amp;")
                || rest.starts_with("lt;")
                || rest.starts_with("gt;")
                || rest.starts_with("quot;")
                || rest.starts_with("apos;")
                || (rest.starts_with('#') && rest[1..].find(';').map_or(false, |p| p > 0 && p <= 8));
            if valid_entity {
                out.push('&');
            } else {
                out.push_str("&amp;");
            }
            i += 1;
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn child_by_name<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}

fn fb2_href<'a>(node: Node<'a, '_>) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == "href")
        .map(|a| a.value())
}

fn collect_plain_text(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    for desc in node.descendants() {
        if desc.is_text() {
            if let Some(t) = desc.text() {
                if !out.is_empty() && !out.ends_with(' ') && !t.starts_with(' ') {
                    out.push(' ');
                }
                out.push_str(t);
            }
        }
    }
    out
}

fn format_fb2_author(node: Node<'_, '_>) -> Option<String> {
    let first = child_by_name(node, "first-name")
        .map(collect_plain_text)
        .unwrap_or_default();
    let middle = child_by_name(node, "middle-name")
        .map(collect_plain_text)
        .unwrap_or_default();
    let last = child_by_name(node, "last-name")
        .map(collect_plain_text)
        .unwrap_or_default();
    let parts: Vec<&str> = [first.trim(), middle.trim(), last.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    if !parts.is_empty() {
        return Some(parts.join(" "));
    }
    child_by_name(node, "nickname")
        .map(collect_plain_text)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn push_fb2_section(sections: &mut Vec<ParsedSection>, title: Option<String>, raw_html: String) {
    let paragraphs = extract_paragraphs(&raw_html);
    if paragraphs.is_empty() {
        return;
    }
    let idx = sections.len();
    let html = paragraphs
        .iter()
        .map(|p| p.html.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    sections.push(ParsedSection {
        id: format!("fb2-sec-{}", idx + 1),
        href: format!("fb2-sec-{}.xhtml", idx + 1),
        title,
        html,
        paragraphs,
    });
}

fn render_fb2_title(node: Node<'_, '_>, level: usize, out: &mut String) {
    let tag = match level {
        1 => "h1",
        2 => "h2",
        _ => "h3",
    };
    let mut parts = Vec::new();
    for child in node.children().filter(|n| n.is_element()) {
        let t = collect_plain_text(child).trim().to_string();
        if !t.is_empty() {
            parts.push(escape_html_text(&t));
        }
    }
    if parts.is_empty() {
        let fallback = collect_plain_text(node).trim().to_string();
        if !fallback.is_empty() {
            parts.push(escape_html_text(&fallback));
        }
    }
    if !parts.is_empty() {
        out.push_str(&format!("<{}>{}</{}>\n", tag, parts.join(" — "), tag));
    }
}

fn render_fb2_epigraph(
    node: Node<'_, '_>,
    binaries: &HashMap<String, (String, String)>,
    include_images: bool,
    out: &mut String,
) {
    out.push_str("<blockquote>");
    for child in node.children().filter(|n| n.is_element()) {
        render_fb2_block(child, 3, binaries, include_images, out);
    }
    out.push_str("</blockquote>\n");
}

fn render_fb2_image(
    node: Node<'_, '_>,
    binaries: &HashMap<String, (String, String)>,
    include_images: bool,
    out: &mut String,
) {
    if !include_images {
        return;
    }
    let Some(href) = fb2_href(node) else {
        return;
    };
    let id = href.trim_start_matches('#');
    if let Some((_, data_url)) = binaries.get(id) {
        let alt = node
            .attribute("alt")
            .or_else(|| node.attribute("title"))
            .map(|a| format!(" alt=\"{}\"", escape_html_text(a)))
            .unwrap_or_default();
        out.push_str(&format!("<p><img src=\"{}\"{} /></p>\n", data_url, alt));
    }
}

fn render_fb2_section_inline(
    sec: Node<'_, '_>,
    depth: usize,
    binaries: &HashMap<String, (String, String)>,
    include_images: bool,
    out: &mut String,
) {
    if let Some(id) = sec.attribute("id").filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("<div id=\"{}\">", escape_html_text(id)));
    }
    for child in sec.children().filter(|n| n.is_element()) {
        render_fb2_block(child, depth, binaries, include_images, out);
    }
    if sec.attribute("id").filter(|s| !s.trim().is_empty()).is_some() {
        out.push_str("</div>\n");
    }
}

fn render_fb2_block(
    node: Node<'_, '_>,
    depth: usize,
    binaries: &HashMap<String, (String, String)>,
    include_images: bool,
    out: &mut String,
) {
    match node.tag_name().name() {
        "title" => render_fb2_title(node, depth, out),
        "subtitle" => {
            let mut inner = String::new();
            render_fb2_inlines(node, binaries, include_images, &mut inner);
            if !inner.trim().is_empty() {
                out.push_str(&format!("<h3>{}</h3>\n", inner));
            }
        }
        "epigraph" | "cite" => render_fb2_epigraph(node, binaries, include_images, out),
        "text-author" => {
            let mut inner = String::new();
            render_fb2_inlines(node, binaries, include_images, &mut inner);
            if !inner.trim().is_empty() {
                out.push_str(&format!("<p><em>{}</em></p>\n", inner));
            }
        }
        "poem" => {
            out.push_str("<blockquote>");
            for child in node.children().filter(|n| n.is_element()) {
                match child.tag_name().name() {
                    "title" => render_fb2_title(child, 3, out),
                    "stanza" => {
                        let mut lines = Vec::new();
                        for v in child.children().filter(|n| n.is_element() && n.tag_name().name() == "v") {
                            let mut line = String::new();
                            render_fb2_inlines(v, binaries, include_images, &mut line);
                            if !line.trim().is_empty() {
                                lines.push(line);
                            }
                        }
                        if !lines.is_empty() {
                            out.push_str(&format!("<p>{}</p>\n", lines.join("<br />")));
                        }
                    }
                    "text-author" => render_fb2_block(child, depth + 1, binaries, include_images, out),
                    _ => {}
                }
            }
            out.push_str("</blockquote>\n");
        }
        "p" | "v" => {
            let mut inner = String::new();
            render_fb2_inlines(node, binaries, include_images, &mut inner);
            if !inner.trim().is_empty() {
                let id_attr = node
                    .attribute("id")
                    .filter(|s| !s.trim().is_empty())
                    .map(|id| format!(" id=\"{}\"", escape_html_text(id)))
                    .unwrap_or_default();
                out.push_str(&format!("<p{}>{}</p>\n", id_attr, inner));
            }
        }
        "empty-line" => {
            out.push_str("<hr />\n");
        }
        "image" => render_fb2_image(node, binaries, include_images, out),
        "section" => render_fb2_section_inline(node, depth + 1, binaries, include_images, out),
        "table" => {
            for tr in node.children().filter(|n| n.is_element() && n.tag_name().name() == "tr") {
                let mut cells = Vec::new();
                for cell in tr.children().filter(|n| n.is_element()) {
                    let mut c = String::new();
                    render_fb2_inlines(cell, binaries, include_images, &mut c);
                    if !c.trim().is_empty() {
                        cells.push(c);
                    }
                }
                if !cells.is_empty() {
                    out.push_str(&format!("<p>{}</p>\n", cells.join(" · ")));
                }
            }
        }
        _ => {
            let mut inner = String::new();
            render_fb2_inlines(node, binaries, include_images, &mut inner);
            if !inner.trim().is_empty() {
                out.push_str(&format!("<p>{}</p>\n", inner));
            }
        }
    }
}

fn render_fb2_inlines(
    node: Node<'_, '_>,
    binaries: &HashMap<String, (String, String)>,
    include_images: bool,
    out: &mut String,
) {
    for child in node.children() {
        if child.is_text() {
            if let Some(t) = child.text() {
                out.push_str(&escape_html_text(t));
            }
        } else if child.is_element() {
            match child.tag_name().name() {
                "strong" => {
                    out.push_str("<strong>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</strong>");
                }
                "emphasis" => {
                    out.push_str("<em>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</em>");
                }
                "strikethrough" => {
                    out.push_str("<s>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</s>");
                }
                "sub" => {
                    out.push_str("<sub>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</sub>");
                }
                "sup" => {
                    out.push_str("<sup>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</sup>");
                }
                "code" => {
                    out.push_str("<code>");
                    render_fb2_inlines(child, binaries, include_images, out);
                    out.push_str("</code>");
                }
                "image" => {
                    if include_images {
                        if let Some(href) = fb2_href(child) {
                            let id = href.trim_start_matches('#');
                            if let Some((_, data_url)) = binaries.get(id) {
                                out.push_str(&format!("<img src=\"{}\" />", data_url));
                            }
                        }
                    }
                }
                _ => render_fb2_inlines(child, binaries, include_images, out),
            }
        }
    }
}
