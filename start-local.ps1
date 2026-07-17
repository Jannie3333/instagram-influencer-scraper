if (-not $env:PLAYWRIGHT_BROWSERS_PATH) {
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PSScriptRoot "pw-browsers"
}
Set-Location $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source server.js
  exit $LASTEXITCODE
}

$codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path $codexNode) {
  & $codexNode server.js
  exit $LASTEXITCODE
}

Write-Error "Node.js was not found. Install Node.js 18+ or run this from a Codex environment."
exit 1
