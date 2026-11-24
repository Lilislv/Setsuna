use reqwest::{redirect, Client, RequestBuilder, Url};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const JIKAN: &str = "Jikan";
const ANILIST: &str = "AniList";
const TVMAZE: &str = "TVmaze";
const TMDB: &str = "TMDB";
const COMMONS: &str = "Wikimedia Commons";
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const RESULTS_PER_SOURCE: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Poster {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<u16>,
    kind: &'static str,
    source: &'static str,
    image_url: String,
    page_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    attribution: Option<String>,
}

#[derive(Serialize, Default)]
pub struct PosterSearch {
    candidates: Vec<Poster>,
    unavailable: Vec<&'static str>,
}

type CatalogResult = Result<Vec<Poster>, ()>;

async fn json(request: RequestBuilder) -> Result<Value, ()> {
    let mut response = request.send().await.map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn provider_url(value: &Value, hosts: &[&str], path_prefix: &str) -> Option<String> {
    let url = Url::parse(value.as_str()?).ok()?;
    (url.scheme() == "https"
        && hosts.contains(&url.host_str()?)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path().starts_with(path_prefix))
    .then(|| url.to_string())
}

fn year_from_date(value: &Value) -> Option<u16> {
    value.as_str()?.get(..4)?.parse().ok()
}

fn parse_jikan(item: &Value) -> Option<Poster> {
    let id = item["mal_id"].as_u64()?;
    let image = &item["images"]["jpg"];
    let image_url = ["large_image_url", "image_url"]
        .iter()
        .find_map(|key| provider_url(&image[*key], &["cdn.myanimelist.net"], "/images/anime/"))?;
    Some(Poster {
        id: format!("jikan:{id}"),
        title: item["title"].as_str()?.into(),
        year: year_from_date(&item["aired"]["from"])
            .or_else(|| item["year"].as_u64()?.try_into().ok()),
        kind: "anime",
        source: JIKAN,
        image_url,
        page_url: format!("https://myanimelist.net/anime/{id}"),
        attribution: Some("MyAnimeList · Jikan".into()),
    })
}

fn parse_anilist(item: &Value) -> Option<Poster> {
    let id = item["id"].as_u64()?;
    Some(Poster {
        id: format!("anilist:{id}"),
        title: item["title"]["romaji"].as_str()?.into(),
        year: item["startDate"]["year"]
            .as_u64()
            .and_then(|year| year.try_into().ok()),
        kind: "anime",
        source: ANILIST,
        image_url: provider_url(
            &item["coverImage"]["large"],
            &["s4.anilist.co"],
            "/file/anilistcdn/media/anime/cover/",
        )?,
        page_url: format!("https://anilist.co/anime/{id}"),
        attribution: Some(ANILIST.into()),
    })
}

fn parse_tvmaze(item: &Value) -> Option<Poster> {
    let show = &item["show"];
    let id = show["id"].as_u64()?;
    let image_url = ["medium", "original"].iter().find_map(|key| {
        provider_url(
            &show["image"][*key],
            &["static.tvmaze.com"],
            "/uploads/images/",
        )
    })?;
    Some(Poster {
        id: format!("tvmaze:{id}"),
        title: show["name"].as_str()?.into(),
        year: year_from_date(&show["premiered"]),
        kind: "series",
        source: TVMAZE,
        image_url,
        page_url: format!("https://www.tvmaze.com/shows/{id}"),
        attribution: Some(TVMAZE.into()),
    })
}

fn parse_tmdb(item: &Value) -> Option<Poster> {
    let media_type = item["media_type"].as_str()?;
    let (kind, title, date) = match media_type {
        "movie" => ("movie", "title", "release_date"),
        "tv" => ("series", "name", "first_air_date"),
        _ => return None,
    };
    let id = item["id"].as_u64()?;
    let filename = item["poster_path"].as_str()?.strip_prefix('/')?;
    if filename.is_empty()
        || !filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        || !filename.ends_with(".jpg") && !filename.ends_with(".png")
    {
        return None;
    }
    Some(Poster {
        id: format!("tmdb:{media_type}:{id}"),
        title: item[title].as_str()?.into(),
        year: year_from_date(&item[date]),
        kind,
        source: TMDB,
        image_url: format!("https://image.tmdb.org/t/p/w500/{filename}"),
        page_url: format!("https://www.themoviedb.org/{media_type}/{id}"),
        attribution: Some(TMDB.into()),
    })
}

// CommonsMetadata returns HTML even for short artist and credit fields.
// Keep the text for display, with the original credit and links available on the file page.
fn credit_text(meta: &Value, key: &str) -> Option<String> {
    let html = meta[key]["value"].as_str()?;
    let mut text = String::new();
    let mut inside_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(ch),
            _ => {}
        }
    }
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let clean = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then_some(clean)
}

