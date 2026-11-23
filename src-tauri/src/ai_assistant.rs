//! Optional local AI explanations (desktop only).
//!
//! Nothing here ships in the installer except this code. When the user turns
//! the feature on in Settings, Setsuna downloads two things into
//! `<app data>/ai/`:
//!
//! * the llama.cpp server (`llama-server`, Vulkan build, ~38 MB), pinned to a
//!   tested release and verified by SHA-256;
//! * a GGUF model (Gemma 4 E4B, ~5 GB), also verified by SHA-256.
//!
//! `llama-server` runs as a hidden child process on a free localhost port and
//! is started lazily on the first request. It is stopped after a few idle
//! minutes, when the model is deleted and when Setsuna exits (on Windows the
//! child also sits in a kill-on-close job object, so it never outlives us).
//!
//! Responses are streamed to the frontend as `ai://chunk` events.
//!
//! Android can't run downloaded executables, so the phone build will need
//! llama.cpp linked into the app instead; that is a separate step.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const RUNTIME_TAG: &str = "b12590";
const IDLE_SHUTDOWN: Duration = Duration::from_secs(10 * 60);
const CONTEXT_TOKENS: u32 = 8192;

#[derive(Clone, Copy)]
#[allow(dead_code)] // only one kind is used per platform
enum ArchiveKind {
    Zip,
    TarGz,
}

struct RuntimeAsset {
    url: &'static str,
    size: u64,
    sha256: &'static str,
    kind: ArchiveKind,
}

fn runtime_asset() -> Option<RuntimeAsset> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some(RuntimeAsset {
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b12590/llama-b12590-bin-win-vulkan-x64.zip",
        size: 38_853_424,
        sha256: "4f11b151fb05e7e0b068893094e8db2406f9a258b3018020d2167c21322803b4",
        kind: ArchiveKind::Zip,
    });
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some(RuntimeAsset {
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b12590/llama-b12590-bin-ubuntu-vulkan-x64.tar.gz",
        size: 36_867_078,
        sha256: "3b9b3c8a6412523b2a75f87b81b97c2f7c690b66dcad42e9c23f5859402a8c3a",
        kind: ArchiveKind::TarGz,
    });
    #[allow(unreachable_code)]
    None
}

struct AiModel {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
    temperature: f32,
    top_p: f32,
    top_k: u32,
}

const MODELS: &[AiModel] = &[AiModel {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    file: "gemma-4-E4B-it-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
    size: 4_977_171_584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
}];

fn model_by_id(id: &str) -> Result<&'static AiModel, String> {
    MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("Unknown model: {id}"))
}

struct AiServer {
    child: Child,
    port: u16,
    model_id: String,
}

pub struct AiState {
    server: Mutex<Option<AiServer>>,
    start_lock: tokio::sync::Mutex<()>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    download_cancel: Arc<AtomicBool>,
    downloading: AtomicBool,
    active_requests: AtomicU64,
    last_used_ms: AtomicU64,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            cancels: Mutex::new(HashMap::new()),
            download_cancel: Arc::new(AtomicBool::new(false)),
            downloading: AtomicBool::new(false),
            active_requests: AtomicU64::new(0),
            last_used_ms: AtomicU64::new(0),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ai_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("runtime").join(RUNTIME_TAG))
}

fn default_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("models"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("config.json"))
}

/// The folder chosen in Settings (any folder on the PC), or the app data default.
fn configured_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let custom = fs::read_to_string(config_path(app)?)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|config| config.get("modelsDir").and_then(Value::as_str).map(str::to_string))
        .filter(|dir| !dir.trim().is_empty());
    match custom {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => default_models_dir(app),
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = configured_models_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Can't use the model folder {}: {e}", dir.display()))?;
    Ok(dir)
}

fn server_exe_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|sub| find_file(&sub, name, depth - 1))
}

fn installed_server_exe(app: &AppHandle) -> Option<PathBuf> {
    let dir = runtime_dir(app).ok()?;
    if !dir.join(".ok").exists() {
        return None;
    }
    find_file(&dir, server_exe_name(), 3)
}

fn model_path(app: &AppHandle, model: &AiModel) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model.file))
}

