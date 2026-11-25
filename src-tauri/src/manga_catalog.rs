//! Manga & Light Novel catalog + cover lookup via AniList GraphQL and Jikan (MyAnimeList).

use base64::{engine::general_purpose, Engine as _};
use reqwest::{redirect, Client, RequestBuilder, Url};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

const ANILIST: &str = "AniList";
const JIKAN: &str = "MyAnimeList";
const SHIKIMORI: &str = "Shikimori";
const KITSU: &str = "Kitsu";
const MANGAUPDATES: &str = "MangaUpdates";
const MANGADEX: &str = "MangaDex";
const APPLE_BOOKS: &str = "Apple Books";
const MAX_JSON_BYTES: usize = 2 * 1_048_576;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const RESULTS_PER_SOURCE: usize = 8;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCandidate {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u16>,
    pub format: String,
    pub source: &'static str,
    pub image_url: String,
    pub page_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_number: Option<f64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MangaCatalogSearch {
    pub candidates: Vec<CatalogCandidate>,
    pub unavailable: Vec<&'static str>,
}

type CatalogResult = Result<Vec<CatalogCandidate>, ()>;

async fn read_bounded(request: RequestBuilder, max_bytes: usize) -> Result<Vec<u8>, ()> {
    let mut response = request.send().await.map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_json(request: RequestBuilder) -> Result<Value, ()> {
    let bytes = read_bounded(request, MAX_JSON_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn allowed_cover_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let path = url.path();
    let valid = (host == "s4.anilist.co" && path.starts_with("/file/anilistcdn/media/"))
        || (host == "cdn.myanimelist.net" && path.starts_with("/images/"))
        || (host == "uploads.mangadex.org" && path.starts_with("/covers/"))
        || (host.ends_with(".mzstatic.com") && path.starts_with("/image/thumb/"))
        || ((host == "shikimori.one" || host.ends_with(".shikimori.one"))
            && path.starts_with("/system/"))
        || ((host == "media.kitsu.app" || host == "media.kitsu.io")
            && path.starts_with("/manga/"))
        || (host == "cdn.mangaupdates.com" && path.starts_with("/image/"));
    valid.then(|| url.to_string())
}

fn non_empty_str(value: &Value) -> Option<String> {
    let s = value.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn format_anilist_kind(fmt: Option<&str>) -> String {
    match fmt {
        Some("NOVEL") => "Light Novel".to_string(),
        Some("ONE_SHOT") => "One-shot".to_string(),
        _ => "Manga".to_string(),
    }
}

fn parse_anilist(item: &Value) -> Option<CatalogCandidate> {
    let id = item["id"].as_u64()?;
    let title_obj = &item["title"];
    let title = non_empty_str(&title_obj["romaji"])
        .or_else(|| non_empty_str(&title_obj["english"]))
        .or_else(|| non_empty_str(&title_obj["native"]))?;
    let native_title = non_empty_str(&title_obj["native"]);
    let image_raw = item["coverImage"]["extraLarge"]
        .as_str()
        .or_else(|| item["coverImage"]["large"].as_str())?;
    let image_url = allowed_cover_url(image_raw)?;
    let year = item["startDate"]["year"]
        .as_u64()
        .and_then(|y| y.try_into().ok());
    let author = item["staff"]["edges"]
        .as_array()
        .and_then(|edges| {
            edges.iter().find_map(|edge| {
                let role = edge["role"].as_str().unwrap_or("");
                if role.contains("Story") || role.contains("Art") || role.is_empty() {
                    non_empty_str(&edge["node"]["name"]["native"])
                        .or_else(|| non_empty_str(&edge["node"]["name"]["full"]))
                } else {
                    None
                }
            })
        });

    Some(CatalogCandidate {
        id: format!("anilist:manga:{id}"),
        title,
        native_title,
        author,
        year,
        format: format_anilist_kind(item["format"].as_str()),
        source: ANILIST,
        image_url,
        page_url: format!("https://anilist.co/manga/{id}"),
        volume: None,
        volume_number: None,
    })
}

fn parse_jikan(item: &Value) -> Option<CatalogCandidate> {
    let id = item["mal_id"].as_u64()?;
    let title = non_empty_str(&item["title"])?;
    let native_title = non_empty_str(&item["title_japanese"]);
    let image = &item["images"]["jpg"];
    let image_raw = ["large_image_url", "image_url"]
        .iter()
        .find_map(|k| image[*k].as_str())?;
    let image_url = allowed_cover_url(image_raw)?;
    let year = item["published"]["prop"]["from"]["year"]
        .as_u64()
        .and_then(|y| y.try_into().ok());
    let author = item["authors"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|a| non_empty_str(&a["name"]));
    let kind = non_empty_str(&item["type"]).unwrap_or_else(|| "Manga".to_string());

    Some(CatalogCandidate {
        id: format!("jikan:manga:{id}"),
        title,
        native_title,
        author,
        year,
        format: kind,
        source: JIKAN,
        image_url,
        page_url: format!("https://myanimelist.net/manga/{id}"),
        volume: None,
        volume_number: None,
    })
}

fn normalize_kind_label(raw: Option<&str>) -> String {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("light_novel" | "novel") => "Light Novel".to_string(),
        Some("one_shot") => "One-shot".to_string(),
        Some("manhwa") => "Manhwa".to_string(),
        Some("manhua") => "Manhua".to_string(),
        Some("doujin" | "doujinshi") => "Doujinshi".to_string(),
        _ => "Manga".to_string(),
    }
}

fn parse_year_prefix(raw: Option<&str>) -> Option<u16> {
    let s = raw?.trim();
    s.get(..4)?.parse::<u16>().ok()
}

fn parse_shikimori(item: &Value) -> Option<CatalogCandidate> {
    let id = item["id"].as_u64()?;
    let title = non_empty_str(&item["name"]).or_else(|| non_empty_str(&item["russian"]))?;
    let native_title = item["japanese"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(non_empty_str)
        .or_else(|| non_empty_str(&item["japanese"]));
    let raw_img = non_empty_str(&item["image"]["original"])
        .or_else(|| non_empty_str(&item["image"]["preview"]))?;
    if raw_img.contains("/missing_") {
        return None;
    }
    let full_img = if raw_img.starts_with('/') {
        format!("https://shikimori.one{raw_img}")
    } else {
        raw_img
    };
    let image_url = allowed_cover_url(&full_img)?;
    let year = parse_year_prefix(item["aired_on"].as_str());
    let format = normalize_kind_label(item["kind"].as_str());

    Some(CatalogCandidate {
        id: format!("shikimori:manga:{id}"),
        title,
        native_title,
        author: None,
        year,
        format,
        source: SHIKIMORI,
        image_url,
        page_url: format!("https://shikimori.one/mangas/{id}"),
        volume: None,
        volume_number: None,
    })
}

fn parse_kitsu(item: &Value) -> Option<CatalogCandidate> {
    let id = non_empty_str(&item["id"])
        .or_else(|| item["id"].as_u64().map(|n| n.to_string()))?;
    let attrs = &item["attributes"];
    let title = non_empty_str(&attrs["canonicalTitle"])
        .or_else(|| non_empty_str(&attrs["titles"]["en_jp"]))
        .or_else(|| non_empty_str(&attrs["titles"]["en"]))?;
    let native_title = non_empty_str(&attrs["titles"]["ja_jp"]);
    let img_raw = non_empty_str(&attrs["posterImage"]["large"])
        .or_else(|| non_empty_str(&attrs["posterImage"]["original"]))
        .or_else(|| non_empty_str(&attrs["posterImage"]["medium"]))?;
    let image_url = allowed_cover_url(&img_raw)?;
    let year = parse_year_prefix(attrs["startDate"].as_str());
    let format = normalize_kind_label(attrs["subtype"].as_str());

    Some(CatalogCandidate {
        id: format!("kitsu:manga:{id}"),
        title,
        native_title,
        author: None,
        year,
        format,
        source: KITSU,
        image_url,
        page_url: format!("https://kitsu.app/manga/{id}"),
        volume: None,
        volume_number: None,
    })
}

fn parse_mangaupdates(item: &Value) -> Option<CatalogCandidate> {
    let rec = &item["record"];
    let id = rec["series_id"].as_u64()?;
    let title = non_empty_str(&rec["title"])?;
    let img_raw = non_empty_str(&rec["image"]["url"]["original"])
        .or_else(|| non_empty_str(&rec["image"]["url"]["thumb"]))?;
    let image_url = allowed_cover_url(&img_raw)?;
    let year = non_empty_str(&rec["year"])
        .and_then(|s| s.parse::<u16>().ok())
        .or_else(|| rec["year"].as_u64().and_then(|y| y.try_into().ok()));
    let format = non_empty_str(&rec["type"]).unwrap_or_else(|| "Manga".to_string());
    let page_url = non_empty_str(&rec["url"])
        .unwrap_or_else(|| format!("https://www.mangaupdates.com/series/{id}"));

    Some(CatalogCandidate {
        id: format!("mangaupdates:manga:{id}"),
        title,
        native_title: None,
        author: None,
        year,
        format,
        source: MANGAUPDATES,
        image_url,
        page_url,
        volume: None,
        volume_number: None,
    })
}

async fn search_anilist(client: &Client, query: &str) -> CatalogResult {
    let body = serde_json::json!({
        "query": "query ($search: String!) { Page(perPage: 8) { media(search: $search, type: MANGA, isAdult: false) { id format title { native romaji english } startDate { year } coverImage { extraLarge large } staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full native } } } } } } }",
        "variables": { "search": query },
    });
    let req = client
        .post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .body(body.to_string());
    let data = read_json(req).await?;
    let items = data["data"]["Page"]["media"].as_array().ok_or(())?;
    Ok(items
        .iter()
        .filter_map(parse_anilist)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn search_jikan(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params(
        "https://api.jikan.moe/v4/manga",
        &[("q", query), ("limit", "8"), ("sfw", "true")],
    )
    .map_err(|_| ())?;
    let data = read_json(client.get(url).timeout(Duration::from_secs(4))).await?;
    let items = data["data"].as_array().ok_or(())?;
    Ok(items
        .iter()
        .filter_map(parse_jikan)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn search_shikimori(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params(
        "https://shikimori.one/api/mangas",
        &[("search", query), ("limit", "8")],
    )
    .map_err(|_| ())?;
    let data = read_json(client.get(url).timeout(Duration::from_secs(4))).await?;
    let items = data.as_array().ok_or(())?;
    Ok(items
        .iter()
        .filter_map(parse_shikimori)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn search_kitsu(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params(
        "https://kitsu.io/api/edge/manga",
        &[("filter[text]", query), ("page[limit]", "8")],
    )
    .map_err(|_| ())?;
    let data = read_json(client.get(url).timeout(Duration::from_secs(4))).await?;
    let items = data["data"].as_array().ok_or(())?;
    Ok(items
        .iter()
        .filter_map(parse_kitsu)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn search_mangaupdates(client: &Client, query: &str) -> CatalogResult {
    let body = serde_json::json!({
        "search": query,
        "perpage": 8,
    });
    let req = client
        .post("https://api.mangaupdates.com/v1/series/search")
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(4))
        .body(body.to_string());
    let data = read_json(req).await?;
    let items = data["results"].as_array().ok_or(())?;
    Ok(items
        .iter()
        .filter_map(parse_mangaupdates)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn search_apple_books_candidates(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params(
        "https://itunes.apple.com/search",
        &[
            ("term", query),
            ("country", "jp"),
            ("media", "ebook"),
            ("limit", "100"),
        ],
    )
    .map_err(|_| ())?;
    let data = read_json(client.get(url).timeout(Duration::from_secs(4))).await?;
    let items = data["results"].as_array().ok_or(())?;

    let base_query = strip_trailing_volume_for_search(query).unwrap_or_else(|| query.to_string());
    let query_key = compact_alnum_ja(&base_query);
    let mut parsed: Vec<(bool, bool, CatalogCandidate)> = Vec::new();
    let mut has_prefix_matches = false;

    for item in items {
        let Some(track_id) = item["trackId"].as_u64() else {
            continue;
        };
        let Some(track_name) = non_empty_str(&item["trackName"]) else {
            continue;
        };
        if is_apple_omnibus_or_sample(&track_name) {
            continue;
        }
        let vol_num = extract_volume_from_apple_title(&track_name);
        let Some(art_raw) = non_empty_str(&item["artworkUrl100"]) else {
            continue;
        };
        let art_hi = art_raw.replace("/100x100bb.", "/600x600bb.");
        let Some(image_url) = allowed_cover_url(&art_hi).or_else(|| allowed_cover_url(&art_raw)) else {
            continue;
        };
        let author = non_empty_str(&item["artistName"]);
        let year = parse_year_prefix(item["releaseDate"].as_str());
        let page_url = non_empty_str(&item["trackViewUrl"])
            .unwrap_or_else(|| format!("https://books.apple.com/jp/book/id{track_id}"));
        let prefix_match = !query_key.is_empty() && compact_alnum_ja(&track_name).starts_with(&query_key);
        if prefix_match {
            has_prefix_matches = true;
        }
        let is_special = is_apple_special_edition(&track_name);
        parsed.push((
            prefix_match,
            is_special,
            CatalogCandidate {
                id: format!("apple:book:{track_id}"),
                title: track_name.clone(),
                native_title: Some(track_name),
                author,
                year,
                format: if vol_num.is_some() {
                    "Book Volume".to_string()
                } else {
                    "eBook".to_string()
                },
                source: APPLE_BOOKS,
                image_url,
                page_url,
                volume: vol_num.map(volume_key),
                volume_number: vol_num,
            },
        ));
    }

    let mut dedup: std::collections::HashMap<String, (bool, CatalogCandidate)> =
        std::collections::HashMap::new();
    for (prefix_match, is_special, candidate) in parsed {
        if has_prefix_matches && !prefix_match {
            continue;
        }
        let key = if let Some(ref vol) = candidate.volume {
            if has_prefix_matches {
                format!("vol:{vol}")
            } else {
                let series_base = strip_trailing_volume_for_search(&candidate.title)
                    .unwrap_or_else(|| candidate.title.clone());
                format!("{}:{vol}", compact_alnum_ja(&series_base))
            }
        } else {
            format!("title:{}", compact_alnum_ja(&candidate.title))
        };
        match dedup.get_mut(&key) {
            Some((existing_special, existing_c)) => {
                if (*existing_special && !is_special)
                    || (*existing_special == is_special && candidate.title.len() < existing_c.title.len())
                {
                    *existing_special = is_special;
                    *existing_c = candidate;
                }
            }
            None => {
                dedup.insert(key, (is_special, candidate));
            }
        }
    }

    let mut out: Vec<CatalogCandidate> = dedup.into_values().map(|(_, c)| c).collect();
    out.sort_by(|a, b| {
        let va = a.volume_number.unwrap_or(f64::MAX);
        let vb = b.volume_number.unwrap_or(f64::MAX);
        va.partial_cmp(&vb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.title.cmp(&b.title))
    });
    out.truncate(60);
    Ok(out)
}

fn build_client(timeout_secs: u64) -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!(
            "Setsuna/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/Lilislv/Setsuna)"
        ))
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(4))
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize HTTP client.".to_string())
}

fn strip_trailing_volume_for_search(query: &str) -> Option<String> {
    let folded: String = query
        .trim()
        .chars()
        .map(|ch| match ch {
            '０'..='９' => char::from_u32(('0' as u32) + (ch as u32 - '０' as u32)).unwrap_or(ch),
            '（' => '(',
            '）' => ')',
            '　' => ' ',
            _ => ch,
        })
        .collect();
    let trimmed = folded.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Strip trailing `(N)`
    let mut s = trimmed;
    if let Some(open) = s.rfind('(') {
        if s.ends_with(')') {
            let inner = s[open + 1..s.len() - 1].trim();
            if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit() || c == '.') {
                s = s[..open].trim();
            }
        }
    }
    // Strip trailing `第N巻` or trailing digits (`宝石の国2`, `Houseki no Kuni v02`)
    s = s.strip_suffix('巻').unwrap_or(s).trim_end();
    let digit_start = s
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_digit() || *c == '.')
        .last()
        .map(|(idx, _)| idx);
    if let Some(idx) = digit_start {
        if idx > 0 && idx < s.len() {
            let prefix = s[..idx].trim_end();
            let lower_p = prefix.to_ascii_lowercase();
            let stripped_marker = ["vol.", "vol", "volume", "part", "том", "第", "v"]
                .iter()
                .find_map(|m| {
                    lower_p
                        .strip_suffix(m)
                        .and_then(|rest| {
                            (rest.is_empty() || rest.ends_with(char::is_whitespace))
                                .then(|| prefix[..rest.len()].trim_end())
                        })
                })
                .unwrap_or(prefix);
            let out = stripped_marker.trim();
            if !out.is_empty() && out != trimmed {
                return Some(out.to_string());
            }
        }
    }
    (s != trimmed && !s.is_empty()).then(|| s.to_string())
}

async fn run_catalog_query(client: &Client, query: &str) -> MangaCatalogSearch {
    let (ani, shiki, kitsu, mu, mal, apple) = tokio::join!(
        search_anilist(client, query),
        search_shikimori(client, query),
        search_kitsu(client, query),
        search_mangaupdates(client, query),
        search_jikan(client, query),
        search_apple_books_candidates(client, query),
    );

    let mut result = MangaCatalogSearch::default();
    let mut unwrap_source = |name: &'static str, res: CatalogResult| -> Vec<CatalogCandidate> {
        match res {
            Ok(list) => list,
            Err(()) => {
                result.unavailable.push(name);
                Vec::new()
            }
        }
    };
    let ani_items = unwrap_source(ANILIST, ani);
    let shiki_items = unwrap_source(SHIKIMORI, shiki);
    let kitsu_items = unwrap_source(KITSU, kitsu);
    let mu_items = unwrap_source(MANGAUPDATES, mu);
    let mal_items = unwrap_source(JIKAN, mal);
    let apple_items = unwrap_source(APPLE_BOOKS, apple);

    let series_lists = [&ani_items, &shiki_items, &kitsu_items, &mu_items, &mal_items];
    let max_len = series_lists.iter().map(|l| l.len()).max().unwrap_or(0);
    let mut seen = HashSet::new();
    for i in 0..max_len {
        for list in &series_lists {
            if let Some(item) = list.get(i) {
                let key = format!(
                    "{}:{}:{}",
                    item.source,
                    item.title.trim().to_ascii_lowercase(),
                    item.volume.as_deref().unwrap_or("")
                );
                if seen.insert(key) {
                    result.candidates.push(item.clone());
                }
            }
        }
    }
    for item in apple_items {
        let key = format!(
            "{}:{}:{}",
            item.source,
            item.title.trim().to_ascii_lowercase(),
            item.volume.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            result.candidates.push(item);
        }
    }
    result
}

#[tauri::command]
pub async fn manga_search_catalog(query: String) -> Result<MangaCatalogSearch, String> {
    let query = query.trim();
    if query.is_empty()
        || query.chars().count() > 200
        || query.chars().any(char::is_control)
        || query.contains('\\')
        || query.contains("://")
    {
        return Err("Enter a title of up to 200 characters.".into());
    }

    let client = build_client(8)?;
    let mut result = run_catalog_query(&client, query).await;
    let has_series = result.candidates.iter().any(|c| c.volume.is_none());
    if !has_series {
        if let Some(base_query) = strip_trailing_volume_for_search(query) {
            let fallback = run_catalog_query(&client, &base_query).await;
            if !fallback.candidates.is_empty() {
                let mut merged = Vec::new();
                let mut seen = HashSet::new();
                // Prefer exact Apple volume hits from the user's volume-specific query,
                // then fill with series + base volumes from fallback.
                for item in fallback.candidates.into_iter().chain(result.candidates.into_iter()) {
                    let key = format!(
                        "{}:{}:{}",
                        item.source,
                        item.title.trim().to_ascii_lowercase(),
                        item.volume.as_deref().unwrap_or("")
                    );
                    if seen.insert(key) {
                        merged.push(item);
                    }
                }
                result.candidates = merged;
                result.unavailable = fallback.unavailable;
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn manga_fetch_cover_data_uri(url: String) -> Result<String, String> {
    let validated = allowed_cover_url(&url)
        .ok_or_else(|| "Unsupported cover host.".to_string())?;
    let client = build_client(10)?;
    let bytes = read_bounded(client.get(&validated), MAX_IMAGE_BYTES)
        .await
        .map_err(|()| "Could not download cover image.".to_string())?;
    if bytes.is_empty() {
        return Err("Empty cover image.".to_string());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    };
    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVolumeCover {
    pub volume: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_number: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub image_url: String,
    pub source: &'static str,
}

fn fold_fullwidth_ascii(raw: &str) -> String {
    raw.chars()
        .map(|ch| match ch {
            '０'..='９' => char::from_u32(('0' as u32) + (ch as u32 - '０' as u32)).unwrap_or(ch),
            'Ａ'..='Ｚ' => char::from_u32(('A' as u32) + (ch as u32 - 'Ａ' as u32)).unwrap_or(ch),
            'ａ'..='ｚ' => char::from_u32(('a' as u32) + (ch as u32 - 'ａ' as u32)).unwrap_or(ch),
            '（' => '(',
            '）' => ')',
            '．' => '.',
            '　' => ' ',
            _ => ch,
        })
        .collect()
}

fn compact_alnum_ja(raw: &str) -> String {
    fold_fullwidth_ascii(raw)
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn parse_volume_number_str(raw: &str) -> Option<f64> {
    let folded = fold_fullwidth_ascii(raw);
    let trimmed = folded.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val = trimmed.parse::<f64>().ok()?;
    (val > 0.0 && val < 5000.0).then_some(val)
}

fn volume_key(num: f64) -> String {
    if (num - num.round()).abs() < 1e-6 {
        format!("{}", num.round() as i64)
    } else {
        let s = format!("{num:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn is_apple_omnibus_or_sample(track_name: &str) -> bool {
    ["合本", "セット", "全巻", "パック", "試し読み", "まとめ買い", "分冊"]
        .iter()
        .any(|kw| track_name.contains(kw))
}

fn is_apple_special_edition(track_name: &str) -> bool {
    ["特装版", "限定版", "特装", "特典付", "電子限定"]
        .iter()
        .any(|kw| track_name.contains(kw))
}

fn extract_volume_from_apple_title(track_name: &str) -> Option<f64> {
    let folded = fold_fullwidth_ascii(track_name);
    let trimmed = folded.trim();
    // 1. Trailing `(N)` or `(N) ...` like `宝石の国(02)` or `宝石の国(13) (アフタヌーンコミックス)`
    if let Some(open) = trimmed.rfind('(') {
        if let Some(close_rel) = trimmed[open + 1..].find(')') {
            let inner = &trimmed[open + 1..open + 1 + close_rel];
            if let Some(n) = parse_volume_number_str(inner) {
                return Some(n);
            }
        }
    }
    // 2. Strip known suffixes like `【電子特典付き】` or `(電撃文庫)` and read trailing digits
    let without_brackets = if let Some(idx) = trimmed.find('【') {
        trimmed[..idx].trim()
    } else {
        trimmed
    };
    let clean = without_brackets.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '巻');
    let no_kan = clean.strip_suffix('巻').unwrap_or(clean).trim();
    let chars: Vec<char> = no_kan.chars().collect();
    let mut start = chars.len();
    while start > 0 && (chars[start - 1].is_ascii_digit() || chars[start - 1] == '.') {
        start -= 1;
    }
    if start < chars.len() {
        let num_str: String = chars[start..].iter().collect();
        if let Some(n) = parse_volume_number_str(num_str.trim_matches('.')) {
            return Some(n);
        }
    }
    None
}

fn extract_apple_volume(track_name: &str, series_keys: &[String]) -> Option<f64> {
    if is_apple_omnibus_or_sample(track_name) {
        return None;
    }
    let track_key = compact_alnum_ja(track_name);
    let prefix_ok = series_keys.iter().any(|k| !k.is_empty() && track_key.starts_with(k));
    if !prefix_ok {
        return None;
    }
    extract_volume_from_apple_title(track_name)
}

async fn fetch_mangadex_volumes(
    client: &Client,
    query: &str,
    anilist_id: Option<&str>,
    mal_id: Option<&str>,
) -> Vec<CatalogVolumeCover> {
    let Ok(url) = Url::parse_with_params(
        "https://api.mangadex.org/manga",
        &[
            ("title", query),
            ("limit", "8"),
            ("order[followedCount]", "desc"),
            ("contentRating[]", "safe"),
            ("contentRating[]", "suggestive"),
            ("contentRating[]", "erotica"),
        ],
    ) else {
        return Vec::new();
    };
    let Ok(search_json) = read_json(client.get(url)).await else {
        return Vec::new();
    };
    let Some(list) = search_json["data"].as_array() else {
        return Vec::new();
    };

    let best_manga_id = list
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            let id = item["id"].as_str()?;
            let links = &item["attributes"]["links"];
            let mut score: i32 = 20 - (idx as i32);
            if let Some(al) = anilist_id {
                if links["al"].as_str() == Some(al) {
                    score += 120;
                }
            }
            if let Some(mal) = mal_id {
                if links["mal"].as_str() == Some(mal) {
                    score += 90;
                }
            }
            let title_blob = item["attributes"]["title"].to_string().to_lowercase();
            if title_blob.contains("colored")
                || title_blob.contains("minimalist color")
                || title_blob.contains("full color")
            {
                score -= 60;
            }
            Some((score, id.to_string()))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, id)| id);

    let Some(manga_id) = best_manga_id else {
        return Vec::new();
    };

    let Ok(cov_url) = Url::parse_with_params(
        "https://api.mangadex.org/cover",
        &[
            ("manga[]", manga_id.as_str()),
            ("limit", "100"),
            ("order[volume]", "asc"),
        ],
    ) else {
        return Vec::new();
    };
    let Ok(cov_json) = read_json(client.get(cov_url)).await else {
        return Vec::new();
    };
    let Some(covers) = cov_json["data"].as_array() else {
        return Vec::new();
    };

    // Keep one cover per volume number, preferring original Japanese edition (`locale == "ja"`).
    let mut by_vol: BTreeMap<String, (bool, CatalogVolumeCover)> = BTreeMap::new();
    for item in covers {
        let Some(attrs) = item.get("attributes") else {
            continue;
        };
        let Some(raw_vol) = non_empty_str(&attrs["volume"]) else {
            continue;
        };
        let Some(file_name) = non_empty_str(&attrs["fileName"]) else {
            continue;
        };
        let raw_url = format!("https://uploads.mangadex.org/covers/{manga_id}/{file_name}.512.jpg");
        let Some(image_url) = allowed_cover_url(&raw_url) else {
            continue;
        };
        let vol_num = parse_volume_number_str(&raw_vol);
        let key = vol_num.map(volume_key).unwrap_or_else(|| raw_vol.clone());
        let is_ja = attrs["locale"].as_str() == Some("ja");

        let entry = CatalogVolumeCover {
            volume: key.clone(),
            volume_number: vol_num,
            title: None,
            image_url,
            source: MANGADEX,
        };
        match by_vol.get(&key) {
            Some((existing_ja, _)) if *existing_ja || !is_ja => {}
            _ => {
                by_vol.insert(key, (is_ja, entry));
            }
        }
    }

    by_vol.into_values().map(|(_, v)| v).collect()
}

async fn fetch_apple_jp_volumes(
    client: &Client,
    term: &str,
    series_keys: &[String],
) -> Vec<CatalogVolumeCover> {
    let Ok(url) = Url::parse_with_params(
        "https://itunes.apple.com/search",
        &[
            ("term", term),
            ("country", "jp"),
            ("media", "ebook"),
            ("limit", "100"),
        ],
    ) else {
        return Vec::new();
    };
    let Ok(json) = read_json(client.get(url)).await else {
        return Vec::new();
    };
    let Some(items) = json["results"].as_array() else {
        return Vec::new();
    };

    let mut by_vol: BTreeMap<String, (bool, CatalogVolumeCover)> = BTreeMap::new();
    for item in items {
        let Some(track_name) = non_empty_str(&item["trackName"]) else {
            continue;
        };
        let Some(vol_num) = extract_apple_volume(&track_name, series_keys) else {
            continue;
        };
        let Some(art_raw) = non_empty_str(&item["artworkUrl100"]) else {
            continue;
        };
        let art_hi = art_raw.replace("/100x100bb.", "/600x600bb.");
        let Some(image_url) = allowed_cover_url(&art_hi).or_else(|| allowed_cover_url(&art_raw)) else {
            continue;
        };
        let is_special = is_apple_special_edition(&track_name);
        let key = volume_key(vol_num);
        let candidate = CatalogVolumeCover {
            volume: key.clone(),
            volume_number: Some(vol_num),
            title: Some(track_name),
            image_url,
            source: APPLE_BOOKS,
        };
        match by_vol.get_mut(&key) {
            Some((existing_special, existing_cov)) => {
                if *existing_special && !is_special {
                    *existing_special = false;
                    *existing_cov = candidate;
                }
            }
            None => {
                by_vol.insert(key, (is_special, candidate));
            }
        }
    }
    by_vol.into_values().map(|(_, cov)| cov).collect()
}

#[tauri::command]
pub async fn manga_fetch_series_volumes(
    title: String,
    native_title: Option<String>,
    anilist_id: Option<String>,
    mal_id: Option<String>,
    format: Option<String>,
    target_volume: Option<String>,
) -> Result<Vec<CatalogVolumeCover>, String> {
    let title = title.trim();
    let native = native_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let primary = native.unwrap_or(title);
    if primary.is_empty() || primary.chars().count() > 200 {
        return Err("Enter a valid series title.".into());
    }
    let tv = target_volume
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let is_novel = format
        .as_deref()
        .map(|f| f.to_ascii_lowercase().contains("novel"))
        .unwrap_or(false);

    let mut series_keys = Vec::new();
    let k1 = compact_alnum_ja(title);
    if !k1.is_empty() {
        series_keys.push(k1);
    }
    if let Some(n) = native {
        let k2 = compact_alnum_ja(n);
        if !k2.is_empty() && !series_keys.contains(&k2) {
            series_keys.push(k2);
        }
    }

    let client = build_client(10)?;
    let fetch_md = async {
        if is_novel {
            Vec::new()
        } else {
            fetch_mangadex_volumes(
                &client,
                if !title.is_empty() { title } else { primary },
                anilist_id.as_deref(),
                mal_id.as_deref(),
            )
            .await
        }
    };
    let fetch_apple_main = fetch_apple_jp_volumes(&client, primary, &series_keys);
    let fetch_apple_target = async {
        if let Some(vol) = tv {
            fetch_apple_jp_volumes(&client, &format!("{primary} {vol}"), &series_keys).await
        } else {
            Vec::new()
        }
    };

    let (md_vols, apple_vols, apple_target_vols) =
        tokio::join!(fetch_md, fetch_apple_main, fetch_apple_target);

    let mut merged: BTreeMap<String, CatalogVolumeCover> = BTreeMap::new();
    for item in apple_vols.into_iter().chain(apple_target_vols.into_iter()) {
        merged.entry(item.volume.clone()).or_insert(item);
    }
    for item in md_vols {
        merged.entry(item.volume.clone()).or_insert(item);
    }

    let mut list: Vec<CatalogVolumeCover> = merged.into_values().collect();
    list.sort_by(|a, b| {
        let na = a.volume_number.unwrap_or(f64::MAX);
        let nb = b.volume_number.unwrap_or(f64::MAX);
        na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(list)
}
