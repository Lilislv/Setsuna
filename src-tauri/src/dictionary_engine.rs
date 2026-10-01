// Shared by the desktop executable, Android commands and native Flow JNI.
use crate::{core, dictionary_import, japanese_deinflector, open_db, get_data_path};
use crate::japanese_tokenizer::segment_text as segment_japanese_text;
use crate::lookup_normalization::{japanese_lookup_variants, katakana_to_hiragana};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime as StdSystemTime, UNIX_EPOCH};
use std::fs;
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DeinflectReason {
    pub(crate) rule: Value,
    pub(crate) desc: Value,
    #[serde(default)]
    pub(crate) in_suffix: String,
    #[serde(default)]
    pub(crate) out_suffix: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FrequencyData {
    pub(crate) dict_name: String,
    pub(crate) display_value: String,
    pub(crate) value: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PitchData {
    pub(crate) dict_name: String,
    pub(crate) reading: String,
    pub(crate) position: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PronunciationData {
    pub(crate) dict_name: String,
    pub(crate) reading: String,
    pub(crate) ipa: String,
    pub(crate) tags: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DictEntry {
    pub(crate) term: String,
    pub(crate) reading: String,
    pub(crate) definition: String,
    pub(crate) dict_name: String,
    pub(crate) tags: String,
    pub(crate) deinflection_reasons: Vec<DeinflectReason>,
    pub(crate) frequencies: Vec<FrequencyData>,
    pub(crate) pitches: Vec<PitchData>,
    pub(crate) pronunciations: Vec<PronunciationData>,
    pub(crate) source_length: usize,
    #[serde(default)]
    pub(crate) score: i64,
    #[serde(default)]
    pub(crate) text_processing_steps: usize,
    #[serde(default)]
    pub(crate) source_term_exact_match: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DictionaryUpdateStatus {
    pub(crate) dict_name: String,
    pub(crate) current_revision: String,
    pub(crate) latest_revision: String,
    pub(crate) update_available: bool,
    pub(crate) error: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TextToken {
    pub(crate) text: String,
    pub(crate) reading: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CursorLookupResult {
    pub(crate) entries: Vec<DictEntry>,
    pub(crate) match_start: usize,
    pub(crate) match_len: usize,
    pub(crate) word: String,
}

pub(crate) const LOOKUP_NO_MATCH: &str = "\u{0000}SETSUNA_NO_MATCH";
pub(crate) const LOOKUP_MAX_SCAN_CHARS: usize = 24;
pub(crate) const LOOKUP_SCAN_DEINFLECT_DEPTH: usize = 3;
pub(crate) const LOOKUP_DIRECT_DEINFLECT_DEPTH: usize = 3;

pub(crate) fn unix_time_ms() -> u128 { StdSystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }

pub(crate) fn kata_to_hira(s: &str) -> String {
    katakana_to_hiragana(s, false)
}
pub(crate) fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

pub(crate) fn irregular_english_base_form(lower: &str) -> Option<&'static str> {
    match lower {
        "arose" | "arisen" => Some("arise"),
        "ate" | "eaten" => Some("eat"),
        "became" => Some("become"),
        "began" | "begun" => Some("begin"),
        "bit" | "bitten" => Some("bite"),
        "blew" | "blown" => Some("blow"),
        "broke" | "broken" => Some("break"),
        "brought" => Some("bring"),
        "built" => Some("build"),
        "bought" => Some("buy"),
        "came" => Some("come"),
        "caught" => Some("catch"),
        "chose" | "chosen" => Some("choose"),
        "dealt" => Some("deal"),
        "did" | "done" => Some("do"),
        "drew" | "drawn" => Some("draw"),
        "drank" | "drunk" => Some("drink"),
        "drove" | "driven" => Some("drive"),
        "fell" | "fallen" => Some("fall"),
        "felt" => Some("feel"),
        "fled" => Some("flee"),
        "flew" | "flown" => Some("fly"),
        "forgot" | "forgotten" => Some("forget"),
        "found" => Some("find"),
        "gave" | "given" => Some("give"),
        "got" | "gotten" => Some("get"),
        "grew" | "grown" => Some("grow"),
        "had" => Some("have"),
        "heard" => Some("hear"),
        "held" => Some("hold"),
        "kept" => Some("keep"),
        "knew" | "known" => Some("know"),
        "laid" => Some("lay"),
        "led" => Some("lead"),
        "left" => Some("leave"),
        "lent" => Some("lend"),
        "lost" => Some("lose"),
        "made" => Some("make"),
        "met" => Some("meet"),
        "paid" => Some("pay"),
        "ran" => Some("run"),
        "rang" | "rung" => Some("ring"),
        "rode" | "ridden" => Some("ride"),
        "rose" | "risen" => Some("rise"),
        "said" => Some("say"),
        "sang" | "sung" => Some("sing"),
        "sat" => Some("sit"),
        "saw" | "seen" => Some("see"),
        "sent" => Some("send"),
        "shook" | "shaken" => Some("shake"),
        "shot" => Some("shoot"),
        "slept" => Some("sleep"),
        "sold" => Some("sell"),
        "spoke" | "spoken" => Some("speak"),
        "spent" => Some("spend"),
        "stood" => Some("stand"),
        "stole" | "stolen" => Some("steal"),
        "swam" | "swum" => Some("swim"),
        "taught" => Some("teach"),
        "thought" => Some("think"),
        "threw" | "thrown" => Some("throw"),
        "told" => Some("tell"),
        "took" | "taken" => Some("take"),
        "understood" => Some("understand"),
        "went" | "gone" => Some("go"),
        "woke" | "woken" => Some("wake"),
        "won" => Some("win"),
        "wore" | "worn" => Some("wear"),
        "wrote" | "written" => Some("write"),
        "lying" => Some("lie"),
        _ => None,
    }
}

pub(crate) fn push_english_base_forms(values: &mut Vec<String>, lower: &str) {
    if !is_english_lookup_word(lower) {
        return;
    }

    if let Some(base) = irregular_english_base_form(lower) {
        push_unique_string(values, base.to_string());
    }

    if lower.ends_with("ies") && lower.len() > 4 {
        let mut stem = lower[..lower.len() - 3].to_string();
        stem.push('y');
        push_unique_string(values, stem);
    }

    if lower.ends_with("ing") && lower.len() > 5 {
        let stem = &lower[..lower.len() - 3];
        push_unique_string(values, stem.to_string());
        let mut with_e = stem.to_string();
        with_e.push('e');
        push_unique_string(values, with_e);

        let stem_chars: Vec<char> = stem.chars().collect();
        if stem_chars.len() >= 2
            && stem_chars[stem_chars.len() - 1] == stem_chars[stem_chars.len() - 2]
        {
            push_unique_string(values, stem_chars[..stem_chars.len() - 1].iter().collect());
        }
    }

    if lower.ends_with("ed") && lower.len() > 4 {
        let stem = &lower[..lower.len() - 2];
        push_unique_string(values, stem.to_string());
        let mut with_e = stem.to_string();
        with_e.push('e');
        push_unique_string(values, with_e);

        let stem_chars: Vec<char> = stem.chars().collect();
        if stem_chars.len() >= 2
            && stem_chars[stem_chars.len() - 1] == stem_chars[stem_chars.len() - 2]
        {
            push_unique_string(values, stem_chars[..stem_chars.len() - 1].iter().collect());
        }
    }

    if lower.ends_with("es") && lower.len() > 3 {
        push_unique_string(values, lower[..lower.len() - 2].to_string());
    }

    if lower.ends_with('s') && lower.len() > 3 && !lower.ends_with("ss") {
        push_unique_string(values, lower[..lower.len() - 1].to_string());
    }
}

pub(crate) fn lookup_forms(term: &str) -> Vec<String> {
    let mut forms = Vec::new();
    push_unique_string(&mut forms, term.to_string());
    if term.chars().any(|c| c.is_ascii_alphabetic()) {
        let lower = term.to_lowercase();
        push_unique_string(&mut forms, lower.clone());
        push_english_base_forms(&mut forms, &lower);
        push_unique_string(&mut forms, term.to_uppercase());
        let mut chars = term.chars();
        if let Some(first) = chars.next() {
            let mut title = first.to_uppercase().collect::<String>();
            title.push_str(&chars.as_str().to_lowercase());
            push_unique_string(&mut forms, title);
        }
    }
    if term.chars().any(is_japanese_lookup_char) {
        for variant in japanese_lookup_variants(term) {
            push_unique_string(&mut forms, variant);
        }
    }

    while forms.len() < 8 {
        forms.push(LOOKUP_NO_MATCH.to_string());
    }
    forms.truncate(8);
    forms
}

pub(crate) fn lookup_entry_rank(entry: &DictEntry, forms: &[String]) -> i32 {
    let primary = forms.first().map(String::as_str).unwrap_or_default();
    // Like Yomitan, prefer a matching headword over a homophone found by reading.
    if is_kana_only_lookup(primary) {
        if forms.iter().any(|form| form != LOOKUP_NO_MATCH && entry.term == *form) {
            return 0;
        }
        if forms.iter().any(|form| {
            form != LOOKUP_NO_MATCH && (entry.term == *form || entry.reading == *form)
        }) {
            return 1;
        }
        return 2;
    }
    if entry.term == primary {
        return 0;
    }
    if entry.reading == primary {
        return 1;
    }
    if forms
        .iter()
        .skip(1)
        .any(|form| !form.is_empty() && entry.term == *form)
    {
        return 2;
    }
    if forms
        .iter()
        .skip(1)
        .any(|form| !form.is_empty() && entry.reading == *form)
    {
        return 3;
    }
    4
}

pub(crate) fn best_frequency_value(entry: &DictEntry) -> i64 {
    entry
        .frequencies
        .iter()
        .map(|freq| freq.value)
        .filter(|value| *value > 0)
        .min()
        .unwrap_or(i64::MAX)
}

pub(crate) fn load_rules() -> &'static [(Value, Value, String, String)] {
    static RULES: OnceLock<Vec<(Value, Value, String, String)>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let rules_str = include_str!("deinflect.json");
            let clean_rules_str = rules_str.trim_start_matches('\u{feff}');
            let mut rules = Vec::new();
            let mut unique_pairs = HashSet::new();
            if let Ok(json_rules) = serde_json::from_str::<Value>(clean_rules_str) {
                if let Some(arr) = json_rules.as_array() {
                    for item in arr {
                        let in_s = item
                            .get("in")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let out_s = item
                            .get("out")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // Dictionary deinflection must end in a dictionary form. Rules
                        // which only strip sentence-final particles caused longer text
                        // to beat the actual word (for example 見えないんだ over 見えない).
                        if in_s.is_empty() || out_s.is_empty() {
                            continue;
                        }
                        if unique_pairs.insert((in_s.clone(), out_s.clone())) {
                            let reason = item
                                .get("reason")
                                .cloned()
                                .unwrap_or(Value::String("".to_string()));
                            let desc = item
                                .get("desc")
                                .cloned()
                                .unwrap_or(Value::String("".to_string()));
                            rules.push((reason, desc, in_s, out_s));
                        }
                    }
                }
            }
            // Prefer the most specific suffix first. The old JSON-order traversal let
            // generic rules such as たい -> る crowd the queue before りたい -> る.
            rules.sort_by(|a, b| {
                b.2.chars()
                    .count()
                    .cmp(&a.2.chars().count())
                    .then_with(|| a.2.cmp(&b.2))
                    .then_with(|| a.3.cmp(&b.3))
            });
            rules
        })
        .as_slice()
}

#[tauri::command]
pub(crate) async fn get_installed_dicts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let mut db = open_db(&app)?;
    // Older builds could leave one row per dated revision. Clean those rows
    // before exposing dictionary names to the frontend.
    dictionary_import::cleanup_stale_dictionary_revisions(&mut db)?;
    // Dictionary imports already record their title in dictionary_meta. Reading
    // every metadata table here made the UI scan large frequency/pitch tables a
    // second time immediately after an import, which looked like a frozen or
    // crashed import dialog. Keep one fallback over entries for legacy DBs.
    let mut names = HashSet::new();
    let mut stmt = db.prepare("SELECT title FROM dictionary_meta WHERE title IS NOT NULL AND title != '' UNION SELECT DISTINCT dict_name FROM entries WHERE dict_name IS NOT NULL AND dict_name != ''")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for name in rows.flatten() {
        names.insert(name);
    }
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort();
    Ok(names)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn check_dictionary_updates(
    app: tauri::AppHandle,
) -> Result<Vec<DictionaryUpdateStatus>, String> {
    let dictionaries = {
        let db = open_db(&app)?;
        let mut stmt = db
            .prepare(
                "SELECT title, revision, index_url FROM dictionary_meta
                 WHERE is_updatable = 1 AND index_url != '' ORDER BY title",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.flatten().collect::<Vec<_>>()
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut statuses = Vec::with_capacity(dictionaries.len());
    for (dict_name, current_revision, index_url) in dictionaries {
        let result = async {
            let response = client
                .get(&index_url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            let index = response.json::<Value>().await.map_err(|e| e.to_string())?;
            Ok::<String, String>(
                index
                    .get("revision")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        }
        .await;

        match result {
            Ok(latest_revision) => statuses.push(DictionaryUpdateStatus {
                dict_name,
                update_available: !latest_revision.is_empty()
                    && latest_revision != current_revision,
                current_revision,
                latest_revision,
                error: String::new(),
            }),
            Err(error) => statuses.push(DictionaryUpdateStatus {
                dict_name,
                current_revision,
                latest_revision: String::new(),
                update_available: false,
                error,
            }),
        }
    }
    Ok(statuses)
}

#[tauri::command]
pub(crate) async fn update_dictionary_from_source(
    app: tauri::AppHandle,
    dict_name: String,
) -> Result<usize, String> {
    let download_url = {
        let db = open_db(&app)?;
        db.query_row(
            "SELECT download_url FROM dictionary_meta WHERE title = ?1 AND is_updatable = 1",
            params![&dict_name],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("Dictionary '{}' has no update source", dict_name))?
    };
    if !(download_url.starts_with("https://") || download_url.starts_with("http://")) {
        return Err("Dictionary update URL is invalid".to_string());
    }

    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Dictionary download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Dictionary download failed: HTTP {}",
            response.status()
        ));
    }
    if response.content_length().unwrap_or(0) > 64 * 1024 * 1024 * 1024 {
        return Err("Dictionary archive is larger than 64 GB".to_string());
    }

    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let temp_path = cache_dir.join(format!(
        "setsuna-dictionary-update-{}-{}.zip",
        std::process::id(),
        unix_time_ms()
    ));
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create update file: {}", e))?;
    let mut response = response;
    let mut downloaded = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to download dictionary: {}", e))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > 64 * 1024 * 1024 * 1024 {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err("Dictionary archive is larger than 64 GB".to_string());
        }
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("Failed to save dictionary update: {}", e))?;
    }
    drop(file);

    let result =
        dictionary_import::import_dictionary(app, temp_path.to_string_lossy().into_owned()).await;
    let _ = tokio::fs::remove_file(&temp_path).await;
    result
}

#[tauri::command]
pub(crate) async fn delete_dictionary(app: tauri::AppHandle, dict_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM entries WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM frequencies WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM pitches WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM pronunciations WHERE dict_name = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM dictionary_meta WHERE title = ?1",
        params![dict_name],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn delete_dictionaries(app: tauri::AppHandle, dict_names: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for dict_name in dict_names {
        tx.execute(
            "DELETE FROM entries WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM frequencies WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM pitches WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM pronunciations WHERE dict_name = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM dictionary_meta WHERE title = ?1",
            params![dict_name],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn clear_database(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
    let mut db = open_db(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM entries", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM frequencies", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pitches", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM pronunciations", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM dictionary_meta", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
    }).await.map_err(|e| e.to_string())?
}

pub(crate) fn is_kanji(c: &char) -> bool {
    (*c >= '\u{4e00}' && *c <= '\u{9faf}') || (*c >= '\u{3400}' && *c <= '\u{4dbf}')
}

pub(crate) fn is_valid_chunk(chars: &[char]) -> bool {
    let mut seen_kana = false;

    for &c in chars {
        let kana = (c >= '\u{3040}' && c <= '\u{309f}') || (c >= '\u{30a0}' && c <= '\u{30ff}');

        if kana {
            seen_kana = true;
        } else if is_kanji(&c) && seen_kana {
            return false;
        }
    }

    true
}

pub(crate) fn split_furigana(term: &str, reading: &str) -> Vec<TextToken> {
    let term_chars: Vec<char> = term.chars().collect();
    let read_chars: Vec<char> = reading.chars().collect();
    let mut pre = 0;
    while pre < term_chars.len() && pre < read_chars.len() && term_chars[pre] == read_chars[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < term_chars.len() - pre
        && suf < read_chars.len() - pre
        && term_chars[term_chars.len() - 1 - suf] == read_chars[read_chars.len() - 1 - suf]
    {
        suf += 1;
    }
    let mut res = Vec::new();
    if pre > 0 {
        res.push(TextToken {
            text: term_chars[..pre].iter().collect(),
            reading: None,
        });
    }
    let stem_term: String = term_chars[pre..term_chars.len() - suf].iter().collect();
    let stem_read: String = read_chars[pre..read_chars.len() - suf].iter().collect();
    if !stem_term.is_empty() {
        if stem_term == stem_read {
            res.push(TextToken {
                text: stem_term,
                reading: None,
            });
        } else {
            res.push(TextToken {
                text: stem_term,
                reading: Some(stem_read),
            });
        }
    }
    if suf > 0 {
        res.push(TextToken {
            text: term_chars[term_chars.len() - suf..].iter().collect(),
            reading: None,
        });
    }
    res
}

pub(crate) fn contextual_suffix_reading(suffix: &str) -> Option<&'static str> {
    match suffix {
        "\u{5185}" => Some("\u{306A}\u{3044}"),
        "\u{5916}" => Some("\u{304C}\u{3044}"),
        "\u{4E2D}" => Some("\u{3061}\u{3085}\u{3046}"),
        "\u{9593}" => Some("\u{304B}\u{3093}"),
        "\u{524D}" => Some("\u{307E}\u{3048}"),
        "\u{5F8C}" => Some("\u{3054}"),
        "\u{4E0A}" => Some("\u{3058}\u{3087}\u{3046}"),
        "\u{4E0B}" => Some("\u{304B}"),
        "\u{7684}" => Some("\u{3066}\u{304D}"),
        "\u{5316}" => Some("\u{304B}"),
        "\u{6027}" => Some("\u{305B}\u{3044}"),
        "\u{7528}" => Some("\u{3088}\u{3046}"),
        "\u{8005}" => Some("\u{3057}\u{3083}"),
        "\u{529B}" => Some("\u{308A}\u{3087}\u{304F}"),
        "\u{7387}" => Some("\u{308A}\u{3064}"),
        "\u{5074}" => Some("\u{304C}\u{308F}"),
        "\u{6BCE}" => Some("\u{3054}\u{3068}"),
        "\u{5225}" => Some("\u{3079}\u{3064}"),
        "\u{7D1A}" => Some("\u{304D}\u{3085}\u{3046}"),
        "\u{5F0F}" => Some("\u{3057}\u{304D}"),
        "\u{7248}" => Some("\u{3070}\u{3093}"),
        "\u{88FD}" => Some("\u{305B}\u{3044}"),
        "\u{6E08}" => Some("\u{305A}\u{307F}"),
        "\u{540C}\u{58EB}" => Some("\u{3069}\u{3046}\u{3057}"),
        "\u{8FBC}\u{307F}" => Some("\u{3053}\u{307F}"),
        "\u{4ED8}\u{304D}" => Some("\u{3064}\u{304D}"),
        "\u{5411}\u{3051}" => Some("\u{3080}\u{3051}"),
        "\u{5BA4}" => Some("\u{3057}\u{3064}"),
        _ => None,
    }
}

pub(crate) fn has_kanji(text: &str) -> bool {
    text.chars().any(|c| is_kanji(&c))
}

pub(crate) fn is_english_word_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
}

pub(crate) fn is_english_word_connector(c: char) -> bool {
    matches!(
        c,
        '\'' | '\u{2019}' | '-' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}'
    )
}

pub(crate) fn is_english_word_inner(c: char) -> bool {
    is_english_word_letter(c) || is_english_word_connector(c)
}

pub(crate) fn is_english_lookup_word(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || !chars.iter().any(|c| is_english_word_letter(*c)) {
        return false;
    }
    for (index, c) in chars.iter().enumerate() {
        if is_english_word_letter(*c) {
            continue;
        }
        if is_english_word_connector(*c)
            && index > 0
            && index + 1 < chars.len()
            && is_english_word_letter(chars[index - 1])
            && is_english_word_letter(chars[index + 1])
        {
            continue;
        }
        return false;
    }
    true
}

pub(crate) fn english_token_bounds(chars: &[char], cursor: usize) -> Option<(usize, usize)> {
    if chars.is_empty() {
        return None;
    }
    let cursor = std::cmp::min(cursor, chars.len().saturating_sub(1));
    if !is_english_word_inner(chars[cursor]) {
        return None;
    }

    let mut start = cursor;
    while start > 0 && is_english_word_inner(chars[start - 1]) {
        start -= 1;
    }

    let mut end = cursor + 1;
    while end < chars.len() && is_english_word_inner(chars[end]) {
        end += 1;
    }

    while start < end && !is_english_word_letter(chars[start]) {
        start += 1;
    }
    while end > start && !is_english_word_letter(chars[end - 1]) {
        end -= 1;
    }

    if start >= end {
        return None;
    }
    let word: String = chars[start..end].iter().collect();
    if is_english_lookup_word(&word) {
        Some((start, end - start))
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub(crate) struct EnglishPhraseWordSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) text: String,
}

pub(crate) fn collect_english_phrase_words(chars: &[char]) -> Vec<EnglishPhraseWordSpan> {
    let mut words = Vec::new();
    let mut index = 0usize;
    while index < chars.len() {
        if !is_english_word_letter(chars[index]) {
            index += 1;
            continue;
        }

        let start = index;
        index += 1;
        while index < chars.len() && is_english_word_inner(chars[index]) {
            index += 1;
        }
        let mut end = index;
        while end > start && !is_english_word_letter(chars[end - 1]) {
            end -= 1;
        }
        if start < end {
            words.push(EnglishPhraseWordSpan {
                start,
                end,
                text: chars[start..end].iter().collect(),
            });
        }
    }
    words
}

pub(crate) fn is_english_phrase_gap(chars: &[char], start: usize, end: usize) -> bool {
    start <= end
        && chars[start..end].iter().all(|character| {
            !matches!(character, '\n' | '\r')
                && (character.is_whitespace() || matches!(character, ','))
        })
}

pub(crate) fn push_english_phrase_form(forms: &mut Vec<String>, value: impl Into<String>) {
    let normalized = value
        .into()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase();
    push_unique_string(forms, normalized.clone());
    let ascii_apostrophe = normalized.replace('\u{2019}', "'");
    push_unique_string(forms, ascii_apostrophe);
}

pub(crate) fn add_english_possessive_idiom_forms(forms: &mut Vec<String>) {
    let originals = forms.clone();
    for form in originals {
        let words = form.split_whitespace().collect::<Vec<_>>();
        if !words.iter().any(|word| {
            matches!(
                *word,
                "my" | "your" | "his" | "her" | "our" | "their" | "its"
            )
        }) {
            continue;
        }
        for replacement in ["one's", "someone's"] {
            let replaced = words
                .iter()
                .map(|word| {
                    if matches!(
                        *word,
                        "my" | "your" | "his" | "her" | "our" | "their" | "its"
                    ) {
                        replacement
                    } else {
                        *word
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            push_english_phrase_form(forms, replaced);
        }
    }
}

pub(crate) fn english_phrase_lookup_forms(
    chars: &[char],
    words: &[EnglishPhraseWordSpan],
    left: usize,
    right: usize,
) -> Vec<String> {
    let mut forms = Vec::new();
    let surface: String = chars[words[left].start..words[right].end].iter().collect();
    let joined = words[left..=right]
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let first_word = &words[left].text;
    let mut base_forms = Vec::new();
    push_english_base_forms(&mut base_forms, &first_word.to_lowercase());
    let rest = words[left + 1..=right]
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for base in base_forms {
        push_english_phrase_form(&mut forms, format!("{base} {rest}"));
        if let Some(surface_rest) = surface.strip_prefix(first_word.as_str()) {
            push_english_phrase_form(&mut forms, format!("{base}{surface_rest}"));
        }
    }

    // Prefer dictionary headwords over Yomitan non-lemma redirects. For example,
    // `closed up shop` has a technical redirect entry, while the useful article is
    // stored under `close up shop`.
    push_english_phrase_form(&mut forms, surface.clone());
    push_english_phrase_form(&mut forms, joined);

    add_english_possessive_idiom_forms(&mut forms);
    forms
}

pub(crate) fn is_english_phrasal_particle(word: &str) -> bool {
    matches!(
        word.to_lowercase().as_str(),
        "about"
            | "across"
            | "ahead"
            | "along"
            | "apart"
            | "around"
            | "aside"
            | "away"
            | "back"
            | "by"
            | "down"
            | "forward"
            | "in"
            | "off"
            | "on"
            | "out"
            | "over"
            | "round"
            | "through"
            | "together"
            | "up"
    )
}

pub(crate) fn english_separable_phrasal_forms(verb: &str, particle: &str) -> Vec<String> {
    let mut base_forms = vec![verb.to_lowercase()];
    push_english_base_forms(&mut base_forms, &verb.to_lowercase());

    let mut forms = Vec::new();
    for base in base_forms {
        push_english_phrase_form(&mut forms, format!("{base} {particle}"));
    }
    forms
}

pub(crate) fn english_token_near_cursor(text: &str, cursor: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    let cursor = cursor.min(chars.len().saturating_sub(1));
    let max_distance = std::cmp::min(24, chars.len().saturating_sub(1));

    for distance in 0..=max_distance {
        let probes = if distance == 0 {
            vec![cursor]
        } else {
            let mut values = Vec::with_capacity(2);
            if cursor >= distance {
                values.push(cursor - distance);
            }
            if cursor + distance < chars.len() {
                values.push(cursor + distance);
            }
            values
        };

        for probe in probes {
            if let Some((start, len)) = english_token_bounds(&chars, probe) {
                return Some(chars[start..start + len].iter().collect());
            }
        }
    }
    None
}

pub(crate) fn is_lookup_punctuation(c: char) -> bool {
    matches!(
        c,
        ' ' | '\n'
            | '\r'
            | '\t'
            | '\u{3000}'
            | '\u{3002}'
            | '\u{3001}'
            | '\u{FF0C}'
            | '\u{FF0E}'
            | '\u{FF01}'
            | '\u{FF1F}'
            | '\u{300C}'
            | '\u{300D}'
            | '\u{300E}'
            | '\u{300F}'
            | '\u{FF08}'
            | '\u{FF09}'
            | '('
            | ')'
            | '['
            | ']'
            | '\u{300A}'
            | '\u{300B}'
    )
}

pub(crate) fn is_japanese_lookup_char(c: char) -> bool {
    is_kanji(&c)
        || ('\u{20000}'..='\u{323af}').contains(&c)
        || ('\u{ff66}'..='\u{ff9f}').contains(&c)
        || ('\u{3040}'..='\u{309f}').contains(&c)
        || ('\u{30a0}'..='\u{30ff}').contains(&c)
        || matches!(c, '\u{3005}' | '\u{30fc}' | '\u{30fd}' | '\u{30fe}')
}

pub(crate) fn is_hiragana_char(c: char) -> bool {
    ('\u{3040}'..='\u{309f}').contains(&c)
}

pub(crate) fn is_kana_lookup_char(c: char) -> bool {
    is_hiragana_char(c) || is_katakana_char(c) || c == '\u{30fc}'
}

pub(crate) fn is_kana_only_lookup(text: &str) -> bool {
    let mut has_kana = false;
    for c in text.chars() {
        if is_kana_lookup_char(c) {
            has_kana = true;
            continue;
        }
        return false;
    }
    has_kana
}

pub(crate) fn common_prefix_char_count(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(left, right)| left == right)
        .count()
}

pub(crate) fn entry_tags_allow_deinflection(tags: &str) -> bool {
    if tags.trim().is_empty() {
        return true;
    }

    tags.to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '|')
        .any(|tag| {
            tag.starts_with("v1")
                || tag.starts_with("v5")
                || matches!(
                    tag,
                    "vk" | "vn"
                        | "vr"
                        | "vs"
                        | "vs-i"
                        | "vs-s"
                        | "vz"
                        | "vi"
                        | "vt"
                        | "aux-v"
                        | "adj-i"
                        | "adj-ix"
                        | "aux-adj"
                        | "cop"
                )
        })
}

pub(crate) fn split_entry_tags(tags: &str) -> Vec<String> {
    tags.to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '|')
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.to_string())
        .collect()
}

pub(crate) fn tags_contain_prefix(tags: &[String], prefix: &str) -> bool {
    tags.iter().any(|tag| {
        tag == prefix
            || tag
                .strip_prefix(prefix)
                .map(|rest| {
                    rest.starts_with('-')
                        || rest
                            .chars()
                            .next()
                            .map(|c| c.is_ascii_digit())
                            .unwrap_or(false)
                })
                .unwrap_or(false)
            || (prefix == "v5" && tag.starts_with("v5"))
    })
}

pub(crate) fn required_tags_for_deinflection_step(in_s: &str, out_s: &str) -> Vec<&'static str> {
    if out_s.is_empty() || out_s == "ます" || out_s == "ない" || out_s == "て" || out_s == "で"
    {
        return Vec::new();
    }

    if out_s.ends_with("する") || out_s.ends_with("為る") {
        return vec!["vs"];
    }
    if out_s.ends_with("ずる") {
        return vec!["vz"];
    }
    if out_s.ends_with("くる") || out_s.ends_with("来る") || out_s.ends_with("來る") {
        return vec!["vk"];
    }

    match out_s {
        "う" => vec!["v5u"],
        "く" => vec!["v5k"],
        "ぐ" => vec!["v5g"],
        "す" => vec!["v5s"],
        "つ" => vec!["v5t"],
        "ぬ" => vec!["v5n"],
        "ぶ" => vec!["v5b"],
        "む" => vec!["v5m"],
        "る" => {
            if matches!(in_s, "った" | "って" | "らない" | "ります" | "れ" | "ろう") {
                vec!["v5r"]
            } else if matches!(in_s, "た" | "て" | "ない" | "ます" | "ません" | "ました")
            {
                vec!["v1"]
            } else {
                vec!["v1", "v5r", "vk", "vs", "vz"]
            }
        }
        "い" => vec!["adj-i", "adj-ix", "aux-adj"],
        _ => Vec::new(),
    }
}

