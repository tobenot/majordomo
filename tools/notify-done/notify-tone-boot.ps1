# notify-tone.ps1 - 赛博朋克/DHV Magellan 风格通知音效生成器
# 纯 PowerShell 动态合成 WAV，无需外部音频文件
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File notify-tone.ps1 [-Volume 0-100]
#
# 设计思路：
#   模拟 Death Stranding 2 DHV Magellan 官方提示音风格
#   - 丰富和弦层叠，空灵悠长
#   - 金属质感的叮咚 + 柔和的合成器 pad
#   - 多层回声逐渐消散，空间感极强
#   - 平静、专业、高级感

param(
    [ValidateRange(0, 100)]
    [int]$Volume
)

# --- 加载配置 ---
$Config = @{}
$configDefault = Join-Path $PSScriptRoot "notify-done.config.ps1"
$configUser    = Join-Path $PSScriptRoot "notify-done.config.user.ps1"
if (Test-Path $configDefault) { . $configDefault }
if (Test-Path $configUser)    { . $configUser }

if (-not $PSBoundParameters.ContainsKey('Volume')) {
    $Volume = if ($Config.DefaultVolume) { $Config.DefaultVolume } else { 80 }
}

function New-CyberTone {
    param([int]$Vol = 80)

    $sampleRate = if ($Config.Tone.SampleRate) { $Config.Tone.SampleRate } else { 44100 }
    $duration   = if ($Config.Tone.Duration)   { $Config.Tone.Duration }   else { 4.5 }
    $totalSamples = [int]($sampleRate * $duration)
    $amplitude  = [math]::Min(($Vol / 100.0) * 0.9, 0.9)

    # WAV 参数
    $bitsPerSample = 16
    $channels      = 1
    $byteRate      = $sampleRate * $channels * ($bitsPerSample / 8)
    $blockAlign    = $channels * ($bitsPerSample / 8)
    $dataSize      = $totalSamples * $blockAlign

    $samples = New-Object 'double[]' $totalSamples
    $twoPi   = 2.0 * [math]::PI

    # ==============================
    # 和弦定义 (Cmaj9 → Fmaj7 的柔和进行)
    # ==============================

    # Chord 1: Cmaj9  (C4 E4 G4 B4 D5)
    $chord1 = @(261.6, 329.6, 392.0, 493.9, 587.3)
    # Chord 2: Fmaj7  (F3 A3 C4 E4)  — 更温暖，解决感
    $chord2 = @(174.6, 220.0, 261.6, 329.6)

    # 叮音频率（高频泛音，金属质感）
    $bell1 = 1318.5   # E6
    $bell2 = 1568.0   # G6
    $bell3 = 1760.0   # A6
    $bell4 = 2093.0   # C7

    for ($i = 0; $i -lt $totalSamples; $i++) {
        $t = $i / $sampleRate
        $sample = 0.0

        # ========================================
        # Layer 1: Synth Pad — 和弦垫底（悠长，温暖）
        # ========================================

        # Chord 1: 0s ~ 3s，缓慢淡入淡出
        if ($t -lt 3.0) {
            $envPad1 = 0.0
            if ($t -lt 0.8) {
                $envPad1 = $t / 0.8                      # 缓慢淡入
            } elseif ($t -lt 2.0) {
                $envPad1 = 1.0
            } else {
                $envPad1 = [math]::Max(0, (3.0 - $t) / 1.0)  # 缓慢淡出
            }
            $envPad1 = $envPad1 * $envPad1   # 平滑

            $pad1 = 0.0
            foreach ($freq in $chord1) {
                $pad1 += [math]::Sin($twoPi * $freq * $t)
                # 加微量失谐，产生温暖的 chorus 效果
                $pad1 += [math]::Sin($twoPi * ($freq * 1.003) * $t) * 0.5
            }
            $sample += $pad1 / ($chord1.Count * 1.8) * $envPad1 * 0.22
        }

        # Chord 2: 1.8s ~ 4.5s，与 chord1 交叉淡入
        if ($t -ge 1.8) {
            $tc2 = $t - 1.8
            $envPad2 = 0.0
            if ($tc2 -lt 0.8) {
                $envPad2 = $tc2 / 0.8
            } elseif ($tc2 -lt 1.8) {
                $envPad2 = 1.0
            } else {
                $envPad2 = [math]::Max(0, (2.7 - $tc2) / 0.9)
            }
            $envPad2 = $envPad2 * $envPad2

            $pad2 = 0.0
            foreach ($freq in $chord2) {
                $pad2 += [math]::Sin($twoPi * $freq * $t)
                $pad2 += [math]::Sin($twoPi * ($freq * 1.004) * $t) * 0.5
            }
            $sample += $pad2 / ($chord2.Count * 1.8) * $envPad2 * 0.22
        }

        # ========================================
        # Layer 2: Bell Tones — 金属叮音和弦（多次触发 + 回声）
        # ========================================

        # 辅助函数：计算一个叮音在给定触发时间的贡献
        # 触发时间, 衰减速率, 音量
        $bellTriggers = @(
            @{ Time = 0.05;  Decay = 2.8;  Vol = 0.40; Freqs = @($bell1, $bell2) },
            @{ Time = 0.15;  Decay = 3.0;  Vol = 0.30; Freqs = @($bell3, $bell4) },
            @{ Time = 0.80;  Decay = 2.5;  Vol = 0.25; Freqs = @($bell1, $bell3) },
            # 回声 1
            @{ Time = 1.50;  Decay = 3.5;  Vol = 0.15; Freqs = @($bell1, $bell2, $bell3) },
            # 回声 2
            @{ Time = 2.20;  Decay = 4.0;  Vol = 0.10; Freqs = @($bell2, $bell4) },
            # 远处回声
            @{ Time = 3.00;  Decay = 4.5;  Vol = 0.06; Freqs = @($bell1, $bell3) }
        )

        foreach ($trigger in $bellTriggers) {
            $trig = [double]$trigger.Time
            if ($t -ge $trig) {
                $tb = $t - $trig
                $envBell = [math]::Exp(-$tb * [double]$trigger.Decay)
                $bellSample = 0.0
                foreach ($bf in $trigger.Freqs) {
                    $bellSample += [math]::Sin($twoPi * $bf * $tb)
                }
                $bellSample = $bellSample / $trigger.Freqs.Count
                $sample += $bellSample * $envBell * [double]$trigger.Vol
            }
        }

        # ========================================
        # Layer 3: Sub Bass — 极低的底层脉动（体感）
        # ========================================
        if ($t -ge 0.0 -and $t -lt 3.5) {
            $envSub = 0.0
            if ($t -lt 0.5) {
                $envSub = $t / 0.5
            } elseif ($t -lt 2.5) {
                $envSub = 1.0
            } else {
                $envSub = [math]::Max(0, (3.5 - $t) / 1.0)
            }
            # 65.4 Hz = C2，极低但可闻
            $sub = [math]::Sin($twoPi * 65.4 * $t) + [math]::Sin($twoPi * 98.0 * $t) * 0.4
            $sample += $sub * $envSub * 0.08
        }

        # ========================================
        # Layer 4: 轻微颗粒感（模拟电子设备底噪）
        # ========================================
        $envNoise = 0.0
        if ($t -lt 3.5) {
            if ($t -lt 0.3) { $envNoise = $t / 0.3 }
            elseif ($t -lt 2.8) { $envNoise = 1.0 }
            else { $envNoise = [math]::Max(0, (3.5 - $t) / 0.7) }
        }
        $noise = (($i * 1103515245 + 12345) % 2147483648) / 2147483648.0 * 2 - 1
        $sample += $noise * $envNoise * 0.008

        # ========================================
        # 软限幅 + 写入
        # ========================================
        $sample = $sample * $amplitude
        $sample = [math]::Max(-0.98, [math]::Min(0.98, $sample))
        $samples[$i] = $sample
    }

    # ==============================
    # 构建 WAV 内存流并播放
    # ==============================
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)

    # RIFF header
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
    $writer.Write([int](36 + $dataSize))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("WAVE"))

    # fmt chunk
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("fmt "))
    $writer.Write([int]16)
    $writer.Write([int16]1)              # PCM
    $writer.Write([int16]$channels)
    $writer.Write([int]$sampleRate)
    $writer.Write([int]$byteRate)
    $writer.Write([int16]$blockAlign)
    $writer.Write([int16]$bitsPerSample)

    # data chunk
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
    $writer.Write([int]$dataSize)

    for ($i = 0; $i -lt $totalSamples; $i++) {
        $val = [int]($samples[$i] * 32767)
        $val = [math]::Max(-32768, [math]::Min(32767, $val))
        $writer.Write([int16]$val)
    }

    $writer.Flush()
    $stream.Position = 0

    $player = New-Object System.Media.SoundPlayer($stream)
    $player.PlaySync()

    $player.Dispose()
    $writer.Dispose()
    $stream.Dispose()
}

# 执行
New-CyberTone -Vol $Volume
