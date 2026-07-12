# bifrost-statusline.ps1 - statusline badge for Claude Code / Cursor CLI
# Reads cache/status.json written by report.ps1, outputs a rainbow-cycling [BIFROST].
# No output when hub is unreachable or status file missing (first turn not yet done).
#
# Color cycle (7 hues, readable on both dark & light terminal themes):
#   0=orange 1=gold 2=green 3=cyan 4=blue 5=purple 6=rose -> repeat

$root = $env:CURSOR_PLUGIN_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:CLAUDE_PLUGIN_ROOT }
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $PSScriptRoot }

$statusFile = Join-Path (Join-Path $root 'cache') 'status.json'
if (-not (Test-Path $statusFile)) { exit 0 }

$s = $null
try {
    $s = Get-Content -Path $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch { exit 0 }

if ($null -eq $s -or -not $s.reachable) { exit 0 }

$hue = [int]$s.hue % 7
$colors = @(166, 178, 71, 37, 33, 97, 168)  # orange→gold→green→cyan→blue→purple→rose
$Esc = [char]27
[Console]::Write("${Esc}[38;5;$($colors[$hue])m[BIFROST]${Esc}[0m")
