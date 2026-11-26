//! Manga OCR LAN server & GPU worker (Desktop) + HTTP client (Desktop & Android):
//! - Runs a persistent Python `manga-ocr` worker on PC (CUDA RTX GPU when available, CPU fallback)
//! - Exposes a lightweight LAN HTTP server (`GET /health`, `POST /ocr`) so Setsuna Android on the
//!   same Wi-Fi can send bubble crops directly to the PC GPU
//! - Provides cross-platform `manga_ocr_remote_health` and `manga_ocr_remote_recognize` Tauri commands.

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMokuroJobState {
    pub job_id: u64,
    pub state: String,
    pub title: String,
    pub book_key: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    #[serde(default)]
    pub updated_at: u64,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaOcrServerStatus {
    pub running: bool,
    pub available: bool,
    pub url: Option<String>,
    pub port: u16,
    pub device: Option<String>,
    pub token: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaOcrResult {
    pub text: String,
    pub engine: String,
    pub device: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MangaOcrHealth {
    pub ok: bool,
    pub service: String,
    pub device: Option<String>,
    pub version: Option<String>,
}

fn normalize_remote_base(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Remote OCR server URL is empty.".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("http://{trimmed}"))
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream, UdpSocket};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread::JoinHandle;
    use tauri::Emitter;

    pub const DEFAULT_OCR_PORT: u16 = 47123;
    const MAX_HTTP_BODY_BYTES: usize = 12 * 1024 * 1024;

    const WORKER_SCRIPT: &str = r#"
import sys, json, io, base64, time
try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass
import torch
from PIL import Image
from manga_ocr import MangaOcr

device = 'cuda' if torch.cuda.is_available() else 'cpu'
mocr = MangaOcr()
print('READY ' + device, flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    t0 = time.perf_counter()
    try:
        req = json.loads(line)
        b64 = req.get('imageBase64') or req.get('image_base64') or ''
        if ',' in b64 and b64.lstrip().startswith('data:'):
            b64 = b64.split(',', 1)[1]
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw))
        text = mocr(img)
        ms = int((time.perf_counter() - t0) * 1000)
        print(json.dumps({'ok': True, 'text': text, 'device': device, 'elapsedMs': ms}, ensure_ascii=False), flush=True)
    except Exception as exc:
        ms = int((time.perf_counter() - t0) * 1000)
        print(json.dumps({'ok': False, 'error': str(exc), 'elapsedMs': ms}, ensure_ascii=False), flush=True)
"#;

    struct PythonOcrWorker {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
        device: Option<String>,
        stderr_tail: Arc<Mutex<String>>,
    }

    struct ServerHandle {
        stop: Arc<AtomicBool>,
        port: u16,
        token: String,
        url: String,
        join: Option<JoinHandle<()>>,
    }

    static WORKER_LOCK: OnceLock<Mutex<Option<PythonOcrWorker>>> = OnceLock::new();
    static LAST_DEVICE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    static SERVER_LOCK: OnceLock<Mutex<Option<ServerHandle>>> = OnceLock::new();
    static REMOTE_MOKURO_LOCK: OnceLock<Mutex<RemoteMokuroJobState>> = OnceLock::new();
    static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

    fn remote_mokuro_mutex() -> &'static Mutex<RemoteMokuroJobState> {
        REMOTE_MOKURO_LOCK.get_or_init(|| Mutex::new(RemoteMokuroJobState {
            state: "idle".to_string(),
            updated_at: now_unix_ms(),
            ..Default::default()
        }))
    }

    fn active_job(job: &RemoteMokuroJobState) -> bool {
        matches!(job.state.as_str(), "queued" | "running" | "converting")
    }

    fn expire_disconnected_job(job: &mut RemoteMokuroJobState) {
        if active_job(job) && now_unix_ms().saturating_sub(job.updated_at) > 120_000 {
            job.state = "error".into();
            job.error = Some("Lost contact with the Setsuna window on the PC.".into());
        }
    }

    pub fn set_remote_mokuro_state(next: RemoteMokuroJobState) -> Result<(), String> {
        let mut job = remote_mokuro_mutex().lock().map_err(|e| e.to_string())?;
        if job.job_id != next.job_id || !active_job(&job) {
            return Err("Mokuro request expired.".into());
        }
        job.state = next.state;
        job.message = next.message;
        job.current = next.current;
        job.total = next.total;
        job.error = next.error;
        job.updated_at = now_unix_ms();
        Ok(())
    }

    pub fn get_remote_mokuro_state() -> RemoteMokuroJobState {
        remote_mokuro_mutex()
            .lock()
            .map(|mut job| {
                expire_disconnected_job(&mut job);
                job.clone()
            })
            .unwrap_or_else(|_| RemoteMokuroJobState {
                state: "idle".to_string(),
                ..Default::default()
            })
    }

    fn worker_mutex() -> &'static Mutex<Option<PythonOcrWorker>> {
        WORKER_LOCK.get_or_init(|| Mutex::new(None))
    }

    fn device_mutex() -> &'static Mutex<Option<String>> {
        LAST_DEVICE.get_or_init(|| Mutex::new(None))
    }

    fn server_mutex() -> &'static Mutex<Option<ServerHandle>> {
        SERVER_LOCK.get_or_init(|| Mutex::new(None))
    }

    fn new_quiet_command(program: &str) -> Command {
        let mut cmd = Command::new(program);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    pub fn detect_manga_ocr_python() -> Option<(String, Vec<String>)> {
        const PROBE: &str = "import importlib.metadata as m; print(m.version('manga-ocr'))";
        for (prog, prefix) in crate::mokuro_setup::python_candidates() {
            let mut cmd = new_quiet_command(&prog);
            cmd.args(&prefix).arg("-c").arg(PROBE);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    return Some((prog, prefix));
                }
            }
        }
        None
    }

    impl PythonOcrWorker {
        fn start() -> Result<Self, String> {
            let (prog, prefix) = detect_manga_ocr_python().ok_or_else(|| {
                "manga-ocr Python package not found on PC (install with `pip install manga-ocr` or `mokuro`).".to_string()
            })?;

            let mut cmd = new_quiet_command(&prog);
            cmd.args(&prefix)
                .arg("-u")
                .arg("-c")
                .arg(WORKER_SCRIPT)
                .env("PYTHONUNBUFFERED", "1")
                .env("PYTHONIOENCODING", "utf-8")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to start manga-ocr worker: {e}"))?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| "Failed to attach stdin to manga-ocr worker.".to_string())?;
            let stdout_raw = child
                .stdout
                .take()
                .ok_or_else(|| "Failed to attach stdout to manga-ocr worker.".to_string())?;
            let stderr_raw = child.stderr.take();

            let stderr_tail = Arc::new(Mutex::new(String::new()));
            if let Some(err_stream) = stderr_raw {
                let tail_clone = Arc::clone(&stderr_tail);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(err_stream);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                if let Ok(mut buf) = tail_clone.lock() {
                                    buf.push_str(&line);
                                    if buf.len() > 4096 {
                                        let cut = buf.len() - 4096;
                                        let drain_end = buf
                                            .char_indices()
                                            .find(|(idx, _)| *idx >= cut)
                                            .map(|(idx, _)| idx)
                                            .unwrap_or(buf.len());
                                        buf.drain(..drain_end);
                                    }
                                }
                            }
                        }
                    }
                });
            }

            let mut stdout = BufReader::new(stdout_raw);
            let mut handshake = String::new();
            let mut device: Option<String> = None;

            for _ in 0..40 {
                handshake.clear();
                let n = stdout
                    .read_line(&mut handshake)
                    .map_err(|e| format!("Failed waiting for manga-ocr worker: {e}"))?;
                if n == 0 {
                    let tail = stderr_tail.lock().map(|s| s.trim().to_string()).unwrap_or_default();
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(if tail.is_empty() {
                        "manga-ocr worker exited during initialization.".to_string()
                    } else {
                        format!("manga-ocr worker failed: {tail}")
                    });
                }
                let trimmed = handshake.trim();
                if let Some(rest) = trimmed.strip_prefix("READY ") {
                    device = Some(rest.trim().to_string());
                    break;
                }
            }

            if device.is_none() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("manga-ocr worker did not report READY.".to_string());
            }

            if let Ok(mut last_dev) = device_mutex().lock() {
                *last_dev = device.clone();
            }

            Ok(Self {
                child,
                stdin,
                stdout,
                device,
                stderr_tail,
            })
        }

        fn recognize(&mut self, image_base64: &str) -> Result<MangaOcrResult, String> {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("manga-ocr worker exited ({status})"));
            }
            let payload = serde_json::json!({ "imageBase64": image_base64 }).to_string();
            self.stdin
                .write_all(payload.as_bytes())
                .and_then(|_| self.stdin.write_all(b"\n"))
                .and_then(|_| self.stdin.flush())
                .map_err(|e| format!("Worker write failed: {e}"))?;

            let mut line = String::new();
            loop {
                line.clear();
                let n = self
                    .stdout
                    .read_line(&mut line)
                    .map_err(|e| format!("Worker read failed: {e}"))?;
                if n == 0 {
                    let tail = self
                        .stderr_tail
                        .lock()
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    return Err(if tail.is_empty() {
                        "manga-ocr worker closed stdout unexpectedly.".to_string()
                    } else {
                        format!("manga-ocr worker crashed: {tail}")
                    });
                }
                if !line.trim().is_empty() {
                    break;
                }
            }

            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct WorkerResp {
                ok: bool,
                text: Option<String>,
                device: Option<String>,
                elapsed_ms: Option<u64>,
                error: Option<String>,
            }

            let resp: WorkerResp = serde_json::from_str(line.trim())
                .map_err(|e| format!("Invalid worker JSON response: {e}"))?;
            if !resp.ok {
                return Err(resp.error.unwrap_or_else(|| "manga-ocr failed.".to_string()));
            }
            Ok(MangaOcrResult {
                text: resp.text.unwrap_or_default(),
                engine: "pc-local".to_string(),
                device: resp.device.or_else(|| self.device.clone()),
                elapsed_ms: resp.elapsed_ms.unwrap_or(0),
            })
        }
    }

    impl Drop for PythonOcrWorker {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    pub fn recognize_local(image_base64: &str) -> Result<MangaOcrResult, String> {
        let mut guard = worker_mutex()
            .lock()
            .map_err(|_| "manga-ocr worker lock poisoned.".to_string())?;
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(PythonOcrWorker::start()?);
            }
            let worker = guard.as_mut().expect("worker initialized");
            match worker.recognize(image_base64) {
                Ok(res) => return Ok(res),
                Err(err) => {
                    *guard = None;
                    if attempt == 1 {
                        return Err(err);
                    }
                }
            }
        }
        Err("manga-ocr worker failed.".to_string())
    }

    pub fn warm_up_worker_in_background() {
        std::thread::spawn(|| {
            if let Ok(mut guard) = worker_mutex().lock() {
                if guard.is_none() {
                    if let Ok(worker) = PythonOcrWorker::start() {
                        *guard = Some(worker);
                    }
                }
            }
        });
    }

    pub fn shutdown_worker() {
        if let Ok(mut guard) = worker_mutex().lock() {
            *guard = None;
        }
        if let Ok(mut dev) = device_mutex().lock() {
            *dev = None;
        }
    }

    fn local_lan_ip() -> String {
        UdpSocket::bind("0.0.0.0:0")
            .and_then(|socket| {
                let _ = socket.connect("8.8.8.8:80");
                socket.local_addr()
            })
            .map(|addr| addr.ip().to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string())
    }

    fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            body.as_bytes().len()
        );
        let _ = stream.write_all(header.as_bytes());
        if !body.is_empty() {
            let _ = stream.write_all(body.as_bytes());
        }
        let _ = stream.flush();
    }

    fn query_token(path: &str) -> Option<String> {
        let query = path.split_once('?')?.1;
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if kv.next() == Some("token") {
                return kv.next().map(|v| v.to_string());
            }
        }
        None
    }

    fn has_valid_token(headers: &str, path: &str, expected: &str) -> bool {
        if expected.is_empty() {
            return true;
        }
        if query_token(path).as_deref() == Some(expected) {
            return true;
        }
        for line in headers.lines() {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("authorization") {
                    let val = v.trim();
                    if let Some(bearer) = val
                        .strip_prefix("Bearer ")
                        .or_else(|| val.strip_prefix("bearer "))
                    {
                        if bearer.trim() == expected {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    fn handle_client(mut stream: TcpStream, expected_token: &str, app: &tauri::AppHandle) {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        let mut header_end: Option<usize> = None;

        while header_end.is_none() {
            match stream.read(&mut tmp) {
                Ok(0) => return,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        break;
                    }
                    if buf.len() > 64 * 1024 {
                        write_http_response(&mut stream, "431 Request Header Fields Too Large", "{}");
                        return;
                    }
                }
                Err(_) => return,
            }
        }

        let header_end = header_end.unwrap_or(buf.len());
        let header_text = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let first_line = header_text.lines().next().unwrap_or("");
        let mut parts = first_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let raw_path = parts.next().unwrap_or("/");
        let route = raw_path.split('?').next().unwrap_or("/");

        if method.eq_ignore_ascii_case("OPTIONS") {
            let cors = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(cors.as_bytes());
            return;
        }

        let mokuro_route = matches!(route, "/mokuro/request" | "/mokuro/status");
        if mokuro_route && expected_token.is_empty() {
            write_http_response(&mut stream, "403 Forbidden",
                r#"{"error":"Set a matching OCR access token on the PC and phone, then restart the PC OCR server."}"#);
            return;
        }
        // Credentials for whole-volume jobs travel only in the Authorization header.
        if !has_valid_token(&header_text, if mokuro_route { route } else { raw_path }, expected_token) {
            write_http_response(
                &mut stream,
                "401 Unauthorized",
                r#"{"ok":false,"error":"Invalid OCR server token"}"#,
            );
            return;
        }

        let mut content_length: usize = 0;
        for line in header_text.lines().skip(1) {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse::<usize>().unwrap_or(0);
                }
            }
        }

        if content_length > MAX_HTTP_BODY_BYTES {
            write_http_response(
                &mut stream,
                "413 Payload Too Large",
                r#"{"ok":false,"error":"Image payload exceeds 12 MB"}"#,
            );
            return;
        }

        let mut body = buf[header_end..].to_vec();
        while body.len() < content_length {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
        }
        if body.len() > content_length && content_length > 0 {
            body.truncate(content_length);
        }

        if method.eq_ignore_ascii_case("GET") && route == "/health" {
            let device = device_mutex().lock().ok().and_then(|d| d.clone());
            let json = serde_json::json!({
                "ok": true,
                "service": "setsuna-manga-ocr",
                "device": device,
                "version": "1",
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
            return;
        }

        if method.eq_ignore_ascii_case("GET") && route == "/mokuro/status" {
            let st = get_remote_mokuro_state();
            write_http_response(&mut stream, "200 OK", &serde_json::json!(st).to_string());
            return;
        }

        if method.eq_ignore_ascii_case("POST") && route == "/mokuro/request" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct MokuroReqBody {
                title: Option<String>,
                book_key: Option<String>,
                auto_convert_cbz: Option<bool>,
            }
            let parsed: Result<MokuroReqBody, _> = serde_json::from_slice(&body);
            let req = match parsed {
                Ok(r) => r,
                Err(e) => {
                    let msg = serde_json::json!({ "ok": false, "error": format!("Invalid JSON body: {e}") }).to_string();
                    write_http_response(&mut stream, "400 Bad Request", &msg);
                    return;
                }
            };
            let title = req.title.unwrap_or_default().trim().to_string();
            let book_key = req.book_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            if title.is_empty() || book_key.is_none() || title.len() > 4096 || book_key.as_ref().is_some_and(|k| k.len() > 4096) {
                write_http_response(&mut stream, "400 Bad Request", r#"{"error":"Invalid library title or bookKey"}"#);
                return;
            }
            let Ok(mut job) = remote_mokuro_mutex().lock() else {
                write_http_response(&mut stream, "500 Internal Server Error", r#"{"error":"Job state unavailable"}"#);
                return;
            };
            expire_disconnected_job(&mut job);
            if active_job(&job) {
                drop(job);
                write_http_response(&mut stream, "409 Conflict", r#"{"error":"A Mokuro job is already in progress on this PC"}"#);
                return;
            }
            let queued = RemoteMokuroJobState {
                job_id: NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed),
                state: "queued".to_string(),
                title: title.clone(),
                book_key: book_key.clone(),
                message: Some("Queued on PC…".to_string()),
                error: None,
                current: None,
                total: None,
                updated_at: now_unix_ms(),
            };
            *job = queued.clone();
            drop(job);
            if app.emit_to("main", "setsuna://remote-mokuro-request", serde_json::json!({
                "jobId": queued.job_id,
                "bookKey": book_key,
                "autoConvertCbz": req.auto_convert_cbz.unwrap_or(true),
            })).is_err() {
                let _ = set_remote_mokuro_state(RemoteMokuroJobState {
                    state: "error".into(), error: Some("PC app window unavailable.".into()), ..queued
                });
                write_http_response(&mut stream, "503 Service Unavailable", r#"{"error":"PC app window unavailable"}"#);
                return;
            }
            write_http_response(&mut stream, "202 Accepted", &serde_json::json!(queued).to_string());
            return;
        }

        if method.eq_ignore_ascii_case("POST") && route == "/ocr" {
            #[derive(Deserialize)]
            struct ReqBody {
                #[serde(alias = "image_base64")]
                #[serde(rename = "imageBase64")]
                image_base64: Option<String>,
            }
            let parsed: Result<ReqBody, _> = serde_json::from_slice(&body);
            let b64 = match parsed {
                Ok(req) => req.image_base64.unwrap_or_default(),
                Err(e) => {
                    let msg = serde_json::json!({ "ok": false, "error": format!("Invalid JSON body: {e}") }).to_string();
                    write_http_response(&mut stream, "400 Bad Request", &msg);
                    return;
                }
            };
            if b64.trim().is_empty() {
                write_http_response(
                    &mut stream,
                    "400 Bad Request",
                    r#"{"ok":false,"error":"Missing imageBase64"}"#,
                );
                return;
            }
            match recognize_local(&b64) {
                Ok(res) => {
                    let json = serde_json::json!({
                        "ok": true,
                        "text": res.text,
                        "engine": "remote-pc",
                        "device": res.device,
                        "elapsedMs": res.elapsed_ms,
                    })
                    .to_string();
                    write_http_response(&mut stream, "200 OK", &json);
                }
                Err(err) => {
                    let json = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_http_response(&mut stream, "500 Internal Server Error", &json);
                }
            }
            return;
        }

        write_http_response(
            &mut stream,
            "404 Not Found",
            r#"{"ok":false,"error":"Not found"}"#,
        );
    }

    pub fn current_status() -> MangaOcrServerStatus {
        let available = detect_manga_ocr_python().is_some();
        let device = device_mutex().lock().ok().and_then(|d| d.clone());
        let guard = server_mutex().lock();
        match guard {
            Ok(ref opt) => {
                if let Some(handle) = opt.as_ref() {
                    MangaOcrServerStatus {
                        running: true,
                        available,
                        url: Some(handle.url.clone()),
                        port: handle.port,
                        device,
                        token: handle.token.clone(),
                        error: None,
                    }
                } else {
                    MangaOcrServerStatus {
                        running: false,
                        available,
                        url: None,
                        port: DEFAULT_OCR_PORT,
                        device,
                        token: String::new(),
                        error: None,
                    }
                }
            }
            Err(_) => MangaOcrServerStatus {
                running: false,
                available,
                url: None,
                port: DEFAULT_OCR_PORT,
                device,
                token: String::new(),
                error: Some("Server state lock error".to_string()),
            },
        }
    }

    pub fn start_server(app: tauri::AppHandle, port: Option<u16>, token: Option<String>) -> Result<MangaOcrServerStatus, String> {
        let requested_port = port.filter(|p| *p > 0).unwrap_or(DEFAULT_OCR_PORT);
        let clean_token = token.unwrap_or_default().trim().to_string();

        // Stop any existing instance first so port/token updates apply cleanly
        let _ = stop_server_only();

        if detect_manga_ocr_python().is_none() {
            return Err("Python package `manga-ocr` not found on this PC.".to_string());
        }

        let listener = TcpListener::bind(("0.0.0.0", requested_port))
            .map_err(|e| format!("Failed to bind LAN OCR server on port {requested_port}: {e}"))?;
        let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(requested_port);
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure nonblocking listener: {e}"))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let token_clone = clean_token.clone();

        let join = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let tok = token_clone.clone();
                        let app = app.clone();
                        std::thread::spawn(move || {
                            handle_client(stream, &tok, &app);
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(45));
                    }
                    Err(_) => break,
                }
            }
        });

        let url = format!("http://{}:{actual_port}", local_lan_ip());
        {
            let mut guard = server_mutex()
                .lock()
                .map_err(|_| "Failed to lock OCR server state.".to_string())?;
            *guard = Some(ServerHandle {
                stop,
                port: actual_port,
                token: clean_token,
                url,
                join: Some(join),
            });
        }

        warm_up_worker_in_background();
        Ok(current_status())
    }

    fn stop_server_only() -> Result<(), String> {
        let mut handle = {
            let mut guard = server_mutex()
                .lock()
                .map_err(|_| "Failed to lock OCR server state.".to_string())?;
            guard.take()
        };
        if let Some(ref mut h) = handle {
            h.stop.store(true, Ordering::Relaxed);
            if let Some(j) = h.join.take() {
                let _ = j.join();
            }
        }
        Ok(())
    }

    pub fn stop_server() -> Result<MangaOcrServerStatus, String> {
        stop_server_only()?;
        shutdown_worker();
        Ok(current_status())
    }
}

#[tauri::command]
pub async fn manga_ocr_server_status() -> MangaOcrServerStatus {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        return tokio::task::spawn_blocking(desktop::current_status)
            .await
            .unwrap_or(MangaOcrServerStatus {
                running: false,
                available: false,
                url: None,
                port: desktop::DEFAULT_OCR_PORT,
                device: None,
                token: String::new(),
                error: Some("Status check panicked".to_string()),
            });
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        MangaOcrServerStatus {
            running: false,
            available: false,
            url: None,
            port: 47123,
            device: None,
            token: String::new(),
            error: None,
        }
    }
}

