$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$port = 1420
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

if ($listeners.Count -gt 0) {
    $processes = @(
        $listeners |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_)" }
    )

    $sameWorkspaceVite = $processes | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match '(?i)(vite|vite\.js)' -and
        $_.CommandLine.IndexOf($workspace, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }

    if ($sameWorkspaceVite) {
        Write-Host "Reusing the existing Setsuna Vite server on http://127.0.0.1:$port/"
        exit 0
    }

    $owners = ($processes | ForEach-Object { "$($_.Name) PID $($_.ProcessId)" }) -join ', '
    throw "Port $port is already used by $owners. Close that application or choose another port."
}

& npm.cmd run dev
exit $LASTEXITCODE