fn model_installed(app: &AppHandle, model: &AiModel) -> bool {
    let Ok(path) = model_path(app, model) else {
        return false;
    };
    let ok_marker = path.with_extension("gguf.ok");
    ok_marker.exists()
        && fs::metadata(&path)
            .map(|m| m.len() == model.size)
            .unwrap_or(false)
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    path.with_file_name(name)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_status(app: AppHandle, state: State<'_, AiState>) -> Result<Value, String> {
    let running = state
        .server
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| s.model_id.clone()));
    let models: Vec<Value> = MODELS
        .iter()
        .map(|model| {
            let path = model_path(&app, model).ok();
            let partial = path
                .as_ref()
                .and_then(|p| fs::metadata(part_path(p)).ok())
                .map(|m| m.len())
                .unwrap_or(0);
            json!({
                "id": model.id,
                "name": model.name,
                "sizeBytes": model.size,
                "installed": model_installed(&app, model),
                "partialBytes": partial,
            })
        })
        .collect();
    let models_dir = configured_models_dir(&app).map(|d| d.display().to_string()).unwrap_or_default();
    let default_dir = default_models_dir(&app).map(|d| d.display().to_string()).unwrap_or_default();
    Ok(json!({
        "modelsDir": models_dir,
        "defaultModelsDir": default_dir,
        "supported": runtime_asset().is_some(),
        "runtimeInstalled": installed_server_exe(&app).is_some(),
        "models": models,
        "running": running,
        "downloading": state.downloading.load(Ordering::SeqCst),
    }))
}

/// Copies a file with progress, then removes the original (works across drives).
fn move_file(app: &AppHandle, from: &Path, to: &Path, total: u64) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let mut input = File::open(from).map_err(|e| e.to_string())?;
    let temporary = part_path(to);
    let mut output = File::create(&temporary).map_err(|e| format!("Can't write to {}: {e}", to.display()))?;
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    let mut done = 0u64;
    let mut last = Instant::now();
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut output, &buf[..n]).map_err(|e| format!("Disk write failed: {e}"))?;
        done += n as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            emit_download(app, "move", done, total, None);
        }
    }
    drop(output);
    fs::rename(&temporary, to).map_err(|e| e.to_string())?;
    fs::remove_file(from).map_err(|e| e.to_string())
}

