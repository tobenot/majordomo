# bifrost-statusline.ps1 - statusline for Claude Code / Cursor CLI
# Replaces the built-in line entirely (hosts only run ONE statusLine command),
# so we redraw: model  ctx N% · 200k  [BIFROST]
# Also sets the terminal / console title from session_name (fallback: cwd leaf).
#
# Stdin: host JSON (model.*, context_window.*, session_name, cwd, ...).
# Bifrost badge: cache/status.json from report.ps1; hidden when hub unreachable.
#
# Color cycle for badge (7 hues): orange gold green cyan blue purple rose
# ASCII-only source for Windows PowerShell 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$Esc = [char]27

function Format-TokenCap {
    param([double]$n)
    if ($n -le 0) { return '' }
    if ($n -ge 1000000) {
        $m = [math]::Round($n / 1000000.0, 1)
        if ($m -eq [math]::Floor($m)) { return ("{0}M" -f [int]$m) }
        return ("{0}M" -f $m)
    }
    if ($n -ge 1000) {
        return ("{0}k" -f [int][math]::Round($n / 1000.0))
    }
    return ("{0}" -f [int]$n)
}

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
$param = ''
$pct = $null
$cap = ''
$sessionName = ''
$cwdLeaf = ''
try {
    if ($payload) {
        $model = [string]$payload.model.display_name
        if ([string]::IsNullOrWhiteSpace($model)) { $model = [string]$payload.model.id }
        $param = [string]$payload.model.param_summary
        if ($null -ne $payload.context_window) {
            if ($null -ne $payload.context_window.used_percentage) {
                $pct = [int][math]::Floor([double]$payload.context_window.used_percentage)
            }
            if ($null -ne $payload.context_window.context_window_size) {
                $cap = Format-TokenCap ([double]$payload.context_window.context_window_size)
            }
        }
        $sessionName = [string]$payload.session_name
        $cwd = [string]$payload.cwd
        if ([string]::IsNullOrWhiteSpace($cwd) -and $payload.workspace) {
            $cwd = [string]$payload.workspace.current_dir
        }
        if (-not [string]::IsNullOrWhiteSpace($cwd)) {
            $cwdLeaf = Split-Path -Leaf $cwd.TrimEnd('\', '/')
        }
    }
} catch { }

if ([string]::IsNullOrWhiteSpace($model)) { $model = 'model?' }

# --- terminal / console title (session name, else cwd leaf, else short id) ---
$title = $sessionName
if ([string]::IsNullOrWhiteSpace($title)) { $title = $cwdLeaf }
if ([string]::IsNullOrWhiteSpace($title) -and $payload -and $payload.session_id) {
    $sid = [string]$payload.session_id
    if ($sid.Length -gt 8) { $title = $sid.Substring(0, 8) } else { $title = $sid }
}
if (-not [string]::IsNullOrWhiteSpace($title)) {
    try { [Console]::Title = $title } catch { }
    # OSC 0: some terminals honor this even when Console.Title is a no-op
    try { [Console]::Write("${Esc}]0;$title$([char]7)") } catch { }
}

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

# --- compose: model  ctx N% · 200k  [BIFROST] ---
# Skip param_summary when display_name already contains it (Cursor often bakes
# "High Fast" into both fields -> "High Fast High Fast").
$parts = New-Object System.Collections.Generic.List[string]
$left = $model
if (-not [string]::IsNullOrWhiteSpace($param)) {
    $paramBare = $param.Trim().Trim('()')
    if ($paramBare.Length -gt 0 -and $model.IndexOf($paramBare, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $left = "$model $param"
    }
}
$parts.Add("${Esc}[90m$left${Esc}[0m")

if ($null -ne $pct) {
    $pc = 71
    if ($pct -ge 80) { $pc = 167 } elseif ($pct -ge 50) { $pc = 178 }
    $ctx = "ctx ${pct}%"
    if ($cap) { $ctx += " · $cap" }
    $parts.Add("${Esc}[38;5;${pc}m$ctx${Esc}[0m")
} elseif ($cap) {
    $parts.Add("${Esc}[90m$cap${Esc}[0m")
}

if ($badge) { $parts.Add($badge) }

# --- usage cache for hub (report.ps1 picks up on next hook) ---
# ponytail: statusline must not POST; file drop keeps hook path one-shot.
try {
    $sid = ''
    if ($payload) { $sid = [string]$payload.session_id }
    if (-not [string]::IsNullOrWhiteSpace($sid)) {
        $safe = ($sid -replace '[\\/:*?"<>|]', '_')
        $usageDir = Join-Path $root 'cache'
        if (-not (Test-Path $usageDir)) { New-Item -ItemType Directory -Path $usageDir -Force | Out-Null }
        $usageObj = [ordered]@{ updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        if ($null -ne $pct) { $usageObj.usedPercent = $pct }
        if ($payload -and $null -ne $payload.context_window -and $null -ne $payload.context_window.context_window_size) {
            $usageObj.windowSize = [int64]$payload.context_window.context_window_size
        }
        if ($payload -and $null -ne $payload.context_window) {
            $cw = $payload.context_window
            if ($null -ne $cw.total_input_tokens) { $usageObj.totalInputTokens = [int64]$cw.total_input_tokens }
            if ($null -ne $cw.total_output_tokens) { $usageObj.totalOutputTokens = [int64]$cw.total_output_tokens }
            $cu = $cw.current_usage
            if ($null -ne $cu) {
                if ($null -ne $cu.input_tokens) { $usageObj.lastInputTokens = [int64]$cu.input_tokens }
                if ($null -ne $cu.output_tokens) { $usageObj.lastOutputTokens = [int64]$cu.output_tokens }
                if ($null -ne $cu.cache_read_input_tokens) { $usageObj.lastCacheReadTokens = [int64]$cu.cache_read_input_tokens }
            }
        }
        ($usageObj | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $usageDir "usage-$safe.json") -Encoding UTF8 -NoNewline
    }
} catch { }

[Console]::Write(($parts -join '  '))
exit 0
