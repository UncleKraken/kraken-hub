# Kraken Hub - one-time server setup for Windows (the counter laptop).
# Run it by double-clicking scripts\setup.bat (which handles the admin prompt). It:
#   1. makes sure Node.js is installed,
#   2. installs and builds the app,
#   3. opens the firewall so the PCs can reach it,
#   4. sets it to start automatically at boot, and starts it now,
#   5. prints the address to open from a PC or tablet.
# Safe to run again any time - it just re-applies each step.

param([switch]$Seed)
$ErrorActionPreference = 'Stop'

# --- Re-launch as administrator if we aren't already (firewall + auto-start need it) ---
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'Asking for administrator rights...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Seed) { $argList += '-Seed' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    return
}

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "Kraken Hub setup - app folder: $repo" -ForegroundColor Cyan

# --- 1. Node.js ---
function Get-NodeMajor {
    $n = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $n -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $n = 'C:\Program Files\nodejs\node.exe' }
    if (-not $n) { return 0 }
    try { return [int]((& $n -v) -replace 'v(\d+).*', '$1') } catch { return 0 }
}
if ((Get-NodeMajor) -lt 22) {
    Write-Host 'Node.js 22+ not found - installing it...' -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    } else {
        Write-Host 'Could not install automatically (winget is missing on this Windows).' -ForegroundColor Red
        Write-Host 'Please install Node.js 22 LTS from https://nodejs.org, then run this again.'
        Read-Host 'Press Enter to close'; return
    }
    if ((Get-NodeMajor) -lt 22) {
        Write-Host 'Node.js still not detected. Close this window, reopen setup.bat, and try again.' -ForegroundColor Red
        Read-Host 'Press Enter to close'; return
    }
}
Write-Host ("Node.js OK (v{0})" -f (Get-NodeMajor)) -ForegroundColor Green

# --- 2. Install + build ---
Write-Host 'Installing dependencies (first time can take a few minutes)...'
cmd /c 'npm install' ; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
Write-Host 'Building...'
cmd /c 'npm run build' ; if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# Keep data outside the app folder so updates never touch it.
$dataDir = Join-Path $env:ProgramData 'KrakenHub\data'
New-Item -ItemType Directory -Force -Path $dataDir, (Join-Path $env:ProgramData 'KrakenHub\logs') | Out-Null

if ($Seed) {
    Write-Host 'Loading demo data...' -ForegroundColor Yellow
    $env:KRAKEN_DATA_DIR = $dataDir
    cmd /c 'npm run seed'
}

# --- 3. Firewall: let PCs on the local network reach the host ---
foreach ($r in @(
    @{ Name = 'Kraken Hub (web 7300/TCP)';       Proto = 'TCP'; Port = 7300 },
    @{ Name = 'Kraken Hub (discovery 7301/UDP)'; Proto = 'UDP'; Port = 7301 }
)) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol $r.Proto -LocalPort $r.Port -Profile Any | Out-Null
}
Write-Host 'Firewall opened for ports 7300 (web) and 7301 (PC discovery).' -ForegroundColor Green

# --- 4. Start automatically at every boot, as SYSTEM (no login needed) ---
$taskName = 'KrakenHub Server'
$runner = Join-Path $PSScriptRoot 'start-server.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host 'Set to start automatically at boot.' -ForegroundColor Green

# Start it now (stop a previous run first so we don't double-bind the port).
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName

# --- 5. Show the address to use from a PC or tablet ---
Start-Sleep -Seconds 3
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host ' Kraken Hub is running.' -ForegroundColor Cyan
Write-Host '  On this laptop:     http://localhost:7300'
foreach ($ip in $ips) { Write-Host ("  From a PC / tablet: http://{0}:7300" -f $ip) }
Write-Host '  Demo logins (if you loaded demo data): admin / admin123, operator / 1234'
Write-Host '========================================================' -ForegroundColor Cyan
Read-Host 'Press Enter to close'
