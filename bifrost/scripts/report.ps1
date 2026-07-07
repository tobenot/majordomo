# report.ps1 - Bifrost formal reporter (design bifrost-hub-v1.md 2.3 / path B)
# One script owns everything a single hook event needs:
#   1. read hook JSON from stdin (UTF-8 first, else Chinese in last_assistant_message garbles)
#   2. dispatch by hook_event_name, shape the 2.5 envelope
#   3. POST to the hub /ingest (bounded timeout, best-effort)
#   4. on failure cache to disk and drain the backlog next time the hub answers
#   5. local side effect: beep on Stop, full toolkit popup on Notification
# Never blocks the window, never fails a turn: always exit 0.
#
# ASCII-only source on purpose: parses under Windows PowerShell 5.1 regardless of BOM.
# Human-facing Chinese lives in the hub payload (UTF-8 JSON body), not in this file.

$ErrorActionPreference = 'SilentlyContinue'

# CC feeds UTF-8 stdin; PS defaults to the local code page (GBK) and would mangle
# the Chinese in last_assistant_message. Fix encoding before reading a single byte.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()

# Plugin root: CC injects CLAUDE_PLUGIN_ROOT; fall back to the parent of scripts/.
$root = $env:CLAUDE_PLUGIN_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $PSScriptRoot }

# ---------------------------------------------------------------------------
# Config: report.config.jsonc (JSONC with // comments). Defaults if absent.
# ---------------------------------------------------------------------------
$cfg = @{
    ingestUrl      = 'http://127.0.0.1:4350/ingest'
    timeoutSec     = 2
    probeMs        = 200      # TCP reachability precheck before the POST (see Test-HubReachable)
    maxTextLen     = 4000
    notifyStop     = 'full'   # beep | full | none
    notifyNotify   = 'full'   # full | beep | none
    popup          = 'web'    # web | winforms | none  (see Invoke-FullNotify)
}
$cfgPath = Join-Path $root 'report.config.jsonc'
if (Test-Path $cfgPath) {
    try {
        $rawCfg = Get-Content -Path $cfgPath -Raw -Encoding UTF8
        # strip // line comments and /* */ block comments so ConvertFrom-Json (PS5.1) accepts it
        $rawCfg = [regex]::Replace($rawCfg, '/\*[\s\S]*?\*/', '')
        $rawCfg = [regex]::Replace($rawCfg, '(?m)^\s*//.*$', '')
        $rawCfg = [regex]::Replace($rawCfg, '//[^"\r\n]*$', '', 'Multiline')
        $parsed = $rawCfg | ConvertFrom-Json
        foreach ($k in @('ingestUrl','timeoutSec','probeMs','maxTextLen','notifyStop','notifyNotify','popup')) {
            if ($null -ne $parsed.$k) { $cfg[$k] = $parsed.$k }
        }
    } catch { }
}

# ---------------------------------------------------------------------------
# Parse the hook event. If body is missing/invalid, still exit clean.
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
$evt = $null
try { $evt = $raw | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $evt) { exit 0 }

$eventName = [string]$evt.hook_event_name
if ([string]::IsNullOrWhiteSpace($eventName)) { exit 0 }

# ---------------------------------------------------------------------------
# Shape the 2.5 envelope. payload varies by event.
# ---------------------------------------------------------------------------
function Trim-Text {
    param([string]$s)
    if ([string]::IsNullOrEmpty($s)) { return $s }
    $max = [int]$cfg.maxTextLen
    if ($max -gt 0 -and $s.Length -gt $max) {
        return $s.Substring(0, $max) + ' ...[truncated]'
    }
    return $s
}

$payload = [ordered]@{}
$mappedEvent = $null
switch ($eventName) {
    'SessionStart'  { $mappedEvent = 'session_start'; $payload.source = [string]$evt.source }
    'SessionEnd'    { $mappedEvent = 'session_end';   $payload.reason = [string]$evt.reason }
    'Stop'          {
        $mappedEvent = 'stop'
        $payload.text = Trim-Text ([string]$evt.last_assistant_message)
        $payload.transcriptPath = [string]$evt.transcript_path
    }
    'Notification'  {
        $mappedEvent = 'notification'
        $payload.text = [string]$evt.message
        $payload.notificationType = [string]$evt.notification_type
    }
    'TaskCreated'   {
        $mappedEvent = 'task_created'
        $payload.taskId = [string]$evt.task_id
        $payload.taskSubject = [string]$evt.task_subject
        $payload.taskDesc = [string]$evt.task_description
        $payload.taskStatus = 'created'
    }
    'TaskCompleted' {
        $mappedEvent = 'task_completed'
        $payload.taskId = [string]$evt.task_id
        $payload.taskSubject = [string]$evt.task_subject
        $payload.taskDesc = [string]$evt.task_description
        $payload.taskStatus = 'completed'
    }
    'UserPromptSubmit' {
        $mappedEvent = 'user_prompt'
        $payload.text = Trim-Text ([string]$evt.prompt)
    }
    default         { $mappedEvent = $eventName.ToLower() }  # forward unknowns raw-ish
}

