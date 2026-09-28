# Release And Updates

Setsuna uses the Tauri v2 updater. Release builds attach `latest.json` and signed NSIS artifacts to the newest GitHub release.

## One-Time Setup

1. Add the updater private key to GitHub repository secrets as `TAURI_SIGNING_PRIVATE_KEY`.
2. If the private key has a password, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep `.tauri/setsuna-updater.key` local only. It is ignored by git.

## Publishing A Release

1. Choose a semantic version greater than the latest published version, for example `0.2.0`.
2. Set this same version in `src/release-info.json` (`displayVersion`), `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Run `node scripts/verify-release.mjs`.
3. Increase `buildNumber` by one for release diagnostics. Since 0.2.0, updater ordering uses the actual semantic version. Existing 0.0.4 installations can update to 0.2.0.
4. Commit the release changes.
5. Push the matching release tag, for example `v0.2.0`. CI checks the tag and version metadata agree.
6. Wait for the `Release` workflow to finish.
7. Open the draft GitHub release, edit notes, and publish it.

The app checks:

```text
https://github.com/Lilislv/Setsuna/releases/latest/download/latest.json
```

## Local Signed Build

Ordinary local previews use `npm run desktop:local`. They keep the release version
and canonical installer filename, with a Local label in the application. Private
preview features are opt-in and disabled in the public release workflow. Do not
publish artifacts produced by `desktop:local`.

For local release verification:

```powershell
$env:CI="true"
$env:TAURI_SIGNING_PRIVATE_KEY=Get-Content "C:\pr\txthk\.tauri\setsuna-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run desktop:release
```
