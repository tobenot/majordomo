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
    maxTextLen     = 4000
    notifyStop     = 'beep'   # beep | full | none
    notifyNotify   = 'full'   # full | beep | none
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
        foreach ($k in @('ingestUrl','timeoutSec','maxTextLen','notifyStop','notifyNotify')) {
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

$sent = $false
try { Send-Ingest $json; $sent = $true } catch { $sent = $false }
if ($sent) { Drain-Offline } else { Cache-Offline $json }

# ---------------------------------------------------------------------------
# Local side effect (Windows). Stop -> gentle beep; Notification -> full toolkit.
# Local signal means "you are at the machine"; the rich Chinese report is the hub's job.
# ---------------------------------------------------------------------------
function Get-Title {
    if ([string]::IsNullOrWhiteSpace($envelope.cwd)) { return 'majordomo' }
    return Split-Path -Leaf $envelope.cwd
}

function Invoke-Beep {
    try { [Console]::Beep(880, 140) } catch { }
}

function Invoke-FullNotify {
    param([string]$message)
    $notifier = Join-Path $PSScriptRoot 'notify-done.ps1'
    if (-not (Test-Path $notifier)) { Invoke-Beep; return }
    try {
        $escaped = $message -replace '"', '\"'
        # -Worker: skip notify-done's launcher self-respawn. We already detach it via
        # Start-Process, so the worker running inline here costs one fewer PS cold-start
        # before the popup appears -- that hop was the popup lagging behind approval.
        Start-Process powershell.exe -ArgumentList @(
            '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
            '-File', "`"$notifier`"", '-Worker', '-Message', "`"$escaped`""
        ) -WindowStyle Hidden | Out-Null
    } catch { Invoke-Beep }
}

$title = Get-Title
switch ($mappedEvent) {
    'stop' {
        switch ($cfg.notifyStop) {
            'full' { Invoke-FullNotify "$title done" }
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

exit 0
