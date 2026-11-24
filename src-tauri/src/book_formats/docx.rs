use super::*;
use roxmltree::{Document, Node};
use std::collections::HashMap;

/// Parses a `.docx` (Office Open XML) file into chapters, ToC, metadata, inline images,
/// and Japanese `<w:ruby>` furigana markup.
pub(in crate::epub_import) fn parse_docx_book(
    path: &str,
    include_images: bool,
) -> Result<ParsedBook, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open DOCX: {}", e))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("DOCX zip error: {}", e))?;

    // 1. Optional core metadata from docProps/core.xml
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut metadata_languages: Vec<String> = Vec::new();
    if let Ok(core_xml) = zip_read_to_string(&mut zip, "docProps/core.xml") {
        if let Ok(doc) = Document::parse(&core_xml) {
            for node in doc.descendants().filter(|n| n.is_element()) {
                let text = node.text().unwrap_or("").trim();
                if text.is_empty() {
                    continue;
                }
                match node.tag_name().name() {
                    "title" if title.is_none() => title = Some(text.to_string()),
                    "creator" if author.is_none() => author = Some(text.to_string()),
                    "language" => metadata_languages.push(text.to_string()),
                    _ => {}
                }
            }
        }
    }

    // 2. Relationship map (rId -> word/media/...) for embedded images
    let mut rels: HashMap<String, String> = HashMap::new();
    if include_images {
        if let Ok(rels_xml) = zip_read_to_string(&mut zip, "word/_rels/document.xml.rels") {
            if let Ok(doc) = Document::parse(&rels_xml) {
                for node in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "Relationship") {
                    if let (Some(id), Some(target)) = (node.attribute("Id"), node.attribute("Target")) {
                        let clean = target.trim_start_matches('/');
                        let full = if clean.starts_with("word/") {
                            clean.to_string()
                        } else {
                            format!("word/{}", clean)
                        };
                        rels.insert(id.to_string(), full);
                    }
                }
            }
        }
    }

    // 3. Parse word/document.xml
    let doc_xml = zip_read_to_string(&mut zip, "word/document.xml")
        .map_err(|e| format!("DOCX missing word/document.xml: {}", e))?;
    let doc = Document::parse(&doc_xml)
        .map_err(|e| format!("Failed to parse DOCX XML: {}", e))?;

    let body = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "body")
        .ok_or_else(|| "DOCX has no document body.".to_string())?;

    let mut image_cache: HashMap<String, String> = HashMap::new();
    let mut html_out = String::with_capacity(doc_xml.len() / 2);

    for child in body.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "p" => render_docx_paragraph(child, &rels, &mut zip, &mut image_cache, include_images, &mut html_out),
            "tbl" => render_docx_table(child, &rels, &mut zip, &mut image_cache, include_images, &mut html_out),
            "sdt" => {
                // Structured document tags (e.g. cover blocks / callouts)
                for sdt_child in child.descendants().filter(|n| n.is_element() && n.tag_name().name() == "p") {
                    render_docx_paragraph(sdt_child, &rels, &mut zip, &mut image_cache, include_images, &mut html_out);
                }
            }
            _ => {}
        }
    }

    let paragraphs = extract_paragraphs(&html_out);
    if paragraphs.is_empty() {
        return Err("DOCX contains no readable text.".to_string());
    }

    let first_heading = paragraphs
        .iter()
        .find(|p| p.kind == "heading" && !p.text.trim().is_empty())
        .map(|p| p.text.trim().to_string());
    let final_title = title
        .or(first_heading)
        .unwrap_or_else(|| file_stem_title(path, "Document"));

    let cover = if include_images {
        paragraphs
            .iter()
            .find(|p| p.kind == "image")
            .and_then(|p| p.image_src.clone())
    } else {
        None
    };

    let sections = split_paragraphs_into_sections(paragraphs, "docx", "docx", &final_title);

    Ok(ParsedBook {
        title: final_title,
        author,
        series: None,
        series_position: None,
        metadata_languages,
        default_vertical: false,
        cover,
        sections,
    })
}

fn docx_paragraph_tag(p_node: Node<'_, '_>) -> &'static str {
    let Some(ppr) = p_node.children().find(|n| n.is_element() && n.tag_name().name() == "pPr") else {
        return "p";
    };
    if let Some(style) = ppr.children().find(|n| n.is_element() && n.tag_name().name() == "pStyle") {
        if let Some(val) = style.attributes().find(|a| a.name() == "val").map(|a| a.value()) {
            let lower = val.to_ascii_lowercase();
            if lower == "title" || lower == "heading1" || lower == "heading 1" || val == "見出し1" || val == "表題" {
                return "h1";
            }
            if lower == "subtitle" || lower == "heading2" || lower == "heading 2" || val == "見出し2" {
                return "h2";
            }
            if lower.starts_with("heading") || val.starts_with("見出し") {
                return "h3";
            }
            if lower.contains("quote") {
                return "blockquote";
            }
        }
    }
    if ppr.children().any(|n| n.is_element() && n.tag_name().name() == "numPr") {
        return "li";
    }
    "p"
}

fn render_docx_paragraph(
    p_node: Node<'_, '_>,
    rels: &HashMap<String, String>,
    zip: &mut ZipArchive<File>,
    image_cache: &mut HashMap<String, String>,
    include_images: bool,
    out: &mut String,
) {
    let tag = docx_paragraph_tag(p_node);
    let mut inner = String::new();

    for child in p_node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "r" => render_docx_run(child, rels, zip, image_cache, include_images, &mut inner),
            "hyperlink" | "ins" | "smartTag" => {
                for sub in child.children().filter(|n| n.is_element() && n.tag_name().name() == "r") {
                    render_docx_run(sub, rels, zip, image_cache, include_images, &mut inner);
                }
            }
            "ruby" => render_docx_ruby(child, &mut inner),
            _ => {}
        }
    }

    if !inner.trim().is_empty() {
        out.push_str(&format!("<{}>{}</{}>\n", tag, inner, tag));
    }
}

