//! WebView renderer failures bypass React error boundaries entirely.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};

pub fn install(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let last_reload = Arc::new(Mutex::new(None::<Instant>));
    let diagnostics = app.clone();
    let result = window.with_webview(move |platform| {
        let register = || -> Result<(), String> {
            let webview = unsafe { platform.controller().CoreWebView2() }.map_err(|error| error.to_string())?;
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()); };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)?; }
                let mut reload = false;
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    if let Ok(mut previous) = last_reload.lock() {
                        // Avoid an automatic reload loop if a workspace itself fails to load.
                        if previous.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                            *previous = Some(Instant::now());
                            reload = true;
                        }
                    }
                }
                super::append_diagnostics_line(&app, serde_json::json!({
                    "ts": super::unix_time_ms(), "kind": "webview_process_failed",
                    "window": label, "process_kind": kind.0, "reload": reload,
                }));
                if reload {
                    let app = app.clone();
                    let label = label.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        if let Some(window) = app.get_webview_window(&label) {
                            let _ = window.reload();
                        }
                    });
                }
                Ok(())
            }));
            let mut token = 0;
            // WebView owns the registered callback until its controller is destroyed.
            unsafe { webview.add_ProcessFailed(&handler, &mut token) }.map_err(|error| error.to_string())
        };
        if let Err(error) = register() {
            super::append_diagnostics_line(&diagnostics, serde_json::json!({
                "ts": super::unix_time_ms(), "kind": "webview_recovery_registration_failed", "error": error,
            }));
        }
    });
    if let Err(error) = result { eprintln!("Unable to monitor WebView renderer: {error}"); }
}
