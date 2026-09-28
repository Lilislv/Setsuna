// Flow calls the same Rust scanner as the in-app popup, including while the
// Activity/WebView is in the background. No second SQL lookup implementation.
use jni::{JNIEnv, objects::{JClass, JString}, sys::{jint, jstring}};
use rusqlite::{Connection, OpenFlags};

#[no_mangle]
pub extern "system" fn Java_com_serichka_setsuna_NativeDictionary_flowTimer(
    env: JNIEnv, _class: JClass, action: jint,
) -> jstring {
    let snapshot = super::flow_timer::snapshot(if action == 2 { Some(true) } else { None }, action == 1);
    env.new_string(serde_json::to_string(&snapshot).unwrap_or_default())
        .map(|value| value.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_serichka_setsuna_NativeDictionary_scan(
    mut env: JNIEnv, _class: JClass, path: JString, sentence: JString, cursor: jint,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<serde_json::Value, String> {
        let sentence: String = env.get_string(&sentence).map_err(|e| e.to_string())?.into();
        if cursor < 0 {
            return serde_json::to_value(super::segment_japanese_text(&sentence)?)
                .map_err(|e| e.to_string());
        }
        let path: String = env.get_string(&path).map_err(|e| e.to_string())?.into();
        let _lease = super::database_access::reading()?;
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        serde_json::to_value(super::scan_cursor_in_db(&conn, &sentence, cursor as usize)?)
            .map_err(|e| e.to_string())
    }));
    let output = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => serde_json::json!({"error": error}),
        Err(_) => serde_json::json!({"error": "Dictionary lookup failed"}),
    };
    env.new_string(output.to_string()).map(|value| value.into_raw()).unwrap_or(std::ptr::null_mut())
}
