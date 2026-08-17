Put the ffmpeg binary here to bundle it with Setsuna installers.

Expected file:

- src-tauri/bin/ffmpeg.exe on Windows
- src-tauri/bin/ffmpeg on Linux (must be executable)

Setsuna also checks these locations at runtime:

- the application directory
- the application bin directory
- Tauri resource directory/bin
- portable data/bin
- PATH

FFmpeg builds have their own license terms. Pick LGPL/GPL builds intentionally
depending on how the app will be distributed.
