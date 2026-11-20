$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw '未检测到 Node.js，无法执行卸载脚本。'
}
& $nodeCmd.Source (Join-Path $scriptDir 'scripts\uninstall.mjs') @args
exit $LASTEXITCODE