pub(crate) fn deinflection_reasons_match_tags(reasons: &[DeinflectReason], tags: &str) -> bool {
    let tags = split_entry_tags(tags);
    if tags.is_empty() {
        return true;
    }

    for reason in reasons {
        let required = required_tags_for_deinflection_step(&reason.in_suffix, &reason.out_suffix);
        if required.is_empty() {
            continue;
        }
        if !required
            .iter()
            .any(|required_tag| tags_contain_prefix(&tags, required_tag))
        {
            return false;
        }
    }

    true
}

pub(crate) fn deinflected_kana_match_is_plausible(surface: &str, term: &str, reading: &str) -> bool {
    if !is_kana_only_lookup(surface) {
        return true;
    }

    let surface_kana = kata_to_hira(surface);
    let candidate = if reading.trim().is_empty() {
        term
    } else {
        reading
    };
    let candidate_kana = kata_to_hira(candidate);
    let surface_len = surface_kana.chars().count();
    let candidate_len = candidate_kana.chars().count();
    let common_prefix = common_prefix_char_count(&surface_kana, &candidate_kana);

    if surface_len >= 4 && candidate_len <= 2 && common_prefix < 2 {
        return false;
    }

    true
}

pub(crate) fn is_lookup_digit(c: char) -> bool {
    c.is_ascii_digit() || ('\u{ff10}'..='\u{ff19}').contains(&c)
}

