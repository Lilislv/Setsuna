param(
    [string]$Serial = ""
)

$ErrorActionPreference = "Stop"

$sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$adb = if (Test-Path $sdkAdb) { $sdkAdb } else { (Get-Command adb -ErrorAction Stop).Source }
$packageName = "com.serichka.setsuna"
$activityName = "$packageName/.MainActivity"

if ([string]::IsNullOrWhiteSpace($Serial)) {
    $connected = @(
        & $adb devices |
            Select-Object -Skip 1 |
            Where-Object { $_ -match '^([^\s]+)\s+device$' } |
            ForEach-Object { $Matches[1] }
    )
    if ($connected.Count -ne 1) {
        throw "Connect exactly one Android device or pass -Serial. Found: $($connected -join ', ')"
    }
    $Serial = $connected[0]
}

$adbArgs = if ([string]::IsNullOrWhiteSpace($Serial)) { @() } else { @("-s", $Serial) }

function Invoke-Adb {
    param([string[]]$Arguments)
    & $adb @adbArgs @Arguments
}

$state = (Invoke-Adb -Arguments @("get-state")).Trim()
if ($state -ne "device") {
    throw "Android device '$Serial' is not ready (state: $state)."
}

$packagePath = (Invoke-Adb -Arguments @("shell", "pm", "path", $packageName)).Trim()
if ([string]::IsNullOrWhiteSpace($packagePath)) {
    throw "Setsuna is not installed on '$Serial'. Build/install it before the smoke test."
}

Invoke-Adb -Arguments @("logcat", "-c") | Out-Null
Invoke-Adb -Arguments @("shell", "am", "force-stop", $packageName) | Out-Null
$launch = Invoke-Adb -Arguments @("shell", "am", "start", "-W", "-n", $activityName)
Start-Sleep -Milliseconds 1000
$processId = (Invoke-Adb -Arguments @("shell", "pidof", $packageName)).Trim()
$log = Invoke-Adb -Arguments @("logcat", "-d", "-t", "250")
$fatal = $log | Select-String -Pattern "FATAL EXCEPTION|AndroidRuntime.*$packageName" -CaseSensitive:$false

if ([string]::IsNullOrWhiteSpace($processId)) {
    throw "Setsuna did not remain running after launch."
}

if ($fatal) {
    throw "Setsuna started with an Android runtime error:`n$($fatal -join [Environment]::NewLine)"
}

[pscustomobject]@{
    Device = $Serial
    Package = $packageName
    Pid = $processId
    Launch = ($launch -join [Environment]::NewLine)
    Result = "Smoke passed"
}
