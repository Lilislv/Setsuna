use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, Once, OnceLock,
};
use tauri::{AppHandle, Manager};

fn media_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

#[derive(serde::Serialize)]
pub struct PlayerClipResult {
    path: String,
    filename: String,
    media_type: String,
}

#[derive(serde::Serialize)]
pub struct FfmpegStatus {
    found: bool,
    path: String,
    bundled: bool,
}

fn sanitize_media_name(value: &str) -> String {
    let mut name = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            name.push(ch);
        } else if ch.is_whitespace() || ch == '.' {
            name.push('_');
        }
        if name.len() >= 64 {
            break;
        }
    }
    if name.is_empty() {
        "clip".to_string()
    } else {
        name
    }
}

fn ffmpeg_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn ffmpeg_candidate_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(env_path) = env::var("SETSUNA_FFMPEG_PATH") {
        if !env_path.trim().is_empty() {
            candidates.push(PathBuf::from(env_path));
        }
    }

    let name = ffmpeg_filename();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("bin").join(name));
            candidates.push(dir.join("resources").join(name));
            candidates.push(dir.join("resources").join("bin").join(name));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(name));
        candidates.push(resource_dir.join("bin").join(name));
        candidates.push(resource_dir.join("resources").join(name));
        candidates.push(resource_dir.join("resources").join("bin").join(name));
    }

    if let Ok(data_bin) = super::get_data_path(app, "bin") {
        candidates.push(data_bin.join(name));
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join(name));
        candidates.push(cwd.join("bin").join(name));
    }

    candidates
}