pub(crate) fn numeric_prefix_len(chars: &[char]) -> usize {
    let mut len = 0;
    while len < chars.len() && is_lookup_digit(chars[len]) {
        len += 1;
    }

    if len > 0 && len < chars.len() && is_japanese_lookup_char(chars[len]) {
        len
    } else {
        0
    }
}
pub(crate) fn is_katakana_char(c: char) -> bool {
    ('\u{30a0}'..='\u{30ff}').contains(&c) || c == '\u{30fc}'
}

pub(crate) fn lookup_numeric_prefix_fallback<'a>(
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    chars: &[char],
    rules: &[(Value, Value, String, String)],
    source_len: usize,
    max_depth: usize,
) -> Vec<DictEntry> {
    let prefix_len = numeric_prefix_len(chars);
    if prefix_len == 0 {
        return Vec::new();
    }

    let suffix_chars = &chars[prefix_len..];
    if suffix_chars.len() < 2 && !suffix_chars.iter().any(is_kanji) {
        return Vec::new();
    }

    let suffix: String = suffix_chars.iter().collect();
    internal_lookup(
        freq_stmt,
        pitch_stmt,
        pronunciation_stmt,
        stmt,
        &suffix,
        rules,
        source_len,
        max_depth,
    )
}

pub(crate) fn lookup_furigana_reading_candidates(
    stmt: &mut rusqlite::Statement<'_>,
    term: &str,
) -> Vec<String> {
    let Ok(rows) = stmt.query_map(params![term], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten()
        .filter(|reading| !reading.is_empty())
        .collect()
}

pub(crate) fn lookup_furigana_reading(stmt: &mut rusqlite::Statement<'_>, term: &str) -> Option<String> {
    lookup_furigana_reading_candidates(stmt, term)
        .into_iter()
        .next()
}

#[cfg(test)]
pub(crate) fn lookup_furigana_reading_prefer(
    stmt: &mut rusqlite::Statement<'_>,
    term: &str,
    preferred: Option<&str>,
) -> Option<String> {
    let candidates = lookup_furigana_reading_candidates(stmt, term);
    if let Some(preferred) = preferred.filter(|value| !value.is_empty()) {
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| candidate.as_str() == preferred)
        {
            return Some(candidate.clone());
        }
    }
    candidates.into_iter().next()
}

