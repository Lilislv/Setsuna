# Release And Updates

Setsuna uses the Tauri v2 updater. Release builds attach `latest.json` and signed NSIS artifacts to the newest GitHub release.

## One-Time Setup

1. Add the updater private key to GitHub repository secrets as `TAURI_SIGNING_PRIVATE_KEY`.
2. If the private key has a password, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep `.tauri/setsuna-updater.key` local only. It is ignored by git.

## Publishing A Release

1. Set the user-facing name in `src/release-info.json` as `displayVersion`. It can use any naming scheme.
2. Increase `buildNumber` by exactly one. This is the only value used to order updates.
3. Set `src-tauri/tauri.conf.json` version to `0.0.<buildNumber>`; for build 2 use `0.0.2`.
4. Commit the release changes.
5. Push any desired release tag, for example `v0.1.0`. The tag name is not used for update ordering.
6. Wait for the `Release` workflow to finish.
7. Open the draft GitHub release, edit notes, and publish it.

The app checks:

```text
https://github.com/Lilislv/Setsuna/releases/latest/download/latest.json
```

## Local Signed Build

For local release verification:

```powershell
$env:CI="true"
$env:TAURI_SIGNING_PRIVATE_KEY=Get-Content "C:\pr\txthk\.tauri\setsuna-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run desktop:release
```