#[tauri::command]
pub async fn manga_ocr_server_start(
    app: tauri::AppHandle,
    port: Option<u16>,
    token: Option<String>,
) -> Result<MangaOcrServerStatus, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        return tokio::task::spawn_blocking(move || desktop::start_server(app, port, token))
            .await
            .map_err(|e| format!("Failed to start OCR server: {e}"))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, port, token);
        Err("Hosting a LAN OCR server is only supported on Desktop.".to_string())
    }
}

#[tauri::command]
pub async fn manga_ocr_server_stop() -> Result<MangaOcrServerStatus, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        return tokio::task::spawn_blocking(desktop::stop_server)
            .await
            .map_err(|e| format!("Failed to stop OCR server: {e}"))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(MangaOcrServerStatus {
            running: false,
            available: false,
            url: None,
            port: 47123,
            device: None,
            token: String::new(),
            error: None,
        })
    }
}

#[tauri::command]
pub async fn manga_ocr_local_recognize(image_base64: String) -> Result<MangaOcrResult, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        return tokio::task::spawn_blocking(move || desktop::recognize_local(&image_base64))
            .await
            .map_err(|e| format!("Local OCR task failed: {e}"))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = image_base64;
        Err("Local Python GPU OCR is only available on Desktop.".to_string())
    }
}

