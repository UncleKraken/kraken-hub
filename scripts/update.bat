@echo off
REM Kraken Hub - double-click to update the server to the latest version.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-windows.ps1"
