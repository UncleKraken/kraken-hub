# Kraken Hub — update the server to the latest version.
# Double-click scripts\update.bat. It pulls the newest code, rebuilds, and restarts the host.
# Your data (members, money, settings) lives in ProgramData and is never touched by this.

$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    return
}

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "Updating Kraken Hub in $repo" -ForegroundColor Cyan

if (Test-Path (Join-Path $repo '.git')) {
    cmd /c 'git pull' ; if ($LASTEXITCODE -ne 0) { Write-Host 'git pull failed — check your internet, then try again.' -ForegroundColor Red; Read-Host 'Press Enter'; return }
} else {
    Write-Host 'This copy was not installed with Git.' -ForegroundColor Yellow
    Write-Host 'Download the latest ZIP from GitHub, unzip it over this folder, then run setup.bat instead.'
    Read-Host 'Press Enter to close'; return
}

Write-Host 'Installing + building...'
cmd /c 'npm install' ; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
cmd /c 'npm run build' ; if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Stop-ScheduledTask -TaskName 'KrakenHub Server' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'KrakenHub Server' -ErrorAction SilentlyContinue
Write-Host 'Updated and restarted. ' -ForegroundColor Green
Read-Host 'Press Enter to close'
