# write-diary.ps1 - Claude Code 日记写入工具
# Usage:
#   powershell -ExecutionPolicy Bypass -File write-diary.ps1 "message"
#
# 功能：
# - 自动获取当前时间戳 (HH:mm)
# - 自动按日期生成文件名 (yyyy-MM-dd.md)
# - UTF-8 编码写入，避免中文乱码
# - 自动创建目录

param(
    [Parameter(Position=0)]
    [string]$Message = "no message"
)

# --- 配置 ---
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$diaryDir = Join-Path $projectRoot ".codebuddy\memory"
$dateStr = Get-Date -Format "yyyy-MM-dd"
$timeStr = Get-Date -Format "HH:mm"
$diaryFile = Join-Path $diaryDir "$dateStr.md"

# --- 确保目录存在 ---
if (-not (Test-Path $diaryDir)) {
    New-Item -ItemType Directory -Path $diaryDir -Force | Out-Null
}

# --- 写入 ---
$line = "- $timeStr $Message"
# 使用 .NET 方法确保 UTF-8 无 BOM
[System.IO.File]::AppendAllText($diaryFile, "$line`n", [System.Text.UTF8Encoding]::new($false))
