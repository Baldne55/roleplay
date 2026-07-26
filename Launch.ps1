# Launch the FXServer against the local server.cfg.
#
# server.cfg is deliberately NOT committed - it is in .gitignore because it
# carries the Discord bot token and the database password. Only
# server.cfg.example is tracked; copy it and fill in the REPLACE_WITH_*
# values. Never commit the filled-in copy.
#
# CWD must be the FXServer install dir for resource discovery (resources/[local]/roleplay).
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$FxRoot = Join-Path $Repo 'Production\Windows'
$Exe = Join-Path $FxRoot 'FXServer.exe'
$Cfg = Join-Path $Repo 'server.cfg'

if (-not (Test-Path $Exe)) {
  throw "FXServer not found at $Exe. Did you extract the Windows artifact into Production/Windows/?"
}
if (-not (Test-Path $Cfg)) {
  throw "server.cfg not found at $Cfg. Copy server.cfg.example to server.cfg and fill in REPLACE_WITH_* values."
}

Set-Location $FxRoot
& $Exe +exec "$Cfg"
