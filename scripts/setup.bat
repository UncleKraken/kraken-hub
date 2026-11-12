@echo off
REM Kraken Hub - double-click to install and start the server on this laptop.
REM Pass "seed" to also load demo data:  setup.bat seed
set SEEDARG=
if /I "%~1"=="seed" set SEEDARG=-Seed
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %SEEDARG%