fn parse_commons(page: &Value) -> Option<Poster> {
    let id = page["pageid"].as_u64()?;
    let title = page["title"].as_str()?.strip_prefix("File:")?;
    let info = page["imageinfo"].as_array()?.first()?;
    if !matches!(
        info["mime"].as_str()?,
        "image/jpeg" | "image/png" | "image/webp"
    ) {
        return None;
    }
    let meta = &info["extmetadata"];
    let license = credit_text(meta, "LicenseShortName")?;
    let attribution = [
        credit_text(meta, "Attribution").or_else(|| credit_text(meta, "Artist")),
        credit_text(meta, "Credit"),
        Some(license),
        credit_text(meta, "LicenseUrl"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    Some(Poster {
        id: format!("commons:{id}"),
        title: title
            .rsplit_once('.')
            .map_or(title, |(stem, _)| stem)
            .into(),
        year: None,
        kind: "image",
        source: COMMONS,
        image_url: provider_url(
            &info["thumburl"],
            &["thumb.wikimedia.org", "upload.wikimedia.org"],
            "/wikipedia/commons/",
        )?,
        page_url: provider_url(
            &info["descriptionurl"],
            &["commons.wikimedia.org"],
            "/wiki/File:",
        )?,
        attribution: Some(attribution),
    })
}

fn posters(items: &Value, parse: fn(&Value) -> Option<Poster>) -> CatalogResult {
    Ok(items
        .as_array()
        .ok_or(())?
        .iter()
        .filter_map(parse)
        .take(RESULTS_PER_SOURCE)
        .collect())
}

async fn jikan(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params(
        "https://api.jikan.moe/v4/anime",
        &[("q", query), ("limit", "8"), ("sfw", "true")],
    )
    .map_err(|_| ())?;
    posters(&json(client.get(url)).await?["data"], parse_jikan)
}

async fn anilist(client: &Client, query: &str) -> CatalogResult {
    let body = serde_json::json!({
        "query": "query ($search: String!) { Page(perPage: 8) { media(search: $search, type: ANIME, isAdult: false) { id title { romaji } startDate { year } coverImage { large } } } }",
        "variables": {"search": query},
    });
    let request = client
        .post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .body(body.to_string());
    let data = json(request).await?;
    posters(&data["data"]["Page"]["media"], parse_anilist)
}

async fn tvmaze(client: &Client, query: &str) -> CatalogResult {
    let url = Url::parse_with_params("https://api.tvmaze.com/search/shows", &[("q", query)])
        .map_err(|_| ())?;
    posters(&json(client.get(url)).await?, parse_tvmaze)
}

async fn tmdb(client: &Client, query: &str, language: &str, token: Option<&str>) -> CatalogResult {
    let Some(token) = token else {
        return Ok(Vec::new());
    };
    let url = Url::parse_with_params(
        "https://api.themoviedb.org/3/search/multi",
        &[("query", query), ("language", language)],
    )
    .map_err(|_| ())?;
    posters(
        &json(client.get(url).bearer_auth(token)).await?["results"],
        parse_tmdb,
    )
}

async fn commons(client: &Client, query: &str) -> CatalogResult {
    let search = format!("intitle:\"{}\" film poster", query.replace('"', " "));
    let url = Url::parse_with_params(
        "https://commons.wikimedia.org/w/api.php",
        &[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrsearch", &search),
            ("gsrnamespace", "6"),
            ("gsrlimit", "8"),
            ("prop", "imageinfo"),
            ("iiurlwidth", "500"),
            ("iiprop", "url|mime|extmetadata"),
            (
                "iiextmetadatafilter",
                "Attribution|Artist|Credit|LicenseShortName|LicenseUrl",
            ),
        ],
    )
    .map_err(|_| ())?;
    let mut data = json(client.get(url)).await?;
    if data.get("error").is_some() {
        return Err(());
    }
    // A successful generator search with no results has no query property.
    if data.get("query").is_none() && data.get("batchcomplete").is_some() {
        return Ok(Vec::new());
    }
    let pages = data.pointer_mut("/query/pages").ok_or(())?;
    pages
        .as_array_mut()
        .ok_or(())?
        .sort_by_key(|page| page["index"].as_u64().unwrap_or(u64::MAX));
    posters(pages, parse_commons)
}

#[tauri::command]
pub async fn player_search_posters(
    query: String,
    year: Option<u16>,
    token: Option<String>,
    language: Option<String>,
) -> Result<PosterSearch, String> {
    let query = query.trim();
    if query.is_empty()
        || query.chars().count() > 200
        || query.chars().any(char::is_control)
        || query.starts_with('/')
        || query.contains('\\')
        || query.contains("://")
        || query.starts_with("./")
        || query.starts_with("../")
        || query.starts_with("~/")
        || query.as_bytes().get(1..3) == Some(b":/")
    {
        return Err("Enter a title of up to 200 characters.".into());
    }
    let token = token
        .filter(|t| !t.trim().is_empty())
        .or_else(|| std::env::var("SETSUNA_TMDB_TOKEN").ok());
    let token = token.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let language = language
        .as_deref()
        .filter(|s| {
            s.len() <= 12
                && !s.is_empty()
                && s.bytes().all(|c| c.is_ascii_alphabetic() || c == b'-')
        })
        .unwrap_or("en-US");
    let client = Client::builder()
        .user_agent(concat!(
            "Setsuna/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/Lilislv/Setsuna)"
        ))
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize poster search.")?;
    let (anime, ani_list, tv, films, images) = tokio::join!(
        jikan(&client, query),
        anilist(&client, query),
        tvmaze(&client, query),
        tmdb(&client, query, language, token),
        commons(&client, query)
    );
    let mut search = PosterSearch::default();
    let mut ranked = Vec::new();
    for (source, result) in [
        (TMDB, films),
        (JIKAN, anime),
        (ANILIST, ani_list),
        (TVMAZE, tv),
        (COMMONS, images),
    ] {
        match result {
            Ok(items) => ranked.extend(items.into_iter().enumerate()),
            Err(()) => search.unavailable.push(source),
        }
    }
    let query_lowercase = query.to_lowercase();
    ranked.sort_by_cached_key(|(index, poster)| {
        (
            year.is_some() && poster.year != year,
            poster.title.to_lowercase() != query_lowercase,
            *index,
        )
    });
    search.candidates = ranked.into_iter().map(|(_, poster)| poster).collect();
    Ok(search)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anime_and_tv_map_nullable_years_and_use_provider_images() {
        let anime = json!({"mal_id":47,"title":"Akira","year":null,"aired":{"from":"1988-07-16"},
            "images":{"jpg":{"image_url":"https://cdn.myanimelist.net/images/anime/3/example.jpg"}}});
        let result = serde_json::to_value(parse_jikan(&anime).unwrap()).unwrap();
        assert_eq!(result["year"], 1988);
        assert_eq!(result["pageUrl"], "https://myanimelist.net/anime/47");
        assert_eq!(result["imageUrl"], anime["images"]["jpg"]["image_url"]);

        let mut tv = json!({"show":{"id":37336,"name":"Shōgun","premiered":null,
            "image":{"original":"https://static.tvmaze.com/uploads/images/original_untouched/506/1265637.jpg"}}});
        assert!(parse_tvmaze(&tv).unwrap().year.is_none());
        tv["show"]["image"]["original"] =
            json!("https://static.tvmaze.com.example.org/uploads/images/1.jpg");
        assert!(parse_tvmaze(&tv).is_none());
    }

    #[test]
    fn anilist_maps_cover_id_and_release_year() {
        let item = json!({"id":183385, "title":{"romaji":"Watashi wo Tabetai, Hitodenashi"},
            "startDate":{"year":2025}, "coverImage":{"large":"https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx183385-f1TgnttLckBT.jpg"}});
        let result = parse_anilist(&item).unwrap();
        assert_eq!(result.source, ANILIST);
        assert_eq!(result.id, "anilist:183385");
        assert_eq!(result.year, Some(2025));
        assert_eq!(result.page_url, "https://anilist.co/anime/183385");
    }

    #[test]
    fn tmdb_separates_movies_and_tv_and_skips_invalid_art_and_people() {
        let mut item = json!({"id":12,"title":"Movie","release_date":"1999-01-01",
            "name":"Series","first_air_date":"2004-01-01","media_type":"movie","poster_path":"/abc123.jpg"});
        assert_eq!(parse_tmdb(&item).unwrap().year, Some(1999));
        item["media_type"] = json!("tv");
        assert_eq!(parse_tmdb(&item).unwrap().id, "tmdb:tv:12");
        item["media_type"] = json!("person");
        assert!(parse_tmdb(&item).is_none());
        item["media_type"] = json!("movie");
        item["poster_path"] = json!("//foreign.example/art.jpg");
        assert!(parse_tmdb(&item).is_none());
    }

    #[test]
    fn commons_keeps_license_credit_and_rejects_external_or_nonimage_files() {
        let mut page = json!({"pageid":1, "title":"File:Example.jpg", "imageinfo":[{
            "mime":"image/jpeg","descriptionurl":"https://commons.wikimedia.org/wiki/File:Example.jpg",
            "thumburl":"https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/500px-Example.jpg",
            "extmetadata":{"Artist":{"value":"<b>Artist &amp; Co</b>"},"Credit":{"value":"Archive"},
                "LicenseShortName":{"value":"Public domain"}}}]});
        assert_eq!(
            parse_commons(&page).unwrap().attribution.as_deref(),
            Some("Artist & Co · Archive · Public domain")
        );
        page["imageinfo"][0]["mime"] = json!("image/svg+xml");
        assert!(parse_commons(&page).is_none());
        page["imageinfo"][0]["mime"] = json!("image/jpeg");
        page["imageinfo"][0]["thumburl"] =
            json!("https://upload.wikimedia.org/wikipedia/en/a/ab/Example.jpg");
        assert!(parse_commons(&page).is_none());
    }
}
