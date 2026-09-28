//! Remote book text crosses a bounded navigation bridge. Dictionary UI stays local.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
const READER: &str = "yatsu_reader";
const LOOKUP: &str = "yatsu_lookup";
const ORIGIN: &str = "https://app.yatsu.moe";

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Bounds {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|n| !n.is_finite() || *n < 0.0 || *n > 100_000.0)
            || self.width < 1.0
            || self.height < 1.0
        {
            return Err("Invalid reader bounds".into());
        }
        Ok(())
    }
    fn rect(&self) -> tauri::Rect {
        tauri::Rect {
            position: tauri::LogicalPosition::new(self.x, self.y).into(),
            size: tauri::LogicalSize::new(self.width, self.height).into(),
        }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Request {
    #[serde(default)]
    revision: u64,
    id: u64,
    sentence: String,
    cursor: usize,
    anchor: Bounds,
    #[serde(default)]
    vertical: bool,
    #[serde(default)]
    prefer_right: bool,
}
#[derive(Default)]
struct Runtime {
    request: Request,
    reader: Option<Bounds>,
}
#[derive(Default)]
pub struct YatsuState(Mutex<Runtime>);
#[derive(Deserialize)]
pub struct Layout {
    reader: Bounds,
    #[serde(default)]
    language: String,
}
fn reader_url(url: &tauri::Url) -> bool {
    url.origin().ascii_serialization() == ORIGIN
}
fn parse_request(url: &tauri::Url) -> Option<Request> {
    if url.scheme() != "setsuna-yatsu"
        || url.host_str() != Some("lookup")
        || url.as_str().len() > 50_000
    {
        return None;
    }
    let data = url.query_pairs().find(|(key, _)| key == "data")?.1;
    let request: Request = serde_json::from_str(&data).ok()?;
    let count = request.sentence.chars().count();
    if count == 0 || count > 4096 || request.cursor >= count || request.anchor.validate().is_err() {
        return None;
    }
    Some(request)
}
fn clear_lookup(app: &AppHandle, revision: Option<u64>) {
    let state = app.state::<YatsuState>();
    let mut runtime = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if revision.is_some_and(|value| value != runtime.request.revision) {
        return;
    }
    runtime.request.revision = runtime.request.revision.wrapping_add(1);
    runtime.request.sentence.clear();
    let request = runtime.request.clone();
    if let Some(view) = app.get_webview(LOOKUP) {
        let _ = view.hide();
    }
    if let Some(view) = app.get_webview(READER) {
        let _ = view.eval("window.__setsunaYatsuDismiss?.()");
    }
    let _ = app.emit_to(LOOKUP, "yatsu-scan", request);
}
#[tauri::command]
pub fn dismiss_yatsu_lookup(app: AppHandle, revision: Option<u64>) {
    clear_lookup(&app, revision);
    if let Some(view) = app.get_webview(READER) {
        let _ = view.set_focus();
    }
}
// Own constrained placement: below horizontal text, before vertical text,
// switching sides near an edge, without covering the scanned character.
fn popup_bounds(reader: &Bounds, request: &Request, width: f64) -> Bounds {
    let margin = 6.0;
    let gap = 10.0;
    let a = &request.anchor;
    let mut w = width
        .clamp(280.0, 720.0)
        .min((reader.width - margin * 2.0).max(1.0));
    let mut h = 520.0_f64.min((reader.height - margin * 2.0).max(1.0));
    let (x, y) = if request.vertical {
        let left = (a.x - gap - margin).max(1.0);
        let right = (reader.width - (a.x + a.width) - gap - margin).max(1.0);
        let use_right = if request.prefer_right {
            right >= w || right >= left
        } else {
            !(left >= w || left >= right)
        };
        w = w.min(if use_right { right } else { left });
        (
            if use_right {
                a.x + a.width + gap
            } else {
                a.x - gap - w
            },
            a.y.clamp(margin, (reader.height - margin - h).max(margin)),
        )
    } else {
        let above = (a.y - gap - margin).max(1.0);
        let below = (reader.height - (a.y + a.height) - gap - margin).max(1.0);
        let use_below = below >= h || below >= above;
        h = h.min(if use_below { below } else { above });
        (
            a.x.clamp(margin, (reader.width - margin - w).max(margin)),
            if use_below {
                a.y + a.height + gap
            } else {
                a.y - gap - h
            },
        )
    };
    Bounds {
        x: reader.x + x.clamp(0.0, (reader.width - w).max(0.0)),
        y: reader.y + y.clamp(0.0, (reader.height - h).max(0.0)),
        width: w,
        height: h,
    }
}
#[tauri::command]
pub fn show_yatsu_lookup(app: AppHandle, revision: u64, width: f64) -> Result<bool, String> {
    if !width.is_finite() {
        return Err("Invalid popup width".into());
    }
    let state = app.state::<YatsuState>();
    let runtime = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(reader) = &runtime.reader else {
        return Ok(false);
    };
    if revision != runtime.request.revision || runtime.request.sentence.is_empty() {
        return Ok(false);
    }
    if let Some(view) = app.get_webview(LOOKUP) {
        view.set_bounds(popup_bounds(reader, &runtime.request, width).rect())
            .map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        if let Some(reader) = app.get_webview(READER) {
            let _ = reader.eval("window.__setsunaYatsuPopup?.(true)");
        }
        return Ok(true);
    }
    Ok(false)
}
#[tauri::command]
pub async fn set_yatsu_workspace(app: AppHandle, layout: Option<Layout>) -> Result<(), String> {
    if let Some(layout) = &layout {
        layout.reader.validate()?;
    }
    {
        let state = app.state::<YatsuState>();
        state.0.lock().unwrap_or_else(|e| e.into_inner()).reader =
            layout.as_ref().map(|l| l.reader.clone());
    }
    clear_lookup(&app, None);
    let Some(layout) = layout else {
        if let Some(view) = app.get_webview(READER) {
            view.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    };
    let main = app.get_window("main").ok_or("Main window was not found")?;
    let language = if layout.language == "en" { "en" } else { "ru" };
    if app.get_webview(READER).is_none() {
        let navigation_app = app.clone();
        let popup_app = app.clone();
        let script = format!(
            "window.__setsunaYatsuLanguage = {:?};\n{}",
            language,
            include_str!("yatsu-reader.js")
        );
        let builder = tauri::webview::WebviewBuilder::new(
            READER,
            WebviewUrl::External(ORIGIN.parse().unwrap()),
        )
        .disable_drag_drop_handler()
        .initialization_script(script)
        .on_navigation(move |url| {
            if let Some(mut request) = parse_request(url) {
                let state = navigation_app.state::<YatsuState>();
                let mut runtime = state.0.lock().unwrap_or_else(|e| e.into_inner());
                if runtime.reader.is_none() {
                    return false;
                }
                request.revision = runtime.request.revision.wrapping_add(1);
                runtime.request = request.clone();
                // Never leave the previous word's card visible during a new scan.
                if let Some(view) = navigation_app.get_webview(LOOKUP) {
                    let _ = view.hide();
                }
                let _ = navigation_app.emit_to(LOOKUP, "yatsu-scan", request);
                return false;
            }
            if url.scheme() == "setsuna-yatsu" {
                if url.host_str() == Some("close") {
                    clear_lookup(&navigation_app, None);
                }
                if url.host_str() == Some("home") {
                    clear_lookup(&navigation_app, None);
                    navigation_app
                        .state::<YatsuState>()
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .reader = None;
                    if let Some(view) = navigation_app.get_webview(READER) {
                        let _ = view.hide();
                    }
                    let _ = navigation_app.emit_to("main", "yatsu-home", ());
                }
                return false;
            }
            if reader_url(url) {
                clear_lookup(&navigation_app, None);
                return true;
            }
            if url.scheme() == "https" {
                let _ = navigation_app.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _| {
            if reader_url(&url) {
                if let Some(view) = popup_app.get_webview(READER) {
                    let _ = view.navigate(url);
                }
            } else if url.scheme() == "https" {
                let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        });
        main.add_child(
            builder,
            tauri::LogicalPosition::new(layout.reader.x, layout.reader.y),
            tauri::LogicalSize::new(layout.reader.width, layout.reader.height),
        )
        .map_err(|e| e.to_string())?;
    }
    // Create after the reader so this child is above the book in native z-order.
    if app.get_webview(LOOKUP).is_none() {
        let panel = main
            .add_child(
                tauri::webview::WebviewBuilder::new(
                    LOOKUP,
                    WebviewUrl::App("yatsu-lookup.html".into()),
                ),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(420.0, 520.0),
            )
            .map_err(|e| e.to_string())?;
        panel.hide().map_err(|e| e.to_string())?;
    }
    if let Some(view) = app.get_webview(READER) {
        view.set_bounds(layout.reader.rect())
            .map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn get_yatsu_request(state: State<'_, YatsuState>) -> Request {
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .request
        .clone()
}
#[tauri::command]
pub fn highlight_yatsu_match(
    app: AppHandle,
    state: State<'_, YatsuState>,
    revision: u64,
    start: usize,
    length: usize,
) {
    let runtime = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let request = &runtime.request;
    if runtime.reader.is_none()
        || revision != request.revision
        || start.saturating_add(length) > request.sentence.chars().count()
    {
        return;
    }
    if let Some(view) = app.get_webview(READER) {
        let _ = view.eval(&format!(
            "window.__setsunaYatsuHighlight?.({}, {}, {})",
            request.id, start, length
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_accepts_only_bounded_valid_character_offsets() {
        let url = |text: &str, cursor: usize| {
            let mut url = tauri::Url::parse("setsuna-yatsu://lookup").unwrap();
            url.query_pairs_mut().append_pair(
                "data",
                &serde_json::json!({"id":1,"sentence":text,"cursor":cursor,"anchor":{"x":10,"y":10,"width":20,"height":20}}).to_string(),
            );
            url
        };
        assert!(parse_request(&url("𠮷野家", 2)).is_some());
        assert!(parse_request(&url("𠮷野家", 3)).is_none());
        assert!(parse_request(&url(&"猫".repeat(4097), 0)).is_none());
        assert!(parse_request(&url("", 0)).is_none());
        assert!(
            parse_request(&tauri::Url::parse("https://app.yatsu.moe/?data={}").unwrap()).is_none()
        );
        assert!(reader_url(
            &tauri::Url::parse("https://app.yatsu.moe/b?id=1").unwrap()
        ));
        assert!(!reader_url(
            &tauri::Url::parse("https://app.yatsu.moe.evil.test/").unwrap()
        ));
        assert!(!reader_url(
            &tauri::Url::parse("http://app.yatsu.moe/").unwrap()
        ));
    }
}
