use super::*;
use pulldown_cmark::{html as md_html, Options as MdOptions, Parser as MdParser};

/// Parses a standalone `.html` / `.htm` / `.xhtml` file using the shared HTML sanitizer
/// and splits chapters by `<h1>`/`<h2>` headings (or fixed chunks when unstructured).
pub(in crate::epub_import) fn parse_html_book(
    path: &str,
    include_images: bool,
) -> Result<ParsedBook, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read HTML: {}", e))?;
    let raw_html = decode_text_bytes(&bytes);
    if raw_html.trim().is_empty() {
        return Err("HTML file is empty.".to_string());
    }

    let prepared_html = if include_images {
        if let Some(parent) = Path::new(path).parent() {
            inline_local_html_images(&raw_html, parent)
        } else {
            raw_html.clone()
        }
    } else {
        raw_html.clone()
    };

    let title = extract_html_title_tag(&raw_html)
        .or_else(|| chapter_title_from_html(&raw_html, path))
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| file_stem_title(path, "HTML"));
    let author = extract_html_meta(&raw_html, "author");
    let mut metadata_languages = Vec::new();
    if let Some(lang) = extract_html_lang(&raw_html) {
        metadata_languages.push(lang);
    }

    let sanitized = sanitize_epub_html_inner(&prepared_html, "", path, None, None);
    let paragraphs = extract_paragraphs(&sanitized);
    if paragraphs.is_empty() {
        return Err("HTML file contains no readable text.".to_string());
    }

    let cover = if include_images {
        paragraphs
            .iter()
            .find(|p| p.kind == "image")
            .and_then(|p| p.image_src.clone())
    } else {
        None
    };

    let sections = split_paragraphs_into_sections(paragraphs, "html", "html", &title);

    Ok(ParsedBook {
        title,
        author,
        series: None,
        series_position: None,
        metadata_languages,
        default_vertical: false,
        cover,
        sections,
    })
}

/// Parses a `.md` / `.markdown` file (supporting optional YAML frontmatter and GitHub-style
/// tables/strikethrough/footnotes) into structured HTML chapters and ToC.
pub(in crate::epub_import) fn parse_markdown_book(
    path: &str,
    include_images: bool,
) -> Result<ParsedBook, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read Markdown: {}", e))?;
    let decoded = decode_text_bytes(&bytes);
    let cleaned = decoded
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let (frontmatter, body) = split_yaml_frontmatter(&cleaned);
    if body.trim().is_empty() {
        return Err("Markdown file is empty.".to_string());
    }

    let mut options = MdOptions::empty();
    options.insert(MdOptions::ENABLE_TABLES);
    options.insert(MdOptions::ENABLE_STRIKETHROUGH);
    options.insert(MdOptions::ENABLE_FOOTNOTES);
    options.insert(MdOptions::ENABLE_TASKLISTS);

    let parser = MdParser::new_ext(body, options);
    let mut rendered_html = String::with_capacity(body.len() + 256);
    md_html::push_html(&mut rendered_html, parser);

    let prepared_html = if include_images {
        if let Some(parent) = Path::new(path).parent() {
            inline_local_html_images(&rendered_html, parent)
        } else {
            rendered_html
        }
    } else {
        rendered_html
    };

    let sanitized = sanitize_epub_html_inner(&prepared_html, "", path, None, None);
    let paragraphs = extract_paragraphs(&sanitized);
    if paragraphs.is_empty() {
        return Err("Markdown file contains no readable text.".to_string());
    }

    let first_heading = paragraphs
        .iter()
        .find(|p| p.kind == "heading" && !p.text.trim().is_empty())
        .map(|p| p.text.trim().to_string());
    let title = frontmatter
        .title
        .or(first_heading)
        .unwrap_or_else(|| file_stem_title(path, "Markdown"));
    let mut metadata_languages = Vec::new();
    if let Some(lang) = frontmatter.language {
        metadata_languages.push(lang);
    }

    let cover = if include_images {
        paragraphs
            .iter()
            .find(|p| p.kind == "image")
            .and_then(|p| p.image_src.clone())
    } else {
        None
    };

    let sections = split_paragraphs_into_sections(paragraphs, "md", "md", &title);

    Ok(ParsedBook {
        title,
        author: frontmatter.author,
        series: frontmatter.series,
        series_position: None,
        metadata_languages,
        default_vertical: false,
        cover,
        sections,
    })
}

#[derive(Default)]
struct MarkdownFrontmatter {
    title: Option<String>,
    author: Option<String>,
    series: Option<String>,
    language: Option<String>,
}

fn split_yaml_frontmatter(text: &str) -> (MarkdownFrontmatter, &str) {
    let mut fm = MarkdownFrontmatter::default();
    if !text.starts_with("---\n") {
        return (fm, text);
    }
    let rest = &text[4..];
    let Some(end_idx) = rest.find("\n---") else {
        return (fm, text);
    };
    let yaml_block = &rest[..end_idx];
    let after_marker = &rest[end_idx + 4..];
    let body = after_marker.strip_prefix('\n').unwrap_or(after_marker);

    for line in yaml_block.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim().trim_matches('"').trim_matches('\'').trim();
        if val.is_empty() {
            continue;
        }
        match key.as_str() {
            "title" => fm.title = Some(val.to_string()),
            "author" => fm.author = Some(val.to_string()),
            "series" => fm.series = Some(val.to_string()),
            "lang" | "language" => fm.language = Some(val.to_string()),
            _ => {}
        }
    }
    (fm, body)
}

fn extract_html_meta(html: &str, name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0usize;
    while let Some(rel) = lower[offset..].find("<meta") {
        let start = offset + rel;
        let Some(end_rel) = html[start..].find('>') else {
            break;
        };
        let tag = &html[start..=start + end_rel];
        if let Some(meta_name) = xml_attr(tag, "name") {
            if meta_name.eq_ignore_ascii_case(name) {
                if let Some(content) = xml_attr(tag, "content") {
                    let trimmed = content.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
        offset = start + end_rel + 1;
    }
    None
}

fn extract_html_title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = html[start..].find('>')?;
    let content_start = start + open_end + 1;
    let close_rel = lower[content_start..].find("</title>")?;
    let text = normalize_text(&html[content_start..content_start + close_rel]);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_html_lang(html: &str) -> Option<String> {
    tag_with_name(html, "html")
        .and_then(|tag| xml_attr(&tag, "lang").or_else(|| xml_attr(&tag, "xml:lang")))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