#[tauri::command]
pub async fn manga_ocr_remote_health(
    url: String,
    token: Option<String>,
) -> Result<MangaOcrHealth, String> {
    let base = normalize_remote_base(&url)?;
    let endpoint = format!("{base}/health");
    let client = crate::http_client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&endpoint);
    if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(tok);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PC OCR server unreachable: {}", e.without_url()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("PC OCR server returned HTTP {status}: {text}"));
    }
    serde_json::from_str::<MangaOcrHealth>(&text)
        .map_err(|e| format!("Invalid health JSON from PC OCR server: {e}"))
}

#[tauri::command]
pub async fn manga_ocr_remote_recognize(
    url: String,
    token: Option<String>,
    image_base64: String,
) -> Result<MangaOcrResult, String> {
    let base = normalize_remote_base(&url)?;
    let endpoint = format!("{base}/ocr");
    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({ "imageBase64": image_base64 }).to_string();
    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json; charset=UTF-8")
        .body(body);
    if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(tok);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PC OCR request failed: {}", e.without_url()))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RemoteResp {
        ok: Option<bool>,
        text: Option<String>,
        engine: Option<String>,
        device: Option<String>,
        elapsed_ms: Option<u64>,
        error: Option<String>,
    }

    let parsed: RemoteResp = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid OCR JSON ({status}): {e}"))?;
    if !status.is_success() || parsed.ok == Some(false) {
        return Err(parsed
            .error
            .unwrap_or_else(|| format!("PC OCR server returned HTTP {status}")));
    }

    Ok(MangaOcrResult {
        text: parsed.text.unwrap_or_default(),
        engine: parsed.engine.unwrap_or_else(|| "remote-pc".to_string()),
        device: parsed.device,
        elapsed_ms: parsed.elapsed_ms.unwrap_or(0),
    })
}