$envelope = [ordered]@{
    windowId = [string]$evt.session_id
    event    = $mappedEvent
    cwd      = [string]$evt.cwd
    ts       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    payload  = $payload
}
$json = $envelope | ConvertTo-Json -Depth 10 -Compress

# ---------------------------------------------------------------------------
# Report to hub. Success -> also drain offline backlog. Failure -> cache.
# ---------------------------------------------------------------------------
$cacheDir  = Join-Path $root 'cache'
$offlineFile = Join-Path $cacheDir 'ingest.offline.jsonl'

function Send-Ingest {
    param([string]$body)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod -Method Post -Uri $cfg.ingestUrl -Body $bytes `
        -ContentType 'application/json; charset=utf-8' `
        -TimeoutSec ([int]$cfg.timeoutSec) -ErrorAction Stop | Out-Null
}

# Human decision: precheck the hub with a cheap TCP probe before the POST.
# Invoke-RestMethod to a dead LOCAL port does NOT return RST fast -- it waits the
# full TimeoutSec. That 2s sits before the hook process exits, which is exactly
# why /clear and every turn's end "hang a beat" (the popup already fired above;
# what stalls here is the turn wrap-up). A ~probeMs TCP connect tells us live-or-dead:
# hub down -> cache and skip the slow POST + drain. Reporting is best-effort; one
# round late costs nothing.
function Test-HubReachable {
    $u = [Uri]$cfg.ingestUrl
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($u.Host, $u.Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne([int]$cfg.probeMs)
        if ($ok) { $client.EndConnect($async) }
        return $ok
    } catch { return $false }
    finally { $client.Close() }
}

function Cache-Offline {
    param([string]$body)
    try {
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        Add-Content -Path $offlineFile -Value $body -Encoding UTF8
    } catch { }
}

function Drain-Offline {
    if (-not (Test-Path $offlineFile)) { return }
    $lines = @()
    try { $lines = Get-Content -Path $offlineFile -Encoding UTF8 } catch { return }
    $remaining = New-Object System.Collections.Generic.List[string]
    $failed = $false
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($failed) { $remaining.Add($line); continue }
        try { Send-Ingest $line } catch { $failed = $true; $remaining.Add($line) }
    }
    try {
        if ($remaining.Count -eq 0) { Remove-Item -Path $offlineFile -Force }
        else { Set-Content -Path $offlineFile -Value $remaining -Encoding UTF8 }
    } catch { }
}

# ---------------------------------------------------------------------------
# Local side effect (Windows). Stop -> gentle beep; Notification -> full toolkit.
# Local signal means "you are at the machine"; the rich Chinese report is the hub's job.
#
# 人为决定：本地副作用（弹窗/提示音）必须排在 hub 上报之前。上报是同步 POST，
# hub 一挂就要干等 timeoutSec 秒超时——那 2 秒会把弹窗整体推后，正是「弹窗慢半拍」
# 的真凶。弹窗/提示音本就是 Start-Process 非阻塞拉起，先发它零成本；上报是 best-effort，
# 晚几秒无人等。脚本头写着 "Never blocks the window"，顺序必须兑现这句话。
# ---------------------------------------------------------------------------
function Get-Title {
    if ([string]::IsNullOrWhiteSpace($envelope.cwd)) { return 'majordomo' }
    return Split-Path -Leaf $envelope.cwd
}

# First sentence of the AI's last message, for the Stop popup headline. The rich
# Chinese report is still the hub's job; this is just enough to glance and know
# WHICH turn ended without alt-tabbing. Cap length so the toolkit popup stays tidy.
# Char class is built from code points (U+3002 / U+FF01 / U+FF1F = the CJK
# sentence enders) so this source stays pure ASCII -- see the file header.
function Get-FirstSentence {
    param([string]$s)
    if ([string]::IsNullOrWhiteSpace($s)) { return '' }
    $flat = ($s -replace '\s+', ' ').Trim()
    $enders = [string]([char]0x3002) + [char]0xFF01 + [char]0xFF1F
    $cut = [regex]::Split($flat, "[$enders.!?\n]")[0]
    if ([string]::IsNullOrWhiteSpace($cut)) { $cut = $flat }
    if ($cut.Length -gt 60) { $cut = $cut.Substring(0, 60) + '...' }
    return $cut
}

function Invoke-Beep {
    try { [Console]::Beep(880, 140) } catch { }
}

