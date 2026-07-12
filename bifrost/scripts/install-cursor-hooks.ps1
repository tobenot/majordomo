# install-cursor-hooks.ps1 - write ~/.cursor/hooks.json for Bifrost
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File <this> [-StatusLine] [-Uninstall]
# Resolves report.ps1 from this script's location so each machine gets its own absolute path.
# ASCII-only source for Windows PowerShell 5.1.

param(
    [switch]$StatusLine,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$bifrostRoot = Split-Path -Parent $PSScriptRoot
$reportPs1 = Join-Path $PSScriptRoot 'report.ps1'
$statusPs1 = Join-Path $PSScriptRoot 'bifrost-statusline.ps1'

if (-not (Test-Path -LiteralPath $reportPs1)) {
    Write-Error "report.ps1 not found next to installer: $reportPs1"
}

$cursorDir = Join-Path $env:USERPROFILE '.cursor'
$hooksFile = Join-Path $cursorDir 'hooks.json'
if (-not (Test-Path -LiteralPath $cursorDir)) {
    New-Item -ItemType Directory -Path $cursorDir -Force | Out-Null
}

# Normalize to forward slashes inside JSON strings (works on Windows PS).
$reportUri = ($reportPs1 -replace '\\', '/')
$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$reportUri`""

$bifrostEvents = @(
    'sessionStart',
    'sessionEnd',
    'afterAgentResponse',
    'stop',
    'beforeSubmitPrompt',
    'preToolUse'
)

function Test-IsBifrostCommand {
    param([string]$c)
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    return ($c -match 'bifrost[\\/]+scripts[\\/]+report\.ps1')
}

function Read-HooksObject {
    if (-not (Test-Path -LiteralPath $hooksFile)) { return $null }
    $raw = Get-Content -LiteralPath $hooksFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}

function Backup-Hooks {
    if (-not (Test-Path -LiteralPath $hooksFile)) { return }
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $bak = "$hooksFile.bak-$stamp"
    Copy-Item -LiteralPath $hooksFile -Destination $bak -Force
    Write-Host "Backup: $bak"
}

function Write-HooksFile {
    param([object]$obj)
    $json = $obj | ConvertTo-Json -Depth 10
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($hooksFile, $json, $utf8)
}

# --- Uninstall: strip bifrost report hooks only ---
if ($Uninstall) {
    Backup-Hooks
    $existing = Read-HooksObject
    if ($null -eq $existing) {
        Write-Host "No hooks.json; nothing to uninstall."
        exit 0
    }
    $hooks = @{}
    if ($existing.hooks) {
        foreach ($p in $existing.hooks.PSObject.Properties) {
            $kept = @()
            foreach ($h in @($p.Value)) {
                $c = [string]$h.command
                if (-not (Test-IsBifrostCommand $c)) { $kept += $h }
            }
            if ($kept.Count -gt 0) { $hooks[$p.Name] = $kept }
        }
    }
    $out = [ordered]@{ version = 1; hooks = $hooks }
    if ($existing.version) { $out.version = $existing.version }
    Write-HooksFile $out
    Write-Host "Uninstalled bifrost hooks from $hooksFile"
    Write-Host "Open a new agent window for changes to apply."
    exit 0
}

# --- Install / refresh ---
Backup-Hooks
$existing = Read-HooksObject

$hooks = @{}
# Keep non-bifrost entries from existing file
if ($existing -and $existing.hooks) {
    foreach ($p in $existing.hooks.PSObject.Properties) {
        $kept = @()
        foreach ($h in @($p.Value)) {
            $c = [string]$h.command
            if (-not (Test-IsBifrostCommand $c)) { $kept += $h }
        }
        if ($kept.Count -gt 0) { $hooks[$p.Name] = @($kept) }
    }
}

foreach ($ev in $bifrostEvents) {
    $entry = @{ command = $cmd }
    if ($ev -eq 'preToolUse') { $entry.matcher = 'AskUserQuestion' }
    $list = @()
    if ($hooks.ContainsKey($ev)) { $list = @($hooks[$ev]) }
    $list += $entry
    $hooks[$ev] = $list
}

$version = 1
if ($existing -and $existing.version) { $version = $existing.version }
Write-HooksFile ([ordered]@{ version = $version; hooks = $hooks })
Write-Host "Wrote $hooksFile"
Write-Host "report.ps1 -> $reportPs1"

if ($StatusLine) {
    $cliFile = Join-Path $cursorDir 'cli-config.json'
    $statusUri = ($statusPs1 -replace '\\', '/')
    $statusCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$statusUri`""
    $cli = $null
    if (Test-Path -LiteralPath $cliFile) {
        try {
            $cliRaw = Get-Content -LiteralPath $cliFile -Raw -Encoding UTF8
            # strip // comments for ConvertFrom-Json if present
            $cliRaw = [regex]::Replace($cliRaw, '(?m)^\s*//.*$', '')
            $cli = $cliRaw | ConvertFrom-Json
        } catch {
            Write-Warning "Could not parse $cliFile; skipping statusLine."
        }
    }
    if ($null -eq $cli) {
        $cliObj = [ordered]@{
            statusLine = [ordered]@{ type = 'command'; command = $statusCmd }
        }
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($cliFile, ($cliObj | ConvertTo-Json -Depth 6), $utf8)
        Write-Host "Wrote statusLine to $cliFile"
    } else {
        $cli | Add-Member -NotePropertyName statusLine -NotePropertyValue ([pscustomobject]@{ type = 'command'; command = $statusCmd }) -Force
        if (Test-Path -LiteralPath $cliFile) {
            $stamp = Get-Date -Format 'yyyyMMddHHmmss'
            Copy-Item -LiteralPath $cliFile -Destination "$cliFile.bak-$stamp" -Force
        }
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($cliFile, ($cli | ConvertTo-Json -Depth 10), $utf8)
        Write-Host "Updated statusLine in $cliFile"
    }
}

Write-Host ""
Write-Host "Next: open a NEW Cursor agent window (agent --force). Do not rely on --plugin-dir."
Write-Host "Verify: bifrost/cache/status.json hue increments after a turn (do not ask the model)."
exit 0
