@echo off
REM Launch the FXServer against the local server.cfg.
REM
REM server.cfg is deliberately NOT committed - it is in .gitignore because
REM it carries the Discord bot token and the database password. Only
REM server.cfg.example is tracked; copy it and fill in the REPLACE_WITH_*
REM values. Never commit the filled-in copy.
REM
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
