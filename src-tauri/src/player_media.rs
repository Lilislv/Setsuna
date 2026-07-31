use std::env;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

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
    Command::new(ffmpeg_filename())
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
) -> Result<PlayerClipResult, String> {
    if source_path.trim().is_empty() {
        return Err("No source video path".to_string());
    }

    let duration = (end - start).clamp(0.1, 60.0);
    let source_name = PathBuf::from(&source_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_media_name)
        .unwrap_or_else(|| "clip".to_string());
    let extension = if prefer_video { "mp4" } else { "mp3" };
    let media_type = if prefer_video { "video" } else { "audio" };
    let filename = format!(
        "setsuna_{}_{}.{extension}",
        source_name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let clip_dir = super::get_data_path(&app, "player_clips")?;
    if !clip_dir.exists() {
        std::fs::create_dir_all(&clip_dir).map_err(|e| e.to_string())?;
    }
    let output_path = clip_dir.join(&filename);

    let ffmpeg_path = find_ffmpeg_binary(&app).unwrap_or_else(|| PathBuf::from(ffmpeg_filename()));
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-ss")
        .arg(format!("{:.3}", start.max(0.0)))
        .arg("-t")
        .arg(format!("{:.3}", duration))
        .arg("-i")
        .arg(&source_path);

    if prefer_video {
        command.arg("-map").arg("0:v:0").arg("-map").arg("0:a:0?");
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
            .arg("-ac")
            .arg("2")
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
