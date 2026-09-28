$ErrorActionPreference = 'Stop'
# Local previews keep the public version number. The app adds a Local label.
$previousReader = $env:VITE_PRIVATE_READER
$previousJobs = $env:CARGO_BUILD_JOBS
try {
    $env:VITE_PRIVATE_READER = '1'
    $env:CARGO_BUILD_JOBS = '1'
    node scripts/verify-release.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Version verification failed' }
    npm run tauri -- build --features private-reader --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'Local build failed' }
} finally {
    $env:VITE_PRIVATE_READER = $previousReader
    $env:CARGO_BUILD_JOBS = $previousJobs
}