pub(crate) fn lookup_deinflected_furigana(
    stmt: &mut rusqlite::Statement<'_>,
    deinflect_rules: &[(String, String)],
    term: &str,
) -> Option<String> {
    for (in_s, out_s) in deinflect_rules {
        if term.ends_with(in_s) {
            let mut new_term = term[..term.len() - in_s.len()].to_string();
            new_term.push_str(out_s);

            if let Some(base_read) = lookup_furigana_reading(stmt, &new_term) {
                if base_read.ends_with(out_s) {
                    let mut conj_read = base_read[..base_read.len() - out_s.len()].to_string();
                    conj_read.push_str(in_s);
                    return Some(conj_read);
                }
            }
        }
    }

    None
}

pub(crate) fn contextual_furigana_tokens(
    stmt: &mut rusqlite::Statement<'_>,
    deinflect_rules: &[(String, String)],
    chars: &[char],
) -> Option<Vec<TextToken>> {
    if chars.len() < 2 {
        return None;
    }

    let max_suffix_len = std::cmp::min(3, chars.len() - 1);
    for suffix_len in (1..=max_suffix_len).rev() {
        let prefix_chars = &chars[..chars.len() - suffix_len];
        let suffix: String = chars[chars.len() - suffix_len..].iter().collect();
        let Some(suffix_reading) = contextual_suffix_reading(&suffix) else {
            continue;
        };

        let prefix: String = prefix_chars.iter().collect();
        if prefix_chars.len() < 2 || !has_kanji(&prefix) || !is_valid_chunk(prefix_chars) {
            continue;
        }

        let prefix_reading = lookup_furigana_reading(stmt, &prefix)
            .or_else(|| lookup_deinflected_furigana(stmt, deinflect_rules, &prefix));

        if let Some(prefix_reading) = prefix_reading {
            if prefix_reading.is_empty() {
                continue;
            }

            let mut tokens = split_furigana(&prefix, &prefix_reading);
            tokens.push(TextToken {
                text: suffix,
                reading: Some(suffix_reading.to_string()),
            });
            return Some(tokens);
        }
    }

    None
}

