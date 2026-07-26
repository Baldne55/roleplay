@echo off
REM Recreate the resource folder + fxmanifest.lua after a fresh FXServer
REM extraction. The Production\ tree is gitignored (it carries per-machine
REM binaries) so anything inside it - including resources\[local]\roleplay\ -
REM gets wiped whenever a new artifact is extracted. Run this script once
REM after each artifact swap to restore the resource scaffolding.

setlocal

set "REPO=%~dp0"
set "REPO=%REPO:~0,-1%"
set "FXROOT=%REPO%\Production\Windows"
set "EXE=%FXROOT%\FXServer.exe"
set "RESDIR=%FXROOT%\resources\[local]\roleplay"
set "MANIFEST=%RESDIR%\fxmanifest.lua"

if not exist "%EXE%" (
  echo FXServer not found at %EXE%.
  echo Extract the Windows artifact into Production\Windows\ first.
  exit /b 1
)

if not exist "%RESDIR%" (
  echo Creating resource directory: %RESDIR%
  mkdir "%RESDIR%" 2>nul
  if errorlevel 1 (
    echo Failed to create resource directory.
    exit /b 1
  )
)

echo Writing %MANIFEST%
(
  echo fx_version 'cerulean'
  echo game 'gta5'
  echo.
  echo author 'Roleplay'
  echo description 'Text-roleplay server ^(Backend + Frontend + UI, TypeScript-bundled^)'
  echo version '0.5.0'
  echo.
  echo server_scripts {
  echo   'Dist/Backend.js',
  echo }
  echo.
  echo client_scripts {
  echo   'Dist/Frontend.js',
  echo }
  echo.
  echo ui_page 'Dist/UI/index.html'
  echo.
  echo loadscreen 'Dist/LoadScreen/index.html'
  echo.
  echo files {
  echo   'Dist/UI/index.html',
  echo   'Dist/UI/Assets/**/*',
  echo   'Dist/LoadScreen/index.html',
  echo   'Dist/LoadScreen/Style.css',
  echo   'Dist/LoadScreen/Script.js',
  echo   'Dist/LoadScreen/Assets/**/*',
  echo }
  echo.
  echo dependencies {
  echo   '/onesync',
  echo }
) > "%MANIFEST%"

if errorlevel 1 (
  echo Failed to write fxmanifest.lua.
  exit /b 1
)

echo.
echo Bootstrap complete.
echo Next steps:
echo   1. Run "npm run build" from the repo root to populate Dist\.
echo   2. Run Launch.cmd to start the server.

endlocal
