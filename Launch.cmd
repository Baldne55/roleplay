@echo off
REM Launch the FXServer with our committed server.cfg.
REM CWD must be the FXServer install dir for resource discovery.

set "REPO=%~dp0"
set "REPO=%REPO:~0,-1%"
set "FXROOT=%REPO%\Production\Windows"
set "EXE=%FXROOT%\FXServer.exe"
set "CFG=%REPO%\server.cfg"

if not exist "%EXE%" (
  echo FXServer not found at %EXE%.
  echo Extract the Windows artifact into Production\Windows\ first.
  exit /b 1
)
if not exist "%CFG%" (
  echo server.cfg not found at %CFG%.
  echo Copy server.cfg.example to server.cfg and fill in REPLACE_WITH_* values.
  exit /b 1
)

cd /d "%FXROOT%"
"%EXE%" +exec "%CFG%"