#[tauri::command]
pub(crate) async fn get_furigana(
    app: tauri::AppHandle,
    text: String,
    context_before: Option<String>,
    context_after: Option<String>,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
    // Lookup chips need stable character offsets. The previous dictionary-greedy
    // renderer returned only surface strings, so repeated text and kana runs could
    // point at the wrong character. Use the embedded morphological tokenizer first,
    // matching the Android path and keeping lookup independent from presentation.
    if let Ok(tokens) = segment_japanese_text(&text) {
        return tokens
            .into_iter()
            .map(|token| serde_json::to_value(token).map_err(|error| error.to_string()))
            .collect();
    }

    let db = open_db(&app)?;
    let before = context_before.unwrap_or_default();
    let after = context_after.unwrap_or_default();

    if before.is_empty() && after.is_empty() {
        return build_furigana_tokens(&db, &text).map(legacy_furigana_values);
    }

    let before_tail: String = before
        .chars()
        .rev()
        .take(48)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let after_head: String = after.chars().take(48).collect();
    let combined = format!("{}{}{}", before_tail, text, after_head);
    let start = before_tail.chars().count();
    let len = text.chars().count();
    let combined_tokens = build_furigana_tokens(&db, &combined)?;

    Ok(legacy_furigana_values(slice_furigana_tokens(
        &combined_tokens,
        start,
        len,
    )))
    }).await.map_err(|e| e.to_string())?
}

pub(crate) fn legacy_furigana_values(tokens: Vec<TextToken>) -> Vec<Value> {
    let mut start = 0usize;
    tokens
        .into_iter()
        .map(|token| {
            let length = token.text.chars().count();
            let end = start + length;
            let lookup = token
                .text
                .chars()
                .any(|character| is_japanese_lookup_char(character) || character.is_alphabetic());
            let value = serde_json::json!({
                "text": token.text,
                "reading": token.reading,
                "lemma": Value::Null,
                "start": start,
                "end": end,
                "partOfSpeech": "unknown",
                "lookup": lookup,
            });
            start = end;
            value
        })
        .collect()
}

pub(crate) fn build_furigana_tokens(db: &Connection, text: &str) -> Result<Vec<TextToken>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let rules = load_rules();
    let mut deinflect_rules = Vec::new();
    for (_, _, in_s, out_s) in rules {
        deinflect_rules.push((in_s.clone(), out_s.clone()));
    }
    let mut stmt = db.prepare("SELECT reading FROM entries WHERE term = ?1 AND reading != term AND reading NOT LIKE '% %' AND reading NOT LIKE '%.%' AND dict_name NOT LIKE '%kanji%' COLLATE NOCASE ORDER BY (SELECT value FROM frequencies WHERE frequencies.term = entries.term AND (frequencies.reading = entries.reading OR frequencies.reading = '') LIMIT 1) ASC NULLS LAST LIMIT 8").map_err(|e| e.to_string())?;

    while i < chars.len() {
        if !is_kanji(&chars[i]) {
            let mut j = i;
            while j < chars.len() && !is_kanji(&chars[j]) {
                j += 1;
            }
            tokens.push(TextToken {
                text: chars[i..j].iter().collect(),
                reading: None,
            });
            i = j;
            continue;
        }
        let mut found = false;
        for len in (1..=std::cmp::min(8, chars.len() - i)).rev() {
            let sub_chars = &chars[i..i + len];
            if !is_valid_chunk(sub_chars) {
                continue;
            }
            let sub: String = sub_chars.iter().collect();

            if let Some(reading) = lookup_furigana_reading(&mut stmt, &sub)
                .or_else(|| lookup_deinflected_furigana(&mut stmt, &deinflect_rules, &sub))
            {
                if !reading.is_empty() {
                    let mut split_toks = split_furigana(&sub, &reading);
                    tokens.append(&mut split_toks);
                    i += len;
                    found = true;
                    break;
                }
            }

            if let Some(mut contextual_tokens) =
                contextual_furigana_tokens(&mut stmt, &deinflect_rules, sub_chars)
            {
                tokens.append(&mut contextual_tokens);
                i += len;
                found = true;
                break;
            }
        }
        if !found {
            tokens.push(TextToken {
                text: chars[i].to_string(),
                reading: None,
            });
            i += 1;
        }
    }
    Ok(tokens)
}