/// Sets the folder for AI models (`None` = back to the app data default) and
/// moves already downloaded models there.
#[tauri::command]
pub async fn ai_set_models_dir(app: AppHandle, state: State<'_, AiState>, dir: Option<String>) -> Result<String, String> {
    if state.downloading.load(Ordering::SeqCst) {
        return Err("Wait for the download to finish first".into());
    }
    let old_dir = configured_models_dir(&app)?;
    let new_dir = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => default_models_dir(&app)?,
    };
    fs::create_dir_all(&new_dir).map_err(|e| format!("Can't use the folder {}: {e}", new_dir.display()))?;
    let same = fs::canonicalize(&old_dir).ok().zip(fs::canonicalize(&new_dir).ok()).is_some_and(|(a, b)| a == b);
    if !same {
        stop_server(&state);
        let app2 = app.clone();
        let (old2, new2) = (old_dir.clone(), new_dir.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            for model in MODELS {
                let from = old2.join(model.file);
                let to = new2.join(model.file);
                if from.exists() && !to.exists() {
                    move_file(&app2, &from, &to, model.size)?;
                }
                for suffix in ["gguf.ok"] {
                    let marker_from = from.with_extension(suffix);
                    if marker_from.exists() {
                        let _ = fs::rename(&marker_from, to.with_extension(suffix))
                            .or_else(|_| fs::copy(&marker_from, to.with_extension(suffix)).map(|_| ()).and_then(|_| fs::remove_file(&marker_from)));
                    }
                }
                let _ = fs::remove_file(part_path(&from));
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        emit_download(&app, "moved", 0, 0, None);
    }
    let is_default = default_models_dir(&app).ok().is_some_and(|d| d == new_dir);
    let config = json!({ "modelsDir": if is_default { String::new() } else { new_dir.display().to_string() } });
    fs::write(config_path(&app)?, config.to_string()).map_err(|e| e.to_string())?;
    Ok(new_dir.display().to_string())
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

fn emit_download(app: &AppHandle, stage: &str, received: u64, total: u64, error: Option<&str>) {
    let _ = app.emit(
        "ai://download",
        json!({ "stage": stage, "received": received, "total": total, "error": error }),
    );
}

async fn download_resumable(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    size: u64,
    stage: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = crate::http_client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let part = part_path(dest);
    let mut last_error = String::new();
    for _attempt in 0..6 {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if have > size {
            let _ = fs::remove_file(&part);
            have = 0;
        }
        if have == size {
            break;
        }
        emit_download(app, stage, have, size, None);
        let mut request = client.get(url);
        if have > 0 {
            request = request.header("Range", format!("bytes={have}-"));
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = error.without_url().to_string();
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            last_error = format!("HTTP {status}");
            if status.is_server_error() || status.as_u16() == 429 {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
            return Err(last_error);
        }
        // A server that ignores Range sends the whole file again.
        let resumed = have > 0 && status.as_u16() == 206;
        let mut file = if resumed {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&part)
                .await
                .map_err(|e| e.to_string())?
        } else {
            have = 0;
            tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?
        };
        let mut received = have;
        let mut last_emit = Instant::now();
        let result: Result<(), String> = loop {
            if cancel.load(Ordering::SeqCst) {
                break Err("cancelled".into());
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(error) = file.write_all(&chunk).await {
                        break Err(format!("Disk write failed: {error}"));
                    }
                    received += chunk.len() as u64;
                    if last_emit.elapsed() >= Duration::from_millis(250) {
                        last_emit = Instant::now();
                        emit_download(app, stage, received, size, None);
                    }
                }
                Ok(None) => break Ok(()),
                Err(error) => break Err(error.without_url().to_string()),
            }
        };
        let _ = file.flush().await;
        drop(file);
        match result {
            Ok(()) => {}
            Err(error) if error == "cancelled" || error.starts_with("Disk write") => {
                return Err(error)
            }
            Err(error) => {
                last_error = error;
                continue;
            }
        }
        if fs::metadata(&part).map(|m| m.len()).unwrap_or(0) >= size {
            break;
        }
    }
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have != size {
        return Err(if last_error.is_empty() {
            format!("Download incomplete ({have} of {size} bytes)")
        } else {
            last_error
        });
    }
    emit_download(app, stage, size, size, None);
    Ok(())
}

fn sha256_file(path: &Path, app: &AppHandle, total: u64, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut done = 0u64;
    let mut last_emit = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            emit_download(app, "verify", done, total, None);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn verify_part(app: &AppHandle, dest: &Path, size: u64, sha256: &str, cancel: Arc<AtomicBool>) -> Result<(), String> {
    let part = part_path(dest);
    let app2 = app.clone();
    let part2 = part.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || sha256_file(&part2, &app2, size, &cancel))
        .await
        .map_err(|e| e.to_string())??;
    if digest != sha256 {
        let _ = fs::remove_file(&part);
        return Err("Checksum mismatch: the file was corrupted, please download again".into());
    }
    Ok(())
}

async fn install_runtime(app: &AppHandle, cancel: Arc<AtomicBool>) -> Result<(), String> {
    if installed_server_exe(app).is_some() {
        return Ok(());
    }
    let asset = runtime_asset().ok_or("Local AI is not supported on this platform yet")?;
    let dir = runtime_dir(app)?;
    let archive = ai_dir(app)?.join(format!(
        "llama-{RUNTIME_TAG}.{}",
        match asset.kind {
            ArchiveKind::Zip => "zip",
            ArchiveKind::TarGz => "tar.gz",
        }
    ));
    download_resumable(app, asset.url, &archive, asset.size, "runtime", &cancel).await?;
    verify_part(app, &archive, asset.size, asset.sha256, cancel.clone()).await?;
    let part = part_path(&archive);
    let kind = asset.kind;
    let dir2 = dir.clone();
    emit_download(app, "extract", 0, 0, None);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = fs::remove_dir_all(&dir2);
        fs::create_dir_all(&dir2).map_err(|e| e.to_string())?;
        let file = File::open(&part).map_err(|e| e.to_string())?;
        match kind {
            ArchiveKind::Zip => {
                let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
                zip.extract(&dir2).map_err(|e| e.to_string())?;
            }
            ArchiveKind::TarGz => {
                let gz = flate2::read::GzDecoder::new(file);
                tar::Archive::new(gz).unpack(&dir2).map_err(|e| e.to_string())?;
            }
        }
        fs::write(dir2.join(".ok"), RUNTIME_TAG).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&part);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    if installed_server_exe(app).is_none() {
        return Err("llama-server was not found in the downloaded archive".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_download_model(app: AppHandle, state: State<'_, AiState>, model_id: String) -> Result<(), String> {
    let model = model_by_id(&model_id)?;
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("A download is already running".into());
    }
    state.download_cancel.store(false, Ordering::SeqCst);
    let cancel = state.download_cancel.clone();
    let result: Result<(), String> = async {
        install_runtime(&app, cancel.clone()).await?;
        if !model_installed(&app, model) {
            let path = model_path(&app, model)?;
            download_resumable(&app, model.url, &path, model.size, "model", &cancel).await?;
            verify_part(&app, &path, model.size, model.sha256, cancel.clone()).await?;
            fs::rename(part_path(&path), &path).map_err(|e| e.to_string())?;
            fs::write(path.with_extension("gguf.ok"), model.sha256).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    .await;
    state.downloading.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => emit_download(&app, "done", model.size, model.size, None),
        Err(error) if error == "cancelled" => emit_download(&app, "cancelled", 0, 0, None),
        Err(error) => emit_download(&app, "error", 0, 0, Some(error)),
    }
    result
}

#[tauri::command]
pub fn ai_cancel_download(state: State<'_, AiState>) {
    state.download_cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn ai_delete_model(app: AppHandle, state: State<'_, AiState>, model_id: String) -> Result<(), String> {
    let model = model_by_id(&model_id)?;
    stop_server(&state);
    let path = model_path(&app, model)?;
    for file in [path.clone(), part_path(&path), path.with_extension("gguf.ok")] {
        if file.exists() {
            fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// llama-server process
// ---------------------------------------------------------------------------

fn stop_server(state: &AiState) {
    if let Ok(mut guard) = state.server.lock() {
        if let Some(mut server) = guard.take() {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

/// Stops the model server. Called when Setsuna exits.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AiState>() {
        stop_server(&state);
    }
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

#[cfg(target_os = "windows")]
fn attach_kill_on_close(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use winapi::um::jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject};
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // The handle is intentionally never closed: it closes when Setsuna
        // exits, and the job then kills the model server with it.
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

fn log_tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().rev().take(6).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

async fn ensure_server(app: &AppHandle, state: &AiState, model: &AiModel) -> Result<u16, String> {
    let _guard = state.start_lock.lock().await;
    {
        let mut guard = state.server.lock().map_err(|e| e.to_string())?;
        if let Some(server) = guard.as_mut() {
            let alive = matches!(server.child.try_wait(), Ok(None));
            if alive && server.model_id == model.id {
                return Ok(server.port);
            }
        }
    }
    stop_server(state);

    let exe = installed_server_exe(app).ok_or("The AI runtime is not installed. Download it in Settings")?;
    if !model_installed(app, model) {
        return Err(format!("{} is not downloaded. Download it in Settings", model.name));
    }
    let model_file = model_path(app, model)?;
    let port = free_port()?;
    let log_path = ai_dir(app)?.join("server.log");
    let log = File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();

    let mut command = Command::new(&exe);
    command
        .arg("-m")
        .arg(&model_file)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["-c", &CONTEXT_TOKENS.to_string(), "-np", "1", "-ngl", "99"])
        .args(["--jinja", "--no-ui"])
        .current_dir(&exe_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(target_os = "linux")]
    {
        let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let joined = if existing.is_empty() {
            exe_dir.display().to_string()
        } else {
            format!("{}:{existing}", exe_dir.display())
        };
        command.env("LD_LIBRARY_PATH", joined);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("Failed to start llama-server: {e}"))?;
    #[cfg(target_os = "windows")]
    attach_kill_on_close(&child);
    {
        let mut guard = state.server.lock().map_err(|e| e.to_string())?;
        *guard = Some(AiServer {
            child,
            port,
            model_id: model.id.to_string(),
        });
    }

    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let health = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        {
            let mut guard = state.server.lock().map_err(|e| e.to_string())?;
            let exited = match guard.as_mut() {
                Some(server) => !matches!(server.child.try_wait(), Ok(None)),
                None => true,
            };
            if exited {
                guard.take();
                return Err(format!("llama-server stopped while loading the model:\n{}", log_tail(&log_path)));
            }
        }
        if let Ok(response) = client.get(&health).send().await {
            if response.status().is_success() {
                return Ok(port);
            }
        }
        if started.elapsed() > Duration::from_secs(240) {
            stop_server(state);
            return Err("The model took too long to load".into());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Stops an idle model server so it doesn't hold ~5 GB of memory.
pub fn start_idle_reaper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let Some(state) = app.try_state::<AiState>() else {
            continue;
        };
        let running = state
            .server
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false);
        if !running || state.active_requests.load(Ordering::SeqCst) > 0 {
            continue;
        }
        let idle = now_ms().saturating_sub(state.last_used_ms.load(Ordering::SeqCst));
        if idle >= IDLE_SHUTDOWN.as_millis() as u64 {
            stop_server(&state);
        }
    });
}

#[tauri::command]
pub fn ai_stop(state: State<'_, AiState>) {
    stop_server(&state);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

struct ActiveGuard<'a>(&'a AiState, String);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.active_requests.fetch_sub(1, Ordering::SeqCst);
        self.0.last_used_ms.store(now_ms(), Ordering::SeqCst);
        if let Ok(mut cancels) = self.0.cancels.lock() {
            cancels.remove(&self.1);
        }
    }
}

fn emit_chunk(app: &AppHandle, request_id: &str, content: &str, reasoning: &str) {
    let _ = app.emit(
        "ai://chunk",
        json!({ "requestId": request_id, "content": content, "reasoning": reasoning }),
    );
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    request_id: String,
    model_id: String,
    messages: Value,
    think: bool,
    max_tokens: Option<u32>,
) -> Result<Value, String> {
    let model = model_by_id(&model_id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.clone(), cancel.clone());
    state.active_requests.fetch_add(1, Ordering::SeqCst);
    let _active = ActiveGuard(&state, request_id.clone());

    let _ = app.emit("ai://status", json!({ "requestId": request_id, "phase": "loading" }));
    let port = ensure_server(&app, &state, model).await?;
    if cancel.load(Ordering::SeqCst) {
        return Ok(json!({ "content": "", "cancelled": true }));
    }
    let _ = app.emit("ai://status", json!({ "requestId": request_id, "phase": "generating" }));

    let body = json!({
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens.unwrap_or(if think { 6000 } else { 1500 }),
        "temperature": model.temperature,
        "top_p": model.top_p,
        "top_k": model.top_k,
        "chat_template_kwargs": { "enable_thinking": think },
    });
    let client = crate::http_client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("The model server didn't answer: {}", e.without_url()))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Model error {status}: {}", text.chars().take(300).collect::<String>()));
    }

    let mut buffer: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut reasoning_chars = 0usize;
    let mut finish = Value::Null;
    let mut timings = Value::Null;
    let mut cancelled = false;
    'stream: loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => return Err(format!("Stream interrupted: {}", error.without_url())),
        };
        buffer.extend_from_slice(&chunk);
        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                break 'stream;
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(t) = event.get("timings") {
                timings = t.clone();
            }
            let Some(choice) = event.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            if let Some(reason) = choice.get("finish_reason").filter(|v| !v.is_null()) {
                finish = reason.clone();
            }
            let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
            let text = delta.get("content").and_then(Value::as_str).unwrap_or("");
            let thought = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !text.is_empty() || !thought.is_empty() {
                content.push_str(text);
                reasoning_chars += thought.chars().count();
                emit_chunk(&app, &request_id, text, thought);
            }
        }
    }
    Ok(json!({
        "content": content,
        "reasoningChars": reasoning_chars,
        "finish": finish,
        "tokens": timings.get("predicted_n"),
        "tokensPerSecond": timings.get("predicted_per_second"),
        "cancelled": cancelled,
    }))
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, request_id: String) {
    if let Ok(cancels) = state.cancels.lock() {
        if let Some(flag) = cancels.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_history_load(app: AppHandle) -> Result<Value, String> {
    let path = ai_dir(&app)?.join("history.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(json!({ "version": 1, "threads": [] })),
    }
}

#[tauri::command]
pub fn ai_history_save(app: AppHandle, data: Value) -> Result<(), String> {
    let dir = ai_dir(&app)?;
    let tmp = dir.join("history.json.tmp");
    let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("history.json")).map_err(|e| e.to_string())
}
