//! One-click Mokuro setup on Windows: a Python 3.10-3.12 interpreter (installed
//! per user when missing), PyTorch (CUDA build when an NVIDIA GPU is present) and
//! the `mokuro` package. Progress goes to the `manga_mokuro_install` event.
//! Also the shared interpreter search used by the Mokuro runner and the PC OCR
//! server: it checks absolute install paths too, because a Python installed while
//! Setsuna runs is not on this process's (stale) PATH.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use std::io::{BufRead, BufReader, Read};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    /// Versions PyTorch publishes Windows wheels for that mokuro is tested with.
    const SUPPORTED_MINORS: [u32; 3] = [12, 11, 10];
    const PYTHON_VERSION: &str = "3.12.10";
    /// CUDA 12.8 wheels cover Turing (7.5) up to Blackwell (RTX 50, 12.0); older
    /// cards (Maxwell/Pascal/Volta) are only in the CUDA 12.6 wheels.
    const TORCH_CUDA_INDEX_NEW: &str = "https://download.pytorch.org/whl/cu128";
    const TORCH_CUDA_INDEX_OLD: &str = "https://download.pytorch.org/whl/cu126";

    pub fn quiet_command(program: &str) -> Command {
        let mut cmd = Command::new(program);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    #[cfg(target_os = "windows")]
    fn per_user_python(minor: u32) -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("Programs").join("Python").join(format!("Python3{minor}")).join("python.exe"))
    }

    /// Interpreters to try, best first: `py -3.x`, absolute install paths, then PATH.
    pub fn python_candidates() -> Vec<(String, Vec<String>)> {
        let mut out: Vec<(String, Vec<String>)> = SUPPORTED_MINORS
            .iter()
            .map(|minor| ("py".to_string(), vec![format!("-3.{minor}")]))
            .collect();
        #[cfg(target_os = "windows")]
        for minor in SUPPORTED_MINORS {
            let mut paths: Vec<PathBuf> = per_user_python(minor).into_iter().collect();
            for var in ["ProgramFiles", "ProgramW6432"] {
                if let Some(base) = std::env::var_os(var) {
                    paths.push(PathBuf::from(base).join(format!("Python3{minor}")).join("python.exe"));
                }
            }
            for path in paths {
                let path = path.to_string_lossy().into_owned();
                if PathBuf::from(&path).is_file() && !out.iter().any(|(p, _)| p == &path) {
                    out.push((path, Vec::new()));
                }
            }
        }
        for prog in ["python", "python3", "py"] {
            out.push((prog.to_string(), Vec::new()));
        }
        out
    }

    fn runs_ok(prog: &str, prefix: &[String], script: &str) -> Option<String> {
        let out = quiet_command(prog).args(prefix).arg("-c").arg(script).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// An interpreter whose version PyTorch supports.
    fn supported_python() -> Option<(String, Vec<String>)> {
        let probe = format!(
            "import sys; sys.exit(0 if sys.version_info[:2] in {} else 1)",
            format!("[{}]", SUPPORTED_MINORS.iter().map(|m| format!("(3, {m})")).collect::<Vec<_>>().join(", "))
        );
        python_candidates().into_iter().find(|(prog, prefix)| runs_ok(prog, prefix, &probe).is_some())
    }

    fn emit(app: &AppHandle, stage: &str, line: &str) {
        let _ = app.emit("manga_mokuro_install", serde_json::json!({ "stage": stage, "line": line }));
    }

    /// Runs a command, forwarding every output line (pip/winget progress) to the UI.
    fn run_streamed(app: &AppHandle, stage: &str, mut cmd: Command) -> Result<(), String> {
        cmd.env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Failed to start {:?}: {e}", cmd.get_program()))?;
        let stderr = child.stderr.take();
        let err_app = app.clone();
        let err_stage = stage.to_string();
        let err_thread = std::thread::spawn(move || {
            let mut last = String::new();
            if let Some(stream) = stderr {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let line = line.trim().to_string();
                    if !line.is_empty() {
                        emit(&err_app, &err_stage, &line);
                        last = line;
                    }
                }
            }
            last
        });
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            // winget redraws progress with '\r'; split on both.
            let mut byte = [0u8; 1];
            while reader.read(&mut byte).map(|n| n > 0).unwrap_or(false) {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    buf.clear();
                    if !line.is_empty() {
                        emit(app, stage, &line);
                    }
                } else if buf.len() < 2048 {
                    buf.push(byte[0]);
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let last = err_thread.join().unwrap_or_default();
        if status.success() {
            Ok(())
        } else if last.is_empty() {
            Err(format!("{:?} exited with {status}", cmd.get_program()))
        } else {
            Err(last)
        }
    }

    #[cfg(target_os = "windows")]
    fn install_python(app: &AppHandle) -> Result<(String, Vec<String>), String> {
        emit(app, "python", &format!("Installing Python {PYTHON_VERSION} for this user…"));
        let mut winget = quiet_command("winget");
        winget.args([
            "install", "--id", "Python.Python.3.12", "-e", "--scope", "user", "--silent",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
        ]);
        let winget_result = run_streamed(app, "python", winget);
        if let Some(found) = supported_python() {
            return Ok(found);
        }
        // No winget (older Windows, LTSC) or it failed: the official installer, per user, no admin.
        emit(app, "python", &format!(
            "winget unavailable ({}); downloading the installer from python.org…",
            winget_result.err().unwrap_or_else(|| "no Python found after install".into())
        ));
        let installer = std::env::temp_dir().join(format!("setsuna-python-{PYTHON_VERSION}-amd64.exe"));
        let url = format!("https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-amd64.exe");
        let mut curl = quiet_command("curl.exe");
        curl.args(["-L", "--fail", "--silent", "--show-error", "-o"]).arg(&installer).arg(&url);
        run_streamed(app, "python", curl).map_err(|e| format!("Could not download Python: {e}"))?;
        let mut setup = quiet_command(&installer.to_string_lossy());
        setup.args(["/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_launcher=0", "Include_test=0", "Shortcuts=0"]);
        let result = run_streamed(app, "python", setup);
        let _ = std::fs::remove_file(&installer);
        result.map_err(|e| format!("Python installer failed: {e}"))?;
        supported_python().ok_or_else(|| "Python was installed but could not be started.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    fn install_python(_app: &AppHandle) -> Result<(String, Vec<String>), String> {
        Err("Install Python 3.10–3.12 with your package manager, then run `pip install mokuro`.".into())
    }

    /// Highest compute capability of the NVIDIA GPUs, e.g. 12.0 for an RTX 5060.
    fn nvidia_compute_capability() -> Option<f32> {
        let out = quiet_command("nvidia-smi")
            .args(["--query-gpu=compute_cap", "--format=csv,noheader"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<f32>().ok())
            .reduce(f32::max)
    }

    pub fn torch_index_for(compute_capability: Option<f32>) -> Option<&'static str> {
        match compute_capability {
            Some(cc) if cc >= 7.5 => Some(TORCH_CUDA_INDEX_NEW),
            Some(cc) if cc >= 5.0 => Some(TORCH_CUDA_INDEX_OLD),
            _ => None,
        }
    }

    pub fn install_mokuro_blocking(app: &AppHandle) -> Result<(), String> {
        static INSTALL: Mutex<()> = Mutex::new(());
        let _busy = INSTALL.try_lock().map_err(|_| "Mokuro is already being installed.".to_string())?;

        emit(app, "python", "Looking for Python 3.10–3.12…");
        let (prog, prefix) = match supported_python() {
            Some(found) => found,
            None => install_python(app)?,
        };
        let pip = |args: &[&str]| {
            let mut cmd = quiet_command(&prog);
            cmd.args(&prefix).args(["-m", "pip"]).args(args);
            cmd
        };

        emit(app, "pip", "Updating pip…");
        // An old pip cannot resolve current torch wheels; failure here is not fatal.
        let _ = run_streamed(app, "pip", pip(&["install", "--upgrade", "pip"]));

        let has_torch = runs_ok(&prog, &prefix, "import importlib.metadata as m; print(m.version('torch'))").is_some();
        if let (false, Some(index)) = (has_torch, torch_index_for(nvidia_compute_capability())) {
            emit(app, "torch", "NVIDIA GPU found: installing PyTorch with CUDA (about 3 GB)…");
            run_streamed(app, "torch", pip(&["install", "torch", "torchvision", "--index-url", index]))
                .map_err(|e| format!("PyTorch install failed: {e}"))?;
        }

        emit(app, "mokuro", "Installing mokuro and its OCR models…");
        run_streamed(app, "mokuro", pip(&["install", "--upgrade", "mokuro"]))
            .map_err(|e| format!("mokuro install failed: {e}"))?;
        emit(app, "done", "Mokuro is ready.");
        Ok(())
    }

    #[tauri::command]
    pub async fn manga_install_mokuro(app: AppHandle) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || install_mokuro_blocking(&app))
            .await
            .map_err(|e| format!("Mokuro installer failed: {e}"))?
    }
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    #[test]
    fn torch_wheels_match_the_gpu_generation() {
        assert_eq!(torch_index_for(Some(12.0)), Some("https://download.pytorch.org/whl/cu128"));
        assert_eq!(torch_index_for(Some(7.5)), Some("https://download.pytorch.org/whl/cu128"));
        assert_eq!(torch_index_for(Some(6.1)), Some("https://download.pytorch.org/whl/cu126"));
        assert_eq!(torch_index_for(Some(3.5)), None);
        assert_eq!(torch_index_for(None), None);
    }

    #[test]
    fn supported_interpreters_come_first() {
        let candidates = python_candidates();
        assert_eq!(candidates[0], ("py".to_string(), vec!["-3.12".to_string()]));
        assert_eq!(candidates.last().map(|c| c.0.as_str()), Some("py"));
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn manga_install_mokuro() -> Result<(), String> {
    Err("Mokuro runs on the PC version of Setsuna.".into())
}
