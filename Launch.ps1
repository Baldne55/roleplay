# Launch the FXServer with our committed server.cfg.
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
