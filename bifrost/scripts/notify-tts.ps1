# notify-tts.ps1 - TTS 双语语音播报子进程
param(
    [string]$Message,
    [int]$Volume = 80,
    [int]$Rate = 0,
    [string]$SinglePrefix = ""
)

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Volume = $Volume
    $synth.Rate = $Rate

    # 查找可用的中文和英文语音
    $allVoices = $synth.GetInstalledVoices()
    $zhVoice = $allVoices | Where-Object {
        $_.VoiceInfo.Culture.Name -like 'zh-*'
    } | Select-Object -First 1
    $enVoice = $allVoices | Where-Object {
        $_.VoiceInfo.Culture.Name -like 'en-*'
    } | Select-Object -First 1

    $zhVoiceName = if ($zhVoice) { $zhVoice.VoiceInfo.Name } else { $null }
    $enVoiceName = if ($enVoice) { $enVoice.VoiceInfo.Name } else { $null }

    # 尝试按 [中文]...[EN]... 或 | 分隔符拆分双语消息
    $zhText = $null
    $enText = $null

    if ($Message -match '\[中文\]\s*(.+?)\s*\|\s*\[EN\]\s*(.+)$') {
        $zhText = $Matches[1].Trim()
        $enText = $Matches[2].Trim()
    } elseif ($Message -match '\[中文\]\s*(.+?)\s*\[EN\]\s*(.+)$') {
        $zhText = $Matches[1].Trim()
        $enText = $Matches[2].Trim()
    }

    if ($zhText -and $enText) {
        # 双语模式：分别用对应语音朗读
        if ($zhVoiceName) { $synth.SelectVoice($zhVoiceName) }
        $synth.Speak($zhText)

        Start-Sleep -Milliseconds 400

        if ($enVoiceName) { $synth.SelectVoice($enVoiceName) }
        $synth.Speak($enText)
    } else {
        # 单语模式（fallback）：用中文语音读全部
        if ($zhVoiceName) { $synth.SelectVoice($zhVoiceName) }
        $synth.Speak("$SinglePrefix$Message")
    }

    $synth.Dispose()
} catch {
    # Silent fail
}