pub(crate) fn slice_furigana_tokens(tokens: &[TextToken], start: usize, len: usize) -> Vec<TextToken> {
    let end = start + len;
    let mut pos = 0;
    let mut sliced = Vec::new();

    for token in tokens {
        let token_len = token.text.chars().count();
        let token_start = pos;
        let token_end = pos + token_len;
        pos = token_end;

        if token_end <= start || token_start >= end {
            continue;
        }

        let local_start = start.saturating_sub(token_start);
        let local_end = std::cmp::min(token_len, end.saturating_sub(token_start));
        let text: String = token
            .text
            .chars()
            .skip(local_start)
            .take(local_end.saturating_sub(local_start))
            .collect();

        if !text.is_empty() {
            sliced.push(TextToken {
                text,
                reading: token.reading.clone(),
            });
        }
    }

    sliced
}

pub(crate) fn internal_lookup<'a>(
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    word: &str,
    rules: &[(Value, Value, String, String)],
    source_len: usize,
    max_depth: usize,
) -> Vec<DictEntry> {
    let mut all_results = Vec::new();
    let mut terms_found = HashSet::new();
    let japanese = word.chars().any(is_japanese_lookup_char);
    let mut queue: VecDeque<(String, Vec<DeinflectReason>, usize, Option<u32>, usize)> = VecDeque::new();
    if japanese && max_depth > 0 {
        let mut candidates = Vec::new();
        for source in japanese_lookup_variants(word) {
            candidates.extend(japanese_deinflector::transform(&source).into_iter().map(|form| (form, usize::from(source != word))));
        }
        candidates.sort_by_key(|(form, cost)| (*cost, form.trace.len()));
        let mut seen = HashSet::new();
        for (form, cost) in candidates {
            if !japanese_deinflector::is_dictionary_form(form.conditions)
                || !seen.insert((form.text.clone(), form.conditions)) { continue; }
            let reasons = form.trace.iter().map(|index| {
                let rule = japanese_deinflector::rule(*index);
                DeinflectReason {
                    rule: serde_json::json!({"en": rule.name, "ja": rule.id}),
                    desc: serde_json::json!({"en": rule.description}),
                    in_suffix: rule.input.clone(), out_suffix: rule.output.clone(),
                }
            }).collect();
            queue.push_back((form.text, reasons, form.trace.len(), Some(form.conditions), cost));
        }
    } else {
        queue.push_back((word.to_string(), vec![], 0, None, 0));
    }
    let mut scheduled = HashSet::new();
    scheduled.insert(word.to_string());
    let mut expanded = 0usize;

    while let Some((current_term, current_reasons, depth, conditions, processing_steps)) = queue.pop_front() {
        expanded += 1;
        if !japanese && expanded > 256 {
            break;
        }
        let forms = lookup_forms(&current_term);

        let mut raw_entries: Vec<(String, String, String, String, String, Option<String>, i64)> = Vec::new();
        if let Ok(rows) = stmt.query_map(
            params![
                &forms[0], &forms[1], &forms[2], &forms[3], &forms[4], &forms[5], &forms[6],
                &forms[7]
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                    row.get::<_, String>(4).unwrap_or_default(),
                    row.get::<_, Option<String>>(5).unwrap_or(None),
                    row.get::<_, i64>(6).unwrap_or(0),
                ))
            },
        ) {
            for row in rows.flatten() {
                raw_entries.push(row);
            }
        }

        if !raw_entries.is_empty() {
            for (term, reading, definition, dict_name, tags, lookup_rules, score) in raw_entries {
                if conditions.is_some_and(|flags| !japanese_deinflector::entry_matches(flags, lookup_rules.as_deref(), &tags)) {
                    continue;
                }
                if conditions.is_none() && !current_reasons.is_empty() && !entry_tags_allow_deinflection(&tags) {
                    continue;
                }
                if conditions.is_none() && !current_reasons.is_empty()
                    && !deinflection_reasons_match_tags(&current_reasons, &tags)
                {
                    continue;
                }
                if conditions.is_none() && !current_reasons.is_empty()
                    && !deinflected_kana_match_is_plausible(word, &term, &reading)
                {
                    continue;
                }

                let mut valid_freqs = Vec::new();
                if let Ok(f_rows) = freq_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, i64>(2).unwrap_or_default(),
                    ))
                }) {
                    for f in f_rows.flatten() {
                        valid_freqs.push(FrequencyData {
                            dict_name: f.0,
                            display_value: f.1,
                            value: f.2,
                        });
                    }
                }

                let mut valid_pitches = Vec::new();
                if let Ok(p_rows) = pitch_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, i64>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                    ))
                }) {
                    for p in p_rows.flatten() {
                        valid_pitches.push(PitchData {
                            dict_name: p.0,
                            reading: p.2,
                            position: p.1,
                        });
                    }
                }

                let mut valid_pronunciations = Vec::new();
                if let Ok(rows) = pronunciation_stmt.query_map(params![&term, &reading], |row| {
                    Ok((
                        row.get::<_, String>(0).unwrap_or_default(),
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                        row.get::<_, String>(3).unwrap_or_default(),
                    ))
                }) {
                    for pronunciation in rows.flatten() {
                        valid_pronunciations.push(PronunciationData {
                            dict_name: pronunciation.0,
                            reading: pronunciation.1,
                            ipa: pronunciation.2,
                            tags: pronunciation.3,
                        });
                    }
                }

                let entry = DictEntry {
                    score,
                    source_term_exact_match: term == current_term || (reading != current_term && forms.iter().any(|form| term == *form)),
                    text_processing_steps: processing_steps + usize::from(japanese && term != current_term && reading != current_term),
                    term,
                    reading,
                    definition,
                    dict_name,
                    tags,
                    deinflection_reasons: current_reasons.clone(),
                    frequencies: valid_freqs,
                    pitches: valid_pitches,
                    pronunciations: valid_pronunciations,
                    source_length: source_len,
                };
                let uniq_key = format!(
                    "{}|{}|{}|{}|{}",
                    entry.term, entry.reading, entry.dict_name, entry.tags, entry.definition
                );
                if !terms_found.contains(&uniq_key) {
                    terms_found.insert(uniq_key);
                    all_results.push(entry);
                }
            }
        } else {
            let mut frequencies = Vec::new();
            if let Ok(rows) = freq_stmt.query_map(params![&current_term, ""], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, i64>(2).unwrap_or_default(),
                ))
            }) {
                for row in rows.flatten() {
                    frequencies.push(FrequencyData {
                        dict_name: row.0,
                        display_value: row.1,
                        value: row.2,
                    });
                }
            }

            let mut pronunciations = Vec::new();
            if let Ok(rows) = pronunciation_stmt.query_map(params![&current_term, ""], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                ))
            }) {
                for row in rows.flatten() {
                    pronunciations.push(PronunciationData {
                        dict_name: row.0,
                        reading: row.1,
                        ipa: row.2,
                        tags: row.3,
                    });
                }
            }

            if !frequencies.is_empty() || !pronunciations.is_empty() {
                let dict_name = pronunciations
                    .first()
                    .map(|value| value.dict_name.clone())
                    .or_else(|| frequencies.first().map(|value| value.dict_name.clone()))
                    .unwrap_or_else(|| "Metadata".to_string());
                let reading = pronunciations
                    .first()
                    .map(|value| value.reading.clone())
                    .unwrap_or_default();
                all_results.push(DictEntry {
                    score: 0,
                    source_term_exact_match: true,
                    text_processing_steps: processing_steps,
                    term: current_term.clone(),
                    reading,
                    definition: String::new(),
                    dict_name,
                    tags: String::new(),
                    deinflection_reasons: current_reasons.clone(),
                    frequencies,
                    pitches: Vec::new(),
                    pronunciations,
                    source_length: source_len,
                });
            }
        }
        if japanese || depth >= max_depth || all_results.len() >= 120 {
            continue;
        }
        for (reason, desc, in_s, out_s) in rules {
            if in_s.is_empty() {
                continue;
            }
            if current_term.ends_with(in_s) {
                if in_s.is_empty() && current_reasons.iter().any(|r| r.rule == *reason) {
                    continue;
                }
                let mut new_term = current_term[..current_term.len() - in_s.len()].to_string();
                new_term.push_str(out_s);
                if new_term.chars().count() > 24 || new_term.chars().count() < 2 {
                    continue;
                }
                if !scheduled.insert(new_term.clone()) {
                    continue;
                }
                let mut new_reasons = current_reasons.clone();
                new_reasons.insert(
                    0,
                    DeinflectReason {
                        rule: reason.clone(),
                        desc: desc.clone(),
                        in_suffix: in_s.clone(),
                        out_suffix: out_s.clone(),
                    },
                );
                queue.push_back((new_term, new_reasons, depth + 1, None, 0));
                if queue.len() >= 256 {
                    break;
                }
            }
        }
    }
    let query_forms = lookup_forms(word);
    all_results.sort_by(|a, b| {
        a.text_processing_steps.cmp(&b.text_processing_steps).then_with(|| a.deinflection_reasons.len()
            .cmp(&b.deinflection_reasons.len())
        )
            .then_with(|| b.source_term_exact_match.cmp(&a.source_term_exact_match))
            .then_with(|| {
                lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
            })
            .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            .then_with(|| b.score.cmp(&a.score))
            .then_with(|| b.source_length.cmp(&a.source_length))
    });
    all_results
}

