$ErrorActionPreference = "Stop"

$sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$adb = if (Test-Path $sdkAdb) { $sdkAdb } else { (Get-Command adb -ErrorAction Stop).Source }

& $adb reverse tcp:1420 tcp:1420 | Out-Null
& $adb reverse tcp:1421 tcp:1421 | Out-Null

$hostIp = "127.0.0.1"
Write-Host "Using USB adb reverse dev host: $hostIp"
Write-Host "Forwarded phone tcp:1420 -> PC tcp:1420"

$env:TAURI_DEV_HOST = $hostIp
npm run tauri -- android dev --host $hostIp