fn render_docx_table(
    tbl_node: Node<'_, '_>,
    rels: &HashMap<String, String>,
    zip: &mut ZipArchive<File>,
    image_cache: &mut HashMap<String, String>,
    include_images: bool,
    out: &mut String,
) {
    for tr in tbl_node.children().filter(|n| n.is_element() && n.tag_name().name() == "tr") {
        let mut cells = Vec::new();
        for tc in tr.children().filter(|n| n.is_element() && n.tag_name().name() == "tc") {
            let mut cell_parts = Vec::new();
            for p in tc.children().filter(|n| n.is_element() && n.tag_name().name() == "p") {
                let mut inner = String::new();
                for r in p.children().filter(|n| n.is_element() && n.tag_name().name() == "r") {
                    render_docx_run(r, rels, zip, image_cache, include_images, &mut inner);
                }
                if !inner.trim().is_empty() {
                    cell_parts.push(inner.trim().to_string());
                }
            }
            if !cell_parts.is_empty() {
                cells.push(cell_parts.join(" "));
            }
        }
        if !cells.is_empty() {
            out.push_str(&format!("<p>{}</p>\n", cells.join(" · ")));
        }
    }
}

fn render_docx_ruby(ruby_node: Node<'_, '_>, out: &mut String) {
    let mut rt_text = String::new();
    let mut base_text = String::new();
    for child in ruby_node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "rt" => {
                for t in child.descendants().filter(|n| n.is_element() && n.tag_name().name() == "t") {
                    if let Some(s) = t.text() {
                        rt_text.push_str(s);
                    }
                }
            }
            "rubyBase" => {
                for t in child.descendants().filter(|n| n.is_element() && n.tag_name().name() == "t") {
                    if let Some(s) = t.text() {
                        base_text.push_str(s);
                    }
                }
            }
            _ => {}
        }
    }
    if !base_text.is_empty() && !rt_text.is_empty() {
        out.push_str("<ruby>");
        out.push_str(&escape_html_text(&base_text));
        out.push_str("<rt>");
        out.push_str(&escape_html_text(&rt_text));
        out.push_str("</rt></ruby>");
    } else if !base_text.is_empty() {
        out.push_str(&escape_html_text(&base_text));
    }
}

fn render_docx_run(
    r_node: Node<'_, '_>,
    rels: &HashMap<String, String>,
    zip: &mut ZipArchive<File>,
    image_cache: &mut HashMap<String, String>,
    include_images: bool,
    out: &mut String,
) {
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;

    if let Some(rpr) = r_node.children().find(|n| n.is_element() && n.tag_name().name() == "rPr") {
        for prop in rpr.children().filter(|n| n.is_element()) {
            let off = prop
                .attributes()
                .find(|a| a.name() == "val")
                .map(|a| a.value() == "0" || a.value().eq_ignore_ascii_case("false"))
                .unwrap_or(false);
            if off {
                continue;
            }
            match prop.tag_name().name() {
                "b" => bold = true,
                "i" => italic = true,
                "strike" | "dstrike" => strike = true,
                _ => {}
            }
        }
    }

    let mut content = String::new();
    for child in r_node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "t" => {
                if let Some(t) = child.text() {
                    content.push_str(&escape_html_text(t));
                }
            }
            "tab" => content.push(' '),
            "br" | "cr" => content.push_str("<br />"),
            "ruby" => render_docx_ruby(child, &mut content),
            "drawing" | "pict" if include_images => {
                for desc in child.descendants().filter(|n| n.is_element()) {
                    let name = desc.tag_name().name();
                    let rel_id = if name == "blip" {
                        desc.attributes().find(|a| a.name() == "embed").map(|a| a.value())
                    } else if name == "imagedata" {
                        desc.attributes().find(|a| a.name() == "id").map(|a| a.value())
                    } else {
                        None
                    };
                    if let Some(rid) = rel_id {
                        if let Some(target_path) = rels.get(rid) {
                            if let Some(data_url) = load_docx_image_cached(zip, target_path, image_cache) {
                                content.push_str(&format!("<img src=\"{}\" />", data_url));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if content.is_empty() {
        return;
    }
    if bold {
        out.push_str("<strong>");
    }
    if italic {
        out.push_str("<em>");
    }
    if strike {
        out.push_str("<s>");
    }
    out.push_str(&content);
    if strike {
        out.push_str("</s>");
    }
    if italic {
        out.push_str("</em>");
    }
    if bold {
        out.push_str("</strong>");
    }
}

fn load_docx_image_cached(
    zip: &mut ZipArchive<File>,
    target_path: &str,
    cache: &mut HashMap<String, String>,
) -> Option<String> {
    if let Some(existing) = cache.get(target_path) {
        return Some(existing.clone());
    }
    if cache.len() >= MAX_EPUB_IMAGES_PER_CHAPTER {
        return None;
    }
    let mut entry = zip.by_name(target_path).ok()?;
    if entry.size() > MAX_EPUB_IMAGE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).ok()?;
    let mime = infer_image_mime(&bytes, Some(target_path));
    let data_url = encode_data_url(&bytes, mime)?;
    cache.insert(target_path.to_string(), data_url.clone());
    Some(data_url)
}
