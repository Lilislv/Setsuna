//! Hover lookup for X11 sessions.
//!
//! This is the Linux counterpart to the Windows UI Automation path: read the
//! pointer position, then ask the element underneath it for the text it is
//! showing. The pointer comes from X11 and the text from the accessibility
//! bus.
//!
//! It is deliberately restricted to X11. On Wayland both halves break: the
//! compositor never reports the pointer position to applications (XQueryPointer
//! through XWayland returns a stale position from whenever the pointer was last
//! over an X11 surface), and windows do not know their own screen position, so
//! every accessible reports its extents at the screen origin and hit-testing by
//! point is meaningless.

use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::proxy_ext::ProxyExt;
use atspi::{CoordType, Granularity};
use zbus::proxy::CacheProperties;

/// Guards against a malformed accessible tree turning the descent into an
/// infinite loop.
const MAX_DESCENT: usize = 64;

/// Failures are reported as i18n keys rather than English prose, so the window
/// can render them in the language the user picked. An optional system detail
/// follows the separator and is substituted into the translated template.
pub const ERROR_DETAIL_SEPARATOR: char = '|';
const ERR_X11: &str = "lookup.error.x11";
const ERR_ACCESSIBILITY: &str = "lookup.error.accessibility";

fn localized(key: &str, detail: impl std::fmt::Display) -> String {
    format!("{key}{ERROR_DETAIL_SEPARATOR}{detail}")
}

/// Text found under the pointer. Mirrors what the Windows path produces, so
/// the frontend can treat both identically: `context` is the surrounding line
/// and `cursor` is the character offset of the pointer within it, which is
/// what `scan_cursor` needs to segment Japanese.
pub struct HoveredText {
    pub text: Option<String>,
    pub context: Option<String>,
    pub cursor: Option<usize>,
}

pub fn is_wayland_session() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Reads the pointer position in root-window coordinates.
pub fn pointer_position() -> Result<(i32, i32), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;

    let (connection, screen_index) =
        x11rb::connect(None).map_err(|error| localized(ERR_X11, error))?;
    let root = connection
        .setup()
        .roots
        .get(screen_index)
        .ok_or_else(|| localized(ERR_X11, "no screen"))?
        .root;

    let pointer = connection
        .query_pointer(root)
        .map_err(|error| localized(ERR_X11, error))?
        .reply()
        .map_err(|error| localized(ERR_X11, error))?;

    Ok((pointer.root_x as i32, pointer.root_y as i32))
}

/// Toolkits only build accessibility trees when something is listening, so
/// without this the desktop exposes nothing but a handful of desktop services.
/// This is the same switch a screen reader flips, and it is deliberately left
/// on afterwards — turning it off again would tear down the trees of every
/// other assistive tool currently running.
async fn ensure_accessibility_enabled() -> Result<(), String> {
    let connection = zbus::Connection::session()
        .await
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;
    let proxy = zbus::Proxy::new(
        &connection,
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.a11y.Status",
    )
    .await
    .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;

    if proxy.get_property::<bool>("IsEnabled").await.ok() != Some(true) {
        proxy
            .set_property("IsEnabled", true)
            .await
            .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;
    }
    // Qt in particular keys off the screen-reader flag rather than IsEnabled.
    if proxy
        .get_property::<bool>("ScreenReaderEnabled")
        .await
        .ok()
        != Some(true)
    {
        proxy
            .set_property("ScreenReaderEnabled", true)
            .await
            .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;
    }

    Ok(())
}

fn build_proxy(
    connection: &zbus::Connection,
    object: &atspi::ObjectRefOwned,
) -> Option<impl std::future::Future<Output = zbus::Result<AccessibleProxy<'static>>>> {
    let name = object.name()?.to_owned();
    let path = object.path().to_owned();
    Some(
        AccessibleProxy::builder(connection)
            .cache_properties(CacheProperties::No)
            .destination(name)
            .ok()?
            .path(path)
            .ok()?
            .build(),
    )
}