#[tauri::command]
pub async fn manga_ocr_set_remote_mokuro_state(state: RemoteMokuroJobState) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        desktop::set_remote_mokuro_state(state)?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = state;
    }
    Ok(())
}

#[tauri::command]
pub async fn manga_ocr_remote_mokuro_request(
    url: String,
    token: Option<String>,
    title: String,
    book_key: Option<String>,
    auto_convert_cbz: Option<bool>,
) -> Result<RemoteMokuroJobState, String> {
    let base = normalize_remote_base(&url)?;
    let endpoint = format!("{base}/mokuro/request");
    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "title": title,
        "bookKey": book_key,
        "autoConvertCbz": auto_convert_cbz.unwrap_or(true),
    })
    .to_string();
    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json; charset=UTF-8")
        .body(body);
    if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(tok);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PC Mokuro request failed: {}", e.without_url()))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("PC OCR server returned HTTP {status}: {raw}"));
    }
    serde_json::from_str::<RemoteMokuroJobState>(&raw)
        .map_err(|e| format!("Invalid Mokuro job JSON ({status}): {e}"))
}

#[tauri::command]
pub async fn manga_ocr_remote_mokuro_status(
    url: String,
    token: Option<String>,
) -> Result<RemoteMokuroJobState, String> {
    let base = normalize_remote_base(&url)?;
    let endpoint = format!("{base}/mokuro/status");
    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&endpoint);
    if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(tok);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("PC Mokuro status check failed: {}", e.without_url()))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("PC OCR server returned HTTP {status}: {raw}"));
    }
    serde_json::from_str::<RemoteMokuroJobState>(&raw)
        .map_err(|e| format!("Invalid Mokuro status JSON ({status}): {e}"))
}
