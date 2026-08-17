# Magic Context — Interactive Setup (Windows)
# Usage: irm https://raw.githubusercontent.com/cortexkit/magic-context/main/scripts/install.ps1 | iex

Write-Host ""
Write-Host "  ✨ Magic Context — Setup" -ForegroundColor Cyan
Write-Host "  ────────────────────────"
Write-Host ""

$package = "@cortexkit/magic-context"
# Always pin "@latest": without an explicit version, npx resolves from its
# on-disk cache rather than re-resolving the npm dist-tag, so a user who
# already installed an older version would keep getting the cached bundle
# even after a patch ships. "@latest" forces a registry round-trip.
$packageLatest = "$package@latest"

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Host "  ✗ npx not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install Node.js (>= 20.12) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# @clack/prompts requires styleText from node:util, which landed in Node 20.12.
$nodeVer = (node -v 2>$null) -replace '^v',''
if (-not $nodeVer) {
    Write-Host "  ✗ Node.js not found on PATH." -ForegroundColor Red
    Write-Host "  Install Node.js (>= 20.12) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    exit 1
}
$parts = $nodeVer.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 12)) {
    Write-Host "  ✗ Node.js $nodeVer is too old (requires >= 20.12)" -ForegroundColor Red
    Write-Host "  Upgrade Node.js: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

Write-Host "  → Using npx (Node $nodeVer)" -ForegroundColor Gray
Write-Host ""
& npx -y $packageLatest setup