fn find_ffmpeg_binary(app: &AppHandle) -> Option<PathBuf> {
    ffmpeg_candidate_paths(app)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn ffmpeg_from_path_available() -> bool {
    media_command(ffmpeg_filename())
        .arg("-version")
        .arg("-hide_banner")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_ffmpeg_status(app: AppHandle) -> Result<FfmpegStatus, String> {
    if let Some(path) = find_ffmpeg_binary(&app) {
        return Ok(FfmpegStatus {
            found: true,
            path: path.to_string_lossy().to_string(),
            bundled: true,
        });
    }

    Ok(FfmpegStatus {
        found: ffmpeg_from_path_available(),
        path: ffmpeg_filename().to_string(),
        bundled: false,
    })
}

#[tauri::command]
pub async fn extract_player_clip(
    app: AppHandle,
    source_path: String,
    start: f64,
    end: f64,
    prefer_video: bool,
    audio_track: Option<u32>,
) -> Result<PlayerClipResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let encoder = find_ffmpeg_binary(&app).unwrap_or_else(|| PathBuf::from(ffmpeg_filename()));
        let directory = super::get_data_path(&app, "player_clips")?;
        cut_clip(
            encoder,
            directory,
            source_path,
            start,
            end,
            prefer_video,
            audio_track,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn media_input(source: &str) -> Result<&'static str, String> {
    if PathBuf::from(source).is_file() {
        Ok("file,crypto")
    } else if source.starts_with("https://") {
        Ok("https,tls,tcp,crypto")
    } else {
        Err("Select a local media file or a direct HTTPS media URL".into())
    }
}

fn cut_clip(
    encoder: PathBuf,
    clip_dir: PathBuf,
    source_path: String,
    start: f64,
    end: f64,
    prefer_video: bool,
    audio_track: Option<u32>,
) -> Result<PlayerClipResult, String> {
    let protocols = media_input(&source_path)?;
    if !start.is_finite() || !end.is_finite() || end <= start || start < 0.0 {
        return Err("Invalid clip interval".into());
    }
    let duration = end - start;
    let source_name = PathBuf::from(&source_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_media_name)
        .unwrap_or_else(|| "clip".to_string());
    let extension = if prefer_video { "mp4" } else { "mp3" };
    let media_type = if prefer_video { "video" } else { "audio" };
    static NEXT_CLIP: AtomicU64 = AtomicU64::new(0);
    let filename = format!(
        "setsuna_{}_{}_{}.{extension}",
        source_name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_CLIP.fetch_add(1, Ordering::Relaxed)
    );

    if !clip_dir.exists() {
        std::fs::create_dir_all(&clip_dir).map_err(|e| e.to_string())?;
    }
    let output_path = clip_dir.join(&filename);

    let mut command = media_command(encoder);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .args(["-abort_on", "empty_output"])
        .arg("-protocol_whitelist")
        .arg(protocols)
        .arg("-y")
        .arg("-ss")
        .arg(format!("{:.3}", start.max(0.0)))
        .arg("-i")
        .arg(&source_path)
        .arg("-t")
        .arg(format!("{:.3}", duration));

    if let Some(track) = audio_track {
        command.args(["-map", &format!("0:a:{track}")]);
    }
    command.args(["-sn", "-dn", "-ac", "2"]);
    if prefer_video {
        // An unlabeled filter output always supplies the video. When no audio track
        // was selected, FFmpeg can still automatically select the default audio.
        command.args([
            "-filter_complex",
            "[0:V:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        ]);
        command
            .arg("-c:v")
            .arg("libx264")
            .arg("-preset")
            .arg("veryfast")
            .arg("-crf")
            .arg("24");
        command.arg("-c:a").arg("aac").arg("-b:a").arg("128k");
        command.arg("-movflags").arg("+faststart");
    } else {
        command
            .arg("-vn")
            .arg("-codec:a")
            .arg("libmp3lame")
            .arg("-q:a")
            .arg("4");
    }

    let output = command
        .arg(&output_path)
        .output()
        .map_err(|e| format!("ffmpeg is not available. Put ffmpeg.exe into src-tauri/bin or install it into PATH. {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&output_path);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffmpeg failed to cut the player clip".to_string()
        } else {
            stderr
        });
    }

    Ok(PlayerClipResult {
        path: output_path.to_string_lossy().to_string(),
        filename,
        media_type: media_type.to_string(),
    })
}

#[tauri::command]
pub fn discard_player_clip(app: AppHandle, filename: String) -> Result<(), String> {
    if !filename.starts_with("setsuna_")
        || !filename
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
        || !(filename.ends_with(".mp4") || filename.ends_with(".mp3"))
    {
        return Err("Invalid clip name".into());
    }
    match std::fs::remove_file(super::get_data_path(&app, "player_clips")?.join(filename)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct SubtitleTrack {
    index: u32,
    codec_name: Option<String>,
    tags: Option<std::collections::HashMap<String, String>>,
}

#[tauri::command]
pub async fn player_subtitle_tracks(
    app: AppHandle,
    source: String,
) -> Result<Vec<SubtitleTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let protocols = media_input(&source)?;
        let name = if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        };
        let probe = find_ffmpeg_binary(&app)
            .map(|p| p.with_file_name(name))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from(name));
        let output = media_command(probe)
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                protocols,
                "-select_streams",
                "s",
                "-show_entries",
                "stream=index,codec_name:stream_tags=language,title",
                "-of",
                "json",
                "-i",
                &source,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        #[derive(serde::Deserialize)]
        struct Streams {
            streams: Vec<SubtitleTrack>,
        }
        let data: Streams = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        Ok(data
            .streams
            .into_iter()
            .filter(|s| {
                matches!(
                    s.codec_name.as_deref(),
                    Some("subrip" | "ass" | "ssa" | "webvtt" | "mov_text" | "text")
                )
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn player_subtitle_text(
    app: AppHandle,
    source: String,
    index: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let protocols = media_input(&source)?;
        let ffmpeg = find_ffmpeg_binary(&app).unwrap_or_else(|| PathBuf::from(ffmpeg_filename()));
        let output = media_command(ffmpeg)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                protocols,
                "-i",
                &source,
                "-map",
                &format!("0:{index}"),
                "-f",
                "webvtt",
                "pipe:1",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn player_scene_frame(
    app: AppHandle,
    source: String,
    time: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let protocols = media_input(&source)?;
        let ffmpeg = find_ffmpeg_binary(&app).unwrap_or_else(|| PathBuf::from(ffmpeg_filename()));
        let output = media_command(ffmpeg)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                protocols,
                "-ss",
                &format!("{:.3}", time.max(0.0)),
                "-i",
                &source,
                "-map",
                "0:V:0",
                "-frames:v",
                "1",
                "-vf",
                "scale='min(iw,960)':-2",
                "-f",
                "image2pipe",
                "-c:v",
                "mjpeg",
                "pipe:1",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() || output.stdout.is_empty() {
            return Err("Could not capture the video frame".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(output.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct WebText {
    url: String,
    text: String,
}

#[tauri::command]
pub async fn player_web_text(url: String) -> Result<WebText, String> {
    let client = super::http_client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let url = response.url().to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Page or subtitle exceeds 8 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(WebText {
        url,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn video_jobs() -> &'static Mutex<HashMap<PathBuf, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(Mutex::default)
}

fn is_video_token(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn compatible_path(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
    if !is_video_token(token) {
        return Err("Invalid conversion identifier".into());
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("player-playback");
    Ok(dir.join(format!("{}.mp4", token.to_ascii_lowercase())))
}

// The desktop app has one instance. At its first conversion, only files from
// an earlier run can exist here (for example after closing the window mid-encode).
fn clear_previous_videos(directory: &Path) {
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name
                .to_str()
                .and_then(|s| s.strip_suffix(".mp4"))
                .is_some_and(is_video_token)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn convert_player_video(
    encoder: &Path,
    source: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Conversion cancelled".into());
    }
    let mut child = media_command(encoder)
        .args([
            "-nostdin",
            "-n",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,crypto",
            "-i",
            source,
            "-map",
            "0:V:0",
            "-map",
            "0:a?",
            "-sn",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
        ])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Conversion cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("FFmpeg conversion failed ({status})")),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(150)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    }
}

#[tauri::command]
pub async fn prepare_player_video(
    app: AppHandle,
    source: String,
    token: String,
) -> Result<String, String> {
    let target = compatible_path(&app, &token)?;
    if !Path::new(&source).is_file() {
        return Err("Choose a local video file".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = video_jobs().lock().map_err(|e| e.to_string())?;
        static CLEAR_PREVIOUS: Once = Once::new();
        CLEAR_PREVIOUS.call_once(|| clear_previous_videos(target.parent().unwrap()));
        if jobs.contains_key(&target) || target.exists() {
            return Err("Conversion already exists".into());
        }
        jobs.insert(target.clone(), cancel.clone());
    }
    let output = target.clone();
    let worker_cancel = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
        let encoder = find_ffmpeg_binary(&app).unwrap_or_else(|| PathBuf::from(ffmpeg_filename()));
        convert_player_video(&encoder, &source, &output, &worker_cancel)?;
        app.asset_protocol_scope()
            .allow_file(&output)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    // Complete under the same lock used by release. A cancellation arriving
    // after FFmpeg exits but before the IPC response still owns the output.
    let mut jobs = video_jobs().lock().map_err(|e| e.to_string())?;
    let result = if cancel.load(Ordering::Relaxed) {
        Err("Conversion cancelled".into())
    } else {
        result
    };
    if result.is_err() {
        let _ = std::fs::remove_file(&target);
    }
    jobs.remove(&target);
    result.map(|_| target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn release_player_video(app: AppHandle, token: String) -> Result<(), String> {
    let output = compatible_path(&app, &token)?;
    if let Some(flag) = video_jobs().lock().map_err(|e| e.to_string())?.get(&output) {
        flag.store(true, Ordering::Relaxed);
        return Ok(());
    }
    // WebView2 can keep a movie open briefly after React detaches its video element.
    for attempt in 0..6 {
        match tokio::fs::remove_file(&output).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if attempt == 5 => return Err(e.to_string()),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(path: &Path) -> serde_json::Value {
        let info = media_command("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name:stream_tags=language:stream_disposition=default:format=duration",
                "-of",
                "json",
                "-i",
            ])
            .arg(path)
            .output()
            .unwrap();
        assert!(info.status.success());
        serde_json::from_slice(&info.stdout).unwrap()
    }

    fn sample_brightness(path: &str, time: &str) -> u8 {
        let frame = media_command(ffmpeg_filename())
            .args([
                "-v",
                "error",
                "-ss",
                time,
                "-i",
                path,
                "-frames:v",
                "1",
                "-vf",
                "scale=1:1,format=gray",
                "-f",
                "rawvideo",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(frame.status.success());
        assert_eq!(frame.stdout.len(), 1);
        frame.stdout[0]
    }

    #[test]
    fn previous_conversion_cleanup_preserves_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("setsuna-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = dir.join("97aa97aa-fec3-4000-a000-ff62bc19bb25.mp4");
        let unrelated = dir.join("episode.mp4");
        std::fs::write(&cache, []).unwrap();
        std::fs::write(&unrelated, []).unwrap();
        clear_previous_videos(&dir);
        assert!(!cache.exists());
        assert!(unrelated.is_file());
        std::fs::remove_file(unrelated).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    // This integration test needs ffmpeg and ffprobe on PATH.
    #[test]
    #[ignore]
    fn player_scene_contains_requested_video_and_audio() {
        let dir = std::env::temp_dir().join(format!("setsuna-player-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("fixture.mkv");
        let ok = media_command(ffmpeg_filename())
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x90:r=24:d=10,drawbox=color=white:t=fill:enable='between(t,1,8)'",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=10",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=10",
                "-map", "0:v", "-map", "1:a", "-map", "2:a",
                "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn",
                "-disposition:a:0", "0", "-disposition:a:1", "default",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(ok.success());
        let clip = cut_clip(
            PathBuf::from(ffmpeg_filename()),
            dir.clone(),
            source.to_string_lossy().into_owned(),
            1.0,
            8.25,
            true,
            None,
        )
        .unwrap();
        let meta = probe(Path::new(&clip.path));
        assert_eq!(meta["streams"][0]["codec_name"], "h264");
        assert_eq!(meta["streams"][1]["codec_name"], "aac");
        assert_eq!(meta["streams"][1]["tags"]["language"], "jpn");
        let duration: f64 = meta["format"]["duration"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((duration - 7.25).abs() < 0.1);
        assert!(sample_brightness(&clip.path, "0.12") > 200);
        assert!(sample_brightness(&clip.path, "7.12") < 40);

        let encoder = PathBuf::from(ffmpeg_filename());
        let compatible = dir.join("compatible.mp4");
        convert_player_video(
            &encoder,
            source.to_str().unwrap(),
            &compatible,
            &AtomicBool::new(false),
        )
        .unwrap();
        let streams = probe(&compatible)["streams"].as_array().unwrap().clone();
        assert_eq!(streams.len(), 3);
        assert_eq!(streams[1]["tags"]["language"], "eng");
        assert_eq!(streams[2]["tags"]["language"], "jpn");
        assert_eq!(streams[2]["disposition"]["default"], 1);
        let explicit = cut_clip(
            encoder.clone(),
            dir.clone(),
            source.to_string_lossy().into_owned(),
            1.0,
            2.0,
            true,
            Some(0),
        )
        .unwrap();
        assert_eq!(
            probe(Path::new(&explicit.path))["streams"][1]["tags"]["language"],
            "eng"
        );
        assert!(cut_clip(
            encoder.clone(),
            dir.clone(),
            source.to_string_lossy().into_owned(),
            1.0,
            2.0,
            true,
            Some(2),
        )
        .is_err());
        assert!(cut_clip(
            encoder,
            dir.clone(),
            source.to_string_lossy().into_owned(),
            20.0,
            21.0,
            true,
            None,
        )
        .is_err());
        std::fs::remove_file(explicit.path).unwrap();
        std::fs::remove_file(compatible).unwrap();
        std::fs::remove_file(clip.path).unwrap();
        std::fs::remove_file(source).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
