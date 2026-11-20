$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw '未检测到 Node.js (>= 22.13)，请先安装 Node.js。'
}
& $nodeCmd.Source (Join-Path $scriptDir 'scripts\install.mjs') @args
exit $LASTEXITCODE
