# notify-done.ps1 - AI 工作交接提醒系统（非阻塞）
# Usage:
#   powershell -ExecutionPolicy Bypass -File notify-done.ps1 ["message"] [-Volume 0-100] [-NoBeep] [-NoPopup]
#
# 设计：
# - 默认模式：立即拉起后台 worker 子进程并立刻退出（不阻塞调用方）
# - worker 模式：真正执行 Beep / 任务栏闪烁 / TTS / 持久浮窗

param(
    [string]$Message,
    [ValidateRange(0, 100)]
    [int]$Volume,
    [switch]$NoBeep,
    [switch]$NoPopup,
    [switch]$Worker
)

# --- 加载配置 ---
$Config = @{}
$configDefault = Join-Path $PSScriptRoot "notify-done.config.ps1"
$configUser    = Join-Path $PSScriptRoot "notify-done.config.user.ps1"
if (Test-Path $configDefault) { . $configDefault }
if (Test-Path $configUser)    { . $configUser }

# 用配置填充未指定的参数
if ([string]::IsNullOrEmpty($Message))              { $Message = $Config.DefaultMessage }
if (-not $PSBoundParameters.ContainsKey('Volume'))   { $Volume  = $Config.DefaultVolume }

# =============================
# 启动器模式（默认）：非阻塞
# =============================
if (-not $Worker) {
    try {
        $scriptPath = $PSCommandPath
        if ([string]::IsNullOrWhiteSpace($scriptPath)) {
            $scriptPath = $MyInvocation.MyCommand.Path
        }

        if (-not [string]::IsNullOrWhiteSpace($scriptPath) -and (Test-Path $scriptPath)) {
            $escapedMessage = $Message -replace '"', '\"'

            $argList = @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-WindowStyle", "Hidden",
                "-File", "`"$scriptPath`"",
                "-Worker",
                "-Message", "`"$escapedMessage`"",
                "-Volume", "$Volume"
            )

            if ($NoBeep) { $argList += "-NoBeep" }
            if ($NoPopup) { $argList += "-NoPopup" }

            Start-Process powershell.exe -ArgumentList $argList -WindowStyle Hidden | Out-Null
            return
        }
    } catch {
        # 启动后台失败则降级为同步执行（继续往下走）
    }
}

# =============================
# worker 模式：执行提醒逻辑
# =============================

# 提示音互斥：Bifrost 的 report.ps1 与 Hub 的 PowershellNotifier 可能在同一回合内
# 相隔毫秒各拉一次 notify-done，两声警报叠着响。用 $TEMP 下一个共享锁去重：
# 锁文件 < 2 秒 = 刚有人响过，本次静音；否则盖时间戳并放行。跨进程 best-effort，
# 竞态窗口只有毫秒级，最坏退回「偶尔两声」——也就是现状，只增不减。
function Test-BeepLock {
    $lock = Join-Path $env:TEMP 'majordomo-beep.lock'
    try {
        if (Test-Path $lock) {
            $age = ([DateTime]::UtcNow - (Get-Item $lock).LastWriteTimeUtc).TotalMilliseconds
            if ($age -lt 2000) { return $false }
        }
        Set-Content -Path $lock -Value ([DateTime]::UtcNow.Ticks) -Encoding ASCII
    } catch { }
    return $true
}

# --- Step 1: 持久浮窗提醒（最慢的一环，最先拉起，让它并行编译/渲染） ---
# 人为决定：浮窗子进程要冷启动 PowerShell + Add-Type WinForms + 建复杂窗体，是整条链里
# 最慢的一步。放最前面用非阻塞 Start-Process 拉起，它就能和下面的提示音/闪烁并行，
# 而不是排在提示音和一次 C# 编译之后——那正是「弹窗比提示音晚」的原因。
if (-not $NoPopup) {
    try {
        $popupScript = Join-Path $PSScriptRoot "notify-popup.ps1"
        if (Test-Path $popupScript) {
            $escapedMessage = $Message -replace '"', '\"'
            Start-Process powershell.exe -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-WindowStyle", "Hidden",
                "-File", "`"$popupScript`"",
                "-Message", "`"$escapedMessage`""
            ) -WindowStyle Hidden | Out-Null
        } else {
            Write-Host "[浮窗脚本未找到] $popupScript"
        }
    } catch {
        Write-Host "[浮窗启动失败] $($_.Exception.Message)"
    }
}

