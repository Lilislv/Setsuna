//! Lists font families installed on the desktop so the reader can use them
//! directly. Each family is probed once for Japanese glyph coverage, which the
//! font picker uses for its "Japanese" filter. Results are cached for the
//! lifetime of the process.

use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    /// Family name usable in CSS `font-family` (English name when available).
    pub family: String,
    /// Other localized names of the family, e.g. 游明朝 for Yu Mincho.
    pub local_names: Vec<String>,
    /// Has kana and common kanji glyphs.
    pub japanese: bool,
    pub monospaced: bool,
    /// Number of faces (weights / styles) installed for the family.
    pub styles: u32,
}

static FONTS: OnceLock<Vec<SystemFont>> = OnceLock::new();

const JAPANESE_PROBE: [char; 4] = ['あ', 'ア', '日', '語'];

fn collect_fonts() -> Vec<SystemFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    struct Entry {
        family: String,
        local_names: Vec<String>,
        face: fontdb::ID,
        face_is_regular: bool,
        monospaced: bool,
        styles: u32,
    }

    let mut families: BTreeMap<String, Entry> = BTreeMap::new();
    for face in db.faces() {
        let Some(primary) = face
            .families
            .iter()
            .find(|(_, language)| *language == fontdb::Language::English_UnitedStates)
            .or_else(|| face.families.first())
            .map(|(name, _)| name.trim().to_string())
        else {
            continue;
        };
        if primary.is_empty() || primary.starts_with('.') {
            continue;
        }
        let is_regular = face.style == fontdb::Style::Normal && face.weight == fontdb::Weight::NORMAL;
        let entry = families.entry(primary.to_lowercase()).or_insert_with(|| Entry {
            family: primary.clone(),
            local_names: Vec::new(),
            face: face.id,
            face_is_regular: is_regular,
            monospaced: face.monospaced,
            styles: 0,
        });
        entry.styles += 1;
        if is_regular && !entry.face_is_regular {
            entry.face = face.id;
            entry.face_is_regular = true;
        }
        for (name, _) in &face.families {
            let name = name.trim();
            if !name.is_empty() && !name.eq_ignore_ascii_case(&entry.family) && !entry.local_names.iter().any(|known| known == name) {
                entry.local_names.push(name.to_string());
            }
        }
    }

    families
        .into_values()
        .map(|entry| {
            let japanese = db
                .with_face_data(entry.face, |data, index| {
                    ttf_parser::Face::parse(data, index)
                        .map(|face| JAPANESE_PROBE.iter().all(|c| face.glyph_index(*c).is_some()))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            SystemFont {
                family: entry.family,
                local_names: entry.local_names,
                japanese,
                monospaced: entry.monospaced,
                styles: entry.styles,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFont>, String> {
    if let Some(fonts) = FONTS.get() {
        return Ok(fonts.clone());
    }
    let fonts = tauri::async_runtime::spawn_blocking(collect_fonts)
        .await
        .map_err(|error| error.to_string())?;
    Ok(FONTS.get_or_init(|| fonts).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_families() {
        let fonts = collect_fonts();
        assert!(!fonts.is_empty(), "no system fonts found");
        assert!(fonts.iter().all(|font| !font.family.is_empty()));
        #[cfg(target_os = "windows")]
        assert!(fonts.iter().any(|font| font.family == "Yu Gothic" && font.japanese), "Yu Gothic should be detected as Japanese");
    }
}