pub(crate) fn dictionary_entry_identity(entry: &DictEntry) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        entry.term, entry.reading, entry.dict_name, entry.tags, entry.definition
    )
}

// Yomitan scans one text source from its anchor and queries every progressively
// shorter prefix. Keep the entries from all successful prefixes, while using
// the longest successful source only for the text selection.
pub(crate) fn lookup_japanese_prefixes<'a>(
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    chars: &[char],
    start: usize,
    rules: &[(Value, Value, String, String)],
    max_depth: usize,
) -> Option<(usize, Vec<DictEntry>)> {
    if start >= chars.len() {
        return None;
    }

    let mut max_len = 0usize;
    for c in chars
        .iter()
        .skip(start)
        .take(LOOKUP_MAX_SCAN_CHARS)
        .copied()
    {
        if is_lookup_punctuation(c) || (!is_japanese_lookup_char(c) && !is_lookup_digit(c)) {
            break;
        }
        max_len += 1;
    }
    if max_len == 0 {
        return None;
    }

    let mut longest_match = 0usize;
    let mut entries_by_identity: HashMap<String, usize> = HashMap::new();
    let mut all_entries: Vec<DictEntry> = Vec::new();

    for len in (1..=max_len).rev() {
        let source_chars = &chars[start..start + len];
        let source: String = source_chars.iter().collect();
        let mut entries = internal_lookup(
            freq_stmt,
            pitch_stmt,
            pronunciation_stmt,
            stmt,
            &source,
            rules,
            len,
            max_depth,
        );

        if entries.is_empty() {
            entries = lookup_numeric_prefix_fallback(
                freq_stmt,
                pitch_stmt,
                pronunciation_stmt,
                stmt,
                source_chars,
                rules,
                len,
                max_depth,
            );
        }
        entries.retain(|entry| {
            let definition = entry.definition.trim();
            !definition.is_empty()
                && definition != "[]"
                && definition != "null"
                && definition != "\"\""
        });
        if entries.is_empty() {
            continue;
        }

        if longest_match == 0 {
            longest_match = len;
        }

        for entry in entries {
            let identity = dictionary_entry_identity(&entry);
            if let Some(existing_index) = entries_by_identity.get(&identity).copied() {
                if all_entries[existing_index].source_length < entry.source_length {
                    all_entries[existing_index] = entry;
                }
                continue;
            }
            entries_by_identity.insert(identity, all_entries.len());
            all_entries.push(entry);
        }
    }

    if longest_match == 0 {
        return None;
    }

    let forms_by_length: HashMap<usize, Vec<String>> = (1..=longest_match)
        .map(|len| {
            let source: String = chars[start..start + len].iter().collect();
            (len, lookup_forms(&source))
        })
        .collect();
    all_entries.sort_by(|a, b| {
        let a_forms = forms_by_length
            .get(&a.source_length)
            .expect("source forms must exist");
        let b_forms = forms_by_length
            .get(&b.source_length)
            .expect("source forms must exist");
        b.source_length
            .cmp(&a.source_length)
            .then_with(|| a.text_processing_steps.cmp(&b.text_processing_steps))
            .then_with(|| {
                a.deinflection_reasons.len()
                    .cmp(&b.deinflection_reasons.len())
            })
            .then_with(|| b.source_term_exact_match.cmp(&a.source_term_exact_match))
            .then_with(|| lookup_entry_rank(a, a_forms).cmp(&lookup_entry_rank(b, b_forms)))
            .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            .then_with(|| b.score.cmp(&a.score))
    });

    Some((longest_match, all_entries))
}

#[tauri::command]
pub(crate) async fn lookup_word(app: tauri::AppHandle, word: String) -> Result<Vec<DictEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || { let db = open_db(&app)?; lookup_word_in_db(&db, &word) }).await.map_err(|e| e.to_string())?
}

pub(crate) fn lookup_word_in_db(db: &Connection, word: &str) -> Result<Vec<DictEntry>, String> {
    let rules = load_rules();
    let clean_word = word.trim();
    let chars: Vec<char> = clean_word.chars().collect();
    let mut all_entries = Vec::new();
    let mut found_terms = HashSet::new();
    let max_len = std::cmp::min(20, chars.len());
    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 32").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 16").map_err(|e| e.to_string())?;
    let mut pronunciation_stmt = db.prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32").map_err(|e| e.to_string())?;
    let mut stmt = core::database::prepare_term_lookup(&db).map_err(|e| e.to_string())?;

    if chars
        .first()
        .copied()
        .is_some_and(|c| is_japanese_lookup_char(c) || is_lookup_digit(c))
    {
        return Ok(lookup_japanese_prefixes(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            &chars,
            0,
            rules,
            LOOKUP_DIRECT_DEINFLECT_DEPTH,
        )
        .map(|(_, entries)| entries)
        .unwrap_or_default());
    }

    for len in (1..=max_len).rev() {
        let sub: String = chars[0..len].iter().collect();
        if len < 2 && !has_kanji(&sub) && !is_english_lookup_word(&sub) {
            continue;
        }
        let mut entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            &sub,
            &rules,
            len,
            LOOKUP_DIRECT_DEINFLECT_DEPTH,
        );
        if entries.is_empty() {
            entries = lookup_numeric_prefix_fallback(
                &mut freq_stmt,
                &mut pitch_stmt,
                &mut pronunciation_stmt,
                &mut stmt,
                &chars[0..len],
                &rules,
                len,
                LOOKUP_DIRECT_DEINFLECT_DEPTH,
            );
        }
        let mut added_for_len = false;
        for entry in entries {
            let key = format!(
                "{}|{}|{}|{}",
                entry.term, entry.reading, entry.dict_name, entry.source_length
            );
            if !found_terms.contains(&key) {
                found_terms.insert(key);
                all_entries.push(entry);
                added_for_len = true;
            }
        }
        if added_for_len {
            break;
        }
    }
    let query_forms = lookup_forms(clean_word);
    all_entries.sort_by(|a, b| {
        b.source_length
            .cmp(&a.source_length)
            .then_with(|| {
                lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
            })
            .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            .then_with(|| b.score.cmp(&a.score))
    });
    Ok(all_entries)
}