# --- Step 2: 科幻远方警报提示音 (使用缓存WAV，后台异步播放) ---
if (-not $NoBeep -and (Test-BeepLock)) {
    try {
        $cachedWav = Join-Path $PSScriptRoot "cache\alert-tone.wav"
        if (-not (Test-Path $cachedWav)) {
            # 首次运行：生成缓存WAV文件（后台生成，本次用fallback）
            $toneScript = Join-Path $PSScriptRoot "notify-tone.ps1"
            if (Test-Path $toneScript) {
                $cacheDir = Join-Path $PSScriptRoot "cache"
                if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
                Start-Process powershell.exe -ArgumentList @(
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-WindowStyle", "Hidden",
                    "-File", "`"$toneScript`"",
                    "-Volume", "$Volume",
                    "-CacheOnly"
                ) -WindowStyle Hidden | Out-Null
            }
            # 本次用简单beep作为fallback
            [Console]::Beep(784, 200)
            Start-Sleep -Milliseconds 80
            [Console]::Beep(988, 300)
        } else {
            # 有缓存：后台播放WAV文件（用SoundPlayer.Play异步播放）
            Start-Process powershell.exe -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-WindowStyle", "Hidden",
                "-Command", "`$p = New-Object System.Media.SoundPlayer('$cachedWav'); `$p.Play(); Start-Sleep -Seconds 11"
            ) -WindowStyle Hidden | Out-Null
        }
    } catch {
        # Best-effort
    }
}

# --- Step 3: Flash taskbar window ---
try {
    $flashCode = @"
using System;
using System.Runtime.InteropServices;
public class TaskbarFlash {
    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO {
        public uint cbSize; public IntPtr hwnd; public uint dwFlags;
        public uint uCount; public uint dwTimeout;
    }
    [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    public static void Flash() {
        IntPtr hwnd = GetConsoleWindow();
        if (hwnd == IntPtr.Zero) return;
        FLASHWINFO fInfo = new FLASHWINFO();
        fInfo.cbSize = (uint)Marshal.SizeOf(fInfo);
        fInfo.hwnd = hwnd; fInfo.dwFlags = 3 | 12; fInfo.uCount = 5; fInfo.dwTimeout = 0;
        FlashWindowEx(ref fInfo);
    }
}
"@
    Add-Type -TypeDefinition $flashCode -Language CSharp -ErrorAction SilentlyContinue
    [TaskbarFlash]::Flash()
} catch {
    # Best-effort
}

# --- Step 4: TTS 双语语音播报（非阻塞，后台子进程播放，延迟确保提示音先播完） ---
try {
    $ttsScript = Join-Path $PSScriptRoot "notify-tts.ps1"
    if (Test-Path $ttsScript) {
        $escapedMessage = $Message -replace '"', '\"'
        # 延迟 5s 启动 TTS，让提示音充分播完主要部分
        Start-Sleep -Milliseconds 5000
        Start-Process powershell.exe -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", "`"$ttsScript`"",
            "-Message", "`"$escapedMessage`"",
            "-Volume", "$Volume",
            "-Rate", "$($Config.TTS.Rate)",
            "-SinglePrefix", "$($Config.TTS.SinglePrefix)"
        ) -WindowStyle Hidden | Out-Null
    } else {
        Write-Host "[TTS脚本未找到] $ttsScript"
    }
} catch {
    Write-Host "[TTS启动失败] $($_.Exception.Message)"
}

# --- Step 5: Console output ---
$timestamp = Get-Date -Format "HH:mm:ss"
Write-Host ""
Write-Host "[$timestamp] 完成 - $Message" -ForegroundColor Green
Write-Host ""
