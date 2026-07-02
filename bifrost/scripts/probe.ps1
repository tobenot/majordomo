# probe.ps1 — Bifrost 探针（施工第 0 步 / 设计稿 §2.6）
# 唯一职责：把每个 hook 的 stdin 原样落到 dump.jsonl，一事件一行。
# 不上报、不阻断、不做本地副作用——只为实测各事件真实 payload 形状。
# 正式版 report.ps1 据 dump 回填后再写。

$ErrorActionPreference = 'SilentlyContinue'

# CC 喂的 stdin 是 UTF-8；PS 默认按本地代码页(GBK)解码会把中文读成乱码。
# last_assistant_message 含中文全文，正式版据此写日记/上报，必须先纠正编码。
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# 读全量 stdin（可能为空；SessionStart 等也可能不给 body）
$raw = [Console]::In.ReadToEnd()

# dump 落在插件根目录；CLAUDE_PLUGIN_ROOT 由 CC 注入，取不到则回退到脚本上级
$root = $env:CLAUDE_PLUGIN_ROOT
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $PSScriptRoot }
$dump = Join-Path $root 'dump.jsonl'

# 包一层信封：记录接收时刻 + 原始文本。故意不解析——
# 即便 body 非法 JSON 也要留证，形状分析交给事后人工/脚本读 dump。
$envelope = [ordered]@{
    receivedAt = (Get-Date).ToString('o')
    rawStdin   = $raw
}
$line = $envelope | ConvertTo-Json -Compress -Depth 20

# 多窗口并发写同一文件：短重试避开偶发文件锁
for ($i = 0; $i -lt 5; $i++) {
    try {
        Add-Content -Path $dump -Value $line -Encoding UTF8 -ErrorAction Stop
        break
    } catch {
        Start-Sleep -Milliseconds 40
    }
}

exit 0
