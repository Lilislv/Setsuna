use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45)).build().map_err(|e| e.to_string())
}

// Stream directly to disk. Retry interrupted transfers using Google's Range support.
// If the server cannot guarantee the same revision, restart instead of mixing files.
pub async fn download(
    client: &reqwest::Client, url: &str, token: &str, path: &Path, expected: Option<u64>,
    progress: impl Fn(u64, u64, &str),
) -> Result<u64, String> {
    let mut file = tokio::fs::File::create(path).await.map_err(|e| e.to_string())?;
    let mut downloaded = 0u64;
    let mut etag: Option<String> = None;
    let mut last_error = String::new();
    for attempt in 0..3 {
        if downloaded > 0 && etag.is_none() {
            file.set_len(0).await.map_err(|e| e.to_string())?;
            use tokio::io::AsyncSeekExt;
            file.rewind().await.map_err(|e| e.to_string())?;
            downloaded = 0;
        }
        progress(downloaded, expected.unwrap_or(0), if attempt == 0 { "connecting" } else { "retrying" });
        let mut request = client.get(url).bearer_auth(token);
        if downloaded > 0 {
            request = request.header("Range", format!("bytes={downloaded}-"))
                .header("If-Range", etag.as_deref().unwrap());
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => { last_error = error.without_url().to_string(); continue; }
        };
        let status = response.status();
        if !status.is_success() {
            last_error = format!("Google Drive: HTTP {status}");
            if status.is_server_error() || status.as_u16() == 429 { continue; }
            return Err(last_error);
        }
        if downloaded > 0 && status == reqwest::StatusCode::OK {
            use tokio::io::AsyncSeekExt;
            file.set_len(0).await.map_err(|e| e.to_string())?;
            file.rewind().await.map_err(|e| e.to_string())?;
            downloaded = 0;
        } else if status == reqwest::StatusCode::PARTIAL_CONTENT {
            let range_start = response.headers().get("content-range").and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes ")).and_then(|s| s.split('-').next()).and_then(|s| s.parse::<u64>().ok());
            if range_start != Some(downloaded) { return Err("Google Drive returned an invalid download range".into()); }
            let response_etag = response.headers().get("etag").and_then(|h| h.to_str().ok());
            if downloaded > 0 && response_etag.is_some() && response_etag != etag.as_deref() {
                return Err("The dictionary changed on Google Drive during download. Try again.".into());
            }
        }
        etag = response.headers().get("etag").and_then(|h| h.to_str().ok()).filter(|s| !s.starts_with("W/")).map(str::to_string);
        let total = expected.or_else(|| response.content_length().map(|n| n + downloaded)).unwrap_or(0);
        let mut last_progress = Instant::now() - Duration::from_secs(1);
        let mut interrupted = false;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk).await.map_err(|e| format!("Failed to save dictionary: {e}"))?;
                    downloaded += chunk.len() as u64;
                    if total > 0 && downloaded > total { return Err("Downloaded dictionary is larger than expected".into()); }
                    if last_progress.elapsed() >= Duration::from_millis(200) {
                        progress(downloaded, total, "downloading");
                        last_progress = Instant::now();
                    }
                }
                Ok(None) => break,
                Err(error) => { last_error = error.without_url().to_string(); interrupted = true; break; }
            }
        }
        if !interrupted && (total == 0 || downloaded == total) {
            if downloaded < 16 { return Err("Google Drive dictionary file is empty or incomplete. Upload the database again from the PC.".into()); }
            file.sync_all().await.map_err(|e| e.to_string())?;
            progress(downloaded, total, "validating");
            return Ok(downloaded);
        }
        if !interrupted { last_error = format!("Incomplete download: {downloaded} / {total} bytes"); }
    }
    Err(format!("Download stopped after 3 attempts (connection timeout 20 s, no data timeout 45 s): {last_error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn run_server(responses: Vec<(&'static str, Option<&'static str>)>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/dictionary", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for (response, required_header) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0]; socket.read_exact(&mut byte).unwrap(); request.push(byte[0]);
                }
                if let Some(header) = required_header { assert!(String::from_utf8_lossy(&request).to_lowercase().contains(header)); }
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, worker)
    }
    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("setsuna-drive-test-{}-{}.db", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }
    #[test]
    fn interrupted_download_resumes_at_confirmed_byte_without_duplication() {
        let (url, worker) = run_server(vec![
            ("HTTP/1.1 200 OK\r\nContent-Length: 32\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nSQLite format 3\0", None),
            ("HTTP/1.1 206 Partial Content\r\nContent-Length: 16\r\nContent-Range: bytes 16-31/32\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nabcdefghijklmnop", Some("range: bytes=16-")),
        ]);
        let file = path();
        let result = tauri::async_runtime::block_on(download(&client().unwrap(), &url, "test", &file, Some(32), |_, _, _| {}));
        assert_eq!(result.unwrap(), 32);
        assert_eq!(std::fs::read(&file).unwrap(), b"SQLite format 3\0abcdefghijklmnop");
        std::fs::remove_file(file).unwrap(); worker.join().unwrap();
    }
    #[test]
    fn ignored_range_restarts_and_empty_download_is_rejected() {
        let (url, worker) = run_server(vec![
            ("HTTP/1.1 200 OK\r\nContent-Length: 32\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nSQLite format 3\0", None),
            ("HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\nSQLite format 3\0abcdefghijklmnop", Some("range: bytes=16-")),
        ]);
        let file = path();
        tauri::async_runtime::block_on(download(&client().unwrap(), &url, "test", &file, Some(32), |_, _, _| {})).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().len(), 32);
        worker.join().unwrap();
        let (url, worker) = run_server(vec![("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", None)]);
        assert!(tauri::async_runtime::block_on(download(&client().unwrap(), &url, "test", &file, None, |_, _, _| {})).unwrap_err().contains("empty"));
        std::fs::remove_file(file).unwrap(); worker.join().unwrap();
    }
    #[test]
    fn failed_connections_are_bounded() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap()); drop(listener);
        let file = path();
        assert!(tauri::async_runtime::block_on(download(&client().unwrap(), &url, "test", &file, None, |_, _, _| {})).unwrap_err().contains("3 attempts"));
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn stalled_headers_and_body_cannot_wait_forever() {
        for headers in ["", "HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\n"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                for _ in 0..3 {
                    let (mut socket, _) = listener.accept().unwrap();
                    let _ = socket.write_all(headers.as_bytes());
                    std::thread::sleep(Duration::from_millis(150));
                }
            });
            let file = path();
            let client = reqwest::Client::builder().read_timeout(Duration::from_millis(80)).build().unwrap();
            let started = Instant::now();
            let error = tauri::async_runtime::block_on(download(&client, &url, "test", &file, Some(32), |_, _, _| {})).unwrap_err();
            assert!(error.contains("3 attempts"));
            assert!(started.elapsed() < Duration::from_secs(3));
            std::fs::remove_file(file).unwrap(); worker.join().unwrap();
        }
    }
}