/// Walks down the accessible tree at a screen point, returning the innermost
/// element that still contains it.
async fn deepest_at_point(
    connection: &zbus::Connection,
    root: AccessibleProxy<'static>,
    x: i32,
    y: i32,
) -> AccessibleProxy<'static> {
    let mut current = root;
    for _ in 0..MAX_DESCENT {
        let Ok(interfaces) = current.proxies().await else {
            break;
        };
        let Ok(component) = interfaces.component().await else {
            break;
        };
        let child = match component.get_accessible_at_point(x, y, CoordType::Screen).await {
            Ok(child) if !child.is_null() => child,
            _ => break,
        };
        let Some(pending) = build_proxy(connection, &child) else {
            break;
        };
        let Ok(next) = pending.await else {
            break;
        };
        current = next;
    }
    current
}

/// Extracts the line under the pointer plus the offset of the pointer within
/// it. Falls back to the element's accessible name for things that render text
/// without implementing the Text interface (labels, buttons, menu items).
async fn read_text(element: &AccessibleProxy<'static>, x: i32, y: i32) -> HoveredText {
    let name = element.name().await.ok().filter(|value| !value.is_empty());

    let text_proxy = match element.proxies().await {
        Ok(interfaces) => interfaces.text().await.ok(),
        Err(_) => None,
    };

    let Some(text) = text_proxy else {
        // No Text interface: the accessible name is the only thing on offer.
        return HoveredText {
            text: name.clone(),
            context: name,
            cursor: Some(0),
        };
    };

    let offset = text
        .get_offset_at_point(x, y, CoordType::Screen)
        .await
        .unwrap_or(-1);
    if offset < 0 {
        return HoveredText {
            text: name.clone(),
            context: name,
            cursor: Some(0),
        };
    }

    // The line gives scan_cursor enough surrounding text to segment Japanese
    // without dragging in an entire document.
    let (line, line_start) = match text.get_string_at_offset(offset, Granularity::Line).await {
        Ok((line, start, _)) if !line.trim().is_empty() => (line, start),
        _ => {
            let count = text.character_count().await.unwrap_or(0);
            match text.get_text(0, count).await {
                Ok(all) => (all, 0),
                Err(_) => {
                    return HoveredText {
                        text: name.clone(),
                        context: name,
                        cursor: Some(0),
                    }
                }
            }
        }
    };

    let word = text
        .get_string_at_offset(offset, Granularity::Word)
        .await
        .ok()
        .map(|(word, _, _)| word.trim().to_string())
        .filter(|word| !word.is_empty() && word.chars().count() < line.chars().count());

    // Offsets from AT-SPI are in characters, and so is the cursor the frontend
    // expects, so no byte conversion is involved.
    let line_length = line.chars().count();
    let cursor = offset.saturating_sub(line_start).max(0) as usize;

    HoveredText {
        text: word,
        context: Some(line),
        cursor: Some(cursor.min(line_length)),
    }
}