# Fire the WinForms toolkit popup (the legacy rich popup) plus its sound/flash/TTS chain.
function Invoke-WinFormsNotify {
    param([string]$message, [switch]$NoPopup)
    $notifier = Join-Path $PSScriptRoot 'notify-done.ps1'
    if (-not (Test-Path $notifier)) { Invoke-Beep; return }
    try {
        $escaped = $message -replace '"', '\"'
        # -Worker: skip notify-done's launcher self-respawn. We already detach it via
        # Start-Process, so the worker running inline here costs one fewer PS cold-start
        # before the popup appears -- that hop was the popup lagging behind approval.
        $al = @(
            '-NoProfile','-WindowStyle','Hidden',
            '-File', "`"$notifier`"", '-Worker', '-Message', "`"$escaped`""
        )
        if ($NoPopup) { $al += '-NoPopup' }  # web popup owns the visual; reuse only sound/flash/TTS
        Start-Process powershell.exe -ArgumentList $al -WindowStyle Hidden | Out-Null
    } catch { Invoke-Beep }
}

# Ensure the web (Edge app-mode) popup is alive + pinned. NON-BLOCKING: the launcher
# is spawned detached (its cold-start pin-poll must never stall the turn). Returns
# $true if Edge exists (web popup is in play), $false if absent (caller falls back).
function Ensure-WebPopup {
    $launcher = Join-Path $PSScriptRoot 'popup-web.ps1'
    if (-not (Test-Path $launcher)) { return $false }
    # Fast inline Edge-presence probe: cheap path tests, no process spawn. Drives the
    # fallback decision without waiting on the detached launcher.
    $edge = $null
    $cands = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { $edge = $c; break } }
    if (-not $edge) { return $false }
    try {
        $ingest = [Uri]$cfg.ingestUrl
        $popupUrl = "$($ingest.Scheme)://$($ingest.Authority)/popup.html"
        Start-Process powershell.exe -ArgumentList @(
            '-NoProfile','-WindowStyle','Hidden',
            '-File', "`"$launcher`"", '-Url', "`"$popupUrl`""
        ) -WindowStyle Hidden | Out-Null
    } catch { }
    return $true
}

# Rich local notification. popup=web -> Edge app window owns the visual, notify-done
# supplies sound/flash/TTS only; falls back to the WinForms popup if Edge is missing.
# popup=winforms -> the legacy rich WinForms popup. popup=none -> sound chain only.
function Invoke-FullNotify {
    param([string]$message)
    switch ([string]$cfg.popup) {
        'none' { Invoke-WinFormsNotify $message -NoPopup; return }
        'winforms' { Invoke-WinFormsNotify $message; return }
        'both' {
            # web popup + WinForms popup both
            if (Ensure-WebPopup) { Invoke-WinFormsNotify $message }
            else { Invoke-WinFormsNotify $message }
        }
        default {
            # 'web' (default)
            if (Ensure-WebPopup) { Invoke-WinFormsNotify $message -NoPopup }
            else { Invoke-WinFormsNotify $message }  # no Edge -> legacy popup
        }
    }
}

$title = Get-Title
switch ($mappedEvent) {
    'stop' {
        switch ($cfg.notifyStop) {
            'full' {
                $line = Get-FirstSentence ([string]$payload.text)
                if ([string]::IsNullOrWhiteSpace($line)) { $line = 'done' }
                Invoke-FullNotify "$title | $line"
            }
            'beep' { Invoke-Beep }
            default { }
        }
    }
    'notification' {
        $msg = $payload.text
        if ([string]::IsNullOrWhiteSpace($msg)) { $msg = 'needs you' }
        switch ($cfg.notifyNotify) {
            'full' { Invoke-FullNotify "$title | $msg" }
            'beep' { Invoke-Beep }
            default { }
        }
    }
    default { }
}

# ---------------------------------------------------------------------------
# Report to hub LAST, and only if a ~probeMs TCP precheck says it's up. A dead
# hub costs one cheap precheck instead of a full timeoutSec-second POST timeout
# sitting in front of the turn's end. Reachable -> POST + drain backlog;
# unreachable or POST fails -> cache and move on.
# ---------------------------------------------------------------------------
$sent = $false
if (Test-HubReachable) {
    $sent = $false
    try { Send-Ingest $json; $sent = $true } catch { $sent = $false }
    if ($sent) { Drain-Offline } else { Cache-Offline $json }
} else {
    Cache-Offline $json
}

# ---------------------------------------------------------------------------
# Status badge file — bifrost-statusline.ps1 reads this to show a rainbow
# [BIFROST] badge in the Claude Code statusline. Hue cycles 0-6 on every
# successful Stop POST (multi-window races are harmless: color just jumps).
# ---------------------------------------------------------------------------
$statusFile = Join-Path $cacheDir 'status.json'
$oldHue = 0
if (Test-Path $statusFile) {
    try { $oldHue = [int]((Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json).hue) } catch { }
}
try {
    [ordered]@{ reachable = $sent; hue = $oldHue + 1 } `
        | ConvertTo-Json -Compress `
        | Set-Content -Path $statusFile -Encoding UTF8
} catch { }

exit 0
