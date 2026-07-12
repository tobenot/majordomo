# bifrost-statusline.ps1 - statusline for Claude Code / Cursor CLI
# Replaces the built-in line entirely (hosts only run ONE statusLine command),
# so we redraw the useful bits ourselves: model + context % + optional [BIFROST].
#
# Stdin: host JSON (model.display_name, context_window.used_percentage, ...).
# Bifrost badge: cache/status.json from report.ps1; hidden when hub unreachable.
#
# Color cycle for badge (7 hues): orange gold green cyan blue purple rose
# ASCII-only source for Windows PowerShell 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$Esc = [char]27

# --- read host payload (UTF-8 bytes; same pitfall as report.ps1) ---
$payload = $null
try {
    $stdin = [Console]::OpenStandardInput()
    $buf = New-Object byte[] 8192
    $ms = New-Object System.IO.MemoryStream
    while (($n = $stdin.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
    $bytes = $ms.ToArray()
    if ($bytes -and $bytes.Length -gt 0) {
        $raw = (New-Object System.Text.UTF8Encoding $false, $false).GetString($bytes)
        if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
        $brace = $raw.IndexOf('{')
        if ($brace -gt 0) { $raw = $raw.Substring($brace) }
        if (-not [string]::IsNullOrWhiteSpace($raw)) { $payload = $raw | ConvertFrom-Json }
    }
} catch { }

$model = ''
$pct = $null
$param = ''
try {
    if ($payload) {
        $model = [string]$payload.model.display_name
        if ([string]::IsNullOrWhiteSpace($model)) { $model = [string]$payload.model.id }
        $param = [string]$payload.model.param_summary
        if ($null -ne $payload.context_window -and $null -ne $payload.context_window.used_percentage) {
            $pct = [int][math]::Floor([double]$payload.context_window.used_percentage)
        }
    }
} catch { }

if ([string]::IsNullOrWhiteSpace($model)) { $model = 'model?' }

# --- bifrost badge from cache ---
$root = $env:CURSOR_PLUGIN_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = $env:CLAUDE_PLUGIN_ROOT }
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $PSScriptRoot }

$badge = ''
try {
    $statusFile = Join-Path (Join-Path $root 'cache') 'status.json'
    if (Test-Path $statusFile) {
        $s = Get-Content -Path $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($s -and $s.reachable) {
            $hue = [int]$s.hue % 7
            $colors = @(166, 178, 71, 37, 33, 97, 168)
            $badge = "${Esc}[38;5;$($colors[$hue])m[BIFROST]${Esc}[0m"
        }
    }
} catch { }

# --- compose: model [param]  ctx N%  [BIFROST] ---
$parts = New-Object System.Collections.Generic.List[string]
$left = "${Esc}[90m$model"
if (-not [string]::IsNullOrWhiteSpace($param)) { $left += " $param" }
$left += "${Esc}[0m"
$parts.Add($left)

if ($null -ne $pct) {
    # green <50, yellow <80, red otherwise
    $pc = 71
    if ($pct -ge 80) { $pc = 167 } elseif ($pct -ge 50) { $pc = 178 }
    $parts.Add("${Esc}[38;5;${pc}mctx ${pct}%${Esc}[0m")
}

if ($badge) { $parts.Add($badge) }

[Console]::Write(($parts -join '  '))
exit 0