/// Finds the text shown at a screen point by asking every running application
/// whether it owns that point.
pub async fn text_at_point(x: i32, y: i32) -> Result<HoveredText, String> {
    ensure_accessibility_enabled().await?;

    let accessibility = atspi::AccessibilityConnection::new()
        .await
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;
    let connection = accessibility.connection().clone();

    let registry = AccessibleProxy::builder(&connection)
        .destination("org.a11y.atspi.Registry")
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?
        .path("/org/a11y/atspi/accessible/root")
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;

    let applications = registry
        .get_children()
        .await
        .map_err(|error| localized(ERR_ACCESSIBILITY, error))?;

    for application in applications {
        let Some(pending) = build_proxy(&connection, &application) else {
            continue;
        };
        let Ok(app_proxy) = pending.await else {
            continue;
        };

        // Ask the application root first; a miss here skips its whole subtree.
        let Ok(interfaces) = app_proxy.proxies().await else {
            continue;
        };
        let hit = match interfaces.component().await {
            Ok(component) => component
                .get_accessible_at_point(x, y, CoordType::Screen)
                .await
                .ok()
                .filter(|child| !child.is_null()),
            Err(_) => None,
        };
        let Some(hit) = hit else { continue };

        let Some(pending) = build_proxy(&connection, &hit) else {
            continue;
        };
        let Ok(start) = pending.await else { continue };

        let element = deepest_at_point(&connection, start, x, y).await;
        let found = read_text(&element, x, y).await;
        if found.text.is_some() || found.context.is_some() {
            return Ok(found);
        }
    }

    Ok(HoveredText {
        text: None,
        context: None,
        cursor: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window splits on the separator and looks the prefix up in the
    /// translation table, so the shape of these strings is a contract.
    #[test]
    fn errors_are_translation_keys_with_detail() {
        assert_eq!(
            localized(ERR_X11, "Connection refused"),
            "lookup.error.x11|Connection refused"
        );
        assert_eq!(
            localized(ERR_ACCESSIBILITY, "no bus"),
            "lookup.error.accessibility|no bus"
        );
    }

    #[test]
    fn error_keys_carry_no_prose() {
        // A key that accidentally contained a space or punctuation would fall
        // through the lookup and be shown to the user verbatim, in English.
        for key in [ERR_X11, ERR_ACCESSIBILITY] {
            assert!(key.starts_with("lookup.error."), "{key} is not namespaced");
            assert!(
                key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'),
                "{key} must be a bare key"
            );
        }
    }

    /// Manual probe against the running desktop; needs a real session, so it
    /// is not part of the normal suite. Run with:
    ///   PROBE_X=800 PROBE_Y=960 \
    ///     cargo test --bin Setsuna hover_probe -- --ignored --nocapture
    #[test]
    #[ignore = "requires a live desktop session"]
    fn hover_probe() {
        let read = |key: &str, fallback: i32| {
            std::env::var(key)
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(fallback)
        };
        let (x, y) = (read("PROBE_X", 800), read("PROBE_Y", 960));

        match tauri::async_runtime::block_on(text_at_point(x, y)) {
            Ok(found) => {
                println!("point   = ({x}, {y})");
                println!("text    = {:?}", found.text);
                println!("cursor  = {:?}", found.cursor);
                println!("context = {:?}", found.context);
            }
            Err(error) => println!("probe failed: {error}"),
        }
    }

    /// Exercises proxy construction and Text extraction without relying on
    /// hit-testing, which Wayland cannot support. Run with:
    ///   cargo test --bin Setsuna text_probe -- --ignored --nocapture
    #[test]
    #[ignore = "requires a live desktop session"]
    fn text_probe() {
        let found = tauri::async_runtime::block_on(async {
            ensure_accessibility_enabled().await?;
            let accessibility = atspi::AccessibilityConnection::new()
                .await
                .map_err(|error| error.to_string())?;
            let connection = accessibility.connection().clone();
            let registry = AccessibleProxy::builder(&connection)
                .destination("org.a11y.atspi.Registry")
                .map_err(|e| e.to_string())?
                .path("/org/a11y/atspi/accessible/root")
                .map_err(|e| e.to_string())?
                .cache_properties(CacheProperties::No)
                .build()
                .await
                .map_err(|e| e.to_string())?;

            let apps = registry.get_children().await.map_err(|e| e.to_string())?;
            let mut reports = Vec::new();

            for app in apps {
                let Some(pending) = build_proxy(&connection, &app) else {
                    continue;
                };
                let Ok(app_proxy) = pending.await else { continue };
                let app_name = app_proxy.name().await.unwrap_or_default();

                // Breadth-limited walk looking for anything with text.
                let mut queue = vec![app_proxy];
                let mut seen = 0;
                while let Some(node) = queue.pop() {
                    seen += 1;
                    if seen > 40 {
                        break;
                    }
                    if let Ok(interfaces) = node.proxies().await {
                        if let Ok(text) = interfaces.text().await {
                            let count = text.character_count().await.unwrap_or(0);
                            if count > 0 {
                                let sample =
                                    text.get_text(0, count.min(60)).await.unwrap_or_default();
                                if !sample.trim().is_empty() {
                                    reports.push(format!("{app_name}: {:?}", sample));
                                    break;
                                }
                            }
                        }
                    }
                    if let Ok(children) = node.get_children().await {
                        for child in children.into_iter().take(8) {
                            if let Some(pending) = build_proxy(&connection, &child) {
                                if let Ok(proxy) = pending.await {
                                    queue.push(proxy);
                                }
                            }
                        }
                    }
                }
            }
            Ok::<_, String>(reports)
        });

        match found {
            Ok(reports) if reports.is_empty() => println!("no accessible text found"),
            Ok(reports) => {
                println!("accessibles exposing text: {}", reports.len());
                for report in reports.iter().take(8) {
                    println!("  {report}");
                }
            }
            Err(error) => println!("probe failed: {error}"),
        }
    }
}