pub(crate) fn scan_english_phrase_in_db<'a>(
    chars: &[char],
    cursor: usize,
    freq_stmt: &mut rusqlite::Statement<'a>,
    pitch_stmt: &mut rusqlite::Statement<'a>,
    pronunciation_stmt: &mut rusqlite::Statement<'a>,
    stmt: &mut rusqlite::Statement<'a>,
    rules: &[(Value, Value, String, String)],
) -> Option<CursorLookupResult> {
    const MAX_PHRASE_WORDS: usize = 8;

    let words = collect_english_phrase_words(chars);
    let hit_index = words
        .iter()
        .position(|word| word.start <= cursor && cursor < word.end)?;

    let mut component_start = hit_index;
    while component_start > 0
        && hit_index - component_start + 1 < MAX_PHRASE_WORDS
        && is_english_phrase_gap(
            chars,
            words[component_start - 1].end,
            words[component_start].start,
        )
    {
        component_start -= 1;
    }

    let mut component_end = hit_index;
    while component_end + 1 < words.len()
        && component_end - hit_index + 1 < MAX_PHRASE_WORDS
        && is_english_phrase_gap(
            chars,
            words[component_end].end,
            words[component_end + 1].start,
        )
    {
        component_end += 1;
    }

    let max_words = MAX_PHRASE_WORDS.min(component_end - component_start + 1);
    // Prefer the nearest useful expression under the pointer. Longer idioms remain
    // available by pointing at a word which is unique to that longer expression.
    for word_count in 2..=max_words {
        for left in component_start..=hit_index {
            let right = left + word_count - 1;
            if right > component_end || hit_index > right {
                continue;
            }

            let source_length = words[right].end - words[left].start;
            for form in english_phrase_lookup_forms(chars, &words, left, right) {
                let mut entries = internal_lookup(
                    freq_stmt,
                    pitch_stmt,
                    pronunciation_stmt,
                    stmt,
                    &form,
                    rules,
                    source_length,
                    0,
                );
                if entries.is_empty() {
                    continue;
                }

                let query_forms = lookup_forms(&form);
                entries.sort_by(|left_entry, right_entry| {
                    right_entry
                        .source_length
                        .cmp(&left_entry.source_length)
                        .then_with(|| {
                            lookup_entry_rank(left_entry, &query_forms)
                                .cmp(&lookup_entry_rank(right_entry, &query_forms))
                        })
                        .then_with(|| {
                            best_frequency_value(left_entry).cmp(&best_frequency_value(right_entry))
                        })
                });
                let word = entries
                    .first()
                    .map(|entry| entry.term.clone())
                    .filter(|term| !term.is_empty())
                    .unwrap_or(form);
                return Some(CursorLookupResult {
                    entries,
                    match_start: words[left].start,
                    match_len: source_length,
                    word,
                });
            }
        }
    }

    const MAX_INTERVENING_WORDS: usize = 4;
    for span_word_count in 3..=MAX_INTERVENING_WORDS + 2 {
        for left in component_start..=hit_index {
            let right = left + span_word_count - 1;
            if right > component_end || hit_index > right {
                continue;
            }
            if !is_english_phrasal_particle(&words[right].text) {
                continue;
            }

            let source_length = words[right].end - words[left].start;
            for form in english_separable_phrasal_forms(&words[left].text, &words[right].text) {
                let mut entries = internal_lookup(
                    freq_stmt,
                    pitch_stmt,
                    pronunciation_stmt,
                    stmt,
                    &form,
                    rules,
                    source_length,
                    0,
                );
                if entries.is_empty() {
                    continue;
                }

                let query_forms = lookup_forms(&form);
                entries.sort_by(|left_entry, right_entry| {
                    right_entry
                        .source_length
                        .cmp(&left_entry.source_length)
                        .then_with(|| {
                            lookup_entry_rank(left_entry, &query_forms)
                                .cmp(&lookup_entry_rank(right_entry, &query_forms))
                        })
                        .then_with(|| {
                            best_frequency_value(left_entry).cmp(&best_frequency_value(right_entry))
                        })
                });
                let word = entries
                    .first()
                    .map(|entry| entry.term.clone())
                    .filter(|term| !term.is_empty())
                    .unwrap_or(form);
                return Some(CursorLookupResult {
                    entries,
                    match_start: words[left].start,
                    match_len: source_length,
                    word,
                });
            }
        }
    }

    None
}

#[tauri::command]
pub(crate) async fn scan_cursor(
    app: tauri::AppHandle,
    sentence: String,
    cursor: usize,
) -> Result<CursorLookupResult, String> {
    tauri::async_runtime::spawn_blocking(move || { let db = open_db(&app)?; scan_cursor_in_db(&db, &sentence, cursor) }).await.map_err(|e| e.to_string())?
}

pub(crate) fn scan_cursor_in_db(
    db: &Connection,
    sentence: &str,
    cursor: usize,
) -> Result<CursorLookupResult, String> {
    let rules = load_rules();
    let chars: Vec<char> = sentence.chars().collect();
    if chars.is_empty() {
        return Err("Empty sentence".into());
    }
    let cursor = std::cmp::min(cursor, chars.len().saturating_sub(1));

    let mut freq_stmt = db.prepare("SELECT dict_name, display_value, value FROM frequencies WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') ORDER BY CASE WHEN value > 0 THEN 0 ELSE 1 END, value ASC LIMIT 32").map_err(|e| e.to_string())?;
    let mut pitch_stmt = db.prepare("SELECT dict_name, position, reading FROM pitches WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 16").map_err(|e| e.to_string())?;
    let mut pronunciation_stmt = db.prepare("SELECT dict_name, reading, ipa, tags FROM pronunciations WHERE term = ?1 AND (reading = ?2 OR reading = '' OR ?2 = '') LIMIT 32").map_err(|e| e.to_string())?;
    let mut stmt = core::database::prepare_term_lookup(&db).map_err(|e| e.to_string())?;

    if let Some(result) = scan_english_phrase_in_db(
        &chars,
        cursor,
        &mut freq_stmt,
        &mut pitch_stmt,
        &mut pronunciation_stmt,
        &mut stmt,
        &rules,
    ) {
        return Ok(result);
    }

    if let Some((start, len)) = english_token_bounds(&chars, cursor) {
        let word: String = chars[start..start + len].iter().collect();
        let mut entries = internal_lookup(
            &mut freq_stmt,
            &mut pitch_stmt,
            &mut pronunciation_stmt,
            &mut stmt,
            &word,
            &rules,
            len,
            0,
        );
        if entries.is_empty() {
            let lower = word.to_lowercase();
            if lower != word {
                entries = internal_lookup(
                    &mut freq_stmt,
                    &mut pitch_stmt,
                    &mut pronunciation_stmt,
                    &mut stmt,
                    &lower,
                    &rules,
                    len,
                    0,
                );
            }
        }
        if !entries.is_empty() {
            let query_forms = lookup_forms(&word);
            entries.sort_by(|a, b| {
                b.source_length
                    .cmp(&a.source_length)
                    .then_with(|| {
                        lookup_entry_rank(a, &query_forms).cmp(&lookup_entry_rank(b, &query_forms))
                    })
                    .then_with(|| best_frequency_value(a).cmp(&best_frequency_value(b)))
            .then_with(|| b.score.cmp(&a.score))
            });
            return Ok(CursorLookupResult {
                entries,
                match_start: start,
                match_len: len,
                word,
            });
        }
    }

    if !is_japanese_lookup_char(chars[cursor]) && !is_lookup_digit(chars[cursor]) {
        return Err("No match".into());
    }

    let Some((match_len, entries)) = lookup_japanese_prefixes(
        &mut freq_stmt,
        &mut pitch_stmt,
        &mut pronunciation_stmt,
        &mut stmt,
        &chars,
        cursor,
        rules,
        LOOKUP_SCAN_DEINFLECT_DEPTH,
    ) else {
        return Err("No match".into());
    };
    let word: String = chars[cursor..cursor + match_len].iter().collect();
    Ok(CursorLookupResult {
        entries,
        match_start: cursor,
        match_len,
        word,
    })
}
