param(
    [string]$LogPath = "$env:APPDATA\com.serichka.setsuna\setsuna-diagnostics.log",
    [int]$Last = 1
)

if (!(Test-Path -LiteralPath $LogPath)) {
    Write-Host "Diagnostics log not found: $LogPath"
    exit 1
}

$snapshots = Get-Content -LiteralPath $LogPath -Tail 500 |
    ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } |
    Where-Object { $_ -and $_.kind -eq "snapshot" }

$selected = $snapshots | Select-Object -Last $Last

foreach ($snapshot in $selected) {
    $date = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$snapshot.ts).LocalDateTime
    Write-Host ""
    Write-Host "Setsuna diagnostics: $date"
    Write-Host "Dictionary: $($snapshot.dictionaryEntries) entries"
    Write-Host "DB path: $($snapshot.dictionaryPath)"

    $processes = @($snapshot.processes) | Sort-Object -Property memoryRaw -Descending
    $totalMb = ($processes | Measure-Object -Property memoryRaw -Sum).Sum / 1MB
    Write-Host ("Process total: {0:N1} MB" -f $totalMb)

    $processes | ForEach-Object {
        Write-Host ("  {0,9} {1,-20} pid={2,-7} {3,8:N1} MB" -f $_.role, $_.name, $_.pid, ($_.memoryRaw / 1MB))
    }

    if ($snapshot.frontend) {
        $f = $snapshot.frontend
        Write-Host "Frontend:"
        Write-Host ("  tabs={0}, active='{1}', mode={2}, lines={3}/{4}, chars={5}" -f $f.tabs, $f.activeTabName, $f.activeTabMode, $f.activeTabLines, $f.totalLines, $f.totalChars)
        Write-Host ("  lookupStack={0}, browserTabs={1}, helperSpace={2}" -f $f.lookupStack, $f.browserTabs, $f.helperSpaceReserved)
        Write-Host ("  localStorage tabs={0} chars, settings={1}, browserTabs={2}, furigana={3}" -f $f.localStorage.tabs, $f.localStorage.settings, $f.localStorage.browserTabs, $f.localStorage.furigana)
        if ($f.jsHeap) {
            Write-Host ("  JS heap used={0:N1} MB total={1:N1} MB limit={2:N1} MB" -f ($f.jsHeap.used / 1MB), ($f.jsHeap.total / 1MB), ($f.jsHeap.limit / 1MB))
        }
    } else {
        Write-Host "Frontend: no frontend sample yet"
    }
}
