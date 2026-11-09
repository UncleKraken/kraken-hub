# Kraken Hub — server runner.
# Started by the "KrakenHub Server" scheduled task at boot (and by setup.bat right after install).
# Keeps the host running: if it ever stops, this restarts it. The database lives OUTSIDE the app
# folder (in ProgramData) so updating or re-downloading the app never touches your data.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot          # ...\kraken-hub  (this script is in \scripts)
$dataDir = Join-Path $env:ProgramData 'KrakenHub\data'
$logDir  = Join-Path $env:ProgramData 'KrakenHub\logs'
New-Item -ItemType Directory -Force -Path $dataDir, $logDir | Out-Null

$env:KRAKEN_DATA_DIR = $dataDir
if (-not $env:PORT) { $env:PORT = '7300' }

# Find Node. Prefer PATH; fall back to the standard install location (so it works when the task
# runs as SYSTEM before anyone logs in).
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
    "[{0}] Node.js not found. Run setup.bat first." -f (Get-Date) | Add-Content (Join-Path $logDir 'server.log')
    exit 1
}

$entry = Join-Path $repo 'host\dist\index.js'
if (-not (Test-Path $entry)) {
    "[{0}] Build missing ($entry). Run setup.bat first." -f (Get-Date) | Add-Content (Join-Path $logDir 'server.log')
    exit 1
}

# Run forever: a crash or power blip just comes back. (The app itself also recovers sessions after
# a power cut.) All output goes to a dated log you can send us if something looks wrong.
while ($true) {
    $log = Join-Path $logDir ("server-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
    "[{0}] starting host on port {1} (data: {2})" -f (Get-Date), $env:PORT, $dataDir | Add-Content $log
    try {
        & $node '--disable-warning=ExperimentalWarning' $entry 2>&1 | Add-Content $log
    } catch {
        "[{0}] host exited: {1}" -f (Get-Date), $_.Exception.Message | Add-Content $log
    }
    Start-Sleep -Seconds 3
}
