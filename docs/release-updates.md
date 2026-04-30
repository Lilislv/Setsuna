# Release And Updates

Setsuna uses the Tauri v2 updater. Release builds attach `latest.json` and signed NSIS artifacts to the newest GitHub release.

## One-Time Setup

1. Add the updater private key to GitHub repository secrets as `TAURI_SIGNING_PRIVATE_KEY`.
2. If the private key has a password, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep `.tauri/setsuna-updater.key` local only. It is ignored by git.

## Publishing A Release

1. Update versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit the release changes.
3. Push a tag like `v0.5.0`.
4. Wait for the `Release` workflow to finish.
5. Open the draft GitHub release, edit notes, and publish it.

The app checks:

```text
https://github.com/Lilislv/Setsuna/releases/latest/download/latest.json
```

## Local Signed Build

For local release verification:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="C:\pr\txthk\.tauri\setsuna-updater.key"
npm run tauri -- build --debug
```
